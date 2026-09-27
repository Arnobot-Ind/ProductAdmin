-- 0008 · Sensor data (spec §3 row 11). Append-only time series.
--
-- Designed to run on plain PostgreSQL AND on TimescaleDB:
--   * queries use native date_bin() (PG14+) for downsampling, not time_bucket();
--   * every table has a UNIQUE index that includes `ts` (Timescale requirement) which is also the
--     backstop against duplicate samples (ON CONFLICT DO NOTHING);
--   * pms_enable_timescale() converts the tables to hypertables when the extension is available,
--     now or later (`npm run db:timescale`). No drop/retention policies, ever (rule 10).

CREATE TABLE telemetry_gps (
  robot_id     text NOT NULL REFERENCES robots(robot_id),
  ts           timestamptz NOT NULL,
  lat          double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon          double precision NOT NULL CHECK (lon BETWEEN -180 AND 180),
  alt_m        real,
  speed_mps    real,
  heading_deg  real,
  fix_quality  text,
  msg_id       uuid NOT NULL
);
CREATE UNIQUE INDEX telemetry_gps_uq ON telemetry_gps (robot_id, ts);

CREATE TABLE telemetry_encoder (
  robot_id      text NOT NULL REFERENCES robots(robot_id),
  ts            timestamptz NOT NULL,
  encoder       text NOT NULL,             -- 'left', 'right', 'm1' …
  ticks         bigint,
  velocity_mps  real,
  rpm           real,
  msg_id        uuid NOT NULL
);
CREATE UNIQUE INDEX telemetry_encoder_uq ON telemetry_encoder (robot_id, encoder, ts);

CREATE TABLE telemetry_battery (
  robot_id   text NOT NULL REFERENCES robots(robot_id),
  ts         timestamptz NOT NULL,
  pct        real,
  voltage_v  real,
  current_a  real,
  temp_c     real,
  msg_id     uuid NOT NULL
);
CREATE UNIQUE INDEX telemetry_battery_uq ON telemetry_battery (robot_id, ts);

CREATE TABLE telemetry_health (
  robot_id           text NOT NULL REFERENCES robots(robot_id),
  ts                 timestamptz NOT NULL,
  health_controller  text CHECK (health_controller IN ('ok', 'warning', 'fault')),
  health_lidar       text CHECK (health_lidar      IN ('ok', 'warning', 'fault')),
  health_cameras     text CHECK (health_cameras    IN ('ok', 'warning', 'fault')),
  health_gps         text CHECK (health_gps        IN ('ok', 'warning', 'fault')),
  temp_controller_c  real,
  temp_battery_c     real,
  temp_motors_c      jsonb,
  msg_id             uuid NOT NULL
);
CREATE UNIQUE INDEX telemetry_health_uq ON telemetry_health (robot_id, ts);

-- Plain-PostgreSQL fast path for large time-range scans (tiny, append-ordered data).
CREATE INDEX telemetry_gps_ts_brin     ON telemetry_gps     USING brin (ts);
CREATE INDEX telemetry_encoder_ts_brin ON telemetry_encoder USING brin (ts);
CREATE INDEX telemetry_battery_ts_brin ON telemetry_battery USING brin (ts);
CREATE INDEX telemetry_health_ts_brin  ON telemetry_health  USING brin (ts);

CREATE TRIGGER telemetry_gps_no_update     BEFORE UPDATE ON telemetry_gps     FOR EACH ROW EXECUTE FUNCTION pms_forbid_update();
CREATE TRIGGER telemetry_encoder_no_update BEFORE UPDATE ON telemetry_encoder FOR EACH ROW EXECUTE FUNCTION pms_forbid_update();
CREATE TRIGGER telemetry_battery_no_update BEFORE UPDATE ON telemetry_battery FOR EACH ROW EXECUTE FUNCTION pms_forbid_update();
CREATE TRIGGER telemetry_health_no_update  BEFORE UPDATE ON telemetry_health  FOR EACH ROW EXECUTE FUNCTION pms_forbid_update();
CREATE TRIGGER telemetry_gps_no_delete     BEFORE DELETE ON telemetry_gps     FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();
CREATE TRIGGER telemetry_encoder_no_delete BEFORE DELETE ON telemetry_encoder FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();
CREATE TRIGGER telemetry_battery_no_delete BEFORE DELETE ON telemetry_battery FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();
CREATE TRIGGER telemetry_health_no_delete  BEFORE DELETE ON telemetry_health  FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();

-- Converts the telemetry tables to hypertables if TimescaleDB is installed. Safe to call repeatedly.
-- Returns a human-readable status. Compression after 30 days is allowed; retention is NOT (keep everything).
CREATE OR REPLACE FUNCTION pms_enable_timescale() RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb') THEN
    RETURN 'timescaledb not installed: telemetry stays in plain PostgreSQL tables';
  END IF;
  BEGIN
    CREATE EXTENSION IF NOT EXISTS timescaledb;
  EXCEPTION WHEN OTHERS THEN
    RETURN 'timescaledb present but could not be loaded (' || SQLERRM || '); add it to shared_preload_libraries';
  END;
  FOREACH t IN ARRAY ARRAY['telemetry_gps', 'telemetry_encoder', 'telemetry_battery', 'telemetry_health'] LOOP
    EXECUTE format(
      'SELECT create_hypertable(%L, by_range(''ts'', INTERVAL ''7 days''), if_not_exists => true, migrate_data => true)', t);
    BEGIN
      EXECUTE format('ALTER TABLE %I SET (timescaledb.compress, timescaledb.compress_segmentby = ''robot_id'')', t);
      EXECUTE format('SELECT add_compression_policy(%L, INTERVAL ''30 days'', if_not_exists => true)', t);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'compression not enabled on %: %', t, SQLERRM;
    END;
  END LOOP;
  RETURN 'telemetry tables are TimescaleDB hypertables (7-day chunks, compression after 30 days, no retention)';
END $$;

DO $$ BEGIN RAISE NOTICE '%', pms_enable_timescale(); END $$;
