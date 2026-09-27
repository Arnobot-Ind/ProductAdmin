# Final Report: Arnobot PMS Product Admin (v1)

Date: 2026-09-27 · Scope: `tasks.txt` items 1–7, built against `docs/spec/robot-record-spec.md` (the source of truth).

## 1. Summary

A working, locally running system that registers Arnobot robots and ingests their messages, and shows live state, telemetry, missions, events, hardware, software, connectivity, documents, dispatch/warranty, maintenance and encrypted credentials to the Arnobot team. The rules in the spec are enforced in three places: the API, the ingest pipeline, and the **database itself**, so a bug in one layer cannot break a rule silently.

| Metric | Value |
|---|---|
| Workspaces | 6: `apps/api`, `apps/ingest`, `apps/admin`, `packages/db`, `packages/message-schema`, `tools/robot-sim` (+ `tools/qa`) |
| Database | 39 tables, 4 views, 11 numbered migrations, triggers guarding every domain table |
| API | ~90 REST operations (OpenAPI generated from code) + Socket.IO live push |
| Admin panel | 15 routes, 12 robot tabs, light/dark, WCAG 2.2 AA-oriented |
| Tests | 39 unit tests + **81 integration checks, all passing** (`docs/qa/LAST_RUN.md`) |

## 2. What was done, per task

| Task | Delivered | Where |
|---|---|---|
| **1. Database from the spec** | PostgreSQL schema covering every field in spec §3 rows 1–13, §4 catalogue, §5 missions, §8 storage/versioning, §9 releases, §10 credentials, §12 permissions. History tables, soft delete, immutability and no-hard-delete enforced by triggers. Telemetry designed for TimescaleDB but runs on plain PostgreSQL (none is installed locally). | `packages/db/migrations`, `docs/database.md` |
| **2. Backend: APIs + ingestion** | **Node.js + Fastify.** `apps/ingest`: internet-facing, idempotent, rule-7-safe, batch/backlog-aware, clock-guarded, per-client keys, optional MQTT. `apps/api`: auth (argon2id, revocable sessions), one `can()` permission gate, all CRUD/history endpoints, streamed uploads with server-side SHA-256, encrypted credentials, Socket.IO push via Postgres LISTEN/NOTIFY. | `apps/ingest`, `apps/api`, `docs/backend.md`, `docs/api.md` |
| **3. UI for every API** | Next.js 16 admin panel: dashboard, robot summary (§5 view 1), registration, a robot detail page with 12 tabs, missions + map (planned vs actual), events with bulk acknowledge, products/revisions/documents, releases, ingest log + key management, users and grants, account. Live updates, accessible, empty states. | `apps/admin`, `docs/frontend.md` |
| **4. Stack, all local** | TypeScript monorepo (npm workspaces + Turborepo), local PostgreSQL (no Docker), local versioned file storage (S3 driver ready), shared Zod contract. Decisions and reasons: `docs/decisions.md`. | root |
| **5. GCS integration** | GCS code analysed (`docs/gcs/gcs-current-state.md`). Checklist of every change the GCS needs, in 5 phases with owners, field mappings, alert→event mapping, mission report mapping, test plan and estimates. **Plus a working reference relay** (Python, stdlib) tested against this PMS. | `docs/gcs/gcs-integration-checklist.md`, `docs/gcs/reference/pms_relay.py` |
| **6. QA** | Automated, isolated QA suite (repo, SQL design, ingestion, API + permission matrix, realtime, frontend bundle secrets), a manual UI/accessibility/security checklist, and a log of the 10 defects found and fixed. | `tools/qa/run-qa.mjs`, `docs/qa/QA_PLAN.md`, `docs/qa/LAST_RUN.md` |
| **7. This report** | What was done and what comes next | `docs/FINAL_REPORT.md` |

Also: a robot + GCS **simulator** with 8 scenarios mapped to spec rules (`tools/robot-sim`), because the robots are not online yet.

## 3. How to run (Windows, local)

Prerequisites: Node.js ≥ 20 (tested on 24), PostgreSQL ≥ 16 running locally (tested on 18.4).

```bash
cp .env.example .env            # then fill in PG_ADMIN_URL, secrets, SEED_ADMIN_PASSWORD (see comments)
npm run setup                   # install → build packages → create DB → migrate → seed
npm run build                   # build everything
npm start                       # api :4000, ingest :4100, admin http://localhost:3000
npm run sim -- --scenario mixed --speed 10   # feed live demo data
npm run qa                      # full automated QA (isolated DB)
```

Sign in with `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` from `.env`. API reference: http://127.0.0.1:4000/api/v1/docs. For development with hot reload, use `npm run dev`.

## 4. Verification

- `npm run typecheck`: 6/6 workspaces clean.
- `npm test`: 39/39.
- `npm run qa`: **81/81**, including every spec rule 1–15 that can be tested automatically (see the mapping in `docs/qa/QA_PLAN.md`).
- Full stack started and the admin panel served all 15 routes. Login through the same-origin proxy works, the simulator's data appears live, and the reference GCS relay delivered to the ingest service and buffered while it was unreachable.
- **Not yet done by a human:** screen-reader and visual passes over the UI (checklist in `QA_PLAN.md`), and testing with the real GCS/robots, which are offline.

## 5. Changes made on your instructions during the build

- Backend is plain **Node.js** (Fastify), not NestJS.
- **No Docker**: the local PostgreSQL service and local file storage are used.
- **Audit log removed.** Consequence: credential reveals and admin edits are not attributable to a person. Re-adding it is one migration plus a small service.
- Backend and frontend kept as separate apps and pushed to separate branches.

## 6. What needs to be done next

### Must do before real robots / production (priority order)
1. **GCS side:** follow `docs/gcs/gcs-integration-checklist.md`. In particular, remove `NEXT_PUBLIC_GCS_API_TOKEN` from the GCS frontend and rotate that token (it is currently exposed in the browser bundle), add version reporting and NTP-sync gating, and deploy `pms_relay`.
2. **Hosting:**
   - Put the ingest service behind TLS (public).
   - Put the admin API + panel on a private network or behind SSO/VPN.
   - Set `COOKIE_SECURE=true`.
   - Keep production secrets in a secret manager (KMS for `CREDENTIAL_ENCRYPTION_KEY`, with an offline backup of the key).
3. **Storage:** set `STORAGE_DRIVER=s3` with **bucket versioning ON** (spec §8), a private bucket, and lifecycle rules that never expire versions.
4. **Backups:** managed PostgreSQL with point-in-time recovery; a tested restore.
5. **Confirm the open questions** in `docs/decisions.md` with the robot team (payload fields, encoders, mission file ownership).

### Should do (quality and scale)
- **TimescaleDB** on the production Postgres, then `npm run db:timescale` (hypertables + compression; no code change). Continuous aggregates for dashboard charts over months.
- **Horizontal scale:**
  - ingest is stateless, so run N instances behind a load balancer;
  - the API needs the Socket.IO Redis adapter for more than one instance;
  - move `pg_notify` to Redis Streams/NATS only if volume demands it.
- **Observability:** OpenTelemetry traces + metrics (ingest rate, rejection rate, DB latency), alerts on "robot offline > N min" and "rejections spike", structured log shipping (pino JSON is already structured).
- **CI:** a GitHub Actions workflow running typecheck, unit tests and `npm run qa` against a Postgres service container on every PR.
- **Frontend:**
  - nonce-based CSP (replaces `'unsafe-inline'`);
  - Playwright end-to-end tests + axe accessibility scans in CI;
  - a robot picker with server-side search (it loads the first 200 robots today);
  - self-hosted fonts, so the UI has no external requests.
- **Security:**
  - SSO (Google Workspace / OIDC) + MFA for admins;
  - re-add an audit log if attribution becomes a requirement;
  - mTLS or signed messages for robot→PMS (§10 extension);
  - rate limits per robot on ingest (currently per key).
- **Release deployment** (§9): today there is a release registry with checksum + signature fields. Pushing updates to robots and verifying signatures on the robot is future work.
- **Data lifecycle:** `ingested_messages.raw` grows forever by design. Monthly partitioning keeps it fast.

### For the 6 planned projects / FleetManager
- `packages/message-schema` is the contract to publish: version it (semver) and consume it from the other projects.
- Customers, Sites and Operators are **data**:
  - add `companies` rows and transfer ownership (history kept);
  - use the `sites` + `site_assignment_history` tables that already exist;
  - issue company- or site-scoped role grants. `can()` already supports these scopes.
- Expose a read-only, scoped API for FleetManager using an **API-key client type**, the same pattern as ingest clients. Don't share the database.
- Keep robot IDs, ownership history and the message format rules as the shared foundation across all projects.

## 7. Design references (standards the implementation follows)

- OWASP Cheat Sheets: Password Storage (argon2id parameters), Session Management, CSRF Prevention, Secrets Management, REST Security.
- NIST SP 800-63B (password length over complexity).
- PostgreSQL documentation: exclusion constraints, generated columns, `date_bin`, LISTEN/NOTIFY, BRIN indexes.
- TimescaleDB documentation: hypertables, compression; retention deliberately **not** used (spec §8).
- RFC 7946 (GeoJSON), RFC 9562 (UUID), ISO 8601 / UTC timestamps.
- WCAG 2.2 AA and the WAI-ARIA Authoring Practices (tabs, dialog patterns).
- The Twelve-Factor App (config in the environment, stateless processes).
- *Designing Data-Intensive Applications* (Kleppmann): idempotent ingestion, event time vs processing time, append-only logs.
