# Arnobot PMS: Product Admin

Admin panel (DB + backend + frontend) for the **Arnobot PMS**, which registers Arnobot's robots (Saibya, Altius, NEXUS, ATM, Duct Cleaning), ingests their messages, and shows live state, telemetry, missions, events, hardware, documents and credentials to the Arnobot team.

**Scope is Version 1:** one Company (Arnobot), Arnobot team logins only. No customers, Client Admins, Operators or Sites yet, but the schema must let those be added **as data, not by rewriting code**.

## Read these first

| File | What it holds |
|------|---------------|
| `docs/spec/robot-record-spec.md` | **Source of truth.** Markdown transcription of the spec docx (original in `docs/spec/`). |
| `docs/architecture.md` | Stack, components, data flow, project layout |
| `docs/database.md` | Every table, column, index, hypertable, view |
| `docs/message-contract.md` | Robot message envelope + per-type payload schemas |
| `docs/backend.md` | Ingestion pipeline, REST API, status rules, auth, permissions, credentials |
| `docs/api.md` | Every admin API endpoint with its permission (live: `/api/v1/docs`) |
| `docs/gcs/gcs-integration-checklist.md` | What the GCS must change to send data here (+ reference relay) |
| `docs/qa/QA_PLAN.md` | Test layers, what `npm run qa` proves, manual checklist |
| `docs/FINAL_REPORT.md` | What was built and what comes next |
| `docs/frontend.md` | Admin panel pages and what each one shows |
| `docs/simulator.md` | Robot simulator. **Real robots are not online yet**, so all dev and testing runs against it |
| `docs/decisions.md` | Decisions made + open questions. Check here before assuming anything not in the spec |

## Non-negotiable rules (from the spec)

1. **Robot ID is permanent and unique** (e.g. `saibya02` = product code + running number, assigned by the PMS). It is never edited and never reused. **Serial number is a separate unique field** and never stands in for the Robot ID.
2. **Ownership is history.** `company_assignment_history` rows with `valid_from` / `valid_to`. Never a single mutable `company_id` column on `robots`.
3. **The message format only grows.** Fields are added, never renamed or removed. Every message carries `v`. Unknown fields are accepted and ignored, never rejected.
4. **Current ≠ history.** `live_state` is overwritten (one row per robot). Everything else that changes (hardware, software, ownership, maintenance, sensor data, missions, events) is append-only history.
5. **Robots don't know the business hierarchy.** A robot only says who it is. Company, Site and Operator are resolved in the PMS.
6. **Idempotent ingestion.** `msg_id` is unique: a message is stored exactly once. `ts` is capture time (UTC) and is what history is keyed on, not receive time.
7. **Late or backlog data never overwrites newer live state.** Only update `live_state` if the incoming `ts` is newer than the stored one.
8. **Status is computed, not stored.** Online `< 60 s`, Stale `60 s–5 min`, Offline `> 5 min` since last seen.
9. **No files in the DB.** Files go to S3 (bucket versioning on). Postgres keeps path + metadata.
10. **Nothing is hard-deleted.** Use soft delete with `deleted_at`, restorable. No retention jobs, no TTLs, no Timescale drop policies.
11. **Secrets live only in `robot_credentials`,** encrypted with a key held outside the DB. Never in `robots`, never in logs, never in API list responses, never in URLs. Camera stream URLs in normal tables have **no** user/password.
12. **`GCS_API_TOKEN` is server-only.** Never create `NEXT_PUBLIC_GCS_API_TOKEN` or send the token to the browser.
13. **Permissions stay out of handler code.** Every request goes through one `can(user, action, target)` check (User → Role → Permission → Scope; scope = Platform | Company | Site | Robot).
14. **Schema changes are numbered migrations.** Never edit an applied migration; add a new one.
15. **Products, part types and revisions are data** (rows), not enums baked into code.

## Conventions

- All timestamps are `timestamptz` in UTC. The API returns ISO-8601 with `Z`.
- Units: metres, m/s, degrees, °C, %, volts, dBm. Put the unit in the column name (`distance_m`, `battery_pct`, `signal_dbm`).
- Table names are snake_case plural. History tables end in `_history` or are clearly append-only (`events`, `missions`).
- Every mutable admin-entered record gets `created_at`, `created_by`, `updated_at`, `deleted_at`.
- There is **no audit log** (removed at the user's request, decision D18). Don't add audit writes unless asked.
- The shared message schema lives in one place (`packages/message-schema`) and is used by the API validator, the simulator and the frontend types.

## Stack and structure (as built, see docs/architecture.md)

- **Backend = plain Node.js + Fastify** (`apps/api` admin API :4000, `apps/ingest` robot/GCS ingestion :4100). **Not NestJS** (user decision).
- **Frontend = Next.js 16** (`apps/admin` :3000). It talks to the API only over HTTP/WebSocket and imports only types + pure helpers from `packages/message-schema`.
- **Database = local PostgreSQL** (no Docker). TimescaleDB optional (`npm run db:timescale`). Plain numbered SQL migrations in `packages/db/migrations` with a checksum-enforcing runner. No ORM.
- Files: `STORAGE_DRIVER=local` (dev) or `s3` (prod, versioning on).
- npm workspaces + Turborepo (no pnpm).

```
apps/api          Fastify admin API: lib/route.ts (the ONLY way to add a route: declares permission), services/, routes/
apps/ingest       Fastify ingestion: pipeline.ts, handlers/, auth.ts, mqtt.ts
apps/admin        Next.js admin panel
packages/message-schema  Zod contract + DTO types + status rule (shared)
packages/db       migrations/, migrate runner, seed, domain ops (registerRobot), credential crypto
tools/robot-sim   simulator (robots are offline)   ·   tools/qa  automated QA (isolated DB)
docs/             design reference
```

## Working rules for this repo

- Adding an endpoint: use `route()` in `apps/api/src/lib/route.ts` with an explicit `access`; never check roles in a handler. Update `docs/api.md`.
- Changing the schema: add `packages/db/migrations/NNNN_name.sql`; never edit an applied one (the runner refuses).
- Changing the message format: add optional fields only in `packages/message-schema`; update `docs/message-contract.md` and the simulator.
- Before finishing: `npm run typecheck && npm test && npm run build && npm run qa` must be green.
- Git: `main` (everything), `backend`, `frontend` branches on github.com/Harshilshah11/ProductAdmin.
