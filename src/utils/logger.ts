import winston from 'winston';
import { config } from '../config/env';

const customFormat = winston.format.printf(({ level, message, timestamp, orderNo, correlationId, ...meta }) => {
  const orderStr = orderNo ? ` [Order: ${orderNo}]` : '';
  const traceStr = correlationId ? ` [Trace: ${correlationId}]` : '';
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `[${timestamp}] [${level.toUpperCase()}]${traceStr}${orderStr}: ${message}${metaStr}`;
});

export const logger = winston.createLogger({
  level: config.nodeEnv === 'test' ? 'error' : 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'inblackm-order-tracking-api' },
  transports: [
    new winston.transports.Console({
      format: config.nodeEnv === 'production'
        ? winston.format.combine(
            winston.format.timestamp(),
            winston.format.json()
          )
        : winston.format.combine(
            winston.format.colorize(),
            winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
            customFormat
          ),
    }),
  ],
});
