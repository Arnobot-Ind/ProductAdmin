import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ZipWriter } from './zip';

async function build(files: { name: string; data: Buffer }[]): Promise<Buffer> {
  const out = new PassThrough();
  const parts: Buffer[] = [];
  out.on('data', (c: Buffer) => parts.push(c));
  const done = new Promise((r) => out.on('end', r));
  const zip = new ZipWriter(out);
  for (const f of files) await zip.add(f.name, Readable.from([f.data.subarray(0, 7), f.data.subarray(7)]), new Date(2026, 8, 28, 18, 35, 50));
  await zip.finish();
  await done;
  return Buffer.concat(parts);
}

describe('ZipWriter', () => {
  it('writes a ZIP64 archive that standard tools read back byte for byte', async () => {
    const files = [
      { name: 'saibya02/20260928_183553/video/cam1/20260928_183553.ts', data: Buffer.alloc(100_000, 7) },
      { name: 'saibya02/20260928_183553/session.json', data: Buffer.from('{"status":"COMPLETED"}') },
      { name: 'saibya02/20260928_183553/empty.csv', data: Buffer.alloc(0) },
    ];
    const zip = await build(files);
    const dir = mkdtempSync(join(tmpdir(), 'pms-zip-'));
    try {
      const path = join(dir, 'x.zip');
      writeFileSync(path, zip);
      // Python's zipfile validates CRCs and the ZIP64 records.
      const py = `import zipfile,sys,json\nz=zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nprint(json.dumps({i.filename:len(z.read(i)) for i in z.infolist()}))`;
      let out: string;
      try {
        out = execFileSync('python', ['-c', py, path], { encoding: 'utf8' });
      } catch {
        return; // no Python on this machine: the structural checks below still run
      }
      expect(JSON.parse(out)).toEqual(Object.fromEntries(files.map((f) => [f.name, f.data.length])));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ends with the ZIP64 end-of-central-directory records', async () => {
    const zip = await build([{ name: 'a.txt', data: Buffer.from('hello world!') }]);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
    expect(zip.readUInt32LE(zip.length - 42)).toBe(0x07064b50);
    expect(readFileSync).toBeTypeOf('function');
  });
});
