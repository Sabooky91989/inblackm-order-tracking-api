import { Request, Response, NextFunction } from 'express';
import { OrderService } from './order.service';
import {
  createOrderSchema,
  listOrdersQuerySchema,
  reportIssueSchema,
  retryUidSchema,
  refundSchema,
} from './order.validator';

export class OrderController {
  /**
   * POST /orders
   * Create order, accepts Idempotency-Key header to prevent duplicate creation
   */
  static async createOrder(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const validatedBody = createOrderSchema.parse(req.body);
      const idempotencyKey = (req.headers['idempotency-key'] || req.headers['x-idempotency-key']) as string | undefined;

      const order = await OrderService.createOrder(validatedBody, idempotencyKey);

      res.status(201).json({
        success: true,
        message: 'Order created successfully',
        data: order,
        traceId: req.correlationId,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /orders/:orderNo
   * Find order by ORD- format number. Validates format (400) and existence (404)
   */
  static async getOrderByNo(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const orderNo = req.params.orderNo as string;
      const order = await OrderService.getOrderByNo(orderNo);

      res.status(200).json({
        success: true,
        data: order,
        traceId: req.correlationId,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /orders?tab=current|history&page=&limit=
   * List orders separated by current/history with pagination
   */
  static async listOrders(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const query = listOrdersQuerySchema.parse(req.query);
      const result = await OrderService.listOrders(query.tab, query.page, query.limit);

      res.status(200).json({
        success: true,
        data: {
          orders: result.orders,
          pagination: {
            total: result.total,
            page: result.page,
            limit: result.limit,
            totalPages: result.totalPages,
            hasNextPage: result.page < result.totalPages,
            hasPrevPage: result.page > 1,
          },
        },
        traceId: req.correlationId,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /orders/:orderNo/timeline
   * Timeline history of status transitions with timestamps
   */
  static async getOrderTimeline(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const orderNo = req.params.orderNo as string;
      const timeline = await OrderService.getOrderTimeline(orderNo);

      res.status(200).json({
        success: true,
        data: {
          orderNo,
          timeline,
        },
        traceId: req.correlationId,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /orders/:orderNo/report-issue
   * Customer reports an issue
   */
  static async reportIssue(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const orderNo = req.params.orderNo as string;
      const validatedBody = reportIssueSchema.parse(req.body);

      const result = await OrderService.reportIssue(orderNo, validatedBody);

      res.status(200).json({
        success: true,
        message: result.message,
        data: result.issue,
        traceId: req.correlationId,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /orders/:orderNo/pay
   * Simulates customer payment confirmation
   */
  static async payOrder(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const orderNo = req.params.orderNo as string;
      const { paymentRef } = req.body || {};
      const order = await OrderService.payOrder(orderNo, paymentRef);

      res.status(200).json({
        success: true,
        message: 'Payment received and order moved to QUEUED',
        data: order,
        traceId: req.correlationId,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /orders/:orderNo/retry-uid
   * Problem Case 4 self-healing: Update UID and re-queue order
   */
  static async retryUid(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const orderNo = req.params.orderNo as string;
      const { newPlayerUid } = retryUidSchema.parse(req.body);

      const updated = await OrderService.retryWithNewUid(orderNo, newPlayerUid);

      res.status(200).json({
        success: true,
        message: 'Player UID updated successfully. Order returned to queue.',
        data: updated,
        traceId: req.correlationId,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /orders/:orderNo/refund
   * Refunds order
   */
  static async refundOrder(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const orderNo = req.params.orderNo as string;
      const { reason } = refundSchema.parse(req.body);

      const refunded = await OrderService.refundOrder(orderNo, reason);

      res.status(200).json({
        success: true,
        message: 'Order refunded successfully',
        data: refunded,
        traceId: req.correlationId,
      });
    } catch (error) {
      next(error);
    }
  }
}
