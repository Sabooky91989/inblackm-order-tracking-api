import { Request, Response, NextFunction } from 'express';
import { WebhookService } from './webhook.service';
import { z } from 'zod';

const bankWebhookSchema = z.object({
  eventId: z.string().min(1, 'eventId is required'),
  orderNo: z.string().min(1, 'orderNo is required'),
  amount: z.number().positive('amount must be positive'),
  transactionRef: z.string().min(1, 'transactionRef is required'),
  timestamp: z.string().optional().default(() => new Date().toISOString()),
});

export class WebhookController {
  /**
   * POST /webhooks/bank-payment
   * Bank payment confirmation webhook
   */
  static async handleBankPayment(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const signature = (req.headers['x-signature'] || req.headers['x-hub-signature']) as string | undefined;
      const validatedBody = bankWebhookSchema.parse(req.body);

      const result = await WebhookService.processBankPayment(validatedBody, signature, req.body);

      res.status(200).json({
        success: true,
        data: result,
        traceId: req.correlationId,
      });
    } catch (error) {
      next(error);
    }
  }
}
