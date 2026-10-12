import { OrderRepository, OrderRow } from '../orders/order.repository';
import { OrderStatus, ActorType, FailureType, AlertType } from '../../constants/orderStatus';
import { AppError } from '../../errors/appError';
import { query } from '../../config/database';
import { logger } from '../../utils/logger';

export class BotService {
  /**
   * Concurrency Solution (Case 2):
   * Bot claims the next available QUEUED order atomically with SKIP LOCKED
   */
  static async claimOrder(botId: string): Promise<OrderRow | null> {
    const order = await OrderRepository.claimOrderForBot(botId);
    if (order) {
      logger.info(`Bot ${botId} claimed order ${order.order_no}`, {
        botId,
        orderNo: order.order_no,
      });
    }
    return order;
  }

  /**
   * Heartbeat / Lease Solution (Case 1):
   * Bot sends heartbeat to extend its lease
   */
  static async heartbeat(orderNo: string, botId: string): Promise<OrderRow> {
    const order = await OrderRepository.renewHeartbeat(orderNo, botId);
    logger.debug(`Heartbeat renewed for order ${orderNo} by bot ${botId}`, {
      orderNo,
      botId,
      lockedUntil: order.locked_until,
    });
    return order;
  }

  /**
   * Bot finishes top-up successfully
   */
  static async completeOrder(
    orderNo: string,
    botId: string,
    metadata?: any
  ): Promise<OrderRow> {
    const order = await OrderRepository.findByOrderNo(orderNo);
    if (!order) {
      throw AppError.notFound(`Order ${orderNo} not found`);
    }

    if (order.locked_by !== botId || order.status !== OrderStatus.IN_PROGRESS) {
      throw AppError.conflict(
        `Order ${orderNo} is not currently locked by bot ${botId} in status IN_PROGRESS`
      );
    }

    return OrderRepository.updateOrderStatus(
      orderNo,
      OrderStatus.COMPLETED,
      ActorType.BOT_WORKER,
      'TOP_UP_SUCCESSFUL',
      {
        reason: 'Bot successfully topped up game package',
        metadata: { botId, ...metadata },
        clearLock: true,
      }
    );
  }

  /**
   * Failure Classification Solution (Case 4):
   * Differentiates between TRANSIENT (retryable) and PERMANENT (fatal, non-retryable) errors
   */
  static async reportFailure(
    orderNo: string,
    botId: string,
    errorType: FailureType,
    errorCode: string,
    errorMessage: string
  ): Promise<OrderRow> {
    const order = await OrderRepository.findByOrderNo(orderNo);
    if (!order) {
      throw AppError.notFound(`Order ${orderNo} not found`);
    }

    if (order.locked_by !== botId && order.status === OrderStatus.IN_PROGRESS) {
      throw AppError.conflict(
        `Order ${orderNo} is not locked by bot ${botId}`
      );
    }

    // 1. Permanent Error (e.g. Invalid UID / Account Banned)
    if (errorType === FailureType.PERMANENT) {
      logger.warn(`Permanent top-up failure on order ${orderNo}: ${errorMessage}`, {
        orderNo,
        botId,
        errorCode,
        errorMessage,
      });

      return OrderRepository.updateOrderStatus(
        orderNo,
        OrderStatus.FAILED,
        ActorType.BOT_WORKER,
        'TOP_UP_PERMANENT_FAILURE',
        {
          reason: `Permanent failure (${errorCode}): ${errorMessage}`,
          failureReason: errorMessage,
          failureType: FailureType.PERMANENT,
          metadata: { botId, errorCode, errorMessage },
          clearLock: true,
        }
      );
    }

    // 2. Transient Error (e.g. Provider 503, network timeout)
    const newRetryCount = (order.retry_count || 0) + 1;
    const maxRetries = order.max_retries || 3;

    if (newRetryCount < maxRetries) {
      logger.warn(
        `Transient failure on order ${orderNo}. Retrying (${newRetryCount}/${maxRetries}): ${errorMessage}`,
        { orderNo, botId, retryCount: newRetryCount }
      );

      // Increment retry_count and return order to QUEUED
      await query(
        `UPDATE orders 
         SET retry_count = $1, 
             failure_reason = $2, 
             failure_type = $3,
             locked_by = NULL,
             locked_until = NULL,
             updated_at = NOW() 
         WHERE order_no = $4`,
        [newRetryCount, errorMessage, FailureType.TRANSIENT, orderNo]
      );

      return OrderRepository.updateOrderStatus(
        orderNo,
        OrderStatus.QUEUED,
        ActorType.BOT_WORKER,
        'TOP_UP_TRANSIENT_RETRY',
        {
          reason: `Transient failure (${errorCode}): ${errorMessage}. Retrying (${newRetryCount}/${maxRetries})`,
          metadata: { botId, errorCode, retryCount: newRetryCount, maxRetries },
          clearLock: true,
        }
      );
    } else {
      // Exceeded max retries -> Move to DELAYED and create system alert
      logger.error(
        `Order ${orderNo} exceeded max retries (${newRetryCount}/${maxRetries}). Moving to DELAYED.`,
        { orderNo, botId }
      );

      await query(
        `UPDATE orders 
         SET retry_count = $1, 
             failure_reason = $2, 
             failure_type = $3,
             locked_by = NULL,
             locked_until = NULL,
             updated_at = NOW() 
         WHERE order_no = $4`,
        [newRetryCount, `Exceeded max retries: ${errorMessage}`, FailureType.TRANSIENT, orderNo]
      );

      // Create system alert
      await query(
        `INSERT INTO system_alerts (order_no, alert_type, message)
         VALUES ($1, $2, $3)`,
        [
          orderNo,
          AlertType.BOT_CRASH_MAX_RETRY,
          `Order ${orderNo} failed after ${newRetryCount} retries due to: ${errorMessage}`,
        ]
      );

      return OrderRepository.updateOrderStatus(
        orderNo,
        OrderStatus.DELAYED,
        ActorType.BOT_WORKER,
        'MAX_RETRIES_EXCEEDED_DELAYED',
        {
          reason: `Max retries exceeded (${newRetryCount}/${maxRetries}). Held for manual review.`,
          failureReason: errorMessage,
          failureType: FailureType.TRANSIENT,
          metadata: { botId, errorCode, retryCount: newRetryCount },
          clearLock: true,
        }
      );
    }
  }
}
