import type { FastifyBaseLogger, FastifyRequest } from 'fastify';
import type { Db, Queryable } from '../db';
import type { AuthUser } from './auth.service';

/**
 * Audit actions (resource.verb). The log answers: who signed in, who opened or downloaded which robot's
 * data, who assigned which robot to which organization, and who changed whose permissions.
 */
export type AuditAction =
  | 'auth.login'
  | 'auth.login_failed'
  | 'auth.logout'
  | 'auth.password_changed'
  | 'auth.invite_accepted'
  | 'access.denied'
  | 'user.created'
  | 'user.invited'
  | 'user.updated'
  | 'user.deleted'
  | 'user.restored'
  | 'grant.added'
  | 'grant.revoked'
  | 'org.created'
  | 'org.updated'
  | 'org.deleted'
  | 'org.restored'
  | 'robot.assigned'
  | 'data.viewed'
  | 'data.downloaded'
  | 'data.deleted'
  | 'data.restored'
  | 'credential.revealed'
  | 'hardware.updated'
  | 'software.recorded';

export interface AuditEntry {
  action: AuditAction;
  outcome?: 'success' | 'denied' | 'failure';
  /** Signed-in user; their organization is recorded when the entry names none. */
  actor?: (Pick<AuthUser, 'id' | 'email'> & Partial<Pick<AuthUser, 'companyId'>>) | null;
  actorEmail?: string | null;
  target?: { type: string; id: string } | null;
  robotId?: string | null;
  companyId?: string | null;
  detail?: Record<string, unknown>;
  req?: FastifyRequest;
}

/**
 * Writes the append-only audit_log (migration 0015; the database refuses UPDATE and DELETE on it).
 * `record` inside a transaction makes the entry part of the change it describes; `note` is fire-and-forget
 * for reads (a failed audit write is logged, never turned into a failed download).
 */
export class AuditService {
  constructor(
    private readonly db: Db,
    private readonly log?: FastifyBaseLogger,
  ) {}

  async record(e: AuditEntry, q: Queryable = this.db): Promise<void> {
    await q.query(
      `INSERT INTO audit_log (actor_id, actor_email, action, outcome, target_type, target_id, robot_id, company_id, detail, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        e.actor?.id ?? null,
        (e.actor?.email ?? e.actorEmail ?? null)?.slice(0, 320) ?? null,
        e.action,
        e.outcome ?? 'success',
        e.target?.type ?? null,
        e.target?.id ?? null,
        e.robotId ?? null,
        e.companyId ?? e.actor?.companyId ?? null,
        JSON.stringify(e.detail ?? {}),
        e.req?.ip ?? null,
        e.req?.headers['user-agent']?.slice(0, 300) ?? null,
      ],
    );
  }

  note(e: AuditEntry): void {
    this.record(e).catch((err) => (this.log ?? e.req?.log)?.error({ err, action: e.action }, 'audit write failed'));
  }
}
