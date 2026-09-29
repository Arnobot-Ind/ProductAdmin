/**
 * Archive object-key layout (written by cloud_sync on the robot) and chunk-name parsing. Pure functions.
 *
 *   <robot_id>/sessions/<session_id>/          real sessions
 *   <robot_id>/sim/sessions/<session_id>/      bench simulations
 *     session.json                             metadata; status / ended_at set when the session ends
 *     upload_log.csv                           every upload of the session (written at the end)
 *     _COMPLETE.json                           uploaded LAST: every file of the session is stored
 *     video/<cam>/<YYYYMMDD_HHMMSS>.ts         camera segments (600 s real, 60 s simulated)
 *     sensors/lidar/<YYYYMMDD_HHMMSS>.npz      LiDAR scans
 *     sensors/imu/<YYYYMMDD_HHMMSS>.csv.gz     IMU samples
 *     sensors/gps/<YYYYMMDD_HHMMSS>.csv.gz     GNSS fixes (RTK)
 *     sensors/encoder/<YYYYMMDD_HHMMSS>.csv.gz wheel encoders (rpm, odometry)
 */

export type FileKind = 'camera' | 'sensors' | 'meta';
export type SensorKind = 'lidar' | 'imu' | 'gps' | 'encoder';
export const SENSOR_KINDS: readonly SensorKind[] = ['lidar', 'imu', 'gps', 'encoder'];

export const SESSION_FILE = 'session.json';
export const COMPLETE_FILE = '_COMPLETE.json';
export const UPLOAD_LOG_FILE = 'upload_log.csv';
/** The only non-data files a robot may upload. */
export const META_FILES = new Set([SESSION_FILE, COMPLETE_FILE, UPLOAD_LOG_FILE]);

export interface SessionKey {
  robotId: string;
  sim: boolean;
  sessionId: string;
  /** Path inside the session folder, e.g. video/cam1/20260924_134701.ts */
  name: string;
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,200}$/;

/** "saibya02/sim/sessions/<id>/video/cam1/x.ts" → { robotId: 'saibya02', sim: true, … }; null when malformed. */
export function parseSessionKey(key: string): SessionKey | null {
  const m = /^([a-z][a-z0-9_]*[0-9]+)\/(sim\/)?sessions\/([^/]+)\/(.+)$/.exec(key);
  if (!m || !SAFE_SEGMENT.test(m[3])) return null;
  const parts = m[4].split('/');
  if (parts.some((p) => !SAFE_SEGMENT.test(p) || p === '.' || p === '..')) return null;
  return { robotId: m[1], sim: Boolean(m[2]), sessionId: m[3], name: m[4] };
}

export function sessionsPrefix(robotId: string, sim: boolean): string {
  return `${robotId}/${sim ? 'sim/' : ''}sessions/`;
}

export function sessionPrefix(robotId: string, sim: boolean, sessionId: string): string {
  return `${sessionsPrefix(robotId, sim)}${sessionId}/`;
}

/**
 * Chunk name → epoch ms. Two forms:
 *   "20260923T090000Z"  UTC
 *   "20260924_134701"   robot local time, offset by `localOffsetMin`
 */
export function parseChunkTime(stem: string, localOffsetMin = 0): number | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})[T_-]?(\d{2})(\d{2})(\d{2})(?:\.(\d{1,3}))?(Z)?/.exec(stem);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s, ms, z] = m;
  const utc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, ms ? +ms.padEnd(3, '0') : 0);
  return z ? utc : utc - localOffsetMin * 60_000;
}

export interface ClassifiedFile {
  name: string;
  kind: FileKind;
  camera: string | null;
  sensor: SensorKind | null;
  /** Chunk start, epoch ms; null for meta files or unparsable names. */
  chunkStart: number | null;
}

/** Decides what a file inside a session folder is. null = not a session file (still being written). */
export function classify(name: string, localOffsetMin = 0): ClassifiedFile | null {
  if (!name || name.endsWith('/')) return null;
  const parts = name.split('/');
  const base = parts[parts.length - 1];
  if (base.endsWith('.part') || base.endsWith('.tmp')) return null;
  const stem = base.replace(/\..*$/, '');
  let kind: FileKind = 'meta';
  let camera: string | null = null;
  let sensor: SensorKind | null = null;
  if (parts.length === 3 && parts[0] === 'video' && base.endsWith('.ts')) {
    kind = 'camera';
    camera = parts[1];
  } else if (parts.length === 3 && parts[0] === 'sensors' && parts[1] === 'lidar' && base.endsWith('.npz')) {
    kind = 'sensors';
    sensor = 'lidar';
  } else if (parts.length === 3 && parts[0] === 'sensors' && (parts[1] === 'imu' || parts[1] === 'gps' || parts[1] === 'encoder') && /\.csv(\.gz)?$/.test(base)) {
    kind = 'sensors';
    sensor = parts[1];
  }
  return { name, kind, camera, sensor, chunkStart: kind === 'meta' ? null : (parseChunkTime(stem, localOffsetMin) ?? null) };
}

/** Content-Type for a session file, from its extension. */
export function contentTypeFor(name: string): string {
  if (name.endsWith('.ts')) return 'video/mp2t';
  if (name.endsWith('.mp4')) return 'video/mp4';
  if (name.endsWith('.json')) return 'application/json';
  if (name.endsWith('.csv')) return 'text/csv';
  if (name.endsWith('.gz')) return 'application/gzip';
  return 'application/octet-stream';
}

/** cam1, cam2, … cam10 in numeric order; other names alphabetically after them. */
export function sortCameras(cams: Iterable<string>): string[] {
  const num = (c: string) => (/^cam(\d+)$/.exec(c) ? Number(c.slice(3)) : Infinity);
  return [...cams].sort((a, b) => num(a) - num(b) || a.localeCompare(b));
}

/** Camera names are path segments: only safe characters. */
export const isCameraName = (c: string) => /^[A-Za-z0-9_-]{1,50}$/.test(c);
