/**
 * Seeds the first super-admin (from env) and, optionally, demo robots for the simulator.
 * Reference data (company, products, part types, roles, permissions) comes from migration 0011.
 * Idempotent: safe to run repeatedly.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PoolClient } from 'pg';
import { addIngestKey, createIngestClient, registerRobot } from '../domain';
import { hashIngestKey } from '../keys';
import { hashPassword, passwordProblem } from '../passwords';
import { createPool, withTransaction } from '../pool';

const SIM_KEYS_PATH = resolve(__dirname, '..', '..', '..', '..', '.sim-keys.json');

interface SimKeys {
  api_url?: string;
  ingest_url: string;
  robots: Record<string, { product: string; key: string }>;
  gcs?: { client_id: string; key: string };
}

const DEMO_ROBOTS = [
  { product: 'saibya', serial: 'SN-SAI-0001', origin: 'Ahmedabad' },
  { product: 'saibya', serial: 'SN-SAI-0002', origin: 'Ahmedabad' },
  { product: 'altius', serial: 'SN-ALT-0001', origin: 'Gandhinagar' },
];

async function seedAdmin(tx: PoolClient): Promise<string> {
  const email = (process.env.SEED_ADMIN_EMAIL ?? '').trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD ?? '';
  const name = process.env.SEED_ADMIN_NAME ?? 'Arnobot Admin';
  if (!email) throw new Error('SEED_ADMIN_EMAIL is not set');

  const existing = await tx.query<{ id: string }>('SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL', [email]);
  if (existing.rowCount) {
    console.log(`✓ admin ${email} exists`);
    return existing.rows[0].id;
  }
  const problem = passwordProblem(password);
  if (problem) throw new Error(`SEED_ADMIN_PASSWORD: ${problem}`);
  const id = (
    await tx.query<{ id: string }>('INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id', [
      email,
      name,
      await hashPassword(password),
    ])
  ).rows[0].id;
  await tx.query(
    `INSERT INTO role_grants (user_id, role_id, scope_type, scope_id, created_by)
     SELECT $1::uuid, id, 'platform', NULL, $1::uuid FROM roles WHERE key = 'super_admin'`,
    [id],
  );
  console.log(`✓ created super-admin ${email}`);
  return id;
}

async function seedCatalogueDetails(tx: PoolClient, adminId: string): Promise<void> {
  // Saibya Rev A with its main components (spec §4 example).
  const saibya = (await tx.query<{ id: string }>("SELECT id FROM products WHERE code = 'saibya'")).rows[0];
  if (!saibya) return;
  const rev = await tx.query<{ id: string }>(
    "SELECT id FROM hardware_revisions WHERE product_id = $1 AND lower(name) = 'rev a' AND deleted_at IS NULL",
    [saibya.id],
  );
  if (rev.rowCount) return;
  const revId = (
    await tx.query<{ id: string }>(
      `INSERT INTO hardware_revisions (product_id, name, description, created_by)
       VALUES ($1, 'Rev A', 'Jetson Orin controller + u-blox RTK GPS + 2D LiDAR + 4 cameras', $2) RETURNING id`,
      [saibya.id, adminId],
    )
  ).rows[0].id;
  const components: [string, number | null, string][] = [
    ['controller', null, 'NVIDIA Jetson Orin'],
    ['gps', null, 'u-blox ZED-F9P (RTK)'],
    ['imu', null, 'WitMotion HWT905'],
    ['lidar', null, 'RPLIDAR S2'],
    ['encoder', 1, 'Hall encoder'],
    ['encoder', 2, 'Hall encoder'],
    ['camera', 1, 'IP camera'],
    ['camera', 2, 'IP camera'],
    ['camera', 3, 'IP camera'],
    ['camera', 4, 'IP camera'],
  ];
  for (const [key, slot, model] of components) {
    await tx.query(
      `INSERT INTO hardware_revision_components (hardware_revision_id, part_type_id, slot, model, created_by)
       SELECT $1, id, $2, $3, $4 FROM part_types WHERE key = $5`,
      [revId, slot, model, adminId, key],
    );
  }
  console.log('✓ created Saibya Rev A');
}

async function seedDemoRobots(tx: PoolClient, adminId: string): Promise<void> {
  const keys: SimKeys = existsSync(SIM_KEYS_PATH)
    ? (JSON.parse(readFileSync(SIM_KEYS_PATH, 'utf8')) as SimKeys)
    : { ingest_url: '', robots: {} };
  keys.ingest_url = `http://localhost:${process.env.INGEST_PORT ?? 4100}`;
  keys.api_url = `http://localhost:${process.env.API_PORT ?? 4000}`;

  const robotIds: string[] = [];
  for (const demo of DEMO_ROBOTS) {
    const existing = await tx.query<{ robot_id: string }>('SELECT robot_id FROM robots WHERE upper(serial_number) = upper($1)', [demo.serial]);
    let robotId: string;
    if (existing.rowCount) {
      robotId = existing.rows[0].robot_id;
      if (!keys.robots[robotId]) {
        const client = await tx.query<{ id: string }>(
          `SELECT c.id FROM ingest_clients c JOIN ingest_client_robots r ON r.client_id = c.id
           WHERE c.kind = 'robot' AND r.robot_id = $1 AND c.revoked_at IS NULL LIMIT 1`,
          [robotId],
        );
        if (client.rowCount) {
          const { key } = await addIngestKey(tx, client.rows[0].id, adminId);
          keys.robots[robotId] = { product: demo.product, key };
        }
      }
      console.log(`✓ demo robot ${robotId} exists`);
    } else {
      const product = (await tx.query<{ id: string }>('SELECT id FROM products WHERE code = $1', [demo.product])).rows[0];
      const revision =
        demo.product === 'saibya'
          ? (await tx.query<{ id: string }>("SELECT id FROM hardware_revisions WHERE product_id = $1 AND lower(name) = 'rev a'", [product.id])).rows[0]?.id
          : null;
      const reg = await registerRobot(tx, {
        productId: product.id,
        serialNumber: demo.serial,
        hardwareRevisionId: revision ?? null,
        notes: `Demo robot for the simulator (${demo.origin})`,
        createdBy: adminId,
      });
      robotId = reg.robotId;
      keys.robots[robotId] = { product: demo.product, key: reg.ingestKey };
      await seedRobotDetails(tx, robotId, adminId, robotIds.length + 1);
      console.log(`✓ registered demo robot ${robotId} (${demo.serial})`);
    }
    robotIds.push(robotId);
  }

  // A keys file from another database (e.g. after a reset) holds keys this DB does not know: re-issue.
  const keyIsLive = async (key: string | undefined) =>
    !!key &&
    ((await tx.query('SELECT 1 FROM ingest_keys k JOIN ingest_clients c ON c.id = k.client_id WHERE k.key_hash = $1 AND k.revoked_at IS NULL AND c.revoked_at IS NULL', [hashIngestKey(key)])).rowCount ?? 0) > 0;
  for (const robotId of robotIds) {
    if (!(await keyIsLive(keys.robots[robotId]?.key))) {
      const client = await tx.query<{ id: string }>(
        `SELECT c.id FROM ingest_clients c JOIN ingest_client_robots r ON r.client_id = c.id
         WHERE c.kind = 'robot' AND r.robot_id = $1 AND c.revoked_at IS NULL LIMIT 1`,
        [robotId],
      );
      if (client.rowCount) {
        const product = (await tx.query<{ code: string }>('SELECT p.code FROM robots r JOIN products p ON p.id = r.product_id WHERE r.robot_id = $1', [robotId])).rows[0].code;
        keys.robots[robotId] = { product, key: (await addIngestKey(tx, client.rows[0].id, adminId)).key };
        console.log(`✓ re-issued ingest key for ${robotId}`);
      }
    }
  }
  if (!(await keyIsLive(keys.gcs?.key))) {
    const gcs = await createIngestClient(tx, {
      name: 'Simulated GCS',
      kind: 'gcs',
      robotIds,
      notes: 'Used by tools/robot-sim to play the GCS role (mission reports)',
      createdBy: adminId,
    });
    keys.gcs = { client_id: gcs.clientId, key: gcs.key };
    console.log('✓ created simulated GCS ingest client');
  }

  writeFileSync(SIM_KEYS_PATH, JSON.stringify(keys, null, 2) + '\n', { mode: 0o600 });
  console.log(`✓ simulator keys written to ${SIM_KEYS_PATH} (gitignored)`);
}

async function seedRobotDetails(tx: PoolClient, robotId: string, adminId: string, n: number): Promise<void> {
  const fitted = [
    ['controller', null, 'NVIDIA Jetson Orin', `JO-${robotId.toUpperCase()}`],
    ['gps', null, 'u-blox ZED-F9P (RTK)', `GPS-${n}001`],
    ['imu', null, 'WitMotion HWT905', `IMU-${n}001`],
    ['lidar', null, 'RPLIDAR S2', `LDR-${n}001`],
    ['encoder', 1, 'Hall encoder', `ENC-${n}01`],
    ['encoder', 2, 'Hall encoder', `ENC-${n}02`],
    ['camera', 1, 'IP camera', `CAM-${n}01`],
    ['camera', 2, 'IP camera', `CAM-${n}02`],
  ] as const;
  for (const [key, slot, model, serial] of fitted) {
    await tx.query(
      `INSERT INTO hardware_fitted (robot_id, part_type_id, slot, model, serial_number, fitted_at, created_by)
       SELECT $1, id, $2, $3, $4, current_date - 60, $5 FROM part_types WHERE key = $6`,
      [robotId, slot, model, serial, adminId, key],
    );
  }
  await tx.query(
    `UPDATE connectivity SET network_address = $2, ssh_ip = $3, cloudflare_tunnel_hostname = $4, omni_ip = $5,
            wifi_router_ip = $6, gcs_camera_domain = $7, gcs_server_domain = $8, updated_by = $9
     WHERE robot_id = $1`,
    [
      robotId,
      `192.168.${10 + n}.0/24`,
      `192.168.${10 + n}.20`,
      `api-${robotId}.example.invalid`,
      `192.168.${10 + n}.30`,
      `192.168.${10 + n}.1`,
      `https://cam-${robotId}.example.invalid`,
      `https://api-${robotId}.example.invalid`,
      adminId,
    ],
  );
  for (const slot of [1, 2]) {
    await tx.query(
      `INSERT INTO robot_cameras (robot_id, slot, ip, stream_url, model, updated_by) VALUES ($1, $2, $3, $4, 'IP camera', $5)`,
      [robotId, slot, `192.168.${10 + n}.${100 + slot}`, `rtsp://192.168.${10 + n}.${100 + slot}:554/stream1`, adminId],
    );
  }
  await tx.query(
    `UPDATE dispatch_warranty SET dispatch_date = current_date - 45, warranty_start = current_date - 45,
            warranty_end = current_date + $2::int, updated_by = $3 WHERE robot_id = $1`,
    [robotId, n === 3 ? 20 : 320, adminId],
  );
}

async function main(): Promise<void> {
  const pool = createPool(undefined, { application_name: 'pms-seed', max: 2 });
  try {
    await withTransaction(pool, async (tx) => {
      const adminId = await seedAdmin(tx);
      await seedCatalogueDetails(tx, adminId);
      if ((process.env.SEED_DEMO_ROBOTS ?? 'true') === 'true') await seedDemoRobots(tx, adminId);
    });
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(`✗ ${(e as Error).message}`);
  process.exit(1);
});
