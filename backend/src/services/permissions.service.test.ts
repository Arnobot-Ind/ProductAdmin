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
const user = (...grants: UserGrant[]): AuthUser => ({ id: 'u', email: 'e', name: 'n', sessionId: 's', grants });

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
  });
  it('robotScope + applyRobotScope build a filter only for non-platform users', () => {
    expect(perms.robotScope(user(grant('platform', null, ['robot.read'])), 'robot.read')).toEqual({ all: true });
    const scope = perms.robotScope(user(grant('robot', 'saibya02', ['robot.read'])), 'robot.read');
    const w = perms.applyRobotScope(new Where(), scope, 'r.robot_id');
    expect(w.parts).toHaveLength(1);
    expect(w.params[0]).toEqual(['saibya02']);
  });
});
