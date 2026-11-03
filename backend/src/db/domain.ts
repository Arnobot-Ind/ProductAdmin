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

/**
 * A robot's serial number for people: 1005000000216 → "1-005-000-0002-16" (category · base model · main attachment ·
 * running number · random). Anything that is not a 13-digit serial is returned as it is.
 */
export function formatSerial(serial: string): string {
  const m = /^([12])([0-9]{3})([0-9]{3})([0-9]{4})([0-9]{2})$/.exec(serial);
  return m ? m.slice(1).join('-') : serial;
}

export interface RegisterRobotInput {
  productId: string;
  hardwareRevisionId?: string | null;
  /** The attachment the robot is built with: its number is part of the serial (000 when none). */
  mainAttachmentId?: string | null;
  notes?: string | null;
  /** First owner; Arnobot (the internal organization) when omitted. */
  companyId?: string | null;
  createdBy: string | null;
}

export interface RegisterRobotResult {
  /** The robot's identity: its 13-digit serial number (robotId and serialNumber are the same, 0028). */
  robotId: string;
  serialNumber: string;
  ingestClientId: string;
  ingestKey: string;
}

/**
 * Registers a robot (spec §3 row 1-2): generates its permanent serial number (0028: category, base model, main
 * attachment, running number of that combination, random) under a row lock on the base model, opens the first
 * ownership period, creates the one-per-robot rows (live_state, connectivity, dispatch_warranty) and issues the
 * robot's own ingest key (shown once).
 */
export async function registerRobot(tx: PoolClient, input: RegisterRobotInput): Promise<RegisterRobotResult> {
  const product = (
    await tx.query<{ id: string; next_running_number: number }>('SELECT id, next_running_number FROM products WHERE id = $1 AND deleted_at IS NULL', [input.productId])
  ).rows[0];
  if (!product) throw new DomainError('not_found', 'base model not found');

  if (input.hardwareRevisionId) {
    const rev = await tx.query('SELECT 1 FROM hardware_revisions WHERE id = $1 AND product_id = $2 AND deleted_at IS NULL', [
      input.hardwareRevisionId,
      product.id,
    ]);
    if (!rev.rowCount) throw new DomainError('invalid', 'hardware revision does not belong to this base model');
  }
  if (input.mainAttachmentId && !(await tx.query('SELECT 1 FROM attachments WHERE id = $1 AND deleted_at IS NULL', [input.mainAttachmentId])).rowCount) {
    throw new DomainError('not_found', 'attachment not found');
  }

  // The database generates the serial (pms_new_robot_serial, 0028) and locks the base model while doing so.
  const robotId = (await tx.query<{ s: string }>('SELECT pms_new_robot_serial($1, $2) AS s', [product.id, input.mainAttachmentId ?? null])).rows[0].s;
  const running = (await tx.query<{ n: number }>('SELECT next_running_number AS n FROM products WHERE id = $1', [product.id])).rows[0].n;
  await tx.query(
    `INSERT INTO robots (robot_id, serial_number, product_id, hardware_revision_id, running_number, main_attachment_id, notes, created_by)
     VALUES ($1, $1, $2, $3, $4, $5, $6, $7)`,
    [robotId, product.id, input.hardwareRevisionId ?? null, running, input.mainAttachmentId ?? null, input.notes ?? null, input.createdBy],
  );
  await tx.query('UPDATE products SET next_running_number = $2 WHERE id = $1', [product.id, running + 1]);
  const serialNumber = robotId;

  const companyId =
    input.companyId ??
    // Arnobot is the internal organization (named e.g. "Arnobot Private Limited"); prefer one named exactly "Arnobot".
    (
      await tx.query<{ id: string }>(
        "SELECT id FROM companies WHERE kind = 'internal' AND deleted_at IS NULL ORDER BY (lower(name) = 'arnobot') DESC, created_at LIMIT 1",
      )
    ).rows[0]?.id;
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
    name: `${formatSerial(robotId)} (robot)`,
    kind: 'robot',
    robotIds: [robotId],
    createdBy: input.createdBy,
  });
  return { robotId, serialNumber, ingestClientId: clientId, ingestKey: key };
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
