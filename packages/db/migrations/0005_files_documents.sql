-- 0005 · Files and documents (spec §3 rows 7–8, §8). Rule 9: files are NEVER stored in the DB;
-- Postgres keeps only the storage location + metadata. Every upload is a new object (never overwritten).

CREATE TABLE files (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_driver  text NOT NULL CHECK (storage_driver IN ('local', 's3', 'external')),
  bucket          text,                    -- S3 bucket (s3/external)
  object_key      text NOT NULL,           -- S3 key or path relative to STORAGE_LOCAL_DIR
  version_id      text,                    -- S3 VersionId (bucket versioning on)
  filename        text NOT NULL,
  content_type    text,
  size_bytes      bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  sha256          text CHECK (sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$'),
  uploaded_at     timestamptz NOT NULL DEFAULT now(),
  uploaded_by     uuid REFERENCES users(id),
  deleted_at      timestamptz
);
CREATE INDEX files_sha256_idx ON files (sha256) WHERE sha256 IS NOT NULL;
CREATE TRIGGER files_location_permanent BEFORE UPDATE ON files
  FOR EACH ROW EXECUTE FUNCTION pms_allow_update_only('deleted_at');
CREATE TRIGGER files_no_delete BEFORE DELETE ON files FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();

-- A document is attached to exactly ONE of: product, hardware revision, or robot (one-off builds).
CREATE TABLE documents (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_type              text NOT NULL CHECK (doc_type IN
                          ('circuit_diagram', 'pinout', 'bom', 'manual', 'component_list', 'warranty_clauses', 'other')),
  title                 text NOT NULL,
  product_id            uuid REFERENCES products(id),
  hardware_revision_id  uuid REFERENCES hardware_revisions(id),
  robot_id              text REFERENCES robots(robot_id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid REFERENCES users(id),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz,
  CHECK (num_nonnulls(product_id, hardware_revision_id, robot_id) = 1)
);
CREATE INDEX documents_product_idx  ON documents (product_id)           WHERE product_id IS NOT NULL;
CREATE INDEX documents_revision_idx ON documents (hardware_revision_id) WHERE hardware_revision_id IS NOT NULL;
CREATE INDEX documents_robot_idx    ON documents (robot_id)             WHERE robot_id IS NOT NULL;
CREATE TRIGGER documents_touch BEFORE UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION pms_touch_updated_at();
CREATE TRIGGER documents_owner_permanent BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION pms_immutable_columns('product_id', 'hardware_revision_id', 'robot_id');
CREATE TRIGGER documents_no_delete BEFORE DELETE ON documents FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();

-- Each upload = new version (version number, uploaded by, date). Latest is shown; older stay available.
CREATE TABLE document_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id  uuid NOT NULL REFERENCES documents(id),
  version_no   integer NOT NULL CHECK (version_no > 0),
  file_id      uuid NOT NULL REFERENCES files(id),
  note         text,
  uploaded_at  timestamptz NOT NULL DEFAULT now(),
  uploaded_by  uuid REFERENCES users(id),
  UNIQUE (document_id, version_no)
);
CREATE TRIGGER document_versions_no_update BEFORE UPDATE ON document_versions FOR EACH ROW EXECUTE FUNCTION pms_forbid_update();
CREATE TRIGGER document_versions_no_delete BEFORE DELETE ON document_versions FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();

ALTER TABLE dispatch_warranty
  ADD CONSTRAINT dispatch_warranty_document_fk FOREIGN KEY (warranty_document_id) REFERENCES documents(id);
