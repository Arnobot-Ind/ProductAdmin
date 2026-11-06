/**
 * One camera of a session as a single MP4 that opens by double-click on Windows, macOS (QuickTime),
 * iPhone and Android. The archive keeps .ts chunks because the web player streams them; a .ts on its own
 * is what most desktop players refuse.
 *
 * What makes it play on a Mac (QuickTime is the pickiest player):
 *  - H.264 or H.265, 8-bit 4:2:0; anything else is re-encoded to H.264 yuv420p;
 *  - H.265 tagged "hvc1" (QuickTime refuses ffmpeg's default "hev1"), H.264 tagged "avc1";
 *  - the moov index at the front (+faststart) and a byte-range server (the route) to seek with;
 *  - audio, when present, as AAC-LC.
 * Chunks are joined with a stream copy when the codec allows, so a build costs disk and network, not an encode.
 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ApiConfig } from '../../lib/config';
import type { ArchiveStorage } from './storage';

export interface Mp4Segment {
  key: string;
  size: number;
}

const NET = ['-protocol_whitelist', 'file,http,https,tcp,tls,crypto'];

/** What people watch and download on the web: 480p at 15 fps, to save network. The originals in the bucket never change. */
const LOW_VIDEO = ['-vf', "scale=-2:'min(480,ih)',fps=15", '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '450k', '-maxrate', '600k', '-bufsize', '1200k', '-pix_fmt', 'yuv420p'];
export type VideoQuality = 'low' | 'original';
/** Length of one playback piece. Only the pieces someone watches are ever made or sent. */
export const LOW_PIECE_SECONDS = 10;
/** Pieces made in one pass. Finding a position in a file on S3 is the slow part (seconds); reading on from it is not. */
const PIECES_PER_PASS = 6;
/** When fewer pieces than this are ready ahead of what is being watched, the next pass starts, so playback never waits. */
const READY_AHEAD = 3;
/** Passes running at the same time. More wait, so playback cannot use up the server. */
const MAX_PASSES = 4;

function safe(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, '_');
}

/** Download name: saibya02_20260926_112634_ab12_cam1.mp4 */
export function mp4Name(robotId: string, sessionId: string, camera: string): string {
  return `${safe(robotId)}_${safe(sessionId)}_${safe(camera)}.mp4`;
}

function run(cmd: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, signal });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${path.basename(cmd)} exited ${code}: ${err.trim().slice(-500)}`))));
  });
}

interface Pass {
  key: string;
  size: number;
  from: number;
  to: number;
  cancel: AbortController;
}

export class Mp4Builder {
  private readonly building = new Map<string, Promise<string>>();
  private readonly cacheDir: string;
  private readonly passQueue: (() => void)[] = [];
  private passes = 0;
  /** Running or queued passes: which pieces of which file they will make. */
  private readonly planned = new Set<Pass>();
  private readonly pieceWaiters = new Map<string, ((file: string | null) => void)[]>();
  private probed: Promise<{ available: boolean; version: string | null }> | null = null;

  constructor(
    private readonly cfg: ApiConfig['archive'],
    private readonly storage: ArchiveStorage,
  ) {
    // Only temporary files: inside the archive temp folder, swept after MP4_CACHE_HOURS.
    this.cacheDir = path.resolve(cfg.tempDir, 'mp4');
  }

  /** Whether ffmpeg runs on this host (checked once, then cached). */
  ffmpeg(): Promise<{ available: boolean; version: string | null }> {
    this.probed ??= run(this.cfg.ffmpegPath, ['-hide_banner', '-version'])
      .then((out) => ({ available: true, version: /ffmpeg version (\S+)/.exec(out)?.[1] ?? 'unknown' }))
      .catch(() => ({ available: false, version: null }));
    return this.probed;
  }

  /** The cached MP4 for these chunks, building it first if needed. Concurrent requests share one build. */
  async build(robotId: string, sessionId: string, camera: string, segments: Mp4Segment[], quality: VideoQuality = 'original'): Promise<string> {
    // The name covers every chunk key and size: a session that gained chunks gets a new file, never a stale one.
    const hash = createHash('sha256')
      .update(quality + segments.map((s) => `${s.key}:${s.size}`).join('\n'))
      .digest('hex')
      .slice(0, 16);
    const file = path.join(this.cacheDir, `${safe(robotId)}__${safe(sessionId)}__${safe(camera)}__${hash}.mp4`);
    try {
      await stat(file);
      return file;
    } catch {
      // not built yet
    }
    let job = this.building.get(file);
    if (!job) {
      job = this.make(segments, file, quality).finally(() => this.building.delete(file));
      this.building.set(file, job);
    }
    return job;
  }

  private pieceFile(key: string, size: number, index: number): string {
    const hash = createHash('sha256').update(`${key}:${size}:${index}`).digest('hex').slice(0, 32);
    return path.join(this.cacheDir, `piece__${hash}.ts`);
  }

  private async pieceReady(file: string): Promise<boolean> {
    return stat(file).then(
      () => true,
      () => false,
    );
  }

  /**
   * One short piece of a recording in low quality, kept for MP4_CACHE_HOURS. Null when the file ends before it (a
   * recording that stopped early). Pieces come from passes that read on through the file, ahead of what is watched.
   */
  async lowPiece(key: string, size: number, index: number, total: number, viewerGone?: AbortSignal): Promise<string | null> {
    const file = this.pieceFile(key, size, index);
    if (!(await this.pieceReady(file))) {
      const made = new Promise<string | null>((done) => {
        this.pieceWaiters.set(file, [...(this.pieceWaiters.get(file) ?? []), done]);
        // A viewer who jumped elsewhere no longer waits, so the pass making this piece can be dropped.
        viewerGone?.addEventListener('abort', () => {
          const left = (this.pieceWaiters.get(file) ?? []).filter((w) => w !== done);
          if (left.length) this.pieceWaiters.set(file, left);
          else this.pieceWaiters.delete(file);
          done(null);
        });
      });
      // Finished while this request was checking: its pass has already told everyone who was waiting then.
      if (await this.pieceReady(file)) {
        for (const done of this.pieceWaiters.get(file) ?? []) done(file);
        this.pieceWaiters.delete(file);
      } else if (![...this.planned].some((p) => !p.cancel.signal.aborted && p.key === key && p.from <= index && index <= p.to)) {
        // A viewer who jumped no longer needs this file's other passes. Others are only dropped when none can start.
        const idle = [...this.planned].filter((p) => !p.cancel.signal.aborted && !this.anyoneWaiting(p));
        for (const p of idle) if (p.key === key) p.cancel.abort();
        if (this.passes >= MAX_PASSES) idle.find((p) => p.key !== key)?.cancel.abort();
        this.startPass(key, size, index, total, true);
      }
      if (!(await made)) return null;
    }
    void this.readAhead(key, size, index, total);
    return file;
  }

  private anyoneWaiting(p: Pass): boolean {
    for (let i = p.from; i <= p.to; i++) if (this.pieceWaiters.has(this.pieceFile(p.key, p.size, i))) return true;
    return false;
  }

  private async readAhead(key: string, size: number, index: number, total: number): Promise<void> {
    for (let i = index + 1; i <= Math.min(index + READY_AHEAD, total - 1); i++) {
      if ([...this.planned].some((p) => !p.cancel.signal.aborted && p.key === key && p.from <= i && i <= p.to)) continue;
      if (!(await this.pieceReady(this.pieceFile(key, size, i)))) {
        this.startPass(key, size, i, total, false);
        return;
      }
    }
  }

  private startPass(key: string, size: number, from: number, total: number, wanted: boolean): void {
    const plan: Pass = { key, size, from, to: Math.min(from + PIECES_PER_PASS, total) - 1, cancel: new AbortController() };
    this.planned.add(plan);
    void this.runPass(plan, wanted).finally(() => this.planned.delete(plan));
  }

  private async runPass(plan: Pass, wanted: boolean): Promise<void> {
    if (this.passes >= MAX_PASSES) {
      // Someone waiting goes ahead of reading ahead.
      await new Promise<void>((go) => (wanted ? this.passQueue.unshift(go) : this.passQueue.push(go)));
    } else this.passes += 1;
    const { key, size, from, to, cancel } = plan;
    const prefix = path.join(this.cacheDir, `pass__${randomUUID()}_`);
    const written = (i: number) => `${prefix}${String(i).padStart(3, '0')}.ts`;
    let next = 0;
    // A piece is finished once the one after it has started, or the pass has ended.
    const collect = async (ended: boolean) => {
      for (;;) {
        const piece = from + next;
        if (piece > to || !(await this.pieceReady(written(next)))) return;
        if (!ended && !(await this.pieceReady(written(next + 1)))) return;
        const file = this.pieceFile(key, size, piece);
        await rename(written(next), file);
        for (const done of this.pieceWaiters.get(file) ?? []) done(file);
        this.pieceWaiters.delete(file);
        next += 1;
      }
    };
    let collecting = Promise.resolve();
    const watch = setInterval(() => {
      collecting = collecting.then(() => collect(false)).catch(() => undefined);
    }, 150);
    try {
      await mkdir(this.cacheDir, { recursive: true });
      void this.sweep();
      if (cancel.signal.aborted) return;
      await run(this.cfg.ffmpegPath, [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
        ...NET, '-ss', String(from * LOW_PIECE_SECONDS), '-i', await this.storage.ffmpegInput(key), '-t', String((to - from + 1) * LOW_PIECE_SECONDS),
        '-map', '0:v:0', '-map', '0:a:0?', '-c:a', 'aac', '-b:a', '64k',
        ...LOW_VIDEO,
        '-force_key_frames', `expr:gte(t,n_forced*${LOW_PIECE_SECONDS})`,
        // Pieces of one file continue each other's timeline, so the player sees one unbroken video.
        '-output_ts_offset', String(from * LOW_PIECE_SECONDS), '-muxdelay', '0',
        '-f', 'segment', '-segment_time', String(LOW_PIECE_SECONDS), '-segment_format', 'mpegts', `${prefix}%03d.ts`,
      ], cancel.signal);
    } catch {
      // Reading past the end of a file is normal here; pieces that were made are still used.
    } finally {
      clearInterval(watch);
      await collecting;
      // A cancelled pass stopped in the middle of a piece: only pieces already finished are kept.
      await collect(!cancel.signal.aborted).catch(() => undefined);
      for (let i = next; i <= to - from + 1; i++) await rm(written(i), { force: true });
      // Whatever this pass did not make does not exist.
      for (let i = from; i <= to; i++) {
        const file = this.pieceFile(key, size, i);
        for (const done of this.pieceWaiters.get(file) ?? []) done(null);
        this.pieceWaiters.delete(file);
      }
      const go = this.passQueue.shift();
      if (go) go();
      else this.passes -= 1;
    }
  }

  private async make(segments: Mp4Segment[], file: string, quality: VideoQuality): Promise<string> {
    await mkdir(this.cacheDir, { recursive: true });
    void this.sweep();
    // ffmpeg reads the segments straight from S3 through short-lived URLs; only the result is written here.
    const inputs = await Promise.all(segments.map((s) => this.storage.ffmpegInput(s.key)));
    const list = `${file}.txt`;
    const part = `${file}.part`;
    await writeFile(list, inputs.map((u) => `file '${u.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
    try {
      const probe = await run(this.cfg.ffprobePath, ['-v', 'error', ...NET, '-show_entries', 'stream=codec_type,codec_name,pix_fmt', '-of', 'json', inputs[0]]);
      const streams = (JSON.parse(probe || '{}').streams ?? []) as { codec_type?: string; codec_name?: string; pix_fmt?: string }[];
      const video = streams.find((s) => s.codec_type === 'video');
      const hasAudio = streams.some((s) => s.codec_type === 'audio');
      const eightBit420 = !video?.pix_fmt || video.pix_fmt === 'yuv420p' || video.pix_fmt === 'yuvj420p';
      const vcodec = quality === 'low' ? [...LOW_VIDEO, '-tag:v', 'avc1'] :
        video?.codec_name === 'h264' && eightBit420
          ? ['-c:v', 'copy', '-tag:v', 'avc1']
          : video?.codec_name === 'hevc' && eightBit420
            ? ['-c:v', 'copy', '-tag:v', 'hvc1']
            : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-tag:v', 'avc1'];
      await run(this.cfg.ffmpegPath, [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
        ...NET, '-f', 'concat', '-safe', '0', '-i', list,
        '-map', '0:v:0', ...(hasAudio ? ['-map', '0:a:0', '-c:a', 'aac', '-b:a', '128k'] : ['-an']),
        ...vcodec,
        '-movflags', '+faststart', '-f', 'mp4', part,
      ]);
      await rename(part, file);
      return file;
    } finally {
      await rm(list, { force: true });
      await rm(part, { force: true });
    }
  }

  /** Deletes cached MP4s older than MP4_CACHE_HOURS. Best effort. */
  private async sweep(): Promise<void> {
    try {
      const cutoff = Date.now() - this.cfg.mp4CacheHours * 3600_000;
      for (const name of await readdir(this.cacheDir)) {
        const p = path.join(this.cacheDir, name);
        const s = await stat(p);
        if (s.mtimeMs < cutoff && !this.building.has(p.replace(/\.(part|txt)$/, ''))) await rm(p, { force: true });
      }
    } catch {
      // ignore
    }
  }
}
