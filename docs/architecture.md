# Architecture

As built (v1). Where this differs from the user's rough plan in `/PROJECT_STRUCTURE.md`, the reason is recorded in `decisions.md`. The spec (`spec/robot-record-spec.md`) wins over both.

## Actors

| Actor | Role in v1 |
|-------|-----------|
| **Robot** (onboard) | Talks to the GCS over the local LAN/Wi-Fi. It doesn't know the business hierarchy (rule 5). |
| **GCS** (on the robot's Jetson, has internet) | Relays robot data to the PMS through a new `pms_relay` service (see `gcs/gcs-integration-checklist.md`), and sends the completed mission report. |
| **`apps/ingest`** (Node.js + Fastify, :4100) | The **only** internet-facing endpoint. Authenticates the connection by ingest key, validates, stores each `msg_id` once, routes by type, and emits `pg_notify` on commit. Optional MQTT adapter. |
| **`apps/api`** (Node.js + Fastify, :4000) | Admin REST API + Socket.IO push. Every route goes through `route()` → session → `can(user, action, target)`. Never talks to robots. Binds to localhost by default. |
| **`apps/admin`** (Next.js 16, :3000) | Admin panel. The browser talks only to its own origin; Next.js proxies `/api/v1/*` to the API, and Socket.IO connects to the API directly. |
| **PostgreSQL 16+** (local service) | All structured data, with telemetry in time-series tables. TimescaleDB is **optional**: the same tables become hypertables if it's installed. |
| **Storage** | `local` driver (versioned files on disk) for development, `s3` driver (bucket versioning, presigned GETs) for production. Postgres keeps only the location + metadata (rule 9). |

## Data flow

```
Robot ──LAN──▶ GCS ─ pms_relay (outbox, live-first, oldest-first) ─HTTPS─▶ apps/ingest :4100
                                                                           │ Bearer ingest key → client → allowed robots
                                                                           │ Zod validate (packages/message-schema)
                                                                           │ clock guard (no future / pre-2024 ts)
                                                                           │ INSERT ingested_messages ON CONFLICT DO NOTHING
                                                                           │ bump live_state.last_seen_at
                                                                           │ route: hello · live (only if newer ts) · telemetry · event · mission
                                                                           │ pg_notify('pms_changes') – delivered on COMMIT
                                                                           ▼
                                                           PostgreSQL (+ optional TimescaleDB)
                                                                           ▲                 │ LISTEN
                                          apps/api :4000 ──────────────────┘                 ▼
                                          REST /api/v1  +  Socket.IO 'change' (only robots the user may read)
                                                                           ▲
                                          apps/admin :3000 (Next.js) ──────┘  same-origin /api/v1 proxy
```

## Key mechanisms

| Concern | Mechanism | Where |
|---|---|---|
| One permission check (rule 13) | Every route is declared with `route(f, app, { access: { can, target } … })`. The helper authenticates, validates, then calls `can()`. Undeclared access is impossible. | `apps/api/src/lib/route.ts`, `services/permissions.service.ts` |
| Scopes (§12) | platform / company (current owner) / site (future) / robot. List routes filter with `applyRobotScope`. | same |
| Robot identity (rule 1) | Allocated in one transaction under a row lock on the product; the DB trigger forbids changing it | `packages/db/src/domain.ts`, migration 0004 |
| Store once (rule 6) | `ingested_messages.msg_id` PK + `ON CONFLICT DO NOTHING` | `apps/ingest/src/pipeline.ts` |
| Late data (rule 7) | `UPDATE live_state … WHERE state_ts < $ts` | `apps/ingest/src/handlers/live.ts` |
| Status (rule 8) | Computed from `last_seen_at` in SQL (`v_robot_status`) and in TS (`computeRobotStatus`), which must agree | migration 0010, `message-schema/src/status.ts` |
| Nothing hard-deleted (rule 10) | `pms_forbid_delete` trigger on every domain table; soft delete via `deleted_at` | migrations |
| Append-only history (rule 4) | `pms_forbid_update` / `pms_allow_update_only(cols…)` triggers | migrations |
| Secrets (rule 11) | AES-256-GCM, key outside the DB, AAD binds robot+kind+slot; reveal is an explicit POST with `no-store` | `packages/db/src/credential-crypto.ts`, `routes/credentials.ts` |
| Sessions | Opaque 256-bit token in an httpOnly SameSite=Lax cookie; the DB stores an HMAC; revocable | `services/auth.service.ts` |
| CSRF | `X-Requested-With: pms-admin` required on non-GET, plus an Origin allow-list | `apps/api/src/app.ts` |
| Live push | `pg_notify` in the ingest transaction → API `LISTEN` → Socket.IO. No broker needed in v1 | `apps/api/src/realtime.ts` |

## Repository layout

```
ProductAdmin/
├── apps/
│   ├── api/            Node.js + Fastify admin API
│   │   └── src/{main,app,context,realtime}.ts
│   │       lib/        route() + target resolvers, errors, validation, sql, multipart, config
│   │       services/   auth, permissions (can), robots, documents, files, storage
│   │       routes/     auth, dashboard, catalogue, robots, hardware(+maintenance), telemetry, credentials,
│   │                   ingest-admin, missions, events, documents, releases, users, meta (healthz, openapi, docs)
│   ├── ingest/         Node.js + Fastify ingestion service
│   │   └── src/{main,server,auth,pipeline,notify,mqtt,config}.ts, handlers/{hello,live,telemetry,event,mission}.ts
│   └── admin/          Next.js 16 admin panel (app/, components/ui, components/domain, lib/)
├── packages/
│   ├── message-schema/ Zod robot-message contract, constants, status rule, API DTO types (shared by all)
│   └── db/             migrations/NNNN_*.sql, migration runner (checksums), seed, domain ops, crypto, pg pool
├── tools/
│   ├── robot-sim/      robot + GCS simulator (scenarios map to spec rules)
│   └── qa/run-qa.mjs   automated QA against an isolated database
└── docs/               design reference (this folder), gcs/, qa/, FINAL_REPORT.md
```

Backend and frontend are separate apps with separate `package.json` files, ports and deployments. The frontend imports only **types and two pure helpers** from `packages/message-schema`, never backend code.

## Environment

See `.env.example` (documented inline). Server-only variables are never prefixed `NEXT_PUBLIC_`. The only public variable is `NEXT_PUBLIC_WS_URL` (not a secret). The API refuses to start if `NEXT_PUBLIC_GCS_API_TOKEN` exists (rule 12).

## Growth path

- **Customers / rental:** add `companies` rows, transfer ownership (history), give users company-scoped grants. No code change.
- **Sites / Operators:** the `sites` + `site_assignment_history` tables and the `site` scope already exist.
- **A robot talking to the internet directly:** it's just another ingest client (a robot key exists for every robot).
- **Scale:** install TimescaleDB (`npm run db:timescale`) for hypertables + compression; run several API instances with the Socket.IO Redis adapter; ingest is stateless and scales horizontally. See `FINAL_REPORT.md`.
