/**
 * Server-side previews of the raw sensor chunks, so the panel can SHOW LiDAR and IMU data without giving the
 * raw files away (downloading them is the restricted `data.download_restricted` permission).
 *
 *   sensors/imu/*.csv.gz   t_unix, ax, ay, az, gx, gy, gz, mx, my, mz, roll, pitch, yaw, yaw_raw
 *   sensors/lidar/*.npz    t float64[S] (unix), offsets int64[S+1], points float32[N,3] (angle_deg, range_m, quality)
 *                          scan i = points[offsets[i]:offsets[i+1]], taken at t[i]
 *
 * Anything unexpected (missing chunk, random bytes, other columns) becomes a clear `problem` for the
 * placeholder, never an exception that breaks the page.
 */
import { gunzipSync, inflateRawSync } from 'node:zlib';
import type { Readable } from 'node:stream';
import type { ImuPreviewDto, LidarPreviewDto, SensorPreviewProblem } from '../../shared';

/** Largest single chunk read into memory for a preview. */
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;
/** IMU: chunks read per preview (one per minute → about three hours) and rows returned for charts. */
const MAX_IMU_CHUNKS = 180;
const IMU_TARGET_ROWS = 1500;
/** LiDAR: scans returned per chunk and points per scan. */
const LIDAR_SCANS = 24;
const LIDAR_POINTS_PER_SCAN = 720;

export const IMU_COLUMNS = ['t_ms', 'ax', 'ay', 'az', 'gx', 'gy', 'gz', 'roll', 'pitch', 'yaw'] as const;

export class SensorFormatError extends Error {}

export async function readAll(body: Readable, limit = MAX_CHUNK_BYTES): Promise<Buffer> {
  const parts: Buffer[] = [];
  let n = 0;
  for await (const chunk of body) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    n += b.length;
    if (n > limit) {
      body.destroy();
      throw new SensorFormatError(`chunk is larger than ${Math.round(limit / 1048576)} MB`);
    }
    parts.push(b);
  }
  return Buffer.concat(parts);
}

// ── IMU ───────────────────────────────────────────────────────────────────

/** Parses one IMU chunk (.csv.gz, or plain .csv) into rows of IMU_COLUMNS. */
export function parseImuChunk(raw: Buffer): (number | null)[][] {
  let text: string;
  try {
    text = (raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw).toString('utf8');
  } catch {
    throw new SensorFormatError('not a valid gzip file');
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) throw new SensorFormatError('empty file');
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const tCol = header.findIndex((h) => h === 't_unix' || h === 't' || h === 'time');
  if (tCol < 0) throw new SensorFormatError('no t_unix column');
  const idx = IMU_COLUMNS.slice(1).map((c) => header.indexOf(c));
  const rows: (number | null)[][] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',');
    const t = Number(cells[tCol]);
    if (!Number.isFinite(t)) continue;
    const row: (number | null)[] = [Math.round(t * 1000)];
    for (const j of idx) {
      const v = j >= 0 ? Number(cells[j]) : NaN;
      row.push(Number.isFinite(v) ? v : null);
    }
    rows.push(row);
  }
  if (!rows.length) throw new SensorFormatError('no readable samples');
  return rows;
}

/** Keeps every k-th row so charts get about `target` points (first and last always kept). */
export function downsample<T>(rows: T[], target: number): T[] {
  if (rows.length <= target) return rows;
  const step = rows.length / target;
  const out: T[] = [];
  for (let i = 0; i < target; i++) out.push(rows[Math.floor(i * step)]);
  out[out.length - 1] = rows[rows.length - 1];
  return out;
}

export async function imuPreview(
  chunks: { name: string; size: number }[],
  read: (name: string) => Promise<Buffer>,
): Promise<ImuPreviewDto> {
  const base = { chunks_total: chunks.length, columns: [...IMU_COLUMNS] };
  if (!chunks.length) {
    return { ...base, status: 'unavailable', problem: 'missing', message: 'No IMU data was uploaded for this recording.', chunks_read: 0, chunks_failed: [], samples_total: 0, rows: [] };
  }
  const picked = chunks.slice(0, MAX_IMU_CHUNKS);
  const failed: { name: string; error: string }[] = [];
  let storageDown = false;
  const parsed: (number | null)[][][] = [];
  // Four at a time: fast enough for an hour of one-minute chunks, gentle on the bucket.
  for (let i = 0; i < picked.length; i += 4) {
    const batch = await Promise.all(
      picked.slice(i, i + 4).map(async (c) => {
        if (c.size > MAX_CHUNK_BYTES) return { c, err: 'too large to preview' };
        try {
          return { c, rows: parseImuChunk(await read(c.name)) };
        } catch (e) {
          if (!(e instanceof SensorFormatError)) storageDown = true;
          return { c, err: e instanceof SensorFormatError ? e.message : 'could not be read from storage' };
        }
      }),
    );
    for (const b of batch) {
      if (b.rows) parsed.push(b.rows);
      else failed.push({ name: b.c.name, error: b.err! });
    }
  }
  const all = parsed.flat().sort((a, b) => (a[0] as number) - (b[0] as number));
  if (!all.length) {
    const problem: SensorPreviewProblem = storageDown ? 'storage_unavailable' : 'unreadable';
    return {
      ...base,
      status: 'unavailable',
      problem,
      message: storageDown ? 'The IMU files could not be read from the archive storage. Try again later.' : 'The IMU files were uploaded but could not be decoded.',
      chunks_read: 0,
      chunks_failed: failed,
      samples_total: 0,
      rows: [],
    };
  }
  const truncated = chunks.length > picked.length;
  const partial = failed.length > 0 || truncated;
  return {
    ...base,
    status: partial ? 'partial' : 'ok',
    problem: null,
    message: partial
      ? [failed.length ? `${failed.length} of ${picked.length} chunk(s) could not be read.` : '', truncated ? `Showing the first ${picked.length} of ${chunks.length} chunks.` : '']
          .filter(Boolean)
          .join(' ')
      : null,
    chunks_read: parsed.length,
    chunks_failed: failed,
    samples_total: all.length,
    rows: downsample(all, IMU_TARGET_ROWS),
  };
}

// ── LiDAR (.npz = ZIP of .npy) ────────────────────────────────────────────

interface NpyArray {
  dtype: '<f8' | '<i8' | '<f4';
  shape: number[];
  data: Buffer;
}

const ITEM = { '<f8': 8, '<i8': 8, '<f4': 4 } as const;

function parseNpy(b: Buffer, name: string): NpyArray {
  if (b[0] !== 0x93 || b.toString('latin1', 1, 6) !== 'NUMPY') throw new SensorFormatError(`${name}: not a .npy array`);
  const major = b[6];
  const hlen = major === 1 ? b.readUInt16LE(8) : b.readUInt32LE(8);
  const hstart = major === 1 ? 10 : 12;
  const header = b.toString('latin1', hstart, hstart + hlen);
  const descr = /'descr':\s*'([^']+)'/.exec(header)?.[1];
  const fortran = /'fortran_order':\s*(True|False)/.exec(header)?.[1];
  const shapeText = /'shape':\s*\(([^)]*)\)/.exec(header)?.[1] ?? '';
  if (descr !== '<f8' && descr !== '<i8' && descr !== '<f4') throw new SensorFormatError(`${name}: dtype ${descr} not supported`);
  if (fortran !== 'False') throw new SensorFormatError(`${name}: Fortran-order arrays not supported`);
  const shape = shapeText.split(',').map((s) => s.trim()).filter(Boolean).map(Number);
  const data = b.subarray(hstart + hlen);
  const expected = shape.reduce((a, x) => a * x, 1) * ITEM[descr];
  if (data.length !== expected) throw new SensorFormatError(`${name}: expected ${expected} data bytes, got ${data.length}`);
  return { dtype: descr, shape, data };
}

/** Every array in an .npz (np.savez / savez_compressed, ZIP64 included), by name without .npy. */
export function readNpz(zip: Buffer): Record<string, NpyArray> {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65_535); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new SensorFormatError('not an .npz (zip) file');
  let count = zip.readUInt16LE(eocd + 10);
  let cdOffset = zip.readUInt32LE(eocd + 16);
  if ((cdOffset === 0xffffffff || count === 0xffff) && eocd >= 20 && zip.readUInt32LE(eocd - 20) === 0x07064b50) {
    const z64 = Number(zip.readBigUInt64LE(eocd - 20 + 8));
    count = Number(zip.readBigUInt64LE(z64 + 32));
    cdOffset = Number(zip.readBigUInt64LE(z64 + 48));
  }
  const out: Record<string, NpyArray> = {};
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > zip.length || zip.readUInt32LE(p) !== 0x02014b50) throw new SensorFormatError('damaged zip directory');
    const method = zip.readUInt16LE(p + 10);
    let csize = zip.readUInt32LE(p + 20);
    let usize = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    let local = zip.readUInt32LE(p + 42);
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen);
    for (let e = p + 46 + nameLen; e < p + 46 + nameLen + extraLen; ) {
      const id = zip.readUInt16LE(e);
      const size = zip.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (usize === 0xffffffff) {
          usize = Number(zip.readBigUInt64LE(q));
          q += 8;
        }
        if (csize === 0xffffffff) {
          csize = Number(zip.readBigUInt64LE(q));
          q += 8;
        }
        if (local === 0xffffffff) local = Number(zip.readBigUInt64LE(q));
      }
      e += 4 + size;
    }
    p += 46 + nameLen + extraLen + commentLen;
    const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(dataStart, dataStart + csize);
    let bytes: Buffer;
    try {
      bytes = method === 0 ? raw : method === 8 ? inflateRawSync(raw) : Buffer.alloc(0);
    } catch {
      throw new SensorFormatError(`${name}: corrupt compressed data`);
    }
    if (method !== 0 && method !== 8) throw new SensorFormatError(`${name}: unsupported zip compression ${method}`);
    if (bytes.length !== usize) throw new SensorFormatError(`${name}: size mismatch`);
    out[name.replace(/\.npy$/, '')] = parseNpy(bytes, name);
  }
  return out;
}

export interface LidarChunk {
  scans_total: number;
  points_total: number;
  scans: { t_ms: number; points: [number, number][] }[];
  max_range_m: number;
}

/** Decodes one LiDAR chunk and keeps LIDAR_SCANS scans spread over it, each down-sampled. */
export function parseLidarChunk(raw: Buffer): LidarChunk {
  const z = readNpz(raw);
  const { t, offsets, points } = z;
  if (!t || !offsets || !points) throw new SensorFormatError('LiDAR chunk is missing t / offsets / points');
  if (t.dtype !== '<f8' || offsets.dtype !== '<i8' || points.dtype !== '<f4' || points.shape.length !== 2 || points.shape[1] < 2) {
    throw new SensorFormatError('LiDAR chunk has an unexpected layout');
  }
  const S = t.shape[0];
  const N = points.shape[0];
  const cols = points.shape[1];
  if (offsets.shape[0] !== S + 1) throw new SensorFormatError('LiDAR offsets do not match the scan count');
  const tv = new Float64Array(t.data.buffer.slice(t.data.byteOffset, t.data.byteOffset + t.data.length));
  const ov = new BigInt64Array(offsets.data.buffer.slice(offsets.data.byteOffset, offsets.data.byteOffset + offsets.data.length));
  const pv = new Float32Array(points.data.buffer.slice(points.data.byteOffset, points.data.byteOffset + points.data.length));

  const scans: LidarChunk['scans'] = [];
  let maxRange = 0;
  for (const i of downsample([...Array(S).keys()], LIDAR_SCANS)) {
    const a = Number(ov[i]);
    const b = Number(ov[i + 1]);
    if (!(a >= 0 && b >= a && b <= N)) continue;
    const idx = downsample([...Array(b - a).keys()].map((k) => a + k), LIDAR_POINTS_PER_SCAN);
    const pts: [number, number][] = [];
    for (const k of idx) {
      const angle = pv[k * cols];
      const range = pv[k * cols + 1];
      // range 0 = no return on RPLIDAR; skip it and anything non-finite.
      if (!Number.isFinite(angle) || !Number.isFinite(range) || range <= 0) continue;
      pts.push([Math.round(angle * 10) / 10, Math.round(range * 1000) / 1000]);
      if (range > maxRange) maxRange = range;
    }
    scans.push({ t_ms: Math.round(tv[i] * 1000), points: pts });
  }
  return { scans_total: S, points_total: N, scans, max_range_m: Math.round(maxRange * 100) / 100 };
}

export function lidarUnavailable(chunks: string[], chunk: string | null, problem: SensorPreviewProblem, message: string): LidarPreviewDto {
  return { status: 'unavailable', problem, message, chunk, chunks, scans_total: 0, points_total: 0, scans: [], max_range_m: 0 };
}

/** Small in-memory LRU of decoded previews: the bucket is read once per chunk, not once per page view. */
export class PreviewCache<T> {
  private readonly map = new Map<string, T>();
  constructor(private readonly max = 32) {}
  get(key: string): T | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: string, value: T): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }
}
