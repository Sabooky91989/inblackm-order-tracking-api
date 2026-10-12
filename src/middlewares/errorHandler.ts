import { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors/appError';
import { ErrorCode } from '../constants/errorCodes';
import { logger } from '../utils/logger';
import { ZodError } from 'zod';

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  next: NextFunction
): void {
  const correlationId = req.correlationId || 'N/A';
  const orderNo = req.orderNo || req.params?.orderNo;

  if (err instanceof AppError) {
    logger.warn(`Handled AppError: ${err.message}`, {
      correlationId,
      orderNo,
      errorCode: err.errorCode,
      statusCode: err.statusCode,
      details: err.details,
    });

    res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.errorCode,
        message: err.message,
        details: err.details,
      },
      traceId: correlationId,
    });
    return;
  }

  // Handle Zod validation errors
  if (err instanceof ZodError) {
    const formattedDetails = err.errors.map((e) => ({
      field: e.path.join('.'),
      message: e.message,
    }));

    logger.warn('Schema validation error', {
      correlationId,
      orderNo,
      details: formattedDetails,
    });

    res.status(400).json({
      success: false,
      error: {
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid request payload or query parameters',
        details: formattedDetails,
      },
      traceId: correlationId,
    });
    return;
  }

  // Unhandled / Internal Server Error
  logger.error(`Unhandled internal error: ${err.message}`, {
    correlationId,
    orderNo,
    stack: err.stack,
  });

  res.status(500).json({
    success: false,
    error: {
      code: ErrorCode.INTERNAL_SERVER_ERROR,
      message: 'Internal server error occurred',
      details: process.env.NODE_ENV === 'development' ? err.message : null,
    },
    traceId: correlationId,
  });
}
