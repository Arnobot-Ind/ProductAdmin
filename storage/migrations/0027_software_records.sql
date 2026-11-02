-- 0027 · Software keeps the same records as hardware: a page per software item with its version history (each
-- version with its commit and what changed), photos / screenshots, and versioned documents.

-- ── Every version of a catalogue software, newest first. The newest one is the software's latest_version. ──
CREATE TABLE software_versions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  software_product_id   uuid NOT NULL REFERENCES software_products(id),
  version               text NOT NULL CHECK (length(trim(version)) BETWEEN 1 AND 64),
  commit_id             text CHECK (commit_id IS NULL OR commit_id ~* '^[0-9a-f]{7,64}$'),
  released_at           timestamptz NOT NULL DEFAULT now(),
  notes                 text,                    -- what changed
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid REFERENCES users(id),
  deleted_at            timestamptz
);
CREATE UNIQUE INDEX software_versions_uq ON software_versions (software_product_id, lower(version)) WHERE deleted_at IS NULL;
CREATE INDEX software_versions_product_idx ON software_versions (software_product_id, released_at DESC) WHERE deleted_at IS NULL;
CREATE TRIGGER software_versions_no_delete BEFORE DELETE ON software_versions FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();
-- The version each software already names becomes the first row of its history.
INSERT INTO software_versions (software_product_id, version, commit_id, released_at, notes)
  SELECT id, latest_version, commit_id, updated_at, 'Recorded before the version history' FROM software_products WHERE latest_version IS NOT NULL;

-- ── Photos / screenshots and documents can belong to a software item as well ──
ALTER TABLE product_media ADD COLUMN software_product_id uuid REFERENCES software_products(id);
ALTER TABLE product_media DROP CONSTRAINT product_media_owner_check;
ALTER TABLE product_media ADD CONSTRAINT product_media_owner_check CHECK (num_nonnulls(product_id, attachment_id, software_product_id) = 1);
CREATE INDEX product_media_software_idx ON product_media (software_product_id, kind, position, created_at) WHERE deleted_at IS NULL AND software_product_id IS NOT NULL;

ALTER TABLE documents ADD COLUMN software_product_id uuid REFERENCES software_products(id);
ALTER TABLE documents DROP CONSTRAINT documents_owner_check;
ALTER TABLE documents ADD CONSTRAINT documents_owner_check CHECK (num_nonnulls(product_id, hardware_revision_id, robot_id, attachment_id, software_product_id) = 1);
CREATE INDEX documents_software_idx ON documents (software_product_id) WHERE software_product_id IS NOT NULL;
DROP TRIGGER documents_owner_permanent ON documents;
CREATE TRIGGER documents_owner_permanent BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION pms_immutable_columns('product_id', 'hardware_revision_id', 'robot_id', 'attachment_id', 'software_product_id');
