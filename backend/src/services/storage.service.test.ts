import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import type { ApiConfig } from '../lib/config';
import { ObjectNotFound, type ArchiveStorage } from './archive/storage';
import type { FileHandoff } from './file-handoff';
import { StorageService } from './storage.service';

/** A bucket in memory, standing in for the shared archive bucket. */
function fakeBucket() {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    put: async (key: string, body: Readable) => {
      const chunks: Buffer[] = [];
      for await (const c of body) chunks.push(c as Buffer);
      objects.set(key, Buffer.concat(chunks));
    },
    get: async (key: string) => {
      const b = objects.get(key);
      if (!b) throw new ObjectNotFound();
      return { body: Readable.from(b), length: b.length };
    },
    listObjects: async (prefix: string) => [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, size: 0, lastModified: new Date() })),
  };
}

const dirs: string[] = [];
const newDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'pms-storage-'));
  dirs.push(d);
  return d;
};
const server = (bucket: ReturnType<typeof fakeBucket> | null) => new StorageService({ storage: { driver: 'local', localDir: newDir(), s3: {} } } as unknown as ApiConfig, bucket as unknown as ArchiveStorage | null);
const tempFile = (text: string) => {
  const p = join(newDir(), 'upload.jpg');
  writeFileSync(p, text);
  return p;
};
const row = (key: string) => ({ storage_driver: 'local', bucket: null, object_key: key, version_id: null, filename: 'a.jpg' });
const read = async (s: StorageService, key: string) => {
  const dl = await s.download(row(key));
  if (dl?.kind !== 'stream') return null;
  const chunks: Buffer[] = [];
  for await (const c of dl.stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString();
};

afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

describe('local files shared between servers on one database', () => {
  it('a file uploaded on one server can be read on another, both ways', async () => {
    const bucket = fakeBucket();
    const [a, b] = [server(bucket), server(bucket)];
    const fromA = await a.put(tempFile('from a'), 'products/x/media', 'a.jpg', 'image/jpeg');
    const fromB = await b.put(tempFile('from b'), 'products/x/media', 'b.jpg', 'image/jpeg');
    expect(await read(b, fromA.key)).toBe('from a');
    expect(await read(a, fromB.key)).toBe('from b');
    expect(await read(a, fromA.key)).toBe('from a');
  });

  it('copies older files only once and reports those on another server', async () => {
    const bucket = fakeBucket();
    const a = server(null);
    const old = await a.put(tempFile('old'), 'products/x/media', 'old.jpg', 'image/jpeg');
    const sharing = new StorageService({ storage: { driver: 'local', localDir: (a as unknown as { cfg: ApiConfig }).cfg.storage.localDir, s3: {} } } as unknown as ApiConfig, bucket as unknown as ArchiveStorage);
    const files = [{ object_key: old.key, content_type: 'image/jpeg' }, { object_key: 'products/x/media/elsewhere/b.jpg', content_type: null }];
    expect(await sharing.shareLocalFiles(files)).toEqual({ copied: 1, missing: 1 });
    expect(await sharing.shareLocalFiles(files)).toEqual({ copied: 0, missing: 1 });
    expect(await read(server(bucket), old.key)).toBe('old');
  });

  it('a failed shared copy fails the upload with a clear message and keeps nothing', async () => {
    const bucket = fakeBucket();
    bucket.put = async () => {
      throw Object.assign(new Error('denied'), { name: 'AccessDenied' });
    };
    const dir = newDir();
    const s = new StorageService({ storage: { driver: 'local', localDir: dir, s3: {} } } as unknown as ApiConfig, bucket as unknown as ArchiveStorage);
    await expect(s.put(tempFile('x'), 'products/x/media', 'a.jpg', 'image/jpeg')).rejects.toMatchObject({ status: 503, code: 'shared_storage_unavailable' });
    expect(readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('a.jpg'))).toEqual([]);
  });

  it('a server that may not write hands the file over: others read it, then a server that can write moves it', async () => {
    const bucket = fakeBucket();
    const denied = { ...bucket, put: async () => { throw Object.assign(new Error('denied'), { name: 'AccessDenied' }); } };
    const rows = new Map<string, Buffer>();
    const handoff = {
      save: async (key: string, bytes: Buffer) => void rows.set(key, bytes),
      read: async (key: string) => rows.get(key) ?? null,
      oldest: async () => [...rows].map(([object_key, bytes]) => ({ object_key, content_type: 'image/webp', bytes })),
      remove: async (key: string) => void rows.delete(key),
    } as unknown as FileHandoff;
    const make = (b: unknown) => new StorageService({ storage: { driver: 'local', localDir: newDir(), s3: {} } } as unknown as ApiConfig, b as ArchiveStorage, handoff);
    const [local, live] = [make(denied), make(bucket)];

    const up = await local.put(tempFile('photo'), 'products/x/media', 'a.webp', 'image/webp');
    expect(rows.size).toBe(1);
    expect(await read(live, up.key)).toBe('photo');
    expect(await local.moveHandedOverFiles()).toBe(0);
    expect(rows.size).toBe(1);

    expect(await live.moveHandedOverFiles()).toBe(1);
    expect(rows.size).toBe(0);
    expect(await read(live, up.key)).toBe('photo');
    expect(await read(local, up.key)).toBe('photo');
  });

  it('a file nobody has is simply not found', async () => {
    expect(await server(fakeBucket()).download(row('products/x/none.jpg'))).toBeNull();
    expect(await server(null).download(row('products/x/none.jpg'))).toBeNull();
  });
});
