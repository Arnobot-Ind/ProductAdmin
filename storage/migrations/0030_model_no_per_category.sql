-- 0030: base model numbers count separately per category.
--
-- UGV and UAV are different families, so each numbers its base models from 001: UGV 1-001…, UAV 2-001….
-- (0028 numbered all base models in one series, which made the first UAV model 2-006.) Attachments fit
-- both families and keep their one shared series.
--
-- Base models are renumbered within their category, in the order of their current numbers (deleted ones
-- included: a number is never given out twice). Robots of a renumbered base model get the new model number
-- in their serial; the rest of the serial (attachment, running number, random digits) stays the same, and the
-- serial they had is kept in robot_previous_ids, so anything that still uses it keeps working.

-- ── 1. Model numbers per category ──
ALTER TABLE products ALTER COLUMN model_no DROP DEFAULT;
DROP SEQUENCE products_model_no_seq;
ALTER TABLE products DROP CONSTRAINT products_model_no_uq;
DROP TRIGGER products_model_no_permanent ON products;

CREATE TEMP TABLE model_renumber ON COMMIT DROP AS
  SELECT id, category, model_no AS old_no,
         row_number() OVER (PARTITION BY category ORDER BY model_no)::smallint AS new_no
  FROM products;

ALTER TABLE products DISABLE TRIGGER USER;
UPDATE products p SET model_no = m.new_no FROM model_renumber m WHERE m.id = p.id AND p.model_no <> m.new_no;
ALTER TABLE products ENABLE TRIGGER USER;

ALTER TABLE products ADD CONSTRAINT products_model_no_uq UNIQUE (category, model_no);

-- The next number of each category (counts up only).
CREATE TABLE product_model_counters (
  category text PRIMARY KEY,
  next_no  smallint NOT NULL CHECK (next_no BETWEEN 1 AND 1000)
);
INSERT INTO product_model_counters (category, next_no)
  SELECT c, coalesce((SELECT max(model_no) FROM products WHERE category = c), 0) + 1 FROM unnest(ARRAY['ugv', 'uav']) AS c;

-- A new base model gets its category's next number. Its number is permanent; the only change is when its
-- category changes (allowed only while no robot is registered on it): it then takes the next number there.
CREATE FUNCTION pms_product_model_no() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.category IS NOT DISTINCT FROM OLD.category THEN
      IF NEW.model_no IS DISTINCT FROM OLD.model_no THEN
        RAISE EXCEPTION 'products.model_no is permanent and cannot be changed' USING ERRCODE = 'restrict_violation';
      END IF;
      RETURN NEW;
    END IF;
  END IF;
  INSERT INTO product_model_counters (category, next_no) VALUES (NEW.category, 1) ON CONFLICT (category) DO NOTHING;
  UPDATE product_model_counters SET next_no = next_no + 1 WHERE category = NEW.category RETURNING next_no - 1 INTO NEW.model_no;
  IF NEW.model_no > 999 THEN
    RAISE EXCEPTION 'no base model numbers left for %', NEW.category USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END $$;
-- Named to run after products_category_locked (triggers run in name order), which refuses a category change
-- once robots exist.
CREATE TRIGGER products_model_no BEFORE INSERT OR UPDATE OF category, model_no ON products
  FOR EACH ROW EXECUTE FUNCTION pms_product_model_no();

-- ── 2. Robots of renumbered base models: the model part of their serial follows ──
CREATE TEMP TABLE robot_renumber ON COMMIT DROP AS
  SELECT r.robot_id AS old_id,
         substr(r.robot_id, 1, 1) || lpad(m.new_no::text, 3, '0') || substr(r.robot_id, 5) AS new_id
  FROM robots r JOIN model_renumber m ON m.id = r.product_id
  WHERE m.new_no <> m.old_no;

DO $$
DECLARE
  fk   record;
  t    text;
  tbls text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM robot_renumber) THEN
    RETURN;
  END IF;
  -- Links to robots are dropped while the key changes, then added back exactly as they were.
  CREATE TEMP TABLE robot_fk_defs ON COMMIT DROP AS
    SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def
    FROM pg_constraint WHERE confrelid = 'robots'::regclass AND contype = 'f';
  FOR fk IN SELECT * FROM robot_fk_defs LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', fk.tbl, fk.conname);
  END LOOP;

  -- History tables refuse updates (append-only rules): those rules pause for the renumbering only.
  tbls := ARRAY(SELECT DISTINCT tbl FROM robot_fk_defs) || ARRAY['robots', 'audit_log', 'ingest_rejections', 'role_grants', 'ingest_clients'];
  FOREACH t IN ARRAY tbls LOOP
    EXECUTE format('ALTER TABLE %s DISABLE TRIGGER USER', t);
  END LOOP;

  FOR t IN SELECT DISTINCT tbl FROM robot_fk_defs LOOP
    EXECUTE format('UPDATE %s x SET robot_id = m.new_id FROM robot_renumber m WHERE x.robot_id = m.old_id', t);
  END LOOP;
  UPDATE robots x SET robot_id = m.new_id, serial_number = m.new_id FROM robot_renumber m WHERE x.robot_id = m.old_id;
  UPDATE audit_log x SET robot_id = m.new_id FROM robot_renumber m WHERE x.robot_id = m.old_id;
  UPDATE audit_log x SET target_id = m.new_id FROM robot_renumber m WHERE x.target_type = 'robot' AND x.target_id = m.old_id;
  UPDATE ingest_rejections x SET robot_id = m.new_id FROM robot_renumber m WHERE x.robot_id = m.old_id;
  UPDATE role_grants x SET scope_id = m.new_id FROM robot_renumber m WHERE x.scope_type = 'robot' AND x.scope_id = m.old_id;
  -- "2-006-000-0001-90 (robot)" → "2-001-000-0001-90 (robot)": the robot's own ingest client follows.
  UPDATE ingest_clients x
    SET name = replace(x.name, regexp_replace(m.old_id, '^(.)(...)(...)(....)(..)$', '\1-\2-\3-\4-\5'),
                               regexp_replace(m.new_id, '^(.)(...)(...)(....)(..)$', '\1-\2-\3-\4-\5'))
    FROM robot_renumber m WHERE x.name LIKE regexp_replace(m.old_id, '^(.)(...)(...)(....)(..)$', '\1-\2-\3-\4-\5') || ' %';

  FOREACH t IN ARRAY tbls LOOP
    EXECUTE format('ALTER TABLE %s ENABLE TRIGGER USER', t);
  END LOOP;
  FOR fk IN SELECT * FROM robot_fk_defs LOOP
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', fk.tbl, fk.conname, fk.def);
  END LOOP;
END $$;

INSERT INTO robot_previous_ids (previous_id, robot_id, kind)
  SELECT old_id, new_id, 'serial' FROM robot_renumber;
