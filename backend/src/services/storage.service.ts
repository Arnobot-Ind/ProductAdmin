import { GetObjectCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import type { ApiConfig } from '../lib/config';
import { ApiError } from '../lib/errors';
import { ObjectNotFound, type ArchiveStorage } from './archive/storage';
import type { FileHandoff } from './file-handoff';

export interface StoredObject {
  driver: 'local' | 's3';
  bucket: string | null;
  key: string;
  versionId: string | null;
  sizeBytes: number;
  sha256: string;
}

export type Download = { kind: 'redirect'; url: string } | { kind: 'stream'; stream: Readable; size: number };

/** Folder in the archive bucket holding a copy of every local file. The archive index ignores folders that are not robots. */
const SHARED_PREFIX = 'pms-files/';

/** The largest file a server without write access can hand over through the database. */
const MAX_HANDOFF_BYTES = 20 * 1024 * 1024;

const isDenied = (e: unknown) => (e as { name?: string }).name === 'AccessDenied';

/** Safe filename for object keys and Content-Disposition. */
export function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  const cleaned = base.normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 150);
  return cleaned || 'file';
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * Spec §8: files never go in the DB. Two drivers:
 *  - local: files under STORAGE_LOCAL_DIR; every upload gets a new unique key, so nothing is ever
 *    overwritten (emulates bucket versioning for development without S3/MinIO);
 *  - s3: AWS S3 / MinIO / any S3-compatible store. Bucket versioning MUST be enabled (spec §8);
 *    the VersionId is recorded. Downloads use short-lived presigned URLs; the bucket stays private.
 *
 * Several servers can share one database (the live server and a developer's machine), but not one disk. So the local
 * driver also keeps a copy of each file in the archive bucket, and reads that copy when a file is not on this disk.
 * A server whose AWS key cannot write to the bucket leaves the file in the database's hand-off table instead; a server
 * that can write moves it to the bucket.
 */
export class StorageService {
  private readonly s3: S3Client | null;
  readonly driver: 'local' | 's3';

  constructor(
    private readonly cfg: ApiConfig,
    private readonly shared: ArchiveStorage | null = null,
    private readonly handoff: FileHandoff | null = null,
  ) {
    this.driver = cfg.storage.driver;
    const s = cfg.storage.s3;
    this.s3 =
      this.driver === 's3'
        ? new S3Client({
            region: s.region,
            endpoint: s.endpoint,
            forcePathStyle: s.forcePathStyle,
            credentials: s.accessKeyId && s.secretAccessKey ? { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey } : undefined,
          })
        : null;
  }

  private localPath(key: string): string {
    const root = resolve(this.cfg.storage.localDir);
    const full = resolve(root, key);
    if (!full.startsWith(root + sep)) throw new Error('invalid object key');
    return full;
  }

  /** `prefix` like `robots/saibya02/docs/<docId>`; a unique segment is always appended. */
  async put(tmpPath: string, prefix: string, filename: string, contentType: string | undefined): Promise<StoredObject> {
    const sha256 = await sha256File(tmpPath);
    const { size } = await fs.stat(tmpPath);
    const key = `${prefix.replace(/\/+$/, '')}/${randomUUID()}/${safeFilename(filename)}`;

    if (this.driver === 'local') {
      const dest = this.localPath(key);
      await fs.mkdir(dirname(dest), { recursive: true });
      await fs.copyFile(tmpPath, dest, fs.constants.COPYFILE_EXCL);
      // A failure fails the upload: a file only this server can read is the problem the copy exists to prevent.
      try {
        // A server that hands files over is a developer's machine: it keeps no copy of its own.
        if ((await this.copyToShared(key, dest, size, contentType)) === 'handoff') await fs.rm(dest, { force: true });
      } catch (e) {
        await fs.rm(dest, { force: true });
        const tooBig = isDenied(e) && size > MAX_HANDOFF_BYTES;
        throw new ApiError(503, 'shared_storage_unavailable', tooBig ? "Not saved: this file is over 20 MB and this server's AWS key cannot write to the shared file storage. Upload it on the live site." : 'Not saved: the shared file storage could not be reached. Try again in a moment.');
      }
      return { driver: 'local', bucket: null, key, versionId: null, sizeBytes: size, sha256 };
    }

    const upload = new Upload({
      client: this.s3!,
      params: {
        Bucket: this.cfg.storage.s3.bucket,
        Key: key,
        Body: createReadStream(tmpPath),
        ContentType: contentType || 'application/octet-stream',
        ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64'),
        Metadata: { sha256 },
      },
    });
    const out = await upload.done();
    return { driver: 's3', bucket: this.cfg.storage.s3.bucket, key, versionId: out.VersionId ?? null, sizeBytes: size, sha256 };
  }

  async download(f: { storage_driver: string; bucket: string | null; object_key: string; version_id: string | null; filename: string }): Promise<Download | null> {
    if (f.storage_driver === 'local') {
      if (this.driver !== 'local' && !this.cfg.storage.localDir) return null;
      const path = this.localPath(f.object_key);
      try {
        const st = await fs.stat(path);
        return { kind: 'stream', stream: createReadStream(path), size: st.size };
      } catch {
        return this.readShared(f.object_key);
      }
    }
    if (!this.s3 || !f.bucket) return null;
    const url = await getSignedUrl(
      this.s3,
      new GetObjectCommand({
        Bucket: f.bucket,
        Key: f.object_key,
        VersionId: f.version_id ?? undefined,
        ResponseContentDisposition: `attachment; filename="${safeFilename(f.filename)}"`,
      }),
      { expiresIn: 300 },
    );
    return { kind: 'redirect', url };
  }

  /** Puts a local file in the bucket, or in the hand-off table when this server may not write to the bucket. */
  private async copyToShared(key: string, path: string, size: number, contentType: string | null | undefined): Promise<'bucket' | 'handoff'> {
    const type = contentType || 'application/octet-stream';
    try {
      await this.shared?.put(SHARED_PREFIX + key, createReadStream(path), type);
      return 'bucket';
    } catch (e) {
      if (!isDenied(e) || !this.handoff || size > MAX_HANDOFF_BYTES) throw e;
      await this.handoff.save(key, await fs.readFile(path), type);
      return 'handoff';
    }
  }

  private async readShared(key: string): Promise<Download | null> {
    if (!this.shared) return null;
    try {
      const obj = await this.shared.get(SHARED_PREFIX + key);
      return { kind: 'stream', stream: obj.body, size: obj.length };
    } catch (e) {
      if (!(e instanceof ObjectNotFound)) throw e;
    }
    const bytes = await this.handoff?.read(key);
    return bytes ? { kind: 'stream', stream: Readable.from(bytes), size: bytes.length } : null;
  }

  /** Moves handed-over files to the bucket. A server that may not write there leaves them for one that can. */
  async moveHandedOverFiles(): Promise<number> {
    if (!this.shared || !this.handoff) return 0;
    let moved = 0;
    for (let f = await this.handoff.next(); f; f = await this.handoff.next()) {
      try {
        await this.shared.put(SHARED_PREFIX + f.object_key, Readable.from(f.bytes), f.content_type || 'application/octet-stream');
      } catch (e) {
        if (isDenied(e)) return moved;
        throw e;
      }
      await this.handoff.remove(f.object_key);
      moved += 1;
    }
    return moved;
  }

  /** Copies local files the bucket does not have yet, so files uploaded before the copy existed reach the other servers. */
  async shareLocalFiles(files: { object_key: string; content_type: string | null }[]): Promise<{ copied: number; missing: number }> {
    if (!this.shared) return { copied: 0, missing: 0 };
    const have = new Set((await this.shared.listObjects(SHARED_PREFIX)).map((o) => o.key));
    let copied = 0;
    let missing = 0;
    for (const f of files) {
      if (have.has(SHARED_PREFIX + f.object_key)) continue;
      const path = this.localPath(f.object_key);
      let size: number;
      try {
        size = (await fs.stat(path)).size;
      } catch {
        missing += 1;
        continue;
      }
      if (await this.handoff?.read(f.object_key)) continue;
      await this.copyToShared(f.object_key, path, size, f.content_type);
      copied += 1;
    }
    return { copied, missing };
  }

  /** Presigned link for an S3 path reported by a robot/GCS (`s3://bucket/key`). null if not reachable. */
  async presignExternal(s3Path: string): Promise<string | null> {
    const m = /^s3:\/\/([^/]+)\/(.+)$/.exec(s3Path);
    if (!m || !this.s3) return null;
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: m[1], Key: m[2] }), { expiresIn: 300 });
  }

  async health(): Promise<{ ok: boolean; driver: string; detail?: string }> {
    try {
      if (this.driver === 'local') {
        const root = resolve(this.cfg.storage.localDir);
        await fs.mkdir(root, { recursive: true });
        await fs.access(root, fs.constants.W_OK);
        return { ok: true, driver: 'local' };
      }
      await this.s3!.send(new HeadBucketCommand({ Bucket: this.cfg.storage.s3.bucket }));
      return { ok: true, driver: 's3' };
    } catch (e) {
      return { ok: false, driver: this.driver, detail: (e as Error).name };
    }
  }
}
