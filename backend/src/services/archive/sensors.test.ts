import { randomBytes } from 'node:crypto';
import { deflateRawSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { downsample, imuPreview, parseImuChunk, parseLidarChunk, readNpz, SensorFormatError } from './sensors';

/** One .npy (format 1.0) like numpy writes it. */
function npy(dtype: '<f8' | '<i8' | '<f4', shape: number[], data: Buffer): Buffer {
  const shapeText = shape.length === 1 ? `(${shape[0]},)` : `(${shape.join(', ')})`;
  let header = `{'descr': '${dtype}', 'fortran_order': False, 'shape': ${shapeText}, }`;
  header += ' '.repeat((64 - ((10 + header.length + 1) % 64)) % 64) + '\n';
  const head = Buffer.alloc(10);
  head[0] = 0x93;
  head.write('NUMPY', 1, 'latin1');
  head[6] = 1;
  head.writeUInt16LE(header.length, 8);
  return Buffer.concat([head, Buffer.from(header, 'latin1'), data]);
}

/** Minimal ZIP writer (deflate, like np.savez_compressed). */
function zip(entries: Record<string, Buffer>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, body] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name);
    const comp = deflateRawSync(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, comp);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

function lidarNpz(scans: number, pointsPerScan: number): Buffer {
  const t = Buffer.alloc(scans * 8);
  const offsets = Buffer.alloc((scans + 1) * 8);
  const points = Buffer.alloc(scans * pointsPerScan * 3 * 4);
  for (let s = 0; s < scans; s++) {
    t.writeDoubleLE(1790600753 + s * 0.1, s * 8);
    offsets.writeBigInt64LE(BigInt(s * pointsPerScan), s * 8);
    for (let p = 0; p < pointsPerScan; p++) {
      const k = (s * pointsPerScan + p) * 3 * 4;
      points.writeFloatLE((p * 360) / pointsPerScan, k);
      points.writeFloatLE(p === 0 ? 0 : 2 + (p % 10) / 10, k + 4); // first point: no return
      points.writeFloatLE(47, k + 8);
    }
  }
  offsets.writeBigInt64LE(BigInt(scans * pointsPerScan), scans * 8);
  return zip({
    't.npy': npy('<f8', [scans], t),
    'offsets.npy': npy('<i8', [scans + 1], offsets),
    'points.npy': npy('<f4', [scans * pointsPerScan, 3], points),
  });
}

describe('LiDAR .npz preview', () => {
  it('decodes cloud_sync chunks: scans, offsets, points', () => {
    const r = parseLidarChunk(lidarNpz(50, 400));
    expect(r.scans_total).toBe(50);
    expect(r.points_total).toBe(20000);
    expect(r.scans.length).toBeLessThanOrEqual(24);
    expect(r.scans[0].t_ms).toBe(1790600753000);
    // zero-range returns are dropped
    expect(r.scans[0].points.every(([, range]) => range > 0)).toBe(true);
    expect(r.max_range_m).toBeCloseTo(2.9, 1);
  });
  it('rejects random bytes (the simulator writes those) with a readable error', () => {
    expect(() => parseLidarChunk(randomBytes(65536))).toThrow(SensorFormatError);
  });
  it('rejects an .npz without the expected arrays', () => {
    const other = zip({ 'x.npy': npy('<f8', [1], Buffer.alloc(8)) });
    expect(Object.keys(readNpz(other))).toEqual(['x']);
    expect(() => parseLidarChunk(other)).toThrow(/missing t \/ offsets \/ points/);
  });
});

describe('IMU .csv.gz preview', () => {
  const csv = ['t_unix,ax,ay,az,gx,gy,gz,mx,my,mz,roll,pitch,yaw,yaw_raw', '1790600753.448,0.019,0.100,9.822,0,0,6,30,0,-40,0,0,140.69,140.69', '1790600753.468,0.023,0.099,9.825,0,0,6,30,0,-40,1,2,140.81,140.81'].join('\n');
  it('parses gzip and plain CSV into [t_ms, ax, ay, az, gx, gy, gz, roll, pitch, yaw]', () => {
    const rows = parseImuChunk(gzipSync(csv));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual([1790600753448, 0.019, 0.1, 9.822, 0, 0, 6, 0, 0, 140.69]);
    expect(parseImuChunk(Buffer.from(csv))).toHaveLength(2);
  });
  it('fills missing columns with null instead of failing', () => {
    const rows = parseImuChunk(gzipSync('t_unix,ax\n1,2\n'));
    expect(rows[0]).toEqual([1000, 2, null, null, null, null, null, null, null, null]);
  });
  it('rejects files without a time column or rows', () => {
    expect(() => parseImuChunk(gzipSync('a,b\n1,2\n'))).toThrow(SensorFormatError);
    expect(() => parseImuChunk(Buffer.from([0x1f, 0x8b, 1, 2, 3]))).toThrow(SensorFormatError);
  });
  it('merges chunks, reports broken ones, and keeps a consistent shape when nothing is there', async () => {
    const files: Record<string, Buffer> = { a: gzipSync(csv), b: randomBytes(100) };
    const dto = await imuPreview(
      [
        { name: 'a', size: 1 },
        { name: 'b', size: 1 },
      ],
      async (n) => files[n],
    );
    expect(dto.status).toBe('partial');
    expect(dto.chunks_read).toBe(1);
    expect(dto.chunks_failed).toHaveLength(1);
    expect(dto.rows).toHaveLength(2);

    const empty = await imuPreview([], async () => Buffer.alloc(0));
    expect(empty).toMatchObject({ status: 'unavailable', problem: 'missing', rows: [], chunks_total: 0 });

    const down = await imuPreview([{ name: 'x', size: 1 }], async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(down).toMatchObject({ status: 'unavailable', problem: 'storage_unavailable' });
  });
});

describe('downsample', () => {
  it('keeps first and last, returns at most target rows', () => {
    const out = downsample([...Array(1000).keys()], 10);
    expect(out).toHaveLength(10);
    expect(out[0]).toBe(0);
    expect(out[9]).toBe(999);
    expect(downsample([1, 2], 10)).toEqual([1, 2]);
  });
});
