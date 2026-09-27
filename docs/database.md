# Database Design

PostgreSQL 16+ (the local service; tested on 18.4). TimescaleDB is **optional** (decision D5). The SQL in `packages/db/migrations/NNNN_*.sql` is the source of truth; this page explains it. § = section of `spec/robot-record-spec.md`.

## Commands

| Command | Does |
|---|---|
| `npm run db:create` | Creates the `pms` role + `arnobot_pms` database using `PG_ADMIN_URL` (superuser, used once), and the extensions (+ timescaledb if present) |
| `npm run db:migrate` / `db:status` | Applies pending migrations in order, each in a transaction. **Refuses** if an applied file was edited (SHA-256 check, rule 14). |
| `npm run db:seed` | First super-admin from `SEED_ADMIN_*`, Saibya Rev A, and demo robots + `.sim-keys.json` (if `SEED_DEMO_ROBOTS=true`) |
| `npm run db:timescale` | Converts telemetry to hypertables once TimescaleDB is installed (idempotent) |
| `npm run db:reset` | **Dev only**: localhost + `--confirm` required. Drops and recreates the DB. |

## Conventions

- PKs are `uuid` (`gen_random_uuid()`), except the natural permanent IDs `robots.robot_id` and `missions.mission_id` (text).
- Every timestamp is `timestamptz`; connections run with `TimeZone=UTC`. Calendar-only values (fitted, repaired, dispatch, warranty) are `date`.
- Units are in the column name: `battery_pct`, `alt_m`, `signal_dbm`, `temp_controller_c`.
- Admin-editable tables have `created_at`, `created_by`, `updated_at` (trigger-maintained) and `deleted_at`.
- Growing lists are **tables** (`products`, `part_types`, `roles`, `permissions`). Spec-fixed sets are `text` + `CHECK`, so a new migration can widen them.

## Guards enforced by the database (the last line of defence)

| Function | Used for | Rule |
|---|---|---|
| `pms_forbid_delete()` | **every** domain table: `DELETE` raises. A deliberate, instructed purge must first run `SET LOCAL pms.allow_hard_delete='on'`. | 10 |
| `pms_forbid_update()` | append-only history: `software_history`, `document_versions`, `mission_files`, `ingested_messages`, `ingest_rejections`, all `telemetry_*` | 4, 6 |
| `pms_allow_update_only(cols…)` | append-only with one permitted change: events (ack), ownership (close `valid_to`), hardware (removal), credentials (revocation), files (`deleted_at`), releases (`notes`, `deleted_at`), ingest keys, role grants | 2, 4, 11 |
| `pms_immutable_columns(cols…)` | `robots.robot_id/product_id/running_number`, `products.code`, `missions.mission_id/robot_id`, document owner | 1, 15 |
| `EXCLUDE USING gist` | no overlapping ownership (or site) periods per robot | 2 |
| `CHECK` | camera stream URL without `user:pass@`; robot_id ≠ serial; health ∈ ok/warning/fault; exactly one document owner; GeoJSON type; semver releases; lat/lon ranges | 1, 11 |

`npm run qa` (sections B and G) proves each guard fires, by trying the forbidden statement on real rows.

## Tables

### Organisation and access (§1, §12) · `0002`
| Table | Purpose |
|---|---|
| `companies` | v1: Arnobot only. Customers are later rows. |
| `sites` | Future. Present so site-scoped grants are data, not code. |
| `users` | email (citext, unique among non-deleted), argon2id `password_hash` (never returned), `is_active` |
| `roles`, `permissions`, `role_permissions` | Seeded: roles `super_admin`, `admin`, `engineer`, `viewer`; 17 `<resource>.<verb>` permissions |
| `role_grants` | user → role → scope (`platform` / `company` / `site` / `robot`, `scope_id`); revocable |
| `sessions` | HMAC of the session token, expiry, revocation, ip / user agent |

### Catalogue (§4) · `0003`
| Table | Purpose |
|---|---|
| `products` | `code` (permanent, prefixes Robot IDs), `name`, `next_running_number` |
| `hardware_revisions` | "Rev A" per product (optional on robots in v1) |
| `part_types` | gps, encoder, imu, lidar, camera (max 4), controller: rows, not enums |
| `hardware_revision_components` | the main components defining a revision |

### Robot record (§3) · `0004`–`0006`
| Table | § row | Notes |
|---|---|---|
| `robots` | 1 | `robot_id` PK (immutable), `serial_number` (unique, case-insensitive, even across deleted robots), product, revision, running number |
| `company_assignment_history` | 2 | `valid_from` / `valid_to` (NULL = current); one open row per robot; no overlaps |
| `site_assignment_history` | future | same pattern |
| `hardware_fitted` | 3 | one row per fitting; `removed_at` closes it; one current part per (robot, type, slot); linked to the repair that fitted/removed it |
| `maintenance_log` | 9 | one row per repair; a "swap" repair closes/opens `hardware_fitted` rows in the same transaction |
| `software_history` | 4 | a row only when versions/features **change** (from `hello`); current = latest |
| `connectivity`, `robot_cameras` | 5 | admin-entered; `inet` columns; camera URLs must not carry credentials; `reported_ips` from `hello` kept separately |
| `dispatch_warranty` | 8 | dates + a warranty clauses document; warranty status computed (active / expiring ≤ 30 d / expired) |
| `files` | 7, 8 | storage registry: driver, bucket, key, S3 `version_id`, size, **sha256** |
| `documents`, `document_versions` | 7 | doc attached to exactly one of product / revision / robot; every upload = new version |
| `robot_credentials` | 6 | AES-256-GCM `ciphertext`, `iv` (12 B), `auth_tag` (16 B), `key_version`; one active secret per (robot, kind, slot); rotation = revoke + insert (`rotated_from_id`) |
| `ingest_clients`, `ingest_client_robots`, `ingest_keys` | §10 | who may push data, for which robots; SHA-256 key hashes; revocable |

### Live, events, missions, ingest · `0007`
| Table | Notes |
|---|---|
| `live_state` | **one row per robot, overwritten** (rule 4). `last_seen_at` = receive time of any message; the fields are replaced only by a newer `state_ts` (rule 7). |
| `ingested_messages` | every accepted message, `msg_id` PK (rule 6), raw envelope kept |
| `ingest_rejections` | every refused message with the reason (kept for diagnosis) |
| `events` | append-only; `msg_id` unique; only `acknowledged_by/at` may change |
| `missions` | `mission_id` PK (`saibya02-M0001`), `duration_s` **generated**, result `completed/failed/aborted/in_progress`, planned/actual GeoJSON, raw GCS report, `external_id` (GCS UUID) |
| `mission_files` | one row per file: S3 path (+ optional `file_id`) |

### Sensor data (§3 row 11) · `0008`
`telemetry_gps`, `telemetry_encoder`, `telemetry_battery`, `telemetry_health`: append-only, with a unique `(robot_id[, encoder], ts)` index (duplicate backstop + Timescale-compatible) and BRIN on `ts`. Reads downsample with `date_bin()`. `pms_enable_timescale()` converts them to hypertables (7-day chunks, compression after 30 days, **no retention policy**, rule 10).

### Releases (§9) · `0009`
`releases`: product, component (software/firmware), semver `version` (never reused), package `file_id`, `sha256` (computed server-side), `signature` + algo, `requires_component` + `requires_min_version` (the other component).

### Views · `0010`
| View | Computes |
|---|---|
| `v_robot_status` | online < 60 s · stale 60 s–5 min · offline (or never seen) |
| `v_robot_current_owner` | the open ownership row |
| `v_robot_mission_summary` | §5 view 1 totals from `missions` rows |
| `v_robot_current_software` | latest software row |

### Reference data · `0011`
Arnobot, the five products, six part types, 17 permissions, four roles and their permission sets.

## Scaling notes

- Volume: about 2 messages / 30 s per robot → ~6 k rows/day per robot in `ingested_messages`, plus ~10 samples per telemetry batch. Plain Postgres handles hundreds of robots. Install TimescaleDB before thousands, or for multi-year raw retention with compression.
- Hot paths are indexed (verified in QA): robot list, events by robot/time, unacknowledged events, telemetry by `(robot_id, ts)`, missions by robot/start.
- `ingested_messages.raw` grows forever by design (retention = keep everything). Partitioning by month is a later option.
