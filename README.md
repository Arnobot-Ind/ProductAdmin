# Arnobot PMS · Product Admin

Internal admin system for Arnobot's robots (Saibya, Altius, NEXUS, ATM, Duct Cleaning). It registers robots, ingests their messages through the GCS, and shows live state, telemetry, missions, events, hardware, software, documents and encrypted credentials to the Arnobot team.

| Part | Tech | Port |
|---|---|---|
| `apps/admin`: admin panel (frontend) | Next.js 16, React 19, Tailwind 4, TanStack Query, MapLibre, Recharts | 3000 |
| `apps/api`: admin REST API + live push | Node.js, Fastify 5, Socket.IO, Zod | 4000 |
| `apps/ingest`: robot/GCS ingestion | Node.js, Fastify 5 (+ optional MQTT) | 4100 |
| `packages/db`: schema, migrations, seed | PostgreSQL 16+ (TimescaleDB optional), `pg` | — |
| `packages/message-schema`: shared contract | Zod | — |
| `tools/robot-sim` / `tools/qa` | simulator / automated QA | — |

## Quick start

```bash
cp .env.example .env     # fill in PG_ADMIN_URL, CREDENTIAL_ENCRYPTION_KEY, SESSION_SECRET, SEED_ADMIN_PASSWORD
npm run setup            # install, build packages, create DB, migrate, seed (demo robots + .sim-keys.json)
npm run build
npm start                # → http://localhost:3000
npm run sim -- --scenario mixed --speed 10     # live demo data (robots are not online yet)
```

| Command | |
|---|---|
| `npm run dev` | api + ingest + admin with hot reload |
| `npm run typecheck` / `npm test` | static checks / 39 unit tests |
| `npm run qa` | 81 integration checks on an isolated DB → `docs/qa/LAST_RUN.md` |
| `npm run db:migrate` / `db:status` / `db:seed` / `db:timescale` / `db:reset` | database |

## Documentation

- `CLAUDE.md`: the non-negotiable rules
- `docs/spec/robot-record-spec.md`: the specification (source of truth)
- `docs/architecture.md` · `docs/database.md` · `docs/backend.md` · `docs/api.md` · `docs/frontend.md` · `docs/message-contract.md` · `docs/simulator.md` · `docs/decisions.md`
- `docs/gcs/gcs-integration-checklist.md`: what to change on the GCS so it sends data here
- `docs/qa/QA_PLAN.md`: how quality is checked
- `docs/FINAL_REPORT.md`: what was done and what comes next

## Branches

`main` = the whole monorepo · `backend` = api, ingest, db, contract, simulator, QA, docs · `frontend` = admin panel + the shared contract + docs.
