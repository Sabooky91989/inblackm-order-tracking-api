import { PoolClient } from 'pg';
import { query, withTransaction } from '../../config/database';
import { OrderStatus, ActorType, FailureType } from '../../constants/orderStatus';
import { OrderStateMachine } from './stateMachine';
import { AppError } from '../../errors/appError';
import { config } from '../../config/env';

export interface OrderRow {
  id: string;
  order_no: string;
  customer_id: string;
  game_id: string;
  package_id: string;
  player_uid: string;
  amount: string;
  currency: string;
  status: OrderStatus;
  retry_count: number;
  max_retries: number;
  locked_by: string | null;
  locked_until: Date | null;
  last_heartbeat_at: Date | null;
  sla_breached: boolean;
  idempotency_key: string | null;
  failure_reason: string | null;
  failure_type: FailureType | null;
  version: number;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface TimelineRow {
  id: string;
  order_no: string;
  from_status: OrderStatus | null;
  to_status: OrderStatus;
  actor: ActorType;
  action: string;
  reason: string | null;
  metadata: any;
  created_at: Date;
}

export interface OrderIssueRow {
  id: string;
  order_no: string;
  customer_id: string;
  issue_type: string;
  description: string;
  status: string;
  created_at: Date;
}

export class OrderRepository {
  /**
   * Inserts new order and logs initial timeline in a transaction
   */
  static async createOrder(
    data: {
      orderNo: string;
      customerId: string;
      gameId: string;
      packageId: string;
      playerUid: string;
      amount: number;
      currency: string;
      expiresAt: Date;
      idempotencyKey?: string;
    }
  ): Promise<OrderRow> {
    return withTransaction(async (client) => {
      const orderRes = await client.query<OrderRow>(
        `INSERT INTO orders (
          order_no, customer_id, game_id, package_id, player_uid,
          amount, currency, status, expires_at, idempotency_key
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING *`,
        [
          data.orderNo,
          data.customerId,
          data.gameId,
          data.packageId,
          data.playerUid,
          data.amount,
          data.currency,
          OrderStatus.PENDING_PAYMENT,
          data.expiresAt,
          data.idempotencyKey || null,
        ]
      );

      const order = orderRes.rows[0];

      // Initial timeline entry
      await client.query(
        `INSERT INTO order_timeline (order_no, from_status, to_status, actor, action, reason, metadata)
         VALUES ($1, NULL, $2, $3, $4, $5, $6)`,
        [
          order.order_no,
          OrderStatus.PENDING_PAYMENT,
          ActorType.CUSTOMER,
          'ORDER_CREATED',
          'Order created and waiting for payment',
          { amount: data.amount, currency: data.currency, playerUid: data.playerUid },
        ]
      );

      return order;
    });
  }

  /**
   * Find order by order_no
   */
  static async findByOrderNo(orderNo: string): Promise<OrderRow | null> {
    const res = await query<OrderRow>('SELECT * FROM orders WHERE order_no = $1', [orderNo]);
    return res.rows[0] || null;
  }

  /**
   * List orders filtered by status array with pagination
   */
  static async listOrders(
    statuses: OrderStatus[],
    page: number,
    limit: number
  ): Promise<{ orders: OrderRow[]; total: number; page: number; limit: number; totalPages: number }> {
    const offset = (page - 1) * limit;

    const countRes = await query<{ count: string }>(
      'SELECT COUNT(*) as count FROM orders WHERE status = ANY($1)',
      [statuses]
    );
    const total = parseInt(countRes.rows[0].count, 10);

    const ordersRes = await query<OrderRow>(
      `SELECT * FROM orders 
       WHERE status = ANY($1) 
       ORDER BY created_at DESC 
       LIMIT $2 OFFSET $3`,
      [statuses, limit, offset]
    );

    return {
      orders: ordersRes.rows,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    };
  }

  /**
   * Get order timeline sorted chronologically
   */
  static async getOrderTimeline(orderNo: string): Promise<TimelineRow[]> {
    const res = await query<TimelineRow>(
      'SELECT * FROM order_timeline WHERE order_no = $1 ORDER BY created_at ASC',
      [orderNo]
    );
    return res.rows;
  }

  /**
   * Adds an entry to order timeline
   */
  static async addTimelineEntry(
    client: PoolClient | null,
    entry: {
      orderNo: string;
      fromStatus: OrderStatus | null;
      toStatus: OrderStatus;
      actor: ActorType;
      action: string;
      reason?: string | null;
      metadata?: any;
    }
  ): Promise<void> {
    const sql = `
      INSERT INTO order_timeline (order_no, from_status, to_status, actor, action, reason, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `;
    const params = [
      entry.orderNo,
      entry.fromStatus,
      entry.toStatus,
      entry.actor,
      entry.action,
      entry.reason || null,
      entry.metadata || {},
    ];

    if (client) {
      await client.query(sql, params);
    } else {
      await query(sql, params);
    }
  }

  /**
   * Safely updates order status following state machine rules
   */
  static async updateOrderStatus(
    orderNo: string,
    toStatus: OrderStatus,
    actor: ActorType,
    action: string,
    options?: {
      reason?: string;
      metadata?: any;
      failureReason?: string;
      failureType?: FailureType;
      clearLock?: boolean;
    }
  ): Promise<OrderRow> {
    return withTransaction(async (client) => {
      // Lock row for update
      const currentRes = await client.query<OrderRow>(
        'SELECT * FROM orders WHERE order_no = $1 FOR UPDATE',
        [orderNo]
      );

      if (currentRes.rows.length === 0) {
        throw AppError.notFound(`Order ${orderNo} not found`);
      }

      const current = currentRes.rows[0];

      // Validate transition via state machine
      OrderStateMachine.validateTransition(current.status, toStatus, orderNo);

      let updateQuery = `
        UPDATE orders 
        SET status = $1, 
            updated_at = NOW(),
            version = version + 1
      `;
      const params: any[] = [toStatus];
      let paramIndex = 2;

      if (options?.failureReason !== undefined) {
        updateQuery += `, failure_reason = $${paramIndex++}`;
        params.push(options.failureReason);
      }

      if (options?.failureType !== undefined) {
        updateQuery += `, failure_type = $${paramIndex++}`;
        params.push(options.failureType);
      }

      if (options?.clearLock) {
        updateQuery += `, locked_by = NULL, locked_until = NULL`;
      }

      updateQuery += ` WHERE order_no = $${paramIndex++} RETURNING *`;
      params.push(orderNo);

      const updateRes = await client.query<OrderRow>(updateQuery, params);
      const updatedOrder = updateRes.rows[0];

      // Add timeline entry
      await this.addTimelineEntry(client, {
        orderNo,
        fromStatus: current.status,
        toStatus,
        actor,
        action,
        reason: options?.reason,
        metadata: options?.metadata,
      });

      return updatedOrder;
    });
  }

  /**
   * Creates an issue reported by customer
   */
  static async createIssue(
    orderNo: string,
    customerId: string,
    issueType: string,
    description: string
  ): Promise<OrderIssueRow> {
    const res = await query<OrderIssueRow>(
      `INSERT INTO order_issues (order_no, customer_id, issue_type, description)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [orderNo, customerId, issueType, description]
    );
    return res.rows[0];
  }

  /**
   * Concurrency Solution (Problem Case 2):
   * Atomic bot claim using SELECT ... FOR UPDATE SKIP LOCKED
   */
  static async claimOrderForBot(botId: string): Promise<OrderRow | null> {
    return withTransaction(async (client) => {
      // Find and lock the oldest QUEUED order that is not currently locked
      const selectRes = await client.query<OrderRow>(
        `SELECT * FROM orders 
         WHERE status = $1 
           AND (locked_until IS NULL OR locked_until < NOW())
         ORDER BY created_at ASC 
         LIMIT 1 
         FOR UPDATE SKIP LOCKED`,
        [OrderStatus.QUEUED]
      );

      if (selectRes.rows.length === 0) {
        return null;
      }

      const order = selectRes.rows[0];
      const leaseDurationSeconds = config.bot.leaseDurationSeconds;

      // Atomically assign lock to bot and transition to IN_PROGRESS
      const updateRes = await client.query<OrderRow>(
        `UPDATE orders 
         SET status = $1,
             locked_by = $2,
             locked_until = NOW() + ($3 || ' seconds')::INTERVAL,
             last_heartbeat_at = NOW(),
             updated_at = NOW(),
             version = version + 1
         WHERE order_no = $4
         RETURNING *`,
        [OrderStatus.IN_PROGRESS, botId, `${leaseDurationSeconds}`, order.order_no]
      );

      const claimedOrder = updateRes.rows[0];

      await this.addTimelineEntry(client, {
        orderNo: claimedOrder.order_no,
        fromStatus: order.status,
        toStatus: OrderStatus.IN_PROGRESS,
        actor: ActorType.BOT_WORKER,
        action: 'BOT_CLAIMED_ORDER',
        reason: `Claimed by worker ${botId} with lease duration ${leaseDurationSeconds}s`,
        metadata: { botId, leaseDurationSeconds },
      });

      return claimedOrder;
    });
  }

  /**
   * Renews heartbeat lease for a bot worker (Problem Case 1)
   */
  static async renewHeartbeat(orderNo: string, botId: string): Promise<OrderRow> {
    const leaseDurationSeconds = config.bot.leaseDurationSeconds;
    const res = await query<OrderRow>(
      `UPDATE orders 
       SET locked_until = NOW() + ($1 || ' seconds')::INTERVAL,
           last_heartbeat_at = NOW(),
           updated_at = NOW()
       WHERE order_no = $2 
         AND locked_by = $3 
         AND status = $4
       RETURNING *`,
      [`${leaseDurationSeconds}`, orderNo, botId, OrderStatus.IN_PROGRESS]
    );

    if (res.rows.length === 0) {
      throw AppError.conflict(
        `Failed to renew heartbeat: order ${orderNo} is not locked by bot ${botId} or is not IN_PROGRESS`,
        undefined,
        { orderNo, botId }
      );
    }

    return res.rows[0];
  }

  /**
   * Problem Case 4: Customer updates UID on FAILED order and requeues
   */
  static async updateUidAndRequeue(orderNo: string, newPlayerUid: string): Promise<OrderRow> {
    return withTransaction(async (client) => {
      const currentRes = await client.query<OrderRow>(
        'SELECT * FROM orders WHERE order_no = $1 FOR UPDATE',
        [orderNo]
      );

      if (currentRes.rows.length === 0) {
        throw AppError.notFound(`Order ${orderNo} not found`);
      }

      const current = currentRes.rows[0];
      if (current.status !== OrderStatus.FAILED && current.status !== OrderStatus.DELAYED) {
        throw AppError.conflict(
          `Can only retry UID for orders with status FAILED or DELAYED. Current status: ${current.status}`
        );
      }

      const oldUid = current.player_uid;

      const updateRes = await client.query<OrderRow>(
        `UPDATE orders 
         SET player_uid = $1,
             status = $2,
             retry_count = 0,
             failure_reason = NULL,
             failure_type = NULL,
             locked_by = NULL,
             locked_until = NULL,
             updated_at = NOW(),
             version = version + 1
         WHERE order_no = $3
         RETURNING *`,
        [newPlayerUid, OrderStatus.QUEUED, orderNo]
      );

      await this.addTimelineEntry(client, {
        orderNo,
        fromStatus: current.status,
        toStatus: OrderStatus.QUEUED,
        actor: ActorType.CUSTOMER,
        action: 'PLAYER_UID_UPDATED_AND_REQUEUED',
        reason: `Customer corrected player UID from ${oldUid} to ${newPlayerUid}`,
        metadata: { oldUid, newPlayerUid },
      });

      return updateRes.rows[0];
    });
  }
}
