-- 0028 · The serial number becomes each robot's identity and replaces the Robot ID ('saibya02').
--
-- Serial number: 13 digits, shown as 1-005-000-0001-47
--   1      category            1 = UGV, 2 = UAV
--   005    base model number   products.model_no (automatic, permanent, never reused)
--   000    main attachment     attachments.attachment_no of the attachment the robot was built with; 000 = none
--   0001   running number of that combination (category + base model + attachment), never reused
--   47     random
-- The serial records how the robot was built: it never changes, even if attachments are swapped later (their
-- history is in robot_attachments). The column robots.robot_id keeps its name but now holds the serial, so every
-- table that points to a robot is renumbered here. The old Robot IDs and old 8-digit serials are kept in
-- robot_previous_ids: robots, the GCS and stored recordings that still use them are recognised.

-- ── 1. Base model and attachment numbers: automatic, not editable, never reused ──
CREATE SEQUENCE products_model_no_seq MINVALUE 1 MAXVALUE 999;
ALTER TABLE products ADD COLUMN model_no smallint;
WITH n AS (SELECT id, row_number() OVER (ORDER BY created_at, name) AS no FROM products)
UPDATE products p SET model_no = n.no FROM n WHERE n.id = p.id;
SELECT setval('products_model_no_seq', coalesce((SELECT max(model_no) FROM products), 0) + 1, false);
ALTER TABLE products
  ALTER COLUMN model_no SET DEFAULT nextval('products_model_no_seq'),
  ALTER COLUMN model_no SET NOT NULL,
  ADD CONSTRAINT products_model_no_range CHECK (model_no BETWEEN 1 AND 999),
  ADD CONSTRAINT products_model_no_uq UNIQUE (model_no);
ALTER SEQUENCE products_model_no_seq OWNED BY products.model_no;
CREATE TRIGGER products_model_no_permanent BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION pms_immutable_columns('model_no');

CREATE SEQUENCE attachments_attachment_no_seq MINVALUE 1 MAXVALUE 999;
ALTER TABLE attachments ADD COLUMN attachment_no smallint;
WITH n AS (SELECT id, row_number() OVER (ORDER BY created_at, name) AS no FROM attachments)
UPDATE attachments a SET attachment_no = n.no FROM n WHERE n.id = a.id;
SELECT setval('attachments_attachment_no_seq', coalesce((SELECT max(attachment_no) FROM attachments), 0) + 1, false);
ALTER TABLE attachments
  ALTER COLUMN attachment_no SET DEFAULT nextval('attachments_attachment_no_seq'),
  ALTER COLUMN attachment_no SET NOT NULL,
  ADD CONSTRAINT attachments_attachment_no_range CHECK (attachment_no BETWEEN 1 AND 999),
  ADD CONSTRAINT attachments_attachment_no_uq UNIQUE (attachment_no);
ALTER SEQUENCE attachments_attachment_no_seq OWNED BY attachments.attachment_no;
CREATE TRIGGER attachments_no_permanent BEFORE UPDATE ON attachments FOR EACH ROW EXECUTE FUNCTION pms_immutable_columns('attachment_no');

-- The category is the serial's first digit: it cannot change once a robot is registered on the base model.
CREATE OR REPLACE FUNCTION pms_product_category_locked() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.category IS DISTINCT FROM OLD.category AND EXISTS (SELECT 1 FROM robots r WHERE r.product_id = OLD.id) THEN
    RAISE EXCEPTION 'the category of % cannot change: robots are registered on it and their serial numbers start with it', OLD.name
      USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER products_category_locked BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION pms_product_category_locked();

-- ── 2. The attachment a robot was built with (part of its serial; recorded once) ──
ALTER TABLE robots ADD COLUMN main_attachment_id uuid REFERENCES attachments(id);
-- Robots registered before this migration: the first attachment ever fitted on them, if any.
UPDATE robots r SET main_attachment_id = (
  SELECT ra.attachment_id FROM robot_attachments ra WHERE ra.robot_id = r.robot_id ORDER BY ra.fitted_at, ra.id LIMIT 1);

-- ── 3. Serial generator: used by registration (server) and the seed alike ──
CREATE OR REPLACE FUNCTION pms_new_robot_serial(p_product_id uuid, p_attachment_id uuid) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  prefix text;
  att    text;
  seq    integer;
BEGIN
  -- Row lock on the base model: concurrent registrations get consecutive running numbers.
  SELECT CASE p.category WHEN 'uav' THEN '2' ELSE '1' END || lpad(p.model_no::text, 3, '0') INTO prefix
    FROM products p WHERE p.id = p_product_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'base model not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_attachment_id IS NULL THEN
    att := '000';
  ELSE
    SELECT lpad(a.attachment_no::text, 3, '0') INTO att FROM attachments a WHERE a.id = p_attachment_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'attachment not found' USING ERRCODE = 'P0002';
    END IF;
  END IF;
  prefix := prefix || att;
  -- Deleted robots stay in the table, so a running number is never reused.
  SELECT coalesce(max(substr(r.robot_id, 8, 4)::integer), 0) + 1 INTO seq FROM robots r WHERE r.robot_id ~ ('^' || prefix || '[0-9]{6}$');
  IF seq > 9999 THEN
    RAISE EXCEPTION 'no running numbers left for this base model and attachment' USING ERRCODE = '22023';
  END IF;
  RETURN prefix || lpad(seq::text, 4, '0') || lpad(floor(random() * 100)::integer::text, 2, '0');
END $$;

-- ── 4. Old identifiers stay findable ──
CREATE TABLE robot_previous_ids (
  previous_id  text PRIMARY KEY,                      -- an old Robot ID ('saibya02') or old serial ('66401144')
  robot_id     text NOT NULL,                         -- the robot's serial now (foreign key added below)
  kind         text NOT NULL CHECK (kind IN ('robot_id', 'serial')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX robot_previous_ids_robot_idx ON robot_previous_ids (robot_id);
CREATE TRIGGER robot_previous_ids_no_update BEFORE UPDATE ON robot_previous_ids FOR EACH ROW EXECUTE FUNCTION pms_forbid_update();
CREATE TRIGGER robot_previous_ids_no_delete BEFORE DELETE ON robot_previous_ids FOR EACH ROW EXECUTE FUNCTION pms_forbid_delete();

-- ── 5. Renumber every robot (deleted ones too, so their history stays complete) ──
-- The old Robot ID rules go first: the ID was "code + number" and had to differ from the serial.
ALTER TABLE robots
  DROP CONSTRAINT robots_robot_id_check,
  DROP CONSTRAINT robots_id_not_serial,
  DROP CONSTRAINT robots_serial_8_digits;

-- Running number per combination, in the order robots were registered.
CREATE TEMP TABLE robot_renumber ON COMMIT DROP AS
SELECT r.robot_id AS old_id, r.serial_number AS old_serial,
       (CASE p.category WHEN 'uav' THEN '2' ELSE '1' END
        || lpad(p.model_no::text, 3, '0')
        || lpad(coalesce(a.attachment_no, 0)::text, 3, '0')
        || lpad(row_number() OVER (PARTITION BY p.category, p.model_no, coalesce(a.attachment_no, 0) ORDER BY r.created_at, r.running_number)::text, 4, '0')
        || lpad(floor(random() * 100)::integer::text, 2, '0')) AS new_id
FROM robots r JOIN products p ON p.id = r.product_id LEFT JOIN attachments a ON a.id = r.main_attachment_id;

DO $$
DECLARE
  fk   record;
  t    text;
  tbls text[];
BEGIN
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
  -- "saibya02 (robot)" → "1-005-000-0002-47 (robot)": the robot's own ingest client follows its new name.
  UPDATE ingest_clients x SET name = replace(x.name, m.old_id, regexp_replace(m.new_id, '^(.)(...)(...)(....)(..)$', '\1-\2-\3-\4-\5'))
    FROM robot_renumber m WHERE x.name LIKE m.old_id || ' %';

  FOREACH t IN ARRAY tbls LOOP
    EXECUTE format('ALTER TABLE %s ENABLE TRIGGER USER', t);
  END LOOP;
  FOR fk IN SELECT * FROM robot_fk_defs LOOP
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', fk.tbl, fk.conname, fk.def);
  END LOOP;
END $$;

INSERT INTO robot_previous_ids (previous_id, robot_id, kind)
  SELECT old_id, new_id, 'robot_id' FROM robot_renumber
  UNION ALL
  SELECT old_serial, new_id, 'serial' FROM robot_renumber WHERE old_serial IS DISTINCT FROM old_id;
ALTER TABLE robot_previous_ids ADD CONSTRAINT robot_previous_ids_robot_fk FOREIGN KEY (robot_id) REFERENCES robots(robot_id);

-- ── 6. Robots: the serial is the identity ──
ALTER TABLE robots
  ALTER COLUMN serial_number DROP DEFAULT,
  ADD CONSTRAINT robots_serial_format CHECK (serial_number ~ '^[12][0-9]{12}$'),
  ADD CONSTRAINT robots_serial_is_id CHECK (robot_id = serial_number);
CREATE TRIGGER robots_main_attachment_permanent BEFORE UPDATE ON robots FOR EACH ROW EXECUTE FUNCTION pms_immutable_columns('main_attachment_id');

-- The seed's registration: same rules as the server (serial from pms_new_robot_serial).
DROP FUNCTION IF EXISTS pms_register_robot(uuid, uuid, text, uuid, uuid);
CREATE FUNCTION pms_register_robot(
  p_product_id         uuid,
  p_revision_id        uuid,
  p_notes              text,
  p_created_by         uuid,
  p_company_id         uuid DEFAULT NULL,
  p_main_attachment_id uuid DEFAULT NULL
) RETURNS TABLE (new_robot_id text, new_serial_number text)
LANGUAGE plpgsql AS $$
DECLARE
  serial   text;
  running  integer;
  company  uuid;
BEGIN
  IF p_revision_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM hardware_revisions h WHERE h.id = p_revision_id AND h.product_id = p_product_id AND h.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'hardware revision does not belong to this base model' USING ERRCODE = '22023';
  END IF;
  serial := pms_new_robot_serial(p_product_id, p_main_attachment_id);
  SELECT p.next_running_number INTO running FROM products p WHERE p.id = p_product_id;
  INSERT INTO robots (robot_id, serial_number, product_id, hardware_revision_id, running_number, main_attachment_id, notes, created_by)
  VALUES (serial, serial, p_product_id, p_revision_id, running, p_main_attachment_id, p_notes, p_created_by);
  UPDATE products SET next_running_number = running + 1 WHERE id = p_product_id;

  company := coalesce(p_company_id, (SELECT c.id FROM companies c WHERE c.kind = 'internal' AND c.deleted_at IS NULL ORDER BY (lower(c.name) = 'arnobot') DESC, c.created_at LIMIT 1));
  IF company IS NULL THEN
    RAISE EXCEPTION 'no owner company (seed the Arnobot company first)' USING ERRCODE = '22023';
  END IF;
  INSERT INTO company_assignment_history (robot_id, company_id, valid_from, reason, created_by) VALUES (serial, company, now(), 'Registered', p_created_by);
  INSERT INTO live_state (robot_id) VALUES (serial);
  INSERT INTO connectivity (robot_id, updated_by) VALUES (serial, p_created_by);
  INSERT INTO dispatch_warranty (robot_id, updated_by) VALUES (serial, p_created_by);
  new_robot_id := serial;
  new_serial_number := serial;
  RETURN NEXT;
END $$;
