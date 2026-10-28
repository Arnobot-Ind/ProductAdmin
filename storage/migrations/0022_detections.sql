-- 0022 · Detections (user request, 2026-10-15): what the robot's cameras detected, with the snapshot image.
--
-- The robot (on-board YOLO / open-vocabulary detectors) logs people, wildlife, fire / smoke and vegetation per camera,
-- and saves a JPEG snapshot of each into the archive S3 bucket (ARCHIVE_S3_BUCKET). This table is the index: one
-- row per detection, pointing at its image by S3 key. The images themselves stay ONLY in the bucket and are
-- streamed through the backend (bucket stays private, permissions + ownership periods apply per image).
--
-- Loaded by `npm run import:detections` (backend) from the GCS database dump (apis_humandetection,
-- apis_environmentevent) and the offline detector runs (Detections/offline/…/events|humans/*.json).
-- status = 'rejected': the reviewer marked it a false positive. Arnobot staff can still see those; customers never.

CREATE TABLE detections (
  id              uuid PRIMARY KEY,                              -- the GCS row id, or the offline event id
  robot_id        text NOT NULL REFERENCES robots(robot_id),
  detected_at     timestamptz NOT NULL,
  time_estimated  boolean NOT NULL DEFAULT false,                -- clock not synced on that run: time is approximate
  kind            text NOT NULL CHECK (kind IN ('human', 'wildlife', 'fire', 'vegetation')),
  label           text,                                          -- 'tiger', 'smoke', 'tree'…; NULL for people
  labels          jsonb,                                         -- {"tree": 2, "bush": 1} when several were seen
  camera          text NOT NULL CHECK (camera ~ '^[a-z0-9_]{1,32}$'),   -- 'cam1'…'cam4'
  count           integer NOT NULL DEFAULT 1 CHECK (count >= 0),  -- people / objects in the frame
  confidence      real CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  boxes           jsonb,                                         -- [{"x1","y1","x2","y2","conf"}] in image pixels
  lat             double precision CHECK (lat IS NULL OR lat BETWEEN -90 AND 90),
  lon             double precision CHECK (lon IS NULL OR lon BETWEEN -180 AND 180),
  bearing_deg     real,
  mission_id      text,                                          -- GCS mission report id (= missions.mission_id when imported)
  mission_name    text,
  image_key       text,                                          -- S3 key in the archive bucket; NULL = no snapshot
  status          text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'rejected')),
  source          text NOT NULL,                                 -- 'gcs-dump:<file>' / 'offline:<run>'
  imported_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX detections_robot_time_idx ON detections (robot_id, detected_at DESC);
CREATE INDEX detections_robot_kind_idx ON detections (robot_id, kind, detected_at DESC);
CREATE TRIGGER detections_no_delete BEFORE DELETE ON detections FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();

-- ── client app feature ──
INSERT INTO client_features (key, area, name, description, kind, always_on, is_default, requires, sort_order) VALUES
  ('portal.detections.view', 'Data', 'Detections', 'People, wildlife and fire / smoke the robot''s cameras detected, with the snapshot images', 'view', false, true, '{}', 450);

-- Switch it on where the reports already are (organizations and their users), so existing clients get it at once;
-- Arnobot staff (organization) and the client's Manager (per user) can take it away again as usual.
INSERT INTO company_features (company_id, feature_key)
  SELECT cf.company_id, 'portal.detections.view' FROM company_features cf
  WHERE cf.feature_key = 'portal.reports.view' AND cf.revoked_at IS NULL;
INSERT INTO user_features (user_id, feature_key)
  SELECT uf.user_id, 'portal.detections.view' FROM user_features uf
  WHERE uf.feature_key = 'portal.reports.view' AND uf.revoked_at IS NULL;
