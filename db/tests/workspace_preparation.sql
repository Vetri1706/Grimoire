-- Run as the local PostgreSQL operator against a disposable *_test database
-- after migration 0049. Every fixture and audit effect is rolled back.
-- This exercises real runtime-role RLS and triggers. Object metadata below is
-- synthetic; exact object bytes are covered by the HTTP/storage harness.
\set ON_ERROR_STOP on
BEGIN;
DO $$ BEGIN
 IF current_database() !~ '_test$' THEN RAISE EXCEPTION 'Disposable *_test database required'; END IF;
END $$;
SET LOCAL ROLE grimoire_migrator;
SELECT set_config('app.request_id',gen_random_uuid()::text,true),
 set_config('app.effective_role','test_fixture',true),
 set_config('app.endpoint_scope','test:workspace-preparation',true),
 set_config('app.action_reason','Rollback-only workspace preparation authorization test',true);
INSERT INTO grimoire.organizations(id,name) VALUES
 ('d3490000-0000-4000-8000-000000000001','Synthetic preparation A'),
 ('d3490000-0000-4000-8000-000000000002','Synthetic preparation B');
INSERT INTO grimoire.org_security_epochs(org_id) VALUES
 ('d3490000-0000-4000-8000-000000000001'),('d3490000-0000-4000-8000-000000000002');
INSERT INTO grimoire.principals(id,org_id,external_subject,display_name) VALUES
 ('d3490000-0000-4000-8000-000000000011','d3490000-0000-4000-8000-000000000001','test:preparation-owner','Owner'),
 ('d3490000-0000-4000-8000-000000000012','d3490000-0000-4000-8000-000000000002','test:foreign-owner','Foreign owner'),
 ('d3490000-0000-4000-8000-000000000013','d3490000-0000-4000-8000-000000000001','test:proposal-worker','Proposal worker'),
 ('d3490000-0000-4000-8000-000000000014','d3490000-0000-4000-8000-000000000001','test:existing-preparer','Existing preparer'),
 ('d3490000-0000-4000-8000-000000000015','d3490000-0000-4000-8000-000000000001','test:mixed-agent','Agent with extra owner role');
INSERT INTO grimoire.principal_roles(org_id,principal_id,role) VALUES
 ('d3490000-0000-4000-8000-000000000001','d3490000-0000-4000-8000-000000000011','org_admin'),
 ('d3490000-0000-4000-8000-000000000002','d3490000-0000-4000-8000-000000000012','org_admin'),
 ('d3490000-0000-4000-8000-000000000001','d3490000-0000-4000-8000-000000000013','read_only_agent'),
 ('d3490000-0000-4000-8000-000000000001','d3490000-0000-4000-8000-000000000014','procurement_preparer'),
 ('d3490000-0000-4000-8000-000000000001','d3490000-0000-4000-8000-000000000015','org_admin'),
 ('d3490000-0000-4000-8000-000000000001','d3490000-0000-4000-8000-000000000015','read_only_agent');
INSERT INTO grimoire.intake_scope_agents(org_id,principal_id) VALUES
 ('d3490000-0000-4000-8000-000000000001','d3490000-0000-4000-8000-000000000013');
RESET ROLE;

CREATE FUNCTION pg_temp.check_preparation(value boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF value IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF;
 RAISE NOTICE 'PASS: %',label;
END $$;
CREATE FUNCTION pg_temp.deny_preparation(command text,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 BEGIN
  EXECUTE command;
 EXCEPTION WHEN SQLSTATE '42501' OR SQLSTATE 'G2901' THEN
  RAISE NOTICE 'PASS: %',label; RETURN;
 END;
 RAISE EXCEPTION 'FAIL: expected denial: %',label;
END $$;
SET LOCAL ROLE grimoire_intake_app;
SELECT set_config('app.current_org_id','d3490000-0000-4000-8000-000000000001',true),
 set_config('app.current_principal_id','d3490000-0000-4000-8000-000000000011',true),
 set_config('app.effective_role','org_admin',true);
SELECT pg_temp.check_preparation(app.intake_can_prepare_workspace() AND NOT app.intake_can_write()
 AND NOT app.intake_scope_can_propose() AND NOT app.intake_scope_can_confirm() AND NOT app.intake_scope_is_agent(),
 'owner gains preparation only, no procurement/scope/approval role');
INSERT INTO grimoire.intake_scions(id,org_id,created_by) VALUES
 ('d3490000-0000-4000-8000-000000000021',app.current_org_id(),app.current_principal_id()),
 ('d3490000-0000-4000-8000-000000000022',app.current_org_id(),app.current_principal_id());
INSERT INTO grimoire.intake_revisions(org_id,scion_id,number,name,product_description,product_category,change_summary,created_by) VALUES
 (app.current_org_id(),'d3490000-0000-4000-8000-000000000021',1,'Synthetic website','A synthetic class booking website','digital','Test initial revision',app.current_principal_id()),
 (app.current_org_id(),'d3490000-0000-4000-8000-000000000022',1,'Synthetic physical case','A synthetic physical scope','physical','Test initial revision',app.current_principal_id());
SELECT pg_temp.check_preparation(app.intake_can_control_preparation('d3490000-0000-4000-8000-000000000021',1,'prepare_capability_plan')
 AND NOT app.intake_can_control_preparation('d3490000-0000-4000-8000-000000000022',1,'prepare_capability_plan')
 AND NOT app.intake_can_control_preparation('d3490000-0000-4000-8000-000000000022',1,'prepare_physical_scope')
 AND NOT app.intake_can_control_preparation('d3490000-0000-4000-8000-000000000022',1,'prepare_offer_normalization')
 AND NOT app.intake_can_control_preparation('d3490000-0000-4000-8000-000000000021',1,'unknown'),
 'owner controls only supported digital capability work');

INSERT INTO grimoire.intake_sources(id,org_id,scion_id,scion_revision,created_by) VALUES
 ('d3490000-0000-4000-8000-000000000031',app.current_org_id(),'d3490000-0000-4000-8000-000000000021',1,app.current_principal_id());
DO $$ DECLARE n integer; BEGIN
 FOR n IN 1..2 LOOP
  INSERT INTO grimoire.intake_source_objects(org_id,source_id,source_revision,object_bucket,object_key,object_version_id,content_sha256,byte_length,recorded_by)
  VALUES(app.current_org_id(),'d3490000-0000-4000-8000-000000000031',n,'synthetic-test',
   'org/'||app.current_org_id()||'/sources/d3490000-0000-4000-8000-000000000031/revisions/'||n||'/fixture',
   'synthetic-'||n,encode(public.digest('Synthetic note','sha256'),'hex'),14,app.current_principal_id());
  INSERT INTO grimoire.intake_source_revisions(org_id,source_id,number,title,origin,owner,synthetic,source_text,content_sha256,byte_length,rights_status,permission_basis,permitted_use,change_summary,created_by)
  VALUES(app.current_org_id(),'d3490000-0000-4000-8000-000000000031',n,'Synthetic note','synthetic://preparation','Synthetic owner',true,NULL,
   encode(public.digest('Synthetic note','sha256'),'hex'),14,'granted','Authored synthetic fixture','scion_review','Synthetic test revision',app.current_principal_id());
 END LOOP;
END $$;
INSERT INTO grimoire.intake_source_claims(id,org_id,source_id,source_revision,statement,start_byte,end_byte,quote,created_by)
 VALUES('d3490000-0000-4000-8000-000000000032',app.current_org_id(),'d3490000-0000-4000-8000-000000000031',2,'An unverified synthetic claim',0,14,'Synthetic note',app.current_principal_id());
SELECT pg_temp.check_preparation((SELECT current_revision=2 FROM grimoire.intake_sources WHERE id='d3490000-0000-4000-8000-000000000031')
 AND (SELECT count(*)=1 FROM grimoire.intake_source_claims WHERE source_id='d3490000-0000-4000-8000-000000000031'),
 'owner creates object-backed source, revises it and records an exact-sized claim');

DO $$ DECLARE agent_id uuid; BEGIN
 agent_id:=(app.intake_save_managed('agent',NULL,NULL,
  '{"name":"Synthetic planner","role":"planner","title":"","capabilities":"","instructions":"Prepare drafts only","reports_to":null,"adapter":"codex_cli","timeout_seconds":120,"skill_ids":[],"paused":false}',
  'workspace-preparation-agent')->>'id')::uuid;
 INSERT INTO grimoire.intake_agent_tasks(id,org_id,scion_id,scion_revision,task_kind,input,created_by,request_key,request_sha256,timeout_seconds)
 VALUES('d3490000-0000-4000-8000-000000000041',app.current_org_id(),'d3490000-0000-4000-8000-000000000021',1,'prepare_capability_plan',
  jsonb_build_object('candidate_proposal',app.intake_capability_candidate('d3490000-0000-4000-8000-000000000021',1)),app.current_principal_id(),'digital-task',repeat('a',64),120);
 PERFORM app.intake_bind_agent_task('d3490000-0000-4000-8000-000000000041',agent_id);
 PERFORM app.intake_bind_agent_task('d3490000-0000-4000-8000-000000000041',agent_id);
 PERFORM pg_temp.check_preparation((SELECT count(*)=1 FROM grimoire.intake_task_agent_bindings WHERE task_id='d3490000-0000-4000-8000-000000000041'),
  'owner queues and assigns a capability task; assignment retry is idempotent');
END $$;
SELECT pg_temp.deny_preparation($command$
 INSERT INTO grimoire.intake_agent_tasks(id,org_id,scion_id,scion_revision,task_kind,input,created_by,request_key,request_sha256,timeout_seconds)
 VALUES('d3490000-0000-4000-8000-000000000049',app.current_org_id(),'d3490000-0000-4000-8000-000000000022',1,'prepare_physical_scope',
  '{"candidate_proposal":{"synthetic":true}}',app.current_principal_id(),'forbidden-physical',repeat('b',64),120)
$command$,'direct runtime-role physical task insertion is denied');
UPDATE grimoire.intake_agent_tasks SET status='dispatched',dispatched_at=clock_timestamp() WHERE id='d3490000-0000-4000-8000-000000000041';
SELECT pg_temp.check_preparation((SELECT status='dispatched' FROM grimoire.intake_agent_tasks WHERE id='d3490000-0000-4000-8000-000000000041'),'owner explicitly dispatches capability task');
SELECT pg_temp.deny_preparation($command$
 UPDATE grimoire.intake_agent_tasks SET status='running',attempt=1,claimed_by=app.current_principal_id(),claimed_at=clock_timestamp(),
  lease_token='d3490000-0000-4000-8000-000000000051',lease_until=clock_timestamp()+interval '120 seconds'
 WHERE id='d3490000-0000-4000-8000-000000000041'
$command$,'owner cannot claim worker execution');

SELECT set_config('app.current_principal_id','d3490000-0000-4000-8000-000000000013',true),set_config('app.effective_role','agent',true);
SELECT pg_temp.check_preparation(NOT app.intake_can_prepare_workspace() AND app.intake_scope_can_propose(),'proposal worker has no workspace preparation authority');
UPDATE grimoire.intake_agent_tasks SET status='running',attempt=1,claimed_by=app.current_principal_id(),claimed_at=clock_timestamp(),
 lease_token='d3490000-0000-4000-8000-000000000051',lease_until=clock_timestamp()+interval '120 seconds'
 WHERE id='d3490000-0000-4000-8000-000000000041';
SELECT set_config('app.agent_task_id','d3490000-0000-4000-8000-000000000041',true),set_config('app.agent_task_lease','d3490000-0000-4000-8000-000000000051',true);
INSERT INTO grimoire.intake_capability_plans(id,org_id,scion_id,scion_revision,agent_task_id,input,created_by,request_key,request_sha256)
 VALUES('d3490000-0000-4000-8000-000000000061',app.current_org_id(),'d3490000-0000-4000-8000-000000000021',1,'d3490000-0000-4000-8000-000000000041',
  jsonb_build_object('synthetic',true,'summary','Synthetic protocol result, not a provider run','capabilities',
   '[{"key":"booking","title":"Booking","reason":"Synthetic intake asks for booking","evidence_needed":["Review authorized notes"],"connector_ids":["handler_intake","scion_sources"]}]'::jsonb,
   'unresolved_gaps',app.intake_capability_candidate('d3490000-0000-4000-8000-000000000021',1)->'unresolved_gaps','change_summary','Synthetic leased proposal fixture'),
  app.current_principal_id(),'synthetic-plan',repeat('c',64));
UPDATE grimoire.intake_agent_tasks SET status='completed',completed_at=clock_timestamp(),proposal_id='d3490000-0000-4000-8000-000000000061',
 output_sha256=repeat('d',64),preparation_note='Synthetic protocol fixture; no provider execution or approval' WHERE id='d3490000-0000-4000-8000-000000000041';

SELECT set_config('app.current_principal_id','d3490000-0000-4000-8000-000000000011',true),set_config('app.effective_role','org_admin',true);
INSERT INTO grimoire.intake_evidence_comparisons(id,org_id,scion_id,scion_revision,plan_id,input,created_by,request_key,request_sha256)
 VALUES('d3490000-0000-4000-8000-000000000071',app.current_org_id(),'d3490000-0000-4000-8000-000000000021',1,'d3490000-0000-4000-8000-000000000061',
 '{"synthetic":true,"plan_id":"d3490000-0000-4000-8000-000000000061","alternatives":[{"label":"Synthetic option A","criteria":[{"capability_key":"booking","claim_ids":["d3490000-0000-4000-8000-000000000032"]}]},{"label":"Synthetic option B","criteria":[{"capability_key":"booking","claim_ids":[]}]}],"unresolved_gaps":["No external evidence"],"change_summary":"Draft review comparison only"}',
 app.current_principal_id(),'comparison',repeat('e',64));
SELECT pg_temp.check_preparation((SELECT count(*)=1 FROM grimoire.intake_evidence_comparisons WHERE id='d3490000-0000-4000-8000-000000000071')
 AND NOT app.intake_scope_can_confirm() AND NOT app.intake_can_write(),'owner saves comparison after leased completion without obtaining approval authority');
INSERT INTO grimoire.intake_source_revocations(org_id,source_id,source_revision,reason,created_by)
 VALUES(app.current_org_id(),'d3490000-0000-4000-8000-000000000031',2,'Synthetic source permission withdrawn',app.current_principal_id());
SELECT pg_temp.check_preparation((SELECT count(*)=0 FROM grimoire.intake_source_revisions WHERE source_id='d3490000-0000-4000-8000-000000000031')
 AND (SELECT count(*)=0 FROM grimoire.intake_source_claims WHERE source_id='d3490000-0000-4000-8000-000000000031')
 AND (SELECT blocked AND stale FROM grimoire.intake_watch_node_states WHERE node_id='d3490000-0000-4000-8000-000000000071' AND node_kind='comparison'),
 'owner revocation hides source/claims and blocks dependent comparison');

SELECT set_config('app.current_principal_id','d3490000-0000-4000-8000-000000000015',true);
SELECT pg_temp.check_preparation(NOT app.intake_can_prepare_workspace() AND NOT app.intake_can_control_preparation('d3490000-0000-4000-8000-000000000021',1,'prepare_capability_plan'),
 'adding org_admin to an agent never grants human preparation');
SELECT set_config('app.current_principal_id','d3490000-0000-4000-8000-000000000014',true);
SELECT pg_temp.check_preparation(app.intake_can_write() AND app.intake_can_control_preparation('d3490000-0000-4000-8000-000000000022',1,'prepare_physical_scope')
 AND app.intake_can_control_preparation('d3490000-0000-4000-8000-000000000022',1,'prepare_offer_normalization'),
 'existing procurement preparer retains physical/offer controls');
SELECT set_config('app.current_org_id','d3490000-0000-4000-8000-000000000002',true),set_config('app.current_principal_id','d3490000-0000-4000-8000-000000000012',true);
SELECT pg_temp.check_preparation(NOT app.intake_can_control_preparation('d3490000-0000-4000-8000-000000000021',1,'prepare_capability_plan')
 AND (SELECT count(*)=0 FROM grimoire.intake_scions WHERE id='d3490000-0000-4000-8000-000000000021')
 AND (SELECT count(*)=0 FROM grimoire.intake_agent_tasks WHERE id='d3490000-0000-4000-8000-000000000041')
 AND (SELECT count(*)=0 FROM grimoire.intake_watch_reviews WHERE scion_id='d3490000-0000-4000-8000-000000000021'),
 'foreign organization cannot authorize or read tasks, Scions or alerts');
RESET ROLE;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
\echo WORKSPACE_PREPARATION_GUARDS_PASS
