-- Grimoire Layer 1 draft intake, authored separately from verified GG-40 v2.2.1.
-- Apply only after unchanged 0022 -> 0023 in the SAME canonical database.
BEGIN;
SET search_path = grimoire, public;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='grimoire_intake_app') THEN
    CREATE ROLE grimoire_intake_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END $$;

CREATE TABLE intake_credentials (
  token_sha256 text PRIMARY KEY CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  org_id uuid NOT NULL REFERENCES organizations(id),
  principal_id uuid NOT NULL,
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz,
  revoked_at timestamptz,
  FOREIGN KEY (org_id,principal_id) REFERENCES principals(org_id,id)
);
COMMENT ON TABLE intake_credentials IS 'Local-development bearer credentials; hash only. Not a production identity provider.';

CREATE FUNCTION app.intake_authenticate(wanted_hash text)
RETURNS TABLE (principal_id uuid, org_id uuid, display_name text, organization_name text, can_write boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=grimoire,pg_temp SET row_security=off AS $$
  SELECT p.id,p.org_id,p.display_name::text,o.name::text,
    EXISTS (SELECT 1 FROM principal_roles r WHERE (r.org_id,r.principal_id)=(p.org_id,p.id)
      AND r.role IN ('org_admin','procurement_preparer'))
  FROM intake_credentials c JOIN principals p ON (p.org_id,p.id)=(c.org_id,c.principal_id)
  JOIN organizations o ON o.id=p.org_id
  WHERE c.token_sha256=wanted_hash AND c.revoked_at IS NULL
    AND (c.expires_at IS NULL OR c.expires_at>clock_timestamp()) AND p.disabled_at IS NULL
    AND EXISTS (SELECT 1 FROM principal_roles r WHERE (r.org_id,r.principal_id)=(p.org_id,p.id))
$$;

CREATE FUNCTION app.intake_can_access() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=grimoire,pg_temp SET row_security=off AS $$
  SELECT EXISTS (SELECT 1 FROM principals p JOIN principal_roles r
    ON (p.org_id,p.id)=(r.org_id,r.principal_id)
    WHERE (p.org_id,p.id)=(app.current_org_id(),app.current_principal_id()) AND p.disabled_at IS NULL)
$$;
CREATE FUNCTION app.intake_can_write() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=grimoire,pg_temp SET row_security=off AS $$
  SELECT EXISTS (SELECT 1 FROM principals p JOIN principal_roles r
    ON (p.org_id,p.id)=(r.org_id,r.principal_id)
    WHERE (p.org_id,p.id)=(app.current_org_id(),app.current_principal_id()) AND p.disabled_at IS NULL
      AND r.role IN ('org_admin','procurement_preparer'))
$$;

CREATE TABLE intake_scions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  current_revision integer NOT NULL DEFAULT 0 CHECK (current_revision>=0),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (org_id,id),
  FOREIGN KEY (org_id,created_by) REFERENCES principals(org_id,id)
);
CREATE TABLE intake_revisions (
  org_id uuid NOT NULL,
  scion_id uuid NOT NULL,
  number integer NOT NULL CHECK (number>0),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  product_description text CHECK (length(product_description)<=12000),
  product_category text NOT NULL CHECK (product_category IN ('physical','digital','unspecified')),
  decision text CHECK (length(decision)<=4000),
  requirements jsonb CHECK (requirements IS NULL OR (jsonb_typeof(requirements)='array' AND jsonb_array_length(requirements)<=100)),
  questions jsonb CHECK (questions IS NULL OR (jsonb_typeof(questions)='array' AND jsonb_array_length(questions)<=100)),
  change_summary text NOT NULL CHECK (length(change_summary)<=1000),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id,scion_id,number),
  FOREIGN KEY (org_id,scion_id) REFERENCES intake_scions(org_id,id),
  FOREIGN KEY (org_id,created_by) REFERENCES principals(org_id,id)
);
CREATE INDEX intake_scions_org_updated ON intake_scions(org_id,updated_at DESC,id);
COMMENT ON TABLE intake_revisions IS 'Immutable Handler-entered draft snapshots. No sourcing fact, qualification, supplier, price, BOM, or approval authority.';

CREATE TABLE intake_idempotency (
  org_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  key text NOT NULL CHECK (length(key) BETWEEN 1 AND 128),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  response_status smallint NOT NULL CHECK (response_status=201),
  response_body text NOT NULL,
  response_etag text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id,principal_id,key),
  FOREIGN KEY (org_id,principal_id) REFERENCES principals(org_id,id)
);
CREATE TABLE intake_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  scion_id uuid NOT NULL,
  revision_number integer NOT NULL,
  principal_id uuid NOT NULL,
  request_id uuid NOT NULL,
  event text NOT NULL CHECK (event IN ('draft_created','revision_created')),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (org_id,scion_id,revision_number) REFERENCES intake_revisions(org_id,scion_id,number),
  FOREIGN KEY (org_id,principal_id) REFERENCES principals(org_id,id)
);

CREATE FUNCTION intake_deny_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE='G2401',MESSAGE='intake history is immutable'; END $$;
CREATE TRIGGER intake_revisions_immutable BEFORE UPDATE OR DELETE ON intake_revisions
FOR EACH ROW EXECUTE FUNCTION intake_deny_mutation();
CREATE TRIGGER intake_idempotency_immutable BEFORE UPDATE OR DELETE ON intake_idempotency
FOR EACH ROW EXECUTE FUNCTION intake_deny_mutation();
CREATE TRIGGER intake_audit_immutable BEFORE UPDATE OR DELETE ON intake_audit_events
FOR EACH ROW EXECUTE FUNCTION intake_deny_mutation();

CREATE FUNCTION intake_guard_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=grimoire,pg_temp AS $$
DECLARE current_number integer; item jsonb;
BEGIN
  IF NEW.org_id IS DISTINCT FROM app.current_org_id() OR NEW.created_by IS DISTINCT FROM app.current_principal_id()
    OR NOT app.intake_can_write() THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='intake write is not authorized';
  END IF;
  SELECT current_revision INTO STRICT current_number FROM intake_scions
    WHERE (org_id,id)=(NEW.org_id,NEW.scion_id) FOR UPDATE;
  IF NEW.number<>current_number+1 THEN
    RAISE EXCEPTION USING ERRCODE='G2402',MESSAGE='revision must follow current revision';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(COALESCE(NEW.requirements,'[]'::jsonb))
    UNION ALL SELECT value FROM jsonb_array_elements(COALESCE(NEW.questions,'[]'::jsonb)) LOOP
    IF jsonb_typeof(item)<>'string' OR length(btrim(item#>>'{}')) NOT BETWEEN 1 AND 2000 THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='intake lists must contain nonempty bounded strings';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER intake_revision_guard BEFORE INSERT ON intake_revisions
FOR EACH ROW EXECUTE FUNCTION intake_guard_revision();

CREATE FUNCTION intake_after_revision() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=grimoire,pg_temp AS $$
BEGIN
  UPDATE intake_scions SET current_revision=NEW.number,updated_at=NEW.created_at
    WHERE (org_id,id)=(NEW.org_id,NEW.scion_id);
  INSERT INTO intake_audit_events(org_id,scion_id,revision_number,principal_id,request_id,event)
  VALUES(NEW.org_id,NEW.scion_id,NEW.number,NEW.created_by,
    nullif(current_setting('app.request_id',true),'')::uuid,
    CASE WHEN NEW.number=1 THEN 'draft_created' ELSE 'revision_created' END);
  RETURN NEW;
END $$;
CREATE TRIGGER intake_revision_recorded AFTER INSERT ON intake_revisions
FOR EACH ROW EXECUTE FUNCTION intake_after_revision();

CREATE FUNCTION intake_require_initial_revision() RETURNS trigger LANGUAGE plpgsql
SET search_path=grimoire,pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM intake_revisions WHERE (org_id,scion_id,number)=(NEW.org_id,NEW.id,1)) THEN
    RAISE EXCEPTION USING ERRCODE='G2403',MESSAGE='Scion creation requires revision one in the same transaction';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER intake_initial_revision AFTER INSERT ON intake_scions
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION intake_require_initial_revision();

ALTER TABLE intake_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE intake_scions ENABLE ROW LEVEL SECURITY;
ALTER TABLE intake_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE intake_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE intake_audit_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY intake_scion_read ON intake_scions FOR SELECT TO grimoire_intake_app
USING (org_id=app.current_org_id() AND app.intake_can_access());
CREATE POLICY intake_scion_create ON intake_scions FOR INSERT TO grimoire_intake_app
WITH CHECK (org_id=app.current_org_id() AND created_by=app.current_principal_id() AND current_revision=0 AND app.intake_can_write());
-- SELECT FOR UPDATE requires UPDATE privilege and a matching policy. Runtime can
-- only update updated_at; current_revision is advanced by the fixed trigger.
CREATE POLICY intake_scion_lock ON intake_scions FOR UPDATE TO grimoire_intake_app
USING (org_id=app.current_org_id() AND app.intake_can_write())
WITH CHECK (org_id=app.current_org_id() AND app.intake_can_write());
CREATE POLICY intake_revision_read ON intake_revisions FOR SELECT TO grimoire_intake_app
USING (org_id=app.current_org_id() AND app.intake_can_access());
CREATE POLICY intake_revision_create ON intake_revisions FOR INSERT TO grimoire_intake_app
WITH CHECK (org_id=app.current_org_id() AND created_by=app.current_principal_id() AND app.intake_can_write());
CREATE POLICY intake_retry_read ON intake_idempotency FOR SELECT TO grimoire_intake_app
USING (org_id=app.current_org_id() AND principal_id=app.current_principal_id() AND app.intake_can_access());
CREATE POLICY intake_retry_create ON intake_idempotency FOR INSERT TO grimoire_intake_app
WITH CHECK (org_id=app.current_org_id() AND principal_id=app.current_principal_id() AND app.intake_can_write());

REVOKE ALL ON intake_credentials,intake_scions,intake_revisions,intake_idempotency,intake_audit_events FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.intake_authenticate(text),app.intake_can_access(),app.intake_can_write(),
  intake_deny_mutation(),intake_guard_revision(),intake_after_revision(),intake_require_initial_revision() FROM PUBLIC;
-- GG-40 0023 left this mutation helper executable by PUBLIC. Narrow its callers
-- in this additive migration; the two verified migration files remain unchanged.
REVOKE EXECUTE ON FUNCTION invalidate_source_dependents(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invalidate_source_dependents(uuid,uuid,text) TO grimoire_app,grimoire_worker;
REVOKE EXECUTE ON FUNCTION assert_decision_complete(uuid,uuid),app.can_read_case(uuid),app.can_read_decision(uuid) FROM PUBLIC;
GRANT USAGE ON SCHEMA grimoire,app TO grimoire_intake_app;
GRANT EXECUTE ON FUNCTION app.intake_authenticate(text),app.intake_can_access(),app.intake_can_write(),
  app.current_org_id(),app.current_principal_id() TO grimoire_intake_app;
GRANT SELECT,INSERT ON intake_scions,intake_revisions,intake_idempotency TO grimoire_intake_app;
GRANT UPDATE(updated_at) ON intake_scions TO grimoire_intake_app;

COMMIT;
