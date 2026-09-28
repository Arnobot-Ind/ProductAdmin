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
  storage: {
    driver: 'local' | 's3';
    localDir: string;
    s3: { endpoint?: string; region: string; bucket: string; accessKeyId?: string; secretAccessKey?: string; forcePathStyle: boolean };
  };
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

  const driver = (env.STORAGE_DRIVER || 'local') as 'local' | 's3';
  if (driver !== 'local' && driver !== 's3') throw new Error('STORAGE_DRIVER must be local or s3');
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
      driver,
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
  };
}
