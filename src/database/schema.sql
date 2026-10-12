-- Enable UUID extension if available
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Table: orders
CREATE TABLE IF NOT EXISTS orders (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  order_no VARCHAR(50) UNIQUE NOT NULL,
  customer_id VARCHAR(100) NOT NULL,
  game_id VARCHAR(100) NOT NULL,
  package_id VARCHAR(100) NOT NULL,
  player_uid VARCHAR(100) NOT NULL,
  amount NUMERIC(10, 2) NOT NULL,
  currency VARCHAR(10) DEFAULT 'THB',
  status VARCHAR(30) NOT NULL DEFAULT 'PENDING_PAYMENT',
  retry_count INT NOT NULL DEFAULT 0,
  max_retries INT NOT NULL DEFAULT 3,
  locked_by VARCHAR(100) NULL,
  locked_until TIMESTAMP WITH TIME ZONE NULL,
  last_heartbeat_at TIMESTAMP WITH TIME ZONE NULL,
  sla_breached BOOLEAN NOT NULL DEFAULT FALSE,
  idempotency_key VARCHAR(255) NULL,
  failure_reason TEXT NULL,
  failure_type VARCHAR(30) NULL,
  version INT NOT NULL DEFAULT 1,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Table: order_timeline
CREATE TABLE IF NOT EXISTS order_timeline (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  order_no VARCHAR(50) NOT NULL REFERENCES orders(order_no) ON DELETE CASCADE,
  from_status VARCHAR(30) NULL,
  to_status VARCHAR(30) NOT NULL,
  actor VARCHAR(50) NOT NULL,
  action VARCHAR(100) NOT NULL,
  reason TEXT NULL,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Table: order_issues
CREATE TABLE IF NOT EXISTS order_issues (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  order_no VARCHAR(50) NOT NULL REFERENCES orders(order_no) ON DELETE CASCADE,
  customer_id VARCHAR(100) NOT NULL,
  issue_type VARCHAR(50) NOT NULL,
  description TEXT NOT NULL,
  status VARCHAR(30) DEFAULT 'OPEN',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Table: idempotency_records
CREATE TABLE IF NOT EXISTS idempotency_records (
  key VARCHAR(255) PRIMARY KEY,
  request_path VARCHAR(255) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  response_status INT NOT NULL,
  response_body JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL
);

-- Table: webhook_events
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id VARCHAR(255) PRIMARY KEY,
  provider VARCHAR(50) NOT NULL,
  order_no VARCHAR(50) NOT NULL,
  status VARCHAR(50) NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Table: system_alerts
CREATE TABLE IF NOT EXISTS system_alerts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  order_no VARCHAR(50) NOT NULL,
  alert_type VARCHAR(50) NOT NULL,
  message TEXT NOT NULL,
  resolved BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Indexes for high performance and fast lookups
CREATE INDEX IF NOT EXISTS idx_orders_order_no ON orders(order_no);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_claim ON orders(status, locked_until) WHERE status = 'QUEUED';
CREATE INDEX IF NOT EXISTS idx_orders_active_lease ON orders(status, locked_until) WHERE status = 'IN_PROGRESS';
CREATE INDEX IF NOT EXISTS idx_orders_payment_expiry ON orders(status, expires_at) WHERE status = 'PENDING_PAYMENT';
CREATE INDEX IF NOT EXISTS idx_timeline_order_no ON order_timeline(order_no, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_issues_order_no ON order_issues(order_no);
CREATE INDEX IF NOT EXISTS idx_alerts_order_no ON system_alerts(order_no);
