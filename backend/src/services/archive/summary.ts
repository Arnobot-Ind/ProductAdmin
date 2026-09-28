/**
 * Reduces an indexed session (row + per-stream file groups) to the ArchiveSessionDto the panel shows.
 * Status and durations are COMPUTED on read, never stored (same rule as robot status).
 */
import type { ArchiveSessionDto, ArchiveSessionStatus } from '../../shared';
import type { ApiConfig } from '../../lib/config';
import { iso } from '../../lib/sql';
import { sortCameras, type FileKind } from './keys';

export interface FileGroup {
  kind: FileKind;
  camera: string | null;
  sensor: string | null;
  count: number;
  bytes: number;
  /** earliest / latest chunk start, epoch ms */
  first: number | null;
  last: number | null;
  /** latest upload, epoch ms */
  uploaded: number | null;
}

export interface SessionRow {
  id: string;
  robot_id: string;
  product_code: string;
  product_name: string;
  sim: boolean;
  session_id: string;
  trip: string | null;
  manifest: Record<string, unknown> | null;
  started_at: Date | null;
  ended_at: Date | null;
  simulated: boolean;
  complete: boolean;
  groups: Array<Record<string, unknown>> | null;
  link_seen_at: Date | null;
  link_session: string | null;
}

/** SELECT producing SessionRow; append a WHERE. */
export const SESSION_SELECT = `
SELECT s.id, s.robot_id, p.code AS product_code, p.name AS product_name, s.sim, s.session_id, t.name AS trip,
       s.manifest, s.started_at, s.ended_at, s.simulated, s.complete,
       l.last_seen_at AS link_seen_at, l.last_status->'session'->>'session_id' AS link_session,
       g.groups
FROM archive_sessions s
JOIN robots r ON r.robot_id = s.robot_id
JOIN products p ON p.id = r.product_id
LEFT JOIN archive_trips t ON t.id = s.trip_id
LEFT JOIN archive_robot_link l ON l.robot_id = s.robot_id
LEFT JOIN LATERAL (
  SELECT json_agg(x) AS groups FROM (
    SELECT f.kind, f.camera, f.sensor, count(*)::int AS count, sum(f.size_bytes)::bigint AS bytes,
           min(f.chunk_start) AS first, max(f.chunk_start) AS last, max(f.uploaded_at) AS uploaded
    FROM archive_files f WHERE f.session_ref = s.id
    GROUP BY f.kind, f.camera, f.sensor
  ) x
) g ON true`;

const OPEN_STATES = /^(RECORDING|ACTIVE|RUNNING|STARTING|STARTED|UPLOADING)$/i;
const ms = (v: unknown): number | null => (v ? Date.parse(String(v)) : null);
const positive = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

function manifestTime(m: Record<string, unknown> | null, isoKey: string, unixKey: string): number | null {
  const v = m?.[isoKey];
  if (typeof v === 'string' && v) {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  const u = m?.[unixKey];
  return typeof u === 'number' && Number.isFinite(u) ? u * 1000 : null;
}

export function toGroups(raw: SessionRow['groups']): FileGroup[] {
  return (raw ?? []).map((g) => ({
    kind: g.kind as FileKind,
    camera: (g.camera as string | null) ?? null,
    sensor: (g.sensor as string | null) ?? null,
    count: Number(g.count),
    bytes: Number(g.bytes),
    first: ms(g.first),
    last: ms(g.last),
    uploaded: ms(g.uploaded),
  }));
}

/** Nominal camera segment length: session.json, else 60 s for simulated cameras, else the DVR default. */
export function videoSegmentSec(manifest: Record<string, unknown> | null, cfg: ApiConfig['archive']): number {
  return positive(manifest?.video_segment_s) ?? (manifest?.simulated === true ? 60 : cfg.videoSegmentSec);
}

export function summarize(row: SessionRow, cfg: ApiConfig['archive'], now = Date.now()): ArchiveSessionDto {
  const m = row.manifest;
  const groups = toGroups(row.groups);
  const segSec = videoSegmentSec(m, cfg);
  const chunkSec = positive(m?.chunk_s) ?? cfg.chunkSec;
  const bytes = { camera: 0, sensors: 0, meta: 0, total: 0 };
  const cameras = new Set<string>();
  let hasLidar = false;
  let hasImu = false;
  let files = 0;
  let firstChunk: number | null = null;
  let chunkEnd: number | null = null;
  let lastUpload: number | null = null;
  for (const g of groups) {
    bytes[g.kind] += g.bytes;
    bytes.total += g.bytes;
    files += g.count;
    if (g.camera) cameras.add(g.camera);
    if (g.sensor === 'lidar') hasLidar = true;
    if (g.sensor === 'imu') hasImu = true;
    if (g.first !== null && g.last !== null) {
      const len = (g.kind === 'camera' ? segSec : chunkSec) * 1000;
      firstChunk = firstChunk === null ? g.first : Math.min(firstChunk, g.first);
      chunkEnd = chunkEnd === null ? g.last + len : Math.max(chunkEnd, g.last + len);
    }
    if (g.uploaded !== null) lastUpload = lastUpload === null ? g.uploaded : Math.max(lastUpload, g.uploaded);
  }

  const endedAt = row.ended_at?.getTime() ?? manifestTime(m, 'ended_at', 'ended_unix');
  const statusText = typeof m?.status === 'string' ? m.status : '';
  const ended = endedAt !== null || (statusText !== '' && !OPEN_STATES.test(statusText));
  const window = cfg.interruptedAfterMin * 60_000;
  let status: ArchiveSessionStatus;
  if (ended) status = 'closed';
  else if (row.link_session === row.session_id && row.link_seen_at && now - row.link_seen_at.getTime() <= window) status = 'active';
  else status = lastUpload === null || now - lastUpload > window ? 'interrupted' : 'active';

  const start = row.started_at?.getTime() ?? manifestTime(m, 'started_at', 'started_unix') ?? firstChunk;
  const end = endedAt ?? chunkEnd;

  return {
    id: row.id,
    robot_id: row.robot_id,
    product_code: row.product_code,
    product_name: row.product_name,
    sim: row.sim,
    session_id: row.session_id,
    trip: row.trip ?? (typeof m?.trip === 'string' && m.trip ? m.trip : null),
    status,
    upload: row.complete ? 'complete' : m && 'video_source' in m ? 'uploading' : ended ? 'uploading' : 'unknown',
    started_at: start === null ? null : new Date(start).toISOString(),
    ended_at: end === null ? null : new Date(end).toISOString(),
    duration_s: start !== null && end !== null ? Math.max(0, Math.round((end - start) / 1000)) : null,
    video_segment_s: segSec,
    simulated: row.simulated || row.sim,
    cameras: sortCameras(cameras),
    has_lidar: hasLidar,
    has_imu: hasImu,
    file_count: files,
    bytes,
    last_upload_at: lastUpload === null ? null : iso(new Date(lastUpload)),
  };
}
