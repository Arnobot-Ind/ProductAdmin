# Backend (`apps/ingest` + `apps/api`, Node.js + Fastify)

Two separate processes with one shared contract (`packages/message-schema`) and one database package (`packages/db`).

| | `apps/ingest` | `apps/api` |
|---|---|---|
| Who calls it | Robots / GCS (internet-facing) | Admin panel only (bind to localhost / private network) |
| Auth | `Authorization: Bearer <ingest key>` | Session cookie `pms_session` |
| Port | 4100 (`INGEST_HOST=0.0.0.0`) | 4000 (`API_HOST=127.0.0.1`) |
| Endpoints | `POST /api/v1/ingest`, `POST /api/v1/gcs/missions/:id/report`, `GET /healthz` | ~90 operations under `/api/v1`: see `api.md`, or live at `/api/v1/docs` |

## Ingestion pipeline (`apps/ingest/src/pipeline.ts`)

Transport-agnostic: `IngestPipeline.process(raw, client, transport)` is called by the HTTPS route and by the optional MQTT adapter (`mqtt.ts`). Per message, **in order**:

1. **Validate** with `parseRobotMessage` (Zod). Unknown fields pass (rule 3). Failure → `rejected` / not retryable, stored in `ingest_rejections`.
2. **Clock guard**: the envelope and every telemetry sample `ts` must be ≤ now + 5 min and ≥ 2024-01-01.
3. **Authorise**: the key's client may speak for this `robot_id` (robot client → itself; GCS client → its robots).
4. **One transaction:** check the robot exists, isn't deleted and the product matches → `INSERT ingested_messages … ON CONFLICT DO NOTHING` (0 rows ⇒ `duplicate`, stop) → bump `live_state.last_seen_at` (and `sw_ver`/`fw_ver` if newest) → route:
   - `hello` → `software_history` row **only if versions/features changed** vs. the state just before this `ts`; `connectivity.reported_ips`.
   - `live` → replace live-state fields **only if `ts > state_ts`** (rule 7).
   - `telemetry` → bulk `INSERT … SELECT unnest(…) ON CONFLICT DO NOTHING` into 4 tables.
   - `event` → insert (unique `msg_id`).
   - `mission` → upsert; a mission id is refused if it belongs to another robot.
   - `pg_notify('pms_changes', …)` (delivered on COMMIT).
5. **Response** per message: `{msg_id, status: stored|duplicate|rejected, error?, retryable?}`. The sender deletes its copy on `stored`/`duplicate`, drops it on non-retryable rejection, and keeps + retries on `retryable: true`.

Batches (≤ 500, ≤ 20 MB) are processed strictly in order. Rate limit: 600 req/min per key. Keys are cached 10 s, so revocation is effective within ~10 s.

**GCS mission report**: `mergeGcsReport()` upserts the same `missions` row. The GCS is authoritative for the planned path / planned distance / waypoints; the robot for actual path / distance / result.

## Admin API (`apps/api`)

- `src/lib/route.ts`: **the only way to add a route.** A route declares `access` (`'public'` | `'signed_in'` | `{ can: '<perm>', target: resolver }`), an optional Zod `query` / `body`, and `upload` for multipart. The helper authenticates → validates → runs `can()` → calls the handler. Handlers never check roles (rule 13).
- Target resolvers: `platform()`, `anyScope()` (list routes; results are then filtered by `applyRobotScope`), `robotParam()`, `robotVia(sql)` (the robot owning a credential/event/mission…), `robotFromBody()`.
- `src/services/permissions.service.ts`: `can(user, action, target)`. platform ⊇ everything; company = robots it **currently** owns; site (future); robot = that robot.
- `src/services/auth.service.ts`: login (argon2id, constant-time user lookup, 5 failures → 15 min lock per email+IP), opaque sessions, change password (ends other sessions).
- `src/realtime.ts`: dedicated `LISTEN pms_changes` connection (auto-reconnect) → Socket.IO `change` to the `fleet` room (platform readers) or per socket after `can()`; sessions re-checked every 60 s.
- Errors: `{ error: { code, message, details? } }`; Postgres constraint errors are mapped to 400/409 (`lib/errors.ts`).
- Security headers (helmet: CSP `default-src 'none'`), `Cache-Control: no-store` on every response, cookie `HttpOnly; SameSite=Lax` (`Secure` when `COOKIE_SECURE=true`), CSRF header + Origin check, 2 MB JSON limit, streamed multipart uploads.

### Permissions (seeded, data not code)

| Permission | super_admin | admin | engineer | viewer |
|---|:-:|:-:|:-:|:-:|
| robot.read, catalog.read | ✓ | ✓ | ✓ | ✓ |
| hardware.write, maintenance.write, document.write, event.ack, credential.read_meta, ingest.read | ✓ | ✓ | ✓ | |
| robot.write, robot.delete, ownership.write, credential.reveal, credential.write, ingest.manage, catalog.write, release.write | ✓ | ✓ | | |
| user.manage | ✓ | | | |

Any role can be granted at platform, company, site or robot scope.

## Credentials (§10)

- `CredentialCipher` (`packages/db/src/credential-crypto.ts`): AES-256-GCM, random 12-byte IV, 16-byte tag, AAD = `robot|kind|slot` (a ciphertext can't be moved to another robot). The key comes from `CREDENTIAL_ENCRYPTION_KEY` (32 bytes base64), never the DB. `key_version` + `CREDENTIAL_ENCRYPTION_OLD_KEYS` allow key rotation.
- Lists return metadata only. `POST /credentials/:id/reveal` needs `credential.reveal` and returns `Cache-Control: no-store`. Rotate = revoke + insert (history kept). Revoke keeps the row.
- Rotation triggers (manual): an employee with access leaves, or a robot returns from outside Arnobot. No scheduled rotation (spec).

## Files (§8)

`POST` multipart streams to a temp file → `StorageService.put()` computes SHA-256 → stores under a **new unique key** (never overwrites) → `files` row. Downloads go through the API (permission-checked): local files are streamed, S3 objects get a 302 to a 5-minute presigned URL. Key layout: `products/{code}/docs/{docId}/v{n}/…`, `robots/{id}/docs/…`, `documents/{docId}/v{n}/…`, `releases/{product}/{component}/{version}/…`.

## Tests

- Unit (`npm test`): contract (20), crypto/keys/ID format (8), `can()` scopes (5), ingest pipeline decisions (6).
- Integration (`npm run qa`): 81 checks against an isolated database. See `qa/QA_PLAN.md`.
