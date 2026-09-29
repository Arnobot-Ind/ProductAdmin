-- 0017 · Hardware: product URL per part + corrections from the panel. Software: updates recorded from the panel.

-- A link to the part's product page / datasheet (e.g. the u-blox M9N page).
ALTER TABLE hardware_fitted
  ADD COLUMN product_url text CHECK (product_url IS NULL OR product_url ~* '^https?://[^\s/@]+(/\S*)?$'),
  ADD COLUMN updated_at  timestamptz,
  ADD COLUMN updated_by  uuid REFERENCES users(id);

-- Corrections (typo in model / serial, missing link, wrong fitted date) are allowed; the part type and slot are
-- not: a different part is a remove + fit, so the history stays true.
DROP TRIGGER hardware_fitted_close_only ON hardware_fitted;
CREATE TRIGGER hardware_fitted_close_only BEFORE UPDATE ON hardware_fitted
  FOR EACH ROW EXECUTE FUNCTION pms_allow_update_only(
    'removed_at', 'removal_reason', 'removed_maintenance_id', 'notes',
    'model', 'serial_number', 'product_url', 'fitted_at', 'updated_at', 'updated_by');

-- Software rows come from the robot's boot report ('robot') or are entered by an admin ('manual').
ALTER TABLE software_history
  ADD COLUMN source     text NOT NULL DEFAULT 'robot' CHECK (source IN ('robot', 'manual')),
  ADD COLUMN entered_by uuid REFERENCES users(id),
  ADD COLUMN note       text;
