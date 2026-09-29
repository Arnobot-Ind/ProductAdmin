import type { FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import type { AppContext } from '../context';
import { badRequest, conflict, notFound } from '../lib/errors';
import type { AuthUser } from './auth.service';

export interface AssignRobotInput {
  robotId: string;
  companyId: string;
  reason?: string | null;
  /** Default now. May be back-dated, but never before the start of the current period. */
  validFrom?: Date;
  actor: AuthUser;
  req?: FastifyRequest;
}

/**
 * Assigns a robot to an organization ("Robot-01 → Adani"): closes the current ownership period and opens a
 * new one (history kept). Robot-scoped grants that users of the PREVIOUS customer organization held on this
 * robot are revoked in the same transaction, so their access ends with the assignment. Audited.
 */
export async function assignRobot(tx: PoolClient, app: AppContext, input: AssignRobotInput): Promise<{ previousCompanyId: string | null; revokedGrants: number }> {
  const { robotId, companyId, actor } = input;
  const robot = await tx.query('SELECT 1 FROM robots WHERE robot_id = $1 AND deleted_at IS NULL FOR UPDATE', [robotId]);
  if (!robot.rowCount) throw notFound('robot');
  const company = (await tx.query<{ name: string }>('SELECT name FROM companies WHERE id = $1 AND deleted_at IS NULL', [companyId])).rows[0];
  if (!company) throw notFound('organization');

  const current = (
    await tx.query<{ id: string; company_id: string; valid_from: Date; kind: string; name: string }>(
      `SELECT h.id, h.company_id, h.valid_from, c.kind, c.name
       FROM company_assignment_history h JOIN companies c ON c.id = h.company_id
       WHERE h.robot_id = $1 AND h.valid_to IS NULL`,
      [robotId],
    )
  ).rows[0];
  const from = input.validFrom ?? new Date();
  if (current?.company_id === companyId) throw conflict(`robot is already assigned to ${company.name}`);
  if (current && from <= current.valid_from) throw badRequest('valid_from must be after the start of the current ownership period');
  if (current) await tx.query('UPDATE company_assignment_history SET valid_to = $2 WHERE id = $1', [current.id, from]);
  await tx.query('INSERT INTO company_assignment_history (robot_id, company_id, valid_from, reason, created_by) VALUES ($1, $2, $3, $4, $5)', [
    robotId,
    companyId,
    from,
    input.reason ?? null,
    actor.id,
  ]);

  let revoked = 0;
  if (current && current.kind === 'customer') {
    const res = await tx.query<{ id: string; user_id: string }>(
      `UPDATE role_grants g SET revoked_at = now(), revoked_by = $3
       FROM users u
       WHERE g.user_id = u.id AND u.company_id = $2 AND g.scope_type = 'robot' AND g.scope_id = $1 AND g.revoked_at IS NULL
       RETURNING g.id, g.user_id`,
      [robotId, current.company_id, actor.id],
    );
    revoked = res.rowCount ?? 0;
    for (const g of res.rows) {
      await app.audit.record(
        {
          action: 'grant.revoked',
          actor,
          target: { type: 'user', id: g.user_id },
          companyId: current.company_id,
          robotId,
          detail: { grant_id: g.id, scope_type: 'robot', scope_id: robotId, reason: `robot assigned to ${company.name}` },
          req: input.req,
        },
        tx,
      );
    }
  }

  await app.audit.record(
    {
      action: 'robot.assigned',
      actor,
      target: { type: 'robot', id: robotId },
      robotId,
      companyId,
      detail: {
        from_company_id: current?.company_id ?? null,
        from_company: current?.name ?? null,
        to_company: company.name,
        valid_from: from.toISOString(),
        reason: input.reason ?? null,
        revoked_robot_grants: revoked,
      },
      req: input.req,
    },
    tx,
  );
  return { previousCompanyId: current?.company_id ?? null, revokedGrants: revoked };
}
