import type { Db, Queryable } from '../db';
import type { Where } from '../lib/sql';
import type { AuthUser } from './auth.service';

/**
 * Spec §12: every request goes through ONE check — can(user, action, target).
 *   User → Role → Permission → Scope (platform | company | site | robot).
 * A grant matches when its role holds the permission AND its scope covers the target:
 *   platform        covers everything
 *   company:X       covers company X and robots whose CURRENT owner is X
 *   site:Y          covers robots currently placed at site Y (future; already data-ready)
 *   robot:R         covers robot R only
 */
export type Target =
  | { type: 'platform' }
  | { type: 'any' } // "holds this permission in some scope" — list routes, which then filter with robotScope()
  | { type: 'robot'; id: string }
  | { type: 'company'; id: string };

export type RobotScope = { all: true } | { all: false; robotIds: string[]; companyIds: string[]; siteIds: string[] };

export class PermissionsService {
  constructor(private readonly db: Db) {}

  async can(user: AuthUser, action: string, target: Target, db: Queryable = this.db): Promise<boolean> {
    const grants = user.grants.filter((g) => g.permissions.has(action));
    if (!grants.length) return false;
    if (grants.some((g) => g.scopeType === 'platform')) return true;

    switch (target.type) {
      case 'platform':
        return false;
      case 'any':
        return true;
      case 'company':
        return grants.some((g) => g.scopeType === 'company' && g.scopeId === target.id);
      case 'robot': {
        if (grants.some((g) => g.scopeType === 'robot' && g.scopeId === target.id)) return true;
        const companyIds = grants.filter((g) => g.scopeType === 'company').map((g) => g.scopeId!);
        const siteIds = grants.filter((g) => g.scopeType === 'site').map((g) => g.scopeId!);
        if (!companyIds.length && !siteIds.length) return false;
        const res = await db.query(
          `SELECT 1 WHERE
             EXISTS (SELECT 1 FROM company_assignment_history
                     WHERE robot_id = $1 AND valid_to IS NULL AND company_id::text = ANY($2::text[]))
          OR EXISTS (SELECT 1 FROM site_assignment_history
                     WHERE robot_id = $1 AND valid_to IS NULL AND site_id::text = ANY($3::text[]))`,
          [target.id, companyIds, siteIds],
        );
        return (res.rowCount ?? 0) > 0;
      }
    }
  }

  /** Which robots a user may see for `action` — used to filter list endpoints. */
  robotScope(user: AuthUser, action: string): RobotScope {
    const grants = user.grants.filter((g) => g.permissions.has(action));
    if (grants.some((g) => g.scopeType === 'platform')) return { all: true };
    const pick = (t: string) => grants.filter((g) => g.scopeType === t).map((g) => g.scopeId!);
    return { all: false, robotIds: pick('robot'), companyIds: pick('company'), siteIds: pick('site') };
  }

  /** Adds the robot-scope condition to a WHERE builder for a column that holds a robot_id. */
  applyRobotScope(where: Where, scope: RobotScope, robotIdColumn: string): Where {
    if (scope.all) return where;
    return where.add(
      `(${robotIdColumn} = ANY(?::text[])
        OR EXISTS (SELECT 1 FROM company_assignment_history sc_h
                   WHERE sc_h.robot_id = ${robotIdColumn} AND sc_h.valid_to IS NULL AND sc_h.company_id::text = ANY(?::text[]))
        OR EXISTS (SELECT 1 FROM site_assignment_history sc_s
                   WHERE sc_s.robot_id = ${robotIdColumn} AND sc_s.valid_to IS NULL AND sc_s.site_id::text = ANY(?::text[])))`,
      scope.robotIds,
      scope.companyIds,
      scope.siteIds,
    );
  }

  /** In-memory filter of robot ids (for realtime fan-out). */
  async canReadRobot(user: AuthUser, robotId: string): Promise<boolean> {
    return this.can(user, 'robot.read', { type: 'robot', id: robotId });
  }
}
