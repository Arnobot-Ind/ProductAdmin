# QA Plan: Arnobot PMS Product Admin

Three layers, cheapest first. Run all three before every release or merge to `main`.

| Layer | Command | Needs | Time |
|---|---|---|---|
| 1. Static: typecheck all 6 workspaces | `npm run typecheck` | nothing | ~30 s |
| 2. Unit: 39 tests (contract, crypto, keys, `can()`, ingest decisions) | `npm test` | nothing | ~15 s |
| 3. Integration: **81 checks** across backend, SQL, ingest, API, realtime, frontend bundle | `npm run build && npm run qa` | local PostgreSQL + `PG_ADMIN_URL` | ~1 min |

`npm run qa` is **isolated**. It drops and recreates `arnobot_pms_qa`, migrates and seeds it, starts its own API (:4900) and ingest (:4910), runs every check and stops them again. Your real database and `.sim-keys.json` are never touched. Results go to `docs/qa/LAST_RUN.md` (human-readable) and `docs/qa/reports/qa-<timestamp>.json`. The exit code is 1 if anything fails, so it can gate CI.

## What the integration suite checks (`tools/qa/run-qa.mjs`)

### A. Repository and configuration
- Rule 12: `NEXT_PUBLIC_GCS_API_TOKEN` is never defined or read.
- `.env`, `.sim-keys.json` and `storage/` are git-ignored.
- `.env.example` holds no real secrets.
- Rule 14: migrations are numbered without gaps.
- Rule 10: no hard `DELETE` in app code; no Timescale retention policies.
- Frontend code never reads server-only env vars.

### B. Database design (SQL)
- All migrations are applied and none were modified (checksums).
- All 39 designed tables exist.
- **Every domain table has the no-hard-delete trigger.**
- No `company_id` on `robots` (rule 2); no secret-looking columns in normal tables (rule 11).
- Guard probes. Each forbidden statement is attempted and must fail *with the trigger's own error*:
  - rename a robot ID;
  - robot ID = serial;
  - duplicate serial (any case);
  - overlapping ownership;
  - hard delete;
  - camera URL containing credentials;
  - product code change.
- Status thresholds at 59 s / 61 s / 299 s / 301 s and never-seen (rule 8).
- Reference data is present.
- Hot queries use indexes (`EXPLAIN`).

### C. Ingestion rules
- 401 for a bad or missing key.
- **Rule 6:** a duplicate `msg_id` is stored once.
- **Rule 7:** an older live message does not overwrite newer state.
- A key can't speak for another robot; product mismatch is refused.
- **Rule 3:** unknown fields are kept.
- Clock guard.
- Invalid payload → non-retryable and recorded.
- **§11 backlog:** replay lands at the original `ts`, and repeated samples don't duplicate rows.
- `hello` versions add history only on change.
- Robot + GCS mission merge: robot path/result win, GCS plan wins.
- A mission can't move to another robot.

### D. Admin API and permissions
- Health; 401 without a session.
- **CSRF:** the header is required and a foreign Origin is refused.
- httpOnly + SameSite cookie.
- 31 read endpoints return 200.
- §5 totals are computed.
- Registration: ID format, key shown once and working, key never listed.
- Duplicate serial → 409; `PATCH` can't change the robot ID.
- Soft delete / restore; ID never reused; a deleted robot can't ingest.
- Ownership transfer rules.
- **Secrets:** never in create/list/detail responses, encrypted at rest, reveal is `no-store`, rotate/revoke work.
- Camera URL with credentials → 400.
- Document versions: v1 kept and downloadable, and appears in the robot's effective documents.
- Releases: server-side SHA-256, declared mismatch refused, version never reused.
- Maintenance part swap is atomic.
- Event acknowledgement: who/when recorded, double ack refused.
- Telemetry downsampling.
- **Permission matrix:**
  - a platform viewer can read but not write, see credentials, manage users or acknowledge events;
  - a robot-scoped engineer sees only its robot (lists filtered, 403 elsewhere), can't reveal credentials, and can log maintenance on its robot.
- The last super-admin can't be removed.
- Logout revokes the session.
- OpenAPI lists a permission for every route.
- No password or key hashes appear in any response.

### E. Realtime
- An ingested live message reaches a signed-in Socket.IO client.

### F. Frontend
- A production build exists.
- **No server secret value is in any browser bundle file.**

### G. Database guards on real rows
- The row-level append-only / write-once guards are exercised after ingestion has created data:
  - `software_history`, `telemetry` and `ingested_messages` can't be updated;
  - credential ciphertext can't be changed;
  - only acknowledgement may change on events;
  - a mission's robot is permanent.

## Manual checklist (UI, run with the simulator: `npm run sim -- --scenario mixed --speed 10`)

**Functional**
- [ ] Sign in and out; wrong password shows an error; 5 wrong attempts lock for 15 min.
- [ ] Dashboard counts match `/robots`; the fault list and expiring warranties appear.
- [ ] Robot list: sort each column, filter by product/status, search by ID/serial, pagination.
- [ ] Status ages Online → Stale → Offline without a reload (stop the simulator).
- [ ] Register a robot: the ID is generated; the key is shown once with a copy button; it can't be seen again.
- [ ] Robot detail: every tab loads with data **and** with no data (fresh robot); `?tab=` survives a reload.
- [ ] Telemetry: each range preset; map track; charts show units.
- [ ] Mission detail: planned dashed + actual solid on the map; stats; files.
- [ ] Credentials: add, reveal (confirm dialog, auto-hide 30 s), rotate, revoke; a viewer can't see the tab.
- [ ] Documents: upload, new version, download v1 and v2.
- [ ] Maintenance with part swap → the Hardware tab shows the old part removed and the new one fitted.
- [ ] Ingest page: accepted list, raw envelope, rejected list with reasons, GCS client creation, key rotation.

**Accessibility (WCAG 2.2 AA)**
- [ ] Keyboard only: the skip link works; the tab order is logical; every control is reachable; focus is always visible.
- [ ] Tabs: arrow keys, Home and End; dialogs trap focus, close on Esc and return focus.
- [ ] Screen reader (NVDA / Narrator): page titles, landmarks, table captions, sort state, form labels and error messages are announced.
- [ ] Status/health are readable without colour (icon + text); contrast ≥ 4.5:1 in light **and** dark themes.
- [ ] 200 % zoom and a 768 px-wide tablet: no loss of content.
- [ ] `prefers-reduced-motion` is honoured.

**Security spot checks**
- [ ] DevTools → Application: `pms_session` is HttpOnly; no secrets in localStorage/sessionStorage.
- [ ] DevTools → Network: no credential secret in any response except `/reveal`; `/reveal` has `Cache-Control: no-store`.
- [ ] Response headers: CSP, X-Frame-Options DENY, nosniff and Referrer-Policy are present.

## Defects found and fixed during QA (2026-09-27)

| # | Found by | Defect | Fix |
|---|---|---|---|
| 1 | QA C (GCS report 401) | The seed reused a GCS key from an old `.sim-keys.json` that didn't exist in a fresh DB | The seed now verifies every key against the DB and re-issues stale ones; QA also isolates the keys file |
| 2 | QA B (probes "allowed") | Row-level guard probes ran on empty tables, so they proved nothing | Moved to section G, after data exists; they now assert the trigger's own message |
| 3 | QA G | No-op updates (`x = x`) passed the "only these columns may change" guard | Correct behaviour; the probes now make real changes |
| 4 | Stack run | The admin panel sent no Content-Security-Policy | Allow-list CSP in `next.config.ts` |
| 5 | Review | The API bound to all network interfaces in dev | `API_HOST=127.0.0.1` default; only ingest listens on the LAN |
| 6 | Migration run | `SET TIME ZONE` on connect raced the first query (pg deprecation) | Time zone set via connection options |
| 7 | Seed run | Parameter type conflicts (`$1` used as uuid and text; `date + unknown`) | Explicit casts / separate params |
| 8 | Typecheck | `Omit<>` over a Zod `looseObject` erased envelope field types | Explicit `EnvelopeBase` interface |
| 9 | Review | `.parse()` on bad scope/release ids would have returned 500 | `safeParse` → 400 |
| 10 | Review | The Swagger page CSP hash was a placeholder | Hash computed from the script at start-up |

## Before go-live (outside the automated suite)

- [ ] `COOKIE_SECURE=true`, TLS everywhere, the API not publicly reachable (only ingest).
- [ ] A new `CREDENTIAL_ENCRYPTION_KEY` / `SESSION_SECRET` for production, stored in a secret manager; back up the key (**without it every stored credential is lost**).
- [ ] `STORAGE_DRIVER=s3` with **bucket versioning enabled** and the bucket private.
- [ ] Postgres backups (PITR) tested with a restore.
- [ ] Run `npm run qa` against a staging copy.
