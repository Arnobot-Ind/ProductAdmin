# Decisions & Open Questions

## Decisions (as built, 2026-09-27)

| # | Decision | Reason |
|---|----------|--------|
| D1 | **Backend = plain Node.js (TypeScript) with Fastify** for both `apps/api` and `apps/ingest`. No NestJS. | The user asked for Node.js rather than NestJS. One HTTP library across the backend, schema-friendly routing, pino logging with redaction, first-party plugins (cookie, helmet, multipart, rate-limit), and roughly 2–3× Express throughput. |
| D2 | **Frontend = Next.js 16** (App Router) + React 19, Tailwind 4, TanStack Query, Socket.IO client, MapLibre, Recharts | The user's plan; the GCS UI is also Next.js |
| D3 | **npm workspaces + Turborepo** (not pnpm) | npm ships with Node; nothing extra to install on Windows |
| D4 | **Plain numbered SQL migrations** with our own runner that stores a SHA-256 per file and refuses edited ones. **No ORM**: `pg` with parameterised SQL. | The schema relies on triggers, exclusion constraints, partial uniques, generated columns, views and optional hypertables, which Prisma cannot express. The checksum enforces rule 14 mechanically. |
| D5 | **Local PostgreSQL 16+ (no Docker)**. TimescaleDB is **optional**: telemetry uses `date_bin()` and unique `(robot_id, ts)` indexes, so it runs on plain Postgres, and `pms_enable_timescale()` / `npm run db:timescale` converts it to hypertables later with no code change. | The user asked for everything local without Docker. The installed PG 18 has no Timescale; the spec's TimescaleDB remains the scale path. |
| D6 | **Storage driver abstraction**: `local` (dev; unique key per upload, so nothing is overwritten, which emulates versioning) and `s3` (prod; bucket versioning required, VersionId recorded, presigned GET). Uploads stream **through the API** so it computes SHA-256 itself. | No MinIO/Docker locally; server-side checksum is more trustworthy than a client-declared one |
| D7 | Transport v1 = **HTTPS** `POST /api/v1/ingest` (batch ≤ 500). An **MQTT** adapter exists (enabled by `MQTT_BROKER_URL`; broker ACLs authenticate). | HTTPS is simplest to secure and to replay a backlog over |
| D8 | `robots.robot_id` (text) is the primary key; a trigger makes it (and product, running number) immutable. Format = product code + running number padded to ≥ 2 digits (`saibya02`, `saibya100`). Numbers are never reused. | Spec §3 row 1, §4 |
| D9 | Status is computed at read time (`v_robot_status`, `computeRobotStatus`). No cron. | Spec §7 |
| D10 | `live_state` is replaced only when the incoming `ts` is newer. `last_seen_at` = receive time of any message. | Rule 7, §11 |
| D11 | **Ingest auth = per-client keys** (`ingest_clients`, `ingest_keys`: SHA-256 of a 256-bit key, revocable, several keys per client for zero-downtime rotation). Each robot gets a robot client at registration; each GCS gets a GCS client listing its robots. | §10: own credentials, revocable; connection-level auth |
| D12 | **Clock guard**: ingest rejects `ts` > now + 5 min (`clock_ahead`) or < 2024 (`clock_unsynced`), as non-retryable. | A future timestamp would freeze live state (rule 7); the Jetson has no RTC |
| D13 | Paths stored as GeoJSON `LineString` in `jsonb` (no PostGIS) | Only needed for display |
| D14 | Hello-reported IPs go in `connectivity.reported_ips`, never over the admin-entered values | Connectivity is "Externally Added" |
| D15 | Raw envelopes kept in `ingested_messages.raw`; rejected input kept in `ingest_rejections` | Retention = keep everything; allows diagnosis and re-processing |
| D16 | **Opaque server-side sessions** (httpOnly, SameSite=Lax, HMAC stored, revocable) instead of JWT. Argon2id passwords (OWASP parameters). Login throttling. | Revocation on logout, disable or password change; simpler and safer for an internal panel |
| D17 | **CSRF**: custom header `X-Requested-With: pms-admin` + Origin allow-list; the Next.js proxy makes the API same-origin for the browser | Defence in depth on top of SameSite |
| D18 | **Audit log removed** at the user's request (not required by the spec). Consequence: credential reveals and admin edits aren't attributable. Can be re-added as a new migration. | User decision, 2026-09-27 |
| D19 | Migrations were rewritten once **before first release** to remove audit (the local DB held only demo data). From the first real deployment on, rule 14 applies strictly and the runner enforces it. | Pre-release clean-up |
| D20 | Mission rows merge robot + GCS: the robot is authoritative for actual path, distance and result; the GCS for planned path, planned distance and waypoints. A mission id can never move to another robot. | Spec §5 |
| D21 | Development is driven by `tools/robot-sim` and verified by `tools/qa/run-qa.mjs` (isolated DB) | Real robots are not online |
| D22 | The reference GCS relay is Python (stdlib) because the GCS backend is Python | Fits the GCS stack; see `gcs/reference/pms_relay.py` |

## Resolved questions

| Question | Answer |
|---|---|
| Project structure / reference repo | The structure was shared (`PROJECT_STRUCTURE.md`) and reconciled here. The GitHub repo `Harshilshah11/ProductAdmin` is the push target (branches `main`, `backend`, `frontend`). |
| Backend language | Node.js (D1) |
| Database hosting | Local PostgreSQL now (D5); a hosted platform later |
| `GCS_API_TOKEN` direction | It is the **GCS's own** API token (GCS UI → GCS backend). It is stored per robot in `robot_credentials`. The GCS authenticates **to the PMS** with a separate PMS ingest key (`PMS_INGEST_KEY`). |
| Robot ID padding | ≥ 2 digits (`saibya02`) |

## Open questions (robot / GCS team)

1. Exact payload fields the robot/GCS can really provide: see the gaps in `gcs/gcs-current-state.md` (no `sw_ver`/`fw_ver`, no camera health, signal is % not dBm, no charging flag, emergency stop writes no report).
2. Encoders: how many per robot, ticks vs RPM vs velocity? (The contract accepts all three.)
3. Who uploads mission files, and to which bucket? Mission ↔ cloud_sync session linkage.
4. Hosting target and where the master encryption key lives in production (env vs KMS).
5. Does v1 need release **deployment** (push updates to robots) or only the release registry (built)?
6. Login method long-term: email + password (built) or SSO (Google Workspace)?
