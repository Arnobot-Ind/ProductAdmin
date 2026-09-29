import type { FastifyBaseLogger } from 'fastify';
import { buildApp } from './app';
import { createContext } from './context';
import { startMqtt } from './ingest/mqtt';
import { IngestPipeline } from './ingest/pipeline';
import { loadConfig } from './lib/config';
import { startRealtime } from './realtime';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const ctx = createContext(cfg);
  let pipeline: IngestPipeline | undefined;
  const app = await buildApp(ctx, (log) => (pipeline = new IngestPipeline(ctx.db, log)));
  const realtime = startRealtime(app.server, ctx, app.log);
  const mqttClient = startMqtt(cfg.ingest, pipeline!, app.log);
  ctx.runtime.mqttConnected = () => (mqttClient ? mqttClient.connected : null);

  const archiveSync = startArchiveSync(ctx, app.log);

  const shutdown = async (signal: string) => {
    app.log.info(`${signal}: shutting down`);
    archiveSync.stop();
    mqttClient?.end();
    await realtime.close();
    await app.close();
    await ctx.db.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: cfg.port, host: cfg.host });
}

/**
 * Keeps the archive index in step with the bucket: cloud_sync may write straight to S3, and data that was
 * there before the PMS existed (e.g. saibya02's recordings) must show up without a manual re-index.
 * Incremental (complete sessions are skipped), never two runs at once, failures only logged.
 */
function startArchiveSync(ctx: ReturnType<typeof createContext>, log: FastifyBaseLogger): { stop: () => void } {
  const minutes = ctx.cfg.archive.syncMinutes;
  if (!minutes) return { stop: () => undefined };
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      // Unfinished sessions are re-checked on every pass (they may still be uploading); only real growth is logged.
      const before = await ctx.archive.stats();
      await ctx.archive.reindex(null, false);
      const after = await ctx.archive.stats();
      if (after.files !== before.files || after.sessions !== before.sessions) {
        log.info({ sessions: after.sessions - before.sessions, files: after.files - before.files }, 'archive sync: indexed new data from the bucket');
      }
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'archive sync failed (bucket unreachable or no credentials?); will retry');
    } finally {
      running = false;
    }
  };
  const first = setTimeout(run, 5_000);
  const timer = setInterval(run, minutes * 60_000);
  timer.unref();
  first.unref();
  return { stop: () => (clearTimeout(first), clearInterval(timer)) };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
