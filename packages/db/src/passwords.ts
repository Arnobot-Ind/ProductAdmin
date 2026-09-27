import { hash, verify } from '@node-rs/argon2';

// OWASP Password Storage Cheat Sheet: argon2id, m=19 MiB, t=2, p=1 (minimum recommended).
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const PASSWORD_MIN_LENGTH = 10;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

/** Minimal policy: length over complexity (NIST SP 800-63B). */
export function passwordProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  if (password.length > 256) return 'password is too long';
  return null;
}
