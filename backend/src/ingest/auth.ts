/**
 * Connection-level authentication (docs/architecture.md). A client presents its own key;
 * the envelope's robot_id is trusted only if that client may speak for that robot:
 *   robot client → its own robot only; GCS client → the robots assigned to it.
 * Revocation takes effect within CACHE_TTL_MS.
 */
import { hashIngestKey, looksLikeIngestKey, type Db } from '../db';

export interface IngestClient {
  /** null for broker-authenticated MQTT connections (no ingest-key row). */
  id: string | null;
  name: string;
  kind: 'robot' | 'gcs';
  keyId: string;
  robotIds: Set<string>;
}

const CACHE_TTL_MS = 10_000;
const LAST_USED_WRITE_MS = 60_000;

export class IngestAuth {
  private readonly cache = new Map<string, { client: IngestClient | null; at: number }>();
  private readonly lastUsedWritten = new Map<string, number>();

  constructor(private readonly db: Db) {}

  /** Returns the client for an `Authorization: Bearer <key>` header, or null. */
  async authenticate(authorization: string | undefined): Promise<IngestClient | null> {
    const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? '');
    if (!m || !looksLikeIngestKey(m[1])) return null;
    const hash = hashIngestKey(m[1]);
    const now = Date.now();
    const cached = this.cache.get(hash);
    let client: IngestClient | null;
    if (cached && now - cached.at < CACHE_TTL_MS) {
      client = cached.client;
    } else {
      client = await this.load(hash);
      this.cache.set(hash, { client, at: now });
    }
    if (client) this.touch(client.keyId, now);
    return client;
  }

  private async load(hash: string): Promise<IngestClient | null> {
    const res = await this.db.query<{ key_id: string; id: string; name: string; kind: 'robot' | 'gcs'; robot_ids: string[] | null }>(
      `SELECT k.id AS key_id, c.id, c.name, c.kind,
              array_agg(r.robot_id) FILTER (WHERE r.robot_id IS NOT NULL) AS robot_ids
       FROM ingest_keys k
       JOIN ingest_clients c ON c.id = k.client_id
       LEFT JOIN ingest_client_robots r ON r.client_id = c.id AND r.revoked_at IS NULL
       WHERE k.key_hash = $1 AND k.revoked_at IS NULL AND c.revoked_at IS NULL
       GROUP BY k.id, c.id`,
      [hash],
    );
    const row = res.rows[0];
    if (!row) return null;
    return { id: row.id, name: row.name, kind: row.kind, keyId: row.key_id, robotIds: new Set(row.robot_ids ?? []) };
  }

  private touch(keyId: string, now: number): void {
    const last = this.lastUsedWritten.get(keyId) ?? 0;
    if (now - last < LAST_USED_WRITE_MS) return;
    this.lastUsedWritten.set(keyId, now);
    this.db.query('UPDATE ingest_keys SET last_used_at = now() WHERE id = $1', [keyId]).catch(() => undefined);
  }
}
