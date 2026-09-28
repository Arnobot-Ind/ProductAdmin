import type { GcsMissionReport, MissionFileRef, MissionMessage } from '@arnobot/message-schema';
import type { PoolClient } from 'pg';
import { notifyChange } from '../notify';

export class MissionConflictError extends Error {
  readonly code = 'mission_robot_mismatch';
}

/** A mission id always belongs to one robot (spec §5). Refuse a message that tries to re-home it. */
async function assertMissionRobot(tx: PoolClient, missionId: string, robotId: string): Promise<void> {
  const row = (await tx.query<{ robot_id: string }>('SELECT robot_id FROM missions WHERE mission_id = $1 FOR UPDATE', [missionId])).rows[0];
  if (row && row.robot_id !== robotId) {
    throw new MissionConflictError(`mission ${missionId} belongs to ${row.robot_id}, not ${robotId}`);
  }
}

async function insertFiles(tx: PoolClient, missionId: string, files: MissionFileRef[] | undefined, source: 'robot' | 'gcs'): Promise<void> {
  for (const f of files ?? []) {
    await tx.query(
      `INSERT INTO mission_files (mission_id, kind, s3_path, size_bytes, sha256, content_type, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (mission_id, s3_path) DO NOTHING`,
      [missionId, f.kind, f.s3_path, f.size_bytes ?? null, f.sha256?.toLowerCase() ?? null, f.content_type ?? null, source],
    );
  }
}

/**
 * mission (robot, at start and end). Whichever of robot-start, robot-end or GCS report arrives first
 * creates the row; later ones fill in gaps. The robot is authoritative for the ACTUAL path, distance
 * driven and result; the GCS for the PLANNED path.
 */
export async function handleMission(tx: PoolClient, msg: MissionMessage): Promise<void> {
  const p = msg.payload;
  await assertMissionRobot(tx, p.mission_id, msg.robot_id);

  if (p.phase === 'start') {
    await tx.query(
      `INSERT INTO missions (mission_id, robot_id, name, started_at, start_msg_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (mission_id) DO UPDATE SET
         name         = coalesce(missions.name, excluded.name),
         started_at   = coalesce(missions.started_at, excluded.started_at),
         start_msg_id = coalesce(missions.start_msg_id, excluded.start_msg_id)`,
      [p.mission_id, msg.robot_id, p.name ?? null, p.started_at ?? msg.ts, msg.msg_id],
    );
  } else {
    await tx.query(
      `INSERT INTO missions (mission_id, robot_id, name, started_at, ended_at, distance_m, result, end_reason, actual_path, end_msg_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (mission_id) DO UPDATE SET
         name        = coalesce(missions.name, excluded.name),
         started_at  = coalesce(missions.started_at, excluded.started_at),
         ended_at    = excluded.ended_at,
         distance_m  = coalesce(excluded.distance_m, missions.distance_m),
         result      = excluded.result,
         end_reason  = coalesce(excluded.end_reason, missions.end_reason),
         actual_path = coalesce(excluded.actual_path, missions.actual_path),
         end_msg_id  = excluded.end_msg_id`,
      [
        p.mission_id,
        msg.robot_id,
        p.name ?? null,
        p.started_at ?? null,
        p.ended_at ?? msg.ts,
        p.distance_m ?? null,
        p.result,
        p.end_reason ?? null,
        p.actual_path ? JSON.stringify(p.actual_path) : null,
        msg.msg_id,
      ],
    );
    await insertFiles(tx, p.mission_id, p.files, 'robot');
  }
  await notifyChange(tx, { kind: 'mission', robot_id: msg.robot_id, mission_id: p.mission_id });
}

/**
 * GCS → PMS mission report (spec §5: "After the mission is finished, the GCS sends the completed
 * mission report"). Idempotent: re-sending the same report re-merges to the same state.
 */
export async function mergeGcsReport(tx: PoolClient, missionId: string, report: GcsMissionReport, raw: unknown): Promise<'created' | 'merged'> {
  await assertMissionRobot(tx, missionId, report.robot_id);
  const res = await tx.query<{ inserted: boolean }>(
    `INSERT INTO missions (mission_id, robot_id, external_id, name, started_at, ended_at, distance_m, distance_planned_m,
                           result, end_reason, planned_path, actual_path, waypoints_total, waypoints_reached,
                           gcs_report, gcs_report_received_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9, 'in_progress'), $10, $11, $12, $13, $14, $15, now())
     ON CONFLICT (mission_id) DO UPDATE SET
       external_id            = coalesce(missions.external_id, excluded.external_id),
       name                   = coalesce(missions.name, excluded.name),
       started_at             = coalesce(missions.started_at, excluded.started_at),
       ended_at               = coalesce(missions.ended_at, excluded.ended_at),
       distance_m             = coalesce(missions.distance_m, excluded.distance_m),       -- robot odometry wins
       distance_planned_m     = coalesce(excluded.distance_planned_m, missions.distance_planned_m),
       result                 = CASE WHEN missions.result = 'in_progress' THEN excluded.result ELSE missions.result END,
       end_reason             = coalesce(missions.end_reason, excluded.end_reason),
       planned_path           = coalesce(excluded.planned_path, missions.planned_path),   -- GCS plan wins
       actual_path            = coalesce(missions.actual_path, excluded.actual_path),     -- robot track wins
       waypoints_total        = coalesce(excluded.waypoints_total, missions.waypoints_total),
       waypoints_reached      = coalesce(excluded.waypoints_reached, missions.waypoints_reached),
       gcs_report             = excluded.gcs_report,
       gcs_report_received_at = excluded.gcs_report_received_at
     RETURNING (xmax = 0) AS inserted`,
    [
      missionId,
      report.robot_id,
      typeof (report as Record<string, unknown>).external_id === 'string' ? (report as Record<string, unknown>).external_id : null,
      report.name ?? null,
      report.started_at ?? null,
      report.ended_at ?? null,
      report.distance_m ?? null,
      report.distance_planned_m ?? null,
      report.result ?? null,
      report.end_reason ?? null,
      report.planned_path ? JSON.stringify(report.planned_path) : null,
      report.actual_path ? JSON.stringify(report.actual_path) : null,
      report.waypoints_total ?? null,
      report.waypoints_reached ?? null,
      JSON.stringify(raw),
    ],
  );
  await insertFiles(tx, missionId, report.files, 'gcs');
  await notifyChange(tx, { kind: 'mission', robot_id: report.robot_id, mission_id: missionId });
  return res.rows[0]?.inserted ? 'created' : 'merged';
}
