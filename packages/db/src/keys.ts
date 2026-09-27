import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Ingest API keys: `pms_<43 base64url chars>` (32 random bytes). Shown once, stored as SHA-256. */
export const INGEST_KEY_PREFIX = 'pms_';

export function generateIngestKey(): { key: string; prefix: string; hash: string } {
  const key = INGEST_KEY_PREFIX + randomBytes(32).toString('base64url');
  return { key, prefix: key.slice(0, 10), hash: hashIngestKey(key) };
}

export function hashIngestKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

export function looksLikeIngestKey(key: string): boolean {
  return key.startsWith(INGEST_KEY_PREFIX) && key.length >= 40 && key.length <= 80;
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
