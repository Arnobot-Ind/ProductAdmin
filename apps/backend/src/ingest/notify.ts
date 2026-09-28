import type { RealtimeChange } from '@arnobot/message-schema';
import type { PoolClient } from 'pg';

export const CHANGE_CHANNEL = 'pms_changes';

/**
 * pg_notify inside the ingest transaction: Postgres delivers it only on COMMIT, so realtime.ts
 * never announces data that was rolled back. The API LISTENs and fans out over Socket.IO.
 */
export async function notifyChange(tx: PoolClient, change: RealtimeChange): Promise<void> {
  await tx.query('SELECT pg_notify($1, $2)', [CHANGE_CHANNEL, JSON.stringify(change)]);
}
