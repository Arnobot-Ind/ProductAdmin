import { GetObjectCommand, HeadBucketCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import type { ApiConfig } from '../../lib/config';

export interface ObjectInfo {
  key: string;
  size: number;
  lastModified: Date;
}

export interface ObjectStream {
  body: Readable;
  /** Bytes in this response (the range length for a partial read). */
  length: number;
  /** "bytes a-b/size" when a range was read. */
  contentRange: string | null;
  lastModified: Date | null;
  etag: string | null;
}

export class ObjectNotFound extends Error {}
export class RangeNotSatisfiable extends Error {
  constructor(readonly size: number | null) {
    super('range not satisfiable');
  }
}

/** Parses a single byte range against a known size. null = no/ignored range. */
export function parseRange(range: string | undefined, size: number): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(range ?? '');
  if (!m || (!m[1] && !m[2])) return null;
  let start = m[1] ? Number(m[1]) : size - Number(m[2]);
  let end = m[1] && m[2] ? Number(m[2]) : size - 1;
  start = Math.max(0, start);
  end = Math.min(end, size - 1);
  if (start > end || start >= size) throw new RangeNotSatisfiable(size);
  return { start, end };
}

/**
 * The video archive's object store: the S3 bucket cloud_sync writes to (arnobot-saibya-data), separate from
 * the documents storage. Videos live ONLY here: the server never keeps a copy. Uploads stream straight into
 * the bucket (multipart, in memory), reads stream straight out of it with Range support, so the bucket stays
 * private and needs no CORS. Credentials from env, or the EC2 instance's IAM role when they are empty.
 * Any S3-compatible store works (MinIO for development: ARCHIVE_S3_ENDPOINT + ARCHIVE_S3_FORCE_PATH_STYLE).
 */
export class ArchiveStorage {
  readonly driver = 's3' as const;
  private readonly client: S3Client;

  constructor(private readonly s: ApiConfig['archive']['s3']) {
    this.client = new S3Client({
      region: s.region,
      endpoint: s.endpoint,
      forcePathStyle: s.forcePathStyle,
      // No SDK timeouts by default: one stalled connection would hold a request for minutes.
      requestHandler: { connectionTimeout: 3000, socketTimeout: 30_000 },
      credentials: s.accessKeyId && s.secretAccessKey ? { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey } : undefined,
    });
  }

  get location(): string {
    return `s3://${this.s.bucket} (${this.s.endpoint ?? this.s.region})`;
  }

  /** Immediate "sub-folders" under a prefix, each ending in "/". */
  async listPrefixes(prefix: string): Promise<string[]> {
    const out: string[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(new ListObjectsV2Command({ Bucket: this.s.bucket, Prefix: prefix, Delimiter: '/', ContinuationToken: token }));
      for (const p of res.CommonPrefixes ?? []) if (p.Prefix) out.push(p.Prefix);
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  /** Every object under a prefix, recursively. */
  async listObjects(prefix: string): Promise<ObjectInfo[]> {
    const out: ObjectInfo[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(new ListObjectsV2Command({ Bucket: this.s.bucket, Prefix: prefix, ContinuationToken: token }));
      for (const o of res.Contents ?? []) if (o.Key) out.push({ key: o.Key, size: o.Size ?? 0, lastModified: o.LastModified ?? new Date(0) });
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  /** Streams a body into the bucket (multipart above 5 MB, so memory stays flat and nothing touches disk). */
  async put(key: string, body: Readable, contentType: string): Promise<void> {
    await new Upload({ client: this.client, params: { Bucket: this.s.bucket, Key: key, Body: body, ContentType: contentType } }).done();
  }

  /** Reads an object, or one byte range of it ("bytes=a-b", "bytes=a-", "bytes=-n"). */
  async get(key: string, range?: string): Promise<ObjectStream> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.s.bucket, Key: key, Range: range && /^bytes=\d*-\d*$/.test(range) ? range : undefined }));
      return {
        body: res.Body as Readable,
        length: res.ContentLength ?? 0,
        contentRange: res.ContentRange ?? null,
        lastModified: res.LastModified ?? null,
        etag: res.ETag ?? null,
      };
    } catch (err) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) throw new ObjectNotFound(key);
      if (e.name === 'InvalidRange' || e.$metadata?.httpStatusCode === 416) throw new RangeNotSatisfiable(null);
      throw err;
    }
  }

  /** Object as text, or null when it does not exist. */
  async readText(key: string): Promise<string | null> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.s.bucket, Key: key }));
      return (await res.Body?.transformToString('utf-8')) ?? null;
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === 'NoSuchKey' || name === 'AccessDenied') return null;
      throw err;
    }
  }

  /** Short-lived URL ffmpeg reads the object from (MP4 export streams from S3, no local copy of the source). */
  async ffmpegInput(key: string): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.s.bucket, Key: key }), { expiresIn: 3600 });
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.s.bucket }));
      return { ok: true };
    } catch (e) {
      const err = e as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
      const text = `${err.name ?? ''} ${err.message ?? ''} ${err.$metadata?.httpStatusCode ?? ''}`;
      const hint = /credential/i.test(text)
        ? 'No AWS credentials. Set ARCHIVE_S3_ACCESS_KEY / ARCHIVE_S3_SECRET_KEY in backend/.env, or attach an IAM role on EC2.'
        : /AccessDenied|Forbidden|403/i.test(text)
          ? 'Access denied: the credentials (or IAM role) need s3:ListBucket, s3:GetObject and s3:PutObject on the bucket.'
          : /NotFound|NoSuchBucket|404/i.test(text)
            ? `Bucket "${this.s.bucket}" does not exist. Check ARCHIVE_S3_BUCKET.`
            : /ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN/i.test(text)
              ? 'The server cannot reach S3. Check the network / ARCHIVE_S3_ENDPOINT.'
              : text.trim() || 'Unexpected S3 error';
      return { ok: false, detail: hint };
    }
  }
}

export function createArchiveStorage(cfg: ApiConfig['archive']): ArchiveStorage {
  return new ArchiveStorage(cfg.s3);
}
