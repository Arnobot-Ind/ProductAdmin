import { canonicalRobotIds } from './services/robots.service';
import compress from '@fastify/compress';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppContext } from './context';
import { archiveIngestRoutes } from './ingest/archive';
import { detectionImageRoutes } from './ingest/detectionImage';
import { ingestRoutes } from './ingest/routes';
import { archiveRoutes } from './routes/archive';
import { systemRoutes } from './routes/system';
import type { IngestPipeline } from './ingest/pipeline';
import { errorHandler } from './lib/errors';
import { authRoutes } from './routes/auth';
import { catalogueRoutes } from './routes/catalogue';
import { clientAdminRoutes } from './routes/client-admin';
import { clientPortalRoutes } from './routes/client-portal';
import { credentialRoutes } from './routes/credentials';
import { dashboardRoutes } from './routes/dashboard';
import { detectionRoutes } from './routes/detections';
import { documentRoutes } from './routes/documents';
import { eventRoutes } from './routes/events';
import { hardwareRoutes } from './routes/hardware';
import { ingestAdminRoutes } from './routes/ingestAdmin';
import { metaRoutes } from './routes/meta';
import { missionRoutes } from './routes/missions';
import { organizationRoutes } from './routes/organizations';
import { auditRoutes } from './routes/audit';
import { releaseRoutes } from './routes/releases';
import { reportRoutes } from './routes/reports';
import { robotRoutes } from './routes/robots';
import { activityRoutes } from './routes/activity';
import { robotLogRoutes } from './routes/robot-log';
import { noteSearchRoutes } from './routes/notes-search';
import { attachmentRoutes } from './routes/attachments';
import { siteRoutes } from './routes/sites';
import { telemetryRoutes } from './routes/telemetry';
import { userRoutes } from './routes/users';
import { sessionCookieName } from './services/auth.service';

export const API_PREFIX = '/api/v1';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function buildApp(ctx: AppContext, makePipeline: (log: FastifyInstance['log']) => IngestPipeline): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: ctx.cfg.logLevel,
      // Rule 11: secrets never reach the logs. Bodies are not logged at all.
      redact: { paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'], censor: '[redacted]' },
    },
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(helmet, {
    // JSON API only: lock everything down. The admin panel is served by Next.js, not from here.
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  // gzip JSON / text responses (lists and reports shrink ~5-10x: less egress, less proxying on Amplify).
  // Video, images and other binary files are already compressed: they pass through untouched.
  await app.register(compress, {
    global: true,
    threshold: 1024,
    encodings: ['gzip', 'deflate'],
    customTypes: /^(application\/(json|[\w.+-]+\+json|vnd\.apple\.mpegurl)|text\/)/,
  });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: ctx.cfg.maxUploadBytes } });

  /**
   * File uploads from the admin panel / client app go straight to this server (https://api.arnobot.in), not through
   * the hosting proxy on the panel's own domain, which refuses request bodies above ~5 MB. The browser asks first
   * (CORS preflight); it is granted only for these upload routes, only to POST, and only to the panel's and client
   * app's own origins (ADMIN_ORIGIN, CLIENT_ORIGIN). The session cookie is SameSite=Lax on the parent domain, and the
   * CSRF hook below still requires X-Requested-With: pms-admin and an allowed Origin.
   */
  const uploadPath = /^\/api\/v1\/(?:documents(?:\/[0-9a-f-]{36}\/versions)?|releases|(?:products|attachments|software-products)\/[0-9a-f-]{36}\/media)\/?$/;
  const uploadOrigin = (origin: string | undefined) =>
    !!origin && [...ctx.cfg.adminOrigins, ...ctx.cfg.clientOrigins].includes(origin);
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (!uploadOrigin(origin) || !uploadPath.test(req.url.split('?')[0])) return;
    reply.header('Access-Control-Allow-Origin', origin).header('Access-Control-Allow-Credentials', 'true').header('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      return reply
        .header('Access-Control-Allow-Methods', 'POST')
        .header('Access-Control-Allow-Headers', 'X-Requested-With, Accept')
        .header('Access-Control-Max-Age', '600')
        .code(204)
        .send();
    }
  });
  await app.register(rateLimit, {
    max: 600,
    timeWindow: '1 minute',
    keyGenerator: (req) => {
      const session = req.cookies?.[sessionCookieName(req.headers)];
      return session ? `s:${session.slice(0, 16)}` : `ip:${req.ip}`;
    },
  });

  // Never let an API response be cached by a browser or proxy (contains operational data).
  app.addHook('onSend', async (_req, reply, payload) => {
    if (!reply.getHeader('cache-control')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: { code: 'not_found', message: `no route ${req.method} ${req.url.split('?')[0]}` } }));

  // cloud_sync (server mode) polls GET /api/health and expects { ok: true } before uploading.
  app.get('/api/health', async (_req, reply) => {
    try {
      await ctx.db.query('SELECT 1');
      return { ok: true, service: 'pms-backend', time: new Date().toISOString() };
    } catch {
      return reply.code(503).send({ ok: false, service: 'pms-backend', error: 'database unreachable' });
    }
  });

  // Robot / GCS ingestion: ingest-key auth, no session, so no CSRF hook (registered outside the admin scope).
  await app.register(async (ingest) => ingestRoutes(ingest, ctx.db, makePipeline(app.log), ctx.cfg.ingest), { prefix: API_PREFIX });
  // Robot → detection snapshots (fleetSync): raw JPEG body, ingest-key auth.
  await app.register(async (d) => detectionImageRoutes(d, ctx), { prefix: API_PREFIX });
  // Robot → video/sensor archive (cloud_sync). Also under the Saibya Archive server's old paths.
  await app.register(async (a) => archiveIngestRoutes(a, ctx, { upload: '/upload', events: '/events', heartbeat: '/heartbeat' }), {
    prefix: `${API_PREFIX}/archive`,
  });
  await app.register(async (a) => archiveIngestRoutes(a, ctx, { upload: '/upload', events: '', heartbeat: '/heartbeat' }), { prefix: '/api/ingest' });

  // Admin panel routes: session auth via route(), plus the CSRF hook below.
  await app.register(
    async (api) => {
      /**
       * CSRF defence in depth (the session cookie is also SameSite=Lax): every state-changing request
       * must carry `X-Requested-With: pms-admin` — a custom header cannot be sent cross-site without a
       * CORS preflight, which is granted only to the panel's own origins for file uploads (see above) — and a
       * present Origin must be an allowed admin origin.
       */
      api.addHook('onRequest', async (req, reply) => {
        if (SAFE_METHODS.has(req.method)) return;
        const origin = req.headers.origin;
        const host = req.headers.host;
        const sameHost = origin && host && (origin === `http://${host}` || origin === `https://${host}`);
        if (origin && !sameHost && ![...ctx.cfg.adminOrigins, ...ctx.cfg.clientOrigins].includes(origin)) {
          return reply.code(403).send({ error: { code: 'forbidden', message: 'cross-origin request refused' } });
        }
        if (req.headers['x-requested-with'] !== 'pms-admin') {
          return reply.code(403).send({ error: { code: 'forbidden', message: 'missing X-Requested-With: pms-admin header' } });
        }
      });
      /**
       * Old robot names (0028): a page address or filter that still names a robot by its old Robot ID
       * ('saibya02') or old serial is switched to the robot's serial number before access is checked.
       */
      api.addHook('preValidation', async (req) => {
        const params = req.params as Record<string, string> | undefined;
        const query = req.query as Record<string, string> | undefined;
        // A serial written with dashes (1-005-000-0002-16) is the same serial.
        const undash = (v: unknown) => (typeof v === 'string' && /^[12](?:-?[0-9]){12}$/.test(v) ? v.replace(/-/g, '') : v);
        if (params?.robotId) params.robotId = undash(params.robotId) as string;
        if (query?.robot) query.robot = undash(query.robot) as string;
        // Also a serial the robot had before (e.g. after its base model was renumbered in 0030).
        const names = [params?.robotId, query?.robot].filter((v): v is string => typeof v === 'string' && !!v);
        if (!names.length) return;
        const map = await canonicalRobotIds(ctx.db, names);
        if (params?.robotId && map.has(params.robotId)) params.robotId = map.get(params.robotId)!;
        if (query?.robot && map.has(query.robot)) query.robot = map.get(query.robot)!;
      });
      metaRoutes(api, ctx);
      authRoutes(api, ctx);
      dashboardRoutes(api, ctx);
      catalogueRoutes(api, ctx);
      robotRoutes(api, ctx);
      robotLogRoutes(api, ctx);
      activityRoutes(api, ctx);
      noteSearchRoutes(api, ctx);
      attachmentRoutes(api, ctx);
      siteRoutes(api, ctx);
      hardwareRoutes(api, ctx);
      telemetryRoutes(api, ctx);
      reportRoutes(api, ctx);
      credentialRoutes(api, ctx);
      ingestAdminRoutes(api, ctx);
      missionRoutes(api, ctx);
      eventRoutes(api, ctx);
      documentRoutes(api, ctx);
      releaseRoutes(api, ctx);
      userRoutes(api, ctx);
      organizationRoutes(api, ctx);
      clientAdminRoutes(api, ctx);
      clientPortalRoutes(api, ctx);
      detectionRoutes(api, ctx);
      auditRoutes(api, ctx);
      archiveRoutes(api, ctx);
      systemRoutes(api, ctx);
    },
    { prefix: API_PREFIX },
  );
  return app;
}
