import type { Db, Queryable } from '@arnobot/db';
import type { FileDto } from '@arnobot/message-schema';
import type { FastifyReply } from 'fastify';
import type { UploadedFile } from '../lib/multipart';
import { badRequest, notFound } from '../lib/errors';
import { iso } from '../lib/sql';
import { safeFilename, StorageService } from './storage.service';

export interface FileRow {
  id: string;
  storage_driver: string;
  bucket: string | null;
  object_key: string;
  version_id: string | null;
  filename: string;
  content_type: string | null;
  size_bytes: number | null;
  sha256: string | null;
  uploaded_at: Date;
  uploaded_by_name: string | null;
}

export const FILE_COLUMNS = `f.id, f.storage_driver, f.bucket, f.object_key, f.version_id, f.filename, f.content_type,
  f.size_bytes, f.sha256, f.uploaded_at, (SELECT name FROM users WHERE id = f.uploaded_by) AS uploaded_by_name`;

export function toFileDto(f: FileRow): FileDto {
  return {
    id: f.id,
    filename: f.filename,
    content_type: f.content_type,
    size_bytes: f.size_bytes,
    sha256: f.sha256,
    storage_driver: f.storage_driver,
    uploaded_at: iso(f.uploaded_at)!,
    uploaded_by_name: f.uploaded_by_name,
  };
}

export class FilesService {
  constructor(
    private readonly db: Db,
    private readonly storage: StorageService,
  ) {}

  /** Stores an uploaded temp file and registers it in `files`. The route helper removes the temp file. */
  async store(file: UploadedFile | null, prefix: string, userId: string, tx: Queryable, expectedSha256?: string | null): Promise<string> {
    if (!file) throw badRequest('file is required (multipart field "file")');
    if (file.size === 0) throw badRequest('file is empty');
    const obj = await this.storage.put(file.path, prefix, file.filename, file.mimetype);
    if (expectedSha256 && expectedSha256.toLowerCase() !== obj.sha256) {
      throw badRequest(`sha256 mismatch: declared ${expectedSha256.toLowerCase()}, file is ${obj.sha256}`);
    }
    const res = await tx.query<{ id: string }>(
      `INSERT INTO files (storage_driver, bucket, object_key, version_id, filename, content_type, size_bytes, sha256, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [obj.driver, obj.bucket, obj.key, obj.versionId, safeFilename(file.filename), file.mimetype || null, obj.sizeBytes, obj.sha256, userId],
    );
    return res.rows[0].id;
  }

  async get(id: string, db: Queryable = this.db): Promise<FileRow> {
    const row = (await db.query<FileRow>(`SELECT ${FILE_COLUMNS} FROM files f WHERE f.id = $1 AND f.deleted_at IS NULL`, [id])).rows[0];
    if (!row) throw notFound('file');
    return row;
  }

  /** Streams a local file or redirects to a presigned S3 URL. */
  async send(fileId: string, reply: FastifyReply): Promise<FastifyReply> {
    const f = await this.get(fileId);
    const dl = await this.storage.download(f);
    if (!dl) throw notFound('file content');
    if (dl.kind === 'redirect') return reply.redirect(dl.url, 302);
    return reply
      .header('Content-Type', f.content_type || 'application/octet-stream')
      .header('Content-Length', String(dl.size))
      .header('Content-Disposition', `attachment; filename="${safeFilename(f.filename)}"`)
      .header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .send(dl.stream);
  }
}
