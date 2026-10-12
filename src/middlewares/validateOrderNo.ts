import { Request, Response, NextFunction } from 'express';
import { isValidOrderNo } from '../utils/orderNoGenerator';
import { AppError } from '../errors/appError';
import { ErrorCode } from '../constants/errorCodes';

export function validateOrderNoParam(req: Request, res: Response, next: NextFunction): void {
  const rawOrderNo = req.params.orderNo;
  const orderNo = Array.isArray(rawOrderNo) ? rawOrderNo[0] : rawOrderNo;

  if (!orderNo || typeof orderNo !== 'string' || !isValidOrderNo(orderNo)) {
    throw AppError.badRequest(
      `Invalid order number format: '${orderNo}'. Expected format ORD-{digits}-{digits} (e.g. ORD-2587965432159-458)`,
      ErrorCode.INVALID_ORDER_FORMAT,
      {
        received: orderNo,
        expectedFormat: 'ORD-\\d+-\\d+',
        example: 'ORD-2587965432159-458',
      }
    );
  }

  req.orderNo = orderNo;
  next();
}
