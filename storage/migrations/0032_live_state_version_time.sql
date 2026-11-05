-- 0032: when a robot last sent its software version. live_state keeps the last version it sent, and robots may stop
-- sending one, so without this time an old report cannot be told from what the robot says today.
ALTER TABLE live_state ADD COLUMN sw_ver_at timestamptz;

UPDATE live_state ls
SET sw_ver_at = (SELECT max(im.ts) FROM ingested_messages im WHERE im.robot_id = ls.robot_id AND im.raw->>'sw_ver' = ls.sw_ver)
WHERE ls.sw_ver IS NOT NULL;
