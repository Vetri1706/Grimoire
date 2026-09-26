-- Supplemental database invariants. This rollback-only script never substitutes
-- for the real Rust HTTP, PostgreSQL 17, MinIO, and MCP acceptance harness.
BEGIN;
SET LOCAL search_path=pg_catalog,grimoire,pg_temp;
SELECT set_config('app.current_org_id','10000000-0000-4000-8000-000000000001',true);
SELECT set_config('app.current_principal_id','10000000-0000-4000-8000-000000000011',true);
SELECT set_config('app.request_id',gen_random_uuid()::text,true);
SELECT set_config('app.effective_role','procurement_preparer',true);
SELECT set_config('app.endpoint_scope','local:adaptive-guards',true);
SELECT set_config('app.action_reason','Rollback-only synthetic adaptive proposal invariant checks',true);
DO $$
DECLARE scion uuid:=gen_random_uuid(); task uuid:=gen_random_uuid(); lease uuid:=gen_random_uuid();
 plan uuid:=gen_random_uuid(); comparison uuid:=gen_random_uuid(); candidate jsonb; proposal jsonb; comparison_input jsonb;
 table_name text; action text;
BEGIN
 IF current_database() NOT LIKE '%\_test' ESCAPE '\' THEN RAISE EXCEPTION 'adaptive guards require a disposable _test database'; END IF;
 INSERT INTO grimoire.intake_scions(id,org_id,created_by)
 VALUES(scion,app.current_org_id(),app.current_principal_id());
 INSERT INTO grimoire.intake_revisions(org_id,scion_id,number,name,product_description,product_category,change_summary,created_by)
 VALUES(app.current_org_id(),scion,1,'Synthetic SQL adaptive website','Handler needs an editable synthetic workshop website.','digital','Rollback-only invariant setup',app.current_principal_id());
 candidate:=app.intake_capability_candidate(scion,1);
 proposal:=jsonb_build_object('synthetic',true,'summary','Synthetic website capability preparation',
   'capabilities',jsonb_build_array(jsonb_build_object('key','content_editing','title','Editable content','reason','Handler wants to maintain the site.',
     'evidence_needed',jsonb_build_array('Authorized demonstration of the editing workflow'),'connector_ids',jsonb_build_array('handler_intake','scion_sources'))),
   'unresolved_gaps',candidate->'unresolved_gaps','change_summary','Synthetic SQL lease guard check');
 IF NOT app.intake_capability_matches(candidate,proposal) THEN RAISE EXCEPTION 'valid synthetic capability proposal rejected'; END IF;
 IF app.intake_capability_matches(candidate,jsonb_set(proposal,'{unresolved_gaps}','[]')) THEN RAISE EXCEPTION 'SQL accepted omitted evidence gaps'; END IF;
 IF app.intake_capability_matches(candidate,jsonb_set(proposal,'{capabilities,0,connector_ids}','["invented_provider"]')) THEN RAISE EXCEPTION 'SQL accepted invented connector'; END IF;
 INSERT INTO grimoire.intake_agent_tasks(id,org_id,scion_id,scion_revision,task_kind,input,created_by,request_key,request_sha256,timeout_seconds)
 VALUES(task,app.current_org_id(),scion,1,'prepare_capability_plan',jsonb_build_object('candidate_proposal',candidate),app.current_principal_id(),task::text,repeat('a',64),240);
 UPDATE grimoire.intake_agent_tasks SET status='dispatched',dispatched_at=clock_timestamp() WHERE id=task;
 PERFORM set_config('app.current_principal_id','10000000-0000-4000-8000-000000000018',true);
 UPDATE grimoire.intake_agent_tasks SET status='running',attempt=1,claimed_by=app.current_principal_id(),claimed_at=clock_timestamp(),lease_token=lease,lease_until=clock_timestamp()+interval '270 seconds' WHERE id=task;
 PERFORM set_config('app.agent_task_id',task::text,true);
 PERFORM set_config('app.agent_task_lease',lease::text,true);
 INSERT INTO grimoire.intake_capability_plans(id,org_id,scion_id,scion_revision,agent_task_id,input,created_by,request_key,request_sha256)
 VALUES(plan,app.current_org_id(),scion,1,task,proposal,app.current_principal_id(),plan::text,repeat('b',64));
 comparison_input:=jsonb_build_object('synthetic',true,'plan_id',plan,
   'alternatives',jsonb_build_array(
     jsonb_build_object('label','Synthetic approach A','criteria',jsonb_build_array(jsonb_build_object('capability_key','content_editing','claim_ids','[]'::jsonb))),
     jsonb_build_object('label','Synthetic approach B','criteria',jsonb_build_array(jsonb_build_object('capability_key','content_editing','claim_ids','[]'::jsonb)))),
   'unresolved_gaps',jsonb_build_array('No authorized provider evidence is present.'),'change_summary','Synthetic comparison draft with explicit missing evidence');
 BEGIN
   INSERT INTO grimoire.intake_evidence_comparisons(id,org_id,scion_id,scion_revision,plan_id,input,created_by,request_key,request_sha256)
   VALUES(comparison,app.current_org_id(),scion,1,plan,comparison_input,app.current_principal_id(),comparison::text,repeat('c',64));
   RAISE EXCEPTION 'agent created Handler evidence review';
 EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
 PERFORM set_config('app.current_principal_id','10000000-0000-4000-8000-000000000011',true);
 BEGIN
   INSERT INTO grimoire.intake_capability_plans(id,org_id,scion_id,scion_revision,agent_task_id,input,created_by,request_key,request_sha256)
   VALUES(gen_random_uuid(),app.current_org_id(),scion,1,task,proposal,app.current_principal_id(),gen_random_uuid()::text,repeat('d',64));
   RAISE EXCEPTION 'Handler bypassed agent plan provenance';
 EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
 INSERT INTO grimoire.intake_evidence_comparisons(id,org_id,scion_id,scion_revision,plan_id,input,created_by,request_key,request_sha256)
 VALUES(comparison,app.current_org_id(),scion,1,plan,comparison_input,app.current_principal_id(),comparison::text,repeat('c',64));
 FOREACH table_name IN ARRAY ARRAY['intake_capability_plans','intake_evidence_comparisons'] LOOP
   FOREACH action IN ARRAY ARRAY['UPDATE','DELETE'] LOOP
     BEGIN
       IF action='UPDATE' THEN EXECUTE format('UPDATE grimoire.%I SET created_at=created_at WHERE scion_id=$1',table_name) USING scion;
       ELSE EXECUTE format('DELETE FROM grimoire.%I WHERE scion_id=$1',table_name) USING scion;
       END IF;
       RAISE EXCEPTION '% % unexpectedly allowed',action,table_name;
     EXCEPTION WHEN SQLSTATE 'G2401' THEN NULL; END;
   END LOOP;
   IF has_table_privilege('grimoire_intake_app','grimoire.'||table_name,'UPDATE,DELETE,TRUNCATE') THEN
     RAISE EXCEPTION 'runtime can rewrite immutable adaptive table %',table_name;
   END IF;
 END LOOP;
 PERFORM set_config('test.adaptive_scion_id',scion::text,true);
 RAISE NOTICE 'PASS: immutable adaptive plans/comparisons, no agent review, no Handler impersonation of agent proposal, pinned leased task, required evidence gaps, actual connector IDs, bounded runtime grants';
END $$;
SET LOCAL ROLE grimoire_intake_app;
SELECT set_config('app.current_org_id','20000000-0000-4000-8000-000000000001',true);
SELECT set_config('app.current_principal_id','20000000-0000-4000-8000-000000000011',true);
DO $$
BEGIN
 IF EXISTS(SELECT 1 FROM grimoire.intake_capability_plans WHERE scion_id=current_setting('test.adaptive_scion_id')::uuid) OR
    EXISTS(SELECT 1 FROM grimoire.intake_evidence_comparisons WHERE scion_id=current_setting('test.adaptive_scion_id')::uuid) THEN
   RAISE EXCEPTION 'runtime cross-organization RLS exposed adaptive history';
 END IF;
 RAISE NOTICE 'PASS: adaptive plan and comparison history hidden by runtime organization RLS';
END $$;
ROLLBACK;
