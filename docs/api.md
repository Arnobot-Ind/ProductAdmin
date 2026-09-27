# Admin REST API Reference (`apps/api`)

Base path: `/api/v1`. JSON in and out. Response types are the TypeScript interfaces in
`packages/message-schema/src/dto.ts` (named in the tables below). Live machine-readable spec: `GET /api/v1/openapi.json` (generated from the route registry, including each route's permission). Interactive UI: `GET /api/v1/docs`.

## Conventions

| Topic | Rule |
|-------|------|
| Auth | Session cookie `pms_session` (httpOnly, SameSite=Lax, Secure in prod), set by `POST /auth/login`. Opaque token; the DB stores only an HMAC of it. |
| CSRF | Every non-GET request must send `X-Requested-With: pms-admin`. Requests with a foreign `Origin` are refused. |
| Permissions | Every route declares `(permission, target)` and goes through `can(user, action, target)`. A route with no declaration is **denied** by default. List routes return only what the user may read. |
| Errors | `{ "error": { "code": "snake_case", "message": "…", "details"?: … } }`. Codes: 400 `validation_failed`, 401 `unauthenticated`, 403 `forbidden`, 404 `not_found`, 409 `conflict`, 429 `rate_limited`. |
| Pagination | `?page=1&limit=50` (max 200) → `Paginated<T>` `{ items, total, page, limit }` |
| Time | ISO-8601 UTC with `Z`. Time-series ranges take `?from&to` (defaults: last 24 h). |
| Soft delete | `DELETE` sets `deleted_at`; `POST …/restore` clears it. Lists hide deleted rows unless `?include_deleted=true`. |
| Secrets | Never in list or detail responses. Only `POST /credentials/:id/reveal` returns one (`Cache-Control: no-store`). |
| Uploads | `multipart/form-data`, field `file`, max `MAX_UPLOAD_MB`. The server computes the SHA-256. |

## Endpoints

### Auth and meta
| Method | Path | Permission | Body → Response |
|---|---|---|---|
| POST | `/auth/login` | public | `{email, password}` → `MeDto` + cookie |
| POST | `/auth/logout` | signed in | → 204 |
| GET | `/auth/me` | signed in | → `MeDto` |
| POST | `/auth/change-password` | signed in | `{current_password, new_password}` → 204 |
| GET | `/healthz` | public | → `{ok, db, storage, time}` |
| GET | `/openapi.json` | public | OpenAPI 3.1 document |
| GET | `/docs` | public | Swagger UI |

### Dashboard
| GET | `/dashboard` | robot.read (any scope) | → `DashboardDto` |
|---|---|---|---|

### Catalogue (spec §4)
| Method | Path | Permission | Body → Response |
|---|---|---|---|
| GET | `/companies` | catalog.read | → `CompanyDto[]` |
| GET | `/part-types` | catalog.read | → `PartTypeDto[]` |
| POST | `/part-types` | catalog.write | `{key, name, max_per_robot?}` → `PartTypeDto` |
| GET | `/products` | catalog.read | `?include_deleted` → `ProductDto[]` |
| POST | `/products` | catalog.write | `{code, name, description?}` → `ProductDto` |
| GET | `/products/:id` | catalog.read | → `ProductDto & { revisions: HardwareRevisionDto[] }` |
| PATCH | `/products/:id` | catalog.write | `{name?, description?}` → `ProductDto` (code is permanent) |
| DELETE / POST | `/products/:id`, `/products/:id/restore` | catalog.write | soft delete / restore |
| GET | `/products/:id/documents` | catalog.read | → `DocumentDto[]` (product + its revisions) |
| POST | `/products/:id/revisions` | catalog.write | `{name, description?, components?: [{part_type_key, slot?, model?}]}` → `HardwareRevisionDto` |
| PATCH | `/revisions/:id` | catalog.write | `{name?, description?}` → `HardwareRevisionDto` |
| PUT | `/revisions/:id/components` | catalog.write | `{components: [{part_type_key, slot?, model?}]}` → `HardwareRevisionDto` |
| DELETE / POST | `/revisions/:id`, `/revisions/:id/restore` | catalog.write | soft delete / restore |

### Robots (spec §3)
`:robotId` is the permanent Robot ID (`saibya02`). Unless noted, reads need `robot.read` and writes `robot.write` **on that robot**.

| Method | Path | Permission | Body → Response |
|---|---|---|---|
| GET | `/robots` | robot.read | `?q&product&status=online\|stale\|offline&include_deleted&sort&page&limit` → `Paginated<RobotListItemDto>` (§5 view 1) |
| POST | `/robots` | robot.write (platform) | `{product_id, serial_number, hardware_revision_id?, notes?}` → 201 `RobotRegisteredDto` (**ingest key shown once**) |
| GET | `/robots/:robotId` | | → `RobotDetailDto` |
| PATCH | `/robots/:robotId` | | `{serial_number?, hardware_revision_id?, notes?}` → `RobotDetailDto`. Robot ID and product cannot change. |
| DELETE / POST | `/robots/:robotId`, `…/restore` | robot.delete | soft delete / restore |
| GET | `/robots/:robotId/live` | | → `LiveStateDto` |
| GET | `/robots/:robotId/ownership` | | → `OwnershipDto[]` (newest first) |
| POST | `/robots/:robotId/ownership` | ownership.write | `{company_id, reason?, valid_from?}` → `OwnershipDto[]` (closes the current row, opens a new one) |
| GET | `/robots/:robotId/hardware` | | `?current=true` → `HardwarePartDto[]` |
| POST | `/robots/:robotId/hardware` | hardware.write | `{part_type_key, slot?, model?, serial_number?, fitted_at, notes?}` → `HardwarePartDto` |
| POST | `/hardware/:id/remove` | hardware.write | `{removed_at, reason?}` → `HardwarePartDto` |
| GET | `/robots/:robotId/software` | | → `SoftwareDto` |
| GET | `/robots/:robotId/connectivity` | | → `ConnectivityDto` |
| PUT | `/robots/:robotId/connectivity` | | `{network_address?, ssh_ip?, cloudflare_tunnel_hostname?, omni_ip?, wifi_router_ip?, gcs_camera_domain?, gcs_server_domain?}` → `ConnectivityDto` |
| PUT | `/robots/:robotId/cameras/:slot` | | `{ip?, stream_url?, model?}` → `ConnectivityDto`. A stream URL containing `user:pass@` is refused. |
| GET | `/robots/:robotId/dispatch` | | → `DispatchWarrantyDto` |
| PUT | `/robots/:robotId/dispatch` | | `{dispatch_date?, warranty_start?, warranty_end?, warranty_document_id?, notes?}` → `DispatchWarrantyDto` |
| GET | `/robots/:robotId/maintenance` | | `?include_deleted` → `MaintenanceDto[]` |
| POST | `/robots/:robotId/maintenance` | maintenance.write | `{repaired_at, description, repaired_by, part_removed_serial?, part_fitted_serial?, swap?: {remove_hardware_id?, part_type_key, slot?, model?}}` → `MaintenanceDto`. With `swap`, the old part is closed and the new one fitted **in the same transaction**. |
| PATCH | `/maintenance/:id` | maintenance.write | `{repaired_at?, description?, repaired_by?, part_removed_serial?, part_fitted_serial?}` |
| DELETE / POST | `/maintenance/:id`, `…/restore` | maintenance.write | soft delete / restore |
| GET | `/robots/:robotId/telemetry/gps` | | `?from&to&bucket_s` → `TelemetrySeriesDto<GpsPointDto>` |
| GET | `/robots/:robotId/telemetry/battery` | | → `TelemetrySeriesDto<BatteryPointDto>` |
| GET | `/robots/:robotId/telemetry/encoders` | | → `TelemetrySeriesDto<EncoderPointDto>` |
| GET | `/robots/:robotId/telemetry/health` | | → `TelemetrySeriesDto<HealthPointDto>` |
| GET | `/robots/:robotId/missions` | | `?result&page&limit` → `Paginated<MissionListItemDto>` (§5 view 2) |
| GET | `/robots/:robotId/events` | | `?type&severity&unacked&page&limit` → `Paginated<EventDto>` |
| GET | `/robots/:robotId/documents` | | → `DocumentDto[]`: effective docs = robot ∪ its revision ∪ its product |

`bucket_s`: 0 returns raw rows (capped at 5000). Omitted, it is chosen automatically so a range returns ≤ ~1000 points. The API uses `date_bin()`.

### Credentials and ingest keys (spec §3 row 6, §10)
| Method | Path | Permission | Body → Response |
|---|---|---|---|
| GET | `/robots/:robotId/credentials` | credential.read_meta | `?include_revoked` → `CredentialMetaDto[]` (**metadata only**) |
| POST | `/robots/:robotId/credentials` | credential.write | `{kind, slot?, label?, username?, secret}` → `CredentialMetaDto` |
| POST | `/credentials/:id/reveal` | credential.reveal | → `CredentialRevealDto` (`Cache-Control: no-store`) |
| POST | `/credentials/:id/rotate` | credential.write | `{secret, username?, label?}` → `CredentialMetaDto` (the old row is revoked, a new row is inserted) |
| POST | `/credentials/:id/revoke` | credential.write | `{reason}` → `CredentialMetaDto` |
| GET | `/ingest-clients` | ingest.manage | `?robot_id` → `IngestClientDto[]` |
| POST | `/ingest-clients` | ingest.manage | `{name, kind: 'gcs', robot_ids, notes?}` → `IngestKeyIssuedDto` |
| POST | `/ingest-clients/:id/keys` | ingest.manage | → `IngestKeyIssuedDto` (a new key; the old one stays valid until revoked, for zero-downtime rotation) |
| PUT | `/ingest-clients/:id/robots` | ingest.manage | `{robot_ids}` → `IngestClientDto` (GCS clients only) |
| POST | `/ingest-clients/:id/revoke` | ingest.manage | → `IngestClientDto` |
| POST | `/ingest-keys/:id/revoke` | ingest.manage | → `IngestClientDto` |

### Missions (spec §5)
| Method | Path | Permission | Response |
|---|---|---|---|
| GET | `/missions` | robot.read | `?robot&result&from&to&page&limit` → `Paginated<MissionListItemDto>` |
| GET | `/missions/:missionId` | robot.read (the mission's robot) | → `MissionDetailDto` (§5 view 3) |
| GET | `/mission-files/:id/download` | robot.read | 302 to a short-lived link, or streamed |

### Events (spec §3 row 13)
| Method | Path | Permission | Body → Response |
|---|---|---|---|
| GET | `/events` | robot.read | `?robot&type&severity&unacked=true&from&to&page&limit` → `Paginated<EventDto>` |
| POST | `/events/:id/ack` | event.ack | → `EventDto` |
| POST | `/events/ack` | event.ack | `{ids: string[]}` → `{acknowledged: number}` |

### Documents and files (spec §3 rows 7–8, §8)
| Method | Path | Permission | Body → Response |
|---|---|---|---|
| POST | `/documents` | document.write | multipart: `file`, `doc_type`, `title`, exactly one of `product_id` / `hardware_revision_id` / `robot_id`, `note?` → `DocumentDto` (v1) |
| POST | `/documents/:id/versions` | document.write | multipart: `file`, `note?` → `DocumentDto` (new version; old ones kept) |
| PATCH | `/documents/:id` | document.write | `{title}` → `DocumentDto` |
| DELETE / POST | `/documents/:id`, `…/restore` | document.write | soft delete / restore |
| GET | `/document-versions/:id/download` | robot.read / catalog.read | file stream or 302 |

### Releases (spec §9)
| Method | Path | Permission | Body → Response |
|---|---|---|---|
| GET | `/releases` | catalog.read | `?product_id&component&include_deleted` → `ReleaseDto[]` |
| POST | `/releases` | release.write | multipart: `file?`, `product_id`, `component`, `version` (semver), `signature`, `signature_algo?`, `sha256?` (must match the file), `requires_component?`, `requires_min_version?`, `notes?` → `ReleaseDto` |
| GET | `/releases/:id/download` | catalog.read | file |
| DELETE / POST | `/releases/:id`, `…/restore` | release.write | soft delete / restore. A version number is never reused. |

### Users and access (spec §12)
| Method | Path | Permission | Body → Response |
|---|---|---|---|
| GET | `/users` | user.manage | `?include_deleted` → `UserDto[]` |
| POST | `/users` | user.manage | `{email, name, password, role_key, scope_type?, scope_id?}` → `UserDto` |
| PATCH | `/users/:id` | user.manage | `{name?, is_active?, password?}` → `UserDto` |
| DELETE / POST | `/users/:id`, `…/restore` | user.manage | soft delete (also ends their sessions) / restore |
| GET | `/roles` | user.manage | → `RoleDto[]` |
| POST | `/users/:id/grants` | user.manage | `{role_key, scope_type, scope_id?}` → `UserDto` |
| POST | `/grants/:id/revoke` | user.manage | → `UserDto` |

### Ingest log
| Method | Path | Permission | Response |
|---|---|---|---|
| GET | `/ingest/messages` | ingest.read | `?robot&type&page&limit` → `Paginated<IngestLogItemDto>` |
| GET | `/ingest/messages/:msgId` | ingest.read | → `IngestLogItemDto` with `raw` |
| GET | `/ingest/rejections` | ingest.read | `?page&limit` → `Paginated<IngestRejectionDto>` |

## Realtime (Socket.IO)

Connect to `NEXT_PUBLIC_WS_URL` with `withCredentials: true`. The session cookie authenticates the handshake. The server emits:

- `change`: `RealtimeChange`: `{kind: 'live'|'seen'|'event'|'mission'|'software'|'telemetry', robot_id, …}`

A client receives changes only for robots it may read. The panel uses these to invalidate its TanStack Query caches. Status still ages client-side, because it's computed from `last_seen_at`.

## Ingest service (`apps/ingest`, separate process, port 4100)

Used by robots and the GCS, never by the admin panel. See `message-contract.md` and `gcs/gcs-integration-checklist.md`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/v1/ingest` | `Bearer <ingest key>` | One envelope or an array (≤ 500, oldest first) → `{results: [{msg_id, status: stored\|duplicate\|rejected, error?, retryable?}], summary}` |
| POST | `/api/v1/gcs/missions/:missionId/report` | `Bearer <ingest key>` | GCS mission report → 201 created / 200 merged |
| GET | `/healthz` | none | liveness + DB check |
