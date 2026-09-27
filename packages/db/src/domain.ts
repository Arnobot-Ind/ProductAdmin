/**
 * Domain operations shared by the API and the seed script, so both follow exactly the same rules.
 * Every function expects to run inside a transaction (pass a PoolClient that has BEGUN).
 */
import type { PoolClient } from 'pg';
import { generateIngestKey } from './keys';

export class DomainError extends Error {
  constructor(
    readonly code: 'not_found' | 'conflict' | 'invalid',
    message: string,
  ) {
    super(message);
  }
}

/** Robot ID = product code + running number, zero-padded to at least 2 digits ('saibya02'). */
export function formatRobotId(productCode: string, runningNumber: number): string {
  return `${productCode}${String(runningNumber).padStart(2, '0')}`;
}

export interface RegisterRobotInput {
  productId: string;
  serialNumber: string;
  hardwareRevisionId?: string | null;
  notes?: string | null;
  /** v1: always Arnobot (default when omitted). */
  companyId?: string | null;
  createdBy: string | null;
}

export interface RegisterRobotResult {
  robotId: string;
  ingestClientId: string;
  ingestKey: string;
}

/**
 * Registers a robot (spec §3 row 1-2): allocates the permanent Robot ID under a row lock on the
 * product, opens the first ownership period, creates the one-per-robot rows (live_state,
 * connectivity, dispatch_warranty) and issues the robot's own ingest key (shown once).
 */
export async function registerRobot(tx: PoolClient, input: RegisterRobotInput): Promise<RegisterRobotResult> {
  const serial = input.serialNumber.trim();
  if (!serial) throw new DomainError('invalid', 'serial_number is required');

  const product = (
    await tx.query<{ id: string; code: string; next_running_number: number }>(
      'SELECT id, code, next_running_number FROM products WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
      [input.productId],
    )
  ).rows[0];
  if (!product) throw new DomainError('not_found', 'product not found');

  if (input.hardwareRevisionId) {
    const rev = await tx.query('SELECT 1 FROM hardware_revisions WHERE id = $1 AND product_id = $2 AND deleted_at IS NULL', [
      input.hardwareRevisionId,
      product.id,
    ]);
    if (!rev.rowCount) throw new DomainError('invalid', 'hardware revision does not belong to this product');
  }

  // Skip any running number already used (e.g. robots imported with explicit IDs). IDs are never reused.
  let running = product.next_running_number;
  for (;;) {
    const taken = await tx.query('SELECT 1 FROM robots WHERE robot_id = $1 OR (product_id = $2 AND running_number = $3)', [
      formatRobotId(product.code, running),
      product.id,
      running,
    ]);
    if (!taken.rowCount) break;
    running++;
  }
  const robotId = formatRobotId(product.code, running);

  const dup = await tx.query('SELECT robot_id FROM robots WHERE upper(serial_number) = upper($1)', [serial]);
  if (dup.rowCount) throw new DomainError('conflict', `serial number ${serial} is already registered to ${dup.rows[0].robot_id}`);

  await tx.query(
    `INSERT INTO robots (robot_id, serial_number, product_id, hardware_revision_id, running_number, notes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [robotId, serial, product.id, input.hardwareRevisionId ?? null, running, input.notes ?? null, input.createdBy],
  );
  await tx.query('UPDATE products SET next_running_number = $2 WHERE id = $1', [product.id, running + 1]);

  const companyId =
    input.companyId ??
    (await tx.query<{ id: string }>("SELECT id FROM companies WHERE lower(name) = 'arnobot' AND deleted_at IS NULL")).rows[0]?.id;
  if (!companyId) throw new DomainError('invalid', 'no owner company (seed the Arnobot company first)');
  await tx.query(
    `INSERT INTO company_assignment_history (robot_id, company_id, valid_from, reason, created_by)
     VALUES ($1, $2, now(), 'Registered', $3)`,
    [robotId, companyId, input.createdBy],
  );

  await tx.query('INSERT INTO live_state (robot_id) VALUES ($1)', [robotId]);
  await tx.query('INSERT INTO connectivity (robot_id, updated_by) VALUES ($1, $2)', [robotId, input.createdBy]);
  await tx.query('INSERT INTO dispatch_warranty (robot_id, updated_by) VALUES ($1, $2)', [robotId, input.createdBy]);

  const { clientId, key } = await createIngestClient(tx, {
    name: `${robotId} (robot)`,
    kind: 'robot',
    robotIds: [robotId],
    createdBy: input.createdBy,
  });
  return { robotId, ingestClientId: clientId, ingestKey: key };
}

export interface CreateIngestClientInput {
  name: string;
  kind: 'robot' | 'gcs';
  robotIds: string[];
  notes?: string | null;
  createdBy: string | null;
}

/** Creates an ingest client (robot or GCS) + its first key. Returns the plaintext key ONCE. */
export async function createIngestClient(tx: PoolClient, input: CreateIngestClientInput): Promise<{ clientId: string; key: string; prefix: string }> {
  if (input.kind === 'robot' && input.robotIds.length !== 1) {
    throw new DomainError('invalid', 'a robot ingest client speaks for exactly one robot');
  }
  const clientId = (
    await tx.query<{ id: string }>('INSERT INTO ingest_clients (name, kind, notes, created_by) VALUES ($1, $2, $3, $4) RETURNING id', [
      input.name,
      input.kind,
      input.notes ?? null,
      input.createdBy,
    ])
  ).rows[0].id;
  for (const robotId of input.robotIds) {
    await tx.query('INSERT INTO ingest_client_robots (client_id, robot_id, created_by) VALUES ($1, $2, $3)', [clientId, robotId, input.createdBy]);
  }
  const { key, prefix } = await addIngestKey(tx, clientId, input.createdBy);
  return { clientId, key, prefix };
}

export async function addIngestKey(tx: PoolClient, clientId: string, createdBy: string | null): Promise<{ key: string; prefix: string; id: string }> {
  const { key, prefix, hash } = generateIngestKey();
  const id = (
    await tx.query<{ id: string }>('INSERT INTO ingest_keys (client_id, key_prefix, key_hash, created_by) VALUES ($1, $2, $3, $4) RETURNING id', [
      clientId,
      prefix,
      hash,
      createdBy,
    ])
  ).rows[0].id;
  return { key, prefix, id };
}
