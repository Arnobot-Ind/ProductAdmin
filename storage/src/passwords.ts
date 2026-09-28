import { hash } from '@node-rs/argon2';

// Same parameters the backend server verifies with (OWASP: argon2id, m=19 MiB, t=2, p=1).
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export function passwordProblem(password: string): string | null {
  if (password.length < 10) return 'password must be at least 10 characters';
  if (password.length > 256) return 'password is too long';
  return null;
}
