/**
 * Customer view (0020): a customer user holds robot.read (and, as Manager, user.invite) but never robot.details.
 * These tests pin which routes plain robot.read opens, so a new robot route cannot leak internal records to
 * customers by declaring robot.read by accident.
 */
import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../context';
import { registry, type RouteDef } from '../lib/route';
import { archiveRoutes } from './archive';
import { auditRoutes } from './audit';
import { authRoutes } from './auth';
import { catalogueRoutes } from './catalogue';
import { clientAdminRoutes } from './client-admin';
import { clientPortalRoutes } from './client-portal';
import { credentialRoutes } from './credentials';
import { dashboardRoutes } from './dashboard';
import { detectionRoutes } from './detections';
import { documentRoutes } from './documents';
import { eventRoutes } from './events';
import { hardwareRoutes } from './hardware';
import { ingestAdminRoutes } from './ingest-admin';
import { missionRoutes } from './missions';
import { organizationRoutes } from './organizations';
import { releaseRoutes } from './releases';
import { reportRoutes } from './reports';
import { robotRoutes } from './robots';
import { telemetryRoutes } from './telemetry';
import { userRoutes } from './users';

/** Anything: every property is another stub, calling it returns a stub. Registration only records routes. */
const stub = (): unknown => new Proxy(() => stub(), { get: (_t, k) => (k === 'then' ? undefined : stub()), apply: () => stub() });

const perms = (r: RouteDef<unknown, unknown>): string[] => (typeof r.access === 'object' ? [r.access.can].flat() : []);
const find = (method: string, path: string) => registry.find((r) => r.method === method && r.path === path);

/** Routes on one robot that customers (robot.read only) may call: overview, live status, the day-wise reports. */
const CUSTOMER_ROBOT_ROUTES = new Set(['GET /robots/:robotId', 'GET /robots/:robotId/live', 'GET /robots/:robotId/reports/day', 'GET /robots/:robotId/reports/daily-distance', 'GET /robots/:robotId/reports/missions', 'GET /robots/:robotId/reports/missions/:missionId', 'GET /robots/:robotId/reports/calendar', 'GET /robots/:robotId/client/events', 'GET /robots/:robotId/client/telemetry/:kind', 'GET /robots/:robotId/client/detections', 'GET /robots/:robotId/client/detections/:id/image']);
/** Of those, the ones that are not the robot itself: each sits behind a client-app feature (0021). */
const ALWAYS_ON = new Set(['GET /robots/:robotId', 'GET /robots/:robotId/live']);

beforeAll(() => {
  const f = stub() as FastifyInstance;
  const app = stub() as AppContext;
  for (const register of [
    authRoutes,
    dashboardRoutes,
    catalogueRoutes,
    robotRoutes,
    hardwareRoutes,
    telemetryRoutes,
    reportRoutes,
    credentialRoutes,
    ingestAdminRoutes,
    missionRoutes,
    eventRoutes,
    documentRoutes,
    releaseRoutes,
    userRoutes,
    organizationRoutes,
    auditRoutes,
    archiveRoutes,
    clientAdminRoutes,
    clientPortalRoutes,
    detectionRoutes,
  ]) {
    register(f, app);
  }
});

describe('route access matrix (customer view)', () => {
  it('registered the routes', () => {
    expect(registry.length).toBeGreaterThan(50);
  });

  it('opens only overview, live and reports of a robot with plain robot.read', () => {
    const readOnly = registry.filter((r) => r.path.startsWith('/robots/:robotId') && perms(r).length === 1 && perms(r)[0] === 'robot.read').map((r) => `${r.method} ${r.path}`);
    expect(new Set(readOnly)).toEqual(CUSTOMER_ROBOT_ROUTES);
  });

  it('keeps every other per-robot read behind robot.details (or a stronger permission)', () => {
    for (const r of registry.filter((x) => x.path.startsWith('/robots/:robotId') && !CUSTOMER_ROBOT_ROUTES.has(`${x.method} ${x.path}`))) {
      expect(perms(r), `${r.method} ${r.path}`).not.toContain('robot.read');
      expect(perms(r).length, `${r.method} ${r.path}`).toBeGreaterThan(0);
    }
  });

  it.each([
    ['GET', '/robots/:robotId/hardware'],
    ['GET', '/robots/:robotId/maintenance'],
    ['GET', '/robots/:robotId/missions'],
    ['GET', '/robots/:robotId/events'],
    ['GET', '/robots/:robotId/archive'],
    ['GET', '/robots/:robotId/telemetry/gps'],
    ['GET', '/robots/:robotId/software'],
    ['GET', '/robots/:robotId/ownership'],
    ['GET', '/robots/:robotId/documents'],
    ['GET', '/robots/:robotId/dispatch'],
    ['GET', '/robots/:robotId/connectivity'],
    ['GET', '/robots/:robotId/detections'],
    ['GET', '/robots/:robotId/detections/:id/image'],
    ['GET', '/missions'],
    ['GET', '/missions/:missionId'],
    ['GET', '/events'],
  ])('%s %s needs robot.details', (method, path) => {
    const r = find(method, path);
    expect(r, `${method} ${path} registered`).toBeDefined();
    expect(perms(r!)).toEqual(['robot.details']);
  });

  it('lets customer Managers (user.invite) reach user management, and nobody else without user.manage', () => {
    const userRoutes = registry.filter((r) => r.path.startsWith('/users') || r.path.startsWith('/grants') || r.path === '/roles');
    expect(userRoutes.length).toBeGreaterThanOrEqual(8);
    for (const r of userRoutes) expect(new Set(perms(r)), `${r.method} ${r.path}`).toEqual(new Set(['user.manage', 'user.invite']));
  });

  it('never opens organization, audit or catalogue writes to customer permissions', () => {
    const customerPerms = new Set(['robot.read', 'user.invite']);
    const open = registry.filter((r) => /^\/(organizations|companies|audit|products|releases|ingest)/.test(r.path) && perms(r).some((p) => customerPerms.has(p)));
    expect(open.map((r) => `${r.method} ${r.path}`)).toEqual([]);
  });

  it('puts every customer data route behind a client-app feature (Arnobot staff are not feature-limited)', () => {
    const customerReads = registry.filter((r) => perms(r).length === 1 && perms(r)[0] === 'robot.read' && !ALWAYS_ON.has(`${r.method} ${r.path}`));
    const unfeatured = customerReads.filter((r) => !r.feature && !/^\/(robots|dashboard|reports\/fleet)$/.test(r.path)).map((r) => `${r.method} ${r.path}`);
    expect(unfeatured).toEqual([]);
  });

  it('keeps client admin (profile, features, software, credentials) to Arnobot staff', () => {
    const customerPerms = new Set(['robot.read', 'user.invite']);
    const staff = registry.filter((r) => /^\/(software-products|software-installs|client-credentials|account-managers)|^\/organizations\/:id\/(profile|features|software|credentials)/.test(r.path));
    expect(staff.length).toBeGreaterThanOrEqual(14);
    for (const r of staff) expect(perms(r).some((p) => customerPerms.has(p)), `${r.method} ${r.path}`).toBe(false);
  });
});
