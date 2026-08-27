import { Pool } from 'pg';

import { config } from '../config.ts';

export const dbPool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 2_000,
});

export async function closeDb(): Promise<void> {
  await dbPool.end();
}
