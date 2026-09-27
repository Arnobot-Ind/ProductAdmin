-- 0003 · Product catalogue (spec §4). Products and part types are DATA, not enums (rule 15).

CREATE TABLE products (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                 text NOT NULL CHECK (code ~ '^[a-z][a-z_]*$'),  -- robot_id prefix + envelope `product`
  name                 text NOT NULL,
  description          text,
  next_running_number  integer NOT NULL DEFAULT 1 CHECK (next_running_number > 0),
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid REFERENCES users(id),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz
);
-- Codes are unique forever (even soft-deleted): they prefix permanent robot IDs.
CREATE UNIQUE INDEX products_code_uq ON products (code);

-- "A name for one set of main components". Optional on a robot in v1.
CREATE TABLE hardware_revisions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id   uuid NOT NULL REFERENCES products(id),
  name         text NOT NULL,                  -- 'Rev A'
  description  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid REFERENCES users(id),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);
CREATE UNIQUE INDEX hardware_revisions_name_uq ON hardware_revisions (product_id, lower(name)) WHERE deleted_at IS NULL;

CREATE TABLE part_types (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key            text NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_]*$'),  -- gps, encoder, imu, lidar, camera, controller
  name           text NOT NULL,
  max_per_robot  integer CHECK (max_per_robot IS NULL OR max_per_robot > 0),  -- NULL = unlimited
  created_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);

-- The "main components" that define a revision.
CREATE TABLE hardware_revision_components (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hardware_revision_id  uuid NOT NULL REFERENCES hardware_revisions(id),
  part_type_id          uuid NOT NULL REFERENCES part_types(id),
  slot                  integer CHECK (slot IS NULL OR slot > 0),
  model                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid REFERENCES users(id),
  deleted_at            timestamptz
);
CREATE UNIQUE INDEX hrc_slot_uq ON hardware_revision_components (hardware_revision_id, part_type_id, coalesce(slot, 0))
  WHERE deleted_at IS NULL;

CREATE TRIGGER products_touch  BEFORE UPDATE ON products           FOR EACH ROW EXECUTE FUNCTION pms_touch_updated_at();
CREATE TRIGGER revisions_touch BEFORE UPDATE ON hardware_revisions FOR EACH ROW EXECUTE FUNCTION pms_touch_updated_at();
CREATE TRIGGER products_code_permanent BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION pms_immutable_columns('code');

CREATE TRIGGER products_no_delete   BEFORE DELETE ON products                     FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();
CREATE TRIGGER revisions_no_delete  BEFORE DELETE ON hardware_revisions           FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();
CREATE TRIGGER part_types_no_delete BEFORE DELETE ON part_types                   FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();
CREATE TRIGGER hrc_no_delete        BEFORE DELETE ON hardware_revision_components FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();
