/**
 * Archive simulator: behaves like cloud_sync on a robot. Generates short test-pattern camera segments
 * (ffmpeg), IMU and LiDAR chunks and session.json, and uploads them through the real robot route
 * PUT /api/v1/archive/upload with the robot's ingest key from backend/.sim-keys.json (npm run db:seed).
 *
 *   npm run archive:sim                                   one finished session for saibya01, saibya02, ductcleaning01
 *   npm run archive:sim -- --robots saibya02 --segments 5
 *   npm run archive:sim -- --robots saibya02 --live       keeps recording in real time (Ctrl+C to stop)
 *
 * Options: --robots a,b  --segments N (default 3)  --seconds S per segment (default 20)  --cameras N (default 4)  --live
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { parseUtcOffset } from '../lib/config';

interface SimKeys {
  api_url?: string;
  ingest_url: string;
  robots: Record<string, { product: string; key: string }>;
}

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const LIVE = args.includes('--live');
const SEGMENTS = Math.max(1, Number(opt('segments', LIVE ? '1000' : '3')));
const SEG_S = Math.max(5, Number(opt('seconds', '20')));
const CAMERAS = Math.min(8, Math.max(1, Number(opt('cameras', '4'))));
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const OFFSET_MIN = parseUtcOffset(process.env.ROBOT_UTC_OFFSET || '+05:30');

// Demo robot keys written by the storage seed (storage/: npm run db:seed).
const keysPath = resolve(process.env.SIM_KEYS_FILE || resolve(__dirname, '..', '..', '..', 'storage', '.sim-keys.json'));
if (!existsSync(keysPath)) {
  console.error(`✗ ${keysPath} not found: run npm run db:seed in storage/ first (or set SIM_KEYS_FILE)`);
  process.exit(1);
}
const keys = JSON.parse(readFileSync(keysPath, 'utf8')) as SimKeys;
const API = (process.env.API_URL || keys.api_url || keys.ingest_url || 'http://localhost:4000').replace(/\/$/, '');
const robots = opt('robots', Object.keys(keys.robots).filter((r) => r !== 'altius01').join(','))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/** epoch ms → "20260924_134701" in robot local time, as cloud_sync names its chunks. */
function stem(ms: number): string {
  return new Date(ms + OFFSET_MIN * 60_000).toISOString().slice(0, 19).replace(/-|:/g, '').replace('T', '_');
}

function localIso(ms: number): string {
  const sign = OFFSET_MIN < 0 ? '-' : '+';
  const a = Math.abs(OFFSET_MIN);
  return `${new Date(ms + OFFSET_MIN * 60_000).toISOString().replace(/\.\d{3}Z$/, '')}${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

// Generated segments are temporary: written to the archive temp folder only, deleted on exit.
const tempRoot = resolve(__dirname, '..', '..', process.env.ARCHIVE_TEMP_DIR || 'tmp');
mkdirSync(tempRoot, { recursive: true });
const work = mkdtempSync(join(tempRoot, 'sim-'));
process.on('exit', () => rmSync(work, { recursive: true, force: true }));

const PATTERNS = ['testsrc2', 'smptehdbars', 'testsrc', 'rgbtestsrc', 'yuvtestsrc', 'pal100bars', 'smptebars', 'testsrc2'];
function makeSegment(camera: number, seconds: number): Buffer {
  const out = join(work, `cam${camera}.ts`);
  const r = spawnSync(
    FFMPEG,
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `${PATTERNS[(camera - 1) % PATTERNS.length]}=size=640x360:rate=15`,
      '-t', String(seconds),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '30',
      '-f', 'mpegts', out,
    ],
    { windowsHide: true },
  );
  if (r.status !== 0) throw new Error(`ffmpeg failed (${r.error?.message ?? r.stderr?.toString().trim()}). Install ffmpeg or set FFMPEG_PATH.`);
  return readFileSync(out);
}

function imuChunk(startMs: number, seconds: number): Buffer {
  const rows = ['t_unix,ax,ay,az,gx,gy,gz,mx,my,mz,roll,pitch,yaw,yaw_raw'];
  for (let i = 0; i < seconds * 50; i++) {
    const t = startMs / 1000 + i / 50;
    const yaw = ((t * 6) % 360) - 180;
    rows.push(
      [t.toFixed(3), (0.2 * Math.sin(t)).toFixed(3), (0.1 * Math.cos(t)).toFixed(3), (9.81 + 0.02 * Math.sin(7 * t)).toFixed(3), 0, 0, 6, 30, 0, -40, 0, 0, yaw.toFixed(2), yaw.toFixed(2)].join(','),
    );
  }
  return gzipSync(rows.join('\n') + '\n');
}

async function upload(robotId: string, key: string, body: Buffer): Promise<void> {
  const sha = createHash('sha256').update(body).digest('hex');
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${API}/api/v1/archive/upload`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${keys.robots[robotId].key}`,
          'X-Object-Key': key,
          'X-Content-SHA256': sha,
          'Content-Type': 'application/octet-stream',
        },
        body: new Uint8Array(body),
      });
      if (res.ok) return;
      const text = await res.text();
      if (res.status < 500 || attempt >= 3) throw new Error(`${res.status} ${text}`);
    } catch (err) {
      if (attempt >= 3) throw err;
    }
    await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
}

async function heartbeat(robotId: string, sessionId: string | null, pending: number): Promise<void> {
  await fetch(`${API}/api/v1/archive/heartbeat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${keys.robots[robotId].key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: sessionId ? { session_id: sessionId } : null, pending_files: pending, pending_bytes: pending * 4_000_000, disk_free_gb: 118.4, alerts: [] }),
  }).catch(() => undefined);
}

async function simulate(robotId: string): Promise<void> {
  if (!keys.robots[robotId]) throw new Error(`no ingest key for ${robotId} in .sim-keys.json`);
  const start = LIVE ? Date.now() : Date.now() - SEGMENTS * SEG_S * 1000 - 60_000;
  const sessionId = `${stem(start)}_${randomBytes(4).toString('hex')}`;
  const prefix = `${robotId}/sessions/${sessionId}/`;
  const manifest = (ended: number | null) => ({
    session_id: sessionId,
    robot_id: robotId,
    status: ended ? 'COMPLETED' : 'RUNNING',
    simulated: true,
    trip: `Simulator ${new Date(start).toISOString().slice(0, 10)}`,
    started_at: localIso(start),
    started_unix: start / 1000,
    ended_at: ended ? localIso(ended) : null,
    ended_unix: ended ? ended / 1000 : null,
    stop_reason: ended ? 'OPERATOR_STOP' : null,
    chunk_s: SEG_S,
    video_segment_s: SEG_S,
    video_source: 'simulator',
    streams: { video: 'video/<cam>/*.ts — test pattern', imu: 'sensors/imu/*.csv.gz', lidar: 'sensors/lidar/*.npz (random bytes)' },
  });
  const json = (v: unknown) => Buffer.from(JSON.stringify(v, null, 2));

  console.log(`▶ ${robotId}: session ${sessionId} (${LIVE ? 'live' : `${SEGMENTS} × ${SEG_S} s`}, ${CAMERAS} cameras)`);
  await upload(robotId, prefix + 'session.json', json(manifest(null)));
  await heartbeat(robotId, sessionId, 0);

  let stopping = false;
  if (LIVE) process.once('SIGINT', () => ((stopping = true), console.log('\n■ stopping after this segment…')));
  let files = 0;
  for (let i = 0; i < SEGMENTS && !stopping; i++) {
    const t = start + i * SEG_S * 1000;
    if (LIVE) {
      const wait = t + SEG_S * 1000 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    for (let c = 1; c <= CAMERAS; c++) await upload(robotId, `${prefix}video/cam${c}/${stem(t)}.ts`, makeSegment(c, SEG_S));
    await upload(robotId, `${prefix}sensors/imu/${stem(t)}.csv.gz`, imuChunk(t, SEG_S));
    await upload(robotId, `${prefix}sensors/lidar/${stem(t)}.npz`, randomBytes(64 * 1024));
    files += CAMERAS + 2;
    await heartbeat(robotId, sessionId, 0);
    process.stdout.write(`  segment ${i + 1}${LIVE ? '' : `/${SEGMENTS}`} uploaded (${files} files)\n`);
  }

  const end = LIVE ? Date.now() : start + SEGMENTS * SEG_S * 1000;
  await upload(robotId, prefix + 'session.json', json(manifest(end)));
  await upload(robotId, prefix + 'upload_log.csv', Buffer.from(`key,size\n${files} files uploaded by the simulator\n`));
  await upload(robotId, prefix + '_COMPLETE.json', json({ session_id: sessionId, files, completed_at: new Date().toISOString() }));
  await heartbeat(robotId, null, 0);
  console.log(`✓ ${robotId}: ${sessionId} complete`);
}

async function main(): Promise<void> {
  console.log(`Archive simulator → ${API}  (robots: ${robots.join(', ')})`);
  if (LIVE) for (const r of robots.slice(1)) void simulate(r).catch((e) => console.error(`✗ ${r}: ${(e as Error).message}`));
  for (const r of LIVE ? robots.slice(0, 1) : robots) await simulate(r);
}

main().catch((e) => {
  console.error(`✗ ${(e as Error).message}`);
  process.exit(1);
});
