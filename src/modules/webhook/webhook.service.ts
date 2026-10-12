import { query, withTransaction } from '../../config/database';
import { OrderRepository } from '../orders/order.repository';
import { OrderStatus, ActorType, AlertType } from '../../constants/orderStatus';
import { AppError } from '../../errors/appError';
import { verifyHmacSignature } from '../../utils/crypto';
import { config } from '../../config/env';
import { logger } from '../../utils/logger';

export interface BankWebhookPayload {
  eventId: string;
  orderNo: string;
  amount: number;
  transactionRef: string;
  timestamp: string;
}

export class WebhookService {
  /**
   * Problem Case 3:
   * Handles bank webhook with HMAC verification, event deduplication, and out-of-order state guards
   */
  static async processBankPayment(payload: BankWebhookPayload, signature?: string, rawPayload?: any) {
    // 1. Signature Verification
    if (config.nodeEnv === 'production' || signature) {
      const payloadToVerify = rawPayload || payload;
      const isValid = verifyHmacSignature(payloadToVerify, config.webhook.secret, signature || '');
      if (!isValid) {
        throw AppError.unauthorized('Invalid bank webhook signature');
      }
    }

    const { eventId, orderNo, amount, transactionRef } = payload;

    return withTransaction(async (client) => {
      // 2. Idempotency Check: Was this event ID already processed?
      const existingEvent = await client.query(
        'SELECT event_id, status FROM webhook_events WHERE event_id = $1',
        [eventId]
      );

      if (existingEvent.rows.length > 0) {
        logger.info(`Duplicate webhook event ignored: ${eventId} for order ${orderNo}`, {
          eventId,
          orderNo,
        });
        return {
          status: 'IDEMPOTENT_IGNORED',
          message: 'Webhook event was already processed previously',
          eventId,
        };
      }

      // Record event receipt immediately
      await client.query(
        `INSERT INTO webhook_events (event_id, provider, order_no, status, payload)
         VALUES ($1, $2, $3, $4, $5)`,
        [eventId, 'BANK_SCB_PROMPTPAY', orderNo, 'PROCESSING', payload]
      );

      // Lock order to check status safely
      const orderRes = await client.query(
        'SELECT * FROM orders WHERE order_no = $1 FOR UPDATE',
        [orderNo]
      );

      if (orderRes.rows.length === 0) {
        throw AppError.notFound(`Order ${orderNo} not found for webhook event ${eventId}`);
      }

      const order = orderRes.rows[0];
      const now = new Date();
      const isExpiredTime = now > new Date(order.expires_at);

      // 3. State Machine & Expiry Resolution
      if (order.status === OrderStatus.PENDING_PAYMENT) {
        if (isExpiredTime) {
          // Late payment arrived after timeout
          logger.warn(`Late payment arrived on expired order ${orderNo}. Triggering auto-refund.`, {
            orderNo,
            eventId,
            amount,
          });

          await client.query(
            `UPDATE orders 
             SET status = $1, updated_at = NOW(), version = version + 1 
             WHERE order_no = $2`,
            [OrderStatus.REFUNDED, orderNo]
          );

          await OrderRepository.addTimelineEntry(client, {
            orderNo,
            fromStatus: OrderStatus.PENDING_PAYMENT,
            toStatus: OrderStatus.REFUNDED,
            actor: ActorType.BANK_WEBHOOK,
            action: 'LATE_PAYMENT_AUTO_REFUNDED',
            reason: `Payment received after expiration window (${order.expires_at}). Automatically refunded to customer.`,
            metadata: { eventId, transactionRef, amount },
          });

          await client.query(
            `INSERT INTO system_alerts (order_no, alert_type, message)
             VALUES ($1, $2, $3)`,
            [
              orderNo,
              AlertType.PAYMENT_EXPIRED,
              `Customer paid ฿${amount} after expiration. Auto-refunded transactionRef: ${transactionRef}`,
            ]
          );

          return {
            status: 'REFUNDED_DUE_TO_EXPIRY',
            message: 'Payment arrived after order expiration. Auto-refund initiated.',
            orderNo,
          };
        }

        // Normal Payment: Transition PENDING_PAYMENT -> QUEUED
        await client.query(
          `UPDATE orders 
           SET status = $1, updated_at = NOW(), version = version + 1 
           WHERE order_no = $2`,
          [OrderStatus.QUEUED, orderNo]
        );

        await OrderRepository.addTimelineEntry(client, {
          orderNo,
          fromStatus: OrderStatus.PENDING_PAYMENT,
          toStatus: OrderStatus.QUEUED,
          actor: ActorType.BANK_WEBHOOK,
          action: 'BANK_PAYMENT_CONFIRMED',
          reason: `Bank confirmed payment of ฿${amount}. Queued for bot fulfillment.`,
          metadata: { eventId, transactionRef, amount },
        });

        return {
          status: 'PAID_AND_QUEUED',
          message: 'Payment verified successfully and order queued for bot',
          orderNo,
        };
      }

      if (order.status === OrderStatus.EXPIRED) {
        // Order was already marked EXPIRED by scheduler
        logger.warn(`Payment arrived for order already marked EXPIRED: ${orderNo}. Auto-refunding.`, {
          orderNo,
          eventId,
        });

        await client.query(
          `UPDATE orders 
           SET status = $1, updated_at = NOW(), version = version + 1 
           WHERE order_no = $2`,
          [OrderStatus.REFUNDED, orderNo]
        );

        await OrderRepository.addTimelineEntry(client, {
          orderNo,
          fromStatus: OrderStatus.EXPIRED,
          toStatus: OrderStatus.REFUNDED,
          actor: ActorType.BANK_WEBHOOK,
          action: 'EXPIRED_ORDER_PAYMENT_REFUNDED',
          reason: `Late payment arrived on EXPIRED order. Auto-refund initiated.`,
          metadata: { eventId, transactionRef, amount },
        });

        return {
          status: 'REFUNDED_DUE_TO_EXPIRY',
          message: 'Payment received on expired order. Refund initiated.',
          orderNo,
        };
      }

      // Order is already QUEUED, IN_PROGRESS, or COMPLETED -> duplicate webhook event
      logger.info(`Webhook payment received for order already in state ${order.status}: ${orderNo}`, {
        orderNo,
        status: order.status,
      });

      return {
        status: 'ALREADY_PROCESSED',
        message: `Order is already in progress or completed (${order.status}). Ignored idempotently.`,
        orderNo,
        currentStatus: order.status,
      };
    });
  }
}
