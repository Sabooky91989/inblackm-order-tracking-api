import { OrderStateMachine } from '../../src/modules/orders/stateMachine';
import { OrderStatus } from '../../src/constants/orderStatus';
import { AppError } from '../../src/errors/appError';
import { ErrorCode } from '../../src/constants/errorCodes';

describe('OrderStateMachine Unit Tests', () => {
  describe('Happy Path State Transitions', () => {
    it('should allow PENDING_PAYMENT -> QUEUED', () => {
      expect(OrderStateMachine.canTransition(OrderStatus.PENDING_PAYMENT, OrderStatus.QUEUED)).toBe(true);
      expect(() => OrderStateMachine.validateTransition(OrderStatus.PENDING_PAYMENT, OrderStatus.QUEUED)).not.toThrow();
    });

    it('should allow QUEUED -> IN_PROGRESS', () => {
      expect(OrderStateMachine.canTransition(OrderStatus.QUEUED, OrderStatus.IN_PROGRESS)).toBe(true);
    });

    it('should allow IN_PROGRESS -> COMPLETED', () => {
      expect(OrderStateMachine.canTransition(OrderStatus.IN_PROGRESS, OrderStatus.COMPLETED)).toBe(true);
    });
  });

  describe('Problem Case Transitions', () => {
    it('Case 1 & 4 (Retry): should allow IN_PROGRESS -> QUEUED (transient retry)', () => {
      expect(OrderStateMachine.canTransition(OrderStatus.IN_PROGRESS, OrderStatus.QUEUED)).toBe(true);
    });

    it('Case 1 (Max Retries Exceeded): should allow IN_PROGRESS -> DELAYED', () => {
      expect(OrderStateMachine.canTransition(OrderStatus.IN_PROGRESS, OrderStatus.DELAYED)).toBe(true);
    });

    it('Case 4 (Permanent Error): should allow IN_PROGRESS -> FAILED', () => {
      expect(OrderStateMachine.canTransition(OrderStatus.IN_PROGRESS, OrderStatus.FAILED)).toBe(true);
    });

    it('Case 4 Self-healing: should allow FAILED -> QUEUED when customer fixes UID', () => {
      expect(OrderStateMachine.canTransition(OrderStatus.FAILED, OrderStatus.QUEUED)).toBe(true);
    });

    it('Case 5 (Expiry): should allow PENDING_PAYMENT -> EXPIRED', () => {
      expect(OrderStateMachine.canTransition(OrderStatus.PENDING_PAYMENT, OrderStatus.EXPIRED)).toBe(true);
    });

    it('Case 3 (Late Payment on Expired Order): should allow EXPIRED -> REFUNDED', () => {
      expect(OrderStateMachine.canTransition(OrderStatus.EXPIRED, OrderStatus.REFUNDED)).toBe(true);
    });
  });

  describe('Illegal State Transitions', () => {
    it('should reject invalid transition PENDING_PAYMENT -> COMPLETED (bypassing payment & bot)', () => {
      expect(OrderStateMachine.canTransition(OrderStatus.PENDING_PAYMENT, OrderStatus.COMPLETED)).toBe(false);
      expect(() =>
        OrderStateMachine.validateTransition(OrderStatus.PENDING_PAYMENT, OrderStatus.COMPLETED, 'ORD-123')
      ).toThrow(AppError);
    });

    it('should reject transitions from terminal state COMPLETED', () => {
      expect(OrderStateMachine.canTransition(OrderStatus.COMPLETED, OrderStatus.QUEUED)).toBe(false);
      expect(OrderStateMachine.canTransition(OrderStatus.COMPLETED, OrderStatus.IN_PROGRESS)).toBe(false);
      expect(OrderStateMachine.canTransition(OrderStatus.COMPLETED, OrderStatus.PENDING_PAYMENT)).toBe(false);
    });

    it('should throw AppError with status 409 and ErrorCode.INVALID_STATE_TRANSITION', () => {
      try {
        OrderStateMachine.validateTransition(OrderStatus.COMPLETED, OrderStatus.QUEUED, 'ORD-999');
        fail('Should have thrown an AppError');
      } catch (err: any) {
        expect(err).toBeInstanceOf(AppError);
        expect(err.statusCode).toBe(409);
        expect(err.errorCode).toBe(ErrorCode.INVALID_STATE_TRANSITION);
      }
    });
  });

  describe('Idempotent Same-State Transition', () => {
    it('should allow same status transition without throwing', () => {
      expect(OrderStateMachine.canTransition(OrderStatus.QUEUED, OrderStatus.QUEUED)).toBe(true);
    });
  });
});
