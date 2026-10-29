-- 0025 · Robot categories (UGV / UAV), product photos and 3D models, full SSH connection details,
-- and the source of a release (GitHub link + commit).

-- ── Category: every product is a ground robot (UGV) or an aerial one (UAV) ──
ALTER TABLE products ADD COLUMN category text NOT NULL DEFAULT 'ugv' CHECK (category IN ('ugv', 'uav'));
UPDATE products SET category = 'uav' WHERE code IN ('drone', 'altius');
-- The product's software repository (its robots' current version comes from the robot itself).
ALTER TABLE products ADD COLUMN repo_url text CHECK (repo_url IS NULL OR repo_url ~* '^https?://');

-- ── Photos and 3D views of a product (files live in storage, rule 9) ──
--   photo     : a picture shown on the robot page;
--   model_3d  : one 3D model (.glb) the viewer can turn;
--   spin      : a series of photos taken all around the robot, shown in order as a 360° view.
CREATE TABLE product_media (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  uuid NOT NULL REFERENCES products(id),
  kind        text NOT NULL CHECK (kind IN ('photo', 'model_3d', 'spin')),
  file_id     uuid NOT NULL REFERENCES files(id),
  position    integer NOT NULL DEFAULT 0,   -- order of the photos in a 360° series
  caption     text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES users(id),
  deleted_at  timestamptz
);
CREATE INDEX product_media_product_idx ON product_media (product_id, kind, position, created_at) WHERE deleted_at IS NULL;
CREATE TRIGGER product_media_no_delete BEFORE DELETE ON product_media FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();

-- ── SSH: where and how to connect (not secret; the password or private key stays encrypted) ──
ALTER TABLE robot_credentials
  ADD COLUMN host        text,
  ADD COLUMN port        integer CHECK (port IS NULL OR port BETWEEN 1 AND 65535),
  ADD COLUMN auth_method text CHECK (auth_method IS NULL OR auth_method IN ('password', 'private_key')),
  ADD COLUMN proxy       text;   -- e.g. a Cloudflare tunnel hostname or ProxyJump host

-- ── Where a release was built from ──
ALTER TABLE releases
  ADD COLUMN repo_url  text CHECK (repo_url IS NULL OR repo_url ~* '^https?://'),
  ADD COLUMN commit_id text CHECK (commit_id IS NULL OR commit_id ~* '^[0-9a-f]{7,64}$');
ALTER TABLE software_products
  ADD COLUMN repo_url  text CHECK (repo_url IS NULL OR repo_url ~* '^https?://'),
  ADD COLUMN commit_id text CHECK (commit_id IS NULL OR commit_id ~* '^[0-9a-f]{7,64}$');


-- ── Scale to a large fleet (1000+ robots) ──
-- Distance, moving time and online time per robot and IST day, kept up to date by the backend every few minutes,
-- so fleet-wide reports read one small table instead of every robot's telemetry.
CREATE TABLE robot_daily_stats (
  robot_id        text NOT NULL REFERENCES robots(robot_id),
  day             date NOT NULL,
  odometer_m      double precision,          -- odometer increase that day; NULL when no odometer was reported
  wheel_m         double precision NOT NULL DEFAULT 0,
  moving_s        double precision NOT NULL DEFAULT 0,
  online_s        integer NOT NULL DEFAULT 0,
  first_seen_at   timestamptz,
  last_seen_at    timestamptz,
  odometer_end_m  double precision,
  computed_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (robot_id, day)
);
CREATE INDEX robot_daily_stats_day_idx ON robot_daily_stats (day);
-- Active faults: the latest event per robot and code.
CREATE INDEX events_robot_code_ts_idx ON events (robot_id, code, ts DESC) WHERE code IS NOT NULL;
-- Unacknowledged critical events across the fleet (dashboard, needs attention).
CREATE INDEX events_unacked_critical_idx ON events (ts DESC) WHERE acknowledged_at IS NULL AND severity = 'critical';

-- ── Robot journal: dated notes people add to a robot (site visits, decisions, anything worth remembering) ──
CREATE TABLE robot_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  robot_id    text NOT NULL REFERENCES robots(robot_id),
  body        text NOT NULL CHECK (length(trim(body)) > 0),
  pinned      boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES users(id),
  deleted_at  timestamptz,
  deleted_by  uuid REFERENCES users(id)
);
CREATE INDEX robot_notes_robot_idx ON robot_notes (robot_id, created_at DESC) WHERE deleted_at IS NULL;
-- Notes are never edited (a correction is a new note); only pinning and removal change.
CREATE TRIGGER robot_notes_append_only BEFORE UPDATE ON robot_notes FOR EACH ROW EXECUTE FUNCTION pms_allow_update_only('pinned', 'deleted_at', 'deleted_by');
CREATE TRIGGER robot_notes_no_delete BEFORE DELETE ON robot_notes FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();

-- ── Who a robot is at a glance: a nickname and a short description, shown wherever the robot appears ──
ALTER TABLE robots
  ADD COLUMN nickname    text CHECK (nickname IS NULL OR length(trim(nickname)) BETWEEN 1 AND 60),
  ADD COLUMN description text CHECK (description IS NULL OR length(description) <= 500);

-- ── Attachments: equipment fitted on a vehicle (sprayer, thermal camera, arm …). A catalogue, and per robot a
-- history of what was fitted when (removal closes the row; nothing is deleted). ──
CREATE TABLE attachments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(trim(name)) > 0),
  category    text CHECK (category IS NULL OR category IN ('ugv', 'uav')),   -- NULL = fits both
  description text,
  manufacturer text,                       -- who makes it (in-house or a supplier)
  model_number text,                       -- the maker's model / part number
  repo_url    text CHECK (repo_url IS NULL OR repo_url ~* '^https?://'),     -- its software, if it has any
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE UNIQUE INDEX attachments_name_uq ON attachments (lower(name)) WHERE deleted_at IS NULL;
CREATE TRIGGER attachments_touch BEFORE UPDATE ON attachments FOR EACH ROW EXECUTE FUNCTION pms_touch_updated_at();
CREATE TRIGGER attachments_no_delete BEFORE DELETE ON attachments FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();

CREATE TABLE robot_attachments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  robot_id       text NOT NULL REFERENCES robots(robot_id),
  attachment_id  uuid NOT NULL REFERENCES attachments(id),
  fitted_at      timestamptz NOT NULL DEFAULT now(),
  fitted_by      uuid REFERENCES users(id),
  hardware_revision_id uuid REFERENCES hardware_revisions(id),   -- which revision of the attachment was fitted
  serial_number  text CHECK (serial_number IS NULL OR length(trim(serial_number)) BETWEEN 1 AND 100),  -- of this unit
  notes          text,
  removed_at     timestamptz,
  removed_by     uuid REFERENCES users(id),
  removal_note   text,
  CHECK (removed_at IS NULL OR removed_at >= fitted_at)
);
CREATE UNIQUE INDEX robot_attachments_active_uq ON robot_attachments (robot_id, attachment_id) WHERE removed_at IS NULL;
CREATE INDEX robot_attachments_robot_idx ON robot_attachments (robot_id, fitted_at DESC);
CREATE TRIGGER robot_attachments_close_only BEFORE UPDATE ON robot_attachments
  FOR EACH ROW EXECUTE FUNCTION pms_allow_update_only('removed_at', 'removed_by', 'removal_note');
CREATE TRIGGER robot_attachments_no_delete BEFORE DELETE ON robot_attachments FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();

-- ── An attachment keeps the same records as a base model: photos / 3D / 360° views, hardware revisions with
-- their main components, and versioned documents (manuals, circuit diagrams, BOM …). Each of these rows now
-- belongs to exactly one base model or one attachment. A robot's documents include those of the attachments
-- fitted on it (and of the fitted revision). ──
ALTER TABLE product_media
  ALTER COLUMN product_id DROP NOT NULL,
  ADD COLUMN attachment_id uuid REFERENCES attachments(id),
  ADD CONSTRAINT product_media_owner_check CHECK (num_nonnulls(product_id, attachment_id) = 1);
CREATE INDEX product_media_attachment_idx ON product_media (attachment_id, kind, position, created_at) WHERE deleted_at IS NULL AND attachment_id IS NOT NULL;

ALTER TABLE hardware_revisions
  ALTER COLUMN product_id DROP NOT NULL,
  ADD COLUMN attachment_id uuid REFERENCES attachments(id),
  ADD CONSTRAINT hardware_revisions_owner_check CHECK (num_nonnulls(product_id, attachment_id) = 1);
CREATE UNIQUE INDEX hardware_revisions_attachment_name_uq ON hardware_revisions (attachment_id, lower(name)) WHERE deleted_at IS NULL AND attachment_id IS NOT NULL;

ALTER TABLE documents ADD COLUMN attachment_id uuid REFERENCES attachments(id);
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'documents'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%num_nonnulls%' LOOP
    EXECUTE format('ALTER TABLE documents DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE documents ADD CONSTRAINT documents_owner_check CHECK (num_nonnulls(product_id, hardware_revision_id, robot_id, attachment_id) = 1);
CREATE INDEX documents_attachment_idx ON documents (attachment_id) WHERE attachment_id IS NOT NULL;
DROP TRIGGER IF EXISTS documents_owner_permanent ON documents;
CREATE TRIGGER documents_owner_permanent BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION pms_immutable_columns('product_id', 'hardware_revision_id', 'robot_id', 'attachment_id');
