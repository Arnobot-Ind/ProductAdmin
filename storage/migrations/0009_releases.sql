-- 0009 · Software & firmware releases (spec §9). One record per version; every version is kept.

CREATE TABLE releases (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id            uuid NOT NULL REFERENCES products(id),
  component             text NOT NULL CHECK (component IN ('software', 'firmware')),
  version               text NOT NULL CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.+-]+)?$'),  -- semver
  file_id               uuid REFERENCES files(id),       -- update package in S3
  sha256                text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  signature             text NOT NULL CHECK (length(signature) > 0),   -- Arnobot signature (base64)
  signature_algo        text,                                           -- e.g. ed25519
  requires_component    text CHECK (requires_component IN ('software', 'firmware')),
  requires_min_version  text CHECK (requires_min_version IS NULL OR requires_min_version ~ '^[0-9]+\.[0-9]+\.[0-9]+'),
  notes                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid REFERENCES users(id),
  deleted_at            timestamptz,
  CHECK ((requires_component IS NULL) = (requires_min_version IS NULL)),
  CHECK (requires_component IS NULL OR requires_component <> component)
);
-- a version number is never reused for a product/component, even after soft delete
CREATE UNIQUE INDEX releases_version_uq ON releases (product_id, component, version);
CREATE TRIGGER releases_immutable BEFORE UPDATE ON releases
  FOR EACH ROW EXECUTE FUNCTION pms_allow_update_only('notes', 'deleted_at');
CREATE TRIGGER releases_no_delete BEFORE DELETE ON releases FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();
