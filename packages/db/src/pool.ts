import { Pool, types, type PoolClient, type PoolConfig, type QueryResultRow } from 'pg';

// int8 (count(), bigint) → number. Counts and byte sizes stay far below 2^53.
types.setTypeParser(20, (v) => Number(v));
// numeric → number (avg(), sums)
types.setTypeParser(1700, (v) => Number(v));
// date → 'YYYY-MM-DD' string; never shift calendar dates through a JS Date/timezone.
types.setTypeParser(1082, (v) => v);

export type Db = Pool;
export type DbClient = PoolClient;
/** Anything that can run a query: the pool or a transaction client. */
export type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

export function createPool(connectionString = process.env.DATABASE_URL, extra: PoolConfig = {}): Pool {
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  const pool = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    application_name: extra.application_name ?? 'arnobot-pms',
    // All timestamps are handled in UTC (CLAUDE.md conventions); set at connection start-up.
    options: '-c TimeZone=UTC',
    ...extra,
  });
  return pool;
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

export async function queryRows<T extends QueryResultRow>(db: Queryable, sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await db.query<T>(sql, params);
  return res.rows;
}

export async function queryOne<T extends QueryResultRow>(db: Queryable, sql: string, params: unknown[] = []): Promise<T | null> {
  const res = await db.query<T>(sql, params);
  return res.rows[0] ?? null;
}

/** Postgres error codes the API maps to HTTP responses. */
export const PgErrorCode = {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  checkViolation: '23514',
  notNullViolation: '23502',
  exclusionViolation: '23P01',
  restrictViolation: '23001',
  invalidTextRepresentation: '22P02',
} as const;

export function isPgError(err: unknown): err is { code: string; constraint?: string; detail?: string; message: string } {
  return typeof err === 'object' && err !== null && 'code' in err && typeof (err as { code: unknown }).code === 'string';
}
