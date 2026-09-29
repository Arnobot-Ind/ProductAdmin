# Arnobot PMS storage

Everything that holds data, kept separate from the server. This folder is **not hosted and not a running
service**: it holds the database schema and the scripts that create, migrate and seed it. The data itself
lives in PostgreSQL (e.g. AWS RDS) and S3, which keep running whether or not the server is up.

## SQL and non-SQL

| | Where | What |
|---|---|---|
| **SQL** | PostgreSQL (local, or AWS RDS) | Every record: users and roles, products, robots (Robot ID + 8-digit serial), ownership, hardware, software, connectivity, credentials (encrypted), ingest keys (hashed), live state, events, missions, telemetry, document records, and the **video index** (sessions + one row per stored file). Full table list: `src/layout.ts` |
| **Non-SQL** | S3 bucket `arnobot-saibya-data` | Camera video (`.ts`), LiDAR (`.npz`), IMU (`.csv.gz`), `session.json`, stored as `<robot_id>/sessions/<session>/…`. The server streams them in and out; it never keeps a copy |
| **Non-SQL** | Document storage (backend `STORAGE_DRIVER`) | Circuit diagrams, manuals, warranty files, release packages |

## Set up (once), e.g. on AWS RDS

1. Create a PostgreSQL 16+ instance. `pgcrypto`, `citext` and `btree_gist` are supported on RDS;
   TimescaleDB is optional.
2. `cp .env.example .env`: set `PG_ADMIN_URL` (RDS master user) and `DATABASE_URL` (the app role).
3. Run:
   ```bash
   npm install
   npm run db:create    # app role + database + extensions
   npm run db:migrate   # schema (migrations/)
   npm run db:seed      # first super-admin (+ demo robots)
   ```
4. Point the backend at it: `DATABASE_URL` in `backend/.env`.

## When the schema changes

Add a new numbered file to `migrations/` (never edit an applied one), then run `npm run db:migrate` once,
then restart the backend. `npm run db:status` lists applied and pending migrations.

Migration `0015` adds organizations (`companies.kind`, users' `company_id`), customer roles and data
permissions, invitations, soft-delete of recordings and the append-only `audit_log`. With
`SEED_DEMO_ROBOTS=true` the seed also creates the demo customer **Adani** and assigns `saibya02` to it
(no users: invite them from the panel).
Migration `0016` reduces the roles to Admin, Manager and Viewer and makes LiDAR / IMU Admin-only (`data.sensors`).

## Commands

| Command | What |
|---|---|
| `npm run db:create` | Create the app role, database and extensions (needs `PG_ADMIN_URL`) |
| `npm run db:migrate` / `db:status` | Apply / list migrations |
| `npm run db:seed` | Super-admin + demo robots; writes `.sim-keys.json` for the robot simulator |
| `npm run db:timescale` | Turn telemetry tables into TimescaleDB hypertables (if installed) |
| `npm run db:reset` | Development only: drop and recreate the local database |
