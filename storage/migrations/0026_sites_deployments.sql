-- 0026 · Sites and deployments: where each robot works.
-- 0002 created `sites` (a place that belongs to an organization) and 0004 `site_assignment_history` (a robot's
-- placement at a site, same from/to history as ownership), both unused until now. They become the deployment
-- record: a site gets its address, map position and contact person; a placement gets what the robot does there
-- and why it left. Site-scoped grants (permissions.service) already follow the current placement.

ALTER TABLE sites
  ADD COLUMN address        text,
  ADD COLUMN city           text,
  ADD COLUMN state          text,
  ADD COLUMN country        text,
  ADD COLUMN latitude       double precision CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  ADD COLUMN longitude      double precision CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
  ADD COLUMN contact_name   text,              -- the person on site
  ADD COLUMN contact_phone  text,
  ADD COLUMN contact_email  text,
  ADD COLUMN notes          text,
  ADD CONSTRAINT sites_name_check CHECK (length(trim(name)) BETWEEN 1 AND 120),
  ADD CONSTRAINT sites_position_check CHECK ((latitude IS NULL) = (longitude IS NULL));
CREATE UNIQUE INDEX sites_name_uq ON sites (lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX sites_company_idx ON sites (company_id) WHERE deleted_at IS NULL;

ALTER TABLE site_assignment_history
  ADD COLUMN purpose   text,                   -- what it does there (night patrol, panel cleaning …)
  ADD COLUMN notes     text,
  ADD COLUMN ended_by  uuid REFERENCES users(id),
  ADD COLUMN end_note  text;                   -- why it left
CREATE INDEX sah_robot_idx ON site_assignment_history (robot_id, valid_from DESC);
CREATE INDEX sah_site_idx ON site_assignment_history (site_id, valid_from DESC);
-- Only ending a placement changes a row (with who ended it and why); a correction is a new placement.
DROP TRIGGER sah_close_only ON site_assignment_history;
CREATE TRIGGER sah_close_only BEFORE UPDATE ON site_assignment_history
  FOR EACH ROW EXECUTE FUNCTION pms_allow_update_only('valid_to', 'ended_by', 'end_note');
