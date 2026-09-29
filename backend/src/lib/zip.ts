/**
 * Streaming zip writer (no dependencies). Entries are STORED, not compressed: the archive's files are video,
 * .gz and .npz, already compressed, so deflating them would only cost CPU. Each entry streams straight
 * through (CRC-32 computed on the way) and is described by a trailing data descriptor, so nothing is buffered
 * and the total size need not be known up front. ZIP64 throughout, so single files and whole dumps may exceed
 * 4 GB (Windows Explorer, macOS Archive Utility, 7-Zip, unzip and Python's zipfile all read it).
 */
import { once } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import * as zlib from 'node:zlib';

const crc32: (data: Uint8Array, value?: number) => number =
  typeof (zlib as { crc32?: unknown }).crc32 === 'function'
    ? (zlib as unknown as { crc32: (d: Uint8Array, v?: number) => number }).crc32
    : (() => {
        // Node < 22.2: table-driven CRC-32 (IEEE).
        const table = new Uint32Array(256).map((_, n) => {
          let c = n;
          for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
          return c >>> 0;
        });
        return (d: Uint8Array, v = 0) => {
          let c = ~v >>> 0;
          for (let i = 0; i < d.length; i++) c = table[(c ^ d[i]) & 0xff] ^ (c >>> 8);
          return ~c >>> 0;
        };
      })();

const FLAGS = 0x0808; // bit 3: sizes in a data descriptor · bit 11: UTF-8 names
const VERSION = 45; // 4.5: ZIP64

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

interface Written {
  name: Buffer;
  crc: number;
  size: number;
  offset: number;
  time: number;
  date: number;
}

export class ZipWriter {
  private offset = 0;
  private readonly entries: Written[] = [];

  constructor(private readonly out: Writable) {}

  private async write(buf: Buffer): Promise<void> {
    this.offset += buf.length;
    if (!this.out.write(buf)) await once(this.out, 'drain');
  }

  /** Adds one file, streamed from `body`. Resolves when the whole entry has been written. */
  async add(name: string, body: Readable, modified = new Date()): Promise<void> {
    const nameBuf = Buffer.from(name.replace(/\\/g, '/').replace(/^\/+/, ''), 'utf8');
    const { time, date } = dosDateTime(modified);
    const offset = this.offset;

    // Local header: sizes unknown yet (0xFFFFFFFF + zeroed ZIP64 extra), real ones follow in the descriptor.
    const local = Buffer.alloc(30 + nameBuf.length + 20);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(FLAGS, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(0xffffffff, 18);
    local.writeUInt32LE(0xffffffff, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(20, 28);
    nameBuf.copy(local, 30);
    local.writeUInt16LE(0x0001, 30 + nameBuf.length);
    local.writeUInt16LE(16, 32 + nameBuf.length);
    await this.write(local);

    let crc = 0;
    let size = 0;
    for await (const chunk of body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      crc = crc32(buf, crc);
      size += buf.length;
      await this.write(buf);
    }

    const desc = Buffer.alloc(24);
    desc.writeUInt32LE(0x08074b50, 0);
    desc.writeUInt32LE(crc >>> 0, 4);
    desc.writeBigUInt64LE(BigInt(size), 8);
    desc.writeBigUInt64LE(BigInt(size), 16);
    await this.write(desc);
    this.entries.push({ name: nameBuf, crc: crc >>> 0, size, offset, time, date });
  }

  /** Writes the central directory and the ZIP64 end records, then ends the output. */
  async finish(): Promise<void> {
    const cdStart = this.offset;
    for (const e of this.entries) {
      const h = Buffer.alloc(46 + e.name.length + 28);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(VERSION, 4);
      h.writeUInt16LE(VERSION, 6);
      h.writeUInt16LE(FLAGS, 8);
      h.writeUInt16LE(0, 10);
      h.writeUInt16LE(e.time, 12);
      h.writeUInt16LE(e.date, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(0xffffffff, 20);
      h.writeUInt32LE(0xffffffff, 24);
      h.writeUInt16LE(e.name.length, 28);
      h.writeUInt16LE(28, 30);
      h.writeUInt16LE(0, 32); // comment
      h.writeUInt16LE(0, 34); // disk
      h.writeUInt16LE(0, 36); // internal attributes
      h.writeUInt32LE(0, 38); // external attributes
      h.writeUInt32LE(0xffffffff, 42);
      e.name.copy(h, 46);
      const x = 46 + e.name.length;
      h.writeUInt16LE(0x0001, x);
      h.writeUInt16LE(24, x + 2);
      h.writeBigUInt64LE(BigInt(e.size), x + 4);
      h.writeBigUInt64LE(BigInt(e.size), x + 12);
      h.writeBigUInt64LE(BigInt(e.offset), x + 20);
      await this.write(h);
    }
    const cdSize = this.offset - cdStart;
    const eocd64At = this.offset;
    const end = Buffer.alloc(56 + 20 + 22);
    end.writeUInt32LE(0x06064b50, 0);
    end.writeBigUInt64LE(44n, 4);
    end.writeUInt16LE(VERSION, 12);
    end.writeUInt16LE(VERSION, 14);
    end.writeUInt32LE(0, 16);
    end.writeUInt32LE(0, 20);
    end.writeBigUInt64LE(BigInt(this.entries.length), 24);
    end.writeBigUInt64LE(BigInt(this.entries.length), 32);
    end.writeBigUInt64LE(BigInt(cdSize), 40);
    end.writeBigUInt64LE(BigInt(cdStart), 48);
    end.writeUInt32LE(0x07064b50, 56);
    end.writeUInt32LE(0, 60);
    end.writeBigUInt64LE(BigInt(eocd64At), 64);
    end.writeUInt32LE(1, 72);
    end.writeUInt32LE(0x06054b50, 76);
    end.writeUInt16LE(0, 80);
    end.writeUInt16LE(0, 82);
    end.writeUInt16LE(Math.min(this.entries.length, 0xffff), 84);
    end.writeUInt16LE(Math.min(this.entries.length, 0xffff), 86);
    end.writeUInt32LE(0xffffffff, 88);
    end.writeUInt32LE(0xffffffff, 92);
    end.writeUInt16LE(0, 96);
    await this.write(end);
    this.out.end();
  }
}
