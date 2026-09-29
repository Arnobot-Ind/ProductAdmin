/**
 * Video / sensor archive (merged from Saibya Archive). The object store (ArchiveStorage) holds the files;
 * Postgres (archive_* tables) is the index every admin page reads. Writes come from the robots
 * (PUT /archive/upload, POST /archive/events) and from the re-index (POST /archive/reindex).
 */
import type { PoolClient } from 'pg';
import { withTransaction, type Db } from '../../db';
import { notifyChange } from '../../ingest/notify';
import type { ApiConfig } from '../../lib/config';
import { notFound } from '../../lib/errors';
import { iso, Where } from '../../lib/sql';
import type {
  ArchiveAccessDto,
  ArchiveCameraDto,
  ArchiveFileDto,
  ArchiveReindexDto,
  ArchiveRobotLinkDto,
  ArchiveSessionDetailDto,
  ArchiveSessionDto,
  ArchiveSessionListDto,
  ArchiveSessionStatus,
  ArchiveStreamDto,
  ImuPreviewDto,
  LidarPreviewDto,
  RobotArchiveDto,
} from '../../shared';
import { classify, COMPLETE_FILE, parseSessionKey, SESSION_FILE, sessionPrefix, sessionsPrefix, sortCameras, type ClassifiedFile } from './keys';
import { Mp4Builder } from './mp4';
import { SESSION_SELECT, summarize, videoSegmentSec, type SessionRow } from './summary';
import { imuPreview, lidarUnavailable, parseLidarChunk, PreviewCache, readAll, SensorFormatError, type LidarChunk } from './sensors';
import { createArchiveStorage, ObjectNotFound, type ArchiveStorage } from './storage';

export const API_ARCHIVE_BASE = '/api/v1/archive/sessions';
const SENDING_WINDOW_MS = 2 * 60_000;
const HEARTBEAT_FRESH_MS = 5 * 60_000;

/** One stored object to index. */
export interface RecordItem {
  key: string;
  robotId: string;
  sim: boolean;
  sessionId: string;
  file: ClassifiedFile;
  size: number;
  sha256: string | null;
  /** session.json body, sent with the session.json upload. */
  manifest?: Record<string, unknown> | null;
  uploadedAt: Date;
}

export interface ReportedEvent {
  key?: unknown;
  size?: unknown;
  uploaded_at?: unknown;
  manifest?: unknown;
}

export interface SessionListFilter {
  robot?: string;
  product?: string;
  q?: string;
  status?: ArchiveSessionStatus;
  include_sim?: boolean;
  include_deleted?: boolean;
  page: number;
  limit: number;
}

function toDate(v: unknown): Date | null {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v * 1000);
  if (typeof v === 'string' && v) {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return new Date(t);
  }
  return null;
}

export interface CameraSegment {
  key: string;
  name: string;
  size: number;
  start: number;
  duration: number;
}

/**
 * Camera chunks in time order with their durations (for the HLS playlist, time sync and MP4 export).
 * A gap longer than a segment means recording paused; keep the nominal length then.
 */
export function cameraSegments(files: { object_key: string; name: string; size_bytes: number; chunk_start: Date | null }[], segmentSec: number): CameraSegment[] {
  const chunks = files.filter((f) => f.chunk_start).sort((a, b) => a.chunk_start!.getTime() - b.chunk_start!.getTime());
  return chunks.map((f, i) => {
    const start = f.chunk_start!.getTime();
    const next = chunks[i + 1]?.chunk_start?.getTime();
    const gap = next !== undefined ? (next - start) / 1000 : segmentSec;
    const duration = gap > 0 && gap <= segmentSec * 1.5 ? gap : segmentSec;
    return { key: f.object_key, name: f.name, size: Number(f.size_bytes), start, duration };
  });
}

const fileUrl = (id: string, name: string) => `${API_ARCHIVE_BASE}/${id}/files/${name.split('/').map(encodeURIComponent).join('/')}`;

export class ArchiveService {
  readonly storage: ArchiveStorage;
  readonly mp4: Mp4Builder;
  private readonly imuCache = new PreviewCache<ImuPreviewDto>(16);
  private readonly lidarCache = new PreviewCache<LidarChunk>(48);

  constructor(
    private readonly db: Db,
    readonly cfg: ApiConfig['archive'],
  ) {
    this.storage = createArchiveStorage(cfg);
    this.mp4 = new Mp4Builder(cfg, this.storage);
  }

  // ── writes ────────────────────────────────────────────────────────────────

  /** Robot ids (of `ids`) that are registered and not deleted. */
  async registered(ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const res = await this.db.query<{ robot_id: string }>('SELECT robot_id FROM robots WHERE robot_id = ANY($1::text[]) AND deleted_at IS NULL', [ids]);
    return new Set(res.rows.map((r) => r.robot_id));
  }

  /**
   * Indexes stored objects in one transaction. Idempotent: the same key twice updates one row.
   * `live` = a robot is sending right now (marks it seen and pushes a realtime change); false for re-index.
   */
  async record(items: RecordItem[], live: boolean): Promise<void> {
    if (!items.length) return;
    await withTransaction(this.db, async (tx) => {
      const sessionIds = new Map<string, string>();
      for (const it of items) {
        const k = `${it.robotId}|${it.sim}|${it.sessionId}`;
        let sid = sessionIds.get(k);
        if (!sid) {
          sid = await this.sessionRef(tx, it.robotId, it.sim, it.sessionId);
          sessionIds.set(k, sid);
        }
        const m = it.manifest;
        if (it.file.name === SESSION_FILE && m && typeof m === 'object') {
          const trip = typeof m.trip === 'string' && m.trip.trim() ? m.trip.trim().slice(0, 200) : null;
          let tripId: number | null = null;
          if (trip) {
            tripId = (
              await tx.query<{ id: number }>('INSERT INTO archive_trips (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = excluded.name RETURNING id', [trip])
            ).rows[0].id;
          }
          await tx.query(
            `UPDATE archive_sessions SET manifest = $2, status = $3, started_at = $4, ended_at = $5, stop_reason = $6,
                    simulated = $7, trip_id = coalesce($8, trip_id)
             WHERE id = $1`,
            [
              sid,
              JSON.stringify(m),
              typeof m.status === 'string' ? m.status.slice(0, 100) : null,
              toDate(m.started_at) ?? toDate(m.started_unix),
              toDate(m.ended_at) ?? toDate(m.ended_unix),
              typeof m.stop_reason === 'string' ? m.stop_reason.slice(0, 500) : null,
              m.simulated === true,
              tripId,
            ],
          );
        }
        if (it.file.name === COMPLETE_FILE) await tx.query('UPDATE archive_sessions SET complete = true WHERE id = $1 AND NOT complete', [sid]);
        await tx.query(
          `INSERT INTO archive_files (object_key, session_ref, name, kind, camera, sensor, chunk_start, size_bytes, sha256, uploaded_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (object_key) DO UPDATE SET size_bytes = excluded.size_bytes, uploaded_at = excluded.uploaded_at,
                                                  kind = excluded.kind, camera = excluded.camera, sensor = excluded.sensor,
                                                  chunk_start = excluded.chunk_start,
                                                  sha256 = coalesce(excluded.sha256, archive_files.sha256)`,
          [
            it.key,
            sid,
            it.file.name,
            it.file.kind,
            it.file.camera,
            it.file.sensor,
            it.file.chunkStart === null ? null : new Date(it.file.chunkStart),
            it.size,
            it.sha256,
            it.uploadedAt,
          ],
        );
      }
      if (live) {
        const robots = new Map<string, string>();
        for (const it of items) robots.set(it.robotId, it.sessionId);
        for (const [robotId, sessionId] of robots) {
          await tx.query(
            `INSERT INTO archive_robot_link (robot_id, last_upload_at) VALUES ($1, now())
             ON CONFLICT (robot_id) DO UPDATE SET last_upload_at = now()`,
            [robotId],
          );
          await tx.query('UPDATE live_state SET last_seen_at = now() WHERE robot_id = $1', [robotId]);
          await notifyChange(tx, { kind: 'archive', robot_id: robotId, session_id: sessionId });
          await notifyChange(tx, { kind: 'seen', robot_id: robotId });
        }
      }
    });
  }

  private async sessionRef(tx: PoolClient, robotId: string, sim: boolean, sessionId: string): Promise<string> {
    const ins = await tx.query<{ id: string }>(
      'INSERT INTO archive_sessions (robot_id, sim, session_id) VALUES ($1, $2, $3) ON CONFLICT (robot_id, sim, session_id) DO NOTHING RETURNING id',
      [robotId, sim, sessionId],
    );
    if (ins.rows[0]) return ins.rows[0].id;
    return (await tx.query<{ id: string }>('SELECT id FROM archive_sessions WHERE robot_id = $1 AND sim = $2 AND session_id = $3', [robotId, sim, sessionId])).rows[0].id;
  }

  /** Indexed size and sha256 of one object, or null. */
  async storedFile(key: string): Promise<{ size: number; sha256: string | null } | null> {
    const r = (await this.db.query<{ size_bytes: number; sha256: string | null }>('SELECT size_bytes, sha256 FROM archive_files WHERE object_key = $1', [key])).rows[0];
    return r ? { size: Number(r.size_bytes), sha256: r.sha256 } : null;
  }

  /** True once _COMPLETE.json is indexed: nothing in the session may change any more. */
  async sessionComplete(robotId: string, sim: boolean, sessionId: string): Promise<boolean> {
    const r = (await this.db.query<{ complete: boolean }>('SELECT complete FROM archive_sessions WHERE robot_id = $1 AND sim = $2 AND session_id = $3', [robotId, sim, sessionId])).rows[0];
    return r?.complete === true;
  }

  /** After a failed upload overwrote the object, drop the hash so the retry is stored again. */
  async forgetSha256(key: string): Promise<void> {
    await this.db.query('UPDATE archive_files SET sha256 = NULL WHERE object_key = $1', [key]);
  }

  /** Objects a robot uploaded to the bucket itself and reports here. */
  async recordReported(events: ReportedEvent[], mayUse: (robotId: string) => boolean): Promise<{ accepted: number; rejected: { key: string; error: string }[] }> {
    const rejected: { key: string; error: string }[] = [];
    const parsed = events.map((ev) => ({ ev, key: typeof ev?.key === 'string' ? ev.key : '', k: typeof ev?.key === 'string' ? parseSessionKey(ev.key) : null }));
    const known = await this.registered([...new Set(parsed.flatMap((p) => (p.k ? [p.k.robotId] : [])))]);
    const items: RecordItem[] = [];
    for (const { ev, key, k } of parsed) {
      const size = Number(ev?.size);
      if (!k || !Number.isFinite(size) || size < 0) {
        rejected.push({ key, error: 'bad key or size' });
        continue;
      }
      if (!mayUse(k.robotId)) {
        rejected.push({ key, error: `this key may not upload for ${k.robotId}` });
        continue;
      }
      if (!known.has(k.robotId)) {
        rejected.push({ key, error: `robot ${k.robotId} is not registered in the PMS` });
        continue;
      }
      const file = classify(k.name, this.cfg.robotUtcOffsetMin);
      if (!file) {
        rejected.push({ key, error: 'not a session file (.part / .tmp)' });
        continue;
      }
      items.push({
        key,
        robotId: k.robotId,
        sim: k.sim,
        sessionId: k.sessionId,
        file,
        size,
        sha256: null,
        manifest: ev.manifest && typeof ev.manifest === 'object' ? (ev.manifest as Record<string, unknown>) : undefined,
        uploadedAt: toDate(ev.uploaded_at) ?? new Date(),
      });
    }
    await this.record(items, true);
    return { accepted: items.length, rejected };
  }

  /** cloud_sync heartbeat: current session, backlog, disk, alerts. */
  async heartbeat(robotId: string, status: unknown): Promise<void> {
    await withTransaction(this.db, async (tx) => {
      await tx.query(
        `INSERT INTO archive_robot_link (robot_id, last_seen_at, last_status) VALUES ($1, now(), $2)
         ON CONFLICT (robot_id) DO UPDATE SET last_seen_at = now(), last_status = excluded.last_status`,
        [robotId, JSON.stringify(status ?? {})],
      );
      await tx.query('UPDATE live_state SET last_seen_at = now() WHERE robot_id = $1', [robotId]);
      await notifyChange(tx, { kind: 'seen', robot_id: robotId });
    });
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  async listSessions(filter: SessionListFilter, scope: (w: Where) => void): Promise<ArchiveSessionListDto> {
    const w = new Where();
    scope(w);
    if (filter.robot) w.add('s.robot_id = ?', filter.robot);
    if (filter.product) w.add('p.code = ?', filter.product);
    if (!filter.include_sim) w.add('NOT s.sim');
    if (!filter.include_deleted) w.add('s.deleted_at IS NULL');
    if (filter.q) {
      const like = `%${filter.q}%`;
      w.add('(s.session_id ILIKE ? OR s.robot_id ILIKE ? OR t.name ILIKE ? OR r.serial_number ILIKE ?)', like, like, like, like);
    }
    const rows = await this.db.query<SessionRow>(`${SESSION_SELECT} ${w.toSql()} ORDER BY coalesce(s.started_at, s.created_at) DESC LIMIT 5000`, w.params);
    let all = rows.rows.map((r) => summarize(r, this.cfg));
    if (filter.status) all = all.filter((s) => s.status === filter.status);
    all.sort((a, b) => (b.started_at ?? '').localeCompare(a.started_at ?? ''));
    const start = (filter.page - 1) * filter.limit;
    return {
      items: all.slice(start, start + filter.limit),
      total: all.length,
      page: filter.page,
      limit: filter.limit,
      totals: {
        sessions: all.length,
        active: all.filter((s) => s.status === 'active').length,
        bytes: all.reduce((n, s) => n + s.bytes.total, 0),
        video_bytes: all.reduce((n, s) => n + s.bytes.camera, 0),
      },
    };
  }

  async link(robotId: string): Promise<ArchiveRobotLinkDto | null> {
    const r = (
      await this.db.query<{ last_seen_at: Date | null; last_status: Record<string, unknown> | null; last_upload_at: Date | null }>(
        'SELECT last_seen_at, last_status, last_upload_at FROM archive_robot_link WHERE robot_id = $1',
        [robotId],
      )
    ).rows[0];
    if (!r) return null;
    const now = Date.now();
    const fresh = r.last_seen_at !== null && now - r.last_seen_at.getTime() < HEARTBEAT_FRESH_MS;
    const status = fresh ? (r.last_status ?? {}) : {};
    const session = status.session as { session_id?: unknown } | null | undefined;
    const alerts = Array.isArray(status.alerts) ? (status.alerts as Record<string, unknown>[]) : [];
    return {
      robot_id: robotId,
      last_seen_at: iso(r.last_seen_at),
      last_upload_at: iso(r.last_upload_at),
      recording_session_id: typeof session?.session_id === 'string' ? session.session_id : null,
      pending_files: Number(status.pending_files) || 0,
      pending_bytes: Number(status.pending_bytes) || 0,
      alerts: alerts.map((a) => ({
        code: typeof a.code === 'string' ? a.code : null,
        severity: typeof a.severity === 'string' ? a.severity : null,
        message: typeof a.message === 'string' ? a.message : null,
      })),
      sending_data: r.last_upload_at !== null && now - r.last_upload_at.getTime() < SENDING_WINDOW_MS,
    };
  }

  /** One robot's recordings; `scope` adds the viewer's ownership-period condition. */
  async robotArchive(robotId: string, scope: (w: Where) => void, includeDeleted = false): Promise<RobotArchiveDto> {
    const w = new Where().add('s.robot_id = ?', robotId);
    if (!includeDeleted) w.add('s.deleted_at IS NULL');
    scope(w);
    const rows = await this.db.query<SessionRow>(`${SESSION_SELECT} ${w.toSql()} ORDER BY coalesce(s.started_at, s.created_at) DESC`, w.params);
    return { link: await this.link(robotId), sessions: rows.rows.map((r) => summarize(r, this.cfg)) };
  }

  /** robot_id and recording time of a session (for access checks); null when unknown or deleted (unless allowed). */
  async sessionOwner(id: string, allowDeleted = false): Promise<{ robotId: string; at: Date } | null> {
    const r = (
      await this.db.query<{ robot_id: string; at: Date }>(
        `SELECT robot_id, coalesce(started_at, created_at) AS at FROM archive_sessions WHERE id = $1 ${allowDeleted ? '' : 'AND deleted_at IS NULL'}`,
        [id],
      )
    ).rows[0];
    return r ? { robotId: r.robot_id, at: r.at } : null;
  }

  private async sessionRow(id: string, allowDeleted = false): Promise<SessionRow> {
    const row = (await this.db.query<SessionRow>(`${SESSION_SELECT} WHERE s.id = $1 ${allowDeleted ? '' : 'AND s.deleted_at IS NULL'}`, [id])).rows[0];
    if (!row) throw notFound('recording');
    return row;
  }

  async detail(id: string, access: ArchiveAccessDto, allowDeleted = false): Promise<ArchiveSessionDetailDto> {
    const row = await this.sessionRow(id, allowDeleted);
    const session = summarize(row, this.cfg);
    const files = (
      await this.db.query<{ object_key: string; name: string; kind: 'camera' | 'sensors' | 'meta'; camera: string | null; sensor: 'lidar' | 'imu' | 'gps' | 'encoder' | null; chunk_start: Date | null; size_bytes: number; uploaded_at: Date }>(
        `SELECT object_key, name, kind, camera, sensor, chunk_start, size_bytes, uploaded_at
         FROM archive_files WHERE session_ref = $1 ORDER BY chunk_start NULLS FIRST, name`,
        [id],
      )
    ).rows;
    const segSec = videoSegmentSec(row.manifest, this.cfg);
    const base = `${API_ARCHIVE_BASE}/${id}`;
    const cameras: ArchiveCameraDto[] = sortCameras(new Set(files.flatMap((f) => (f.camera ? [f.camera] : [])))).map((name) => {
      const segs = cameraSegments(files.filter((f) => f.kind === 'camera' && f.camera === name), segSec);
      return {
        name,
        segments: segs.map((s) => ({ start_ms: s.start, duration_s: s.duration })),
        bytes: files.filter((f) => f.camera === name).reduce((n, f) => n + Number(f.size_bytes), 0),
        seconds: segs.reduce((n, s) => n + s.duration, 0),
        playlist_url: `${base}/cameras/${encodeURIComponent(name)}/playlist.m3u8`,
        mp4_url: `${base}/cameras/${encodeURIComponent(name)}/mp4`,
        mp4_download_url: `${base}/cameras/${encodeURIComponent(name)}/mp4?download=1`,
      };
    });
    const fileDtos: ArchiveFileDto[] = files.map((f) => ({
      name: f.name,
      kind: f.kind,
      camera: f.camera,
      sensor: f.sensor,
      chunk_start: iso(f.chunk_start),
      size_bytes: Number(f.size_bytes),
      uploaded_at: iso(f.uploaded_at)!,
      url: fileUrl(id, f.name),
      download_url: `${fileUrl(id, f.name)}?download=1`,
    }));
    const stream = (list: typeof files, missing: string): ArchiveStreamDto => ({
      available: list.length > 0,
      files: list.length,
      bytes: list.reduce((n, f) => n + Number(f.size_bytes), 0),
      reason: list.length ? null : missing,
    });
    const still = session.status === 'active' ? ' yet' : '';
    return {
      session,
      manifest: row.manifest,
      cameras,
      files: fileDtos,
      streams: {
        video: stream(files.filter((f) => f.kind === 'camera'), `No camera video was uploaded for this recording${still}.`),
        lidar: stream(files.filter((f) => f.sensor === 'lidar'), `No LiDAR data was uploaded for this recording${still}.`),
        imu: stream(files.filter((f) => f.sensor === 'imu'), `No IMU data was uploaded for this recording${still}.`),
        gps: stream(files.filter((f) => f.sensor === 'gps'), `No GPS log was uploaded for this recording${still}.`),
        encoder: stream(files.filter((f) => f.sensor === 'encoder'), `No wheel-encoder log was uploaded for this recording${still}.`),
        metadata: stream(
          files.filter((f) => f.kind === 'meta'),
          `The robot has not uploaded session.json${still}, so start / stop details come from the file names.`,
        ),
      },
      access,
      zip_url: `/api/v1/archive/download.zip?sessions=${id}`,
      mp4_available: (await this.mp4.ffmpeg()).available,
      interrupted_after_min: this.cfg.interruptedAfterMin,
      deleted_at: iso(row.deleted_at),
      delete_reason: row.delete_reason,
    };
  }

  /** Every file of a session, for zip downloads (oldest chunk first within each group). */
  async files(id: string): Promise<{ object_key: string; name: string; kind: 'camera' | 'sensors' | 'meta'; camera: string | null; sensor: string | null; size_bytes: number }[]> {
    await this.sessionRow(id);
    const rows = await this.db.query<{ object_key: string; name: string; kind: 'camera' | 'sensors' | 'meta'; camera: string | null; sensor: string | null; size_bytes: number }>(
      'SELECT object_key, name, kind, camera, sensor, size_bytes FROM archive_files WHERE session_ref = $1 ORDER BY kind, camera NULLS FIRST, sensor NULLS FIRST, chunk_start NULLS FIRST, name',
      [id],
    );
    return rows.rows.map((r) => ({ ...r, size_bytes: Number(r.size_bytes) }));
  }

  /** One file of a session (only names that are indexed for it can be read). */
  async file(id: string, name: string): Promise<{ key: string; name: string; size: number; kind: 'camera' | 'sensors' | 'meta'; sensor: string | null }> {
    const r = (
      await this.db.query<{ object_key: string; size_bytes: number; kind: 'camera' | 'sensors' | 'meta'; sensor: string | null }>(
        'SELECT object_key, size_bytes, kind, sensor FROM archive_files WHERE session_ref = $1 AND name = $2',
        [id, name],
      )
    ).rows[0];
    if (!r) throw notFound('file');
    return { key: r.object_key, name, size: Number(r.size_bytes), kind: r.kind, sensor: r.sensor };
  }

  // ── sensor previews (view without downloading the raw files) ─────────────

  private async sensorFiles(id: string, sensor: 'imu' | 'lidar'): Promise<{ object_key: string; name: string; size_bytes: number; uploaded_at: Date }[]> {
    await this.sessionRow(id);
    return (
      await this.db.query<{ object_key: string; name: string; size_bytes: number; uploaded_at: Date }>(
        "SELECT object_key, name, size_bytes, uploaded_at FROM archive_files WHERE session_ref = $1 AND kind = 'sensors' AND sensor = $2 ORDER BY chunk_start NULLS LAST, name",
        [id, sensor],
      )
    ).rows;
  }

  private async readObject(key: string): Promise<Buffer> {
    return readAll((await this.storage.get(key)).body);
  }

  async imuPreview(id: string): Promise<ImuPreviewDto> {
    const files = await this.sensorFiles(id, 'imu');
    // Cache key changes whenever a chunk is added or re-uploaded.
    const cacheKey = `${id}|${files.length}|${files.reduce((m, f) => Math.max(m, f.uploaded_at.getTime()), 0)}`;
    const hit = this.imuCache.get(cacheKey);
    if (hit) return hit;
    const byName = new Map(files.map((f) => [f.name, f.object_key]));
    const dto = await imuPreview(
      files.map((f) => ({ name: f.name, size: Number(f.size_bytes) })),
      (name) => this.readObject(byName.get(name)!),
    );
    // Do not cache a storage outage.
    if (dto.problem !== 'storage_unavailable') this.imuCache.set(cacheKey, dto);
    return dto;
  }

  async lidarPreview(id: string, chunk: string | undefined): Promise<LidarPreviewDto> {
    const files = await this.sensorFiles(id, 'lidar');
    const chunks = files.map((f) => f.name);
    if (!files.length) return lidarUnavailable(chunks, null, 'missing', 'No LiDAR data was uploaded for this recording.');
    const f = chunk ? files.find((x) => x.name === chunk) : files[0];
    if (!f) throw notFound('LiDAR chunk');
    if (Number(f.size_bytes) > 64 * 1024 * 1024) return lidarUnavailable(chunks, f.name, 'too_large', 'This LiDAR chunk is too large to preview. Download it to open it in Python.');
    const cacheKey = `${f.object_key}|${f.uploaded_at.getTime()}`;
    let decoded = this.lidarCache.get(cacheKey);
    if (!decoded) {
      try {
        decoded = parseLidarChunk(await this.readObject(f.object_key));
        this.lidarCache.set(cacheKey, decoded);
      } catch (e) {
        if (e instanceof SensorFormatError) {
          return lidarUnavailable(chunks, f.name, 'unreadable', `This LiDAR chunk was uploaded but could not be decoded (${e.message}).`);
        }
        if (e instanceof ObjectNotFound) return lidarUnavailable(chunks, f.name, 'missing', 'This LiDAR chunk is listed but no longer in the archive storage.');
        return lidarUnavailable(chunks, f.name, 'storage_unavailable', 'The LiDAR file could not be read from the archive storage. Try again later.');
      }
    }
    return { status: 'ok', problem: null, message: null, chunk: f.name, chunks, ...decoded };
  }

  // ── delete / restore (hide; the objects stay in the bucket) ──────────────

  async setDeleted(id: string, deleted: boolean, by: string, reason: string | null): Promise<void> {
    const res = await this.db.query(
      deleted
        ? 'UPDATE archive_sessions SET deleted_at = now(), deleted_by = $2, delete_reason = $3 WHERE id = $1 AND deleted_at IS NULL'
        : 'UPDATE archive_sessions SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL WHERE id = $1 AND deleted_at IS NOT NULL',
      deleted ? [id, by, reason] : [id],
    );
    if (!res.rowCount) throw notFound(deleted ? 'recording (or it is already deleted)' : 'deleted recording');
  }

  async cameraTrack(id: string, camera: string): Promise<{ session: ArchiveSessionDto; segments: CameraSegment[] }> {
    const row = await this.sessionRow(id);
    const files = (
      await this.db.query<{ object_key: string; name: string; size_bytes: number; chunk_start: Date | null }>(
        "SELECT object_key, name, size_bytes, chunk_start FROM archive_files WHERE session_ref = $1 AND kind = 'camera' AND camera = $2",
        [id, camera],
      )
    ).rows;
    return { session: summarize(row, this.cfg), segments: cameraSegments(files, videoSegmentSec(row.manifest, this.cfg)) };
  }

  // ── re-index ──────────────────────────────────────────────────────────────

  /**
   * Rebuilds the index from the object store (the store is the source of truth). Only registered robots
   * are indexed; other top-level folders are reported as ignored. Sessions already complete are skipped
   * unless `full`. Idempotent and safe while robots upload.
   */
  async reindex(only: string | null, full: boolean): Promise<ArchiveReindexDto> {
    const robots = (
      await this.db.query<{ robot_id: string }>(
        `SELECT robot_id FROM robots WHERE deleted_at IS NULL ${only ? 'AND robot_id = $1' : ''} ORDER BY robot_id`,
        only ? [only] : [],
      )
    ).rows.map((r) => r.robot_id);
    const known = new Set(robots);
    const ignored = only ? [] : (await this.storage.listPrefixes('')).map((p) => p.replace(/\/$/, '')).filter((p) => !known.has(p));
    const report: ArchiveReindexDto['robots'] = [];
    for (const robotId of robots) {
      const line = { robot_id: robotId, sessions: 0, skipped: 0, files: 0, rejected: 0 };
      for (const sim of [false, true]) {
        const done = new Set(
          full
            ? []
            : (await this.db.query<{ session_id: string }>('SELECT session_id FROM archive_sessions WHERE robot_id = $1 AND sim = $2 AND complete', [robotId, sim])).rows.map(
                (r) => r.session_id,
              ),
        );
        const sessionIds = (await this.storage.listPrefixes(sessionsPrefix(robotId, sim))).map((p) => p.replace(/\/$/, '').split('/').pop() ?? '');
        for (const sessionId of sessionIds) {
          if (done.has(sessionId)) {
            line.skipped++;
            continue;
          }
          const prefix = sessionPrefix(robotId, sim, sessionId);
          const objects = await this.storage.listObjects(prefix);
          if (!objects.length) continue;
          let manifest: Record<string, unknown> | null = null;
          if (objects.some((o) => o.key === prefix + SESSION_FILE)) {
            try {
              manifest = JSON.parse((await this.storage.readText(prefix + SESSION_FILE)) ?? 'null');
            } catch {
              manifest = null;
            }
          }
          const items: RecordItem[] = [];
          for (const o of objects) {
            const k = parseSessionKey(o.key);
            const file = k ? classify(k.name, this.cfg.robotUtcOffsetMin) : null;
            if (!k || !file || k.robotId !== robotId || k.sessionId !== sessionId) {
              line.rejected++;
              continue;
            }
            items.push({ key: o.key, robotId, sim, sessionId, file, size: o.size, sha256: null, manifest: file.name === SESSION_FILE ? manifest : undefined, uploadedAt: o.lastModified });
          }
          // session.json first, so the session row has its metadata before the rest lands
          items.sort((a, b) => Number(b.file.name === SESSION_FILE) - Number(a.file.name === SESSION_FILE));
          for (let i = 0; i < items.length; i += 500) await this.record(items.slice(i, i + 500), false);
          line.files += items.length;
          line.sessions++;
        }
      }
      report.push(line);
    }
    return { robots: report, ignored_prefixes: ignored };
  }

  async stats(): Promise<{ sessions: number; files: number; bytes: number; last_upload_at: string | null }> {
    const r = (
      await this.db.query<{ sessions: number; files: number; bytes: number; last: Date | null }>(
        `SELECT (SELECT count(*)::int FROM archive_sessions) AS sessions,
                count(*)::int AS files, coalesce(sum(size_bytes), 0)::bigint AS bytes, max(uploaded_at) AS last
         FROM archive_files`,
      )
    ).rows[0];
    return { sessions: r.sessions, files: r.files, bytes: Number(r.bytes), last_upload_at: iso(r.last) };
  }
}
