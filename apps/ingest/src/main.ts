import { createPool } from '@arnobot/db';
import { loadConfig } from './config';
import { startMqtt } from './mqtt';
import { IngestPipeline } from './pipeline';
import { buildServer } from './server';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createPool(config.databaseUrl, { application_name: 'pms-ingest', max: 10 });
  const app = await buildServer(db, config);
  const mqttClient = startMqtt(config, new IngestPipeline(db, app.log), app.log);

  const shutdown = async (signal: string) => {
    app.log.info(`${signal}: shutting down`);
    mqttClient?.end();
    await app.close();
    await db.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: config.port, host: config.host });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
