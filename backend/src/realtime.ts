import type { RealtimeChange } from './shared';
import { parse as parseCookie } from 'cookie';
import type { FastifyBaseLogger } from 'fastify';
import type { Server as HttpServer } from 'node:http';
import { Client } from 'pg';
import { Server } from 'socket.io';
import type { AppContext } from './context';
import { SESSION_COOKIE, type AuthUser } from './services/auth.service';

export const CHANGE_CHANNEL = 'pms_changes';

/** Shortest gap between two pushes of the same kind for the same robot (kinds not listed: no limit). */
const THROTTLE_MS: Partial<Record<RealtimeChange['kind'], number>> = { live: 5_000, telemetry: 10_000, seen: 30_000, archive: 5_000 };

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
    cors: { origin: [...app.cfg.adminOrigins, ...app.cfg.clientOrigins], credentials: true },
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

  // Every robot message announces itself, and each announcement makes every open browser refetch lists and
  // the dashboard. High-rate kinds are sent at most once per window per robot (first at once, the latest at the
  // window's end); events, missions and software changes always go out at once.
  const windows = new Map<string, { timer: NodeJS.Timeout; pending: RealtimeChange | null }>();
  function throttled(change: RealtimeChange): void {
    const ms = THROTTLE_MS[change.kind] ?? 0;
    if (!ms) return void fanOut(change);
    const key = `${change.kind}:${change.robot_id}`;
    const open = windows.get(key);
    if (open) {
      open.pending = change;
      return;
    }
    void fanOut(change);
    const close = () => {
      const w = windows.get(key);
      if (w?.pending) {
        void fanOut(w.pending);
        w.pending = null;
        w.timer = setTimeout(close, ms);
        w.timer.unref();
      } else windows.delete(key);
    };
    const timer = setTimeout(close, ms);
    timer.unref();
    windows.set(key, { timer, pending: null });
  }

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
        throttled(JSON.parse(msg.payload) as RealtimeChange);
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
      for (const w of windows.values()) clearTimeout(w.timer);
      await new Promise<void>((resolve) => io.close(() => resolve()));
      await listener?.end().catch(() => undefined);
    },
  };
}
