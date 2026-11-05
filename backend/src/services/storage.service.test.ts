import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import type { ApiConfig } from '../lib/config';
import { ObjectNotFound, type ArchiveStorage } from './archive/storage';
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

  it('a file nobody has is simply not found', async () => {
    expect(await server(fakeBucket()).download(row('products/x/none.jpg'))).toBeNull();
    expect(await server(null).download(row('products/x/none.jpg'))).toBeNull();
  });
});
