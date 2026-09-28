-- 0001 · Extensions and shared trigger helpers.
-- Never edit this file after it has been applied; add a new numbered migration instead (CLAUDE.md rule 14).

CREATE EXTENSION IF NOT EXISTS pgcrypto;    -- gen_random_uuid(), digest()
CREATE EXTENSION IF NOT EXISTS citext;      -- case-insensitive e-mail
CREATE EXTENSION IF NOT EXISTS btree_gist;  -- exclusion constraints on (robot_id, time range)

-- Keeps updated_at honest on admin-editable tables.
CREATE OR REPLACE FUNCTION pms_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Rule 10: nothing is hard-deleted. Attached to every domain table.
-- A deliberate, instructed purge must first run: SET LOCAL pms.allow_hard_delete = 'on';
CREATE OR REPLACE FUNCTION pms_forbid_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('pms.allow_hard_delete', true), 'off') = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'hard delete is not allowed on %; set deleted_at instead', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END $$;

-- Rule 4: history is append-only.
CREATE OR REPLACE FUNCTION pms_forbid_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; UPDATE is not allowed', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END $$;

-- Append-only tables that allow a small, explicit set of columns to change
-- (e.g. event acknowledgement). TG_ARGV lists the columns that MAY change.
CREATE OR REPLACE FUNCTION pms_allow_update_only() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_j jsonb := to_jsonb(OLD);
  new_j jsonb := to_jsonb(NEW);
  col   text;
BEGIN
  FOREACH col IN ARRAY TG_ARGV LOOP
    old_j := old_j - col;
    new_j := new_j - col;
  END LOOP;
  IF old_j IS DISTINCT FROM new_j THEN
    RAISE EXCEPTION 'on %, only these columns may change: %', TG_TABLE_NAME, array_to_string(TG_ARGV, ', ')
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

-- Columns that must never change once written (e.g. robots.robot_id). TG_ARGV lists them.
CREATE OR REPLACE FUNCTION pms_immutable_columns() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  col text;
BEGIN
  FOREACH col IN ARRAY TG_ARGV LOOP
    IF (to_jsonb(OLD) -> col) IS DISTINCT FROM (to_jsonb(NEW) -> col) THEN
      RAISE EXCEPTION '%.% is permanent and cannot be changed', TG_TABLE_NAME, col
        USING ERRCODE = 'restrict_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
