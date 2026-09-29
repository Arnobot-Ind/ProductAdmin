-- 0019 · The robot's own odometer: total distance driven since it was built (lifetime, all driving), reported in
-- `live.odometer_m`. Separate from mission distance, which only counts driving inside missions (computed from missions).
ALTER TABLE live_state ADD COLUMN odometer_m double precision CHECK (odometer_m IS NULL OR odometer_m >= 0);
ALTER TABLE live_state ADD COLUMN odometer_ts timestamptz;
