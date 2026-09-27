# Robot Message Contract (v = 1)

Implemented once in `packages/message-schema/src/messages.ts` (Zod 4). Used by `apps/ingest`, the simulator, the reference GCS relay (`gcs/reference/pms_relay.py`) and the UI types.
The envelope is fixed by spec §6. **Payload field names below are our proposal.** The spec lists only what each payload contains. Confirm them with the robot team before real robots connect (see `decisions.md`).

## Compatibility rules

- Fields are **added only**, never renamed or removed. A breaking change means bumping `v` and supporting both versions.
- Zod schemas use `.passthrough()`. Unknown fields are kept in `raw` and never cause a rejection.
- Optional by default: a robot without a given sensor omits the field; it doesn't send junk.
- Units: metres, m/s, degrees, °C, %, volts, dBm.

## Envelope

```jsonc
{
  "v": 1,
  "msg_id": "uuid",               // unique, generated on the robot, stable across retries
  "robot_id": "saibya01",
  "product": "saibya",            // products.code
  "sw_ver": "1.4.0",
  "fw_ver": "0.9.2",
  "ts": "2026-09-26T10:30:00.000Z", // capture time, UTC
  "type": "hello|live|telemetry|event|mission",
  "payload": { }
}
```
Transport: `POST /api/v1/ingest` on the ingest service, `Authorization: Bearer <ingest key>`, body = one envelope or an array of up to 500 (a backlog is sent oldest-first). HTTP 401 means a bad/revoked key. Otherwise HTTP 200, with a result **per message**:

```json
{ "results": [ { "msg_id": "…", "status": "stored" },
               { "msg_id": "…", "status": "duplicate" },
               { "msg_id": "…", "status": "rejected", "error": "clock_ahead", "retryable": false } ],
  "summary": { "stored": 1, "duplicate": 1, "rejected": 1 } }
```

| Sender action | When |
|---|---|
| delete the local copy | `stored` or `duplicate` |
| log + drop (the PMS keeps a copy in *Ingest → Rejected*) | `rejected` with `retryable: false` |
| keep and retry with backoff | `retryable: true`, HTTP 5xx / 429, network error |

Rejection codes: `invalid_envelope`, `invalid_<type>_payload` (with Zod details), `unknown_robot`, `robot_deleted`, `robot_not_allowed` (key may not speak for this robot), `product_mismatch`, `mission_robot_mismatch`, `constraint_violation`, **`clock_ahead`** (a `ts` more than 5 min in the future: it would freeze live state), **`clock_unsynced`** (a `ts` before 2024: NTP not synced), `internal_error` (retryable).

Validation details: `msg_id` any UUID; `robot_id` = lowercase product code + digits; `ts` ISO-8601 with `Z` or an offset (stored as UTC); `v` ∈ supported versions (1). Enum values are case-insensitive (`"FAULT"` = `"fault"`).

## hello: at boot and after every reconnect

```json
{ "boot_id": "uuid", "sw_ver": "1.4.0", "fw_ver": "0.9.2",
  "enabled_features": ["rtk", "obstacle_avoidance"],
  "ips": { "lan": "192.168.1.20", "tunnel_hostname": "saibya01.example.net", "omni": "192.168.1.30" } }
```
Effects: insert a `software_history` row if the version or features changed; update `connectivity.reported_ips`.

## live: every 30 s

```json
{
  "position": { "lat": 23.0225, "lon": 72.5714, "alt_m": 53.2, "fix": "rtk_fixed", "hdop": 0.7, "sats": 18 },
  "battery": { "pct": 81.5, "voltage_v": 25.1, "charging": false },
  "signal_dbm": -67,
  "temps_c": { "controller": 48.2, "battery": 31.0, "motors": { "left": 40.1, "right": 41.3 } },
  "armed": true,
  "mode": "auto",
  "health": { "controller": "ok", "lidar": "ok", "cameras": "warning", "gps": "ok" },
  "current_mission_id": "saibya01-M0007"
}
```
`fix`: known values `none | 2d | 3d | dgps | rtk_float | rtk_fixed` (other strings are stored as-is). `health.*` ∈ `ok | warning | fault`. `position` may also carry `heading_deg` and `speed_mps`. A live message is a full snapshot: omitted fields are shown as unknown.

## telemetry: batch every 30 s

```json
{
  "gps":      [{ "ts": "…", "lat": 0, "lon": 0, "alt_m": 0, "speed_mps": 0, "heading_deg": 0, "fix": "3d" }],
  "encoders": [{ "ts": "…", "encoder": "left", "ticks": 123456, "velocity_mps": 0.8, "rpm": 120 }],
  "battery":  [{ "ts": "…", "pct": 80.9, "voltage_v": 25.0, "current_a": 4.2, "temp_c": 31 }],
  "health":   [{ "ts": "…", "controller": "ok", "lidar": "ok", "cameras": "ok", "gps": "ok",
                 "temps_c": { "controller": 48, "battery": 31, "motors": { "left": 40, "right": 41 } } }]
}
```
Each sample has its own `ts`. The envelope `ts` is the batch time.

## event: immediately

```json
{ "event_type": "fault", "severity": "critical", "message": "LiDAR not responding",
  "code": "LIDAR_NOT_AVAILABLE", "data": { "device": "lidar" } }
```
`event_type` ∈ `abort | rth | alert | fault | update`. `severity` ∈ `info | warning | critical`. `code` (optional) carries the source system's alert code, e.g. the GCS alert codes.

## mission: at start and at end

```jsonc
// start
{ "phase": "start", "mission_id": "saibya01-M0007", "name": "North fence patrol", "started_at": "…" }
// end
{ "phase": "end", "mission_id": "saibya01-M0007", "started_at": "…", "ended_at": "…",
  "distance_m": 1520.4, "result": "completed", "end_reason": "all waypoints reached",
  "actual_path": { "type": "LineString", "coordinates": [[72.57, 23.02], [72.58, 23.03]] },
  "files": [{ "kind": "video", "s3_path": "s3://arnobot-pms/missions/saibya01-M0007/cam1.mp4" },
            { "kind": "mcap",  "s3_path": "s3://arnobot-pms/missions/saibya01-M0007/run.mcap" }] }
```
`result` ∈ `completed | failed | aborted` (required on `end`). File refs may also carry `size_bytes`, `sha256`, `content_type`. A mission id belongs to one robot forever: a message placing it on another robot is rejected.

## GCS → PMS mission report (not a robot message)

`POST /api/v1/gcs/missions/{mission_id}/report` on the ingest service, `Authorization: Bearer <PMS ingest key of this GCS>` (server-to-server; this is **not** the GCS's own `GCS_API_TOKEN`). Response 201 (created) / 200 (merged); 403 if the key doesn't cover the robot; 409 if the mission belongs to another robot.

```json
{ "robot_id": "saibya01", "external_id": "<GCS mission uuid>", "name": "…",
  "started_at": "…", "ended_at": "…", "distance_m": 1520.4, "distance_planned_m": 1500,
  "waypoints_total": 8, "waypoints_reached": 8, "result": "completed", "end_reason": "…",
  "planned_path": { "type": "LineString", "coordinates": [[72.57, 23.02]] },
  "files": [ … ] }
```
Merged into the same `missions` row. The robot's `actual_path`, `distance_m` and `result` win; the GCS's `planned_path`, `distance_planned_m` and waypoint counts win. The GCS's `actual_path` is used only if the robot never sent one. Re-sending a report is idempotent.

## MQTT (optional)

When `MQTT_BROKER_URL` is set, ingest subscribes to `arnobot/v1/{robot_id}/{type}` (QoS 1) and publishes each result to `arnobot/v1/{robot_id}/ack`. The broker authenticates clients, and its ACL must restrict each client to its own `robot_id` topics.
