import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_NAME || 'order_tracking_db',
    connectionString: process.env.DATABASE_URL,
    max: parseInt(process.env.DB_POOL_MAX || '20', 10),
  },

  bot: {
    leaseDurationSeconds: parseInt(process.env.BOT_LEASE_DURATION_SECONDS || '30', 10),
    heartbeatIntervalSeconds: parseInt(process.env.BOT_HEARTBEAT_INTERVAL_SECONDS || '10', 10),
    maxRetries: parseInt(process.env.BOT_MAX_RETRIES || '3', 10),
  },

  scheduler: {
    paymentExpiryMinutes: parseInt(process.env.PAYMENT_EXPIRY_MINUTES || '15', 10),
    slaQueueTimeoutSeconds: parseInt(process.env.SLA_QUEUE_TIMEOUT_SECONDS || '120', 10),
    recoveryWorkerIntervalSeconds: parseInt(process.env.RECOVERY_WORKER_INTERVAL_SECONDS || '5', 10),
  },

  webhook: {
    secret: process.env.WEBHOOK_SECRET || 'inblackm_bank_webhook_secret_key_2026',
  },
};
