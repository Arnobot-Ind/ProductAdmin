import { DomainError, isPgError, PgErrorCode } from '../db';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

/** All API errors render as `{ error: { code, message, details? } }`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new ApiError(400, 'validation_failed', message, details);
export const unauthenticated = (message = 'sign in required') => new ApiError(401, 'unauthenticated', message);
export const forbidden = (message = 'you do not have permission to do this') => new ApiError(403, 'forbidden', message);
export const notFound = (what: string) => new ApiError(404, 'not_found', `${what} not found`);
export const conflict = (message: string, details?: unknown) => new ApiError(409, 'conflict', message, details);

export function toErrorResponse(e: unknown): [number, string, string, unknown?] {
  if (e instanceof ApiError) return [e.status, e.code, e.message, e.details];
  if (e instanceof DomainError) {
    return [e.code === 'not_found' ? 404 : e.code === 'conflict' ? 409 : 400, e.code === 'invalid' ? 'validation_failed' : e.code, e.message];
  }
  if (isPgError(e) && /^[0-9A-Z]{5}$/.test(e.code)) {
    // The DB is the last line of defence for the spec rules; turn its refusals into readable 4xx.
    switch (e.code) {
      case PgErrorCode.uniqueViolation:
        return [409, 'conflict', 'a record with the same unique value already exists', { constraint: e.constraint }];
      case PgErrorCode.exclusionViolation:
        return [409, 'conflict', 'this period overlaps an existing one', { constraint: e.constraint }];
      case PgErrorCode.foreignKeyViolation:
        return [409, 'conflict', 'a referenced record does not exist or is still in use', { constraint: e.constraint }];
      case PgErrorCode.checkViolation:
        return [400, 'validation_failed', 'value not allowed', { constraint: e.constraint }];
      case PgErrorCode.notNullViolation:
        return [400, 'validation_failed', 'a required value is missing'];
      case PgErrorCode.restrictViolation:
        return [409, 'conflict', e.message];
      case PgErrorCode.invalidTextRepresentation:
      case '22007':
      case '22008':
      case '22003':
        return [400, 'validation_failed', 'invalid value format'];
    }
  }
  const fe = e as Partial<FastifyError>;
  if (fe?.statusCode === 413 || fe?.code === 'FST_REQ_FILE_TOO_LARGE') return [413, 'payload_too_large', 'upload or request body too large'];
  if (fe?.statusCode === 429) return [429, 'rate_limited', 'too many requests'];
  if (fe?.statusCode && fe.statusCode >= 400 && fe.statusCode < 500) return [fe.statusCode, 'bad_request', fe.message ?? 'bad request'];
  return [500, 'internal_error', 'internal error'];
}

export function errorHandler(err: unknown, req: FastifyRequest, reply: FastifyReply): void {
  const [status, code, message, details] = toErrorResponse(err);
  if (status >= 500) req.log.error({ err }, 'unhandled error');
  void reply.code(status).send({ error: { code, message, ...(details !== undefined ? { details } : {}) } });
}
