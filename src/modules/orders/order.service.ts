import { OrderRepository, OrderRow, TimelineRow } from './order.repository';
import { generateOrderNo } from '../../utils/orderNoGenerator';
import { OrderStatus, CURRENT_ORDER_STATUSES, HISTORY_ORDER_STATUSES, ActorType } from '../../constants/orderStatus';
import { AppError } from '../../errors/appError';
import { config } from '../../config/env';
import { CreateOrderInput, ReportIssueInput } from './order.validator';
import { logger } from '../../utils/logger';

export class OrderService {
  /**
   * Creates a new game top-up order
   */
  static async createOrder(
    input: CreateOrderInput,
    idempotencyKey?: string
  ): Promise<OrderRow> {
    const orderNo = generateOrderNo();
    const expiresAt = new Date(Date.now() + config.scheduler.paymentExpiryMinutes * 60 * 1000);

    const order = await OrderRepository.createOrder({
      orderNo,
      customerId: input.customerId,
      gameId: input.gameId,
      packageId: input.packageId,
      playerUid: input.playerUid,
      amount: input.amount,
      currency: input.currency || 'THB',
      expiresAt,
      idempotencyKey,
    });

    logger.info(`Order created successfully: ${orderNo}`, {
      orderNo,
      customerId: input.customerId,
      amount: input.amount,
      expiresAt,
    });

    return order;
  }

  /**
   * Retrieves order by orderNo, returns 404 if not found
   */
  static async getOrderByNo(orderNo: string): Promise<OrderRow> {
    const order = await OrderRepository.findByOrderNo(orderNo);
    if (!order) {
      throw AppError.notFound(`Order with number '${orderNo}' was not found`);
    }
    return order;
  }

  /**
   * Lists orders separated by current / history tabs with pagination
   */
  static async listOrders(
    tab: 'current' | 'history',
    page: number = 1,
    limit: number = 10
  ) {
    const statuses = tab === 'current' ? CURRENT_ORDER_STATUSES : HISTORY_ORDER_STATUSES;
    return OrderRepository.listOrders(statuses, page, limit);
  }

  /**
   * Retrieves full chronological timeline of status transitions
   */
  static async getOrderTimeline(orderNo: string): Promise<TimelineRow[]> {
    // Ensure order exists
    await this.getOrderByNo(orderNo);
    return OrderRepository.getOrderTimeline(orderNo);
  }

  /**
   * Customer reports an issue on an order
   */
  static async reportIssue(orderNo: string, input: ReportIssueInput) {
    const order = await this.getOrderByNo(orderNo);

    // Record issue in order_issues table
    const issue = await OrderRepository.createIssue(
      orderNo,
      input.customerId,
      input.issueType,
      input.description
    );

    // If order is currently active, transition to DELAYED for investigation
    if (
      order.status === OrderStatus.PENDING_PAYMENT ||
      order.status === OrderStatus.QUEUED ||
      order.status === OrderStatus.IN_PROGRESS
    ) {
      await OrderRepository.updateOrderStatus(
        orderNo,
        OrderStatus.DELAYED,
        ActorType.CUSTOMER,
        'CUSTOMER_REPORTED_ISSUE',
        {
          reason: `Issue reported: ${input.issueType} - ${input.description}`,
          metadata: { issueId: issue.id, issueType: input.issueType },
          clearLock: true,
        }
      );
    } else {
      // For terminal orders, record event in timeline without altering terminal state
      await OrderRepository.addTimelineEntry(null, {
        orderNo,
        fromStatus: order.status,
        toStatus: order.status,
        actor: ActorType.CUSTOMER,
        action: 'CUSTOMER_REPORTED_ISSUE',
        reason: `Post-completion issue reported: ${input.issueType} - ${input.description}`,
        metadata: { issueId: issue.id, issueType: input.issueType },
      });
    }

    logger.warn(`Issue reported for order: ${orderNo}`, {
      orderNo,
      issueType: input.issueType,
      customerId: input.customerId,
    });

    return {
      message: 'Issue reported successfully and queued for admin review',
      issue,
    };
  }

  /**
   * Simulates customer payment or internal payment confirmation
   */
  static async payOrder(orderNo: string, paymentRef?: string): Promise<OrderRow> {
    const order = await this.getOrderByNo(orderNo);

    if (order.status !== OrderStatus.PENDING_PAYMENT) {
      throw AppError.conflict(
        `Order ${orderNo} cannot be paid. Current status is ${order.status}`
      );
    }

    if (new Date() > new Date(order.expires_at)) {
      throw AppError.badRequest(
        `Payment window for order ${orderNo} has expired`,
        undefined,
        { expiresAt: order.expires_at }
      );
    }

    return OrderRepository.updateOrderStatus(
      orderNo,
      OrderStatus.QUEUED,
      ActorType.CUSTOMER,
      'PAYMENT_RECEIVED',
      {
        reason: 'Payment confirmed via payment gateway',
        metadata: { paymentRef: paymentRef || `PAY-${Date.now()}` },
      }
    );
  }

  /**
   * Problem Case 4: Corrects invalid UID and re-queues order
   */
  static async retryWithNewUid(orderNo: string, newPlayerUid: string): Promise<OrderRow> {
    return OrderRepository.updateUidAndRequeue(orderNo, newPlayerUid);
  }

  /**
   * Refunds order
   */
  static async refundOrder(orderNo: string, reason: string): Promise<OrderRow> {
    const order = await this.getOrderByNo(orderNo);

    if (
      order.status !== OrderStatus.DELAYED &&
      order.status !== OrderStatus.FAILED &&
      order.status !== OrderStatus.QUEUED &&
      order.status !== OrderStatus.EXPIRED
    ) {
      throw AppError.conflict(
        `Cannot refund order in status ${order.status}. Allowed statuses for refund: DELAYED, FAILED, QUEUED, EXPIRED`
      );
    }

    return OrderRepository.updateOrderStatus(
      orderNo,
      OrderStatus.REFUNDED,
      ActorType.ADMIN,
      'ORDER_REFUNDED',
      {
        reason,
        clearLock: true,
      }
    );
  }
}
