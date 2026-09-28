import type { FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ApiError, badRequest } from './errors';

export interface UploadedFile {
  path: string;
  filename: string;
  mimetype: string;
  size: number;
  cleanup: () => Promise<void>;
}

/**
 * Streams a multipart request: the single `file` part goes to a temp file (never buffered in memory),
 * text parts become `fields`. The temp file is removed by the caller via cleanup().
 */
export async function readMultipart(req: FastifyRequest, maxBytes: number): Promise<{ fields: Record<string, string>; file: UploadedFile | null }> {
  if (!req.isMultipart()) throw badRequest('expected multipart/form-data');
  const fields: Record<string, string> = {};
  let file: UploadedFile | null = null;
  try {
    for await (const part of req.parts({ limits: { fileSize: maxBytes, files: 1, fields: 30, fieldSize: 64 * 1024 } })) {
      if (part.type === 'file') {
        if (part.fieldname !== 'file' || file) {
          part.file.resume();
          throw badRequest('exactly one file is allowed, in the field "file"');
        }
        const path = join(tmpdir(), `pms-upload-${randomUUID()}`);
        await pipeline(part.file, createWriteStream(path, { flags: 'wx' }));
        if (part.file.truncated) {
          await fs.unlink(path).catch(() => undefined);
          throw new ApiError(413, 'payload_too_large', `file exceeds ${Math.round(maxBytes / 1024 / 1024)} MB`);
        }
        const { size } = await fs.stat(path);
        file = {
          path,
          filename: part.filename || 'file',
          mimetype: part.mimetype || 'application/octet-stream',
          size,
          cleanup: () => fs.unlink(path).catch(() => undefined),
        };
      } else {
        fields[part.fieldname] = String(part.value ?? '');
      }
    }
  } catch (e) {
    await file?.cleanup();
    throw e;
  }
  return { fields, file };
}
