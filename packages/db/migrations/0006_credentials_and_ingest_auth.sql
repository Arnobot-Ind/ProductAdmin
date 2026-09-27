-- 0006 · Device credentials (spec §3 row 6, §10) and ingest authentication.
-- Rule 11: secrets live ONLY in robot_credentials, AES-256-GCM encrypted with a key held
-- outside the database (CREDENTIAL_ENCRYPTION_KEY). Never in robots, logs, list responses or URLs.

CREATE TABLE robot_credentials (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  robot_id         text NOT NULL REFERENCES robots(robot_id),
  kind             text NOT NULL CHECK (kind IN ('cloudflare', 'camera_admin', 'camera_operator', 'camera_rtsp_url',
                                                 'ssh', 'ssh_public_key', 'omni', 'wifi_router', 'gcs_login', 'gcs_api_token')),
  slot             integer CHECK (slot IS NULL OR slot BETWEEN 1 AND 4),   -- camera 1–4
  label            text,
  username         text,                   -- non-secret part; may be displayed
  ciphertext       bytea NOT NULL,
  iv               bytea NOT NULL CHECK (octet_length(iv) = 12),
  auth_tag         bytea NOT NULL CHECK (octet_length(auth_tag) = 16),
  key_version      integer NOT NULL CHECK (key_version > 0),
  rotated_from_id  uuid REFERENCES robot_credentials(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES users(id),
  revoked_at       timestamptz,
  revoked_by       uuid REFERENCES users(id),
  revoke_reason    text,
  CHECK ((kind IN ('camera_admin', 'camera_operator', 'camera_rtsp_url')) = (slot IS NOT NULL))
);
-- one active secret per (robot, kind, slot); rotation = revoke old + insert new
CREATE UNIQUE INDEX robot_credentials_active_uq ON robot_credentials (robot_id, kind, coalesce(slot, 0))
  WHERE revoked_at IS NULL;
CREATE INDEX robot_credentials_robot_idx ON robot_credentials (robot_id);
-- ciphertext is write-once; only revocation fields may change
CREATE TRIGGER robot_credentials_revoke_only BEFORE UPDATE ON robot_credentials
  FOR EACH ROW EXECUTE FUNCTION pms_allow_update_only('revoked_at', 'revoked_by', 'revoke_reason');
CREATE TRIGGER robot_credentials_no_delete BEFORE DELETE ON robot_credentials FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();

-- Who may push data INTO the PMS. Auth is per connection (docs/architecture.md):
--   kind 'robot' → exactly its own robot; kind 'gcs' → the robots listed in ingest_client_robots.
CREATE TABLE ingest_clients (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('robot', 'gcs')),
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES users(id),
  revoked_at  timestamptz,
  revoked_by  uuid REFERENCES users(id)
);
CREATE TRIGGER ingest_clients_no_delete BEFORE DELETE ON ingest_clients FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();

CREATE TABLE ingest_client_robots (
  client_id   uuid NOT NULL REFERENCES ingest_clients(id),
  robot_id    text NOT NULL REFERENCES robots(robot_id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES users(id),
  revoked_at  timestamptz,
  PRIMARY KEY (client_id, robot_id)
);
CREATE INDEX ingest_client_robots_robot_idx ON ingest_client_robots (robot_id);
CREATE TRIGGER icr_no_delete BEFORE DELETE ON ingest_client_robots FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();

-- API keys: 32 random bytes, shown once. Only SHA-256 of the key is stored (high-entropy key,
-- so a fast hash is appropriate and allows indexed lookup). Several keys per client → zero-downtime rotation.
CREATE TABLE ingest_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     uuid NOT NULL REFERENCES ingest_clients(id),
  key_prefix    text NOT NULL,             -- first chars, for identification in the UI
  key_hash      text NOT NULL UNIQUE CHECK (key_hash ~ '^[a-f0-9]{64}$'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES users(id),
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  revoked_by    uuid REFERENCES users(id)
);
CREATE INDEX ingest_keys_client_idx ON ingest_keys (client_id);
CREATE TRIGGER ingest_keys_limited BEFORE UPDATE ON ingest_keys
  FOR EACH ROW EXECUTE FUNCTION pms_allow_update_only('last_used_at', 'revoked_at', 'revoked_by');
CREATE TRIGGER ingest_keys_no_delete BEFORE DELETE ON ingest_keys FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();
