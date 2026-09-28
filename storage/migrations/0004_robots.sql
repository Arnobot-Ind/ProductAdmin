-- 0004 · Robot record: identity, ownership, hardware, software, connectivity, dispatch, maintenance
-- (spec §3 rows 1–5, 8, 9).

-- ── Identity (row 1). robot_id is permanent, unique, never reused (rule 1) ──
CREATE TABLE robots (
  robot_id              text PRIMARY KEY CHECK (robot_id ~ '^[a-z][a-z0-9_]*[0-9]+$'),  -- 'saibya02'
  serial_number         text NOT NULL CHECK (length(trim(serial_number)) > 0),        -- 'SN123456'; never the ID
  product_id            uuid NOT NULL REFERENCES products(id),
  hardware_revision_id  uuid REFERENCES hardware_revisions(id),                      -- optional in v1
  running_number        integer NOT NULL CHECK (running_number > 0),
  notes                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid REFERENCES users(id),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz,
  CONSTRAINT robots_product_running_uq UNIQUE (product_id, running_number),
  CONSTRAINT robots_id_not_serial CHECK (lower(robot_id) <> lower(serial_number))
);
-- Serial numbers are unique across ALL robots, including soft-deleted ones.
CREATE UNIQUE INDEX robots_serial_uq ON robots (upper(serial_number));
CREATE INDEX robots_product_idx ON robots (product_id) WHERE deleted_at IS NULL;

CREATE TRIGGER robots_touch BEFORE UPDATE ON robots FOR EACH ROW EXECUTE FUNCTION pms_touch_updated_at();
CREATE TRIGGER robots_identity_permanent BEFORE UPDATE ON robots
  FOR EACH ROW EXECUTE FUNCTION pms_immutable_columns('robot_id', 'product_id', 'running_number');
CREATE TRIGGER robots_no_delete BEFORE DELETE ON robots FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();

-- ── Ownership (row 2). History with from/to, never a mutable company_id (rule 2) ──
CREATE TABLE company_assignment_history (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  robot_id    text NOT NULL REFERENCES robots(robot_id),
  company_id  uuid NOT NULL REFERENCES companies(id),
  valid_from  timestamptz NOT NULL,
  valid_to    timestamptz,                    -- NULL = current owner
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES users(id),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  -- no two ownership periods of one robot may overlap
  EXCLUDE USING gist (robot_id WITH =, tstzrange(valid_from, coalesce(valid_to, 'infinity')) WITH &&)
);
CREATE UNIQUE INDEX cah_one_current_uq ON company_assignment_history (robot_id) WHERE valid_to IS NULL;
CREATE INDEX cah_company_current_idx ON company_assignment_history (company_id) WHERE valid_to IS NULL;
CREATE TRIGGER cah_close_only BEFORE UPDATE ON company_assignment_history
  FOR EACH ROW EXECUTE FUNCTION pms_allow_update_only('valid_to');
CREATE TRIGGER cah_no_delete BEFORE DELETE ON company_assignment_history FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();

-- Future: robot ↔ site placement, same history pattern. Empty in v1.
CREATE TABLE site_assignment_history (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  robot_id    text NOT NULL REFERENCES robots(robot_id),
  site_id     uuid NOT NULL REFERENCES sites(id),
  valid_from  timestamptz NOT NULL,
  valid_to    timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES users(id),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  EXCLUDE USING gist (robot_id WITH =, tstzrange(valid_from, coalesce(valid_to, 'infinity')) WITH &&)
);
CREATE TRIGGER sah_close_only BEFORE UPDATE ON site_assignment_history
  FOR EACH ROW EXECUTE FUNCTION pms_allow_update_only('valid_to');
CREATE TRIGGER sah_no_delete BEFORE DELETE ON site_assignment_history FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();

-- ── Maintenance (row 9). One entry per repair ───────────────────────────────
CREATE TABLE maintenance_log (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  robot_id             text NOT NULL REFERENCES robots(robot_id),
  repaired_at          date NOT NULL,
  description          text NOT NULL,          -- what was repaired
  part_removed_serial  text,
  part_fitted_serial   text,
  repaired_by          text NOT NULL,          -- free text: may be an external technician
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid REFERENCES users(id),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz
);
CREATE INDEX maintenance_robot_idx ON maintenance_log (robot_id, repaired_at DESC);
CREATE TRIGGER maintenance_touch BEFORE UPDATE ON maintenance_log FOR EACH ROW EXECUTE FUNCTION pms_touch_updated_at();
CREATE TRIGGER maintenance_no_delete BEFORE DELETE ON maintenance_log FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();

-- ── Hardware fitted (row 3). One row per fitting; removal closes it ─────────
CREATE TABLE hardware_fitted (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  robot_id                   text NOT NULL REFERENCES robots(robot_id),
  part_type_id               uuid NOT NULL REFERENCES part_types(id),
  slot                       integer CHECK (slot IS NULL OR slot > 0),   -- camera 1–4, encoder index …
  model                      text,                                       -- 'M9N', 'RTK' …
  serial_number              text,
  fitted_at                  date NOT NULL,
  removed_at                 date,
  removal_reason             text,
  fitted_maintenance_id      uuid REFERENCES maintenance_log(id),
  removed_maintenance_id     uuid REFERENCES maintenance_log(id),
  notes                      text,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  created_by                 uuid REFERENCES users(id),
  CHECK (removed_at IS NULL OR removed_at >= fitted_at)
);
-- one current part per (robot, part type, slot)
CREATE UNIQUE INDEX hardware_fitted_current_uq ON hardware_fitted (robot_id, part_type_id, coalesce(slot, 0))
  WHERE removed_at IS NULL;
CREATE INDEX hardware_fitted_robot_idx ON hardware_fitted (robot_id, fitted_at DESC);
CREATE INDEX hardware_fitted_serial_idx ON hardware_fitted (upper(serial_number)) WHERE serial_number IS NOT NULL;
CREATE TRIGGER hardware_fitted_close_only BEFORE UPDATE ON hardware_fitted
  FOR EACH ROW EXECUTE FUNCTION pms_allow_update_only('removed_at', 'removal_reason', 'removed_maintenance_id', 'notes');
CREATE TRIGGER hardware_fitted_no_delete BEFORE DELETE ON hardware_fitted FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();

-- ── Software (row 4). A row is appended only when versions/features CHANGE ──
CREATE TABLE software_history (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  robot_id          text NOT NULL REFERENCES robots(robot_id),
  sw_ver            text,
  fw_ver            text,
  enabled_features  jsonb,                     -- sorted array of strings
  boot_id           text,
  reported_at       timestamptz NOT NULL,      -- message capture ts
  source_msg_id     uuid,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX software_history_robot_idx ON software_history (robot_id, reported_at DESC);
CREATE TRIGGER software_history_no_update BEFORE UPDATE ON software_history FOR EACH ROW EXECUTE FUNCTION pms_forbid_update();
CREATE TRIGGER software_history_no_delete BEFORE DELETE ON software_history FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();

-- ── Connectivity (row 5). Admin-entered, current only. NO secrets here ──────
CREATE TABLE connectivity (
  robot_id                    text PRIMARY KEY REFERENCES robots(robot_id),
  network_address             text,
  ssh_ip                      inet,
  cloudflare_tunnel_hostname  text,
  omni_ip                     inet,
  wifi_router_ip              inet,
  gcs_camera_domain           text,     -- the GCS's NEXT_PUBLIC_CAMERA_DOMAIN value for this robot
  gcs_server_domain           text,     -- the GCS's NEXT_PUBLIC_SERVER_DOMAIN value for this robot
  reported_ips                jsonb,    -- last IPs from `hello`; shown for comparison, never overwrites the above
  reported_at                 timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  updated_by                  uuid REFERENCES users(id),
  CHECK (gcs_camera_domain IS NULL OR gcs_camera_domain !~ '://[^/]*@'),
  CHECK (gcs_server_domain IS NULL OR gcs_server_domain !~ '://[^/]*@')
);
CREATE TRIGGER connectivity_touch BEFORE UPDATE ON connectivity FOR EACH ROW EXECUTE FUNCTION pms_touch_updated_at();
CREATE TRIGGER connectivity_no_delete BEFORE DELETE ON connectivity FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();

CREATE TABLE robot_cameras (
  robot_id    text NOT NULL REFERENCES robots(robot_id),
  slot        integer NOT NULL CHECK (slot BETWEEN 1 AND 4),
  ip          inet,
  -- Rule 11: camera stream URLs in normal tables never carry user:password.
  stream_url  text CHECK (stream_url IS NULL OR stream_url !~ '://[^/@]*@'),
  model       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES users(id),
  PRIMARY KEY (robot_id, slot)
);
CREATE TRIGGER robot_cameras_touch BEFORE UPDATE ON robot_cameras FOR EACH ROW EXECUTE FUNCTION pms_touch_updated_at();
CREATE TRIGGER robot_cameras_no_delete BEFORE DELETE ON robot_cameras FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();

-- ── Dispatch & warranty (row 8). warranty_document_id FK added in 0005 ──────
CREATE TABLE dispatch_warranty (
  robot_id              text PRIMARY KEY REFERENCES robots(robot_id),
  dispatch_date         date,
  warranty_start        date,
  warranty_end          date,
  warranty_document_id  uuid,
  notes                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid REFERENCES users(id),
  CHECK (warranty_end IS NULL OR warranty_start IS NULL OR warranty_end >= warranty_start)
);
CREATE TRIGGER dispatch_touch BEFORE UPDATE ON dispatch_warranty FOR EACH ROW EXECUTE FUNCTION pms_touch_updated_at();
CREATE TRIGGER dispatch_no_delete BEFORE DELETE ON dispatch_warranty FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();
