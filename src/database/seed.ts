import { query } from '../config/database';
import { runMigrations } from './migrate';
import { OrderStatus, ActorType } from '../constants/orderStatus';
import { logger } from '../utils/logger';

export async function runSeeds(): Promise<void> {
  await runMigrations();
  logger.info('Seeding demo orders...');

  // Sample orders
  const sampleOrders = [
    {
      orderNo: 'ORD-2587965432159-458',
      customerId: 'CUST-001',
      gameId: 'ROV',
      packageId: 'ROV-POINTS-500',
      playerUid: '984512398',
      amount: 150.0,
      status: OrderStatus.COMPLETED,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    },
    {
      orderNo: 'ORD-2587965432160-101',
      customerId: 'CUST-002',
      gameId: 'GENSHIN',
      packageId: 'GENSHIN-BLESSING',
      playerUid: '800123999',
      amount: 179.0,
      status: OrderStatus.IN_PROGRESS,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    },
    {
      orderNo: 'ORD-2587965432161-202',
      customerId: 'CUST-003',
      gameId: 'VALORANT',
      packageId: 'VAL-VP-1000',
      playerUid: 'RIYA#SEA',
      amount: 300.0,
      status: OrderStatus.QUEUED,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    },
    {
      orderNo: 'ORD-2587965432162-303',
      customerId: 'CUST-004',
      gameId: 'FREEFIRE',
      packageId: 'FF-DIAMOND-100',
      playerUid: 'FF-999988',
      amount: 35.0,
      status: OrderStatus.PENDING_PAYMENT,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    },
    {
      orderNo: 'ORD-2587965432163-404',
      customerId: 'CUST-005',
      gameId: 'ROV',
      packageId: 'ROV-PASS-MONTHLY',
      playerUid: 'INVALID_UID_77',
      amount: 99.0,
      status: OrderStatus.FAILED,
      failureReason: 'Player UID not found on provider server (Code: 404_NOT_FOUND)',
      failureType: 'PERMANENT',
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    },
  ];

  for (const o of sampleOrders) {
    const existing = await query('SELECT order_no FROM orders WHERE order_no = $1', [o.orderNo]);
    if (existing.rows.length === 0) {
      await query(
        `INSERT INTO orders (order_no, customer_id, game_id, package_id, player_uid, amount, status, failure_reason, failure_type, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [o.orderNo, o.customerId, o.gameId, o.packageId, o.playerUid, o.amount, o.status, o.failureReason || null, o.failureType || null, o.expiresAt]
      );

      await query(
        `INSERT INTO order_timeline (order_no, from_status, to_status, actor, action, reason)
         VALUES ($1, NULL, $2, $3, $4, $5)`,
        [o.orderNo, o.status, ActorType.SYSTEM, 'SEED_DATA_INITIALIZED', 'Initial seeding record']
      );
    }
  }

  logger.info('Database seeded successfully.');
}

if (require.main === module) {
  runSeeds()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error('Seed failed', { error: err.message });
      process.exit(1);
    });
}
