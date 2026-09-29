-- 0018 · The recording archive also indexes GPS and wheel-encoder chunks written by cloud_sync:
--   sensors/gps/<YYYYMMDD_HHMMSS>.csv.gz       t_unix, src, fix, valid, sat, lat, lon, alt, quality, cog, sog, hdg, hdg_std, hdg_type
--   sensors/encoder/<YYYYMMDD_HHMMSS>.csv.gz   t_unix, m1..m4 (rpm), vx, vy, omega, valid, odo_m
ALTER TABLE archive_files DROP CONSTRAINT IF EXISTS archive_files_sensor_check;
ALTER TABLE archive_files ADD CONSTRAINT archive_files_sensor_check CHECK (sensor IS NULL OR sensor IN ('lidar', 'imu', 'gps', 'encoder'));
-- Files a re-index had filed as metadata before GPS / encoder were known become sensor chunks.
UPDATE archive_files SET kind = 'sensors', sensor = split_part(name, '/', 2)
WHERE kind = 'meta' AND name ~ '^sensors/(gps|encoder)/[^/]+\.csv(\.gz)?$';
