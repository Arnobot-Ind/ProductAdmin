import { z } from 'zod';
import { badRequest } from './errors';

export function parseWith<T extends z.ZodType>(schema: T, value: unknown, where: string): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) throw badRequest(`invalid ${where}`, z.flattenError(r.error as z.ZodError<Record<string, unknown>>));
  return r.data;
}

export const uuidSchema = z.guid();
export const robotIdSchema = z.string().regex(/^[a-z][a-z0-9_]*[0-9]+$/, 'invalid robot id');
export const isoDate = z.iso.date(); // YYYY-MM-DD
export const isoDateTime = z.iso.datetime({ offset: true });

/** 'true'/'1' → true (query strings and multipart fields are text). */
export const optionalBool = z.preprocess((v) => (v === 'true' || v === '1' ? true : v === 'false' || v === '0' ? false : v), z.boolean()).optional();

export const pageQuery = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
};
export const includeDeleted = { include_deleted: optionalBool };

/** Trims; empty string → null. For optional form fields. */
export const nullableText = (max = 2000) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : typeof v === 'string' ? v.trim() : v), z.string().max(max).nullable());

/** Empty/absent → undefined; for optional multipart fields. */
export const optionalText = (max = 2000) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : typeof v === 'string' ? v.trim() : v), z.string().max(max).optional());

export function assertUuid(value: string, what = 'id'): string {
  if (!uuidSchema.safeParse(value).success) throw badRequest(`${what} must be a UUID`);
  return value;
}
export function assertRobotId(value: string): string {
  if (!robotIdSchema.safeParse(value).success) throw badRequest('invalid robot id');
  return value;
}

/** A source repository web link (GitHub etc.); '' clears it. */
export const repoUrlField = z
  .string()
  .trim()
  .max(500)
  .regex(/^https?:\/\/\S+$/i, 'a web link starting with https://')
  .nullable()
  .or(z.literal('').transform(() => null));
/** A git commit ID (7–64 hex characters, short or full); '' clears it. */
export const commitIdField = z
  .string()
  .trim()
  .regex(/^[0-9a-f]{7,64}$/i, 'a commit ID is 7–64 hex characters, e.g. 3f9c2ab')
  .transform((v) => v.toLowerCase())
  .nullable()
  .or(z.literal('').transform(() => null));

/** A calendar month, YYYY-MM. */
export const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'YYYY-MM');
/** The IST bounds of a YYYY-MM month: [from, to) as ISO timestamps with +05:30. */
export function istMonthBounds(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return { from: `${month}-01T00:00:00+05:30`, to: `${next}-01T00:00:00+05:30` };
}
