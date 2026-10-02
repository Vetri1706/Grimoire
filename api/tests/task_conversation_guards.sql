-- Restricted-runtime conversation probes; no model, provider, or website calls.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL ROLE grimoire_migrator;
DO $$ BEGIN
 IF current_database() !~ '_test$' THEN RAISE EXCEPTION 'Disposable test database required'; END IF;
 IF has_table_privilege('grimoire_intake_app','grimoire.intake_task_messages','UPDATE,DELETE,TRUNCATE') OR has_table_privilege('grimoire_intake_app','grimoire.intake_task_followups','UPDATE,DELETE,TRUNCATE') THEN RAISE EXCEPTION 'Conversation history is mutable'; END IF;
END $$;
SELECT set_config('app.request_id',gen_random_uuid()::text,true),set_config('app.effective_role','test_fixture',true),set_config('app.endpoint_scope','test:conversation',true),set_config('app.action_reason','Rollback-only conversation probes',true);
INSERT INTO grimoire.organizations(id,name) VALUES('d3550000-0000-4000-8000-000000000001','Conversation guard organization');
INSERT INTO grimoire.org_security_epochs(org_id) VALUES('d3550000-0000-4000-8000-000000000001');
INSERT INTO grimoire.principals(id,org_id,external_subject,display_name) VALUES
 ('d3550000-0000-4000-8000-000000000011','d3550000-0000-4000-8000-000000000001','test:conversation-owner','Conversation owner'),
 ('d3550000-0000-4000-8000-000000000012','d3550000-0000-4000-8000-000000000001','test:conversation-agent','Conversation agent');
INSERT INTO grimoire.principal_roles(org_id,principal_id,role) VALUES
 ('d3550000-0000-4000-8000-000000000001','d3550000-0000-4000-8000-000000000011','org_admin'),
 ('d3550000-0000-4000-8000-000000000001','d3550000-0000-4000-8000-000000000012','read_only_agent');
INSERT INTO grimoire.intake_scope_agents(org_id,principal_id) VALUES('d3550000-0000-4000-8000-000000000001','d3550000-0000-4000-8000-000000000012');
SET LOCAL ROLE grimoire_intake_app;
SELECT set_config('app.current_org_id','d3550000-0000-4000-8000-000000000001',true),set_config('app.current_principal_id','d3550000-0000-4000-8000-000000000011',true);
DO $$
DECLARE scion uuid:=gen_random_uuid();root uuid:=gen_random_uuid();child uuid:=gen_random_uuid();note uuid:=gen_random_uuid();msg uuid:=gen_random_uuid();candidate jsonb;denied boolean;
BEGIN
 INSERT INTO grimoire.intake_scions(id,org_id,created_by) VALUES(scion,app.current_org_id(),app.current_principal_id());
 INSERT INTO grimoire.intake_revisions(org_id,scion_id,number,name,product_description,product_category,change_summary,created_by)
 VALUES(app.current_org_id(),scion,1,'Conversation protocol fixture','No provider is executed by this SQL fixture.','digital','Guard fixture',app.current_principal_id());
 candidate:=app.intake_capability_candidate(scion,1);
 INSERT INTO grimoire.intake_agent_tasks(id,org_id,scion_id,scion_revision,task_kind,input,created_by,request_key,request_sha256,timeout_seconds)
 VALUES(root,app.current_org_id(),scion,1,'prepare_capability_plan',jsonb_build_object('candidate_proposal',candidate),app.current_principal_id(),root::text,repeat('a',64),120);
 INSERT INTO grimoire.intake_task_messages(id,org_id,scion_id,scion_revision,thread_task_id,author_principal_id,author_name,body,intent,request_key,request_sha256)
 VALUES(note,app.current_org_id(),scion,1,root,app.current_principal_id(),'Conversation owner','A saved note does not start work.','note','note',repeat('b',64));
 IF (SELECT count(*) FROM grimoire.intake_agent_tasks WHERE scion_id=scion)<>1 THEN RAISE EXCEPTION 'Note created an agent run'; END IF;
 INSERT INTO grimoire.intake_task_messages(id,org_id,scion_id,scion_revision,thread_task_id,author_principal_id,author_name,body,intent,request_key,request_sha256)
 VALUES(msg,app.current_org_id(),scion,1,root,app.current_principal_id(),'Conversation owner','Make the capability plan concise.','follow_up','followup',repeat('c',64));
 INSERT INTO grimoire.intake_agent_tasks(id,org_id,scion_id,scion_revision,task_kind,input,created_by,request_key,request_sha256,timeout_seconds)
 VALUES(child,app.current_org_id(),scion,1,'prepare_capability_plan',jsonb_build_object('candidate_proposal',candidate),app.current_principal_id(),child::text,repeat('d',64),120);
 denied:=false;BEGIN
  INSERT INTO grimoire.intake_task_followups VALUES(app.current_org_id(),root,root,msg,child,clock_timestamp());
 EXCEPTION WHEN SQLSTATE 'G5501' THEN denied:=true;END;
 IF NOT denied THEN RAISE EXCEPTION 'Follow-up started while root task was queued'; END IF;
 UPDATE grimoire.intake_agent_tasks SET status='cancelled',cancelled_at=clock_timestamp(),completed_at=clock_timestamp() WHERE id=root;
 denied:=false;BEGIN
  INSERT INTO grimoire.intake_task_followups VALUES(app.current_org_id(),root,root,note,child,clock_timestamp());
 EXCEPTION WHEN insufficient_privilege THEN denied:=true;END;
 IF NOT denied THEN RAISE EXCEPTION 'A plain note authorized follow-up'; END IF;
 INSERT INTO grimoire.intake_task_followups VALUES(app.current_org_id(),root,root,msg,child,clock_timestamp());
 UPDATE grimoire.intake_agent_tasks SET status='dispatched',dispatched_at=clock_timestamp() WHERE id=child;
 PERFORM set_config('app.current_principal_id','d3550000-0000-4000-8000-000000000012',true);
 denied:=false;BEGIN
  UPDATE grimoire.intake_agent_tasks SET status='running',attempt=1,claimed_by=app.current_principal_id(),claimed_at=clock_timestamp(),lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '140 seconds' WHERE id=child;
 EXCEPTION WHEN SQLSTATE 'G5502' THEN denied:=true;END;
 IF NOT denied THEN RAISE EXCEPTION 'Old worker claimed message-bound work'; END IF;
 PERFORM set_config('app.task_messages_protocol','1',true);
 UPDATE grimoire.intake_agent_tasks SET status='running',attempt=1,claimed_by=app.current_principal_id(),claimed_at=clock_timestamp(),lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '140 seconds' WHERE id=child;
 denied:=false;BEGIN
  INSERT INTO grimoire.intake_task_messages(id,org_id,scion_id,scion_revision,thread_task_id,author_principal_id,author_name,body,intent,request_key,request_sha256)
  VALUES(gen_random_uuid(),app.current_org_id(),scion,1,root,app.current_principal_id(),'Conversation agent','Agent cannot impersonate a Handler message.','note','agent-spoof',repeat('e',64));
 EXCEPTION WHEN insufficient_privilege THEN denied:=true;END;
 IF NOT denied THEN RAISE EXCEPTION 'Agent impersonated a Handler'; END IF;
 PERFORM set_config('app.current_org_id',gen_random_uuid()::text,true);
 IF EXISTS(SELECT 1 FROM grimoire.intake_task_messages WHERE id=msg) OR EXISTS(SELECT 1 FROM grimoire.intake_task_followups WHERE agent_task_id=child) THEN RAISE EXCEPTION 'Foreign thread data visible'; END IF;
 RAISE NOTICE 'PASS immutable Handler messages, notes do not run, active-task exclusion, exact native followup binding, worker capability gate and organization isolation';
END $$;
ROLLBACK;
