-- Migration-owner check on a disposable *_test database; all changes roll back.
-- HTTP harness covers valid receipts, exact-source invalidation and restart.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL search_path=pg_catalog,grimoire,pg_temp;
SET LOCAL ROLE grimoire_migrator;
DO $$ BEGIN
 IF current_database() !~ '_test$' THEN RAISE EXCEPTION 'Disposable *_test database required'; END IF;
 IF NOT has_table_privilege('grimoire_intake_app','grimoire.intake_capability_plan_reviews','SELECT')
  OR has_table_privilege('grimoire_intake_app','grimoire.intake_capability_plan_reviews','INSERT,UPDATE,DELETE,TRUNCATE') THEN
  RAISE EXCEPTION 'Review runtime privileges must be SELECT only'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='grimoire.intake_capability_plan_reviews'::regclass AND relrowsecurity) THEN
  RAISE EXCEPTION 'Review RLS disabled'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='grimoire.intake_capability_plan_reviews'::regclass
  AND tgname='intake_capability_reviews_immutable' AND tgenabled='O') THEN RAISE EXCEPTION 'Immutable review trigger disabled'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace,
 LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
 WHERE n.nspname='app' AND p.proname IN ('intake_record_capability_review','intake_capability_review_visible')
 AND a.grantee=0 AND a.privilege_type='EXECUTE') THEN RAISE EXCEPTION 'Public can invoke review functions'; END IF;
END $$;
SELECT set_config('app.request_id',gen_random_uuid()::text,true),set_config('app.effective_role','test_fixture',true),
 set_config('app.endpoint_scope','test:capability-review',true),set_config('app.action_reason','Rollback-only receipt authorization test',true);
INSERT INTO grimoire.organizations(id,name) VALUES('d3510000-0000-4000-8000-000000000001','Synthetic receipt guard');
INSERT INTO grimoire.org_security_epochs(org_id) VALUES('d3510000-0000-4000-8000-000000000001');
INSERT INTO grimoire.principals(id,org_id,external_subject,display_name) VALUES
 ('d3510000-0000-4000-8000-000000000011','d3510000-0000-4000-8000-000000000001','test:review-owner','Review owner'),
 ('d3510000-0000-4000-8000-000000000012','d3510000-0000-4000-8000-000000000001','test:review-agent','Review agent');
INSERT INTO grimoire.principal_roles(org_id,principal_id,role) VALUES
 ('d3510000-0000-4000-8000-000000000001','d3510000-0000-4000-8000-000000000011','org_admin'),
 ('d3510000-0000-4000-8000-000000000001','d3510000-0000-4000-8000-000000000012','org_admin'),
 ('d3510000-0000-4000-8000-000000000001','d3510000-0000-4000-8000-000000000012','read_only_agent');
INSERT INTO grimoire.intake_scope_agents(org_id,principal_id) VALUES('d3510000-0000-4000-8000-000000000001','d3510000-0000-4000-8000-000000000012');
SET LOCAL ROLE grimoire_intake_app;
SELECT set_config('app.current_org_id','d3510000-0000-4000-8000-000000000001',true),
 set_config('app.current_principal_id','d3510000-0000-4000-8000-000000000011',true),set_config('app.effective_role','org_admin',true);
DO $$ DECLARE denied boolean; BEGIN
 IF EXISTS(SELECT 1 FROM grimoire.intake_capability_plan_reviews) THEN RAISE EXCEPTION 'Foreign receipts leaked to fresh organization'; END IF;
 IF app.intake_capability_review_visible(gen_random_uuid()) THEN RAISE EXCEPTION 'Unknown plan visible'; END IF;
 denied:=false;
 BEGIN PERFORM app.intake_record_capability_review(gen_random_uuid(),gen_random_uuid(),1,'Synthetic note','missing-plan');
 EXCEPTION WHEN SQLSTATE 'G3804' THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'Human created receipt for unavailable target'; END IF;
 denied:=false;
 BEGIN INSERT INTO grimoire.intake_capability_plan_reviews(id) VALUES(gen_random_uuid());
 EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'Runtime bypassed review function'; END IF;
 denied:=false;
 BEGIN DELETE FROM grimoire.intake_capability_plan_reviews;
 EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'Runtime could delete review history'; END IF;
 RAISE NOTICE 'PASS review runtime privileges, foreign RLS and missing target guards';
END $$;
SELECT set_config('app.current_principal_id','d3510000-0000-4000-8000-000000000012',true);
DO $$ DECLARE denied boolean:=false; BEGIN
 BEGIN PERFORM app.intake_record_capability_review(gen_random_uuid(),gen_random_uuid(),1,'Synthetic agent note','agent-review');
 EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'Agent with extra owner role recorded human review'; END IF;
 RAISE NOTICE 'PASS enrolled agent cannot review even with an extra organization administrator role';
END $$;
RESET ROLE;
SET LOCAL ROLE grimoire_migrator;
DO $$ DECLARE existing uuid; denied boolean:=false; BEGIN
 SELECT id INTO existing FROM grimoire.intake_capability_plan_reviews LIMIT 1;
 IF existing IS NOT NULL THEN
  BEGIN UPDATE grimoire.intake_capability_plan_reviews SET note='Changed historical receipt' WHERE id=existing;
  EXCEPTION WHEN SQLSTATE 'G2401' OR SQLSTATE '42501' THEN denied:=true; END;
  IF NOT denied THEN RAISE EXCEPTION 'Migration owner could mutate a review receipt'; END IF;
  RAISE NOTICE 'PASS historical receipt remains immutable even for migration owner';
 END IF;
END $$;
ROLLBACK;
