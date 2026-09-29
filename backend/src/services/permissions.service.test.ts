import type { Db } from '../db';
import { describe, expect, it } from 'vitest';
import { Where } from '../lib/sql';
import type { AuthUser, UserGrant } from './auth.service';
import { PermissionsService } from './permissions.service';

const grant = (scopeType: UserGrant['scopeType'], scopeId: string | null, perms: string[]): UserGrant => ({
  id: 'g',
  roleKey: 'r',
  roleName: 'R',
  scopeType,
  scopeId,
  permissions: new Set(perms),
  createdAt: new Date(),
});
const user = (...grants: UserGrant[]): AuthUser => ({
  id: 'u',
  email: 'e',
  name: 'n',
  sessionId: 's',
  companyId: 'c1',
  companyName: 'Adani',
  companyKind: 'customer',
  mustChangePassword: false,
  grants,
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
