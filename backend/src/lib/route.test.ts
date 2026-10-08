import http from 'node:http';
import { Readable } from 'node:stream';
import Fastify from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../context';
import { errorHandler } from './errors';
import { route } from './route';

// Regression (2026-10-08): closing a video mid-stream crashed the whole server. The route wrapper's
// `await handler()` unwraps the thenable reply to undefined, reply.sent stays false after a hang-up, and
// the wrapper then sent a 204 on a response already streaming → ERR_HTTP_HEADERS_SENT, uncaught.
describe('a client that hangs up mid-stream', () => {
  const app = Fastify();
  app.setErrorHandler(errorHandler);
  const ctx = {} as AppContext; // public routes never touch it
  route(app, ctx, {
    method: 'GET',
    path: '/slow.ts',
    summary: 'test stream',
    tag: 'test',
    access: 'public',
    handler: ({ reply }) => {
      // Like an S3 body: the first chunk arrives (headers go out), then the rest is slow.
      const body = new Readable({ read() {} });
      body.push(Buffer.alloc(1024));
      return reply.header('Content-Type', 'video/mp2t').send(body);
    },
  });
  route(app, ctx, { method: 'GET', path: '/ok', summary: 'test', tag: 'test', access: 'public', handler: () => ({ ok: true }) });
  afterAll(() => app.close());

  it('leaves the server running', async () => {
    const crashes: unknown[] = [];
    const onCrash = (e: unknown) => crashes.push(e);
    process.on('uncaughtException', onCrash);
    try {
      await app.listen({ port: 0, host: '127.0.0.1' });
      const { port } = app.server.address() as { port: number };
      await new Promise<void>((resolve) => {
        const req = http.get({ port, host: '127.0.0.1', path: '/slow.ts' }, (res) => res.once('data', () => req.destroy()));
        req.on('close', () => resolve());
        req.on('error', () => resolve());
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(crashes).toEqual([]);
      const res = await fetch(`http://127.0.0.1:${port}/ok`);
      expect(await res.json()).toEqual({ ok: true });
    } finally {
      process.off('uncaughtException', onCrash);
    }
  });
});
