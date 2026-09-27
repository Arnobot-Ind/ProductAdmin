/** Converts telemetry tables to TimescaleDB hypertables once the extension is installed. Idempotent. */
import { Client } from 'pg';

async function main(): Promise<void> {
  // Needs a superuser to CREATE EXTENSION timescaledb; falls back to the app role.
  const appUrl = new URL(process.env.DATABASE_URL ?? '');
  let url = process.env.DATABASE_URL!;
  if (process.env.PG_ADMIN_URL && !process.env.PG_ADMIN_URL.includes('<postgres-password>')) {
    const admin = new URL(process.env.PG_ADMIN_URL);
    admin.pathname = appUrl.pathname;
    url = admin.toString();
  }
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    const r = await c.query<{ msg: string }>('SELECT pms_enable_timescale() AS msg');
    console.log(r.rows[0].msg);
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(`✗ ${(e as Error).message}`);
  process.exit(1);
});
