import { ErrorCode } from '../constants/errorCodes';

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly errorCode: ErrorCode;
  public readonly details: any;

  constructor(
    statusCode: number,
    errorCode: ErrorCode,
    message: string,
    details: any = null
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(message: string, errorCode = ErrorCode.VALIDATION_ERROR, details: any = null) {
    return new AppError(400, errorCode, message, details);
  }

  static notFound(message: string, errorCode = ErrorCode.ORDER_NOT_FOUND) {
    return new AppError(404, errorCode, message);
  }

  static conflict(message: string, errorCode = ErrorCode.INVALID_STATE_TRANSITION, details: any = null) {
    return new AppError(409, errorCode, message, details);
  }

  static unauthorized(message: string, errorCode = ErrorCode.UNAUTHORIZED_SIGNATURE) {
    return new AppError(401, errorCode, message);
  }

  static internal(message: string = 'Internal server error', details: any = null) {
    return new AppError(500, ErrorCode.INTERNAL_SERVER_ERROR, message, details);
  }
}
