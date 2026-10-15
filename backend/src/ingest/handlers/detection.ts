import type { DetectionMessage } from '../../shared';
import type { PoolClient } from 'pg';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** detections.camera allows [a-z0-9_]{1,32}: 'Cam 1' → 'cam_1', nothing → 'unknown'. */
function cameraOf(camera: string | undefined): string {
  const c = (camera ?? '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
  return c || 'unknown';
}

/**
 * detection (0024): one row per robot detection id. fleetSync names each detection by its GCS row id, which is also
 * the id of a detection imported from the GCS dump (import:detections), so a message for an imported detection, or a
 * resend under a new msg_id, hits an existing row and is a no-op: a detection is never counted twice.
 */
export async function handleDetection(tx: PoolClient, msg: DetectionMessage): Promise<void> {
  const p = msg.payload;
  const id = UUID_RE.test(p.detection_id) ? p.detection_id.toLowerCase() : null;
  await tx.query(
    `INSERT INTO detections (id, detection_id, msg_id, robot_id, detected_at, kind, label, labels, camera, count, confidence,
                             lat, lon, bearing_deg, mission_id, mission_name, data, status, source)
     VALUES (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, 'confirmed', 'robot')
     ON CONFLICT DO NOTHING`,
    [
      id,
      p.detection_id,
      msg.msg_id,
      msg.robot_id,
      p.detected_at,
      p.kind,
      p.kind === 'human' ? null : (p.label ?? null),
      p.labels ? JSON.stringify(p.labels) : null,
      cameraOf(p.camera),
      p.count ?? 1,
      p.confidence ?? null,
      p.lat ?? null,
      p.lon ?? null,
      p.bearing_deg ?? null,
      p.mission_id ?? null,
      p.mission_name ?? null,
      p.data ? JSON.stringify(p.data) : null,
    ],
  );
}
