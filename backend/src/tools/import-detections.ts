/**
 * Imports camera detections (people, wildlife, fire / smoke, vegetation) into the `detections` index (0022). The
 * snapshot JPEGs stay where they are in the archive bucket; each row only points at its image by S3 key.
 *
 *   npm run import:detections -- --robot saibya02 --root "<prefix>/Detections/" [--dump <gcs_db_dump.sql.gz>] [--dry-run]
 *
 * --root    The robot's Detections folder in the archive bucket (ARCHIVE_S3_BUCKET), e.g.
 *           "adani-trails/Part 1 - 2026-10-04 to 10-06 2122/Detections/". Images are under <root>images/, the
 *           offline detector runs under <root>offline/<run>/(loaded|rejected)/(events|humans)/*.json.
 * --dump    The GCS database dump (pg_dump, .sql or .sql.gz): apis_humandetection + apis_environmentevent, the live
 *           detections with GPS position and mission. A local file, or an S3 key in the archive bucket.
 *
 * Sources merge on the GCS row id (offline events carry it as row_id once loaded into the GCS): the GCS gives time,
 * position and mission, the offline run adds the boxes and labels. Offline events never loaded into the GCS are added
 * too; those under rejected/ are kept as status 'rejected' (false positives: staff only). Vegetation-index readings
 * without a snapshot are not detections and are skipped, as are rows with a broken clock (before 2020).
 * Every row keeps its source id, so re-running updates in place and never duplicates.
 */
import { createReadStream, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { createPool } from '../db';
import { loadConfig } from '../lib/config';
import { ArchiveStorage } from '../services/archive/storage';
import { DETECTION_KINDS, type DetectionKind } from '../shared';

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const ROBOT = opt('robot');
const ROOT_ARG = opt('root');
const DUMP = opt('dump');
const DRY = args.includes('--dry-run');
if (!ROBOT || !ROOT_ARG) {
  console.error('usage: npm run import:detections -- --robot <robot_id> --root "<prefix>/Detections/" [--dump <gcs_db_dump.sql[.gz]>] [--dry-run]');
  process.exit(2);
}
const ROOT = ROOT_ARG.endsWith('/') ? ROOT_ARG : `${ROOT_ARG}/`;
/** Rows older than this come from a robot whose clock was not set (1970). */
const MIN_TIME = Date.parse('2020-01-01T00:00:00Z');
const KINDS = new Set<string>(DETECTION_KINDS);

interface Row {
  id: string;
  detected_at: Date;
  time_estimated: boolean;
  kind: DetectionKind;
  label: string | null;
  labels: Record<string, number> | null;
  camera: string;
  count: number;
  confidence: number | null;
  boxes: { x1: number; y1: number; x2: number; y2: number; conf: number | null }[] | null;
  lat: number | null;
  lon: number | null;
  bearing_deg: number | null;
  mission_id: string | null;
  mission_name: string | null;
  image_key: string | null;
  status: 'confirmed' | 'rejected';
  source: string;
}

// ── helpers ─────────────────────────────────────────────────────────────────
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const conf = (v: unknown): number | null => {
  const n = num(v);
  return n === null || n <= 0 || n > 1 ? null : Math.round(n * 1000) / 1000;
};
/** 32 hex digits (offline event id) → canonical UUID text. */
const toUuid = (id: string): string | null => {
  const h = id.toLowerCase().replace(/-/g, '');
  return /^[0-9a-f]{32}$/.test(h) ? `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}` : null;
};
const camera = (v: unknown): string | null => {
  const c = text(v)?.toLowerCase() ?? null;
  return c && /^[a-z0-9_]{1,32}$/.test(c) ? c : null;
};
function boxesOf(v: unknown): Row['boxes'] {
  if (!Array.isArray(v)) return null;
  const out = v
    .map((b) => ({ x1: num(b?.x1), y1: num(b?.y1), x2: num(b?.x2), y2: num(b?.y2), conf: conf(b?.conf) }))
    .filter((b): b is { x1: number; y1: number; x2: number; y2: number; conf: number | null } => b.x1 !== null && b.y1 !== null && b.x2 !== null && b.y2 !== null);
  return out.length ? out : null;
}
function labelsOf(v: unknown): Record<string, number> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v)) if (typeof n === 'number' && n > 0) out[k] = n;
  return Object.keys(out).length ? out : null;
}
const json = (v: string | null): unknown => {
  if (!v) return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
};
/** pg_dump timestamptz text ("2026-09-16 11:20:39.29954+00") → Date. */
const pgTime = (v: string | null): Date | null => {
  if (!v) return null;
  const d = new Date(v.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00'));
  return Number.isNaN(d.getTime()) ? null : d;
};

/** pg_dump COPY text format: \N = NULL, backslash escapes. */
function unescapeCopy(v: string): string | null {
  if (v === '\\N') return null;
  if (!v.includes('\\')) return v;
  return v.replace(/\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|.)/g, (_, e: string) => {
    if (e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
    if (/^[0-7]/.test(e)) return String.fromCharCode(parseInt(e, 8));
    return ({ b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' } as Record<string, string>)[e] ?? e;
  });
}

async function* copyRows(input: Readable, tables: Set<string>): AsyncGenerator<{ table: string; row: Record<string, string | null> }> {
  const lines = createInterface({ input, crlfDelay: Infinity });
  let table: string | null = null;
  let cols: string[] = [];
  for await (let line of lines) {
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (!table) {
      const m = /^COPY (\S+) \((.*)\) FROM stdin;$/.exec(line);
      if (m && tables.has(m[1])) {
        table = m[1];
        cols = m[2].split(', ').map((c) => c.replace(/^"|"$/g, ''));
      }
      continue;
    }
    if (line === '\\.') {
      table = null;
      continue;
    }
    const values = line.split('\t');
    yield { table, row: Object.fromEntries(cols.map((c, i) => [c, unescapeCopy(values[i] ?? '\\N')])) };
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const store = new ArchiveStorage(cfg.archive.s3);
  const pool = createPool();
  try {
    const robot = await pool.query('SELECT 1 FROM robots WHERE robot_id = $1', [ROBOT]);
    if (!robot.rowCount) throw new Error(`robot ${ROBOT} does not exist`);

    console.log(`listing s3://${cfg.archive.s3.bucket}/${ROOT} …`);
    const objects = await store.listObjects(ROOT);
    const keys = new Set(objects.map((o) => o.key));
    const imageKey = (image: unknown): string | null => {
      const p = text(image);
      if (!p) return null;
      const k = `${ROOT}images/${p.replace(/^\/+/, '')}`;
      return keys.has(k) ? k : null;
    };
    const rows = new Map<string, Row>();
    const skipped = { no_snapshot: 0, bad_time: 0, bad_kind: 0, bad_camera: 0, image_missing: 0 };

    // 1 · the GCS database dump: live detections with position and mission
    if (DUMP) {
      const local = existsSync(DUMP);
      const input = local ? createReadStream(DUMP) : (await store.get(DUMP)).body;
      const stream = DUMP.endsWith('.gz') ? input.pipe(createGunzip()) : input;
      const source = `gcs-dump:${basename(DUMP)}`;
      for await (const { table, row: r } of copyRows(stream, new Set(['public.apis_humandetection', 'public.apis_environmentevent']))) {
        const id = toUuid(r.id ?? '');
        const at = pgTime(r.detected_at);
        const cam = camera(r.camera);
        const human = table === 'public.apis_humandetection';
        const kind = human ? 'human' : (r.kind ?? '');
        if (!id) continue;
        if (!human && !text(r.image)) {
          skipped.no_snapshot++;
          continue;
        }
        if (!at || at.getTime() < MIN_TIME) {
          skipped.bad_time++;
          continue;
        }
        if (!KINDS.has(kind)) {
          skipped.bad_kind++;
          continue;
        }
        if (!cam) {
          skipped.bad_camera++;
          continue;
        }
        const extra = json(r.extra) as { boxes?: unknown; time_estimated?: boolean } | null;
        const key = imageKey(r.image);
        if (text(r.image) && !key) skipped.image_missing++;
        rows.set(id, {
          id,
          detected_at: at,
          time_estimated: extra?.time_estimated === true,
          kind: kind as DetectionKind,
          label: human ? null : text(r.label),
          labels: human ? null : labelsOf(json(r.labels)),
          camera: cam,
          count: Math.max(0, Math.round(num(human ? r.human_count : r.count) ?? 1)),
          confidence: conf(r.confidence),
          boxes: boxesOf(extra?.boxes),
          lat: num(r.lat),
          lon: num(r.long),
          bearing_deg: num(r.bearing),
          mission_id: text(r.mission_id),
          mission_name: text(r.mission_name),
          image_key: key,
          status: 'confirmed',
          source,
        });
      }
      console.log(`GCS dump: ${rows.size} detections`);
    }

    // 2 · offline detector runs: boxes / labels for GCS rows, plus events the GCS never got (and rejected ones)
    const eventFiles = objects.filter((o) => o.key.startsWith(`${ROOT}offline/`) && /\/(events|humans)\/[0-9a-f]{32}\.json$/.test(o.key));
    let merged = 0;
    let added = 0;
    for (let i = 0; i < eventFiles.length; i += 32) {
      const batch = await Promise.all(eventFiles.slice(i, i + 32).map(async (o) => ({ key: o.key, body: await store.readText(o.key) })));
      for (const { key, body } of batch) {
        const j = json(body) as Record<string, unknown> | null;
        if (!j) continue;
        const extra = (j.extra ?? {}) as { boxes?: unknown; time_estimated?: boolean };
        const existing = typeof j.row_id === 'string' ? rows.get(j.row_id) : undefined;
        if (existing) {
          existing.boxes ??= boxesOf(extra.boxes);
          existing.labels ??= labelsOf(j.labels);
          existing.label ??= text(j.label);
          existing.image_key ??= imageKey(j.image);
          merged++;
          continue;
        }
        const id = (typeof j.row_id === 'string' && toUuid(j.row_id)) || toUuid(String(j.id ?? ''));
        const ts = num(j.ts);
        const cam = camera(j.camera);
        const kind = String(j.kind ?? '');
        if (!id || rows.has(id)) continue;
        if (ts === null || ts * 1000 < MIN_TIME) {
          skipped.bad_time++;
          continue;
        }
        if (!KINDS.has(kind)) {
          skipped.bad_kind++;
          continue;
        }
        if (!cam) {
          skipped.bad_camera++;
          continue;
        }
        const img = imageKey(j.image);
        if (text(j.image) && !img) skipped.image_missing++;
        const run = key.slice(`${ROOT}offline/`.length).split('/')[0];
        rows.set(id, {
          id,
          detected_at: new Date(ts * 1000),
          time_estimated: extra.time_estimated === true,
          kind: kind as DetectionKind,
          label: kind === 'human' ? null : text(j.label),
          labels: kind === 'human' ? null : labelsOf(j.labels),
          camera: cam,
          count: Math.max(0, Math.round(num(j.count) ?? 1)),
          confidence: conf(j.max_conf),
          boxes: boxesOf(extra.boxes),
          lat: null,
          lon: null,
          bearing_deg: null,
          mission_id: null,
          mission_name: null,
          image_key: img,
          status: key.includes('/rejected/') ? 'rejected' : 'confirmed',
          source: `offline:${run}`,
        });
        added++;
      }
    }
    console.log(`offline runs: ${eventFiles.length} files, ${merged} merged into GCS rows, ${added} added`);

    const all = [...rows.values()];
    const byKind = all.reduce<Record<string, number>>((m, r) => ((m[`${r.kind}${r.status === 'rejected' ? ' (rejected)' : ''}`] = (m[`${r.kind}${r.status === 'rejected' ? ' (rejected)' : ''}`] ?? 0) + 1), m), {});
    console.log('detections:', all.length, byKind);
    console.log('with snapshot:', all.filter((r) => r.image_key).length, '· skipped:', skipped);
    if (DRY) {
      console.log('dry run: nothing written');
      return;
    }

    const COLS = ['id', 'detection_id', 'robot_id', 'detected_at', 'time_estimated', 'kind', 'label', 'labels', 'camera', 'count', 'confidence', 'boxes', 'lat', 'lon', 'bearing_deg', 'mission_id', 'mission_name', 'image_key', 'status', 'source'];
    const CHUNK = 500;
    for (let i = 0; i < all.length; i += CHUNK) {
      const chunk = all.slice(i, i + CHUNK);
      const params: unknown[] = [];
      const values = chunk.map((r) => {
        const v = [r.id, r.id, ROBOT, r.detected_at, r.time_estimated, r.kind, r.label, r.labels && JSON.stringify(r.labels), r.camera, r.count, r.confidence, r.boxes && JSON.stringify(r.boxes), r.lat, r.lon, r.bearing_deg, r.mission_id, r.mission_name, r.image_key, r.status, r.source];
        const base = params.length;
        params.push(...v);
        return `(${v.map((_, k) => `$${base + k + 1}`).join(', ')})`;
      });
      await pool.query(
        `INSERT INTO detections (${COLS.join(', ')}) VALUES ${values.join(', ')}
         ON CONFLICT (id) DO UPDATE SET ${COLS.filter((c) => c !== 'id' && c !== 'detection_id').map((c) => `${c} = EXCLUDED.${c}`).join(', ')}, imported_at = now()`,
        params,
      );
    }
    console.log(`✓ wrote ${all.length} detections for ${ROBOT}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
