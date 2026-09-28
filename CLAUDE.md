# Arnobot PMS: Product Admin

Admin panel (DB + backend + frontend) for the **Arnobot PMS**, which registers Arnobot's robots (Saibya, Altius, NEXUS, ATM, Duct Cleaning), ingests their messages, and shows live state, telemetry, missions, events, hardware, documents and credentials to the Arnobot team.

**Scope is Version 1:** one Company (Arnobot), Arnobot team logins only. No customers, Client Admins, Operators or Sites yet, but the schema must let those be added **as data, not by rewriting code**. Real robots are not online yet.

This file is the only project doc. The SQL migrations, `packages/message-schema` and the live OpenAPI docs (`/api/v1/docs`) are the detailed reference.

## Non-negotiable rules

1. **Robot ID is permanent and unique** (`saibya02` = product code + running number, ≥ 2 digits, assigned by the PMS). Never edited, never reused. **Serial number is a separate unique field** and never stands in for the Robot ID.
2. **Ownership is history.** `company_assignment_history` rows with `valid_from` / `valid_to`. Never a single mutable `company_id` on `robots`.
3. **The message format only grows.** Fields are added, never renamed or removed. Every message carries `v`. Unknown fields are accepted and ignored, never rejected.
4. **Current ≠ history.** `live_state` is overwritten (one row per robot). Everything else that changes (hardware, software, ownership, maintenance, sensor data, missions, events) is append-only.
5. **Robots don't know the business hierarchy.** A robot only says who it is. Company, Site and Operator are resolved in the PMS.
6. **Idempotent ingestion.** `msg_id` is unique: stored exactly once. `ts` is capture time (UTC) and keys history, not receive time.
7. **Late/backlog data never overwrites newer live state.** Update `live_state` only if incoming `ts` > stored `state_ts`.
8. **Status is computed, not stored.** Online `< 60 s`, Stale `60 s–5 min`, Offline `> 5 min` since last seen (`v_robot_status` in SQL and `computeRobotStatus` in TS must agree).
9. **No files in the DB.** Files go to S3 (versioning on). Postgres keeps path + metadata.
10. **Nothing is hard-deleted.** Soft delete with `deleted_at`, restorable. No retention jobs, TTLs or Timescale drop policies.
11. **Secrets live only in `robot_credentials`,** AES-256-GCM encrypted with a key outside the DB. Never in `robots`, logs, list responses or URLs. Camera stream URLs have **no** user/password.
12. **`GCS_API_TOKEN` is server-only.** Never create `NEXT_PUBLIC_GCS_API_TOKEN` (the API refuses to start if it exists).
13. **Permissions stay out of handler code.** Every request goes through one `can(user, action, target)` check (User → Role → Permission → Scope; scope = Platform | Company | Site | Robot).
14. **Schema changes are numbered migrations.** Never edit an applied migration; add a new one (the runner checks SHA-256 and refuses edits).
15. **Products, part types and revisions are data** (rows), not enums in code.

## Stack and layout

- **Backend = plain Node.js + Fastify** (not NestJS). **One server**, `apps/backend` :4000: the admin API, Socket.IO push and robot/GCS ingestion (user decision: no separate ingest service). Set `API_HOST=0.0.0.0` when a GCS must reach it.
- **Frontend = Next.js 16** (`apps/frontend` :3000): React 19, Tailwind 4, TanStack Query, socket.io-client, MapLibre, Recharts. Proxies `/api/v1/*` to the API (same-origin cookies). Imports only types + pure helpers from `packages/message-schema`.
- **Database = local PostgreSQL 16+** (no Docker). TimescaleDB optional (`npm run db:timescale`). Plain SQL migrations, `pg` with parameterised SQL, **no ORM**.
- Files: `STORAGE_DRIVER=local` (dev) or `s3` (prod, versioning on). Uploads stream through the API, which computes SHA-256.
- npm workspaces + Turborepo.

```
apps/backend      src/lib/route.ts (the ONLY way to add an admin route), services/ (auth, permissions, robots, documents, files, storage), routes/, realtime.ts
                  src/ingest/  routes.ts, pipeline.ts, handlers/{hello,live,telemetry,event,mission}.ts, auth.ts (ingest keys), mqtt.ts
apps/frontend     Next.js admin panel (app/, components/ui, components/domain, lib/)
packages/message-schema  Zod message contract + DTO types + status rule (shared)
packages/db       migrations/NNNN_*.sql, migrate runner, seed, domain ops (registerRobot), credential crypto
```

Commands: `npm run setup` (install, build packages, create DB, migrate, seed) · `npm run dev` · `db:migrate` / `db:status` / `db:seed` / `db:reset` (dev only) · `typecheck` · `test` · `build`. Env vars are documented in `.env.example`.

## Data flow

```
Robot ─LAN─▶ GCS (pms_relay) ─HTTPS─▶ apps/backend /api/v1/ingest ─▶ PostgreSQL ─pg_notify pms_changes─▶ apps/backend realtime ─REST + Socket.IO─▶ apps/frontend
```

**Ingest** (`POST /api/v1/ingest`, `Authorization: Bearer <ingest key>`, one envelope or array ≤ 500, oldest-first). Per message, in order: Zod validate (unknown fields pass) → clock guard (`ts` ≤ now + 5 min → else `clock_ahead`; ≥ 2024 → else `clock_unsynced`) → key's client may speak for this `robot_id` → one transaction: `INSERT ingested_messages … ON CONFLICT DO NOTHING` (0 rows = `duplicate`) → bump `live_state.last_seen_at` → route by type → `pg_notify`. Response per message: `stored | duplicate | rejected` (+ `retryable`). Ingest routes are machine-authenticated (ingest key), so they are registered outside `route()` and outside the admin CSRF hook, with their own body limit (`INGEST_BODY_LIMIT_MB`) and per-key rate limit. Rejected input is kept in `ingest_rejections`. Optional MQTT adapter (`MQTT_BROKER_URL`, topics `arnobot/v1/{robot_id}/{type}`).

**GCS mission report**: `POST /api/v1/gcs/missions/:id/report`, merged into the same `missions` row. Robot wins for actual path / distance / result; GCS wins for planned path / planned distance / waypoints. A mission id never moves to another robot.

## Message contract (v = 1, `packages/message-schema/src/messages.ts`)

Envelope: `{ v, msg_id (uuid), robot_id, product, sw_ver, fw_ver, ts (UTC), type, payload }`. Payload field names are our proposal, still to be confirmed with the robot team.

| type | When | Effect |
|---|---|---|
| `hello` | boot / reconnect | `software_history` row only if versions/features changed; `connectivity.reported_ips` (never overwrites admin-entered IPs) |
| `live` | every 30 s | full snapshot (position, battery, signal_dbm, temps_c, armed, mode, health ok/warning/fault, current_mission_id); replaces live state only if newer |
| `telemetry` | batch every 30 s | samples with own `ts` into `telemetry_gps/encoder/battery/health` |
| `event` | immediately | `event_type` abort/rth/alert/fault/update, `severity` info/warning/critical |
| `mission` | start + end | upsert; `result` completed/failed/aborted; file refs are S3 paths |

To change it: add optional fields only, update the Zod schema and the frontend types.

## Database (`packages/db/migrations`)

- PKs are uuid, except natural permanent ids `robots.robot_id` and `missions.mission_id` (`saibya02-M0001`).
- DB-level guards: `pms_forbid_delete()` on every domain table; `pms_forbid_update()` / `pms_allow_update_only(cols…)` on history tables; `pms_immutable_columns(…)` on ids; `EXCLUDE` for overlapping ownership periods; `CHECK` for credential-free camera URLs, robot_id ≠ serial, etc.
- Main groups: org/access (`companies`, `sites`, `users`, `roles`, `permissions`, `role_grants`, `sessions`) · catalogue (`products`, `hardware_revisions`, `part_types`) · robot record (`robots`, `company_assignment_history`, `hardware_fitted`, `maintenance_log`, `software_history`, `connectivity`, `robot_cameras`, `dispatch_warranty`, `files`, `documents`, `document_versions`, `robot_credentials`, `ingest_clients`, `ingest_keys`) · live (`live_state`, `ingested_messages`, `ingest_rejections`, `events`, `missions`, `mission_files`) · `telemetry_*` · `releases`.
- Views: `v_robot_status`, `v_robot_current_owner`, `v_robot_mission_summary`, `v_robot_current_software`.

## API, auth, permissions

- Add an admin route only via `route()` in `apps/backend/src/lib/route.ts` with an explicit `access` (`'public'` | `'signed_in'` | `{ can: '<perm>', target: resolver }`). Never check roles in a handler.
- Sessions: opaque token in httpOnly SameSite=Lax cookie `pms_session`, DB stores an HMAC; argon2id passwords; login throttling. CSRF: `X-Requested-With: pms-admin` + Origin allow-list.
- Errors: `{ error: { code, message, details? } }`.
- Seeded roles: `super_admin` (all), `admin` (all but user.manage), `engineer` (read + hardware/maintenance/document write, event.ack, credential.read_meta, ingest.read), `viewer` (robot.read, catalog.read). Any role can be granted at platform, company, site or robot scope.
- Credentials: lists return metadata only; `POST /credentials/:id/reveal` needs `credential.reveal`, returns `no-store`. Rotate = revoke + insert. Frontend keeps revealed secrets in component state only, auto-hidden after 30 s.

## Admin panel shape

- **Everything hangs off a robot.** No fleet dashboard, no global Missions or Events pages (user decision). `/` redirects to `/robots`; the robot list shows status, health and unacknowledged critical alerts per robot. A robot's page has Missions and Events tabs, and a mission opens at `/robots/{robotId}/missions/{missionId}`.
- Logo: `apps/frontend/public/brand/arnobot-logo-{black,white}.png` (black on light theme, white on dark). Tab icon `app/icon.png` is the logo mark.

## Conventions

- All timestamps are `timestamptz` UTC; the API returns ISO-8601 with `Z`. UI shows local time with UTC on hover.
- Units in column names: metres, m/s, degrees, °C, %, volts, dBm (`distance_m`, `battery_pct`, `signal_dbm`).
- Tables snake_case plural; history tables end in `_history` or are clearly append-only.
- Every mutable admin-entered record has `created_at`, `created_by`, `updated_at`, `deleted_at`.
- **No audit log** (removed at the user's request). Don't add audit writes unless asked.
- Status colours: Online green, Stale amber, Offline grey. Health OK green, Warning amber, Fault red, always with text too.

## Working rules

- Before finishing: `npm run typecheck && npm test && npm run build` must be green.
- Git: `main` (everything), `backend`, `frontend` branches on github.com/Harshilshah11/ProductAdmin.

## Open questions (robot / GCS team)

Exact payload fields the robot/GCS can provide (no sw/fw version, camera health or charging flag yet; signal is % not dBm) · encoder format · who uploads mission files and where · production hosting and where the encryption key lives · whether v1 needs release deployment to robots · long-term login (password vs SSO).
