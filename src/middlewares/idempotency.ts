import { Request, Response, NextFunction } from 'express';
import { query } from '../config/database';
import { hashPayload } from '../utils/crypto';
import { AppError } from '../errors/appError';
import { ErrorCode } from '../constants/errorCodes';
import { logger } from '../utils/logger';

export function idempotencyMiddleware(options?: { required?: boolean }) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const idempotencyKey = (req.headers['idempotency-key'] || req.headers['x-idempotency-key']) as string | undefined;

    if (!idempotencyKey) {
      if (options?.required) {
        throw AppError.badRequest('Idempotency-Key header is required for this operation', ErrorCode.VALIDATION_ERROR);
      }
      return next();
    }

    const currentHash = hashPayload({
      path: req.originalUrl,
      body: req.body,
    });

    try {
      const existing = await query(
        `SELECT key, request_hash, response_status, response_body, expires_at 
         FROM idempotency_records 
         WHERE key = $1`,
        [idempotencyKey]
      );

      if (existing.rows.length > 0) {
        const record = existing.rows[0];

        // Check if payload matches
        if (record.request_hash !== currentHash) {
          throw AppError.conflict(
            `Idempotency-Key '${idempotencyKey}' was already used with a different request payload`,
            ErrorCode.IDEMPOTENCY_CONFLICT,
            { key: idempotencyKey }
          );
        }

        logger.info(`Idempotent cache hit for key: ${idempotencyKey}`, {
          key: idempotencyKey,
          correlationId: req.correlationId,
        });

        res.setHeader('X-Cache-Lookup', 'HIT');
        res.status(record.response_status).json(record.response_body);
        return;
      }

      // Intercept res.json to cache response upon completion
      const originalJson = res.json.bind(res);
      res.json = (body: any) => {
        // Only cache successful or client error responses (don't cache 500s)
        if (res.statusCode < 500) {
          const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours expiry
          query(
            `INSERT INTO idempotency_records (key, request_path, request_hash, response_status, response_body, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (key) DO NOTHING`,
            [idempotencyKey, req.originalUrl, currentHash, res.statusCode, body, expiresAt]
          ).catch((err) => {
            logger.error('Failed to store idempotency record', { error: err.message, key: idempotencyKey });
          });
        }
        res.setHeader('X-Cache-Lookup', 'MISS');
        return originalJson(body);
      };

      next();
    } catch (error) {
      next(error);
    }
  };
}
