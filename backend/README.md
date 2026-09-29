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

Production server setup, update and rollback: [`deploy/README.md`](deploy/README.md).

## Robots and their data

- A robot is registered under a product and gets a permanent **Robot ID** (`saibya02`, `ductcleaning01`),
  a unique **8-digit serial number** (generated) and an **ingest key** (shown once).
- Only registered robots are accepted: a robot uploads with its ingest key, and only under its own ID
  (`<robot_id>/sessions/<session>/…`). Data for unknown robots is refused.
- **Hardware**: each fitted part may carry a `product_url` (product page / datasheet). `PATCH /hardware/:id`
  corrects model, serial, URL, fitted date or notes (audited); a different part is still Remove + Fit.
- **Software**: the robot reports versions at boot; an admin can also record an update from the panel
  (`POST /robots/:id/software`, kept in the history as `manual` with who entered it). It records, it does not install.
- **Two distances**: `live.odometer_m` is the robot's lifetime odometer (all driving; a live message without it
  keeps the last value), shown as "Total driven". Mission distance is the sum of `distance_m` over missions.
- **Mission report PDFs** (robot → Missions tab, and each mission page) are built in the browser. Per-waypoint
  rows come from the GCS report's `waypoints: [{sequence, label, lat, lng, reached, reached_at}]`.
- The Saibya Archive server's paths still work for cloud_sync (`PUT /api/ingest/upload`,
  `POST /api/ingest`, `POST /api/ingest/heartbeat`): only the host and the key change.

## Organizations, roles and access

- **Organizations** (`/organizations`): Arnobot (internal) and customers (e.g. Adani). Every user belongs to
  one. A robot belongs to the organization in its current ownership period; assign it with
  `POST /organizations/:id/robots` (or the robot's Ownership tab). The old owner's robot-level grants are revoked.
- **Roles** (see `GET /access-model` or the panel's *Roles & permissions* page), three of them:
  **Admin** (key `super_admin`, Arnobot only: everything, including LiDAR / IMU and user management),
  **Manager** (Arnobot or customer: view, download video + metadata, control robots, acknowledge events) and
  **Viewer** (Arnobot or customer: view, download video + metadata). LiDAR / IMU (`data.sensors`,
  `data.download_restricted`) are Admin-only, so customers never see them. `robot.control` is reserved:
  no remote commands exist yet.
- **Isolation**: customer users see only robots currently assigned to their organization, and never data
  recorded while another customer owned the robot. Customer users can only get grants inside their own
  organization; only a super-admin can give platform roles. Other organizations' recordings answer 404.
- **Logins**: admins create users with an **invitation link** (`/invite#<token>`, single use, 72 h) or a
  **temporary password** (must be changed at first sign-in; the API refuses everything else until then).
  Robot/device credentials and ingest keys stay separate and are never visible to customer roles.
- **Audit log** (`/audit`, CSV export): sign-ins (and failures), invitations, recording views, downloads,
  deletes, robot assignments, grant changes, credential reveals and refused requests. Append-only in the DB.

## S3 archive (video, LiDAR, IMU)

- Bucket `ARCHIVE_S3_BUCKET` (default `arnobot-saibya-data`, `ap-south-1`). Credentials: `ARCHIVE_S3_ACCESS_KEY` /
  `ARCHIVE_S3_SECRET_KEY`, or the EC2 instance role. They need `s3:ListBucket` + `s3:GetObject` (+ `s3:PutObject`
  for robot uploads through the server). The Settings page shows whether the bucket is reachable.
- `ARCHIVE_SYNC_MINUTES` (default 10) re-indexes the bucket at start-up and periodically, so data already in S3
  (e.g. `saibya02/sessions/...`) appears without a manual re-index. Only registered robots are indexed.
- `GET /archive/sessions/:id` always returns all four streams (`video`, `lidar`, `imu`, `metadata`) with
  `available` + `reason`, plus what the caller may do (`access`). LiDAR/IMU previews:
  `/archive/sessions/:id/sensors/lidar?chunk=` and `/sensors/imu`, decoded on the server; unreadable or missing
  files come back as `status: 'unavailable'` with a `problem` code instead of an error.

## Commands

```bash
# database first: in ../storage run npm install, db:create, db:migrate, db:seed
npm install
npm run dev            # http://localhost:4000  (API docs: /api/v1/docs)
npm run archive:sim    # fake robot: uploads test-pattern recordings (needs S3 configured + ffmpeg;
                       # keys from ../storage/.sim-keys.json)
npm run typecheck && npm test
```
