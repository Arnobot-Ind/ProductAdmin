import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CredentialCipher } from './credentialCrypto';
import { formatSerial } from './domain';
import { generateIngestKey, hashIngestKey, looksLikeIngestKey } from './keys';

const key = () => randomBytes(32).toString('base64');
const aad = { robotId: 'saibya02', kind: 'ssh', slot: null };

describe('CredentialCipher (spec §10, rule 11)', () => {
  it('round-trips a secret', () => {
    const c = new CredentialCipher(key());
    const enc = c.encrypt('p@ss:word/with@chars', aad);
    expect(c.decrypt(enc, aad)).toBe('p@ss:word/with@chars');
  });

  it('never produces the plaintext in the ciphertext and uses a fresh IV each time', () => {
    const c = new CredentialCipher(key());
    const a = c.encrypt('same-secret', aad);
    const b = c.encrypt('same-secret', aad);
    expect(a.ciphertext.toString('utf8')).not.toContain('same-secret');
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.iv).toHaveLength(12);
    expect(a.authTag).toHaveLength(16);
  });

  it('binds the secret to its robot/kind/slot (AAD): moving a row to another robot fails', () => {
    const c = new CredentialCipher(key());
    const enc = c.encrypt('secret', aad);
    expect(() => c.decrypt(enc, { ...aad, robotId: 'saibya03' })).toThrow();
    expect(() => c.decrypt(enc, { ...aad, kind: 'omni' })).toThrow();
  });

  it('detects tampering', () => {
    const c = new CredentialCipher(key());
    const enc = c.encrypt('secret', aad);
    enc.ciphertext[0] ^= 0xff;
    expect(() => c.decrypt(enc, aad)).toThrow();
  });

  it('supports key rotation via key_version', () => {
    const k1 = key();
    const old = new CredentialCipher(k1, 1);
    const enc = old.encrypt('legacy', aad);
    const current = new CredentialCipher(key(), 2, `1:${k1}`);
    expect(current.decrypt(enc, aad)).toBe('legacy');
    expect(current.encrypt('new', aad).keyVersion).toBe(2);
  });

  it('refuses a malformed key', () => {
    expect(() => new CredentialCipher(Buffer.from('short').toString('base64'))).toThrow(/32 bytes/);
    expect(() => new CredentialCipher(undefined)).toThrow(/not set/);
  });
});

describe('ingest keys', () => {
  it('are high-entropy, prefixed, and stored only as SHA-256', () => {
    const k = generateIngestKey();
    expect(looksLikeIngestKey(k.key)).toBe(true);
    expect(k.hash).toBe(hashIngestKey(k.key));
    expect(k.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(k.key).not.toBe(generateIngestKey().key);
  });
});

describe('formatSerial (0028)', () => {
  it('shows a 13-digit serial as category-model-attachment-running-random', () => {
    expect(formatSerial('1005000000216')).toBe('1-005-000-0002-16');
    expect(formatSerial('2006001012399')).toBe('2-006-001-0123-99');
  });
  it('leaves anything else as it is', () => {
    expect(formatSerial('saibya02')).toBe('saibya02');
    expect(formatSerial('66401144')).toBe('66401144');
  });
});
