import { Request, Response, NextFunction } from 'express';
import { BotService } from './bot.service';
import { z } from 'zod';
import { FailureType } from '../../constants/orderStatus';

const claimSchema = z.object({
  botId: z.string().min(1, 'botId is required'),
});

const heartbeatSchema = z.object({
  botId: z.string().min(1, 'botId is required'),
});

const completeSchema = z.object({
  botId: z.string().min(1, 'botId is required'),
  metadata: z.any().optional(),
});

const failSchema = z.object({
  botId: z.string().min(1, 'botId is required'),
  errorType: z.nativeEnum(FailureType),
  errorCode: z.string().min(1, 'errorCode is required'),
  errorMessage: z.string().min(1, 'errorMessage is required'),
});

export class BotController {
  /**
   * POST /bot/claim
   * Bot worker requests next available queued order
   */
  static async claimOrder(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { botId } = claimSchema.parse(req.body);
      const order = await BotService.claimOrder(botId);

      if (!order) {
        res.status(200).json({
          success: true,
          message: 'No pending orders available in queue',
          data: null,
          traceId: req.correlationId,
        });
        return;
      }

      res.status(200).json({
        success: true,
        message: `Order ${order.order_no} claimed successfully by bot ${botId}`,
        data: order,
        traceId: req.correlationId,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /bot/orders/:orderNo/heartbeat
   * Bot worker extends active lease lock
   */
  static async heartbeat(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const orderNo = req.params.orderNo as string;
      const { botId } = heartbeatSchema.parse(req.body);

      const order = await BotService.heartbeat(orderNo, botId);

      res.status(200).json({
        success: true,
        message: 'Heartbeat renewed successfully',
        data: {
          orderNo: order.order_no,
          lockedUntil: order.locked_until,
        },
        traceId: req.correlationId,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /bot/orders/:orderNo/complete
   * Bot marks order as successfully finished
   */
  static async complete(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const orderNo = req.params.orderNo as string;
      const { botId, metadata } = completeSchema.parse(req.body);

      const order = await BotService.completeOrder(orderNo, botId, metadata);

      res.status(200).json({
        success: true,
        message: 'Order completed successfully',
        data: order,
        traceId: req.correlationId,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /bot/orders/:orderNo/fail
   * Bot reports failure (transient vs permanent)
   */
  static async fail(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const orderNo = req.params.orderNo as string;
      const { botId, errorType, errorCode, errorMessage } = failSchema.parse(req.body);

      const order = await BotService.reportFailure(orderNo, botId, errorType, errorCode, errorMessage);

      res.status(200).json({
        success: true,
        message: `Failure reported: ${errorType} (${errorCode})`,
        data: order,
        traceId: req.correlationId,
      });
    } catch (error) {
      next(error);
    }
  }
}
