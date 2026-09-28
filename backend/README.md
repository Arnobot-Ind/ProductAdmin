# Arnobot PMS backend

The server: robot ingest plus the admin API, in one Node.js (Fastify) process on port **4000**. It is
**stateless**: every record lives in the database service and every file lives in object storage, so the
server can crash, restart or be replaced without losing data.

## Separate services

| Service | What it holds | Where |
|---|---|---|
| **Backend server** (this folder) | Nothing permanent. Takes data in from robots, serves it to the admin panel | `npm run dev`, port 4000 |
| **Database** (PostgreSQL 16+, e.g. AWS RDS) | All records: products, robots, missions, events, telemetry, and the **index** of recorded videos | Its own service (`DATABASE_URL`). Schema, migrations and seed live in `../storage` |
| **Video storage** (S3 bucket `arnobot-saibya-data`) | Camera video + LiDAR/IMU chunks + `session.json` | S3 only (`ARCHIVE_S3_*`). The server never keeps a copy |
| **Document storage** | Circuit diagrams, manuals, release packages | `STORAGE_DRIVER` (local folder or S3) |
| **Admin panel** (`../frontend`) | Nothing. UI only, talks to this server through `/api/v1` | `npm run dev`, port 3000 |

Temporary files (a camera exported as one MP4) are written **only** to `ARCHIVE_TEMP_DIR` (`./tmp`,
gitignored) and deleted after `MP4_CACHE_HOURS`. The folder can be emptied at any time.

## Code layout

```
src/
  main.ts, app.ts         start-up, HTTP server, route registration
  ingest/                 data IN from robots (ingest-key auth)
    routes.ts             POST /api/v1/ingest            telemetry / events / missions
    archive.ts            PUT  /api/v1/archive/upload    video + sensor files → S3 (streamed)
                          POST /api/v1/archive/heartbeat cloud_sync status
  routes/                 data OUT to the admin panel (session auth, permissions)
    archive.ts            recordings, file streaming, HLS playlist, MP4 download, reindex
    system.ts             /system/status for the Settings page
  services/               business logic
    archive/              keys.ts (S3 layout) · storage.ts (S3) · archive.service.ts (index) · mp4.ts · summary.ts
  db/                     database connection + queries only (schema/migrations/seed: ../storage)
  shared/                 API types shared with the admin panel
```

## Robots and their data

- A robot is registered under a product and gets a permanent **Robot ID** (`saibya02`, `ductcleaning01`),
  a unique **8-digit serial number** (generated) and an **ingest key** (shown once).
- Only registered robots are accepted: a robot uploads with its ingest key, and only under its own ID
  (`<robot_id>/sessions/<session>/…`). Data for unknown robots is refused.
- The Saibya Archive server's paths still work for cloud_sync (`PUT /api/ingest/upload`,
  `POST /api/ingest`, `POST /api/ingest/heartbeat`): only the host and the key change.

## Commands

```bash
# database first: in ../storage run npm install, db:create, db:migrate, db:seed
npm install
npm run dev            # http://localhost:4000  (API docs: /api/v1/docs)
npm run archive:sim    # fake robot: uploads test-pattern recordings (needs S3 configured + ffmpeg;
                       # keys from ../storage/.sim-keys.json)
npm run typecheck && npm test
```
