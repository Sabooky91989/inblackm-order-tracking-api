import fs from 'fs';
import path from 'path';
import { query } from '../config/database';
import { logger } from '../utils/logger';

export async function runMigrations(): Promise<void> {
  const schemaPath = path.resolve(__dirname, 'schema.sql');
  const fallbackPath = path.resolve(__dirname, '../../src/database/schema.sql');

  let sql: string;
  if (fs.existsSync(schemaPath)) {
    sql = fs.readFileSync(schemaPath, 'utf8');
  } else if (fs.existsSync(fallbackPath)) {
    sql = fs.readFileSync(fallbackPath, 'utf8');
  } else {
    throw new Error(`Schema file not found at ${schemaPath} or ${fallbackPath}`);
  }

  logger.info('Executing database schema migrations...');
  await query(sql);
  logger.info('Database schema migrations completed successfully.');
}

if (require.main === module) {
  runMigrations()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error('Migration failed', { error: err.message });
      process.exit(1);
    });
}
