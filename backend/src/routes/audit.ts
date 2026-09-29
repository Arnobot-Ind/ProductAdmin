import type { AuditEntryDto, Paginated } from '../shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context';
import { platform, route } from '../lib/route';
import { iso, paginate, Where } from '../lib/sql';
import { isoDateTime, pageQuery, robotIdSchema, uuidSchema } from '../lib/validation';

const AUDIT_SELECT = `
SELECT a.id::text, a.at, a.actor_id, a.actor_email, u.name AS actor_name, a.action, a.outcome, a.target_type, a.target_id,
       a.robot_id, a.company_id, c.name AS company_name, a.detail, a.ip
FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id LEFT JOIN companies c ON c.id = a.company_id`;
const toEntry = (r: Record<string, unknown>): AuditEntryDto => ({ ...(r as unknown as AuditEntryDto), at: iso(r.at as Date)! });

const filterQuery = {
  /** Exact action (data.downloaded) or a group (data.). */
  action: z.string().regex(/^[a-z_]+\.([a-z_]+)?$/).optional(),
  outcome: z.enum(['success', 'denied', 'failure']).optional(),
  actor_id: uuidSchema.optional(),
  robot: robotIdSchema.optional(),
  company_id: uuidSchema.optional(),
  /** Free text over actor email / name, target id and detail. */
  q: z.string().trim().max(100).optional(),
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
};

function buildWhere(q: { action?: string; outcome?: string; actor_id?: string; robot?: string; company_id?: string; q?: string; from?: string; to?: string }): Where {
  const w = new Where();
  if (q.action?.endsWith('.')) w.add('a.action LIKE ?', `${q.action}%`);
  else if (q.action) w.add('a.action = ?', q.action);
  if (q.outcome) w.add('a.outcome = ?', q.outcome);
  if (q.actor_id) w.add('a.actor_id = ?', q.actor_id);
  if (q.robot) w.add('a.robot_id = ?', q.robot);
  if (q.company_id) w.add('a.company_id = ?', q.company_id);
  if (q.from) w.add('a.at >= ?', q.from);
  if (q.to) w.add('a.at < ?', q.to);
  if (q.q) {
    const like = `%${q.q}%`;
    w.add('(a.actor_email ILIKE ? OR u.name ILIKE ? OR a.target_id ILIKE ? OR a.detail::text ILIKE ?)', like, like, like, like);
  }
  return w;
}

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  // Quote everything; neutralise spreadsheet formulas (CSV injection).
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

/** The audit log (append-only; migration 0015). Arnobot admins only. */
export function auditRoutes(f: FastifyInstance, app: AppContext): void {
  const { db } = app;
  const tag = 'Audit';
  const read = { can: 'audit.read', target: platform() };

  route(f, app, {
    method: 'GET',
    path: '/audit',
    summary: 'Audit log, newest first: sign-ins, data access and downloads, robot assignments, permission changes',
    tag,
    access: read,
    query: z.object({ ...filterQuery, ...pageQuery }),
    handler: ({ query }): Promise<Paginated<AuditEntryDto>> =>
      paginate(db, AUDIT_SELECT, buildWhere(query), 'a.at DESC, a.id DESC', query.page, query.limit, toEntry) as Promise<Paginated<AuditEntryDto>>,
  });

  route(f, app, {
    method: 'GET',
    path: '/audit/export.csv',
    summary: 'The filtered audit log as CSV (at most 50 000 rows)',
    tag,
    access: read,
    query: z.object(filterQuery),
    handler: async ({ query, reply }) => {
      const w = buildWhere(query);
      const rows = (await db.query(`${AUDIT_SELECT} ${w.toSql()} ORDER BY a.at DESC, a.id DESC LIMIT 50000`, w.params)).rows.map(toEntry);
      const cols: (keyof AuditEntryDto)[] = ['at', 'action', 'outcome', 'actor_email', 'actor_name', 'target_type', 'target_id', 'robot_id', 'company_name', 'ip', 'detail'];
      const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n');
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      return reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="audit-log-${stamp}.csv"`).send(`﻿${csv}\r\n`);
    },
  });
}
