-- 0011 · Reference data every environment needs. Idempotent. More rows are added later as data (rule 15).

INSERT INTO companies (name) SELECT 'Arnobot'
WHERE NOT EXISTS (SELECT 1 FROM companies WHERE lower(name) = 'arnobot');

INSERT INTO products (code, name, description) VALUES
  ('saibya',        'Saibya',        'Arnobot Saibya UGV'),
  ('altius',        'Altius',        'Arnobot Altius'),
  ('nexus',         'NEXUS',         'Arnobot NEXUS'),
  ('atm',           'ATM',           'Arnobot ATM'),
  ('duct_cleaning', 'Duct Cleaning', 'Arnobot duct cleaning robot')
ON CONFLICT (code) DO NOTHING;

-- spec §3 row 3: GPS module, Encoder, IMU, LiDAR, Cameras 1–4, Controller
INSERT INTO part_types (key, name, max_per_robot) VALUES
  ('gps',        'GPS module',  1),
  ('encoder',    'Encoder',     NULL),
  ('imu',        'IMU',         1),
  ('lidar',      'LiDAR',       1),
  ('camera',     'Camera',      4),
  ('controller', 'Controller',  1)
ON CONFLICT (key) DO NOTHING;

INSERT INTO permissions (key, description) VALUES
  ('robot.read',           'View robots and everything recorded about them (live, telemetry, missions, events, hardware, documents …)'),
  ('robot.write',          'Register robots; edit identity, connectivity, cameras, dispatch & warranty'),
  ('robot.delete',         'Soft-delete and restore robots'),
  ('ownership.write',      'Transfer robot ownership between companies'),
  ('hardware.write',       'Fit and remove hardware parts'),
  ('maintenance.write',    'Record and edit repairs'),
  ('document.write',       'Create documents and upload new versions'),
  ('event.ack',            'Acknowledge events'),
  ('credential.read_meta', 'See which credentials exist (never the secret)'),
  ('credential.reveal',    'Reveal a decrypted credential'),
  ('credential.write',     'Create, rotate and revoke credentials'),
  ('ingest.read',          'View the ingest log and rejected messages'),
  ('ingest.manage',        'Create and revoke ingest clients and keys for robots / GCS'),
  ('catalog.read',         'View products, revisions, part types and releases'),
  ('catalog.write',        'Edit products, revisions and part types'),
  ('release.write',        'Register software / firmware releases'),
  ('user.manage',          'Manage users and role grants')
ON CONFLICT (key) DO NOTHING;

INSERT INTO roles (key, name, description) VALUES
  ('super_admin', 'Super admin', 'Everything, including user management'),
  ('admin',       'Admin',       'Everything except user management'),
  ('engineer',    'Engineer',    'Read everything; maintain hardware, repairs, documents; acknowledge events. No credential reveal.'),
  ('viewer',      'Viewer',      'Read only')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON
     r.key = 'super_admin'
  OR (r.key = 'admin'    AND p.key <> 'user.manage')
  OR (r.key = 'engineer' AND p.key IN ('robot.read', 'hardware.write', 'maintenance.write', 'document.write',
                                       'event.ack', 'credential.read_meta', 'ingest.read', 'catalog.read'))
  OR (r.key = 'viewer'   AND p.key IN ('robot.read', 'catalog.read'))
ON CONFLICT DO NOTHING;
