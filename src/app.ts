import express from 'express';
import cors from 'cors';
import path from 'path';
import { requestLogger } from './middlewares/requestLogger';
import { errorHandler } from './middlewares/errorHandler';
import { idempotencyMiddleware } from './middlewares/idempotency';
import { validateOrderNoParam } from './middlewares/validateOrderNo';
import { OrderController } from './modules/orders/order.controller';
import { BotController } from './modules/bot/bot.controller';
import { WebhookController } from './modules/webhook/webhook.controller';
import { RecoveryWorker } from './modules/scheduler/recoveryWorker';
import { query } from './config/database';

export const app = express();

// Global Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(requestLogger);

// Serve static frontend files (Interactive Dashboard)
app.use(express.static(path.resolve(__dirname, '../public')));
app.use(express.static(path.resolve(__dirname, './public')));

// Health Check
app.get('/health', async (req, res) => {
  try {
    const dbRes = await query('SELECT 1 as healthy');
    res.status(200).json({
      status: 'UP',
      database: dbRes.rows[0]?.healthy === 1 ? 'CONNECTED' : 'DISCONNECTED',
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    res.status(503).json({
      status: 'DOWN',
      database: 'DISCONNECTED',
      error: err.message,
    });
  }
});

// ==========================================
// Orders Endpoints
// ==========================================
app.post('/orders', idempotencyMiddleware(), OrderController.createOrder);
app.get('/orders', OrderController.listOrders);
app.get('/orders/:orderNo', validateOrderNoParam, OrderController.getOrderByNo);
app.get('/orders/:orderNo/timeline', validateOrderNoParam, OrderController.getOrderTimeline);
app.post('/orders/:orderNo/report-issue', validateOrderNoParam, OrderController.reportIssue);

// Self-healing & Customer Action Endpoints
app.post('/orders/:orderNo/pay', validateOrderNoParam, OrderController.payOrder);
app.post('/orders/:orderNo/retry-uid', validateOrderNoParam, OrderController.retryUid);
app.post('/orders/:orderNo/refund', validateOrderNoParam, OrderController.refundOrder);

// ==========================================
// Bot Worker Endpoints (Problem Cases 1, 2, 4)
// ==========================================
app.post('/bot/claim', BotController.claimOrder);
app.post('/bot/orders/:orderNo/heartbeat', validateOrderNoParam, BotController.heartbeat);
app.post('/bot/orders/:orderNo/complete', validateOrderNoParam, BotController.complete);
app.post('/bot/orders/:orderNo/fail', validateOrderNoParam, BotController.fail);

// ==========================================
// Bank Webhook Endpoint (Problem Case 3)
// ==========================================
app.post('/webhooks/bank-payment', WebhookController.handleBankPayment);

// ==========================================
// Demo / Simulator & Admin Helper Endpoints
// ==========================================
app.post('/admin/run-recovery-cycle', async (req, res) => {
  const result = await RecoveryWorker.runRecoveryCycle();
  res.json({ success: true, data: result });
});

app.get('/admin/alerts', async (req, res) => {
  const alerts = await query('SELECT * FROM system_alerts ORDER BY created_at DESC LIMIT 50');
  res.json({ success: true, data: alerts.rows });
});

// Universal Error Handler
app.use(errorHandler);
