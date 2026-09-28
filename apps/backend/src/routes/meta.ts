import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AppContext } from '../context';
import { registry, route } from '../lib/route';

function jsonSchema(schema: z.ZodType | undefined): unknown {
  if (!schema) return undefined;
  try {
    return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  } catch {
    return { type: 'object' };
  }
}

/** OpenAPI 3.1 built from the route registry — always matches the code, including each route's permission. */
export function buildOpenApi(prefix: string): unknown {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of registry) {
    const path = prefix + r.path.replace(/:([A-Za-z_]+)/g, '{$1}');
    const params = [...r.path.matchAll(/:([A-Za-z_]+)/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
    const q = jsonSchema(r.query) as { properties?: Record<string, unknown>; required?: string[] } | undefined;
    for (const [name, schema] of Object.entries(q?.properties ?? {})) params.push({ name, in: 'query', required: q?.required?.includes(name) ?? false, schema: schema as { type: string } });
    const access = r.access === 'public' ? 'public' : r.access === 'signed_in' ? 'any signed-in user' : `${r.access.can} on ${r.access.target.describe}`;
    paths[path] ??= {};
    paths[path][r.method.toLowerCase()] = {
      tags: [r.tag],
      summary: r.summary,
      description: `**Permission:** ${access}`,
      security: r.access === 'public' ? [] : [{ session: [] }],
      parameters: params,
      ...(r.body
        ? { requestBody: { required: true, content: { [r.upload ? 'multipart/form-data' : 'application/json']: { schema: jsonSchema(r.body) } } } }
        : {}),
      responses: { [String(r.status ?? 200)]: { description: 'OK' }, '4XX': { description: '{ error: { code, message, details? } }' } },
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'Arnobot PMS Admin API', version: '1.0.0', description: 'Response types: packages/message-schema/src/dto.ts. Non-GET requests need header X-Requested-With: pms-admin.' },
    servers: [{ url: '/' }],
    components: { securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: 'pms_session' } } },
    paths,
  };
}

export function metaRoutes(f: FastifyInstance, app: AppContext): void {
  route(f, app, {
    method: 'GET',
    path: '/healthz',
    summary: 'Liveness + database + storage check',
    tag: 'Meta',
    access: 'public',
    handler: async ({ reply }) => {
      let dbOk = false;
      try {
        await app.db.query('SELECT 1');
        dbOk = true;
      } catch {
        dbOk = false;
      }
      const storage = await app.storage.health();
      const ok = dbOk && storage.ok;
      reply.code(ok ? 200 : 503);
      return { ok, service: 'api', db: dbOk, storage, time: new Date().toISOString() };
    },
  });

  route(f, app, {
    method: 'GET',
    path: '/openapi.json',
    summary: 'OpenAPI 3.1 document generated from the route registry',
    tag: 'Meta',
    access: 'public',
    handler: () => buildOpenApi('/api/v1'),
  });

  route(f, app, {
    method: 'GET',
    path: '/docs',
    summary: 'Interactive API reference (Swagger UI)',
    tag: 'Meta',
    access: 'public',
    handler: ({ reply }) => {
      reply
        .type('text/html; charset=utf-8')
        .header(
          'Content-Security-Policy',
          `default-src 'none'; script-src https://cdn.jsdelivr.net '${DOCS_SCRIPT_HASH}'; style-src https://cdn.jsdelivr.net; img-src 'self' data: https://cdn.jsdelivr.net; connect-src 'self'`,
        );
      return DOCS_HTML;
    },
  });
}

const DOCS_SCRIPT = "SwaggerUIBundle({url:'/api/v1/openapi.json',dom_id:'#ui'})";
// CSP allows exactly this inline script, by hash.
const DOCS_SCRIPT_HASH = `sha256-${createHash('sha256').update(DOCS_SCRIPT).digest('base64')}`;
const DOCS_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Arnobot PMS API</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css"></head>
<body><div id="ui"></div>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>${DOCS_SCRIPT}</script>
</body></html>`;
