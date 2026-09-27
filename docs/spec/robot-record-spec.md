# Robot Record — Data Fields (Spec v1)

> Markdown transcription of `Arnobot_PMS_Robot_Record_Spec.docx` (Version 1 · Arnobot PMS ⇄ Robots · 27 September 2026).
> **This is the source of truth.** If anything in `docs/` disagrees with this file, this file wins. Change the design docs, not this one; update this only when the spec document itself changes.

Storage: PostgreSQL (+ TimescaleDB for telemetry) + S3.
Every field in a robot's record, where it comes from and where it is stored, plus the basic rules the PMS and robots follow.

---

## 1. What Version 1 Is

Version 1 is the first working link between the Arnobot PMS and Arnobot's own robots. There are **no customers, Client Admins, Operators or Sites** in the system yet. Arnobot is the only Company and the Arnobot team are the only users.

```
Arnobot PMS
One Company (Arnobot) · Arnobot team logins · one message format for every robot
   ├── Robot 1 (Saibya)
   ├── Robot 2
   ├── Robot 3
   └── Robot N …
```

**The idea behind v1:** build it small but properly, so later features (customers, Operators, Sites, rental) are added as new data, not by rewriting code.

## 2. Core Rules

| # | Rule | Why it matters |
|---|------|----------------|
| 1 | Every robot has one unique, permanent identity | The Robot ID never changes, even when the robot changes owner, software or parts. |
| 2 | Company / ownership must be changeable | Ownership is stored as history (from / to), so rental and pilots later need no redesign. |
| 3 | The robot message format stays stable | Fields are only ever added, never renamed or removed. Old robots keep working after the PMS changes. |
| 4 | Current data ≠ historical data | Live State is overwritten; history is append-only and kept in its own tables. |
| 5 | The robot does not know the business hierarchy | The robot only says who it is. The PMS decides which Company, Site or Operator it belongs to. |

## 3. Data Fields

### Legend: where a field comes from

| Tag | Meaning |
|-----|---------|
| Available | Reported automatically by the robot. |
| Externally Added | Entered by an admin in the PMS (per robot), usually at registration. |
| Platform | Created by the PMS or GCS itself (IDs, computed status). |
| Encrypted | Secrets, encrypted and kept in `robot_credentials`, separate from the main record. |
| History kept | Changes are recorded, never simply overwritten. |

### Field table

Every row in every section is linked to one robot by its Robot ID.

| # | Section | Source | Fields | Stored in |
|---|---------|--------|--------|-----------|
| 1 | Identity | Platform / Added via software. Robot ID assigned by PMS; rest entered at registration | Robot ID (unique, permanent, given by PMS, e.g. `saibya02`) · Serial number (hardware serial on the unit, e.g. `SN123456`; separate field, never used as the Robot ID) · Product (Saibya / Altius / NEXUS / ATM / Duct Cleaning) · Hardware revision (Rev A, Rev B, Rev C) | PostgreSQL |
| 2 | Company / Ownership | Externally Added · History kept · v1: always Arnobot | `company_id` · Assignment history (company, from date, to date) | PostgreSQL |
| 3 | Hardware Fitted | Externally Added · History kept · One entry per part | Part type + model + serial number for each of: GPS module (M9N / RTK), Encoder, IMU, LiDAR, Cameras 1–4, Controller · Fitted date | PostgreSQL |
| 4 | Software | Available · History kept · Reported at boot | Firmware version · Software version · Last update · Update history · Enabled features | PostgreSQL |
| 5 | Connectivity | Externally Added | Network address · SSH IP · Cloudflare Tunnel hostname · Camera stream URLs (×4), without username / password · Camera IP addresses (×4) · OMNI IP address · Wi-Fi router IP address · GCS camera domain (`NEXT_PUBLIC_CAMERA_DOMAIN`) · GCS server domain (`NEXT_PUBLIC_SERVER_DOMAIN`) | PostgreSQL |
| 6 | Device Credentials | Encrypted · Externally Added · **Never in the robots table** | Cloudflare credentials · Camera credentials (×4): camera admin + camera operator accounts · Camera RTSP stream URLs with credentials (×4) · SSH credentials · SSH public key · OMNI credentials · Wi-Fi router credentials · GCS operator login: user + password (`GCS_LOGIN_USER` / `GCS_LOGIN_PASS`), temporary · GCS API token (`GCS_API_TOKEN`, server only) | `robot_credentials` |
| 7 | Documents | Externally Added · Linked from the product; per robot only for one-off builds | Circuit diagram · Pinout details · BOM (Excel) · Manuals · Component list | S3 (+ path in PostgreSQL) |
| 8 | Dispatch & Warranty | Externally Added | Dispatch date · Warranty start date · Warranty end date · Warranty clauses (file) | PostgreSQL + S3 |
| 9 | Maintenance | Externally Added · History kept · One entry per repair | What was repaired · Part removed (serial) · Part fitted (serial) · Repaired by · Date of repair | PostgreSQL |
| 10 | Live State | Available · Current only, overwritten on every update | Last-seen time · Status: Online / Stale / Offline (computed by PMS) · Position + fix quality · Battery status · Signal strength · Temperatures (controller, battery, motors) · Armed / operating mode · Device health (Controller / LiDAR / Cameras / GPS) · Current mission ID | PostgreSQL (one row per robot) |
| 11 | Sensor Data | Available · History kept · Append only | GPS position track · Encoders · Battery history · Health history (device health + temperatures) | TimescaleDB |
| 12 | Mission Report | Available · Platform · History kept · Created by GCS; PMS stores it, viewed in admin panel; append only | Mission ID · Start / end time · Duration · Planned path · Actual path driven · Distance · Result · End reason | PostgreSQL + S3 |
| 13 | Event Log | Available · History kept · Append only | Time (UTC) · Type: Abort / RTH / Alert / Fault / Update · Severity: Info / Warning / Critical · Message · Acknowledged by + time | PostgreSQL |

## 4. Product Catalogue

Products are defined once. Every robot points to one product. Documents that are the same for every robot of a product are stored once on the product, not copied into each robot.

```
Product            Saibya / Altius / NEXUS / ATM / Duct Cleaning
└── Hardware revision
     ├── Main components   controller, GPS, LiDAR, cameras …
     └── Documents         circuit diagram, pinout, BOM, manuals, component list
          └── Robot        saibya01, saibya02 …
```

| Field | Meaning |
|-------|---------|
| Product | Saibya, Altius, NEXUS, ATM, Duct Cleaning. New products are added as rows, no code change. |
| Hardware revision | A name for one set of main components (e.g. "Saibya rev A: controller X + M9N GPS + LiDAR Y"). A new revision is created when a main component changes. **Optional in v1:** the field exists but can be left empty. |
| Documents | Attached to the hardware revision (or to the product if there is no revision yet). A robot can also have its own documents for one-off builds. |

**Robot ID vs serial number: keep them separate.** The Robot ID (e.g. `saibya02`) is the name the PMS gives the robot: product name + running number. It is used in every message, report and screen. The serial number is the hardware serial printed on the unit (e.g. `SN123456`). They are two different fields, both unique, and one is never used in place of the other.

## 5. Mission Report Structure

Every mission belongs to one Robot ID. One robot has many missions, and each mission has its own data: times, distance, result, both paths and its files. Large files are stored in S3; the mission stores only their file paths.

```
Robot  saibya02                         (Robot ID)
└── Missions                            many per robot
     ├── Mission saibya02-M0001
     │    ├── Start / end time, duration, distance
     │    ├── Result + end reason
     │    ├── Planned path             from GCS
     │    ├── Actual path              from robot
     │    └── Files in S3              video, MCAP, images (paths only)
     ├── Mission saibya02-M0002
     │    └── …
     └── Mission saibya02-M000N
```

**How it is stored**
- `missions`: one row per mission, linked by `robot_id`. Mission ID is unique (e.g. `saibya02-M0001`).
- `mission_files`: one row per file (video, MCAP, image), linked by `mission_id`; holds the S3 path.
- Robot totals (missions, distance, duration) are **calculated** from the missions rows, not stored separately.

**How it is shown in the admin panel**

| Admin panel view | Shows |
|------------------|-------|
| 1. Robot summary (one row per robot) | Robot ID · Total missions · Completed / failed / aborted missions · Total distance · Total mission duration · Average mission duration |
| 2. Missions of this robot (list, open a robot) | Mission ID · Start time · End time · Duration · Distance · Result · End reason |
| 3. Mission details (open one mission) | Planned path (from GCS) · Actual path (from robot) · Map view showing planned and actual paths · Files in S3: video, MCAP, images |

The GCS creates and runs the mission. After the mission is finished, the GCS sends the completed mission report to the PMS.

## 6. Robot Message Format

Every robot message uses one envelope; only the payload changes by type. Kept simple; fields are added only when needed.

```jsonc
{
  "v": 1,                                              // format version
  "msg_id": "6f1c2a9e-4b7d-4e0a-9c1f-2d8e5a7b3c10",   // unique, made on the robot
  "robot_id": "saibya01",
  "product": "saibya",
  "sw_ver": "1.4.0",
  "fw_ver": "0.9.2",
  "ts": "2026-09-26T10:30:00.000Z",                   // UTC, time of capture
  "type": "live",                                      // hello | live | telemetry | event | mission
  "payload": { ... }
}
```

| type | Sent when | Payload contains |
|------|-----------|------------------|
| hello | At boot and after every reconnect | Software / firmware versions, IP addresses |
| live | Regularly | Position + fix, battery, signal, temperatures, mode, device health, current mission |
| telemetry | In batches | GPS track points, encoder readings, battery and health samples |
| event | Immediately | Type, severity, message |
| mission | At mission start and end | Mission ID, times, actual path, result, end reason, S3 file paths |

- `msg_id` is unique: the PMS stores each message once.
- `ts` is the capture time, in UTC.
- Units: metres, m/s, degrees, °C, %, volts, dBm.
- Transport (MQTT or HTTPS): chosen during the build.

## 7. Reporting Frequency & Health Status

| Data | How often | Value |
|------|-----------|-------|
| hello | At boot / reconnect | — |
| live | Every 30 s | 30 s (same while operating or idle) |
| telemetry | Every 30 s | 30 s (one batch per interval) |
| event | Immediately | — |
| mission | Start and end | — |

**Robot status (computed by the PMS from last-seen time)**

| Status | Rule | Meaning |
|--------|------|---------|
| Online | last seen < 60 s | Robot is connected and reporting. |
| Stale | 60 s – 5 min | Connection is weak or dropping. |
| Offline | more than 5 min | No contact. |

Device health, per device (Controller / LiDAR / Cameras / GPS): **OK / Warning / Fault**, reported by the robot in every live message.

Why 30 s: enough for the admin panel and robot status, and keeps storage small. Online allows one missed message before a robot turns Stale. A faster rate while operating is not needed now; it can be added later without changing the storage schema.

## 8. Storage

Structured data and files are kept apart. Files are never stored in the database; PostgreSQL holds the S3 path and metadata for each file.

| PostgreSQL (structured data) | TimescaleDB (time series) | S3 (files) | robot_credentials (secrets) |
|---|---|---|---|
| Robots, products, hardware · Live state · Mission reports · Events · Users, roles, grants · S3 path + metadata for every file | Sensor data: GPS track, encoders, battery history, health history (PostgreSQL extension, same database) | Videos · LiDAR files · MCAP recordings · Images · PDFs, circuit diagrams, manuals, BOM · Update packages | Device credentials (encrypted) |

**Retention: keep everything.** All data is kept until the Arnobot team instructs otherwise. Nothing is deleted automatically: no expiry on telemetry, mission reports, events, files or history. A deletion happens only on an explicit instruction.

**Versioning: keep what is needed**
- S3 files: bucket versioning is on. Replacing or deleting a file keeps the old version.
- Documents (circuit diagram, pinout, BOM, manuals, component list): each upload is a new version with version number, uploaded by and date. The latest is shown; older versions stay available.
- Records: never hard-deleted. A removed row is marked deleted (`deleted_at`) and can be restored.
- Changes: hardware, software, ownership and maintenance keep history rows.
- Schema and message format: database changes are numbered migrations; robot messages carry `v`.
- Releases: every software / firmware version is kept (Section 9).

## 9. Software & Firmware Updates

Software (navigation, cameras, maps) and firmware (motors, battery, sensors) have separate versions and separate updates. One release record is kept per version.

| Field | Meaning |
|-------|---------|
| Product | Which product it is for (e.g. Saibya). |
| Component | Software or firmware. |
| Version | e.g. 1.4.0 |
| File | Update package in S3. |
| Checksum + signature | SHA-256 checksum and Arnobot signature. The robot refuses a package that fails either check. |
| Requires | Minimum version of the other component (e.g. software 1.4.0 needs firmware ≥ 0.9.0). |

## 10. Credentials & Robot Authentication

- Each robot has its own credentials.
- Credentials are stored separately and encrypted.
- Encryption keys are kept outside the database.
- Lost or stolen robot credentials can be revoked.
- Only authorized users can view or change credentials.
- Camera passwords are encrypted and not shown in normal URLs.

**GCS API token**
- Keep the GCS API token on the server.
- Do **not** use `NEXT_PUBLIC_GCS_API_TOKEN`. Use `GCS_API_TOKEN` instead.
- The browser should never see the token.

**Credential rotation.** Change credentials when an employee with access leaves, or a robot returns from outside Arnobot. Regular rotation period: **never**.

## 11. Offline Behaviour

Connectivity will not always be available on site, so the robot must never lose data when it goes offline.

```
Robot offline → store data locally → internet comes back
  → send live state first → upload old data (oldest first)
  → PMS stores each message once
```

- Every stored message keeps its original `ts` (capture time) and `msg_id`, so late data lands in the right place and is never duplicated.
- After reconnecting, the robot sends current live state first so the console is correct at once; the backlog follows.
- Local storage limit: 75 GB. When full, the oldest sensor data is dropped first; events and mission reports are never dropped.
- The PMS shows the robot as Offline while it is away and as Online again when it reconnects.

## 12. Permissions

Permissions are kept out of the API code. Every request goes through one check: `can(user, action, target)`.

```
User → Role → Permission → Scope
Scope = where the role applies: Platform, Company, Site or Robot.
```
