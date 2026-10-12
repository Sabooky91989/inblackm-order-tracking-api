import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger';

declare global {
  namespace Express {
    interface Request {
      correlationId?: string;
      orderNo?: string;
    }
  }
}

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const correlationId = (req.headers['x-correlation-id'] || req.headers['x-request-id'] || uuidv4()) as string;
  req.correlationId = correlationId;
  res.setHeader('X-Correlation-Id', correlationId);

  // Extract orderNo from params or body if available
  const orderNo = (req.params.orderNo || req.body?.orderNo || req.query?.orderNo) as string | undefined;
  if (orderNo) {
    req.orderNo = orderNo;
  }

  const startTime = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - startTime;
    logger.info(`${req.method} ${req.originalUrl} - ${res.statusCode} (${duration}ms)`, {
      correlationId,
      orderNo: req.orderNo,
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      duration,
    });
  });

  next();
}
