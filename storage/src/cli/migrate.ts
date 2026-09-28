import { createPool } from '../pool';
import { migrateUp, migrationStatus } from '../migrate';

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'up';
  const pool = createPool(undefined, { application_name: 'pms-storage-migrate', max: 2 });
  try {
    if (cmd === 'status') {
      for (const m of await migrationStatus(pool)) {
        const mark = m.state === 'applied' ? '✓' : m.state === 'pending' ? '·' : '✗ MODIFIED';
        console.log(`${mark.padEnd(11)} ${m.file}${m.applied_at ? `  (${m.applied_at.toISOString()})` : ''}`);
      }
    } else if (cmd === 'up') {
      await migrateUp(pool);
    } else {
      throw new Error(`unknown command "${cmd}" (use: up | status)`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(`✗ ${(e as Error).message}`);
  process.exit(1);
});
