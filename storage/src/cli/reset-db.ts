/**
 * DEVELOPMENT ONLY: drops and recreates the local database. Refuses unless the DB host is local and
 * `--confirm` is passed. Never run against shared/production data (rule 10: nothing is deleted).
 */
import { Client } from 'pg';

async function main(): Promise<void> {
  if (!process.argv.includes('--confirm')) throw new Error('refusing to reset without --confirm');
  const app = new URL(process.env.DATABASE_URL ?? '');
  if (!['localhost', '127.0.0.1', '::1'].includes(app.hostname)) throw new Error(`refusing to reset non-local database host ${app.hostname}`);
  if (process.env.NODE_ENV === 'production') throw new Error('refusing to reset in production');
  const adminUrl = process.env.PG_ADMIN_URL;
  if (!adminUrl) throw new Error('PG_ADMIN_URL is not set');
  const database = app.pathname.replace(/^\//, '');
  if (!/^[a-z_][a-z0-9_]*$/.test(database)) throw new Error('unsafe database name');
  const c = new Client({ connectionString: adminUrl });
  await c.connect();
  try {
    await c.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    console.log(`✓ dropped ${database}; recreating it (db:create, db:migrate, db:seed)`);
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(`✗ ${(e as Error).message}`);
  process.exit(1);
});
