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

  const shutdown = async (signal: string) => {
    app.log.info(`${signal}: shutting down`);
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
