import type { TelemetryMessage } from '@arnobot/message-schema';
import type { PoolClient } from 'pg';
import { notifyChange } from '../notify';

/**
 * telemetry: bulk-append samples to the four sensor tables with one INSERT … SELECT unnest(...) each.
 * Each sample has its own capture ts. ON CONFLICT DO NOTHING is the backstop against a sample
 * re-sent inside a different message (the message itself is already de-duplicated by msg_id).
 * Returns the number of samples stored.
 */
export async function handleTelemetry(tx: PoolClient, msg: TelemetryMessage): Promise<number> {
  const p = msg.payload;
  const r = msg.robot_id;
  let stored = 0;

  if (p.gps?.length) {
    const s = p.gps;
    const res = await tx.query(
      `INSERT INTO telemetry_gps (robot_id, ts, lat, lon, alt_m, speed_mps, heading_deg, fix_quality, msg_id)
       SELECT $1::text, *, $9::uuid FROM unnest($2::timestamptz[], $3::float8[], $4::float8[], $5::real[], $6::real[], $7::real[], $8::text[])
       ON CONFLICT DO NOTHING`,
      [
        r,
        s.map((x) => x.ts),
        s.map((x) => x.lat),
        s.map((x) => x.lon),
        s.map((x) => x.alt_m ?? null),
        s.map((x) => x.speed_mps ?? null),
        s.map((x) => x.heading_deg ?? null),
        s.map((x) => x.fix ?? null),
        msg.msg_id,
      ],
    );
    stored += res.rowCount ?? 0;
  }

  if (p.encoders?.length) {
    const s = p.encoders;
    const res = await tx.query(
      `INSERT INTO telemetry_encoder (robot_id, ts, encoder, ticks, velocity_mps, rpm, msg_id)
       SELECT $1::text, *, $7::uuid FROM unnest($2::timestamptz[], $3::text[], $4::int8[], $5::real[], $6::real[])
       ON CONFLICT DO NOTHING`,
      [r, s.map((x) => x.ts), s.map((x) => x.encoder), s.map((x) => x.ticks ?? null), s.map((x) => x.velocity_mps ?? null), s.map((x) => x.rpm ?? null), msg.msg_id],
    );
    stored += res.rowCount ?? 0;
  }

  if (p.battery?.length) {
    const s = p.battery;
    const res = await tx.query(
      `INSERT INTO telemetry_battery (robot_id, ts, pct, voltage_v, current_a, temp_c, msg_id)
       SELECT $1::text, *, $7::uuid FROM unnest($2::timestamptz[], $3::real[], $4::real[], $5::real[], $6::real[])
       ON CONFLICT DO NOTHING`,
      [r, s.map((x) => x.ts), s.map((x) => x.pct ?? null), s.map((x) => x.voltage_v ?? null), s.map((x) => x.current_a ?? null), s.map((x) => x.temp_c ?? null), msg.msg_id],
    );
    stored += res.rowCount ?? 0;
  }

  if (p.health?.length) {
    const s = p.health;
    const res = await tx.query(
      `INSERT INTO telemetry_health (robot_id, ts, health_controller, health_lidar, health_cameras, health_gps,
                                     temp_controller_c, temp_battery_c, temp_motors_c, msg_id)
       SELECT $1::text, t.ts, t.hc, t.hl, t.hcam, t.hg, t.tc, t.tb, t.tm::jsonb, $10::uuid
       FROM unnest($2::timestamptz[], $3::text[], $4::text[], $5::text[], $6::text[], $7::real[], $8::real[], $9::text[])
            AS t(ts, hc, hl, hcam, hg, tc, tb, tm)
       ON CONFLICT DO NOTHING`,
      [
        r,
        s.map((x) => x.ts),
        s.map((x) => x.controller ?? null),
        s.map((x) => x.lidar ?? null),
        s.map((x) => x.cameras ?? null),
        s.map((x) => x.gps ?? null),
        s.map((x) => x.temps_c?.controller ?? null),
        s.map((x) => x.temps_c?.battery ?? null),
        s.map((x) => (x.temps_c?.motors ? JSON.stringify(x.temps_c.motors) : null)),
        msg.msg_id,
      ],
    );
    stored += res.rowCount ?? 0;
  }

  if (stored) await notifyChange(tx, { kind: 'telemetry', robot_id: r });
  return stored;
}
