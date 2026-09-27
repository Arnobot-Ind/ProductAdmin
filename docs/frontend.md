# Frontend (`apps/admin`, Next.js 16 admin panel)

As built: Next.js 16.3 (App Router, Turbopack), React 19, Tailwind 4, TanStack Query 5, socket.io-client 4, MapLibre GL 6 (OpenStreetMap tiles), Recharts 3, lucide icons. Arnobot brand colours/typography from the GCS brand guide. `next.config.ts` loads the root `.env`, proxies `/api/v1/*` to the API (same-origin cookies), and sets CSP and security headers.

Accessibility (WCAG 2.2 AA target): skip link, landmarks, visible focus, keyboard-operable ARIA tabs (arrow/Home/End), dialogs with focus trap + Esc + focus return, labelled inputs, `aria-sort` table headers, `aria-live` toasts, status/health shown by icon **and** text (never colour alone), `prefers-reduced-motion`, light/dark theme without a flash.

Secrets: revealed credentials and newly issued keys live only in component state (never the query cache) and auto-hide after 30 s.

Arnobot team only. Desktop-first but usable on a tablet. Talks only to `apps/api` (through the same-origin `/api/v1` proxy). The only public env var is `NEXT_PUBLIC_WS_URL`. **No secret ever goes into client code or `NEXT_PUBLIC_*`.**

## Routes

| Route | Content |
|-------|---------|
| `/login` | Email + password |
| `/` Dashboard | Counts by status (Online / Stale / Offline), unacknowledged critical events, robots with a device in `fault`, recent missions |
| `/robots` | **Robot summary table** (spec §5 view 1): Robot ID, product, serial, status badge, last seen, battery, total / completed / failed / aborted missions, total distance, total and average duration. Filters: product, status. |
| `/robots/new` | Register a robot: product → (revision) → serial. Robot ID is generated and shown, not typed. Shows the robot key once on success. |
| `/robots/[robotId]` | Robot detail with tabs ↓ |
| `/missions/[missionId]` | **Mission detail** (§5 view 3): header stats, map with planned (dashed) + actual (solid) paths, files list (video player / image preview / MCAP download) |
| `/events` | Global event log, filter by robot / type / severity / unacked, bulk acknowledge |
| `/products` | Product list → `/products/[id]`: revisions, main components per revision, product/revision documents |
| `/releases` | Software / firmware releases per product: version, checksum, signature, requires, upload |
| `/admin/users` | Users, role grants (scope picker) |
| `/ingest` | Ingest log: accepted messages (raw envelope viewer), rejected messages with reasons, robot + GCS ingest clients and key rotation |
| `/missions` | All missions, filter by robot / result |
| `/account` | Change own password |

### Robot detail tabs (`/robots/[robotId]`)

Header (always visible): Robot ID, product, revision, serial, owner company, status badge, last seen, current mission link.

| Tab | Spec section | Content |
|-----|-------------|---------|
| Overview / Live | 10 | Live state cards: position on a mini-map + fix, battery, signal, temps, armed/mode, device health chips (OK/Warning/Fault). Pushed live over Socket.IO; 15 s polling fallback. |
| Telemetry | 11 | Time-range picker; GPS track on a map; charts for battery, temperatures, encoder velocity; health timeline |
| Missions | 12 | §5 view 2 list: Mission ID, start, end, duration, distance, result, end reason → click opens mission detail |
| Events | 13 | Event log for this robot, acknowledge |
| Hardware | 3 | Currently fitted parts (type, slot, model, serial, fitted date) + full history |
| Software | 4 | Current SW/FW, enabled features, last update, version history |
| Connectivity | 5 | Editable form; camera table (4 slots). Shows `reported_ips` from the last hello next to the admin values, highlighted when they differ |
| Credentials | 6 | Metadata list only; "Reveal" (permission-gated, confirm dialog, auto-hides after 30 s), Rotate, Revoke; robot auth keys |
| Documents | 7 | Effective docs grouped by source (robot / revision / product), latest version + version history, upload new version |
| Dispatch & Warranty | 8 | Dates + warranty clauses file; warranty-expiring badge |
| Maintenance | 9 | Repair log + add repair (optionally swaps a part in Hardware) |
| Ownership | 2 | Ownership history timeline; "Transfer" (v1: Arnobot only, but the UI already supports it) |

## UI conventions

- Status badge colours: Online = green, Stale = amber, Offline = grey. Health: OK = green, Warning = amber, Fault = red.
- Show times in the user's local zone with UTC on hover. Store and send UTC.
- Units always shown (m, km, m/s, °C, %, V, dBm). Durations as `1h 12m`.
- Hide controls the user can't use (the API still enforces). `GET /auth/me` returns the effective permissions.
- Soft-deleted items are hidden by default, with a "Show deleted" toggle and a Restore action.
- Empty states matter: there's no real robot data yet, so every screen must look right with zero rows and with simulator data.
