# Robot Simulator (`tools/robot-sim`)

**The physical robots are not online yet.** All development and demos run against this simulator. It imports `packages/message-schema` and validates every message it produces, so it cannot drift from the contract.

## Usage

```bash
npm run db:seed                 # creates demo robots saibya01, saibya02, altius01 + .sim-keys.json (gitignored)
npm run sim -- --scenario mixed --speed 10
npm run sim -- --robots saibya02 --scenario offline-backlog --speed 10 --offline-intervals 12
npm run sim -- --help
```

| Option | Default | Meaning |
|---|---|---|
| `--robots` | `all` | comma list of Robot IDs from `.sim-keys.json` |
| `--scenario` | `normal` | see below; `mixed` gives each robot a different one |
| `--speed` | `1` | time compression: live + telemetry every `30 s / speed` |
| `--duration` | `0` (forever) | seconds, then stop |
| `--once` | | one cycle, then exit |
| `--seed` | time | deterministic randomness |
| `--ingest` | from keys file | ingest base URL (default `http://localhost:4100`) |
| `--offline-intervals` | `12` | how long `offline-backlog` stays offline |

## Behaviour (same rules the real robot/GCS must follow)

- Boot → `hello`. Every interval: 10 physics steps (movement, battery drain/charge, temperatures, encoder ticks) → one `telemetry` batch (each sample with its own `ts`) + one `live`.
- Missions: `mission` start (id `{robot}-M{NNNN}`, counter kept in `.sim-state.json`), drives the planned waypoints, then `mission` end with `actual_path`, distance, result, end reason and S3 file refs. It then plays the **GCS** and POSTs the mission report with the `planned_path`, using the GCS key.
- **Outbox:** everything is queued locally first. A message is removed only on `stored` / `duplicate`, dropped (and logged) on a non-retryable rejection, and kept on a network error.
- **Reconnect:** the *current* live state first, then the backlog oldest-first (spec §11).

## Scenarios → the spec rule they exercise

| Scenario | What it does | Watch in the admin panel |
|---|---|---|
| `normal` | steady reporting, periodic missions | Online status, live tab, telemetry charts, missions |
| `flaky` | the link drops randomly for 1–4 intervals | Online → Stale → Online; nothing lost |
| `offline-backlog` | offline for N intervals while buffering, then reconnects | Offline after 5 min; live correct at once on reconnect; charts back-filled at the right times; live never rewound (rule 7) |
| `duplicate` | re-sends already-stored messages | `duplicate` results, no double rows (rule 6) |
| `fault` | LiDAR `fault` + critical event, camera warning, later recovery | Health chips, dashboard fault list, event log, acknowledge |
| `version-bump` | "reboots" with software 1.5.0 → `hello` + update event | Software tab: new history row + last update |
| `mission` | frequent missions, half aborted mid-route | Mission counts (completed / aborted), end reasons, map |
| `mixed` | a different scenario per robot | Everything at once |

## GCS relay testing

`docs/gcs/reference/pms_relay.py --fake` is a second, independent sender (Python, GCS-style) for testing the same endpoints.
