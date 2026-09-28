import type { RealtimeChange } from './shared';
import { parse as parseCookie } from 'cookie';
import type { FastifyBaseLogger } from 'fastify';
import type { Server as HttpServer } from 'node:http';
import { Client } from 'pg';
import { Server } from 'socket.io';
import type { AppContext } from './context';
import { SESSION_COOKIE, type AuthUser } from './services/auth.service';

export const CHANGE_CHANNEL = 'pms_changes';

/**
 * Live push to the admin panel. The ingest pipeline calls pg_notify('pms_changes', …) inside its transaction
 * (delivered only on COMMIT, so rolled-back data is never announced, and it works across several backend
 * instances); this process LISTENs on a dedicated connection and fans each change out
 * over Socket.IO — only to users allowed to read that robot. No extra broker needed in v1; for several
 * API instances, add the Socket.IO Redis adapter (see docs/improvements).
 */
export function startRealtime(httpServer: HttpServer, app: AppContext, log: FastifyBaseLogger): { close: () => Promise<void> } {
  const io = new Server(httpServer, {
    path: '/socket.io',
    cors: { origin: app.cfg.adminOrigins, credentials: true },
    serveClient: false,
  });

  io.use(async (socket, next) => {
    try {
      const cookies = parseCookie(socket.handshake.headers.cookie ?? '');
      const user = await app.auth.userFromToken(cookies[SESSION_COOKIE]);
      if (!user) return next(new Error('unauthenticated'));
      socket.data.user = user;
      const scope = app.perms.robotScope(user, 'robot.read');
      if (scope.all) await socket.join('fleet');
      else if (!scope.robotIds.length && !scope.companyIds.length && !scope.siteIds.length) return next(new Error('forbidden'));
      else socket.data.scoped = true;
      next();
    } catch (err) {
      next(err as Error);
    }
  });

  // Re-validate sessions periodically so logout / disable also cuts live push.
  const sweep = setInterval(async () => {
    for (const [, socket] of io.sockets.sockets) {
      const cookies = parseCookie(socket.handshake.headers.cookie ?? '');
      const still = await app.auth.userFromToken(cookies[SESSION_COOKIE]).catch(() => null);
      if (!still) socket.disconnect(true);
    }
  }, 60_000);

  async function fanOut(change: RealtimeChange): Promise<void> {
    io.to('fleet').emit('change', change);
    for (const [, socket] of io.sockets.sockets) {
      if (!socket.data.scoped) continue;
      if (await app.perms.canReadRobot(socket.data.user as AuthUser, change.robot_id)) socket.emit('change', change);
    }
  }

  let listener: Client | null = null;
  let stopped = false;
  const connect = async (): Promise<void> => {
    if (stopped) return;
    listener = new Client({ connectionString: app.cfg.databaseUrl, application_name: 'pms-api-listen' });
    listener.on('notification', (msg) => {
      if (msg.channel !== CHANGE_CHANNEL || !msg.payload) return;
      try {
        void fanOut(JSON.parse(msg.payload) as RealtimeChange);
      } catch {
        log.warn('bad realtime payload');
      }
    });
    listener.on('error', (err) => {
      log.warn({ err }, 'realtime listener lost; reconnecting in 5 s');
      listener?.end().catch(() => undefined);
      setTimeout(() => void connect().catch(() => undefined), 5_000);
    });
    await listener.connect();
    await listener.query(`LISTEN ${CHANGE_CHANNEL}`);
    log.info('realtime: listening for ingest changes');
  };
  void connect().catch((err) => {
    log.warn({ err }, 'realtime listener failed to start; retrying in 5 s');
    setTimeout(() => void connect().catch(() => undefined), 5_000);
  });

  return {
    close: async () => {
      stopped = true;
      clearInterval(sweep);
      await new Promise<void>((resolve) => io.close(() => resolve()));
      await listener?.end().catch(() => undefined);
    },
  };
}
