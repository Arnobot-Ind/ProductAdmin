-- 0029: structured, automatic numbers for organizations and sites (they are never typed and never reused).
--
--   Organization number  companies.org_no   Arnobot (internal) = 0, customers 1, 2, 3… in the order they were added.
--                                           Shown as the customer number C-0001.
--   Site number          sites.site_no      1, 2, 3… within its organization. Shown as 0001-01 (organization · site).
--
-- A site keeps its number for life. It can move to another organization only while no robot was ever deployed at it
-- (a site created under the wrong customer); it then gets the next number of its new organization. Old numbers are
-- never given out again, because each organization counts up in companies.next_site_no.

-- Organizations ------------------------------------------------------------------------------------------------------
CREATE SEQUENCE companies_org_no_seq MINVALUE 1 MAXVALUE 9999 NO CYCLE;

ALTER TABLE companies
  ADD COLUMN org_no integer,
  ADD COLUMN next_site_no integer NOT NULL DEFAULT 1;

UPDATE companies SET org_no = 0 WHERE kind = 'internal';
UPDATE companies c SET org_no = n.no
FROM (SELECT id, nextval('companies_org_no_seq') AS no FROM (SELECT id FROM companies WHERE kind <> 'internal' ORDER BY created_at, name) o) n
WHERE c.id = n.id;

ALTER TABLE companies
  ALTER COLUMN org_no SET NOT NULL,
  ADD CONSTRAINT companies_org_no_range CHECK (org_no BETWEEN 0 AND 9999),
  ADD CONSTRAINT companies_org_no_internal CHECK ((kind = 'internal') = (org_no = 0)),
  ADD CONSTRAINT companies_org_no_unique UNIQUE (org_no),
  ADD CONSTRAINT companies_next_site_no_range CHECK (next_site_no BETWEEN 1 AND 100);

CREATE FUNCTION pms_company_org_no() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Always given by the database, whatever the insert says.
  NEW.org_no := CASE WHEN NEW.kind = 'internal' THEN 0 ELSE nextval('companies_org_no_seq') END;
  NEW.next_site_no := 1;
  RETURN NEW;
END $$;
CREATE TRIGGER companies_org_no BEFORE INSERT ON companies FOR EACH ROW EXECUTE FUNCTION pms_company_org_no();
CREATE TRIGGER companies_org_no_permanent BEFORE UPDATE OF org_no, kind ON companies
  FOR EACH ROW EXECUTE FUNCTION pms_immutable_columns('org_no', 'kind');

-- Sites --------------------------------------------------------------------------------------------------------------
ALTER TABLE sites ADD COLUMN site_no integer;

UPDATE sites s SET site_no = n.no
FROM (SELECT id, row_number() OVER (PARTITION BY company_id ORDER BY created_at, name) AS no FROM sites) n
WHERE s.id = n.id;

UPDATE companies c SET next_site_no = coalesce((SELECT max(site_no) FROM sites s WHERE s.company_id = c.id), 0) + 1;

ALTER TABLE sites
  ALTER COLUMN site_no SET NOT NULL,
  ADD CONSTRAINT sites_site_no_range CHECK (site_no BETWEEN 1 AND 99),
  ADD CONSTRAINT sites_site_no_unique UNIQUE (company_id, site_no);

CREATE FUNCTION pms_site_number() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  next_no integer;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.site_no IS DISTINCT FROM OLD.site_no AND NEW.company_id IS NOT DISTINCT FROM OLD.company_id THEN
      RAISE EXCEPTION 'sites.site_no is permanent and cannot be changed' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.company_id IS NOT DISTINCT FROM OLD.company_id THEN
      RETURN NEW;
    END IF;
    IF EXISTS (SELECT 1 FROM site_assignment_history h WHERE h.site_id = OLD.id) THEN
      RAISE EXCEPTION 'this site cannot move to another organization: robots have been deployed at it'
        USING ERRCODE = '22023';
    END IF;
  END IF;
  -- One at a time per organization: the counter row is locked until the transaction ends.
  UPDATE companies SET next_site_no = next_site_no + 1 WHERE id = NEW.company_id RETURNING next_site_no - 1 INTO next_no;
  IF next_no IS NULL THEN
    RAISE EXCEPTION 'organization % not found', NEW.company_id USING ERRCODE = 'P0002';
  END IF;
  IF next_no > 99 THEN
    RAISE EXCEPTION 'this organization already has 99 site numbers' USING ERRCODE = '22023';
  END IF;
  NEW.site_no := next_no;
  RETURN NEW;
END $$;
CREATE TRIGGER sites_site_no BEFORE INSERT OR UPDATE OF company_id, site_no ON sites
  FOR EACH ROW EXECUTE FUNCTION pms_site_number();
