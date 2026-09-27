-- 0002 · Organisation (spec §1) and access control (spec §12).
-- v1 has one company (Arnobot). Sites / operators / customers are added later as ROWS.

CREATE TABLE companies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE UNIQUE INDEX companies_name_uq ON companies (lower(name)) WHERE deleted_at IS NULL;

-- Future (not used in v1): a site belongs to a company. Present so site-scoped grants are data, not code.
CREATE TABLE sites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          citext NOT NULL,
  name           text NOT NULL,
  password_hash  text NOT NULL,             -- argon2id; never returned by the API
  is_active      boolean NOT NULL DEFAULT true,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES users(id),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);
CREATE UNIQUE INDEX users_email_uq ON users (email) WHERE deleted_at IS NULL;

ALTER TABLE companies ADD CONSTRAINT companies_created_by_fk FOREIGN KEY (created_by) REFERENCES users(id);
ALTER TABLE sites     ADD CONSTRAINT sites_created_by_fk     FOREIGN KEY (created_by) REFERENCES users(id);

CREATE TABLE roles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key          text NOT NULL UNIQUE,        -- super_admin, admin, engineer, viewer …
  name         text NOT NULL,
  description  text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE permissions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key          text NOT NULL UNIQUE CHECK (key ~ '^[a-z_]+\.[a-z_]+$'),   -- <resource>.<verb>
  description  text NOT NULL
);

CREATE TABLE role_permissions (
  role_id        uuid NOT NULL REFERENCES roles(id),
  permission_id  uuid NOT NULL REFERENCES permissions(id),
  PRIMARY KEY (role_id, permission_id)
);

-- User → Role → Scope. scope_id is NULL for platform, a company/site uuid, or a robot_id.
CREATE TABLE role_grants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  role_id     uuid NOT NULL REFERENCES roles(id),
  scope_type  text NOT NULL CHECK (scope_type IN ('platform', 'company', 'site', 'robot')),
  scope_id    text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES users(id),
  revoked_at  timestamptz,
  revoked_by  uuid REFERENCES users(id),
  CHECK ((scope_type = 'platform') = (scope_id IS NULL))
);
CREATE INDEX role_grants_user_active_idx ON role_grants (user_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX role_grants_active_uq
  ON role_grants (user_id, role_id, scope_type, coalesce(scope_id, ''))
  WHERE revoked_at IS NULL;

-- Opaque server-side sessions (httpOnly cookie). Only an HMAC of the token is stored.
CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id),
  token_hash    text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  ip            text,
  user_agent    text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);


CREATE TRIGGER companies_touch BEFORE UPDATE ON companies FOR EACH ROW EXECUTE FUNCTION pms_touch_updated_at();
CREATE TRIGGER sites_touch     BEFORE UPDATE ON sites     FOR EACH ROW EXECUTE FUNCTION pms_touch_updated_at();
CREATE TRIGGER users_touch     BEFORE UPDATE ON users     FOR EACH ROW EXECUTE FUNCTION pms_touch_updated_at();

CREATE TRIGGER companies_no_delete   BEFORE DELETE ON companies   FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();
CREATE TRIGGER sites_no_delete       BEFORE DELETE ON sites       FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();
CREATE TRIGGER users_no_delete       BEFORE DELETE ON users       FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();
CREATE TRIGGER role_grants_no_delete BEFORE DELETE ON role_grants FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();
CREATE TRIGGER role_grants_limited   BEFORE UPDATE ON role_grants FOR EACH ROW EXECUTE FUNCTION pms_allow_update_only('revoked_at', 'revoked_by');
