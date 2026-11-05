-- 0031: which commit a robot's software came from, recorded from the panel (robots report versions only).
ALTER TABLE software_history
  ADD COLUMN commit_id text CHECK (commit_id IS NULL OR commit_id ~* '^[0-9a-f]{7,64}$');
