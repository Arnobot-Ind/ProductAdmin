/**
 * Creates the application role + database on a LOCAL PostgreSQL using a superuser connection
 * (PG_ADMIN_URL). Idempotent. The app itself connects with the least-privileged DATABASE_URL role.
 */
import { Client } from 'pg';

function ident(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Unsafe identifier "${name}"`);
  return `"${name}"`;
}

async function main(): Promise<void> {
  const adminUrl = process.env.PG_ADMIN_URL;
  const appUrl = process.env.DATABASE_URL;
  if (!adminUrl || adminUrl.includes('<postgres-password>')) {
    throw new Error('Set PG_ADMIN_URL in .env to a superuser connection, e.g. postgres://postgres:<password>@localhost:5432/postgres');
  }
  if (!appUrl) throw new Error('DATABASE_URL is not set');
  const app = new URL(appUrl);
  const role = decodeURIComponent(app.username);
  const password = decodeURIComponent(app.password);
  const database = app.pathname.replace(/^\//, '');

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    const roleExists = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
    // Passwords cannot be bound as parameters in CREATE ROLE; quote safely as a literal.
    const pwLiteral = `'${password.replace(/'/g, "''")}'`;
    if (roleExists.rowCount) {
      await admin.query(`ALTER ROLE ${ident(role)} WITH LOGIN PASSWORD ${pwLiteral}`);
      console.log(`✓ role ${role} exists (password synced with DATABASE_URL)`);
    } else {
      await admin.query(`CREATE ROLE ${ident(role)} WITH LOGIN PASSWORD ${pwLiteral}`);
      console.log(`✓ created role ${role}`);
    }
    const dbExists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    if (dbExists.rowCount) {
      console.log(`✓ database ${database} exists`);
    } else {
      await admin.query(`CREATE DATABASE ${ident(database)} OWNER ${ident(role)} ENCODING 'UTF8' TEMPLATE template0`);
      console.log(`✓ created database ${database}`);
    }
  } finally {
    await admin.end();
  }

  // Extensions as superuser inside the new DB (timescaledb is not a "trusted" extension).
  const adminInDb = new URL(adminUrl);
  adminInDb.pathname = `/${database}`;
  const c = new Client({ connectionString: adminInDb.toString() });
  await c.connect();
  try {
    for (const ext of ['pgcrypto', 'citext', 'btree_gist']) await c.query(`CREATE EXTENSION IF NOT EXISTS ${ext}`);
    const ts = await c.query("SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb'");
    if (ts.rowCount) {
      try {
        await c.query('CREATE EXTENSION IF NOT EXISTS timescaledb');
        console.log('✓ timescaledb extension enabled');
      } catch (e) {
        console.log(`! timescaledb available but not loadable: ${(e as Error).message}`);
      }
    } else {
      console.log('i timescaledb not installed: telemetry uses plain PostgreSQL tables (fully supported)');
    }
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(`✗ ${(e as Error).message}`);
  process.exit(1);
});
