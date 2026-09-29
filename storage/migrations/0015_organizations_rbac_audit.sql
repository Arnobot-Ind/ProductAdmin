-- 0015 · Organizations, customer roles, data permissions, invitations and the audit log.
--
--   Organizations  = the existing `companies` table. Arnobot is the one `internal` organization; customers
--                    (e.g. Adani) are `customer` rows. A robot belongs to the organization in its CURRENT
--                    company_assignment_history period ("assign Robot-01 → Adani" = open a new period).
--   Users          = every login belongs to exactly one organization (users.company_id). A customer user
--                    may only hold grants inside their own organization (enforced by the server).
--   Roles          = `staff` roles for Arnobot (platform scope) and `customer` roles for an organization's
--                    team (company or robot scope, never platform).
--   Robot/device credentials stay in robot_credentials / ingest_* (0006): never user logins, never shown to
--                    customer roles (no credential.* permission).
--   Audit log      = append-only record of sign-ins, data access and downloads, robot assignments and
--                    permission changes. The server writes it; nobody can UPDATE or DELETE a row.

-- ── organizations ──────────────────────────────────────────────────────────
ALTER TABLE companies
  ADD COLUMN kind          text NOT NULL DEFAULT 'customer' CHECK (kind IN ('internal', 'customer')),
  ADD COLUMN contact_name  text,
  ADD COLUMN contact_email citext,
  ADD COLUMN notes         text;
UPDATE companies SET kind = 'internal' WHERE lower(name) = 'arnobot';
CREATE UNIQUE INDEX companies_one_internal_uq ON companies (kind) WHERE kind = 'internal' AND deleted_at IS NULL;

-- ── users: home organization, invitations, forced password change ─────────
ALTER TABLE users
  ADD COLUMN company_id           uuid REFERENCES companies(id),
  ADD COLUMN must_change_password boolean NOT NULL DEFAULT false,
  ADD COLUMN password_changed_at  timestamptz,
  -- Invitation: only an HMAC of the one-time token is stored; the link is shown once to the admin.
  ADD COLUMN invite_token_hash    text UNIQUE,
  ADD COLUMN invite_expires_at    timestamptz;
UPDATE users SET company_id = (SELECT id FROM companies WHERE kind = 'internal' AND deleted_at IS NULL LIMIT 1) WHERE company_id IS NULL;
ALTER TABLE users ALTER COLUMN company_id SET NOT NULL;
-- An invited user has no password until they accept the invitation.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ADD CONSTRAINT users_password_or_invite CHECK (password_hash IS NOT NULL OR invite_token_hash IS NOT NULL);
CREATE INDEX users_company_idx ON users (company_id) WHERE deleted_at IS NULL;

-- ── roles: who they are for ───────────────────────────────────────────────
ALTER TABLE roles
  ADD COLUMN audience   text NOT NULL DEFAULT 'staff' CHECK (audience IN ('staff', 'customer')),
  ADD COLUMN sort_order integer NOT NULL DEFAULT 100;

UPDATE roles SET sort_order = 10, description = 'Arnobot. Everything, including giving Arnobot-wide (platform) roles' WHERE key = 'super_admin';
UPDATE roles SET sort_order = 20, description = 'Arnobot. Everything: organizations, robot assignment, customer users, audit log. Cannot give platform roles' WHERE key = 'admin';
UPDATE roles SET sort_order = 30 WHERE key = 'engineer';
UPDATE roles SET sort_order = 40, description = 'Arnobot. Read only' WHERE key = 'viewer';

INSERT INTO roles (key, name, description, audience, sort_order) VALUES
  ('org_manager',  'Organization manager',  'Customer. Sees the organization''s robots and data; downloads everything incl. raw LiDAR / IMU; controls robots; acknowledges events', 'customer', 50),
  ('org_operator', 'Organization operator', 'Customer. Sees the organization''s robots and data; downloads video and metadata (not raw sensor data); controls robots; acknowledges events', 'customer', 60),
  ('org_viewer',   'Organization viewer',   'Customer. Views the organization''s robots and data (video plays, LiDAR / IMU previews). Cannot download', 'customer', 70)
ON CONFLICT (key) DO NOTHING;

-- ── permissions: view / download / control / delete, organizations, audit ──
UPDATE permissions SET description = 'View robots and their data: live state, telemetry, missions, events, recordings (video playback, LiDAR / IMU previews)' WHERE key = 'robot.read';
UPDATE permissions SET description = 'Assign robots to organizations (ownership transfer)' WHERE key = 'ownership.write';
UPDATE permissions SET description = 'Manage users and role grants (only a super-admin can give platform roles)' WHERE key = 'user.manage';

INSERT INTO permissions (key, description) VALUES
  ('data.download',            'Download recordings: camera video (MP4 / .ts), session.json, upload logs, mission files'),
  ('data.download_restricted', 'Download restricted raw sensor data: LiDAR (.npz) and IMU (.csv.gz) chunks'),
  ('data.delete',              'Delete (hide) and restore recordings'),
  ('robot.control',            'Send commands to a robot (remote control). Reserved: the PMS has no remote commands yet'),
  ('org.manage',               'Create, edit and delete organizations'),
  ('audit.read',               'Read the audit log'),
  ('system.read',              'See the server / storage status page and fleet-wide counts')
ON CONFLICT (key) DO NOTHING;

-- Admin now manages users too (the platform-role restriction is enforced by the server).
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON
     r.key IN ('super_admin', 'admin')
  OR (r.key = 'engineer'     AND p.key IN ('data.download', 'data.download_restricted', 'robot.control', 'system.read'))
  OR (r.key = 'viewer'       AND p.key IN ('system.read'))
  OR (r.key = 'org_manager'  AND p.key IN ('robot.read', 'data.download', 'data.download_restricted', 'robot.control', 'event.ack'))
  OR (r.key = 'org_operator' AND p.key IN ('robot.read', 'data.download', 'robot.control', 'event.ack'))
  OR (r.key = 'org_viewer'   AND p.key IN ('robot.read'))
ON CONFLICT DO NOTHING;

-- ── recordings: soft delete (the objects stay in the bucket; hidden everywhere, restorable) ──
ALTER TABLE archive_sessions
  ADD COLUMN deleted_at    timestamptz,
  ADD COLUMN deleted_by    uuid REFERENCES users(id),
  ADD COLUMN delete_reason text;

-- ── audit log ─────────────────────────────────────────────────────────────
CREATE TABLE audit_log (
  id           bigserial PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  actor_id     uuid REFERENCES users(id),        -- NULL: unknown user (failed sign-in) or the system
  actor_email  citext,                           -- copied, so the row still reads right after renames
  action       text NOT NULL CHECK (action ~ '^[a-z_]+\.[a-z_]+$'),
  outcome      text NOT NULL DEFAULT 'success' CHECK (outcome IN ('success', 'denied', 'failure')),
  target_type  text,
  target_id    text,
  robot_id     text,                             -- no FK: the log outlives whatever it points at
  company_id   uuid,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip           text,
  user_agent   text
);
CREATE INDEX audit_log_at_idx      ON audit_log (at DESC);
CREATE INDEX audit_log_actor_idx   ON audit_log (actor_id, at DESC);
CREATE INDEX audit_log_robot_idx   ON audit_log (robot_id, at DESC) WHERE robot_id IS NOT NULL;
CREATE INDEX audit_log_company_idx ON audit_log (company_id, at DESC) WHERE company_id IS NOT NULL;
CREATE INDEX audit_log_action_idx  ON audit_log (action, at DESC);
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log FOR EACH ROW EXECUTE FUNCTION pms_forbid_update();
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();
