import type { Db } from '../db';
import { describe, expect, it } from 'vitest';
import { Where } from '../lib/sql';
import type { AuthUser, UserGrant } from './auth.service';
import { dataSince, PermissionsService } from './permissions.service';

const grant = (scopeType: UserGrant['scopeType'], scopeId: string | null, perms: string[]): UserGrant => ({
  id: 'g',
  roleKey: 'r',
  roleName: 'R',
  scopeType,
  scopeId,
  permissions: new Set(perms),
  createdAt: new Date(),
});
/** An Arnobot staff user with these grants. */
const user = (...grants: UserGrant[]): AuthUser => ({
  id: 'u',
  email: 'e',
  name: 'n',
  sessionId: 's',
  companyId: 'arnobot',
  companyName: 'Arnobot',
  companyKind: 'internal',
  mustChangePassword: false,
  grants,
  client: null,
});
/** A user of customer organization c1 (Adani), optionally with a data history limit. */
const customer = (dataHistoryDays: number | null, ...grants: UserGrant[]): AuthUser => ({
  ...user(...grants),
  companyId: 'c1',
  companyName: 'Adani',
  companyKind: 'customer',
  client: { status: 'active', features: new Set(), organizationFeatures: [], dataHistoryDays, dataFrom: null },
});

/** Fake DB: robot saibya01 is currently owned by company c1. */
const db = {
  query: async (_sql: string, params: unknown[]) => {
    const [robot, companies] = params as [string, string[]];
    return { rowCount: robot === 'saibya01' && companies.includes('c1') ? 1 : 0, rows: [] };
  },
} as unknown as Db;
const perms = new PermissionsService(db);

describe('can(user, action, target) — spec §12', () => {
  it('denies when the user has no grant with the permission', async () => {
    expect(await perms.can(user(grant('platform', null, ['robot.read'])), 'robot.write', { type: 'platform' })).toBe(false);
  });
  it('platform scope covers everything', async () => {
    const u = user(grant('platform', null, ['robot.write']));
    expect(await perms.can(u, 'robot.write', { type: 'robot', id: 'any01' })).toBe(true);
    expect(await perms.can(u, 'robot.write', { type: 'platform' })).toBe(true);
  });
  it('robot scope covers only that robot, never platform actions', async () => {
    const u = user(grant('robot', 'saibya02', ['robot.read']));
    expect(await perms.can(u, 'robot.read', { type: 'robot', id: 'saibya02' })).toBe(true);
    expect(await perms.can(u, 'robot.read', { type: 'robot', id: 'saibya01' })).toBe(false);
    expect(await perms.can(u, 'robot.read', { type: 'platform' })).toBe(false);
    expect(await perms.can(u, 'robot.read', { type: 'any' })).toBe(true);
  });
  it('company scope covers robots the company CURRENTLY owns', async () => {
    const u = user(grant('company', 'c1', ['robot.read']));
    expect(await perms.can(u, 'robot.read', { type: 'robot', id: 'saibya01' })).toBe(true);
    expect(await perms.can(u, 'robot.read', { type: 'robot', id: 'saibya02' })).toBe(false);
    expect(await perms.can(u, 'robot.read', { type: 'company', id: 'c1' })).toBe(true);
    expect(await perms.can(u, 'robot.read', { type: 'company', id: 'c2' })).toBe(false);
  });
  it('an organization viewer may view but not download (per-permission check)', async () => {
    const viewer = user(grant('company', 'c1', ['robot.read']));
    expect(await perms.can(viewer, 'robot.read', { type: 'robot', id: 'saibya01' })).toBe(true);
    expect(await perms.can(viewer, 'data.download', { type: 'robot', id: 'saibya01' })).toBe(false);
    expect(await perms.can(viewer, 'data.download_restricted', { type: 'robot', id: 'saibya01' })).toBe(false);
    const operator = user(grant('company', 'c1', ['robot.read', 'data.download']));
    expect(await perms.can(operator, 'data.download', { type: 'robot', id: 'saibya01' })).toBe(true);
    expect(await perms.can(operator, 'data.download_restricted', { type: 'robot', id: 'saibya01' })).toBe(false);
  });
  it('robotScope + applyRobotScope build a filter only for non-platform users', () => {
    expect(perms.robotScope(user(grant('platform', null, ['robot.read'])), 'robot.read')).toEqual({ all: true });
    const scope = perms.robotScope(user(grant('robot', 'saibya02', ['robot.read'])), 'robot.read');
    const w = perms.applyRobotScope(new Where(), scope, 'r.robot_id');
    expect(w.parts).toHaveLength(1);
    expect(w.params[0]).toEqual(['saibya02']);
  });
});

describe('ownership-period data scope', () => {
  it('adds nothing for platform users', () => {
    const w = perms.applyDataScope(new Where(), { all: true }, 's.robot_id', 's.started_at');
    expect(w.parts).toHaveLength(0);
  });
  it('company grants: robot owned now, and never rows from another customer’s period', () => {
    const scope = perms.robotScope(user(grant('company', 'c1', ['robot.read'])), 'robot.read');
    const w = perms.applyDataScope(new Where(), scope, 's.robot_id', 's.started_at');
    expect(w.parts).toHaveLength(1);
    expect(w.parts[0]).toContain('ds_h.valid_to IS NULL');
    expect(w.parts[0]).toContain("ds_c.kind = 'customer'");
    expect(w.parts[0]).toContain('s.started_at >= ds_o.valid_from');
    expect(w.params).toEqual([[], ['c1'], ['c1'], []]);
  });
  it('dataPeriods: platform and robot grants see the whole history', async () => {
    expect(await perms.dataPeriods(user(grant('platform', null, ['robot.read'])), 'robot.read', 'saibya01')).toBeNull();
    expect(await perms.dataPeriods(user(grant('robot', 'saibya01', ['robot.read'])), 'robot.read', 'saibya01')).toBeNull();
    expect(await perms.dataPeriods(user(grant('platform', null, ['catalog.read'])), 'robot.read', 'saibya01')).toEqual([]);
  });
  it('dataPeriods: everything except other customers’ periods', async () => {
    const t = (iso: string) => new Date(iso);
    const fake = {
      query: async (sql: string) =>
        sql.includes('SELECT 1 WHERE')
          ? { rowCount: 1, rows: [] }
          : {
              rowCount: 1,
              rows: [
                { valid_from: t('2026-01-01T00:00:00Z'), valid_to: t('2026-03-01T00:00:00Z') },
                { valid_from: t('2026-05-01T00:00:00Z'), valid_to: t('2026-06-01T00:00:00Z') },
              ],
            },
    } as unknown as Db;
    const spans = await new PermissionsService(fake).dataPeriods(user(grant('company', 'c1', ['robot.read'])), 'robot.read', 'saibya02');
    expect(spans).toEqual([
      { from: null, to: t('2026-01-01T00:00:00Z') },
      { from: t('2026-03-01T00:00:00Z'), to: t('2026-05-01T00:00:00Z') },
      { from: t('2026-06-01T00:00:00Z'), to: null },
    ]);
  });
  it('holdsAnywhere looks at every scope', () => {
    const u = user(grant('company', 'c1', ['data.delete']));
    expect(perms.holdsAnywhere(u, 'data.delete')).toBe(true);
    expect(perms.holdsAnywhere(u, 'user.manage')).toBe(false);
  });
});

describe('customer users (0021): per-user robots stay inside the organization', () => {
  it('a robot grant counts only while the organization owns the robot', async () => {
    // fake db: saibya01 is owned by c1, saibya02 is not
    const u = customer(null, grant('robot', 'saibya01', ['robot.read']), grant('robot', 'saibya02', ['robot.read']));
    expect(await perms.can(u, 'robot.read', { type: 'robot', id: 'saibya01' })).toBe(true);
    expect(await perms.can(u, 'robot.read', { type: 'robot', id: 'saibya02' })).toBe(false);
  });
  it('grants on another organization are ignored', async () => {
    const u = customer(null, grant('company', 'c2', ['robot.read']));
    expect(await perms.can(u, 'robot.read', { type: 'robot', id: 'saibya01' })).toBe(false);
    const scope = perms.robotScope(u, 'robot.read');
    expect(scope).toMatchObject({ all: false, companyIds: [], customerOrg: 'c1' });
  });
  it('data rule: own robots, owned now, never another customer’s period, and the history limit', () => {
    const scope = perms.robotScope(customer(30, grant('robot', 'saibya01', ['robot.read'])), 'robot.read');
    const w = perms.applyDataScope(new Where(), scope, 's.robot_id', 's.started_at');
    expect(w.parts).toHaveLength(3);
    expect(w.parts[0]).toBe('s.started_at >= $1');
    expect((w.params[0] as Date).getTime()).toBeLessThan(Date.now() - 29 * 86_400_000);
    expect(w.parts[1]).toContain('sc_h.valid_to IS NULL');
    expect(w.parts[2]).toContain("ds_c.kind = 'customer'");
    expect(w.params.slice(1)).toEqual([['saibya01'], 'c1', [], 'c1', 'c1']);
  });
  it('dataPeriods: a robot grant no longer means the whole history, and the limit clips the start', async () => {
    const t = (iso: string) => new Date(iso);
    const fake = {
      query: async (sql: string) =>
        sql.startsWith('SELECT 1') ? { rowCount: 1, rows: [] } : { rowCount: 1, rows: [{ valid_from: t('2026-01-01T00:00:00Z'), valid_to: t('2026-03-01T00:00:00Z') }] },
    } as unknown as Db;
    const svc = new PermissionsService(fake);
    expect(await svc.dataPeriods(customer(null, grant('robot', 'saibya02', ['robot.read'])), 'robot.read', 'saibya02')).toEqual([
      { from: null, to: t('2026-01-01T00:00:00Z') },
      { from: t('2026-03-01T00:00:00Z'), to: null },
    ]);
    const limited = await svc.dataPeriods(customer(7, grant('robot', 'saibya02', ['robot.read'])), 'robot.read', 'saibya02');
    expect(limited).toHaveLength(1);
    expect(limited![0].to).toBeNull();
    expect(limited![0].from!.getTime()).toBeGreaterThan(Date.now() - 8 * 86_400_000);
  });
});

describe('customer data start (0023)', () => {
  const withFrom = (dataHistoryDays: number | null, dataFrom: string | null): AuthUser => {
    const u = customer(dataHistoryDays);
    return { ...u, client: { ...u.client!, dataFrom } };
  };

  it('starts at the beginning of the IST day', () => {
    expect(dataSince(withFrom(null, '2026-10-01'))?.toISOString()).toBe('2026-09-30T18:30:00.000Z');
  });

  it('takes the later of the start date and the history limit', () => {
    expect(dataSince(withFrom(1, '2026-10-01'))!.getTime()).toBeGreaterThan(Date.parse('2026-10-01T00:00:00+05:30'));
    expect(dataSince(withFrom(36500, '2026-10-01'))?.toISOString()).toBe('2026-09-30T18:30:00.000Z');
  });

  it('is null without either limit', () => {
    expect(dataSince(withFrom(null, null))).toBeNull();
  });
});
