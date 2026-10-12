import { query, withTransaction } from '../../config/database';
import { OrderRepository, OrderRow } from '../orders/order.repository';
import { OrderStatus, ActorType, AlertType } from '../../constants/orderStatus';
import { config } from '../../config/env';
import { logger } from '../../utils/logger';

export class RecoveryWorker {
  private static timer: NodeJS.Timeout | null = null;
  private static isRunning = false;

  /**
   * Starts the background recovery worker loop
   */
  static start(): void {
    if (this.timer) return;

    const intervalMs = config.scheduler.recoveryWorkerIntervalSeconds * 1000;
    logger.info(`Starting Recovery Worker (Interval: ${config.scheduler.recoveryWorkerIntervalSeconds}s)...`);

    this.timer = setInterval(() => {
      this.runRecoveryCycle().catch((err) => {
        logger.error('Error during recovery cycle', { error: err.message });
      });
    }, intervalMs);
  }

  /**
   * Stops the background worker
   */
  static stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('Recovery Worker stopped.');
    }
  }

  /**
   * Runs a complete recovery cycle for Case 1 (bot crash) and Case 5 (order expiry & SLA)
   */
  static async runRecoveryCycle(): Promise<{
    recoveredLeases: number;
    delayedLeases: number;
    expiredPayments: number;
    slaBreaches: number;
  }> {
    if (this.isRunning) {
      return { recoveredLeases: 0, delayedLeases: 0, expiredPayments: 0, slaBreaches: 0 };
    }

    this.isRunning = true;
    let recoveredLeases = 0;
    let delayedLeases = 0;
    let expiredPayments = 0;
    let slaBreaches = 0;

    try {
      // =========================================================================
      // Case 1: Detect Bot Crash / Expired Leases (Heartbeat Timeout)
      // =========================================================================
      const expiredLeases = await query<OrderRow>(
        `SELECT * FROM orders 
         WHERE status = $1 
           AND locked_until IS NOT NULL 
           AND locked_until < NOW()`,
        [OrderStatus.IN_PROGRESS]
      );

      for (const order of expiredLeases.rows) {
        await withTransaction(async (client) => {
          const currentRetry = order.retry_count + 1;
          const maxRetries = order.max_retries || 3;

          if (currentRetry < maxRetries) {
            // Re-queue order for another bot worker with backoff
            await client.query(
              `UPDATE orders 
               SET status = $1, 
                   retry_count = $2, 
                   locked_by = NULL, 
                   locked_until = NULL, 
                   updated_at = NOW(),
                   version = version + 1
               WHERE order_no = $3`,
              [OrderStatus.QUEUED, currentRetry, order.order_no]
            );

            await OrderRepository.addTimelineEntry(client, {
              orderNo: order.order_no,
              fromStatus: OrderStatus.IN_PROGRESS,
              toStatus: OrderStatus.QUEUED,
              actor: ActorType.SYSTEM,
              action: 'BOT_HEARTBEAT_LEASE_EXPIRED_RETRY',
              reason: `Bot ${order.locked_by || 'UNKNOWN'} went silent. Lease expired at ${order.locked_until?.toISOString()}. Auto-retrying (${currentRetry}/${maxRetries}).`,
              metadata: {
                previousBot: order.locked_by,
                retryCount: currentRetry,
                maxRetries,
                lastHeartbeat: order.last_heartbeat_at,
              },
            });

            logger.warn(`Recovered dead lease on order ${order.order_no}. Re-queued for retry.`, {
              orderNo: order.order_no,
              retryCount: currentRetry,
              previousBot: order.locked_by,
            });

            recoveredLeases++;
          } else {
            // Exceeded max retries -> Move to DELAYED and raise alert
            await client.query(
              `UPDATE orders 
               SET status = $1, 
                   retry_count = $2, 
                   locked_by = NULL, 
                   locked_until = NULL, 
                   failure_reason = $3,
                   updated_at = NOW(),
                   version = version + 1
               WHERE order_no = $4`,
              [
                OrderStatus.DELAYED,
                currentRetry,
                `Bot crashed repeatedly. Exceeded max retries (${currentRetry}/${maxRetries}).`,
                order.order_no,
              ]
            );

            await client.query(
              `INSERT INTO system_alerts (order_no, alert_type, message)
               VALUES ($1, $2, $3)`,
              [
                order.order_no,
                AlertType.BOT_CRASH_MAX_RETRY,
                `Order ${order.order_no} moved to DELAYED because bot ${order.locked_by} died and exceeded ${maxRetries} retry attempts.`,
              ]
            );

            await OrderRepository.addTimelineEntry(client, {
              orderNo: order.order_no,
              fromStatus: OrderStatus.IN_PROGRESS,
              toStatus: OrderStatus.DELAYED,
              actor: ActorType.SYSTEM,
              action: 'BOT_CRASH_MAX_RETRIES_EXCEEDED_DELAYED',
              reason: `Bot went silent repeatedly. Max retries (${maxRetries}) exceeded. Held for manual admin inspection.`,
              metadata: {
                previousBot: order.locked_by,
                retryCount: currentRetry,
                maxRetries,
              },
            });

            logger.error(`Order ${order.order_no} exceeded max retries. Moved to DELAYED.`, {
              orderNo: order.order_no,
              retryCount: currentRetry,
            });

            delayedLeases++;
          }
        });
      }

      // =========================================================================
      // Case 5: Sweep Expired Payments (Customer didn't pay within window)
      // =========================================================================
      const expiredPaymentsRes = await query<OrderRow>(
        `SELECT * FROM orders 
         WHERE status = $1 
           AND expires_at < NOW()`,
        [OrderStatus.PENDING_PAYMENT]
      );

      for (const order of expiredPaymentsRes.rows) {
        await withTransaction(async (client) => {
          await client.query(
            `UPDATE orders 
             SET status = $1, updated_at = NOW(), version = version + 1 
             WHERE order_no = $2`,
            [OrderStatus.EXPIRED, order.order_no]
          );

          await OrderRepository.addTimelineEntry(client, {
            orderNo: order.order_no,
            fromStatus: OrderStatus.PENDING_PAYMENT,
            toStatus: OrderStatus.EXPIRED,
            actor: ActorType.SYSTEM,
            action: 'PAYMENT_EXPIRED_SWEEP',
            reason: `Order payment timeout reached (${order.expires_at.toISOString()}). Automatically marked as EXPIRED.`,
            metadata: { expiresAt: order.expires_at },
          });

          expiredPayments++;
        });
      }

      // =========================================================================
      // Case 5: SLA Breach Detection (Queued longer than SLA threshold)
      // =========================================================================
      const slaTimeoutSeconds = config.scheduler.slaQueueTimeoutSeconds;
      const slaBreachesRes = await query<OrderRow>(
        `SELECT * FROM orders 
         WHERE status = $1 
           AND sla_breached = FALSE 
           AND created_at < NOW() - ($2 || ' seconds')::INTERVAL`,
        [OrderStatus.QUEUED, `${slaTimeoutSeconds}`]
      );

      for (const order of slaBreachesRes.rows) {
        await withTransaction(async (client) => {
          await client.query(
            `UPDATE orders 
             SET status = $1, sla_breached = TRUE, updated_at = NOW(), version = version + 1 
             WHERE order_no = $2`,
            [OrderStatus.DELAYED, order.order_no]
          );

          await client.query(
            `INSERT INTO system_alerts (order_no, alert_type, message)
             VALUES ($1, $2, $3)`,
            [
              order.order_no,
              AlertType.SLA_BREACH,
              `Order ${order.order_no} breached queue SLA (${slaTimeoutSeconds}s without bot pickup). Moved to DELAYED.`,
            ]
          );

          await OrderRepository.addTimelineEntry(client, {
            orderNo: order.order_no,
            fromStatus: OrderStatus.QUEUED,
            toStatus: OrderStatus.DELAYED,
            actor: ActorType.SYSTEM,
            action: 'SLA_BREACH_DELAYED',
            reason: `Order waited in QUEUED longer than SLA threshold (${slaTimeoutSeconds}s). Marked as DELAYED for investigation.`,
            metadata: { slaTimeoutSeconds },
          });

          slaBreaches++;
        });
      }
    } finally {
      this.isRunning = false;
    }

    return {
      recoveredLeases,
      delayedLeases,
      expiredPayments,
      slaBreaches,
    };
  }
}
