# GCS → PMS Integration Checklist

**Goal:** the GCS backend (`C:\Users\Harshil\Desktop\GCS\backend`, on the robot's Jetson Orin) sends robot data and mission reports to the Arnobot PMS. The PMS stores them. The GCS is the only thing that talks to the PMS over the internet (spec §6, `docs/architecture.md`).

**Current state:** the GCS never sends anything to an HTTP API. Its only outbound path is `cloud_sync`, which does S3 file uploads. It is pull-only: Flask on :8080 serves the GCS UI, and nothing pushes. Details and file references: `gcs-current-state.md`.

**What the PMS already provides (done, tested):**

| PMS side | Where |
|---|---|
| Ingest endpoint `POST /api/v1/ingest` (single envelope or batch ≤ 500, oldest-first) | `apps/ingest`, port 4100 |
| Mission report endpoint `POST /api/v1/gcs/missions/{mission_id}/report` | `apps/ingest` |
| Per-GCS API key, revocable, rotatable without downtime | Admin panel → **Ingest** → *GCS clients* |
| Message contract + validation (unknown fields accepted) | `packages/message-schema`, `docs/message-contract.md` |
| Idempotency (`msg_id`), backlog ordering, rule-7 protection, clock guard | verified by `npm run qa` (section C) |
| A reference relay for the GCS (Python, stdlib only) | `docs/gcs/reference/pms_relay.py` |

---

## Phase 0: Decisions to confirm (owner: Arnobot robotics lead)

- [ ] **Robot IDs.** The GCS today calls its robot `saibya02` only in `CLOUD_SYNC_PREFIX` and the Cloudflare hostnames, and the `Bot` row uses a UUID. Confirm that each physical robot gets exactly one PMS Robot ID (e.g. `saibya02`), assigned **by the PMS** at registration. It is never the serial number (rule 1).
- [ ] **Transport.** HTTPS (recommended for v1; the PMS supports it now) or MQTT (the adapter exists; it needs a broker and per-robot ACLs).
- [ ] **Where the PMS ingest is reachable from the site.** For example `https://ingest.pms.arnobot.in` behind TLS (Cloudflare Tunnel or a reverse proxy). The GCS only needs **outbound 443**.
- [ ] **Mission ID format.** The PMS expects `{robot_id}-M{NNNN}` (spec §5). The GCS uses UUID4 today. Decision: the relay allocates the PMS ID and sends the GCS UUID as `external_id` (already supported).
- [ ] **Who uploads mission files** (video, MCAP, images) to S3, and which bucket. Today `cloud_sync` uploads *sessions* to `arnobot-saibya-data/saibya02/sessions/…`, which are **not linked to missions**.

## Phase 1: Register the robot and the GCS in the PMS (owner: PMS admin, ~10 min)

1. [ ] Admin panel → **Robots → Register**: product *Saibya*, serial number from the unit label, optional revision. Note the generated **Robot ID** (e.g. `saibya02`). Its robot key is shown once; you only need it if the robot ever connects directly.
2. [ ] Admin panel → **Ingest → GCS clients → New**: name `GCS saibya02 (site X)`, robots `saibya02`. **Copy the key now.** It is shown once and stored only as a SHA-256 hash.
3. [ ] Fill in **Connectivity** for the robot (SSH IP, OMNI IP, Wi-Fi router IP, tunnel hostname, camera IPs and stream URLs *without* passwords). Put the GCS's `NEXT_PUBLIC_CAMERA_DOMAIN` / `NEXT_PUBLIC_SERVER_DOMAIN` values in the two GCS domain fields.
4. [ ] Store the device secrets under **Credentials**: camera admin/operator ×4, RTSP URLs with credentials, SSH, OMNI, Wi-Fi, Cloudflare, `GCS_LOGIN_USER/PASS`, `GCS_API_TOKEN`. They are encrypted, and only `credential.reveal` holders can see them.

## Phase 2: Fix blockers in the GCS repository (owner: GCS developer)

| # | Change | Why | Where (GCS repo) |
|---|---|---|---|
| 2.1 | [ ] **Remove `NEXT_PUBLIC_GCS_API_TOKEN`** from the GCS frontend. Call the GCS API through a server-side route or proxy that injects `GCS_API_TOKEN`, and drop `?token=` on image URLs. | Spec §10 / PMS rule 12: the browser must never see the token. Today it is inlined into the JS bundle. | `frontend/gcs_frontend/src/lib/config/env.ts:58`, `server.ts:616`, Dockerfile build args 29-32, `AMPLIFY_DEPLOY.md:24` |
| 2.2 | [ ] **Rotate `GCS_API_TOKEN`** after 2.1 ships, because the old value is public in built bundles. Store the new one in PMS Credentials. | It has leaked | `credential.txt` |
| 2.3 | [ ] **Clock:** do not capture/send until NTP is synced (`timedatectl show -p NTPSynchronized` = yes). Add an RTC or a GPS time source if possible. | The Orin has no RTC. The PMS rejects `ts` < 2024 (`clock_unsynced`) or > now+5 min (`clock_ahead`) to protect live state. | `CustomNav/app/cli.py:704-711` has a partial guard |
| 2.4 | [ ] **All timestamps UTC ISO-8601 with `Z`**, never IST strings. | Spec §6: `ts` is UTC capture time | cloud_sync / DVR / `recordings.py:29` use IST |
| 2.5 | [ ] Add **version constants**: software version (e.g. a `VERSION` file per image) and firmware version (report it from the GIGA in the serial frame, or set it at flash time). | The envelope needs `sw_ver` / `fw_ver`, and software history keys on them | no source today |
| 2.6 | [ ] Add an **outbound HTTP client** (`requests` or stdlib `urllib`) to the relay image. | Nothing in the GCS can POST today | `requirements.txt` |

## Phase 3: Add the relay service to the GCS (owner: GCS developer)

Add a new container, `pms_relay`, to `backend/docker-compose.yml`. Start from **`docs/gcs/reference/pms_relay.py`** (Python 3.12, stdlib only, plus `psycopg2`, which the GCS already uses).

```yaml
  pms_relay:
    build: ./pms_relay            # copy docs/gcs/reference/pms_relay.py + a slim Dockerfile
    restart: unless-stopped
    depends_on: [db, gcs_data_handler]
    environment:
      TZ: UTC
      PMS_INGEST_URL: https://ingest.pms.arnobot.in      # no trailing slash
      PMS_ROBOT_ID: saibya02                               # the PMS Robot ID
      PMS_PRODUCT: saibya
      GCS_SW_VERSION: "1.4.0"
      GCS_FW_VERSION: "0.9.2"
      RELAY_OUTBOX: /data/outbox.sqlite
      RELAY_MAX_OUTBOX_GB: "75"                            # spec §11 local limit
      DB_HOST: db
      DB_NAME: arnobot_gcs_db
    env_file: [credential.txt]                             # PMS_INGEST_KEY, DB password: never in compose/git
    volumes: [pms_relay_data:/data]
    network_mode: bridge
```

Relay responsibilities. Each one maps to a PMS rule that the QA suite verifies on the PMS side:

- [ ] **3.1 Durable outbox (spec §11).** Every message is written to local SQLite *first*, with its `msg_id` (UUID made once, at capture) and capture `ts`. Delete it only when the PMS answers `stored` or `duplicate`. On `rejected` with `retryable: false`, log it and drop it (the PMS keeps a copy in *Ingest → Rejected*). On `retryable: true`, HTTP 5xx or a network error, keep it and back off (5 s → 5 min).
- [ ] **3.2 Reconnect order.** After a gap, send the *current* `live` first, then the backlog **oldest-first** in batches ≤ 500.
- [ ] **3.3 75 GB cap.** When the outbox exceeds `RELAY_MAX_OUTBOX_GB`, drop the **oldest telemetry** first. Never drop `event` or `mission` messages.
- [ ] **3.4 `hello`** at relay start and on every reconnect: `sw_ver`, `fw_ver`, `enabled_features`, `ips`.
- [ ] **3.5 `live` every 30 s** built from the `Bot` row. See the mapping table below.
- [ ] **3.6 `telemetry` every 30 s:** one batch of samples since the last cursor, from `UGVTelemetry` (every 2 s) and the `Bot` RPMs. Each sample carries its own `ts`.
- [ ] **3.7 `event` immediately:** the GCS alerts are *computed per poll* and never stored, so the relay must **edge-detect** them. Poll `/alerts` every 2–5 s (server-side, with `GCS_API_TOKEN`), emit an event when a code *appears*, and optionally an `info` event when it *clears*.
- [ ] **3.8 Missions:** send a `mission` start when `Bot.mission_id` becomes non-null or a `Mission.status` → active. Send a `mission` end plus the **GCS report** when an `apis_missionreport` row appears. Keep a cursor on `created_at`, or better, add an `synced_at` column or an outbox hook in `build_mission_report_row`, which exists in **two copies**: CustomNav and gcs_data_handler.
- [ ] **3.9 Mission ID mapping:** store `gcs_mission_uuid → saibya02-M0001` in the relay DB, and send the UUID as `external_id` in the GCS report.

### Field mapping (GCS → PMS `live` payload)

| PMS field | GCS source | Conversion |
|---|---|---|
| `position.lat/lon` | `Bot.lat`, `Bot.long` | degrees; skip `position` if either is null |
| `position.alt_m` | latest `UGVTelemetry.altitude` | metres |
| `position.fix` | `Bot.gps_fix` | `NO_FIX→none`, `SINGLE→3d`, `DGPS→dgps`, `RTK_FLOAT→rtk_float`, `RTK_FIX→rtk_fixed`, `STALE→none` (+ `health.gps = warning`) |
| `position.sats` | `Bot.satellites` | int |
| `position.hdop` | parsed in `drivers/gps_rtk.py:274-288`, **not stored** | persist it on `Bot` (new column) or omit |
| `position.heading_deg`, `speed_mps` | `Bot.yaw`, `Bot.actual_speed` | normalise yaw to 0–360 |
| `battery.voltage_v` / `pct` | `Bot.battery_volt` + `gcs_data_handler/config.py:46-127` | apply the **same** offset/smoothing/SoC as the GCS UI (`bv`/`bp`) |
| `battery.charging` | none | omit until a sensor exists |
| `signal_dbm` | `link_signal.py` gives a **0-100 %**, UART only (disabled) | **omit**. Do not send a percentage in a dBm field. Add a real modem RSSI (dBm) later. |
| `temps_c.controller` | `/sys/class/thermal/thermal_zone0/temp` / 1000 | °C |
| `temps_c.battery`, `motors` | none | omit |
| `armed` | `Bot.armed` | bool |
| `mode` | `Bot.mode` (+ `Bot.return_to_home`) | `auto` / `manual` / `rth` (lower-case) |
| `health.controller / lidar / gps` | `features/get/device_status/serializer.py:164-185` | map to `ok` / `warning` / `fault` |
| `health.cameras` | **none** | add a go2rtc stream probe (all 4 up → ok, some → warning, none → fault) |
| `current_mission_id` | `Bot.mission_id` (UUID) | map to the PMS mission id (3.9) |

### Alert → event mapping (starting point; tune with the robot team)

| GCS alert code(s) | `event_type` | `severity` |
|---|---|---|
| `GIGA_NOT_CONNECTED`, `LIDAR_NOT_AVAILABLE`, `NO_GPS` | `fault` | `critical` |
| `OVER_TEMPERATURE` | `alert` | `warning` (critical above a threshold) |
| `OUT_OF_RANGE`, `NO_MISSION_SELECTED` | `alert` | `info` |
| `HUMAN_/WILDLIFE_/FIRE_DETECTED_*` | `alert` | `warning` (`critical` for fire) |
| `CLOUD_SYNC_*` | `alert` | `info` |
| operator abort | `abort` | `warning` |
| return-to-home started | `rth` | `info` |
| software/firmware updated | `update` | `info` |

Always send the original code in `payload.code` (supported), plus details in `payload.data`.

### Mission report mapping (`POST /api/v1/gcs/missions/{pms_mission_id}/report`)

| PMS field | GCS source |
|---|---|
| `robot_id` | `PMS_ROBOT_ID` |
| `external_id` | `MissionReport.mission_id` (GCS UUID) |
| `name` | `MissionReport.mission_name` |
| `started_at`, `ended_at` | `MissionReport.started_at/ended_at` → UTC `Z` |
| `result` | `completed` / `aborted` (add **`failed`** for emergency stop, which **writes no report today**) |
| `end_reason` | new field: "operator abort", "RTH: low battery", "all waypoints reached"… |
| `distance_planned_m` | `MissionReport.distance_planned_m` |
| `distance_m` | ⚠ `distance_covered_m` is the sum of *reached waypoint legs*, not odometry. Send odometry (`Bot.total_distance_m` delta) if possible. |
| `planned_path` | `report_data.waypoints[]` → GeoJSON `LineString` `[[lon, lat], …]` |
| `actual_path` | `report_data.track[]` → GeoJSON (lon, lat). ⚠ capped at 20 k points, lost on crash, **missing for operator aborts**: persist the track incrementally. |
| `waypoints_total`, `waypoints_reached` | same names |
| `files` | none today. Once missions and cloud_sync sessions are linked: `[{kind:'video', s3_path:'s3://…'}]` |

## Phase 4: Test before going live (owner: GCS developer + PMS admin)

1. [ ] Run the relay with `--dry-run`. It prints envelopes without sending. Validate a few against `docs/message-contract.md`.
2. [ ] Point it at a **local PMS** (`PMS_INGEST_URL=http://<dev-pc>:4100`). The PMS ingest binds `0.0.0.0:4100` by default.
3. [ ] Admin panel → **Ingest**: messages arrive as *Accepted*, and **Rejected** is empty. Every rejection shows the exact reason.
4. [ ] Pull the network cable for 6 minutes. The robot shows **Offline** after 5 min. Reconnect: it shows **Online** at once (live first), and the backlog fills the telemetry charts at the correct times.
5. [ ] Run a short mission. It appears under the robot's **Missions**, with the planned (dashed) and actual (solid) paths on the map.
6. [ ] Revoke the GCS key in the panel. Within ~10 s the relay gets 401 and keeps buffering. Issue a new key, update `credential.txt`, and restart the relay: the backlog drains.

## Phase 5: Production (owner: ops)

- [ ] PMS ingest behind TLS. Only `/api/v1/ingest`, `/api/v1/gcs/*` and `/healthz` are exposed publicly; the admin API stays private.
- [ ] Per-site GCS key. Rotate it when a person with access leaves or a robot returns from outside Arnobot (spec §10). No scheduled rotation.
- [ ] Monitor *Ingest → Rejected* and robot status on the dashboard.

## Effort estimate

| Work | Estimate |
|---|---|
| Phase 2 blockers (2.1–2.6) | 1.5–2 days |
| Relay (Phase 3) starting from the reference | 2–3 days |
| New signals (hdop persisted, camera health, emergency-stop report, persisted track, end_reason) | 2–3 days |
| Testing (Phase 4) | 1 day |
