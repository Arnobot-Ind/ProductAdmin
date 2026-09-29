import { createHash, randomBytes } from 'node:crypto';

/**
 * Ingest API keys: `pms_<43 base64url chars>` (32 random bytes). Shown once, stored as SHA-256.
 * Same format the backend server issues and checks.
 */
export function generateIngestKey(): { key: string; prefix: string; hash: string } {
  const key = 'pms_' + randomBytes(32).toString('base64url');
  return { key, prefix: key.slice(0, 10), hash: hashIngestKey(key) };
}

export function hashIngestKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}
