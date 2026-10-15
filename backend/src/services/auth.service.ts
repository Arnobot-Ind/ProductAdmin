import { hashPassword, passwordProblem, verifyPassword, type Db } from '../db';
import { CLIENT_SIGN_IN_STATUSES, type ClientStatus, type GrantDto, type InviteInfoDto, type MeDto, type OrganizationKind, type ScopeType } from '../shared';
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
  /** Customer users only (null for Arnobot staff): the organization's client status and what the user may use. */
  client: ClientAccess | null;
}

/** A customer user's client-app access (0021): effective features and how far back their data reaches. */
export interface ClientAccess {
  status: ClientStatus;
  /** Effective features: the user's ∩ the organization's, plus every always-on feature. */
  features: Set<string>;
  /** The organization's features (the most a Manager can give a user). */
  organizationFeatures: string[];
  /** client_profiles.data_history_days: data older than this is hidden (null = all history). */
  dataHistoryDays: number | null;
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
    // A suspended or ended client (or a deleted customer organization) cannot sign in. The password was right,
    // so saying why reveals nothing the caller did not already know.
    const blocked = await this.clientBlock(user.id);
    if (blocked) throw new ApiError(403, 'client_inactive', blocked);

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
        company_deleted: boolean;
        client_status: ClientStatus;
        data_history_days: number | null;
      }>(
        `SELECT s.id AS session_id, s.last_seen_at, u.id, u.email, u.name, u.must_change_password,
                c.id AS company_id, c.name AS company_name, c.kind AS company_kind, c.deleted_at IS NOT NULL AS company_deleted,
                coalesce(cp.status, 'active') AS client_status, cp.data_history_days
         FROM sessions s JOIN users u ON u.id = s.user_id JOIN companies c ON c.id = u.company_id
         LEFT JOIN client_profiles cp ON cp.company_id = c.id
         WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
           AND u.is_active AND u.deleted_at IS NULL`,
        [this.tokenHash(token)],
      )
    ).rows[0];
    if (!row) return null;
    const customer = row.company_kind === 'customer';
    // Suspending or ending a client (or deleting the organization) cuts its users' sessions at once.
    if (customer && (row.company_deleted || !CLIENT_SIGN_IN_STATUSES.includes(row.client_status))) return null;
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
      client: customer
        ? { status: row.client_status, features: await this.loadFeatures(row.id), organizationFeatures: await this.organizationFeatures(row.company_id), dataHistoryDays: row.data_history_days }
        : null,
    };
  }

  /** Why a customer user may not sign in (suspended or ended client, deleted organization), or null. */
  async clientBlock(userId: string): Promise<string | null> {
    const r = (
      await this.db.query<{ kind: string; name: string; deleted: boolean; status: ClientStatus }>(
        `SELECT c.kind, c.name, c.deleted_at IS NOT NULL AS deleted, coalesce(cp.status, 'active') AS status
         FROM users u JOIN companies c ON c.id = u.company_id LEFT JOIN client_profiles cp ON cp.company_id = c.id WHERE u.id = $1`,
        [userId],
      )
    ).rows[0];
    if (!r || r.kind !== 'customer') return null;
    if (r.deleted || r.status === 'ended') return `${r.name}'s access to Arnobot has ended; contact your Arnobot account manager`;
    if (r.status === 'suspended') return `${r.name}'s access to Arnobot is suspended; contact your Arnobot account manager`;
    return null;
  }

  async organizationFeatures(companyId: string): Promise<string[]> {
    const rows = await this.db.query<{ key: string }>(
      'SELECT cf.feature_key AS key FROM company_features cf JOIN client_features f ON f.key = cf.feature_key WHERE cf.company_id = $1 AND cf.revoked_at IS NULL AND f.retired_at IS NULL ORDER BY 1',
      [companyId],
    );
    return rows.rows.map((r) => r.key);
  }

  /** A customer user's effective features: (user's ∩ organization's) ∪ always-on, minus retired ones. */
  async loadFeatures(userId: string): Promise<Set<string>> {
    const rows = await this.db.query<{ key: string }>(
      `SELECT f.key FROM client_features f
       WHERE f.retired_at IS NULL AND (
         f.always_on OR (
           EXISTS (SELECT 1 FROM user_features uf WHERE uf.user_id = $1 AND uf.feature_key = f.key AND uf.revoked_at IS NULL)
           AND EXISTS (SELECT 1 FROM company_features cf JOIN users u ON u.company_id = cf.company_id
                       WHERE u.id = $1 AND cf.feature_key = f.key AND cf.revoked_at IS NULL)))`,
      [userId],
    );
    return new Set(rows.rows.map((r) => r.key));
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
      // permissions.audience (0020): 'staff' permissions never reach customer users, 'customer' ones never reach Arnobot users.
      `SELECT g.id, r.key AS role_key, r.name AS role_name, g.scope_type, g.scope_id, g.created_at,
              array_agg(p.key) FILTER (WHERE p.key IS NOT NULL) AS perms
       FROM role_grants g
       JOIN users u ON u.id = g.user_id
       JOIN companies c ON c.id = u.company_id
       JOIN roles r ON r.id = g.role_id
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
       LEFT JOIN permissions p ON p.id = rp.permission_id
         AND (p.audience = 'any' OR p.audience = CASE WHEN c.kind = 'customer' THEN 'customer' ELSE 'staff' END)
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
      client: user.client
        ? { status: user.client.status, features: [...user.client.features].sort(), organization_features: user.client.organizationFeatures, data_history_days: user.client.dataHistoryDays }
        : null,
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
