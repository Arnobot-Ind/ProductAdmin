export interface IngestConfig {
  port: number;
  host: string;
  databaseUrl: string;
  logLevel: string;
  mqttUrl: string | null;
  mqttUsername: string | null;
  mqttPassword: string | null;
  /** Max HTTP body (a reconnecting robot uploads backlog in batches). */
  bodyLimitBytes: number;
  rateLimitPerMinute: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): IngestConfig {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  return {
    port: Number(env.INGEST_PORT || 4100),
    host: env.INGEST_HOST || '0.0.0.0',
    databaseUrl: env.DATABASE_URL,
    logLevel: env.LOG_LEVEL || 'info',
    mqttUrl: env.MQTT_BROKER_URL || null,
    mqttUsername: env.MQTT_USERNAME || null,
    mqttPassword: env.MQTT_PASSWORD || null,
    bodyLimitBytes: Number(env.INGEST_BODY_LIMIT_MB || 20) * 1024 * 1024,
    rateLimitPerMinute: Number(env.INGEST_RATE_LIMIT_PER_MIN || 600),
  };
}
