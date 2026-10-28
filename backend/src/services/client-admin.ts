/**
 * Client admin (0021, ported from the GCS repo's clientAdmin): a customer organization's profile, the client-app
 * features it has, and each user's own features. Robots per user stay role grants (organization or robot scope).
 *
 *   Features(U) = active user_features(U) ∩ active company_features(C), plus every always-on feature, minus retired.
 *
 * Every change is audited in the same transaction; removing a feature from an organization also removes it from
 * each of its users (one access.updated entry per user, detail.reason = 'company_feature_removed').
 */
import type { Queryable } from '../db';
import type { ClientFeatureDto, ClientProfileDto, LicenceState, SoftwareInstallDto } from '../shared';
import type { FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import type { AppContext } from '../context';
import { badRequest } from '../lib/errors';
import { iso } from '../lib/sql';
import type { AuthUser } from './auth.service';

/** Licences ending within this many days show as "expiring". */
export const LICENCE_EXPIRING_DAYS = 30;

const day = (d: Date | string | null): string | null => (d === null ? null : typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));

export async function featureCatalogue(q: Queryable): Promise<ClientFeatureDto[]> {
  return (
    await q.query<ClientFeatureDto>(
      `SELECT key, area, name, description, kind, always_on, is_default, requires, sort_order
       FROM client_features WHERE retired_at IS NULL ORDER BY sort_order`,
    )
  ).rows;
}

/**
 * Validates a requested feature set against the catalogue: known, not retired, not always-on (those are implied),
 * every `requires` inside the same set. Returns the set without always-on keys.
 */
export function checkFeatureSet(catalogue: ClientFeatureDto[], keys: string[], ceiling?: Set<string>): string[] {
  const byKey = new Map(catalogue.map((f) => [f.key, f]));
  const set = new Set(keys.filter((k) => !byKey.get(k)?.always_on));
  const unknown = [...set].filter((k) => !byKey.has(k));
  if (unknown.length) throw badRequest(`unknown feature(s): ${unknown.join(', ')}`, { unknown });
  if (ceiling) {
    const outside = [...set].filter((k) => !ceiling.has(k));
    if (outside.length) throw badRequest(`not available to this organization: ${outside.map((k) => byKey.get(k)!.name).join(', ')}`, { outside });
  }
  const missing: string[] = [];
  for (const k of set) for (const r of byKey.get(k)!.requires) if (!set.has(r) && !byKey.get(r)?.always_on) missing.push(`${byKey.get(k)!.name} needs ${byKey.get(r)?.name ?? r}`);
  if (missing.length) throw badRequest(missing.join('; '), { missing });
  return [...set].sort();
}

export async function companyFeatures(q: Queryable, companyId: string): Promise<string[]> {
  return (await q.query<{ feature_key: string }>('SELECT feature_key FROM company_features WHERE company_id = $1 AND revoked_at IS NULL ORDER BY feature_key', [companyId])).rows.map(
    (r) => r.feature_key,
  );
}

export async function userFeatures(q: Queryable, userId: string): Promise<string[]> {
  return (await q.query<{ feature_key: string }>('SELECT feature_key FROM user_features WHERE user_id = $1 AND revoked_at IS NULL ORDER BY feature_key', [userId])).rows.map(
    (r) => r.feature_key,
  );
}

/** Replaces the active rows of one owner (company or user) with `next`; returns what changed. */
async function replaceSet(tx: PoolClient, table: 'company_features' | 'user_features', ownerCol: 'company_id' | 'user_id', ownerId: string, next: string[], actorId: string) {
  const current = new Set(
    (await tx.query<{ feature_key: string }>(`SELECT feature_key FROM ${table} WHERE ${ownerCol} = $1 AND revoked_at IS NULL FOR UPDATE`, [ownerId])).rows.map((r) => r.feature_key),
  );
  const want = new Set(next);
  const added = [...want].filter((k) => !current.has(k));
  const removed = [...current].filter((k) => !want.has(k));
  if (removed.length) {
    await tx.query(`UPDATE ${table} SET revoked_at = now(), revoked_by = $3 WHERE ${ownerCol} = $1 AND feature_key = ANY($2::text[]) AND revoked_at IS NULL`, [ownerId, removed, actorId]);
  }
  for (const k of added) await tx.query(`INSERT INTO ${table} (${ownerCol}, feature_key, granted_by) VALUES ($1, $2, $3)`, [ownerId, k, actorId]);
  return { added, removed };
}

/**
 * Sets an organization's features. Keys it loses are removed from every one of its users. With `addToUsers`,
 * keys it gains are also given to every active user (the usual "everyone gets the new feature" case).
 */
export async function setCompanyFeatures(
  tx: PoolClient,
  app: AppContext,
  input: { companyId: string; keys: string[]; addToUsers: boolean; actor: AuthUser; req?: FastifyRequest },
): Promise<{ added: string[]; removed: string[] }> {
  const keys = checkFeatureSet(await featureCatalogue(tx), input.keys);
  const diff = await replaceSet(tx, 'company_features', 'company_id', input.companyId, keys, input.actor.id);
  await app.audit.record(
    { action: 'features.updated', actor: input.actor, target: { type: 'organization', id: input.companyId }, companyId: input.companyId, detail: { ...diff, features: keys }, req: input.req },
    tx,
  );
  const users = (await tx.query<{ id: string; email: string }>('SELECT id, email FROM users WHERE company_id = $1 AND deleted_at IS NULL', [input.companyId])).rows;
  for (const u of users) {
    const own = new Set(await userFeatures(tx, u.id));
    const next = new Set([...own].filter((k) => !diff.removed.includes(k)));
    if (input.addToUsers) for (const k of diff.added) next.add(k);
    const userDiff = await replaceSet(tx, 'user_features', 'user_id', u.id, [...next], input.actor.id);
    if (!userDiff.added.length && !userDiff.removed.length) continue;
    await app.audit.record(
      {
        action: 'access.updated',
        actor: input.actor,
        target: { type: 'user', id: u.id },
        companyId: input.companyId,
        detail: { user_email: u.email, features_added: userDiff.added, features_removed: userDiff.removed, reason: userDiff.removed.length ? 'company_feature_removed' : 'company_feature_added' },
        req: input.req,
      },
      tx,
    );
  }
  return diff;
}

/** Sets one customer user's features (must be inside the organization's set). Audited when something changed. */
export async function setUserFeatures(
  tx: PoolClient,
  app: AppContext,
  input: { userId: string; userEmail: string; companyId: string; keys: string[]; actor: AuthUser; req?: FastifyRequest },
): Promise<{ added: string[]; removed: string[] }> {
  const keys = checkFeatureSet(await featureCatalogue(tx), input.keys, new Set(await companyFeatures(tx, input.companyId)));
  const diff = await replaceSet(tx, 'user_features', 'user_id', input.userId, keys, input.actor.id);
  if (diff.added.length || diff.removed.length) {
    await app.audit.record(
      {
        action: 'access.updated',
        actor: input.actor,
        target: { type: 'user', id: input.userId },
        companyId: input.companyId,
        detail: { user_email: input.userEmail, features_added: diff.added, features_removed: diff.removed },
        req: input.req,
      },
      tx,
    );
  }
  return diff;
}

/** (own ∩ organization's) ∪ always-on. */
export function effectiveFeatures(catalogue: ClientFeatureDto[], own: string[], company: string[]): string[] {
  const c = new Set(company);
  return catalogue.filter((f) => f.always_on || (own.includes(f.key) && c.has(f.key))).map((f) => f.key);
}

export async function clientProfile(q: Queryable, companyId: string): Promise<ClientProfileDto> {
  const r = (
    await q.query(
      `SELECT p.*, u.id AS am_id, u.name AS am_name, u.email AS am_email
       FROM client_profiles p LEFT JOIN users u ON u.id = p.account_manager_id WHERE p.company_id = $1`,
      [companyId],
    )
  ).rows[0];
  if (!r) {
    return {
      company_id: companyId,
      client_code: null,
      status: 'active',
      legal_name: null,
      industry: null,
      phone: null,
      address: null,
      gstin: null,
      billing_email: null,
      account_manager: null,
      contract_start: null,
      contract_end: null,
      data_history_days: null,
      data_from: null,
      updated_at: null,
    };
  }
  return {
    company_id: companyId,
    client_code: r.client_code,
    status: r.status,
    legal_name: r.legal_name,
    industry: r.industry,
    phone: r.phone,
    address: r.address,
    gstin: r.gstin,
    billing_email: r.billing_email,
    account_manager: r.am_id ? { id: r.am_id, name: r.am_name, email: r.am_email } : null,
    contract_start: day(r.contract_start),
    contract_end: day(r.contract_end),
    data_history_days: r.data_history_days,
    data_from: day(r.data_from),
    updated_at: iso(r.updated_at),
  };
}

export function licenceState(validUntil: string | null, today = new Date()): LicenceState {
  if (!validUntil) return 'none';
  const t = today.toISOString().slice(0, 10);
  if (validUntil < t) return 'expired';
  const soon = new Date(today.getTime() + LICENCE_EXPIRING_DAYS * 86_400_000).toISOString().slice(0, 10);
  return validUntil <= soon ? 'expiring' : 'valid';
}

export const INSTALL_SELECT = `
SELECT i.id, i.company_id, i.robot_id, i.version, i.host_label, i.seats, i.installed_at::text AS installed_at,
       i.licence_valid_until::text AS licence_valid_until, i.notes, i.created_at, i.updated_at,
       s.id AS software_id, s.code AS software_code, s.name AS software_name, s.kind AS software_kind, s.latest_version
FROM software_installs i JOIN software_products s ON s.id = i.software_id`;

export function toInstall(r: Record<string, unknown>): SoftwareInstallDto {
  const latest = (r.latest_version as string | null) ?? null;
  return {
    id: r.id as string,
    company_id: r.company_id as string,
    software: { id: r.software_id as string, code: r.software_code as string, name: r.software_name as string, kind: r.software_kind as SoftwareInstallDto['software']['kind'], latest_version: latest },
    robot_id: (r.robot_id as string | null) ?? null,
    version: r.version as string,
    update_available: !!latest && latest !== r.version,
    host_label: (r.host_label as string | null) ?? null,
    seats: (r.seats as number | null) ?? null,
    installed_at: (r.installed_at as string | null) ?? null,
    licence_valid_until: (r.licence_valid_until as string | null) ?? null,
    licence_state: licenceState((r.licence_valid_until as string | null) ?? null),
    notes: (r.notes as string | null) ?? null,
    created_at: iso(r.created_at as Date)!,
    updated_at: iso(r.updated_at as Date)!,
  };
}
