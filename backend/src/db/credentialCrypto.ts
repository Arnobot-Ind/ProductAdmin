/**
 * Envelope for robot_credentials (spec §10, rule 11): AES-256-GCM, random 12-byte IV per secret,
 * master key held OUTSIDE the database (env CREDENTIAL_ENCRYPTION_KEY, or a KMS later).
 * key_version lets the key rotate: old rows stay decryptable via CREDENTIAL_ENCRYPTION_OLD_KEYS.
 * The AAD binds a ciphertext to its robot + kind + slot, so rows cannot be swapped between robots.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface EncryptedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyVersion: number;
}

export interface CredentialAad {
  robotId: string;
  kind: string;
  slot: number | null;
}

function parseKey(b64: string, label: string): Buffer {
  const key = Buffer.from(b64.trim(), 'base64');
  if (key.length !== 32) throw new Error(`${label} must be 32 bytes, base64-encoded (got ${key.length} bytes)`);
  return key;
}

export class CredentialCipher {
  private readonly keys = new Map<number, Buffer>();
  readonly currentVersion: number;

  constructor(currentKeyB64: string | undefined, currentVersion = 1, oldKeys = '') {
    if (!currentKeyB64) throw new Error('CREDENTIAL_ENCRYPTION_KEY is not set');
    this.currentVersion = currentVersion;
    this.keys.set(currentVersion, parseKey(currentKeyB64, 'CREDENTIAL_ENCRYPTION_KEY'));
    for (const part of oldKeys.split(',').map((s) => s.trim()).filter(Boolean)) {
      const idx = part.indexOf(':');
      const version = Number(part.slice(0, idx));
      if (!Number.isInteger(version) || version <= 0) throw new Error('CREDENTIAL_ENCRYPTION_OLD_KEYS entries must be "<version>:<base64>"');
      if (version !== currentVersion) this.keys.set(version, parseKey(part.slice(idx + 1), `old key v${version}`));
    }
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): CredentialCipher {
    return new CredentialCipher(env.CREDENTIAL_ENCRYPTION_KEY, Number(env.CREDENTIAL_KEY_VERSION || 1), env.CREDENTIAL_ENCRYPTION_OLD_KEYS || '');
  }

  private static aad(a: CredentialAad): Buffer {
    return Buffer.from(`pms-cred|${a.robotId}|${a.kind}|${a.slot ?? 0}`, 'utf8');
  }

  encrypt(plaintext: string, aad: CredentialAad): EncryptedSecret {
    const key = this.keys.get(this.currentVersion)!;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(CredentialCipher.aad(aad));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return { ciphertext, iv, authTag: cipher.getAuthTag(), keyVersion: this.currentVersion };
  }

  decrypt(secret: EncryptedSecret, aad: CredentialAad): string {
    const key = this.keys.get(secret.keyVersion);
    if (!key) throw new Error(`No key available for credential key_version ${secret.keyVersion}`);
    const decipher = createDecipheriv('aes-256-gcm', key, secret.iv);
    decipher.setAAD(CredentialCipher.aad(aad));
    decipher.setAuthTag(secret.authTag);
    return Buffer.concat([decipher.update(secret.ciphertext), decipher.final()]).toString('utf8');
  }
}
