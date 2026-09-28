import type { HelloMessage } from '@arnobot/message-schema';
import type { PoolClient } from 'pg';
import { notifyChange } from '../notify';

/**
 * hello (boot / reconnect): append a software_history row only when versions or features CHANGE
 * compared with the state just before this message's ts (so backlog lands in the right place),
 * and record reported IPs next to (never over) the admin-entered connectivity.
 */
export async function handleHello(tx: PoolClient, msg: HelloMessage): Promise<void> {
  const p = msg.payload;
  const swVer = p.sw_ver ?? msg.sw_ver ?? null;
  const fwVer = p.fw_ver ?? msg.fw_ver ?? null;
  const features = p.enabled_features ? [...new Set(p.enabled_features)].sort() : null;

  const prev = (
    await tx.query<{ sw_ver: string | null; fw_ver: string | null; enabled_features: string[] | null }>(
      `SELECT sw_ver, fw_ver, enabled_features FROM software_history
       WHERE robot_id = $1 AND reported_at <= $2 ORDER BY reported_at DESC, created_at DESC LIMIT 1`,
      [msg.robot_id, msg.ts],
    )
  ).rows[0];

  const changed =
    !prev ||
    prev.sw_ver !== swVer ||
    prev.fw_ver !== fwVer ||
    JSON.stringify(prev.enabled_features ?? null) !== JSON.stringify(features);

  if (changed) {
    await tx.query(
      `INSERT INTO software_history (robot_id, sw_ver, fw_ver, enabled_features, boot_id, reported_at, source_msg_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [msg.robot_id, swVer, fwVer, features ? JSON.stringify(features) : null, p.boot_id ?? null, msg.ts, msg.msg_id],
    );
    await notifyChange(tx, { kind: 'software', robot_id: msg.robot_id });
  }

  if (p.ips && Object.keys(p.ips).length) {
    await tx.query(
      `UPDATE connectivity SET reported_ips = $2, reported_at = $3
       WHERE robot_id = $1 AND (reported_at IS NULL OR reported_at < $3)`,
      [msg.robot_id, JSON.stringify(p.ips), msg.ts],
    );
  }
}
