import type { MeDto } from '@arnobot/message-schema';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context';
import { unauthenticated } from '../lib/errors';
import { route } from '../lib/route';
import { SESSION_COOKIE } from '../services/auth.service';

const loginBody = z.object({ email: z.string().trim().email().max(320), password: z.string().min(1).max(256) });
const changePasswordBody = z.object({ current_password: z.string().min(1).max(256), new_password: z.string().min(1).max(256) });

export function authRoutes(f: FastifyInstance, app: AppContext): void {
  const tag = 'Auth';

  route(f, app, {
    method: 'POST',
    path: '/auth/login',
    summary: 'Sign in; sets the httpOnly session cookie',
    tag,
    access: 'public',
    body: loginBody,
    handler: async ({ body, req, reply }): Promise<MeDto> => {
      const { token, expiresAt } = await app.auth.login(body.email, body.password, req.ip, req.headers['user-agent']);
      reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, secure: app.cfg.cookieSecure, sameSite: 'lax', path: '/', expires: expiresAt });
      const user = await app.auth.userFromToken(token);
      if (!user) throw unauthenticated();
      return app.auth.toMe(user);
    },
  });

  route(f, app, {
    method: 'POST',
    path: '/auth/logout',
    summary: 'Sign out (revokes the session server-side)',
    tag,
    access: 'signed_in',
    handler: async ({ user, reply }) => {
      await app.auth.logout(user.sessionId);
      reply.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, sameSite: 'lax', secure: app.cfg.cookieSecure });
    },
  });

  route(f, app, {
    method: 'GET',
    path: '/auth/me',
    summary: 'Current user and effective platform permissions',
    tag,
    access: 'signed_in',
    handler: ({ user }): MeDto => app.auth.toMe(user),
  });

  route(f, app, {
    method: 'POST',
    path: '/auth/change-password',
    summary: 'Change own password (ends all other sessions)',
    tag,
    access: 'signed_in',
    body: changePasswordBody,
    handler: async ({ user, body }) => {
      await app.auth.changePassword(user, body.current_password, body.new_password);
    },
  });
}
