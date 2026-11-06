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
import { createHash } from 'node:crypto';
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
/** Pieces made at the same time. More requests wait, so playback cannot use up the server. */
const MAX_PIECE_JOBS = 4;

function safe(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, '_');
}

/** Download name: saibya02_20260926_112634_ab12_cam1.mp4 */
export function mp4Name(robotId: string, sessionId: string, camera: string): string {
  return `${safe(robotId)}_${safe(sessionId)}_${safe(camera)}.mp4`;
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${path.basename(cmd)} exited ${code}: ${err.trim().slice(-500)}`))));
  });
}

export class Mp4Builder {
  private readonly building = new Map<string, Promise<string>>();
  private readonly cacheDir: string;
  private readonly pieceWaiters: (() => void)[] = [];
  private pieceJobs = 0;
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

  /** One short piece of a recording in low quality, made when first asked for and kept for MP4_CACHE_HOURS. */
  async lowPiece(key: string, size: number, startS: number, durationS: number): Promise<string> {
    const hash = createHash('sha256').update(`${key}:${size}:${startS}:${durationS}`).digest('hex').slice(0, 32);
    const file = path.join(this.cacheDir, `piece__${hash}.ts`);
    try {
      await stat(file);
      return file;
    } catch {
      // not made yet
    }
    let job = this.building.get(file);
    if (!job) {
      job = this.makePiece(key, startS, durationS, file).finally(() => this.building.delete(file));
      this.building.set(file, job);
    }
    return job;
  }

  private async makePiece(key: string, startS: number, durationS: number, file: string): Promise<string> {
    if (this.pieceJobs >= MAX_PIECE_JOBS) await new Promise<void>((go) => this.pieceWaiters.push(go));
    else this.pieceJobs += 1;
    const part = `${file}.part`;
    try {
      await mkdir(this.cacheDir, { recursive: true });
      void this.sweep();
      await run(this.cfg.ffmpegPath, [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
        ...NET, '-ss', String(startS), '-i', await this.storage.ffmpegInput(key), '-t', String(durationS),
        '-map', '0:v:0', '-map', '0:a:0?', '-c:a', 'aac', '-b:a', '64k',
        ...LOW_VIDEO,
        // Pieces of one file continue each other's timeline, so the player sees one unbroken video.
        '-output_ts_offset', String(startS), '-muxdelay', '0', '-f', 'mpegts', part,
      ]);
      await rename(part, file);
      return file;
    } finally {
      await rm(part, { force: true });
      const next = this.pieceWaiters.shift();
      if (next) next();
      else this.pieceJobs -= 1;
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
