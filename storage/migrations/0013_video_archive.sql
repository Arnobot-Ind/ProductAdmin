-- 0013 · Video / sensor archive (merged from Saibya Archive).
-- The recordings themselves (camera .ts segments, LiDAR .npz, IMU .csv.gz, session.json) live in the
-- archive object store (S3 bucket or local disk, spec §8: files never in the DB). These tables are the
-- INDEX of that store: every row can be rebuilt from it with POST /api/v1/archive/reindex.
-- Only robots registered in the PMS have an archive: robot_id is a foreign key to robots.
--
-- Object layout (written by cloud_sync on the robot):
--   <robot_id>/sessions/<session_id>/…       real sessions
--   <robot_id>/sim/sessions/<session_id>/…   bench simulations (sim = true)

-- A named mission / day the operator files sessions under (typed at Start).
CREATE TABLE archive_trips (
  id          bigserial PRIMARY KEY,
  name        text NOT NULL UNIQUE CHECK (length(trim(name)) > 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER archive_trips_no_delete BEFORE DELETE ON archive_trips FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();

-- One recording session (operator Start → Stop).
CREATE TABLE archive_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  robot_id     text NOT NULL REFERENCES robots(robot_id),
  sim          boolean NOT NULL DEFAULT false,          -- stored under <robot>/sim/sessions/
  session_id   text NOT NULL CHECK (session_id ~ '^[A-Za-z0-9._-]{1,200}$'),
  trip_id      bigint REFERENCES archive_trips(id),
  manifest     jsonb,                                   -- session.json as last uploaded
  status       text,                                    -- copied out of the manifest for filtering
  started_at   timestamptz,
  ended_at     timestamptz,
  stop_reason  text,
  simulated    boolean NOT NULL DEFAULT false,          -- manifest says the data is synthetic
  complete     boolean NOT NULL DEFAULT false,          -- _COMPLETE.json indexed: every file is stored
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT archive_sessions_uq UNIQUE (robot_id, sim, session_id)
);
CREATE INDEX archive_sessions_started_idx ON archive_sessions (robot_id, started_at DESC NULLS LAST);
CREATE INDEX archive_sessions_trip_idx ON archive_sessions (trip_id) WHERE trip_id IS NOT NULL;
CREATE TRIGGER archive_sessions_touch BEFORE UPDATE ON archive_sessions FOR EACH ROW EXECUTE FUNCTION pms_touch_updated_at();
CREATE TRIGGER archive_sessions_identity BEFORE UPDATE ON archive_sessions
  FOR EACH ROW EXECUTE FUNCTION pms_immutable_columns('robot_id', 'sim', 'session_id');
CREATE TRIGGER archive_sessions_no_delete BEFORE DELETE ON archive_sessions FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();

-- One stored object of a session (video segment, sensor chunk, session.json, upload log).
CREATE TABLE archive_files (
  object_key   text PRIMARY KEY,                        -- key in the archive store
  session_ref  uuid NOT NULL REFERENCES archive_sessions(id),
  name         text NOT NULL,                           -- path inside the session: video/cam1/20260924_134701.ts
  kind         text NOT NULL CHECK (kind IN ('camera', 'sensors', 'meta')),
  camera       text,
  sensor       text CHECK (sensor IS NULL OR sensor IN ('lidar', 'imu')),
  chunk_start  timestamptz,                             -- parsed from the file name; NULL for meta files
  size_bytes   bigint NOT NULL CHECK (size_bytes >= 0),
  sha256       text CHECK (sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$'),
  uploaded_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'camera') = (camera IS NOT NULL)),
  CHECK ((kind = 'sensors') = (sensor IS NOT NULL))
);
CREATE INDEX archive_files_session_idx ON archive_files (session_ref, kind, camera, chunk_start);
CREATE INDEX archive_files_uploaded_idx ON archive_files (uploaded_at DESC);
CREATE TRIGGER archive_files_no_delete BEFORE DELETE ON archive_files FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();

-- The robot's upload link: cloud_sync heartbeat (about once a minute) and the last upload.
CREATE TABLE archive_robot_link (
  robot_id        text PRIMARY KEY REFERENCES robots(robot_id),
  last_seen_at    timestamptz,                          -- last heartbeat
  last_status     jsonb,                                -- heartbeat body: current session, backlog, disk, alerts
  last_upload_at  timestamptz,                          -- last file stored or reported
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER archive_robot_link_touch BEFORE UPDATE ON archive_robot_link FOR EACH ROW EXECUTE FUNCTION pms_touch_updated_at();
CREATE TRIGGER archive_robot_link_no_delete BEFORE DELETE ON archive_robot_link FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();
