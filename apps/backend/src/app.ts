import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppContext } from './context';
import { ingestRoutes } from './ingest/routes';
import type { IngestPipeline } from './ingest/pipeline';
import { errorHandler } from './lib/errors';
import { authRoutes } from './routes/auth';
import { catalogueRoutes } from './routes/catalogue';
import { credentialRoutes } from './routes/credentials';
import { documentRoutes } from './routes/documents';
import { eventRoutes } from './routes/events';
import { hardwareRoutes } from './routes/hardware';
import { ingestAdminRoutes } from './routes/ingest-admin';
import { metaRoutes } from './routes/meta';
import { missionRoutes } from './routes/missions';
import { releaseRoutes } from './routes/releases';
import { robotRoutes } from './routes/robots';
import { telemetryRoutes } from './routes/telemetry';
import { userRoutes } from './routes/users';

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
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: ctx.cfg.maxUploadBytes } });
  await app.register(rateLimit, {
    max: 600,
    timeWindow: '1 minute',
    keyGenerator: (req) => (req.cookies?.pms_session ? `s:${req.cookies.pms_session.slice(0, 16)}` : `ip:${req.ip}`),
  });

  // Never let an API response be cached by a browser or proxy (contains operational data).
  app.addHook('onSend', async (_req, reply, payload) => {
    if (!reply.getHeader('cache-control')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: { code: 'not_found', message: `no route ${req.method} ${req.url.split('?')[0]}` } }));

  // Robot / GCS ingestion: ingest-key auth, no session, so no CSRF hook (registered outside the admin scope).
  await app.register(async (ingest) => ingestRoutes(ingest, ctx.db, makePipeline(app.log), ctx.cfg.ingest), { prefix: API_PREFIX });

  // Admin panel routes: session auth via route(), plus the CSRF hook below.
  await app.register(
    async (api) => {
      /**
       * CSRF defence in depth (the session cookie is also SameSite=Lax): every state-changing request
       * must carry `X-Requested-With: pms-admin` — a custom header cannot be sent cross-site without a
       * CORS preflight, which is never granted — and a present Origin must be an allowed admin origin.
       */
      api.addHook('onRequest', async (req, reply) => {
        if (SAFE_METHODS.has(req.method)) return;
        const origin = req.headers.origin;
        const host = req.headers.host;
        const sameHost = origin && host && (origin === `http://${host}` || origin === `https://${host}`);
        if (origin && !sameHost && !ctx.cfg.adminOrigins.includes(origin)) {
          return reply.code(403).send({ error: { code: 'forbidden', message: 'cross-origin request refused' } });
        }
        if (req.headers['x-requested-with'] !== 'pms-admin') {
          return reply.code(403).send({ error: { code: 'forbidden', message: 'missing X-Requested-With: pms-admin header' } });
        }
      });
      metaRoutes(api, ctx);
      authRoutes(api, ctx);
      catalogueRoutes(api, ctx);
      robotRoutes(api, ctx);
      hardwareRoutes(api, ctx);
      telemetryRoutes(api, ctx);
      credentialRoutes(api, ctx);
      ingestAdminRoutes(api, ctx);
      missionRoutes(api, ctx);
      eventRoutes(api, ctx);
      documentRoutes(api, ctx);
      releaseRoutes(api, ctx);
      userRoutes(api, ctx);
    },
    { prefix: API_PREFIX },
  );
  return app;
}
