import type { Db, Queryable } from '../db';
import { Where } from '../lib/sql';
import type { AuthUser } from './auth.service';

/**
 * Spec §12: every request goes through ONE check — can(user, action, target).
 *   User → Role → Permission → Scope (platform | company | site | robot).
 * A grant matches when its role holds the permission AND its scope covers the target:
 *   platform        covers everything
 *   company:X       covers company X and robots whose CURRENT owner is X
 *   site:Y          covers robots currently placed at site Y (future; already data-ready)
 *   robot:R         covers robot R only
 *
 * Robots vs. their DATA. A company grant covers the robots the company owns NOW and their data, EXCEPT data
 * recorded while ANOTHER customer organization owned the robot (applyDataScope / canSeeData / dataPeriods).
 * So Adani sees Robot-01's factory tests and everything since it was assigned, but when Robot-01 later moves
 * to another customer, that customer never sees Adani's recordings (and Adani loses the robot altogether).
 * Robot and platform grants are explicit and cover the robot's whole history.
 */
export type Target =
  | { type: 'platform' }
  | { type: 'any' } // "holds this permission in some scope" — list routes, which then filter with robotScope()
  | { type: 'robot'; id: string }
  | { type: 'company'; id: string };

/**
 * `customerOrg`: set for customer users. Their robot grants (a Manager picking robots per user, 0021) are NOT the
 * whole-history robot grants Arnobot staff get: the robot must still be owned by the user's organization and its data
 * follows the organization rule (never another customer's period).
 * `since`: customer organizations with a data history limit (client_profiles.data_history_days) or a data start date
 * (client_profiles.data_from, whichever is later) see no robot data
 * recorded before it; null = all history.
 */
export type RobotScope =
  | { all: true }
  | { all: false; robotIds: string[]; companyIds: string[]; siteIds: string[]; customerOrg: string | null; since: Date | null };

/** Start of the data a customer user may see: the later of the data start date (IST day) and the history limit; null = all history. */
export function dataSince(user: AuthUser): Date | null {
  const days = user.client?.dataHistoryDays;
  const from = user.client?.dataFrom;
  const limits = [days ? Date.now() - days * 86_400_000 : null, from ? Date.parse(`${from}T00:00:00+05:30`) : null].filter((t): t is number => t !== null && !Number.isNaN(t));
  return limits.length ? new Date(Math.max(...limits)) : null;
}

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
        if (user.companyKind === 'customer') {
          // Customer users: a robot or organization grant, and the robot is owned by their organization now.
          const viaGrant = grants.some((g) => (g.scopeType === 'robot' && g.scopeId === target.id) || (g.scopeType === 'company' && g.scopeId === user.companyId));
          if (!viaGrant) return false;
          const owned = await db.query('SELECT 1 FROM company_assignment_history WHERE robot_id = $1 AND valid_to IS NULL AND company_id = $2', [target.id, user.companyId]);
          return (owned.rowCount ?? 0) > 0;
        }
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
    if (user.companyKind === 'customer') {
      // Customer users stay inside their own organization, whatever their grants say.
      return { all: false, robotIds: pick('robot'), companyIds: pick('company').filter((c) => c === user.companyId), siteIds: [], customerOrg: user.companyId, since: dataSince(user) };
    }
    return { all: false, robotIds: pick('robot'), companyIds: pick('company'), siteIds: pick('site'), customerOrg: null, since: null };
  }

  /** Adds the robot-scope condition to a WHERE builder for a column that holds a robot_id. */
  applyRobotScope(where: Where, scope: RobotScope, robotIdColumn: string): Where {
    if (scope.all) return where;
    if (scope.customerOrg) {
      return where.add(
        `((${robotIdColumn} = ANY(?::text[]) OR ?::text = ANY(?::text[]))
          AND EXISTS (SELECT 1 FROM company_assignment_history sc_h
                      WHERE sc_h.robot_id = ${robotIdColumn} AND sc_h.valid_to IS NULL AND sc_h.company_id = ?::uuid))`,
        scope.robotIds,
        scope.customerOrg,
        scope.companyIds,
        scope.customerOrg,
      );
    }
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

  /**
   * Adds the data condition for rows of a robot (recordings, missions, events, telemetry); `timeExpr` is when
   * the row was recorded. Company grants: the robot is currently owned by one of the user's organizations AND
   * the row was not recorded while a different CUSTOMER organization owned it. Site grants: the robot is at the
   * site now. Robot grants: the robot's whole history. Customer users: robotScope's robots, organization rule.
   */
  applyDataScope(where: Where, scope: RobotScope, robotIdColumn: string, timeExpr: string): Where {
    if (scope.all) return where;
    if (scope.customerOrg) {
      if (scope.since) where.add(`${timeExpr} >= ?`, scope.since);
      this.applyRobotScope(where, scope, robotIdColumn);
      return where.add(
        `NOT EXISTS (SELECT 1 FROM company_assignment_history ds_o JOIN companies ds_c ON ds_c.id = ds_o.company_id
                     WHERE ds_o.robot_id = ${robotIdColumn} AND ds_c.kind = 'customer' AND ds_o.company_id <> ?::uuid
                       AND ${timeExpr} >= ds_o.valid_from AND (ds_o.valid_to IS NULL OR ${timeExpr} < ds_o.valid_to))`,
        scope.customerOrg,
      );
    }
    return where.add(
      `(${robotIdColumn} = ANY(?::text[])
        OR (EXISTS (SELECT 1 FROM company_assignment_history ds_h
                    WHERE ds_h.robot_id = ${robotIdColumn} AND ds_h.valid_to IS NULL AND ds_h.company_id::text = ANY(?::text[]))
            AND NOT EXISTS (SELECT 1 FROM company_assignment_history ds_o JOIN companies ds_c ON ds_c.id = ds_o.company_id
                            WHERE ds_o.robot_id = ${robotIdColumn} AND ds_c.kind = 'customer' AND ds_o.company_id::text <> ALL(?::text[])
                              AND ${timeExpr} >= ds_o.valid_from AND (ds_o.valid_to IS NULL OR ${timeExpr} < ds_o.valid_to)))
        OR EXISTS (SELECT 1 FROM site_assignment_history ds_s
                   WHERE ds_s.robot_id = ${robotIdColumn} AND ds_s.valid_to IS NULL AND ds_s.site_id::text = ANY(?::text[])))`,
      scope.robotIds,
      scope.companyIds,
      scope.companyIds,
      scope.siteIds,
    );
  }

  /** One data row: may the user see (or, for other actions, act on) data of `robotId` recorded at `at`? */
  async canSeeData(user: AuthUser, action: string, robotId: string, at: Date, db: Queryable = this.db): Promise<boolean> {
    const scope = this.robotScope(user, action);
    if (scope.all) return true;
    const w = this.applyDataScope(new Where([robotId, at]), scope, '$1::text', '$2::timestamptz');
    return ((await db.query(`SELECT 1 ${w.toSql()}`, w.params)).rowCount ?? 0) > 0;
  }

  /**
   * Time spans of `robotId`'s data the user may see, for time-series queries that are easier to clip than to
   * rewrite (telemetry): null = all of it; [] = none; otherwise everything outside other customers' periods
   * (`from` null = since the beginning, `to` null = until now).
   */
  async dataPeriods(user: AuthUser, action: string, robotId: string, db: Queryable = this.db): Promise<{ from: Date | null; to: Date | null }[] | null> {
    const scope = this.robotScope(user, action);
    if (scope.all) return null;
    const spans = await this.ownPeriods(scope, robotId, db);
    if (!scope.since) return spans;
    // Data history limit: nothing before `since`.
    const since = scope.since;
    return (spans ?? [{ from: null, to: null }])
      .filter((s) => s.to === null || s.to > since)
      .map((s) => ({ from: s.from && s.from > since ? s.from : since, to: s.to }));
  }

  private async ownPeriods(scope: Exclude<RobotScope, { all: true }>, robotId: string, db: Queryable): Promise<{ from: Date | null; to: Date | null }[] | null> {
    let own = scope.companyIds;
    if (scope.customerOrg) {
      const w = this.applyRobotScope(new Where([robotId]), scope, '$1::text');
      if (!(await db.query(`SELECT 1 ${w.toSql()}`, w.params)).rowCount) return [];
      own = [scope.customerOrg];
    } else {
      if (scope.robotIds.includes(robotId)) return null;
      const owned = await db.query(
        `SELECT 1 WHERE EXISTS (SELECT 1 FROM company_assignment_history WHERE robot_id = $1 AND valid_to IS NULL AND company_id::text = ANY($2::text[]))
                     OR EXISTS (SELECT 1 FROM site_assignment_history WHERE robot_id = $1 AND valid_to IS NULL AND site_id::text = ANY($3::text[]))`,
        [robotId, scope.companyIds, scope.siteIds],
      );
      if (!owned.rowCount) return [];
    }
    const others = (
      await db.query<{ valid_from: Date; valid_to: Date | null }>(
        `SELECT h.valid_from, h.valid_to FROM company_assignment_history h JOIN companies c ON c.id = h.company_id
         WHERE h.robot_id = $1 AND c.kind = 'customer' AND h.company_id::text <> ALL($2::text[]) ORDER BY h.valid_from`,
        [robotId, own],
      )
    ).rows;
    // Complement of the other customers' periods (they never overlap: one owner at a time).
    const spans: { from: Date | null; to: Date | null }[] = [];
    let cursor: Date | null = null;
    for (const o of others) {
      spans.push({ from: cursor, to: o.valid_from });
      if (o.valid_to === null) return spans;
      cursor = o.valid_to;
    }
    spans.push({ from: cursor, to: null });
    return spans;
  }

  /** Holds `action` in at least one scope (drives UI hints; list routes still filter). */
  holdsAnywhere(user: AuthUser, action: string): boolean {
    return user.grants.some((g) => g.permissions.has(action));
  }

  /** In-memory filter of robot ids (for realtime fan-out). */
  async canReadRobot(user: AuthUser, robotId: string): Promise<boolean> {
    return this.can(user, 'robot.read', { type: 'robot', id: robotId });
  }
}
