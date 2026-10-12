import request from 'supertest';
import { app } from '../../src/app';
import { pool } from '../../src/config/database';
import { runMigrations } from '../../src/database/migrate';
import { ErrorCode } from '../../src/constants/errorCodes';
import { OrderStatus, FailureType } from '../../src/constants/orderStatus';
import { calculateHmacSignature } from '../../src/utils/crypto';
import { config } from '../../src/config/env';

describe('Order Tracking API & Problem Resolution Integration Tests', () => {
  beforeAll(async () => {
    // Ensure migrations are run before testing
    await runMigrations();
  });

  afterAll(async () => {
    // Close pool cleanly
    await pool.end();
  });

  describe('Part 1: Validation and Error Formatting', () => {
    it('GET /orders/:orderNo should return 400 with standard error format for invalid orderNo pattern', async () => {
      const res = await request(app).get('/orders/INVALID-FORMAT-999');

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('success', false);
      expect(res.body.error).toHaveProperty('code', ErrorCode.INVALID_ORDER_FORMAT);
      expect(res.body.error).toHaveProperty('message');
      expect(res.body).toHaveProperty('traceId');
    });

    it('GET /orders/:orderNo should return 404 with standard error format for non-existent order', async () => {
      const res = await request(app).get('/orders/ORD-9999999999999-999');

      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('success', false);
      expect(res.body.error).toHaveProperty('code', ErrorCode.ORDER_NOT_FOUND);
      expect(res.body).toHaveProperty('traceId');
    });

    it('GET /orders?tab=unknown should return 400 validation error', async () => {
      const res = await request(app).get('/orders?tab=invalid_tab');

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('success', false);
      expect(res.body.error).toHaveProperty('code', ErrorCode.VALIDATION_ERROR);
    });

    it('POST /orders should return 400 if required payload fields are missing or invalid', async () => {
      const res = await request(app).post('/orders').send({
        customerId: '',
        amount: -50,
      });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('success', false);
      expect(res.body.error).toHaveProperty('code', ErrorCode.VALIDATION_ERROR);
      expect(Array.isArray(res.body.error.details)).toBe(true);
    });
  });

  describe('Part 1: Happy Path Lifecycle & Idempotency', () => {
    const idempotencyKey = `TEST-IDEM-${Date.now()}`;
    let createdOrderNo: string;

    it('POST /orders should create a new order in PENDING_PAYMENT status and return 201', async () => {
      const payload = {
        customerId: 'CUST-TEST-001',
        gameId: 'ROV',
        packageId: 'ROV-POINTS-500',
        playerUid: 'UID-TEST-123',
        amount: 150.0,
      };

      const res = await request(app)
        .post('/orders')
        .set('Idempotency-Key', idempotencyKey)
        .send(payload);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('order_no');
      expect(res.body.data.order_no).toMatch(/^ORD-\d+-\d+$/);
      expect(res.body.data.status).toBe(OrderStatus.PENDING_PAYMENT);

      createdOrderNo = res.body.data.order_no;
    });

    it('POST /orders with same Idempotency-Key should return cached response (Idempotent)', async () => {
      const payload = {
        customerId: 'CUST-TEST-001',
        gameId: 'ROV',
        packageId: 'ROV-POINTS-500',
        playerUid: 'UID-TEST-123',
        amount: 150.0,
      };

      const res = await request(app)
        .post('/orders')
        .set('Idempotency-Key', idempotencyKey)
        .send(payload);

      expect(res.status).toBe(201);
      expect(res.headers['x-cache-lookup']).toBe('HIT');
      expect(res.body.data.order_no).toBe(createdOrderNo);
    });

    it('POST /orders with same Idempotency-Key but DIFFERENT body should return 409 Conflict', async () => {
      const alteredPayload = {
        customerId: 'CUST-ALTERED',
        gameId: 'VALORANT',
        packageId: 'VAL-1000',
        playerUid: 'DIFFERENT-UID',
        amount: 999.0,
      };

      const res = await request(app)
        .post('/orders')
        .set('Idempotency-Key', idempotencyKey)
        .send(alteredPayload);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe(ErrorCode.IDEMPOTENCY_CONFLICT);
    });

    it('GET /orders/:orderNo should retrieve created order details', async () => {
      const res = await request(app).get(`/orders/${createdOrderNo}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.order_no).toBe(createdOrderNo);
      expect(res.body.data.status).toBe(OrderStatus.PENDING_PAYMENT);
    });

    it('GET /orders/:orderNo/timeline should retrieve initial ORDER_CREATED entry', async () => {
      const res = await request(app).get(`/orders/${createdOrderNo}/timeline`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data.timeline)).toBe(true);
      expect(res.body.data.timeline.length).toBeGreaterThanOrEqual(1);
      expect(res.body.data.timeline[0].action).toBe('ORDER_CREATED');
    });

    it('POST /orders/:orderNo/pay should transition PENDING_PAYMENT to QUEUED', async () => {
      const res = await request(app)
        .post(`/orders/${createdOrderNo}/pay`)
        .send({ paymentRef: 'TX-PAY-001' });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe(OrderStatus.QUEUED);
    });

    it('GET /orders?tab=current should include the newly queued order', async () => {
      const res = await request(app).get('/orders?tab=current&page=1&limit=20');

      expect(res.status).toBe(200);
      expect(res.body.data.orders.some((o: any) => o.order_no === createdOrderNo)).toBe(true);
    });

    it('POST /orders/:orderNo/report-issue should record issue and transition active order to DELAYED', async () => {
      const res = await request(app)
        .post(`/orders/${createdOrderNo}/report-issue`)
        .send({
          customerId: 'CUST-TEST-001',
          issueType: 'INCORRECT_UID_ENTERED',
          description: 'Customer accidentally typed wrong server UID',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const check = await request(app).get(`/orders/${createdOrderNo}`);
      expect(check.body.data.status).toBe(OrderStatus.DELAYED);
    });
  });

  describe('Part 2: Problem Cases Solutions Verification', () => {
    describe('Case 2: Bot Race Condition & Concurrency Control', () => {
      let raceOrderNo: string;

      beforeAll(async () => {
        // Create an order specifically for the concurrency race test
        const createRes = await request(app).post('/orders').send({
          customerId: 'CUST-RACE',
          gameId: 'ROV',
          packageId: 'ROV-POINTS-500',
          playerUid: 'RACE-UID-1',
          amount: 100.0,
        });
        raceOrderNo = createRes.body.data.order_no;
        await request(app).post(`/orders/${raceOrderNo}/pay`).send({});
      });

      it('Two concurrent bots claiming at the same time must NOT claim the same order', async () => {
        // Run two simultaneous bot claim requests
        const [botARes, botBRes] = await Promise.all([
          request(app).post('/bot/claim').send({ botId: 'BOT-ALPHA' }),
          request(app).post('/bot/claim').send({ botId: 'BOT-BETA' }),
        ]);

        const orderA = botARes.body.data;
        const orderB = botBRes.body.data;

        // Either one claimed raceOrderNo and the other claimed another or null, but NEVER both the same
        if (orderA && orderB) {
          expect(orderA.order_no).not.toBe(orderB.order_no);
        }
      });
    });

    describe('Case 1: Heartbeat Lease Renewal & Bot Crash Recovery', () => {
      let crashOrderNo: string;

      beforeAll(async () => {
        const createRes = await request(app).post('/orders').send({
          customerId: 'CUST-CRASH',
          gameId: 'GENSHIN',
          packageId: 'GENSHIN-BLESSING',
          playerUid: 'CRASH-UID-1',
          amount: 179.0,
        });
        crashOrderNo = createRes.body.data.order_no;
        await request(app).post(`/orders/${crashOrderNo}/pay`).send({});
      });

      it('Bot can claim and send heartbeat to renew lease', async () => {
        // Bot claims order
        await pool.query(
          "UPDATE orders SET status = 'QUEUED', locked_by = NULL, locked_until = NULL WHERE order_no = $1",
          [crashOrderNo]
        );

        const claimRes = await request(app).post('/bot/claim').send({ botId: 'BOT-HEARTBEAT-TEST' });
        expect(claimRes.status).toBe(200);

        if (claimRes.body.data) {
          const hbRes = await request(app)
            .post(`/bot/orders/${claimRes.body.data.order_no}/heartbeat`)
            .send({ botId: 'BOT-HEARTBEAT-TEST' });

          expect(hbRes.status).toBe(200);
          expect(hbRes.body.success).toBe(true);
        }
      });

      it('Background recovery cycle detects dead lease and returns order to queue (Case 1)', async () => {
        // Force lease into past (simulating crashed bot)
        await pool.query(
          `UPDATE orders 
           SET status = 'IN_PROGRESS', 
               locked_by = 'BOT-DEAD', 
               locked_until = NOW() - INTERVAL '10 seconds',
               retry_count = 0 
           WHERE order_no = $1`,
          [crashOrderNo]
        );

        const recoveryRes = await request(app).post('/admin/run-recovery-cycle');
        expect(recoveryRes.status).toBe(200);

        const check = await request(app).get(`/orders/${crashOrderNo}`);
        expect(check.body.data.status).toBe(OrderStatus.QUEUED);
        expect(check.body.data.retry_count).toBe(1);
        expect(check.body.data.locked_by).toBeNull();
      });

      it('If dead lease exceeds max retries (3), order transitions to DELAYED and raises alert', async () => {
        // Force retry_count to 2 so next failure is 3 (exceeded)
        await pool.query(
          `UPDATE orders 
           SET status = 'IN_PROGRESS', 
               locked_by = 'BOT-DEAD-PERMANENT', 
               locked_until = NOW() - INTERVAL '10 seconds',
               retry_count = 2 
           WHERE order_no = $1`,
          [crashOrderNo]
        );

        await request(app).post('/admin/run-recovery-cycle');

        const check = await request(app).get(`/orders/${crashOrderNo}`);
        expect(check.body.data.status).toBe(OrderStatus.DELAYED);

        const alertsRes = await request(app).get('/admin/alerts');
        expect(alertsRes.body.data.some((a: any) => a.order_no === crashOrderNo)).toBe(true);
      });
    });

    describe('Case 3: Bank Webhook Idempotency & Late Expiry Handling', () => {
      let webhookOrderNo: string;

      beforeAll(async () => {
        const createRes = await request(app).post('/orders').send({
          customerId: 'CUST-WEBHOOK',
          gameId: 'ROV',
          packageId: 'ROV-500',
          playerUid: 'UID-WEBHOOK',
          amount: 150.0,
        });
        webhookOrderNo = createRes.body.data.order_no;
      });

      it('Bank webhook processes valid payment with signature and moves order to QUEUED', async () => {
        const eventId = `EVT-BANK-${Date.now()}`;
        const payload = {
          eventId,
          orderNo: webhookOrderNo,
          amount: 150.0,
          transactionRef: 'TX-BANK-9988',
        };
        const signature = calculateHmacSignature(payload, config.webhook.secret);

        const res = await request(app)
          .post('/webhooks/bank-payment')
          .set('x-signature', signature)
          .send(payload);

        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe('PAID_AND_QUEUED');

        const check = await request(app).get(`/orders/${webhookOrderNo}`);
        expect(check.body.data.status).toBe(OrderStatus.QUEUED);
      });

      it('Duplicate bank webhook with same eventId returns 200 idempotently without reprocessing', async () => {
        const eventId = `EVT-BANK-DUP-${Date.now()}`;
        const payload = {
          eventId,
          orderNo: webhookOrderNo,
          amount: 150.0,
          transactionRef: 'TX-BANK-DUP',
        };
        const signature = calculateHmacSignature(payload, config.webhook.secret);

        // First call
        await request(app)
          .post('/webhooks/bank-payment')
          .set('x-signature', signature)
          .send(payload);

        // Second call (duplicate)
        const dupRes = await request(app)
          .post('/webhooks/bank-payment')
          .set('x-signature', signature)
          .send(payload);

        expect(dupRes.status).toBe(200);
        expect(dupRes.body.data.status).toBe('IDEMPOTENT_IGNORED');
      });

      it('Late bank webhook arriving on EXPIRED order automatically initiates REFUND', async () => {
        const lateCreateRes = await request(app).post('/orders').send({
          customerId: 'CUST-LATE',
          gameId: 'ROV',
          packageId: 'ROV-500',
          playerUid: 'UID-LATE',
          amount: 150.0,
        });
        const lateOrderNo = lateCreateRes.body.data.order_no;

        // Manually mark order as EXPIRED
        await pool.query("UPDATE orders SET status = 'EXPIRED' WHERE order_no = $1", [lateOrderNo]);

        const payload = {
          eventId: `EVT-LATE-${Date.now()}`,
          orderNo: lateOrderNo,
          amount: 150.0,
          transactionRef: 'TX-LATE-BANK',
        };
        const signature = calculateHmacSignature(payload, config.webhook.secret);

        const lateRes = await request(app)
          .post('/webhooks/bank-payment')
          .set('x-signature', signature)
          .send(payload);

        expect(lateRes.status).toBe(200);
        expect(lateRes.body.data.status).toBe('REFUNDED_DUE_TO_EXPIRY');

        const check = await request(app).get(`/orders/${lateOrderNo}`);
        expect(check.body.data.status).toBe(OrderStatus.REFUNDED);
      });
    });

    describe('Case 4: Top-up Failure Classification & Customer Self-Healing', () => {
      let failOrderNo: string;

      beforeAll(async () => {
        const createRes = await request(app).post('/orders').send({
          customerId: 'CUST-FAIL',
          gameId: 'ROV',
          packageId: 'ROV-500',
          playerUid: 'WRONG-UID-999',
          amount: 150.0,
        });
        failOrderNo = createRes.body.data.order_no;

        // Set to IN_PROGRESS locked by BOT-FAIL-TEST
        await pool.query(
          "UPDATE orders SET status = 'IN_PROGRESS', locked_by = 'BOT-FAIL-TEST' WHERE order_no = $1",
          [failOrderNo]
        );
      });

      it('Permanent error (INVALID_UID) transitions directly to FAILED without retrying', async () => {
        const res = await request(app)
          .post(`/bot/orders/${failOrderNo}/fail`)
          .send({
            botId: 'BOT-FAIL-TEST',
            errorType: FailureType.PERMANENT,
            errorCode: 'INVALID_PLAYER_UID',
            errorMessage: 'Player UID does not exist on game server',
          });

        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe(OrderStatus.FAILED);
        expect(res.body.data.failure_type).toBe(FailureType.PERMANENT);
      });

      it('Customer corrects UID via /orders/:orderNo/retry-uid and re-queues order', async () => {
        const res = await request(app)
          .post(`/orders/${failOrderNo}/retry-uid`)
          .send({ newPlayerUid: 'CORRECTED-UID-12345' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.status).toBe(OrderStatus.QUEUED);
        expect(res.body.data.player_uid).toBe('CORRECTED-UID-12345');
      });
    });

    describe('Case 5: Payment Expiration Sweep & SLA Breach Monitor', () => {
      it('Orders in PENDING_PAYMENT older than expires_at are marked EXPIRED by scheduler', async () => {
        const createRes = await request(app).post('/orders').send({
          customerId: 'CUST-EXPIRY',
          gameId: 'ROV',
          packageId: 'ROV-500',
          playerUid: 'UID-EXPIRY',
          amount: 50.0,
        });
        const orderNo = createRes.body.data.order_no;

        // Force expiration time to 1 minute ago
        await pool.query("UPDATE orders SET expires_at = NOW() - INTERVAL '1 minute' WHERE order_no = $1", [orderNo]);

        await request(app).post('/admin/run-recovery-cycle');

        const check = await request(app).get(`/orders/${orderNo}`);
        expect(check.body.data.status).toBe(OrderStatus.EXPIRED);
      });

      it('Orders waiting in QUEUED longer than SLA are moved to DELAYED and create alert', async () => {
        const createRes = await request(app).post('/orders').send({
          customerId: 'CUST-SLA',
          gameId: 'ROV',
          packageId: 'ROV-500',
          playerUid: 'UID-SLA',
          amount: 50.0,
        });
        const orderNo = createRes.body.data.order_no;

        // Set to QUEUED and created_at to 10 minutes ago
        await pool.query(
          "UPDATE orders SET status = 'QUEUED', created_at = NOW() - INTERVAL '10 minutes' WHERE order_no = $1",
          [orderNo]
        );

        await request(app).post('/admin/run-recovery-cycle');

        const check = await request(app).get(`/orders/${orderNo}`);
        expect(check.body.data.status).toBe(OrderStatus.DELAYED);
        expect(check.body.data.sla_breached).toBe(true);
      });
    });
  });
});
