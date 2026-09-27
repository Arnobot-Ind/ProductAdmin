import type { EventMessage } from '@arnobot/message-schema';
import type { PoolClient } from 'pg';
import { notifyChange } from '../notify';

/** event: append-only. The msg_id is kept on the row, so one message = one event. */
export async function handleEvent(tx: PoolClient, msg: EventMessage): Promise<void> {
  const p = msg.payload;
  const res = await tx.query<{ id: string }>(
    `INSERT INTO events (msg_id, robot_id, ts, type, severity, code, message, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (msg_id) DO NOTHING
     RETURNING id`,
    [msg.msg_id, msg.robot_id, msg.ts, p.event_type, p.severity, p.code ?? null, p.message, p.data ? JSON.stringify(p.data) : null],
  );
  const id = res.rows[0]?.id;
  if (id) await notifyChange(tx, { kind: 'event', robot_id: msg.robot_id, id, severity: p.severity });
}
