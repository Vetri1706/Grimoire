-- Supplemental database checks, not a replacement for the Go HTTP harness.
-- Run as the migration owner after local-handlers.sql in grimoire_test.
-- Every change is rolled back. Never loads the GG-40 fixture into development.
BEGIN;
SET LOCAL search_path=grimoire,public;
SELECT set_config('app.current_org_id','10000000-0000-4000-8000-000000000001',true);
SELECT set_config('app.current_principal_id','10000000-0000-4000-8000-000000000011',true);
SELECT set_config('app.request_id',gen_random_uuid()::text,true);
SELECT set_config('app.effective_role','procurement_preparer',true);
SELECT set_config('app.endpoint_scope','local:database-checks',true);
SELECT set_config('app.action_reason','Rollback-only security checks',true);

DO $$
DECLARE sample uuid:=gen_random_uuid(); token_hash text;
BEGIN
  IF current_database() NOT LIKE '%\_test' ESCAPE '\' THEN
    RAISE EXCEPTION 'database guard tests require a disposable _test database';
  END IF;
  INSERT INTO intake_scions(id,org_id,created_by)
    VALUES(sample,app.current_org_id(),app.current_principal_id());
  INSERT INTO intake_revisions(org_id,scion_id,number,name,product_category,change_summary,created_by)
    VALUES(app.current_org_id(),sample,1,'Rollback-only guard test','unspecified','',app.current_principal_id());
  BEGIN
    UPDATE intake_revisions SET name='rewritten' WHERE scion_id=sample;
    RAISE EXCEPTION 'immutable revision UPDATE unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'G2401' THEN NULL; END;
  BEGIN
    DELETE FROM intake_revisions WHERE scion_id=sample;
    RAISE EXCEPTION 'immutable revision DELETE unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'G2401' THEN NULL; END;
  BEGIN
    INSERT INTO intake_revisions(org_id,scion_id,number,name,product_category,change_summary,created_by)
      VALUES(app.current_org_id(),sample,3,'Skipped revision','unspecified','',app.current_principal_id());
    RAISE EXCEPTION 'nonsequential revision unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'G2402' THEN NULL; END;
  IF (SELECT current_revision FROM intake_scions WHERE id=sample)<>1
    OR (SELECT count(*) FROM intake_audit_events WHERE scion_id=sample)<>1 THEN
    RAISE EXCEPTION 'atomic revision pointer or audit failed';
  END IF;
  IF has_table_privilege('grimoire_intake_app','grimoire.sourcing_cases','SELECT,INSERT,UPDATE,DELETE')
    OR has_table_privilege('grimoire_intake_app','grimoire.intake_credentials','SELECT')
    OR has_table_privilege('grimoire_intake_app','grimoire.intake_revisions','UPDATE,DELETE')
    OR has_function_privilege('grimoire_intake_app','grimoire.invalidate_source_dependents(uuid,uuid,text)','EXECUTE')
    OR has_function_privilege('grimoire_intake_app','grimoire.assert_decision_complete(uuid,uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'intake runtime has forbidden governed, credential, or history privileges';
  END IF;
  -- GG-40 retains PUBLIC EXECUTE on some legacy trigger functions. Prevent the
  -- runtime from attaching those owner-privileged functions to an attacker-owned
  -- table: provisioning must deny every schema/table creation route, including
  -- the database TEMP privilege normally granted to PUBLIC by PostgreSQL.
  IF has_database_privilege('grimoire_intake_app',current_database(),'TEMPORARY,CREATE')
    OR has_schema_privilege('grimoire_intake_app','public','CREATE')
    OR has_schema_privilege('grimoire_intake_app','grimoire','CREATE')
    OR has_schema_privilege('grimoire_intake_app','app','CREATE') THEN
    RAISE EXCEPTION 'intake runtime can create tables and attach legacy owner-privileged triggers';
  END IF;
  SELECT token_sha256 INTO STRICT token_hash FROM intake_credentials
    WHERE principal_id=app.current_principal_id() AND revoked_at IS NULL LIMIT 1;
  IF (SELECT count(*) FROM app.intake_authenticate(token_hash))<>1 THEN
    RAISE EXCEPTION 'enabled seeded Handler authentication failed';
  END IF;
  UPDATE principals SET disabled_at=clock_timestamp() WHERE id=app.current_principal_id();
  IF EXISTS(SELECT 1 FROM app.intake_authenticate(token_hash)) THEN
    RAISE EXCEPTION 'disabled principal authentication unexpectedly succeeded';
  END IF;
  RAISE NOTICE 'PASS: immutable UPDATE/DELETE; sequential revisions; atomic pointer/audit; least privilege; no TEMP/schema creation; disabled principal denial';
END $$;
SET LOCAL ROLE grimoire_intake_app;
DO $$ BEGIN
  BEGIN
    CREATE TEMP TABLE intake_forbidden_temp(org_id uuid);
    RAISE EXCEPTION 'runtime temporary table creation unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RAISE NOTICE 'PASS: actual runtime CREATE TEMP TABLE rejected';
END $$;
ROLLBACK;

-- History author labels are current directory metadata, scoped to one visible
-- Scion. Exercise the helper under the real runtime role, not the table owner.
BEGIN;
SET LOCAL search_path=grimoire,public;
SELECT set_config('app.current_org_id','10000000-0000-4000-8000-000000000001',true);
SELECT set_config('app.current_principal_id','10000000-0000-4000-8000-000000000011',true);
SELECT set_config('app.request_id',gen_random_uuid()::text,true);
SELECT set_config('app.effective_role','procurement_preparer',true);
SELECT set_config('app.endpoint_scope','local:database-checks',true);
SELECT set_config('app.action_reason','Rollback-only history author scope checks',true);

DO $$
DECLARE own_scion uuid:=gen_random_uuid(); foreign_scion uuid:=gen_random_uuid();
BEGIN
  IF current_database() NOT LIKE '%\_test' ESCAPE '\' THEN
    RAISE EXCEPTION 'history author guard tests require a disposable _test database';
  END IF;
  INSERT INTO intake_scions(id,org_id,created_by)
    VALUES(own_scion,app.current_org_id(),app.current_principal_id());
  INSERT INTO intake_revisions(org_id,scion_id,number,name,product_category,change_summary,created_by)
    VALUES(app.current_org_id(),own_scion,1,'Author scope A','unspecified','',app.current_principal_id());
  PERFORM set_config('app.current_org_id','20000000-0000-4000-8000-000000000001',true);
  PERFORM set_config('app.current_principal_id','20000000-0000-4000-8000-000000000011',true);
  INSERT INTO intake_scions(id,org_id,created_by)
    VALUES(foreign_scion,app.current_org_id(),app.current_principal_id());
  INSERT INTO intake_revisions(org_id,scion_id,number,name,product_category,change_summary,created_by)
    VALUES(app.current_org_id(),foreign_scion,1,'Author scope B','unspecified','',app.current_principal_id());
  PERFORM set_config('app.test_own_scion',own_scion::text,true);
  PERFORM set_config('app.test_foreign_scion',foreign_scion::text,true);
  PERFORM set_config('app.current_org_id','10000000-0000-4000-8000-000000000001',true);
  PERFORM set_config('app.current_principal_id','10000000-0000-4000-8000-000000000011',true);
END $$;
SET LOCAL ROLE grimoire_intake_app;
DO $$
DECLARE own_scion uuid:=current_setting('app.test_own_scion')::uuid;
        foreign_scion uuid:=current_setting('app.test_foreign_scion')::uuid;
BEGIN
  IF (SELECT count(*) FROM app.intake_history_authors(own_scion))<>1
    OR NOT EXISTS(SELECT 1 FROM app.intake_history_authors(own_scion)
      WHERE principal_id=app.current_principal_id() AND display_name='Local Handler A') THEN
    RAISE EXCEPTION 'visible history did not return its readable Handler name';
  END IF;
  IF EXISTS(SELECT 1 FROM app.intake_history_authors(foreign_scion)) THEN
    RAISE EXCEPTION 'history author helper exposed another organization';
  END IF;
  IF EXISTS(SELECT 1 FROM app.intake_history_authors(gen_random_uuid())) THEN
    RAISE EXCEPTION 'nonexistent Scion unexpectedly returned authors';
  END IF;
  BEGIN
    PERFORM 1 FROM grimoire.principals LIMIT 1;
    RAISE EXCEPTION 'runtime direct principal-directory access unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  PERFORM set_config('app.current_org_id','20000000-0000-4000-8000-000000000001',true);
  IF EXISTS(SELECT 1 FROM app.intake_history_authors(foreign_scion)) THEN
    RAISE EXCEPTION 'history author helper accepted a mismatched organization/principal';
  END IF;
  PERFORM set_config('app.current_org_id','',true);
  PERFORM set_config('app.current_principal_id','',true);
  IF EXISTS(SELECT 1 FROM app.intake_history_authors(own_scion))
    OR EXISTS(SELECT 1 FROM app.intake_history_authors(foreign_scion)) THEN
    RAISE EXCEPTION 'history author helper exposed names without authenticated context';
  END IF;
  RAISE NOTICE 'PASS: readable history Handler; foreign, mismatched and missing context author denial; no direct principal access';
END $$;
ROLLBACK;
