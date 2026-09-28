/**
 * Numbered SQL migration runner (CLAUDE.md rule 14).
 *  - files: migrations/NNNN_name.sql, applied in order, each in its own transaction;
 *  - the SHA-256 of every applied file is recorded; if an applied file is later edited,
 *    `up` refuses to run. Never edit an applied migration: add a new one.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Pool } from 'pg';

export const MIGRATIONS_DIR = resolve(__dirname, '..', 'migrations');
const FILE_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const LOCK_KEY = 7_241_990_001; // pg_advisory_lock key for "pms migrations"

export interface MigrationFile {
  version: number;
  name: string;
  file: string;
  sql: string;
  checksum: string;
}

export interface MigrationStatus extends MigrationFile {
  applied_at: Date | null;
  state: 'applied' | 'pending' | 'modified';
}

export function loadMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const seen = new Set<number>();
  return files.map((file) => {
    const m = FILE_RE.exec(file);
    if (!m) throw new Error(`Bad migration filename "${file}" (expected NNNN_snake_name.sql)`);
    const version = Number(m[1]);
    if (seen.has(version)) throw new Error(`Duplicate migration number ${m[1]}`);
    seen.add(version);
    // Normalise line endings so a Windows checkout does not look "modified".
    const sql = readFileSync(join(dir, file), 'utf8').replace(/\r\n/g, '\n');
    return { version, name: m[2], file, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  });
}

async function ensureTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     integer PRIMARY KEY,
      name        text NOT NULL,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )`);
}

export async function migrationStatus(pool: Pool, dir = MIGRATIONS_DIR): Promise<MigrationStatus[]> {
  await ensureTable(pool);
  const applied = new Map(
    (await pool.query<{ version: number; checksum: string; applied_at: Date }>('SELECT version, checksum, applied_at FROM schema_migrations')).rows.map(
      (r) => [r.version, r],
    ),
  );
  return loadMigrations(dir).map((m) => {
    const a = applied.get(m.version);
    return {
      ...m,
      applied_at: a?.applied_at ?? null,
      state: !a ? 'pending' : a.checksum === m.checksum ? 'applied' : 'modified',
    };
  });
}

export async function migrateUp(pool: Pool, log: (msg: string) => void = console.log, dir = MIGRATIONS_DIR): Promise<number> {
  await ensureTable(pool);
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    const status = await migrationStatus(pool, dir);
    const modified = status.filter((s) => s.state === 'modified');
    if (modified.length) {
      throw new Error(
        `Applied migration(s) were edited: ${modified.map((m) => m.file).join(', ')}. ` +
          'Revert the edit and add a new numbered migration instead (rule 14).',
      );
    }
    let count = 0;
    for (const m of status.filter((s) => s.state === 'pending')) {
      log(`→ applying ${m.file}`);
      client.on('notice', (n) => log(`   notice: ${n.message}`));
      try {
        await client.query('BEGIN');
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [m.version, m.name, m.checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(`Migration ${m.file} failed: ${(err as Error).message}`);
      } finally {
        client.removeAllListeners('notice');
      }
      count++;
    }
    log(count ? `✓ applied ${count} migration(s)` : '✓ database is up to date');
    return count;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}
