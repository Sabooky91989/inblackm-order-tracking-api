import { app } from './app';
import { config } from './config/env';
import { pool } from './config/database';
import { runMigrations } from './database/migrate';
import { runSeeds } from './database/seed';
import { RecoveryWorker } from './modules/scheduler/recoveryWorker';
import { logger } from './utils/logger';

async function bootstrap() {
  try {
    logger.info('Initializing Order Tracking API Server...');

    // Automatically apply database schema
    await runMigrations();

    // Check if initial seed is needed
    try {
      const existing = await pool.query('SELECT COUNT(*) as count FROM orders');
      if (parseInt(existing.rows[0].count, 10) === 0) {
        await runSeeds();
      }
    } catch (seedErr: any) {
      logger.warn('Seed check failed, skipping automatic seed', { error: seedErr.message });
    }

    // Start background recovery & SLA monitoring worker
    RecoveryWorker.start();

    const server = app.listen(config.port, () => {
      logger.info(`========================================================`);
      logger.info(` Order Tracking API Server running on port ${config.port}`);
      logger.info(` Environment: ${config.nodeEnv}`);
      logger.info(` Interactive UI: http://localhost:${config.port}`);
      logger.info(` Health check:   http://localhost:${config.port}/health`);
      logger.info(`========================================================`);
    });

    // Graceful Shutdown
    const shutdown = async (signal: string) => {
      logger.info(`Received ${signal}. Shutting down gracefully...`);
      RecoveryWorker.stop();
      server.close(async () => {
        logger.info('HTTP server closed.');
        await pool.end();
        logger.info('PostgreSQL pool drained. Process terminated.');
        process.exit(0);
      });
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (error: any) {
    logger.error('Fatal error during application startup', { error: error.message, stack: error.stack });
    process.exit(1);
  }
}

bootstrap();
