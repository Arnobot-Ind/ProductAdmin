-- 0007 · Live state (spec §3 row 10), events (row 13), missions (row 12, §5), ingest bookkeeping (§6, §11).

-- ── Live state: ONE row per robot, overwritten (rule 4) ─────────────────────
-- Rule 7: fields below state_ts are only replaced when an incoming live message has a NEWER ts.
-- last_seen_at is the RECEIVE time of the latest message of any type; status is computed from it (rule 8).
CREATE TABLE live_state (
  robot_id            text PRIMARY KEY REFERENCES robots(robot_id),
  last_seen_at        timestamptz,
  last_msg_ts         timestamptz,            -- capture ts of the newest message of any type
  state_ts            timestamptz,            -- capture ts of the live message currently shown
  lat                 double precision CHECK (lat IS NULL OR lat BETWEEN -90 AND 90),
  lon                 double precision CHECK (lon IS NULL OR lon BETWEEN -180 AND 180),
  alt_m               real,
  fix_quality         text,
  hdop                real,
  sats                integer,
  heading_deg         real,
  speed_mps           real,
  battery_pct         real CHECK (battery_pct IS NULL OR battery_pct BETWEEN 0 AND 100),
  battery_v           real,
  charging            boolean,
  signal_dbm          real,
  temp_controller_c   real,
  temp_battery_c      real,
  temp_motors_c       jsonb,
  armed               boolean,
  mode                text,
  health_controller   text CHECK (health_controller IN ('ok', 'warning', 'fault')),
  health_lidar        text CHECK (health_lidar      IN ('ok', 'warning', 'fault')),
  health_cameras      text CHECK (health_cameras    IN ('ok', 'warning', 'fault')),
  health_gps          text CHECK (health_gps        IN ('ok', 'warning', 'fault')),
  current_mission_id  text,
  sw_ver              text,                   -- from the envelope of the newest message
  fw_ver              text,
  source_msg_id       uuid,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX live_state_last_seen_idx ON live_state (last_seen_at DESC);
CREATE TRIGGER live_state_no_delete BEFORE DELETE ON live_state FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();

-- ── Every accepted message, stored exactly once (rule 6) ───────────────────
CREATE TABLE ingested_messages (
  msg_id       uuid PRIMARY KEY,
  robot_id     text NOT NULL REFERENCES robots(robot_id),
  type         text NOT NULL,
  v            integer NOT NULL,
  ts           timestamptz NOT NULL,          -- capture time; history is keyed on this
  received_at  timestamptz NOT NULL DEFAULT now(),
  client_id    uuid REFERENCES ingest_clients(id),
  transport    text NOT NULL DEFAULT 'https' CHECK (transport IN ('https', 'mqtt')),
  raw          jsonb NOT NULL                 -- full envelope as received, incl. unknown fields
);
CREATE INDEX ingested_messages_robot_ts_idx ON ingested_messages (robot_id, ts DESC);
CREATE INDEX ingested_messages_received_idx ON ingested_messages (received_at DESC);
CREATE TRIGGER ingested_messages_no_update BEFORE UPDATE ON ingested_messages FOR EACH ROW EXECUTE FUNCTION pms_forbid_update();
CREATE TRIGGER ingested_messages_no_delete BEFORE DELETE ON ingested_messages FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();

-- Rejected input is kept too (retention = keep everything) so problems can be diagnosed.
CREATE TABLE ingest_rejections (
  id           bigserial PRIMARY KEY,
  received_at  timestamptz NOT NULL DEFAULT now(),
  client_id    uuid REFERENCES ingest_clients(id),
  msg_id       text,
  robot_id     text,
  type         text,
  error        text NOT NULL,
  details      jsonb,
  raw          jsonb
);
CREATE INDEX ingest_rejections_received_idx ON ingest_rejections (received_at DESC);
CREATE TRIGGER ingest_rejections_no_update BEFORE UPDATE ON ingest_rejections FOR EACH ROW EXECUTE FUNCTION pms_forbid_update();
CREATE TRIGGER ingest_rejections_no_delete BEFORE DELETE ON ingest_rejections FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();

-- ── Events: append only; acknowledgement is the only permitted change ──────
CREATE TABLE events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  msg_id           uuid UNIQUE,
  robot_id         text NOT NULL REFERENCES robots(robot_id),
  ts               timestamptz NOT NULL,       -- capture time (UTC)
  type             text NOT NULL CHECK (type IN ('abort', 'rth', 'alert', 'fault', 'update')),
  severity         text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  code             text,
  message          text NOT NULL,
  data             jsonb,
  acknowledged_by  uuid REFERENCES users(id),
  acknowledged_at  timestamptz,
  received_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((acknowledged_by IS NULL) = (acknowledged_at IS NULL))
);
CREATE INDEX events_robot_ts_idx ON events (robot_id, ts DESC);
CREATE INDEX events_ts_idx ON events (ts DESC);
CREATE INDEX events_unacked_idx ON events (ts DESC) WHERE acknowledged_at IS NULL;
CREATE TRIGGER events_ack_only BEFORE UPDATE ON events
  FOR EACH ROW EXECUTE FUNCTION pms_allow_update_only('acknowledged_by', 'acknowledged_at');
CREATE TRIGGER events_no_delete BEFORE DELETE ON events FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();

-- ── Missions: created by the GCS, reported by robot and GCS; never deleted ──
-- A row is created by whichever arrives first (robot start/end or GCS report); later messages fill gaps.
-- Robot totals are CALCULATED from these rows (v_robot_mission_summary), never stored (spec §5).
CREATE TABLE missions (
  mission_id              text PRIMARY KEY CHECK (length(mission_id) BETWEEN 1 AND 200),  -- 'saibya02-M0001'
  robot_id                text NOT NULL REFERENCES robots(robot_id),
  external_id             text,               -- GCS's own mission id (a UUID today), for traceability
  name                    text,
  started_at              timestamptz,
  ended_at                timestamptz,
  duration_s              integer GENERATED ALWAYS AS
                            (CASE WHEN started_at IS NOT NULL AND ended_at IS NOT NULL
                                  THEN greatest(0, extract(epoch FROM ended_at - started_at))::integer END) STORED,
  distance_m              real CHECK (distance_m IS NULL OR distance_m >= 0),
  distance_planned_m      real CHECK (distance_planned_m IS NULL OR distance_planned_m >= 0),
  result                  text NOT NULL DEFAULT 'in_progress' CHECK (result IN ('completed', 'failed', 'aborted', 'in_progress')),
  end_reason              text,
  planned_path            jsonb,              -- GeoJSON LineString, from GCS (authoritative for the plan)
  actual_path             jsonb,              -- GeoJSON LineString, from robot (authoritative for the drive)
  waypoints_total         integer,
  waypoints_reached       integer,
  gcs_report              jsonb,              -- latest raw GCS report, kept as-is
  gcs_report_received_at  timestamptz,
  start_msg_id            uuid,
  end_msg_id              uuid,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CHECK (planned_path IS NULL OR planned_path ->> 'type' = 'LineString'),
  CHECK (actual_path  IS NULL OR actual_path  ->> 'type' = 'LineString')
);
CREATE INDEX missions_robot_started_idx ON missions (robot_id, started_at DESC NULLS LAST);
CREATE INDEX missions_started_idx ON missions (started_at DESC NULLS LAST);
CREATE INDEX missions_external_idx ON missions (external_id) WHERE external_id IS NOT NULL;
CREATE TRIGGER missions_touch BEFORE UPDATE ON missions FOR EACH ROW EXECUTE FUNCTION pms_touch_updated_at();
CREATE TRIGGER missions_identity_permanent BEFORE UPDATE ON missions
  FOR EACH ROW EXECUTE FUNCTION pms_immutable_columns('mission_id', 'robot_id');
CREATE TRIGGER missions_no_delete BEFORE DELETE ON missions FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();

-- One row per file (video, MCAP, image …). Large files live in S3; only the path is here.
CREATE TABLE mission_files (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id    text NOT NULL REFERENCES missions(mission_id),
  kind          text NOT NULL CHECK (kind IN ('video', 'mcap', 'image', 'lidar', 'other')),
  s3_path       text NOT NULL,
  file_id       uuid REFERENCES files(id),  -- set when the object is in PMS-managed storage
  size_bytes    bigint,
  sha256        text,
  content_type  text,
  source        text NOT NULL CHECK (source IN ('robot', 'gcs', 'admin')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mission_id, s3_path)
);
CREATE TRIGGER mission_files_no_update BEFORE UPDATE ON mission_files FOR EACH ROW EXECUTE FUNCTION pms_forbid_update();
CREATE TRIGGER mission_files_no_delete BEFORE DELETE ON mission_files FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();
