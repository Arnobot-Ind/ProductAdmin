-- 0020 · Customer view (user decision, 2026-10-10).
--
-- Customer users (companies.kind = 'customer', e.g. Adani) see only: the robot overview + live status, the
-- day-wise report, and distance / odometry by day. Everything else about a robot is Arnobot-internal.
-- Customer Managers may invite and manage users of their OWN organization.
--
-- permissions.audience says who a permission can ever apply to, whatever role carries it:
--   any       everyone the role is granted to
--   staff     Arnobot users only; dropped for customer users when their grants are loaded
--   customer  customer users only; dropped for Arnobot users
-- So Manager / Viewer stay one role each (0016), but a customer Viewer holds less than an Arnobot Viewer.

ALTER TABLE permissions ADD COLUMN audience text NOT NULL DEFAULT 'staff' CHECK (audience IN ('any', 'staff', 'customer'));

INSERT INTO permissions (key, description, audience) VALUES
  ('robot.details', 'See a robot''s internal records and raw data: missions, events, videos, sensor history, hardware, software, connectivity, documents, dispatch, maintenance, ownership', 'staff'),
  ('user.invite',   'Invite and manage users of your own organization (Manager or Viewer, organization scope)', 'customer')
ON CONFLICT (key) DO NOTHING;

UPDATE permissions SET audience = 'any' WHERE key = 'robot.read';
UPDATE permissions SET description = 'See robots: overview, live status, day-wise reports and distance by day' WHERE key = 'robot.read';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r JOIN permissions p ON
     (r.key IN ('super_admin', 'manager', 'viewer') AND p.key = 'robot.details')
  OR (r.key = 'manager' AND p.key = 'user.invite')
ON CONFLICT DO NOTHING;
