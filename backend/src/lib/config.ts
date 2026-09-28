export interface S3Settings {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle: boolean;
}

export interface ApiConfig {
  port: number;
  host: string;
  databaseUrl: string;
  adminOrigins: string[];
  sessionSecret: string;
  sessionTtlHours: number;
  cookieSecure: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  maxUploadBytes: number;
  /** Robot / GCS ingestion (POST /api/v1/ingest, optional MQTT). */
  ingest: {
    /** Max HTTP body (a reconnecting robot uploads backlog in batches). */
    bodyLimitBytes: number;
    rateLimitPerMinute: number;
    mqttUrl: string | null;
    mqttUsername: string | null;
    mqttPassword: string | null;
  };
  /** Documents / release packages. */
  storage: {
    driver: 'local' | 's3';
    localDir: string;
    s3: S3Settings;
  };
  /**
   * Video / sensor archive (camera recordings). Stored ONLY in S3 (its own bucket, separate from the
   * documents storage): the server keeps no video. Temporary files (MP4 exports) live in tempDir only.
   */
  archive: {
    s3: S3Settings;
    /** The one folder the server may write temporary archive files to (MP4 builds). Safe to delete. */
    tempDir: string;
    /** Largest single file PUT /archive/upload accepts. */
    uploadMaxBytes: number;
    /** Open session with no upload (and no heartbeat naming it) for this long → "interrupted". */
    interruptedAfterMin: number;
    /** Sensor chunk length written by cloud_sync (s). */
    chunkSec: number;
    /** Camera segment length when session.json does not say (s). The DVR records 10-minute segments. */
    videoSegmentSec: number;
    /** Robot clock offset in minutes: chunk names like 20260924_134701 are robot local time. */
    robotUtcOffsetMin: number;
    ffmpegPath: string;
    ffprobePath: string;
    /** Built MP4s are deleted this long after they were built. */
    mp4CacheHours: number;
  };
}

/** "+05:30" → 330 */
export function parseUtcOffset(value: string): number {
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(value.trim());
  if (!m) return 330;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

const positive = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

function driverOf(value: string | undefined, name: string): 'local' | 's3' {
  const d = value || 'local';
  if (d !== 'local' && d !== 's3') throw new Error(`${name} must be local or s3`);
  return d;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const required = (name: string): string => {
    const v = env[name];
    if (!v) throw new Error(`${name} is not set (see .env.example)`);
    return v;
  };
  const sessionSecret = required('SESSION_SECRET');
  if (sessionSecret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
  required('CREDENTIAL_ENCRYPTION_KEY'); // validated again by CredentialCipher (rule 11)

  // Rule 12: the GCS token must never be exposed through a NEXT_PUBLIC_ variable.
  if (env.NEXT_PUBLIC_GCS_API_TOKEN) throw new Error('NEXT_PUBLIC_GCS_API_TOKEN must not exist; use server-only GCS_API_TOKEN');

  const level = (env.LOG_LEVEL || 'info') as ApiConfig['logLevel'];
  return {
    port: Number(env.API_PORT || 4000),
    host: env.API_HOST || '0.0.0.0',
    databaseUrl: required('DATABASE_URL'),
    adminOrigins: (env.ADMIN_ORIGIN || 'http://localhost:3000').split(',').map((s) => s.trim()).filter(Boolean),
    sessionSecret,
    sessionTtlHours: Number(env.SESSION_TTL_HOURS || 12),
    cookieSecure: env.COOKIE_SECURE === 'true',
    logLevel: ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info',
    maxUploadBytes: Number(env.MAX_UPLOAD_MB || 1024) * 1024 * 1024,
    ingest: {
      bodyLimitBytes: Number(env.INGEST_BODY_LIMIT_MB || 20) * 1024 * 1024,
      rateLimitPerMinute: Number(env.INGEST_RATE_LIMIT_PER_MIN || 600),
      mqttUrl: env.MQTT_BROKER_URL || null,
      mqttUsername: env.MQTT_USERNAME || null,
      mqttPassword: env.MQTT_PASSWORD || null,
    },
    storage: {
      driver: driverOf(env.STORAGE_DRIVER, 'STORAGE_DRIVER'),
      localDir: env.STORAGE_LOCAL_DIR || './storage',
      s3: {
        endpoint: env.S3_ENDPOINT || undefined,
        region: env.S3_REGION || 'ap-south-1',
        bucket: env.S3_BUCKET || 'arnobot-pms',
        accessKeyId: env.S3_ACCESS_KEY || undefined,
        secretAccessKey: env.S3_SECRET_KEY || undefined,
        forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true',
      },
    },
    archive: {
      tempDir: env.ARCHIVE_TEMP_DIR || './tmp',
      s3: {
        endpoint: env.ARCHIVE_S3_ENDPOINT || undefined,
        region: env.ARCHIVE_S3_REGION || 'ap-south-1',
        bucket: env.ARCHIVE_S3_BUCKET || 'arnobot-saibya-data',
        // Empty on EC2: credentials come from the instance's IAM role.
        accessKeyId: env.ARCHIVE_S3_ACCESS_KEY || undefined,
        secretAccessKey: env.ARCHIVE_S3_SECRET_KEY || undefined,
        forcePathStyle: env.ARCHIVE_S3_FORCE_PATH_STYLE === 'true',
      },
      uploadMaxBytes: positive(env.ARCHIVE_UPLOAD_MAX_MB, 100) * 1024 * 1024,
      interruptedAfterMin: positive(env.ARCHIVE_INTERRUPTED_AFTER_MINUTES, 30),
      chunkSec: positive(env.ARCHIVE_CHUNK_SECONDS, 60),
      videoSegmentSec: positive(env.ARCHIVE_VIDEO_SEGMENT_SECONDS, 600),
      robotUtcOffsetMin: parseUtcOffset(env.ROBOT_UTC_OFFSET || '+05:30'),
      ffmpegPath: env.FFMPEG_PATH || 'ffmpeg',
      ffprobePath: env.FFPROBE_PATH || 'ffprobe',
      mp4CacheHours: positive(env.MP4_CACHE_HOURS, 24),
    },
  };
}
