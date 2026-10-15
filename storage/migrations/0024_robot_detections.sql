-- 0024 · Detections sent by the robot itself (fleetSync `detection` message + snapshot upload, user decision
-- 2026-10-15: ProductAdmin is the one PMS; the GCS monorepo's own 0020_detections is not used).
--
-- fleetSync names each detection by the GCS row id (detection_id). Imported rows (0022) carry the same id, so a
-- message for a detection already imported is a no-op. The annotated JPEG follows separately and is stored in the
-- archive bucket at <robot_id>/detections/<YYYY-MM-DD>/<detection_id>.jpg.

ALTER TABLE detections
  ADD COLUMN detection_id      text,
  ADD COLUMN msg_id            uuid UNIQUE,
  ADD COLUMN image_sha256      text CHECK (image_sha256 IS NULL OR image_sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN image_size_bytes  integer CHECK (image_size_bytes IS NULL OR image_size_bytes >= 0),
  ADD COLUMN image_uploaded_at timestamptz,
  ADD COLUMN data              jsonb;

UPDATE detections SET detection_id = id::text WHERE detection_id IS NULL;
ALTER TABLE detections ALTER COLUMN detection_id SET NOT NULL,
  ADD CONSTRAINT detections_detection_id_check CHECK (length(detection_id) BETWEEN 1 AND 100);
CREATE UNIQUE INDEX detections_robot_detection_uq ON detections (robot_id, detection_id);
