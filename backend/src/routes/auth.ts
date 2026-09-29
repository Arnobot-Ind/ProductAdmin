import type { InviteInfoDto, MeDto } from '../shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context';
import { ApiError, unauthenticated } from '../lib/errors';
import { route } from '../lib/route';
import { SESSION_COOKIE } from '../services/auth.service';

const loginBody = z.object({ email: z.string().trim().email().max(320), password: z.string().min(1).max(256) });
const changePasswordBody = z.object({ current_password: z.string().min(1).max(256), new_password: z.string().min(1).max(256) });
const inviteToken = z.string().trim().min(20).max(200);

export function authRoutes(f: FastifyInstance, app: AppContext): void {
  const tag = 'Auth';

  const startSession = async (reply: FastifyReply, token: string, expiresAt: Date): Promise<MeDto> => {
    reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, secure: app.cfg.cookieSecure, sameSite: 'lax', path: '/', expires: expiresAt });
    const user = await app.auth.userFromToken(token);
    if (!user) throw unauthenticated();
    return app.auth.toMe(user);
  };

  route(f, app, {
    method: 'POST',
    path: '/auth/login',
    summary: 'Sign in; sets the httpOnly session cookie',
    tag,
    access: 'public',
    body: loginBody,
    handler: async ({ body, req, reply }): Promise<MeDto> => {
      let session: Awaited<ReturnType<typeof app.auth.login>>;
      try {
        session = await app.auth.login(body.email, body.password, req.ip, req.headers['user-agent']);
      } catch (err) {
        const code = err instanceof ApiError ? err.code : 'error';
        app.audit.note({ action: 'auth.login_failed', outcome: 'failure', actorEmail: body.email.toLowerCase(), detail: { reason: code }, req });
        throw err;
      }
      const me = await startSession(reply, session.token, session.expiresAt);
      app.audit.note({
        action: 'auth.login',
        actor: { id: me.id, email: me.email },
        companyId: me.organization.id,
        detail: { temporary_password: me.must_change_password },
        req,
      });
      return me;
    },
  });

  route(f, app, {
    method: 'POST',
    path: '/auth/logout',
    summary: 'Sign out (revokes the session server-side)',
    tag,
    access: 'signed_in',
    allowWithTemporaryPassword: true,
    handler: async ({ user, req, reply }) => {
      await app.auth.logout(user.sessionId);
      app.audit.note({ action: 'auth.logout', actor: user, companyId: user.companyId, req });
      reply.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, sameSite: 'lax', secure: app.cfg.cookieSecure });
    },
  });

  route(f, app, {
    method: 'GET',
    path: '/auth/me',
    summary: 'Current user, organization and effective permissions',
    tag,
    access: 'signed_in',
    allowWithTemporaryPassword: true,
    handler: ({ user }): MeDto => app.auth.toMe(user),
  });

  route(f, app, {
    method: 'POST',
    path: '/auth/change-password',
    summary: 'Change own password (ends all other sessions; clears a temporary password)',
    tag,
    access: 'signed_in',
    allowWithTemporaryPassword: true,
    body: changePasswordBody,
    handler: async ({ user, body, req }) => {
      await app.auth.changePassword(user, body.current_password, body.new_password);
      app.audit.note({ action: 'auth.password_changed', actor: user, target: { type: 'user', id: user.id }, companyId: user.companyId, req });
    },
  });

  // ── invitations (public: the token in the link is the credential) ─────────
  route(f, app, {
    method: 'GET',
    path: '/auth/invite',
    summary: 'Who an invitation link is for (to show on the "set your password" page)',
    tag,
    access: 'public',
    query: z.object({ token: inviteToken }),
    handler: async ({ query }): Promise<InviteInfoDto> => {
      const info = await app.auth.inviteInfo(query.token);
      if (!info) throw new ApiError(410, 'invite_invalid', 'this invitation link is invalid, already used or expired; ask your administrator for a new one');
      return info;
    },
  });

  route(f, app, {
    method: 'POST',
    path: '/auth/invite/accept',
    summary: 'Accept an invitation: set a password (single use) and sign in',
    tag,
    access: 'public',
    body: z.object({ token: inviteToken, password: z.string().min(1).max(256) }),
    handler: async ({ body, req, reply }): Promise<MeDto> => {
      const { email } = await app.auth.acceptInvite(body.token, body.password);
      const session = await app.auth.login(email, body.password, req.ip, req.headers['user-agent']);
      const me = await startSession(reply, session.token, session.expiresAt);
      app.audit.note({ action: 'auth.invite_accepted', actor: { id: me.id, email: me.email }, target: { type: 'user', id: me.id }, companyId: me.organization.id, req });
      return me;
    },
  });
}
