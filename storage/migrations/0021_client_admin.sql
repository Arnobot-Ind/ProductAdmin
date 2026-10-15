-- 0021 · Client admin (user decision, 2026-10-15), ported from the GCS repo's clientAdmin into this one database.
--
-- Arnobot staff set up each customer organization in the PMS: its profile (status, contract, account manager, how
-- much history it sees), the client portal features it has bought, the Arnobot software it runs (licences) and the
-- credentials Arnobot holds for it. Customers sign in only to the client app; their Manager decides, per user,
-- which robots (role grants, as before) and which of the organization's features each user gets.
--
-- No video and no CSV in the client app (user decision): those are not features, so they can never be granted.
-- Same house rules as the rest of the schema: nothing is hard-deleted, grants are revoked, secrets are ciphertext.

-- ── client profile: 1:1 with a customer organization. A customer without a row reads as status 'active'. ──
CREATE TABLE client_profiles (
  company_id          uuid PRIMARY KEY REFERENCES companies(id),
  client_code         text CHECK (client_code ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'),     -- short code, e.g. 'ADANI'
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('onboarding', 'active', 'suspended', 'ended')),
  legal_name          text,
  industry            text,
  phone               text,
  address             text,
  gstin               text CHECK (gstin IS NULL OR gstin ~ '^[0-9A-Z]{15}$'),
  billing_email       citext,
  account_manager_id  uuid REFERENCES users(id),                                   -- an Arnobot user
  contract_start      date,
  contract_end        date,
  data_history_days   integer CHECK (data_history_days IS NULL OR data_history_days > 0),  -- NULL = all history
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid REFERENCES users(id),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid REFERENCES users(id),
  CHECK (contract_end IS NULL OR contract_start IS NULL OR contract_end >= contract_start)
);
CREATE UNIQUE INDEX client_profiles_code_uq ON client_profiles (client_code) WHERE client_code IS NOT NULL;
CREATE TRIGGER client_profiles_touch     BEFORE UPDATE ON client_profiles FOR EACH ROW EXECUTE FUNCTION pms_touch_updated_at();
CREATE TRIGGER client_profiles_no_delete BEFORE DELETE ON client_profiles FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();

-- ── client app features: what an organization can be given. Reference data, owned by migrations. ──
-- always_on = everyone has it and it cannot be removed. requires = keys that must be granted with this one.
-- Keys are permanent: retire one with retired_at in a later migration, never rename or delete it.
CREATE TABLE client_features (
  key          text PRIMARY KEY CHECK (key ~ '^portal(\.[a-z0-9_]+)+$'),
  area         text NOT NULL,
  name         text NOT NULL,
  description  text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('view', 'export')),
  always_on    boolean NOT NULL DEFAULT false,
  is_default   boolean NOT NULL DEFAULT true,     -- part of a new organization's starting set
  requires     text[] NOT NULL DEFAULT '{}',
  sort_order   integer NOT NULL,
  retired_at   timestamptz
);

INSERT INTO client_features (key, area, name, description, kind, always_on, is_default, requires, sort_order) VALUES
  ('portal.robots.view',       'Robots',   'Robots and live status',  'The robots the user may see: status, battery, mode, distance. Always granted', 'view', true, true, '{}', 100),
  ('portal.robots.location',   'Robots',   'Robot location',          'Last reported position of each robot on a map, and the GPS track', 'view', false, true, '{}', 110),
  ('portal.missions.view',     'Missions', 'Missions',                'Runs with result, duration, distance, planned vs actual route and waypoints', 'view', false, true, '{}', 200),
  ('portal.reports.view',      'Reports',  'Reports calendar',        'Mission report, day summary, monthly summary and night surveillance log', 'view', false, true, '{portal.missions.view}', 300),
  ('portal.reports.download',  'Reports',  'Download report PDFs',    'Save the reports as PDF', 'export', false, true, '{portal.reports.view}', 310),
  ('portal.telemetry.view',    'Data',     'Battery and health',      'Battery, temperature and device health history (charts)', 'view', false, false, '{}', 400),
  ('portal.events.view',       'Data',     'Events and alerts',       'Alerts, faults, aborts and return-to-home events', 'view', false, false, '{}', 500),
  ('portal.software.view',     'Software', 'Software and licences',   'Installed Arnobot software, versions and licence dates', 'view', false, false, '{}', 600);

-- every `requires` entry must name a feature
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(f.key || ' -> ' || r, ', ') INTO bad
  FROM client_features f, unnest(f.requires) r WHERE NOT EXISTS (SELECT 1 FROM client_features g WHERE g.key = r);
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'unknown feature requirement: %', bad; END IF;
END $$;

-- ── organization entitlements (what the client has bought: the ceiling for its users) ──
CREATE TABLE company_features (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id),
  feature_key  text NOT NULL REFERENCES client_features(key),
  granted_at   timestamptz NOT NULL DEFAULT now(),
  granted_by   uuid REFERENCES users(id),
  revoked_at   timestamptz,
  revoked_by   uuid REFERENCES users(id)
);
CREATE UNIQUE INDEX company_features_active_uq ON company_features (company_id, feature_key) WHERE revoked_at IS NULL;
CREATE TRIGGER company_features_revoke_only BEFORE UPDATE ON company_features
  FOR EACH ROW EXECUTE FUNCTION pms_allow_update_only('revoked_at', 'revoked_by');
CREATE TRIGGER company_features_no_delete BEFORE DELETE ON company_features FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();

-- ── per-user features: a subset of the organization's. Robots per user stay role grants (organization or robot scope). ──
CREATE TABLE user_features (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id),
  feature_key  text NOT NULL REFERENCES client_features(key),
  granted_at   timestamptz NOT NULL DEFAULT now(),
  granted_by   uuid REFERENCES users(id),
  revoked_at   timestamptz,
  revoked_by   uuid REFERENCES users(id)
);
CREATE UNIQUE INDEX user_features_active_uq ON user_features (user_id, feature_key) WHERE revoked_at IS NULL;
CREATE TRIGGER user_features_revoke_only BEFORE UPDATE ON user_features
  FOR EACH ROW EXECUTE FUNCTION pms_allow_update_only('revoked_at', 'revoked_by');
CREATE TRIGGER user_features_no_delete BEFORE DELETE ON user_features FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();

-- ── software catalogue: what Arnobot ships to clients ──
CREATE TABLE software_products (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  name            text NOT NULL CHECK (length(trim(name)) > 0),
  kind            text NOT NULL CHECK (kind IN ('desktop_app', 'web_app', 'robot_software', 'firmware', 'service')),
  description     text,
  latest_version  text CHECK (latest_version IS NULL OR length(trim(latest_version)) BETWEEN 1 AND 64),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE UNIQUE INDEX software_products_code_uq ON software_products (code);   -- codes are never reused
CREATE TRIGGER software_products_touch     BEFORE UPDATE ON software_products FOR EACH ROW EXECUTE FUNCTION pms_touch_updated_at();
CREATE TRIGGER software_products_code      BEFORE UPDATE ON software_products FOR EACH ROW EXECUTE FUNCTION pms_immutable_columns('code');
CREATE TRIGGER software_products_no_delete BEFORE DELETE ON software_products FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();

INSERT INTO software_products (code, name, kind, description, latest_version) VALUES
  ('gcs_desktop',   'ARNOBOT GCS (desktop)', 'desktop_app',    'Operator app for Windows/macOS; bundles the GCS web app', NULL),
  ('gcs_web',       'ARNOBOT GCS (web)',     'web_app',        'Operator app served from a browser', NULL),
  ('client_portal', 'Client portal',         'web_app',        'The client''s own dashboard: robots, missions and reports', NULL),
  ('robot_stack',   'Robot software',        'robot_software', 'Jetson services: navigation, operator API, cameras, recording, cloud sync', NULL),
  ('giga_firmware', 'Controller firmware',   'firmware',       'Arduino GIGA R1 motor/RC controller firmware', NULL),
  ('cloud_sync',    'Cloud data collection', 'service',        'Upload of video, LiDAR and IMU sessions to the Arnobot archive', NULL);

-- ── software in use: one row per installation / licence a client has ──
CREATE TABLE software_installs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL REFERENCES companies(id),
  software_id          uuid NOT NULL REFERENCES software_products(id),
  robot_id             text REFERENCES robots(robot_id),        -- NULL = not bound to a robot
  version              text NOT NULL CHECK (length(trim(version)) BETWEEN 1 AND 64),
  host_label           text,                                    -- 'Control room PC 2'
  seats                integer CHECK (seats IS NULL OR seats > 0),
  installed_at         date,
  licence_valid_until  date,                                    -- NULL = perpetual / not licensed
  notes                text,                                    -- Arnobot-only; never shown to the client
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid REFERENCES users(id),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid REFERENCES users(id),
  deleted_at           timestamptz,
  deleted_by           uuid REFERENCES users(id)
);
CREATE INDEX software_installs_company_idx ON software_installs (company_id) WHERE deleted_at IS NULL;
CREATE TRIGGER software_installs_touch     BEFORE UPDATE ON software_installs FOR EACH ROW EXECUTE FUNCTION pms_touch_updated_at();
CREATE TRIGGER software_installs_owner     BEFORE UPDATE ON software_installs FOR EACH ROW EXECUTE FUNCTION pms_immutable_columns('company_id');
CREATE TRIGGER software_installs_no_delete BEFORE DELETE ON software_installs FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();

-- ── client credentials: secrets Arnobot holds for a client (GCS logins, API tokens, Wi-Fi, VPN …) ──
-- AES-256-GCM with the backend's CREDENTIAL_ENCRYPTION_KEY, AAD 'client-cred|<id>|<company_id>|<kind>' (the id is
-- generated before the insert, so every ciphertext is bound to its own row). Rotation = revoke + insert.
-- Robot-side secrets stay in robot_credentials.
CREATE TABLE client_credentials (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL REFERENCES companies(id),
  kind                 text NOT NULL CHECK (kind IN ('gcs_login', 'gcs_api_token', 'portal', 'camera', 'wifi', 'vpn', 'cloud', 'email', 'other')),
  label                text NOT NULL CHECK (length(trim(label)) > 0),
  username             text,                                    -- non-secret part; may be displayed
  url                  text CHECK (url IS NULL OR url !~ '://[^/]*@'),   -- never credentials inside a URL
  robot_id             text REFERENCES robots(robot_id),
  notes                text,
  ciphertext           bytea NOT NULL,
  iv                   bytea NOT NULL CHECK (octet_length(iv) = 12),
  auth_tag             bytea NOT NULL CHECK (octet_length(auth_tag) = 16),
  key_version          integer NOT NULL CHECK (key_version > 0),
  rotated_from_id      uuid REFERENCES client_credentials(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid REFERENCES users(id),
  revoked_at           timestamptz,
  revoked_by           uuid REFERENCES users(id),
  revoke_reason        text
);
CREATE INDEX client_credentials_company_idx ON client_credentials (company_id);
CREATE TRIGGER client_credentials_revoke_only BEFORE UPDATE ON client_credentials
  FOR EACH ROW EXECUTE FUNCTION pms_allow_update_only('revoked_at', 'revoked_by', 'revoke_reason');
CREATE TRIGGER client_credentials_no_delete BEFORE DELETE ON client_credentials FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();

-- ── existing customers keep what they had: the default features, for the organization and for every user ──
INSERT INTO company_features (company_id, feature_key)
SELECT c.id, f.key FROM companies c CROSS JOIN client_features f
WHERE c.kind = 'customer' AND (f.is_default OR f.always_on);

INSERT INTO user_features (user_id, feature_key)
SELECT u.id, cf.feature_key FROM users u JOIN companies c ON c.id = u.company_id
JOIN company_features cf ON cf.company_id = c.id AND cf.revoked_at IS NULL
WHERE c.kind = 'customer' AND u.deleted_at IS NULL;
