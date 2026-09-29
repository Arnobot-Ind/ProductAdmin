import { hashPassword, passwordProblem, verifyPassword, type Db } from '../db';
import type { GrantDto, InviteInfoDto, MeDto, OrganizationKind, ScopeType } from '../shared';
import { createHmac, randomBytes } from 'node:crypto';
import { ApiError, badRequest } from '../lib/errors';

export interface UserGrant {
  id: string;
  roleKey: string;
  roleName: string;
  scopeType: ScopeType;
  scopeId: string | null;
  permissions: Set<string>;
  createdAt: Date;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  sessionId: string;
  /** Home organization (users.company_id). */
  companyId: string;
  companyName: string;
  companyKind: OrganizationKind;
  /** Temporary password: every route except sign-out / me / change-password answers 403 until changed. */
  mustChangePassword: boolean;
  grants: UserGrant[];
}

/** Invitation links are valid this long. */
export const INVITE_TTL_HOURS = 72;

export const SESSION_COOKIE = 'pms_session';

const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;
const TOUCH_MS = 60_000;

/**
 * Opaque server-side sessions. The cookie holds 32 random bytes; the DB stores only
 * HMAC-SHA256(SESSION_SECRET, token), so a database leak does not yield usable sessions.
 * Sessions are revocable (logout, password change, user disabled) — unlike stateless JWTs.
 */
export class AuthService {
  private readonly failures = new Map<string, { count: number; lockedUntil: number }>();
  private dummyHash: Promise<string> | null = null;

  constructor(
    private readonly db: Db,
    private readonly sessionSecret: string,
    private readonly sessionTtlHours: number,
  ) {}

  /** HMAC of a session or invitation token (only the HMAC is ever stored). */
  tokenHash(token: string): string {
    return createHmac('sha256', this.sessionSecret).update(token).digest('hex');
  }

  async login(emailRaw: string, password: string, ip: string | undefined, userAgent: string | undefined): Promise<{ token: string; expiresAt: Date; userId: string }> {
    const email = emailRaw.trim().toLowerCase();
    const throttleKey = `${email}|${ip ?? ''}`;
    const f = this.failures.get(throttleKey);
    if (f && f.lockedUntil > Date.now()) throw new ApiError(429, 'rate_limited', 'too many failed sign-in attempts; try again in 15 minutes');

    const user = (
      await this.db.query<{ id: string; password_hash: string | null; is_active: boolean }>(
        'SELECT id, password_hash, is_active FROM users WHERE email = $1 AND deleted_at IS NULL',
        [email],
      )
    ).rows[0];
    // Always verify a hash so response time does not reveal whether the account exists.
    this.dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
    const ok = await verifyPassword(user?.password_hash ?? (await this.dummyHash), password);
    if (!user || !user.password_hash || !ok || !user.is_active) {
      const next = { count: (f?.count ?? 0) + 1, lockedUntil: 0 };
      if (next.count >= MAX_FAILURES) next.lockedUntil = Date.now() + LOCK_MS;
      this.failures.set(throttleKey, next);
      throw new ApiError(401, 'invalid_credentials', 'email or password is incorrect');
    }
    this.failures.delete(throttleKey);

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.sessionTtlHours * 3600_000);
    await this.db.query('INSERT INTO sessions (user_id, token_hash, expires_at, ip, user_agent) VALUES ($1, $2, $3, $4, $5)', [
      user.id,
      this.tokenHash(token),
      expiresAt,
      ip ?? null,
      userAgent?.slice(0, 300) ?? null,
    ]);
    await this.db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
    return { token, expiresAt, userId: user.id };
  }

  async logout(sessionId: string): Promise<void> {
    await this.db.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [sessionId]);
  }

  /** Session token → user with grants, or null. Used by HTTP routes and the WebSocket handshake. */
  async userFromToken(token: string | undefined): Promise<AuthUser | null> {
    if (!token || token.length > 200) return null;
    const row = (
      await this.db.query<{
        session_id: string;
        last_seen_at: Date;
        id: string;
        email: string;
        name: string;
        company_id: string;
        company_name: string;
        company_kind: OrganizationKind;
        must_change_password: boolean;
      }>(
        `SELECT s.id AS session_id, s.last_seen_at, u.id, u.email, u.name, u.must_change_password,
                c.id AS company_id, c.name AS company_name, c.kind AS company_kind
         FROM sessions s JOIN users u ON u.id = s.user_id JOIN companies c ON c.id = u.company_id
         WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
           AND u.is_active AND u.deleted_at IS NULL`,
        [this.tokenHash(token)],
      )
    ).rows[0];
    if (!row) return null;
    if (Date.now() - row.last_seen_at.getTime() > TOUCH_MS) {
      void this.db.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [row.session_id]).catch(() => undefined);
    }
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      sessionId: row.session_id,
      companyId: row.company_id,
      companyName: row.company_name,
      companyKind: row.company_kind,
      mustChangePassword: row.must_change_password,
      grants: await this.loadGrants(row.id),
    };
  }

  async loadGrants(userId: string): Promise<UserGrant[]> {
    const rows = await this.db.query<{
      id: string;
      role_key: string;
      role_name: string;
      scope_type: ScopeType;
      scope_id: string | null;
      created_at: Date;
      perms: string[] | null;
    }>(
      `SELECT g.id, r.key AS role_key, r.name AS role_name, g.scope_type, g.scope_id, g.created_at,
              array_agg(p.key) FILTER (WHERE p.key IS NOT NULL) AS perms
       FROM role_grants g
       JOIN roles r ON r.id = g.role_id
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
       LEFT JOIN permissions p ON p.id = rp.permission_id
       WHERE g.user_id = $1 AND g.revoked_at IS NULL
       GROUP BY g.id, r.key, r.name`,
      [userId],
    );
    return rows.rows.map((g) => ({
      id: g.id,
      roleKey: g.role_key,
      roleName: g.role_name,
      scopeType: g.scope_type,
      scopeId: g.scope_id,
      permissions: new Set(g.perms ?? []),
      createdAt: g.created_at,
    }));
  }

  toMe(user: AuthUser): MeDto {
    const platform = new Set<string>();
    const anywhere = new Set<string>();
    for (const g of user.grants) {
      for (const p of g.permissions) {
        anywhere.add(p);
        if (g.scopeType === 'platform') platform.add(p);
      }
    }
    const grants: GrantDto[] = user.grants.map((g) => ({
      id: g.id,
      role_key: g.roleKey,
      role_name: g.roleName,
      scope_type: g.scopeType,
      scope_id: g.scopeId,
      created_at: g.createdAt.toISOString(),
      revoked_at: null,
    }));
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      organization: { id: user.companyId, name: user.companyName, kind: user.companyKind },
      permissions: [...platform].sort(),
      scoped_permissions: [...anywhere].sort(),
      must_change_password: user.mustChangePassword,
      grants,
    };
  }

  async changePassword(user: AuthUser, current: string, next: string): Promise<void> {
    const row = (await this.db.query<{ password_hash: string | null }>('SELECT password_hash FROM users WHERE id = $1', [user.id])).rows[0];
    if (!row?.password_hash || !(await verifyPassword(row.password_hash, current))) throw new ApiError(400, 'invalid_credentials', 'current password is incorrect');
    const problem = passwordProblem(next);
    if (problem) throw badRequest(problem);
    if (current === next) throw badRequest('the new password must be different from the current one');
    await this.db.query('UPDATE users SET password_hash = $2, must_change_password = false, password_changed_at = now() WHERE id = $1', [
      user.id,
      await hashPassword(next),
    ]);
    // End every other session of this user.
    await this.db.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL', [user.id, user.sessionId]);
  }

  // ── invitations ───────────────────────────────────────────────────────────

  /** New one-time invitation token: the raw token goes into the link (shown once), its HMAC into the DB. */
  newInvite(): { token: string; hash: string; expiresAt: Date } {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: this.tokenHash(token), expiresAt: new Date(Date.now() + INVITE_TTL_HOURS * 3600_000) };
  }

  private async inviteRow(token: string) {
    if (!token || token.length > 200) return null;
    const row = (
      await this.db.query<{ id: string; email: string; name: string; organization: string; invite_expires_at: Date }>(
        `SELECT u.id, u.email, u.name, c.name AS organization, u.invite_expires_at
         FROM users u JOIN companies c ON c.id = u.company_id
         WHERE u.invite_token_hash = $1 AND u.deleted_at IS NULL AND u.is_active AND u.invite_expires_at > now()`,
        [this.tokenHash(token)],
      )
    ).rows[0];
    return row ?? null;
  }

  async inviteInfo(token: string): Promise<InviteInfoDto | null> {
    const r = await this.inviteRow(token);
    return r ? { email: r.email, name: r.name, organization: r.organization, expires_at: r.invite_expires_at.toISOString() } : null;
  }

  /** Sets the invited user's password and consumes the token (single use). */
  async acceptInvite(token: string, password: string): Promise<{ id: string; email: string }> {
    const r = await this.inviteRow(token);
    if (!r) throw new ApiError(410, 'invite_invalid', 'this invitation link is invalid, already used or expired; ask your administrator for a new one');
    const problem = passwordProblem(password);
    if (problem) throw badRequest(problem);
    const res = await this.db.query(
      `UPDATE users SET password_hash = $2, invite_token_hash = NULL, invite_expires_at = NULL, must_change_password = false, password_changed_at = now()
       WHERE id = $1 AND invite_token_hash = $3`,
      [r.id, await hashPassword(password), this.tokenHash(token)],
    );
    if (!res.rowCount) throw new ApiError(410, 'invite_invalid', 'this invitation link was already used');
    return { id: r.id, email: r.email };
  }
}
