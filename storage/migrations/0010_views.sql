-- 0010 · Read views. Status and mission totals are COMPUTED, never stored (rule 8, spec §5).

-- Spec §7. Must agree with computeRobotStatus() in packages/message-schema/src/status.ts.
CREATE VIEW v_robot_status AS
SELECT r.robot_id,
       ls.last_seen_at,
       CASE
         WHEN ls.last_seen_at IS NULL                        THEN 'offline'
         WHEN now() - ls.last_seen_at <  interval '60 seconds' THEN 'online'
         WHEN now() - ls.last_seen_at <= interval '5 minutes'  THEN 'stale'
         ELSE 'offline'
       END AS status
FROM robots r
LEFT JOIN live_state ls ON ls.robot_id = r.robot_id;

-- Current owner = the open ownership row.
CREATE VIEW v_robot_current_owner AS
SELECT h.robot_id, h.company_id, c.name AS company_name, h.valid_from
FROM company_assignment_history h
JOIN companies c ON c.id = h.company_id
WHERE h.valid_to IS NULL;

-- Spec §5 view 1: totals calculated from missions rows.
CREATE VIEW v_robot_mission_summary AS
SELECT r.robot_id,
       count(m.mission_id)                                       AS total_missions,
       count(*) FILTER (WHERE m.result = 'completed')            AS completed,
       count(*) FILTER (WHERE m.result = 'failed')               AS failed,
       count(*) FILTER (WHERE m.result = 'aborted')              AS aborted,
       count(*) FILTER (WHERE m.result = 'in_progress')          AS in_progress,
       coalesce(sum(m.distance_m), 0)::double precision          AS total_distance_m,
       coalesce(sum(m.duration_s), 0)::bigint                    AS total_duration_s,
       avg(m.duration_s)::double precision                       AS avg_duration_s
FROM robots r
LEFT JOIN missions m ON m.robot_id = r.robot_id
GROUP BY r.robot_id;

-- Current software = latest software_history row.
CREATE VIEW v_robot_current_software AS
SELECT DISTINCT ON (robot_id) robot_id, sw_ver, fw_ver, enabled_features, reported_at
FROM software_history
ORDER BY robot_id, reported_at DESC, created_at DESC;
