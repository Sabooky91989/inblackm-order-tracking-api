import { OrderStatus } from '../../constants/orderStatus';
import { AppError } from '../../errors/appError';
import { ErrorCode } from '../../constants/errorCodes';

/**
 * Valid state transitions definition:
 * Key: Current status
 * Value: Array of allowable next statuses
 */
export const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.PENDING_PAYMENT]: [
    OrderStatus.QUEUED,
    OrderStatus.EXPIRED,
    OrderStatus.FAILED,
  ],
  [OrderStatus.QUEUED]: [
    OrderStatus.IN_PROGRESS,
    OrderStatus.DELAYED,
    OrderStatus.REFUNDED,
  ],
  [OrderStatus.IN_PROGRESS]: [
    OrderStatus.COMPLETED,
    OrderStatus.QUEUED,      // Retry on transient failure / lease timeout
    OrderStatus.DELAYED,     // Retries exhausted or transient provider hold
    OrderStatus.FAILED,      // Permanent error (e.g. invalid UID)
  ],
  [OrderStatus.DELAYED]: [
    OrderStatus.QUEUED,      // Resumed by admin or auto-recovery
    OrderStatus.FAILED,      // Mark as permanent failure
    OrderStatus.REFUNDED,    // Refunded to customer
  ],
  [OrderStatus.FAILED]: [
    OrderStatus.QUEUED,      // Customer updated UID / admin retried
    OrderStatus.REFUNDED,    // Customer requested refund
  ],
  [OrderStatus.EXPIRED]: [
    OrderStatus.REFUNDED,    // Late payment arrived after expiration
  ],
  [OrderStatus.COMPLETED]: [], // Terminal state
  [OrderStatus.REFUNDED]: [],  // Terminal state
};

export class OrderStateMachine {
  /**
   * Checks if transition is valid
   */
  static canTransition(from: OrderStatus, to: OrderStatus): boolean {
    if (from === to) return true; // Idempotent same-state check
    const allowed = ALLOWED_TRANSITIONS[from];
    return allowed ? allowed.includes(to) : false;
  }

  /**
   * Asserts transition validity or throws AppError
   */
  static validateTransition(from: OrderStatus, to: OrderStatus, orderNo?: string): void {
    if (!this.canTransition(from, to)) {
      throw AppError.conflict(
        `Invalid status transition from ${from} to ${to}${orderNo ? ` for order ${orderNo}` : ''}`,
        ErrorCode.INVALID_STATE_TRANSITION,
        {
          fromStatus: from,
          toStatus: to,
          allowedNextStatuses: ALLOWED_TRANSITIONS[from] || [],
        }
      );
    }
  }
}
