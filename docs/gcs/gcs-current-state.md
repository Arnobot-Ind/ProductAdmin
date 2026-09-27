# GCS Backend: Current State (as analysed on 2026-09-27)

Read-only analysis of `C:\Users\Harshil\Desktop\GCS\backend` (paths relative to it). Input for `gcs-integration-checklist.md`. **No secret values are recorded here.**

## Architecture today

- Runs on a Jetson Orin via `gcs-stack.service` → `docker compose up -d` from `/home/arnobot/GCS`.
- Services (`docker-compose.yml`):

| Service | Lines | What it does |
|---|---|---|
| `db` | 2-24 | postgres:16-alpine, DB `arnobot_gcs_db`, `127.0.0.1:5432`. Tables are prefixed `apis_` (Django-owned models). |
| `arduino_reader` (CustomNav) | 26-77 | Nav/EKF loop. Reads the Arduino GIGA (serial), LiDAR and RTK GNSS. Writes the single `Bot` row at ~10 Hz and `UGVTelemetry` every 2 s. |
| `gcs_data_handler` | 79-180 | Flask + waitress on :8080. **Request/response only, never pushes.** |
| `human_detector` + go2rtc | 190-310 | |
| `cloudflared` | 334-376 | `api-saibya02-arnobot.arnobot.in` → :8080; `cam-saibya02-…` → go2rtc. |
| `dvr_recorder` | 387-404 | |
| `cloud_sync` | 430-459 | Sessions → S3 via boto3. |
| `slam_builder` | 469-501 | |

- Language: Python 3.12 (SQLAlchemy 2, Flask, waitress, pyserial, boto3).
- No ROS, MQTT or websocket push. **No outbound HTTP client library** (`requests` isn't in any requirements).

## Existing outbound path: `cloud_sync`

- Session-based uploads of camera `.ts`, LiDAR `.npz` and IMU `.csv.gz` to `s3://arnobot-saibya-data/saibya02/sessions/<YYYYMMDD_HHMMSS>_<uuid8>/`.
- Local disk is the queue: oldest-first upload, 5 s retry, and the oldest files are dropped above 20 GB.
- Env: `CLOUD_SYNC_*`, plus AWS keys in `credential.txt`, region ap-south-1.
- Sessions are **not linked to missions**. No MCAP files exist.

## Data sources → PMS fields

| PMS field | GCS source |
|---|---|
| robot_id | Only in `CLOUD_SYNC_PREFIX` / `CLOUD_SYNC_ROBOT_ID` (`saibya02`) and Cloudflare hostnames. `Bot.id` is a UUID. |
| product, sw_ver, fw_ver | **None.** |
| position | `Bot.lat`, `Bot.long` (deg); alt only in `UGVTelemetry.altitude`. |
| fix / sats | `Bot.gps_fix`: `NO_FIX\|SINGLE\|DGPS\|RTK_FLOAT\|RTK_FIX\|STALE`; `Bot.satellites`. hdop is parsed in `drivers/gps_rtk.py:274-288` but never stored. |
| battery | `Bot.battery_volt` (raw). % comes from `gcs_data_handler/config.py:46-127` (offset, smoothing, linear SoC); served as `bv`/`bp` by `features/get/ugv_odometry/serializer.py:99-135`. No charging flag. |
| signal_dbm | `link_signal.py` gives 0-100 % (RSSI/255), UART only, and UART is disabled (`--no-uart`), **so it is always null**. |
| temps | Jetson CPU only (`/sys/class/thermal/thermal_zone0/temp`). No battery or motor temperatures. |
| armed / mode | `Bot.armed`, `Bot.mode` (AUTO/MANUAL) + `Bot.return_to_home`. |
| health | `features/get/device_status/serializer.py:164-185`: controller, lidar, gps, rtk, imu, esp_nano. **No camera health.** |
| current mission | `Bot.mission_id` (UUID). |
| encoders | `Bot.rpm_m1..4` (RPM). No history. `UGVTelemetry.encoder_m*` is never written. |
| mission | `Mission`: uuid id, name, status, started_at, ended_at. `Waypoint` rows = the planned path. |
| mission report | `apis_missionreport`: status is completed/aborted only; `distance_covered_m` = sum of reached waypoint legs, not odometry; `report_data.track[]` = the actual path (`t` is on the pipeline clock, in ms). |
| | Written at: cli.py:1463-1470 (complete), 876-884 (RTH abort), 915-920 (RTH report), `features/post/abort_mission/resolver.py:42-49` (operator abort, **no track**). Emergency stop writes **no** report. |
| events | Alerts are computed per poll in `features/get/alerts/serializer.py:145-230` and **never persisted**, so there are no edge events. Detections are persisted in `apis_humandetection` / `apis_environmentevent`. |

## Security findings

- `NEXT_PUBLIC_GCS_API_TOKEN` in `frontend/gcs_frontend` inlines the bot's `GCS_API_TOKEN` into the browser bundle (`src/lib/config/env.ts:58`, `server.ts:616`, Dockerfile build arg lines 29-32, `?token=` on image URLs). **This violates spec §10.**
- Inbound GCS auth accepts a bearer token (`GCS_API_TOKEN`), Basic auth or a JWT (config.py:179-214).

## Time and clock

- DB timestamps are UTC, but containers run TZ=Asia/Kolkata. cloud_sync, DVR and `mission_date` use IST.
- The Orin has **no battery RTC**, so the clock is wrong after boot until NTP syncs, and capture `ts` can be wrong.

## Doc drift

The top of `backend/CLAUDE.md` still describes the old Django/GraphQL stubs.
