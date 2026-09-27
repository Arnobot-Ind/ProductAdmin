import { buildApp } from './app';
import { createContext } from './context';
import { loadConfig } from './lib/config';
import { startRealtime } from './realtime';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const ctx = createContext(cfg);
  const app = await buildApp(ctx);
  const realtime = startRealtime(app.server, ctx, app.log);

  const shutdown = async (signal: string) => {
    app.log.info(`${signal}: shutting down`);
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
