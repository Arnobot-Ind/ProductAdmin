/**
 * Robot message contract, spec §6. See docs/message-contract.md.
 *
 * Compatibility rules (CLAUDE.md rule 3):
 *  - every object is a `looseObject`: unknown fields are accepted and preserved, never rejected;
 *  - fields are only ever ADDED; nothing here may be renamed or removed;
 *  - payload fields are optional unless the message is meaningless without them.
 */
import { z } from 'zod';
import {
  EVENT_SEVERITIES,
  EVENT_TYPES,
  HEALTH_LEVELS,
  MESSAGE_TYPES,
  MISSION_FILE_KINDS,
  MISSION_RESULTS,
  SUPPORTED_MESSAGE_VERSIONS,
} from './constants';

/** Lower-cases strings before enum checks so `"OK"` and `"ok"` are the same value. */
const lowerEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess((v) => (typeof v === 'string' ? v.trim().toLowerCase() : v), z.enum(values));

/** ISO-8601 with Z or an offset. Normalised to UTC by the consumer. */
export const isoTimestamp = z.iso.datetime({ offset: true });
const finite = z.number().finite();
const lat = finite.min(-90).max(90);
const lon = finite.min(-180).max(180);

export const robotIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*[0-9]+$/, 'robot_id must be product code + running number, e.g. saibya02');

export const healthLevel = lowerEnum(HEALTH_LEVELS);

export const geoLineString = z.looseObject({
  type: z.literal('LineString'),
  /** [lon, lat] or [lon, lat, alt] per GeoJSON (RFC 7946). */
  coordinates: z.array(z.array(finite).min(2).max(3)),
});
export type GeoLineString = z.infer<typeof geoLineString>;

// ── payloads ────────────────────────────────────────────────────────────────

export const helloPayload = z.looseObject({
  boot_id: z.string().optional(),
  sw_ver: z.string().optional(),
  fw_ver: z.string().optional(),
  enabled_features: z.array(z.string()).optional(),
  ips: z.record(z.string(), z.string()).optional(),
});

const tempsC = z.looseObject({
  controller: finite.optional(),
  battery: finite.optional(),
  motors: z.record(z.string(), finite).optional(),
});

export const livePayload = z.looseObject({
  position: z
    .looseObject({
      lat,
      lon,
      alt_m: finite.optional(),
      fix: z.string().optional(),
      hdop: finite.optional(),
      sats: z.number().int().optional(),
      heading_deg: finite.optional(),
      speed_mps: finite.optional(),
    })
    .optional(),
  battery: z
    .looseObject({
      pct: finite.min(0).max(100).optional(),
      voltage_v: finite.optional(),
      charging: z.boolean().optional(),
    })
    .optional(),
  signal_dbm: finite.optional(),
  temps_c: tempsC.optional(),
  armed: z.boolean().optional(),
  mode: z.string().optional(),
  health: z
    .looseObject({
      controller: healthLevel.optional(),
      lidar: healthLevel.optional(),
      cameras: healthLevel.optional(),
      gps: healthLevel.optional(),
    })
    .optional(),
  current_mission_id: z.string().nullable().optional(),
  /** The robot's lifetime odometer (m): all driving, not only missions. */
  odometer_m: finite.nonnegative().optional(),
});

const sampleTs = { ts: isoTimestamp };
export const telemetryPayload = z.looseObject({
  gps: z
    .array(
      z.looseObject({
        ...sampleTs,
        lat,
        lon,
        alt_m: finite.optional(),
        speed_mps: finite.optional(),
        heading_deg: finite.optional(),
        fix: z.string().optional(),
      }),
    )
    .optional(),
  encoders: z
    .array(
      z.looseObject({
        ...sampleTs,
        encoder: z.string().min(1),
        ticks: z.number().int().optional(),
        velocity_mps: finite.optional(),
        rpm: finite.optional(),
      }),
    )
    .optional(),
  battery: z
    .array(
      z.looseObject({
        ...sampleTs,
        pct: finite.optional(),
        voltage_v: finite.optional(),
        current_a: finite.optional(),
        temp_c: finite.optional(),
      }),
    )
    .optional(),
  health: z
    .array(
      z.looseObject({
        ...sampleTs,
        controller: healthLevel.optional(),
        lidar: healthLevel.optional(),
        cameras: healthLevel.optional(),
        gps: healthLevel.optional(),
        temps_c: tempsC.optional(),
      }),
    )
    .optional(),
});

export const eventPayload = z.looseObject({
  event_type: lowerEnum(EVENT_TYPES),
  severity: lowerEnum(EVENT_SEVERITIES),
  message: z.string().min(1).max(4000),
  /** Optional machine code, e.g. LIDAR_NOT_AVAILABLE (GCS alert codes). */
  code: z.string().max(200).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

export const missionFileRef = z.looseObject({
  kind: lowerEnum(MISSION_FILE_KINDS),
  s3_path: z.string().min(1).max(2048),
  size_bytes: z.number().int().nonnegative().optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  content_type: z.string().optional(),
});
export type MissionFileRef = z.infer<typeof missionFileRef>;

const missionCommon = {
  mission_id: z.string().min(1).max(200),
  name: z.string().max(500).optional(),
  started_at: isoTimestamp.optional(),
};
export const missionPayload = z.discriminatedUnion('phase', [
  z.looseObject({ phase: z.literal('start'), ...missionCommon }),
  z.looseObject({
    phase: z.literal('end'),
    ...missionCommon,
    ended_at: isoTimestamp.optional(),
    distance_m: finite.nonnegative().optional(),
    result: lowerEnum(MISSION_RESULTS),
    end_reason: z.string().max(2000).optional(),
    actual_path: geoLineString.optional(),
    files: z.array(missionFileRef).optional(),
  }),
]);

export const payloadSchemas = {
  hello: helloPayload,
  live: livePayload,
  telemetry: telemetryPayload,
  event: eventPayload,
  mission: missionPayload,
} as const;

// ── envelope ────────────────────────────────────────────────────────────────

/** The fixed envelope (spec §6). The payload is validated separately per `type`. */
export const envelopeSchema = z.looseObject({
  v: z.number().int().refine((v) => (SUPPORTED_MESSAGE_VERSIONS as readonly number[]).includes(v), {
    message: `unsupported format version; supported: ${SUPPORTED_MESSAGE_VERSIONS.join(', ')}`,
  }),
  msg_id: z.guid(),
  robot_id: robotIdSchema,
  product: z.string().min(1),
  sw_ver: z.string().optional(),
  fw_ver: z.string().optional(),
  ts: isoTimestamp,
  type: z.enum(MESSAGE_TYPES),
  payload: z.unknown(),
});

export type HelloPayload = z.infer<typeof helloPayload>;
export type LivePayload = z.infer<typeof livePayload>;
export type TelemetryPayload = z.infer<typeof telemetryPayload>;
export type EventPayload = z.infer<typeof eventPayload>;
export type MissionPayload = z.infer<typeof missionPayload>;

/** Declared explicitly: Omit<> over a looseObject's index signature would erase the field types. */
export interface EnvelopeBase {
  v: number;
  msg_id: string;
  robot_id: string;
  product: string;
  sw_ver?: string;
  fw_ver?: string;
  /** capture time, ISO-8601 */
  ts: string;
  [extra: string]: unknown;
}
export type HelloMessage = EnvelopeBase & { type: 'hello'; payload: HelloPayload };
export type LiveMessage = EnvelopeBase & { type: 'live'; payload: LivePayload };
export type TelemetryMessage = EnvelopeBase & { type: 'telemetry'; payload: TelemetryPayload };
export type EventMessage = EnvelopeBase & { type: 'event'; payload: EventPayload };
export type MissionMessage = EnvelopeBase & { type: 'mission'; payload: MissionPayload };
export type RobotMessage = HelloMessage | LiveMessage | TelemetryMessage | EventMessage | MissionMessage;

export type ParseResult =
  | { ok: true; message: RobotMessage }
  | { ok: false; msg_id?: string; error: string; details?: unknown };

/**
 * Validate a raw envelope and its typed payload. Never throws.
 * Unknown fields survive (the caller stores the raw JSON as received).
 */
export function parseRobotMessage(raw: unknown): ParseResult {
  const env = envelopeSchema.safeParse(raw);
  const msgId =
    raw && typeof raw === 'object' && typeof (raw as Record<string, unknown>).msg_id === 'string'
      ? ((raw as Record<string, unknown>).msg_id as string)
      : undefined;
  if (!env.success) {
    return { ok: false, msg_id: msgId, error: 'invalid_envelope', details: z.treeifyError(env.error) };
  }
  const schema = payloadSchemas[env.data.type];
  const payload = schema.safeParse(env.data.payload ?? {});
  if (!payload.success) {
    return { ok: false, msg_id: msgId, error: `invalid_${env.data.type}_payload`, details: z.treeifyError(payload.error) };
  }
  return { ok: true, message: { ...env.data, payload: payload.data } as RobotMessage };
}

// ── GCS → PMS mission report (server to server, not a robot message) ────────

export const gcsMissionReportSchema = z.looseObject({
  v: z.number().int().optional(),
  robot_id: robotIdSchema,
  name: z.string().max(500).optional(),
  started_at: isoTimestamp.optional(),
  ended_at: isoTimestamp.optional(),
  distance_m: finite.nonnegative().optional(),
  distance_planned_m: finite.nonnegative().optional(),
  result: lowerEnum(MISSION_RESULTS).optional(),
  end_reason: z.string().max(2000).optional(),
  planned_path: geoLineString.optional(),
  actual_path: geoLineString.optional(),
  waypoints_total: z.number().int().nonnegative().optional(),
  waypoints_reached: z.number().int().nonnegative().optional(),
  /** Per-waypoint results, shown in the Mission Report PDF. */
  waypoints: z
    .array(
      z.looseObject({
        sequence: z.number().int().optional(),
        label: z.string().max(200).optional(),
        lat: finite.min(-90).max(90),
        lng: finite.min(-180).max(180),
        reached: z.boolean().optional(),
        reached_at: isoTimestamp.nullable().optional(),
      }),
    )
    .max(5000)
    .optional(),
  files: z.array(missionFileRef).optional(),
});
export type GcsMissionReport = z.infer<typeof gcsMissionReportSchema>;
