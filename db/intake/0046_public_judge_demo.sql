-- Public access to three deliberately published synthetic examples only.
-- No visitor identity, writable credential, provider login or task worker.
BEGIN;
SET search_path=pg_catalog,grimoire,pg_temp;
SELECT set_config('app.request_id',gen_random_uuid()::text,true),
       set_config('app.effective_role','local_setup',true),
       set_config('app.endpoint_scope','migration:public-judge-demo',true),
       set_config('app.action_reason','Reserve a separate public synthetic organization and a non-authenticatable read-only principal',true);

-- Reserve a new organization instead of making any existing workspace public.
-- An ID collision fails the migration; it must never relabel existing data.
INSERT INTO grimoire.organizations(id,name)
VALUES('d3400000-0000-4000-8000-000000000001','Grimoire public synthetic judge workspace');
INSERT INTO grimoire.org_security_epochs(org_id)
VALUES('d3400000-0000-4000-8000-000000000001');
INSERT INTO grimoire.principals(id,org_id,external_subject,display_name)
VALUES('d3400000-0000-4000-8000-000000000002','d3400000-0000-4000-8000-000000000001',
 'public-synthetic-judge-reader','Public synthetic demo reader');
INSERT INTO grimoire.principal_roles(org_id,principal_id,role)
VALUES('d3400000-0000-4000-8000-000000000001','d3400000-0000-4000-8000-000000000002','read_only_agent');

CREATE TABLE grimoire.intake_public_demo_scenarios (
 slug text PRIMARY KEY CHECK(slug IN ('current','revised','revoked')),
 org_id uuid NOT NULL CHECK(org_id='d3400000-0000-4000-8000-000000000001'),
 scion_id uuid NOT NULL UNIQUE,
 synthetic boolean NOT NULL CHECK(synthetic),
 published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(org_id,scion_id) REFERENCES grimoire.intake_scions(org_id,id)
);
COMMENT ON TABLE grimoire.intake_public_demo_scenarios IS
 'Operator-only publication registry for the dedicated public synthetic organization. Never register private or user-provided data. No runtime table grants or registration endpoint.';
REVOKE ALL ON grimoire.intake_public_demo_scenarios FROM PUBLIC,grimoire_intake_app;

CREATE FUNCTION grimoire.intake_public_demo_publication_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,grimoire,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM grimoire.intake_revisions r WHERE (r.org_id,r.scion_id)=(NEW.org_id,NEW.scion_id)) OR
    EXISTS(SELECT 1 FROM grimoire.intake_revisions r WHERE (r.org_id,r.scion_id)=(NEW.org_id,NEW.scion_id)
      AND (r.product_category<>'digital' OR r.name NOT LIKE 'Synthetic judge:%'
        OR COALESCE(r.product_description,'') NOT LIKE 'PUBLIC_SYNTHETIC_JUDGE_FIXTURE:%')) THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='only explicitly marked synthetic digital judge fixtures can be published';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER intake_public_demo_publication_guard
 BEFORE INSERT OR UPDATE ON grimoire.intake_public_demo_scenarios
 FOR EACH ROW EXECUTE FUNCTION grimoire.intake_public_demo_publication_guard();
REVOKE ALL ON FUNCTION grimoire.intake_public_demo_publication_guard() FROM PUBLIC,grimoire_intake_app;

CREATE FUNCTION app.intake_public_demo_scenarios()
RETURNS TABLE(slug text,scion_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
 SELECT d.slug,d.scion_id FROM grimoire.intake_public_demo_scenarios d
 WHERE d.org_id='d3400000-0000-4000-8000-000000000001' AND d.synthetic
 AND (SELECT count(*) FROM grimoire.intake_public_demo_scenarios)=3
 AND EXISTS(SELECT 1 FROM grimoire.principals p JOIN grimoire.principal_roles r
   ON (r.org_id,r.principal_id)=(p.org_id,p.id)
   WHERE (p.org_id,p.id)=('d3400000-0000-4000-8000-000000000001','d3400000-0000-4000-8000-000000000002')
   AND p.external_subject='public-synthetic-judge-reader' AND p.disabled_at IS NULL AND r.role='read_only_agent')
 AND NOT EXISTS(SELECT 1 FROM grimoire.principal_roles r
   WHERE r.principal_id='d3400000-0000-4000-8000-000000000002' AND r.role<>'read_only_agent')
 AND NOT EXISTS(SELECT 1 FROM grimoire.intake_scope_agents a WHERE a.principal_id='d3400000-0000-4000-8000-000000000002')
 AND NOT EXISTS(SELECT 1 FROM grimoire.intake_scope_reviewers r WHERE r.principal_id='d3400000-0000-4000-8000-000000000002')
 AND NOT EXISTS(SELECT 1 FROM grimoire.intake_credentials c WHERE c.principal_id='d3400000-0000-4000-8000-000000000002')
 AND NOT EXISTS(SELECT 1 FROM grimoire.handler_organization_memberships m WHERE m.principal_id='d3400000-0000-4000-8000-000000000002')
 AND NOT EXISTS(SELECT 1 FROM grimoire.intake_public_demo_scenarios registered
   JOIN grimoire.intake_revisions r ON (r.org_id,r.scion_id)=(registered.org_id,registered.scion_id)
   WHERE r.product_category<>'digital' OR r.name NOT LIKE 'Synthetic judge:%'
      OR COALESCE(r.product_description,'') NOT LIKE 'PUBLIC_SYNTHETIC_JUDGE_FIXTURE:%')
 ORDER BY CASE d.slug WHEN 'current' THEN 1 WHEN 'revised' THEN 2 ELSE 3 END
$$;

-- PostgreSQL forbids row locking in READ ONLY transactions. The public graph
-- instead uses one REPEATABLE READ snapshot, and these narrowly scoped helpers
-- permit lock-free reads only for its fixed non-authenticatable reader and an
-- explicitly published Scion. Every ordinary read/write keeps its old locks.
CREATE FUNCTION app.intake_public_demo_readable(wanted_scion uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
 SELECT current_setting('transaction_read_only')='on'
 AND current_setting('transaction_isolation')='repeatable read'
 AND app.current_org_id()='d3400000-0000-4000-8000-000000000001'
 AND app.current_principal_id()='d3400000-0000-4000-8000-000000000002'
 AND EXISTS(SELECT 1 FROM app.intake_public_demo_scenarios() d WHERE d.scion_id=wanted_scion)
$$;

CREATE OR REPLACE FUNCTION app.intake_scope_lock_scion(wanted_scion uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE revision integer;
BEGIN
 IF app.intake_public_demo_readable(wanted_scion) THEN
  SELECT s.current_revision INTO revision FROM grimoire.intake_scions s
   WHERE s.id=wanted_scion AND s.org_id=app.current_org_id() AND app.intake_can_access();
 ELSE
  SELECT s.current_revision INTO revision FROM grimoire.intake_scions s
   WHERE s.id=wanted_scion AND s.org_id=app.current_org_id() AND app.intake_can_access() FOR UPDATE;
 END IF;
 RETURN revision;
END $$;

CREATE OR REPLACE FUNCTION app.intake_source_read_lock(wanted_scion uuid,wanted_source uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE revision integer;
BEGIN
 IF app.intake_public_demo_readable(wanted_scion) THEN
  SELECT s.current_revision INTO revision FROM grimoire.intake_sources s
   WHERE s.id=wanted_source AND s.scion_id=wanted_scion AND s.org_id=app.current_org_id() AND app.intake_can_access();
 ELSE
  SELECT s.current_revision INTO revision FROM grimoire.intake_sources s
   WHERE s.id=wanted_source AND s.scion_id=wanted_scion AND s.org_id=app.current_org_id() AND app.intake_can_access() FOR SHARE;
 END IF;
 RETURN revision;
END $$;

CREATE OR REPLACE FUNCTION app.intake_capability_assert_claim(scion uuid,revision integer,claim uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE c grimoire.intake_source_claims%ROWTYPE; s grimoire.intake_sources%ROWTYPE; r grimoire.intake_source_revisions%ROWTYPE; current_number integer;
BEGIN
 current_number:=app.intake_scope_lock_scion(scion);
 IF current_number IS NULL THEN RAISE EXCEPTION USING ERRCODE='G3804',MESSAGE='Scion unavailable'; END IF;
 IF current_number<>revision THEN RAISE EXCEPTION USING ERRCODE='G2402',MESSAGE='stale Scion revision'; END IF;
 SELECT * INTO c FROM grimoire.intake_source_claims WHERE id=claim AND org_id=app.current_org_id();
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='G3804',MESSAGE='claim unavailable'; END IF;
 -- Same shared source lock as before for normal callers; public read-only
 -- snapshots use the exact same permission, revision and object checks below.
 PERFORM app.intake_source_read_lock(scion,c.source_id);
 SELECT * INTO s FROM grimoire.intake_sources WHERE (org_id,id,scion_id)=(app.current_org_id(),c.source_id,scion);
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='G3804',MESSAGE='claim unavailable'; END IF;
 IF NOT app.intake_source_permitted(s.id) THEN RAISE EXCEPTION USING ERRCODE='G2601',MESSAGE='source permission unavailable'; END IF;
 IF s.scion_revision<>revision OR s.current_revision<>c.source_revision THEN RAISE EXCEPTION USING ERRCODE='G3802',MESSAGE='claim is bound to a stale Scion or source revision'; END IF;
 SELECT * INTO STRICT r FROM grimoire.intake_source_revisions WHERE (org_id,source_id,number)=(s.org_id,s.id,c.source_revision);
 IF r.rights_status<>'granted' OR r.permitted_use<>'scion_review' OR length(btrim(r.permission_basis))=0 THEN RAISE EXCEPTION USING ERRCODE='G2601',MESSAGE='source permission unavailable'; END IF;
 IF NOT EXISTS(SELECT 1 FROM grimoire.intake_source_objects o WHERE (o.org_id,o.source_id,o.source_revision,o.content_sha256,o.byte_length)=(r.org_id,r.source_id,r.number,r.content_sha256,r.byte_length)) THEN
  RAISE EXCEPTION USING ERRCODE='G3802',MESSAGE='source object binding is missing';
 END IF;
END $$;

REVOKE ALL ON FUNCTION app.intake_public_demo_scenarios(),app.intake_public_demo_readable(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.intake_public_demo_scenarios(),app.intake_public_demo_readable(uuid) TO grimoire_intake_app;
COMMIT;
