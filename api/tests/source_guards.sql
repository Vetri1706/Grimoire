-- Supplemental Layer 2 database invariants, separate from the live Go HTTP suite.
-- Every insert is rolled back; never run against the canonical development DB.
BEGIN;
SET LOCAL search_path=pg_catalog,grimoire,pg_temp;
SELECT set_config('app.current_org_id','10000000-0000-4000-8000-000000000001',true);
SELECT set_config('app.current_principal_id','10000000-0000-4000-8000-000000000011',true);
SELECT set_config('app.request_id',gen_random_uuid()::text,true);

DO $$
DECLARE scion uuid:=gen_random_uuid(); source uuid:=gen_random_uuid();
  content text:='SYNTHETIC width: 120 mm. Unicode: µ.';
  table_name text; action text;
BEGIN
  IF current_database() NOT LIKE '%\_test' ESCAPE '\' THEN
    RAISE EXCEPTION 'source guard checks require a disposable _test database';
  END IF;
  INSERT INTO grimoire.intake_scions(id,org_id,created_by)
    VALUES(scion,app.current_org_id(),app.current_principal_id());
  INSERT INTO grimoire.intake_revisions(org_id,scion_id,number,name,product_category,change_summary,created_by)
    VALUES(app.current_org_id(),scion,1,'Synthetic SQL source guard','unspecified','',app.current_principal_id());
  INSERT INTO grimoire.intake_sources(id,org_id,scion_id,scion_revision,created_by)
    VALUES(source,app.current_org_id(),scion,1,app.current_principal_id());
  -- SQL-only reference: these rollback tests validate database structure, not
  -- object existence or byte integrity; the live Go suite exercises real S3.
  INSERT INTO grimoire.intake_source_objects(org_id,source_id,source_revision,object_bucket,object_key,object_version_id,content_sha256,byte_length,recorded_by)
    VALUES(app.current_org_id(),source,1,'grimoire-sources-test',
      'org/'||app.current_org_id()||'/sources/'||source||'/revisions/1/sql-guard.txt','synthetic-sql-version',
      encode(public.digest(convert_to(content,'UTF8'),'sha256'),'hex'),octet_length(content),app.current_principal_id());
  INSERT INTO grimoire.intake_source_revisions(org_id,source_id,number,title,origin,owner,synthetic,
    source_text,content_sha256,byte_length,rights_status,permission_basis,permitted_use,change_summary,created_by)
    VALUES(app.current_org_id(),source,1,'Synthetic SQL fixture','synthetic://sql-guard','Local prototype',true,
      NULL,encode(public.digest(convert_to(content,'UTF8'),'sha256'),'hex'),octet_length(content),'granted',
      'Created for rollback-only synthetic testing','scion_review','Initial',app.current_principal_id());
  BEGIN
    INSERT INTO grimoire.intake_source_revisions(org_id,source_id,number,title,origin,owner,synthetic,
      source_text,content_sha256,byte_length,rights_status,permission_basis,permitted_use,change_summary,created_by)
      SELECT org_id,source_id,2,title,origin,owner,synthetic,source_text,repeat('0',64),byte_length,
        rights_status,permission_basis,permitted_use,'Wrong hash',created_by
      FROM grimoire.intake_source_revisions WHERE source_id=source;
    RAISE EXCEPTION 'source without matching object reference unexpectedly stored';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO grimoire.intake_source_claims(id,org_id,source_id,source_revision,statement,start_byte,end_byte,quote,created_by)
      VALUES(gen_random_uuid(),app.current_org_id(),source,1,'Bad locator',0,4,'wrong',app.current_principal_id());
    RAISE EXCEPTION 'structurally mismatched locator unexpectedly stored';
  EXCEPTION WHEN check_violation THEN NULL; END;
  INSERT INTO grimoire.intake_source_claims(id,org_id,source_id,source_revision,statement,start_byte,end_byte,quote,created_by)
    VALUES(gen_random_uuid(),app.current_org_id(),source,1,'The note calls itself synthetic.',0,9,'SYNTHETIC',app.current_principal_id());
  BEGIN
    UPDATE grimoire.intake_source_objects SET recorded_at=recorded_at WHERE source_id=source;
    RAISE EXCEPTION 'immutable object reference unexpectedly updated';
  EXCEPTION WHEN SQLSTATE 'G2401' THEN NULL; END;
  BEGIN
    DELETE FROM grimoire.intake_source_objects WHERE source_id=source;
    RAISE EXCEPTION 'immutable object reference unexpectedly deleted';
  EXCEPTION WHEN SQLSTATE 'G2401' THEN NULL; END;
  IF has_table_privilege('grimoire_intake_app','grimoire.intake_source_objects','UPDATE,DELETE,TRUNCATE')
    OR has_function_privilege('grimoire_intake_app','app.intake_externalize_source_revision(uuid,uuid,integer,text,text,text,text,integer)','EXECUTE') THEN
    RAISE EXCEPTION 'HTTP runtime can change object history or invoke administrator externalization';
  END IF;
  BEGIN
    INSERT INTO grimoire.intake_source_revisions(org_id,source_id,number,title,origin,owner,synthetic,
      source_text,content_sha256,byte_length,rights_status,permission_basis,permitted_use,change_summary,created_by)
      SELECT org_id,source_id,2,title,origin,owner,synthetic,source_text,content_sha256,byte_length,
        'missing',permission_basis,permitted_use,'No permission',created_by
      FROM grimoire.intake_source_revisions WHERE source_id=source;
    RAISE EXCEPTION 'missing source rights unexpectedly stored';
  EXCEPTION WHEN check_violation THEN NULL; END;
  INSERT INTO grimoire.intake_source_revocations(org_id,source_id,source_revision,reason,created_by)
    VALUES(app.current_org_id(),source,1,'Synthetic revocation test',app.current_principal_id());
  FOREACH table_name IN ARRAY ARRAY['intake_source_revisions','intake_source_claims','intake_source_revocations'] LOOP
    FOREACH action IN ARRAY ARRAY['UPDATE','DELETE'] LOOP
      BEGIN
        IF action='UPDATE' THEN
          EXECUTE format('UPDATE grimoire.%I SET created_at=created_at WHERE source_id=$1',table_name) USING source;
        ELSE
          EXECUTE format('DELETE FROM grimoire.%I WHERE source_id=$1',table_name) USING source;
        END IF;
        RAISE EXCEPTION '% % unexpectedly allowed',action,table_name;
      EXCEPTION WHEN SQLSTATE 'G2401' THEN NULL; END;
    END LOOP;
    IF has_table_privilege('grimoire_intake_app','grimoire.'||table_name,'UPDATE,DELETE,TRUNCATE') THEN
      RAISE EXCEPTION 'runtime has mutation privilege on immutable table %',table_name;
    END IF;
  END LOOP;
  BEGIN
    INSERT INTO grimoire.intake_source_claims(id,org_id,source_id,source_revision,statement,start_byte,end_byte,quote,created_by)
      VALUES(gen_random_uuid(),app.current_org_id(),source,1,'Post-revocation claim',0,9,'SYNTHETIC',app.current_principal_id());
    RAISE EXCEPTION 'claim after revocation unexpectedly stored';
  EXCEPTION WHEN SQLSTATE 'G2601' THEN NULL; END;
  IF has_column_privilege('grimoire_intake_app','grimoire.intake_sources','current_revision','UPDATE')
    OR has_column_privilege('grimoire_intake_app','grimoire.intake_sources','scion_revision','UPDATE') THEN
    RAISE EXCEPTION 'runtime can directly rewrite source pointer or Scion binding';
  END IF;
  SET LOCAL ROLE grimoire_intake_app;
  IF EXISTS(SELECT 1 FROM grimoire.intake_source_revisions WHERE source_id=source)
    OR EXISTS(SELECT 1 FROM grimoire.intake_source_claims WHERE source_id=source)
    OR EXISTS(SELECT 1 FROM grimoire.intake_source_objects WHERE source_id=source)
    OR app.intake_source_permitted(source) THEN
    RAISE EXCEPTION 'runtime source content or claims remained readable after revocation';
  END IF;
  IF (SELECT count(*) FROM app.intake_source_summaries(scion) WHERE id=source AND rights_status='revoked')<>1 THEN
    RAISE EXCEPTION 'authorized audit summary missing after revocation';
  END IF;
  PERFORM set_config('app.current_org_id','20000000-0000-4000-8000-000000000001',true);
  PERFORM set_config('app.current_principal_id','20000000-0000-4000-8000-000000000011',true);
  IF EXISTS(SELECT 1 FROM grimoire.intake_sources WHERE id=source)
    OR EXISTS(SELECT 1 FROM grimoire.intake_source_revocations WHERE source_id=source)
    OR EXISTS(SELECT 1 FROM app.intake_source_summaries(scion))
    OR app.intake_source_permitted(source) THEN
    RAISE EXCEPTION 'foreign source, revocation or summary leaked across organizations';
  END IF;
  RAISE NOTICE 'PASS: source/claim/revocation/object-reference immutability; reference identity and locator bounds; no runtime externalization; missing rights; revoked content RLS; pointer privileges; foreign hiding. Exact object bytes/quote are verified by the live API harness.';
END $$;
ROLLBACK;
