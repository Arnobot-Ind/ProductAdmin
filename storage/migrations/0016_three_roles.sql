-- 0016 · Three roles: Admin, Manager, Viewer (user decision, 2026-09-29).
--
--   Admin    (key super_admin) Arnobot only. Everything: organizations, users, audit, robot setup, LiDAR / IMU.
--   Manager  (key manager)     Arnobot or customer. View robots and video; download video + metadata;
--                              control robots; acknowledge events. No LiDAR / IMU.
--   Viewer   (key viewer)      Arnobot or customer. View robots and video; download video + metadata. No LiDAR / IMU.
--
-- LiDAR / IMU (previews AND raw files) become Admin-only: new permission data.sensors; customers never see them.
-- Retired: admin, engineer, org_manager, org_operator, org_viewer (only removed when no grant references them).

ALTER TABLE roles DROP CONSTRAINT IF EXISTS roles_audience_check;
ALTER TABLE roles ADD CONSTRAINT roles_audience_check CHECK (audience IN ('staff', 'customer', 'any'));

INSERT INTO permissions (key, description) VALUES
  ('data.sensors', 'See LiDAR and IMU data of recordings (scan viewer, charts)')
ON CONFLICT (key) DO NOTHING;
UPDATE permissions SET description = 'View robots and their data: live state, telemetry, missions, events, recordings (video playback)' WHERE key = 'robot.read';
UPDATE permissions SET description = 'Download raw LiDAR (.npz) and IMU (.csv.gz) files' WHERE key = 'data.download_restricted';

-- Retire the old roles (their permissions first; a role still named in a grant is kept, only emptied).
DELETE FROM role_permissions rp USING roles r
WHERE rp.role_id = r.id AND r.key IN ('admin', 'engineer', 'org_manager', 'org_operator', 'org_viewer', 'viewer');
DELETE FROM roles r
WHERE r.key IN ('admin', 'engineer', 'org_manager', 'org_operator', 'org_viewer')
  AND NOT EXISTS (SELECT 1 FROM role_grants g WHERE g.role_id = r.id);

UPDATE roles SET name = 'Admin', audience = 'staff', sort_order = 10,
       description = 'Arnobot. Everything: organizations, users, audit log, robot setup, LiDAR / IMU data, deleting recordings'
WHERE key = 'super_admin';
UPDATE roles SET name = 'Viewer', audience = 'any', sort_order = 30,
       description = 'Views robots and their recordings (video) and downloads video and metadata. No LiDAR / IMU'
WHERE key = 'viewer';
INSERT INTO roles (key, name, description, audience, sort_order) VALUES
  ('manager', 'Manager', 'Everything a Viewer can, plus controlling robots and acknowledging events. No LiDAR / IMU', 'any', 20)
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON
     r.key = 'super_admin'
  OR (r.key = 'manager' AND p.key IN ('robot.read', 'data.download', 'robot.control', 'event.ack'))
  OR (r.key = 'viewer'  AND p.key IN ('robot.read', 'data.download'))
ON CONFLICT DO NOTHING;
