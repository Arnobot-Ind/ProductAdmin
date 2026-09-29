import { Pool, type PoolClient, type PoolConfig } from 'pg';

export function createPool(connectionString = process.env.DATABASE_URL, extra: PoolConfig = {}): Pool {
  if (!connectionString) throw new Error('DATABASE_URL is not set (see .env.example)');
  return new Pool({ connectionString, max: 2, application_name: 'pms-storage', options: '-c TimeZone=UTC', ...extra });
}

/** Runs fn inside BEGIN/COMMIT; rolls back on any error. */
export async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
