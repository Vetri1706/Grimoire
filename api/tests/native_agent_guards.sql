BEGIN;
SET LOCAL search_path=pg_catalog,grimoire,pg_temp;
DO $$
DECLARE table_name text; mutated boolean;
BEGIN
 IF current_database()<>'grimoire_test' THEN RAISE EXCEPTION 'Native agent guards require disposable grimoire_test'; END IF;
 FOREACH table_name IN ARRAY ARRAY['intake_managed_entities','intake_managed_revisions','intake_managed_receipts','intake_task_agent_bindings','intake_worker_presence'] LOOP
  IF has_table_privilege('grimoire_intake_app','grimoire.'||table_name,'INSERT,UPDATE,DELETE,TRUNCATE') THEN RAISE EXCEPTION 'runtime can mutate native agent data: %',table_name; END IF;
 END LOOP;
 FOREACH table_name IN ARRAY ARRAY['intake_managed_revisions','intake_managed_receipts','intake_task_agent_bindings'] LOOP
  mutated:=false;
  BEGIN
   EXECUTE format('DELETE FROM grimoire.%I',table_name);
   mutated:=true;
  EXCEPTION WHEN SQLSTATE 'G2401' THEN NULL;
  END;
  IF mutated THEN RAISE EXCEPTION 'native history was mutable or fixture missing: %',table_name; END IF;
 END LOOP;
 RAISE NOTICE 'PASS native runtime has no direct mutation grants; revisions, receipts and assignments are immutable';
END $$;
SET LOCAL ROLE grimoire_intake_app;
SELECT set_config('app.current_org_id','20000000-0000-4000-8000-000000000001',true);
SELECT set_config('app.current_principal_id','20000000-0000-4000-8000-000000000011',true);
DO $$ DECLARE table_name text; leaked bigint; BEGIN
 FOREACH table_name IN ARRAY ARRAY['intake_managed_entities','intake_managed_revisions','intake_managed_receipts','intake_task_agent_bindings','intake_worker_presence'] LOOP
  EXECUTE format('SELECT count(*) FROM grimoire.%I WHERE org_id<>app.current_org_id()',table_name) INTO leaked;
  IF leaked<>0 THEN RAISE EXCEPTION 'foreign organization native rows exposed: %',table_name; END IF;
 END LOOP;
 RAISE NOTICE 'PASS native profile, instruction, assignment and heartbeat RLS hides other organizations';
END $$;
ROLLBACK;
