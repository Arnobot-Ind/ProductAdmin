# Deploying the backend on the server

How the production server (EC2, Ubuntu, Node 22) runs this branch. No secrets live here: they are only in
the server's `.env` files and in `~/productadmin-secrets/` (mode 700).

## Layout

| Path | What |
|---|---|
| `/opt/productadmin/backend` | clone of branch `backend`; the app is `backend/backend` (`.env` beside `package.json`) |
| `/opt/productadmin/storage` | clone of branch `storage`; migrations + seed run from `storage/storage` |
| `/opt/productadmin/rds-global-bundle.pem` | AWS RDS CA bundle, for a verified TLS connection to the database |
| `/opt/productadmin/tmp` | `ARCHIVE_TEMP_DIR` (MP4 exports), safe to empty |
| `/opt/productadmin/documents` | `STORAGE_LOCAL_DIR`, used while `STORAGE_DRIVER=local` |
| `/opt/productadmin/backups` | `pg_dump` taken before each deploy (mode 700) |

- Process: pm2 `productadmin-backend` (`pm2 start npm --name productadmin-backend -- start`, then `pm2 save`).
- nginx: [`nginx.conf`](nginx.conf) → `/etc/nginx/sites-available/productadmin`.
- Database: managed PostgreSQL (Lightsail / RDS), database `arnobot_pms`, app role `pms` (not the master user).
  `DATABASE_URL=postgres://pms:<password>@<host>:5432/arnobot_pms?sslmode=verify-full&sslrootcert=/opt/productadmin/rds-global-bundle.pem`
  in both `backend/.env` and `storage/.env`. Keep other apps' databases on the same instance untouched.
- S3 archive: the EC2 instance role (`ARCHIVE_S3_ACCESS_KEY` / `ARCHIVE_S3_SECRET_KEY` empty). After any IAM
  role change restart the process: the SDK caches the old role's credentials.
- `ADMIN_ORIGIN` lists every origin the admin panel is served from, comma-separated (production domain,
  Netlify URL, `http://localhost:3000` for a local panel pointed at this server). A missing origin → login 403
  "cross-origin request refused".

## Update (after a push to `backend` / `storage`)

```bash
cd /opt/productadmin
F=backups/arnobot_pms-pre-$(git -C backend rev-parse --short origin/backend)-$(date -u +%Y%m%d%H%M).dump
pg_dump -d "$(grep ^DATABASE_URL= storage/storage/.env | cut -d= -f2-)" -Fc -f "$F"   # backup first
git -C storage pull --ff-only && git -C backend pull --ff-only
(cd storage/storage && npm ci && npm run db:migrate)
(cd backend/backend && npm ci && npm run build)
pm2 restart productadmin-backend
curl -s http://127.0.0.1:4000/api/health        # {"ok":true,...}
```

The admin panel proxies to this server, so deploy the backend **before** (or with) a frontend that uses new
routes: an older backend answers the new pages with 404.

Robots keep working through the restart (~10 s): cloud_sync and fleet_sync queue locally and catch up.

## Roll back

`git -C backend checkout <previous commit>`, rebuild, restart. Migrations only move forward: if one must be
undone, restore the pre-deploy dump (`pg_restore --clean --no-owner --no-acl`, skipping the `EXTENSION`
entries, which the app role cannot own).

## Good to know

- Sign-in lockout (5 failures → 15 min) is kept in memory: `pm2 restart productadmin-backend` clears it.
- Robot ingest keys are stored as SHA-256 only. A key issued by another PMS instance (e.g. a laptop) is not
  valid here until it is issued again from this server (robot → Credentials).
- HTTPS: once `api.arnobot.in` resolves to the server, `sudo certbot --nginx -d api.arnobot.in`, then
  `COOKIE_SECURE=true` and restart. Socket.IO from an HTTPS panel needs this (or a proxy on the panel's host).
