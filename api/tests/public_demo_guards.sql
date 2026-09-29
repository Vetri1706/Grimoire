-- Migration-owner checks on an explicitly disposable *_test database after
-- scripts/seed-judge-demo.mjs has published its three synthetic fixtures.
-- Every attempted change below rolls back.
BEGIN;
SET LOCAL search_path=pg_catalog,grimoire,pg_temp;
SELECT set_config('app.request_id',gen_random_uuid()::text,true),
       set_config('app.effective_role','local_setup',true),
       set_config('app.endpoint_scope','test:public-judge-demo',true),
       set_config('app.action_reason','Rollback-only public demo security guards',true);
DO $$
DECLARE denied boolean; selected_scion uuid;
BEGIN
 IF current_database() NOT LIKE '%\_test' ESCAPE '\' THEN
  RAISE EXCEPTION 'Public demo guards require a disposable _test database';
 END IF;
 IF has_table_privilege('grimoire_intake_app','grimoire.intake_public_demo_scenarios','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') THEN
  RAISE EXCEPTION 'runtime has direct public demo registry privileges';
 END IF;
 IF (SELECT count(*) FROM app.intake_public_demo_scenarios())<>3 THEN
  RAISE EXCEPTION 'Seed the three public synthetic scenarios before running these guards';
 END IF;
 SELECT scion_id INTO selected_scion FROM app.intake_public_demo_scenarios() WHERE slug='current';
 denied:=false;
 BEGIN
  UPDATE grimoire.intake_public_demo_scenarios SET org_id=gen_random_uuid() WHERE slug='current';
 EXCEPTION WHEN check_violation OR foreign_key_violation THEN denied:=true;
 END;
 IF NOT denied THEN RAISE EXCEPTION 'private organization was publishable'; END IF;
 INSERT INTO grimoire.principal_roles(org_id,principal_id,role)
 VALUES('d3400000-0000-4000-8000-000000000001','d3400000-0000-4000-8000-000000000002','org_admin');
 IF EXISTS(SELECT 1 FROM app.intake_public_demo_scenarios()) THEN
  RAISE EXCEPTION 'demo reader privilege drift did not fail closed';
 END IF;
 DELETE FROM grimoire.principal_roles
  WHERE principal_id='d3400000-0000-4000-8000-000000000002' AND role='org_admin';
 INSERT INTO grimoire.intake_scope_agents(org_id,principal_id)
 VALUES('d3400000-0000-4000-8000-000000000001','d3400000-0000-4000-8000-000000000002');
 IF EXISTS(SELECT 1 FROM app.intake_public_demo_scenarios()) THEN
  RAISE EXCEPTION 'demo reader proposal enrollment did not fail closed';
 END IF;
 DELETE FROM grimoire.intake_scope_agents WHERE principal_id='d3400000-0000-4000-8000-000000000002';
 PERFORM set_config('app.current_org_id','d3400000-0000-4000-8000-000000000001',true);
 PERFORM set_config('app.current_principal_id','d3400000-0000-4000-8000-000000000002',true);
 IF app.intake_public_demo_readable(selected_scion) THEN
  RAISE EXCEPTION 'public no-lock helper accepted a writable transaction';
 END IF;
 RAISE NOTICE 'PASS registry has no runtime privileges; private publication, elevated reader and proposal enrollment fail closed';
END $$;
SET LOCAL ROLE grimoire_intake_app;
DO $$
DECLARE denied boolean:=false;
BEGIN
 BEGIN DELETE FROM grimoire.intake_public_demo_scenarios;
 EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'runtime changed publication registry'; END IF;
 PERFORM set_config('app.current_org_id',gen_random_uuid()::text,true);
 IF EXISTS(SELECT 1 FROM grimoire.intake_scions)
 OR EXISTS(SELECT 1 FROM grimoire.intake_revisions)
 OR EXISTS(SELECT 1 FROM grimoire.intake_watch_events)
 OR EXISTS(SELECT 1 FROM grimoire.intake_watch_dependencies)
 OR EXISTS(SELECT 1 FROM grimoire.intake_watch_reviews) THEN
  RAISE EXCEPTION 'foreign organization could read case nodes, edges, events or alerts';
 END IF;
 RAISE NOTICE 'PASS runtime cannot mutate registry; foreign organization context has no graph or alert access';
END $$;
ROLLBACK;

BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL search_path=pg_catalog,grimoire,pg_temp;
SET LOCAL ROLE grimoire_intake_app;
SELECT set_config('app.current_org_id','d3400000-0000-4000-8000-000000000001',true),
       set_config('app.current_principal_id','d3400000-0000-4000-8000-000000000002',true);
DO $$
DECLARE scenario record; source record; denied boolean:=false;
BEGIN
 IF app.intake_can_write() OR app.intake_can_manage_workspace()
 OR app.intake_scope_can_propose() OR app.intake_scope_can_confirm() THEN
  RAISE EXCEPTION 'public reader gained write, proposal or approval authority';
 END IF;
 IF app.intake_public_demo_readable(gen_random_uuid()) THEN
  RAISE EXCEPTION 'unregistered identifier accepted by public no-lock helper';
 END IF;
 FOR scenario IN SELECT * FROM app.intake_public_demo_scenarios() LOOP
  IF NOT app.intake_public_demo_readable(scenario.scion_id)
  OR app.intake_scope_lock_scion(scenario.scion_id) IS NULL THEN
   RAISE EXCEPTION 'registered scenario unavailable in read-only snapshot';
  END IF;
  FOR source IN SELECT id FROM grimoire.intake_sources WHERE scion_id=scenario.scion_id LOOP
   IF app.intake_source_read_lock(scenario.scion_id,source.id) IS NULL THEN
    RAISE EXCEPTION 'source cannot be read in public read-only snapshot';
   END IF;
  END LOOP;
 END LOOP;
 BEGIN UPDATE grimoire.intake_scions SET updated_at=clock_timestamp() WHERE false;
 EXCEPTION WHEN read_only_sql_transaction THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'public snapshot allowed a database write'; END IF;
 IF EXISTS(SELECT 1 FROM grimoire.intake_scions WHERE org_id<>app.current_org_id()) THEN
  RAISE EXCEPTION 'public reader sees another organization';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM grimoire.intake_source_revocations) THEN
  RAISE EXCEPTION 'revoked scenario has no real permission revocation';
 END IF;
 IF EXISTS(SELECT 1 FROM grimoire.intake_source_revisions r
   JOIN grimoire.intake_source_revocations v ON (v.org_id,v.source_id)=(r.org_id,r.source_id))
 OR EXISTS(SELECT 1 FROM grimoire.intake_source_claims c
   JOIN grimoire.intake_source_revocations v ON (v.org_id,v.source_id)=(c.org_id,c.source_id)) THEN
  RAISE EXCEPTION 'public reader can see revoked content or claims';
 END IF;
 RAISE NOTICE 'PASS public snapshot reads registered state without write capability or cross-organization access';
END $$;
ROLLBACK;

BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL search_path=pg_catalog,grimoire,pg_temp;
SET LOCAL ROLE grimoire_intake_app;
SELECT set_config('app.current_org_id','d3400000-0000-4000-8000-000000000001',true),
       set_config('app.current_principal_id','d3400000-0000-4000-8000-000000000003',true);
DO $$
DECLARE denied boolean:=false; selected_scion uuid;
BEGIN
 SELECT scion_id INTO selected_scion FROM app.intake_public_demo_scenarios() WHERE slug='current';
 IF app.intake_public_demo_readable(selected_scion) THEN
  RAISE EXCEPTION 'another principal borrowed the public no-lock path';
 END IF;
 BEGIN PERFORM app.intake_scope_lock_scion(selected_scion);
 EXCEPTION WHEN read_only_sql_transaction THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'ordinary reader no longer uses its locking path'; END IF;
 RAISE NOTICE 'PASS ordinary authenticated reads retain row locking; no public lock bypass';
END $$;
ROLLBACK;
