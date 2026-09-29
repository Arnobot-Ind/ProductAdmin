import type { LiveMessage } from '../../shared';
import type { PoolClient } from 'pg';
import { notifyChange } from '../notify';

/**
 * live: overwrite the robot's single live_state row — but ONLY if this message is newer than the
 * one currently shown (rule 7). A backlog replayed after reconnect therefore never rewinds the console.
 * A live message is a full snapshot: a field the robot does not send is shown as unknown (NULL).
 * Returns true if the state was replaced.
 */
export async function handleLive(tx: PoolClient, msg: LiveMessage): Promise<boolean> {
  const p = msg.payload;
  const pos = p.position;
  const res = await tx.query(
    `UPDATE live_state SET
       state_ts = $2,
       lat = $3, lon = $4, alt_m = $5, fix_quality = $6, hdop = $7, sats = $8, heading_deg = $9, speed_mps = $10,
       battery_pct = $11, battery_v = $12, charging = $13,
       signal_dbm = $14,
       temp_controller_c = $15, temp_battery_c = $16, temp_motors_c = $17,
       armed = $18, mode = $19,
       health_controller = $20, health_lidar = $21, health_cameras = $22, health_gps = $23,
       current_mission_id = $24,
       source_msg_id = $25,
       -- The odometer only grows; a live message without it keeps the last known value.
       odometer_m = coalesce($26, odometer_m),
       odometer_ts = CASE WHEN $26::float8 IS NULL THEN odometer_ts ELSE $2 END,
       updated_at = now()
     WHERE robot_id = $1 AND (state_ts IS NULL OR state_ts < $2)`,
    [
      msg.robot_id,
      msg.ts,
      pos?.lat ?? null,
      pos?.lon ?? null,
      pos?.alt_m ?? null,
      pos?.fix ?? null,
      pos?.hdop ?? null,
      pos?.sats ?? null,
      pos?.heading_deg ?? null,
      pos?.speed_mps ?? null,
      p.battery?.pct ?? null,
      p.battery?.voltage_v ?? null,
      p.battery?.charging ?? null,
      p.signal_dbm ?? null,
      p.temps_c?.controller ?? null,
      p.temps_c?.battery ?? null,
      p.temps_c?.motors ? JSON.stringify(p.temps_c.motors) : null,
      p.armed ?? null,
      p.mode ?? null,
      p.health?.controller ?? null,
      p.health?.lidar ?? null,
      p.health?.cameras ?? null,
      p.health?.gps ?? null,
      p.current_mission_id ?? null,
      msg.msg_id,
      p.odometer_m ?? null,
    ],
  );
  const replaced = (res.rowCount ?? 0) > 0;
  if (replaced) await notifyChange(tx, { kind: 'live', robot_id: msg.robot_id });
  return replaced;
}
