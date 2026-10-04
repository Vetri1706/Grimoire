-- Read/write authorization probes run as the runtime role; all fixture rows roll back.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL search_path=pg_catalog,grimoire,pg_temp;
SET LOCAL ROLE grimoire_migrator;
DO $$ DECLARE table_name text; BEGIN
 IF current_database() !~ '_test$' THEN RAISE EXCEPTION 'Disposable test database required'; END IF;
 FOREACH table_name IN ARRAY ARRAY['intake_research_captures','intake_research_capture_revocations','intake_research_reports','intake_research_reviews'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=('grimoire.'||table_name)::regclass AND relrowsecurity) THEN RAISE EXCEPTION 'Research RLS disabled: %',table_name; END IF;
  IF has_table_privilege('grimoire_intake_app','grimoire.'||table_name,'UPDATE,DELETE,TRUNCATE') THEN RAISE EXCEPTION 'Runtime can rewrite research history: %',table_name; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
 WHERE n.nspname='app' AND p.proname LIKE 'intake_research_%' AND a.grantee=0 AND a.privilege_type='EXECUTE') THEN RAISE EXCEPTION 'Public research function exposure'; END IF;
END $$;
SELECT set_config('app.request_id',gen_random_uuid()::text,true),set_config('app.effective_role','test_fixture',true),set_config('app.endpoint_scope','test:research',true),set_config('app.action_reason','Rollback-only research authorization probes',true);
INSERT INTO grimoire.organizations(id,name) VALUES('d3520000-0000-4000-8000-000000000001','Research guard organization');
INSERT INTO grimoire.org_security_epochs(org_id) VALUES('d3520000-0000-4000-8000-000000000001');
INSERT INTO grimoire.principals(id,org_id,external_subject,display_name) VALUES
 ('d3520000-0000-4000-8000-000000000011','d3520000-0000-4000-8000-000000000001','test:research-owner','Research owner'),
 ('d3520000-0000-4000-8000-000000000012','d3520000-0000-4000-8000-000000000001','test:research-agent','Research agent');
INSERT INTO grimoire.principal_roles(org_id,principal_id,role) VALUES
 ('d3520000-0000-4000-8000-000000000001','d3520000-0000-4000-8000-000000000011','org_admin'),
 ('d3520000-0000-4000-8000-000000000001','d3520000-0000-4000-8000-000000000012','org_admin'),
 ('d3520000-0000-4000-8000-000000000001','d3520000-0000-4000-8000-000000000012','read_only_agent');
INSERT INTO grimoire.intake_scope_agents(org_id,principal_id) VALUES('d3520000-0000-4000-8000-000000000001','d3520000-0000-4000-8000-000000000012');
SET LOCAL ROLE grimoire_intake_app;
SELECT set_config('app.current_org_id','d3520000-0000-4000-8000-000000000001',true),set_config('app.current_principal_id','d3520000-0000-4000-8000-000000000011',true);
DO $$ DECLARE candidate jsonb; denied boolean; BEGIN
 IF EXISTS(SELECT 1 FROM grimoire.intake_research_reports) OR EXISTS(SELECT 1 FROM grimoire.intake_research_captures) OR EXISTS(SELECT 1 FROM grimoire.intake_research_reviews) THEN RAISE EXCEPTION 'Foreign research data visible'; END IF;
 candidate:=jsonb_build_object('synthetic',false,'objective','Public procurement overview','consent',true,'policy_version','public-web-research-v1','worker_connection_id',gen_random_uuid());
 IF NOT app.intake_research_candidate_valid(candidate) OR app.intake_research_candidate_valid(candidate||'{"consent":false}') OR app.intake_research_candidate_valid(candidate||'{"synthetic":true}') OR app.intake_research_candidate_valid(candidate||'{"private_sources":[]}') THEN RAISE EXCEPTION 'Research consent shape not enforced'; END IF;
 IF app.intake_research_connection(candidate,false) THEN RAISE EXCEPTION 'Unknown computer authorized'; END IF;
 IF app.intake_research_report_valid(gen_random_uuid(),'{"synthetic":false}') THEN RAISE EXCEPTION 'Malformed report accepted'; END IF;
 denied:=false;BEGIN PERFORM app.intake_research_assert_task(gen_random_uuid(),gen_random_uuid());EXCEPTION WHEN SQLSTATE 'G2901' THEN denied:=true;END;
 IF NOT denied THEN RAISE EXCEPTION 'Human or unknown lease accepted'; END IF;
 denied:=false;BEGIN DELETE FROM grimoire.intake_research_reports;EXCEPTION WHEN insufficient_privilege THEN denied:=true;END;
 IF NOT denied THEN RAISE EXCEPTION 'Research report deletion allowed'; END IF;
 RAISE NOTICE 'PASS research foreign organization RLS, explicit consent, unavailable worker, malformed report, lease and immutable-history guards';
END $$;
SELECT set_config('app.current_principal_id','d3520000-0000-4000-8000-000000000012',true);
DO $$ DECLARE denied boolean:=false; BEGIN
 BEGIN INSERT INTO grimoire.intake_research_reviews(id,org_id,report_id,reviewer_id,note,request_key)
 VALUES(gen_random_uuid(),app.current_org_id(),gen_random_uuid(),app.current_principal_id(),'Agent cannot review','agent-denied');
 EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'Agent with extra admin role could record human review'; END IF;
 RAISE NOTICE 'PASS agent cannot review research even with extra administrator role';
END $$;
RESET ROLE;
SET LOCAL ROLE grimoire_migrator;
INSERT INTO grimoire.handler_identities(id,login_name,display_name,password_hash) VALUES
 ('d3520000-0000-4000-8000-000000000021','research_guard_fixture','Research guard fixture',public.crypt('rollback-only fixture passphrase',public.gen_salt('bf',4)));
INSERT INTO grimoire.intake_credentials(token_sha256,org_id,principal_id,label)
 VALUES(repeat('f',64),'d3520000-0000-4000-8000-000000000001','d3520000-0000-4000-8000-000000000012','Rollback-only research credential fixture');
INSERT INTO grimoire.intake_worker_connections(id,org_id,principal_id,device_name,credential_sha256,approved_by,approved_principal,approved_at,policy_version,content_class)
 VALUES('d3520000-0000-4000-8000-000000000031','d3520000-0000-4000-8000-000000000001','d3520000-0000-4000-8000-000000000012','Rollback-only computer',repeat('f',64),'d3520000-0000-4000-8000-000000000021','d3520000-0000-4000-8000-000000000011',clock_timestamp(),'codex-synthetic-v1','synthetic_only');
SET LOCAL ROLE grimoire_intake_app;
SELECT set_config('app.current_principal_id','d3520000-0000-4000-8000-000000000011',true);
DO $$
DECLARE scion uuid:=gen_random_uuid();task uuid:=gen_random_uuid();capture uuid:=gen_random_uuid();report uuid:=gen_random_uuid();lease uuid:=gen_random_uuid();
 candidate jsonb;body jsonb;denied boolean;cancel_task uuid:=gen_random_uuid();
 child uuid;parent uuid;child_done uuid;child_running uuid;child_report uuid;message uuid;followup_body jsonb;idx integer;
BEGIN
 INSERT INTO grimoire.intake_scions(id,org_id,created_by) VALUES(scion,app.current_org_id(),app.current_principal_id());
 INSERT INTO grimoire.intake_revisions(org_id,scion_id,number,name,product_description,product_category,change_summary,created_by)
 VALUES(app.current_org_id(),scion,1,'Rollback research protocol case','No provider or website is called by this SQL protocol fixture.','digital','Guard fixture',app.current_principal_id());
 candidate:=jsonb_build_object('synthetic',false,'objective','Public process overview','consent',true,'policy_version','public-web-research-v1','worker_connection_id','d3520000-0000-4000-8000-000000000031');
 INSERT INTO grimoire.intake_agent_tasks(id,org_id,scion_id,scion_revision,task_kind,input,created_by,request_key,request_sha256,timeout_seconds)
 VALUES(task,app.current_org_id(),scion,1,'research_public_web',jsonb_build_object('candidate_proposal',candidate),app.current_principal_id(),task::text,repeat('a',64),240);
 UPDATE grimoire.intake_agent_tasks SET status='dispatched',dispatched_at=clock_timestamp() WHERE id=task;
 PERFORM set_config('app.current_principal_id','d3520000-0000-4000-8000-000000000012',true);
 UPDATE grimoire.intake_agent_tasks SET status='running',attempt=1,claimed_by=app.current_principal_id(),claimed_at=clock_timestamp(),lease_token=lease,lease_until=clock_timestamp()+interval '270 seconds' WHERE id=task;
 PERFORM set_config('app.agent_task_id',task::text,true);PERFORM set_config('app.agent_task_lease',lease::text,true);
 PERFORM app.intake_research_assert_task(task,lease);
 denied:=false;BEGIN PERFORM app.intake_research_assert_task(task,gen_random_uuid());EXCEPTION WHEN SQLSTATE 'G2901' THEN denied:=true;END;
 IF NOT denied THEN RAISE EXCEPTION 'Wrong research lease accepted'; END IF;
 -- Failed receipt deliberately contains no website bytes; this is not a live fetch claim.
 INSERT INTO grimoire.intake_research_captures(id,org_id,scion_id,scion_revision,agent_task_id,requested_url,status,fetched_at,failure_code,created_by)
 VALUES(capture,app.current_org_id(),scion,1,task,'https://www.gov.uk/contracts-finder','failed',clock_timestamp(),'PROTOCOL_FIXTURE_NO_FETCH',app.current_principal_id());
 -- Exercise the same read-lock and receipt path as the API without UPDATE grants.
 PERFORM app.intake_research_lock_captures(task,NULL);
 IF NOT EXISTS(SELECT 1 FROM grimoire.intake_research_captures WHERE id=capture AND agent_task_id=task) THEN RAISE EXCEPTION 'Runtime cannot read captured receipt'; END IF;
 denied:=false;BEGIN PERFORM app.intake_research_lock_captures(task,capture);EXCEPTION WHEN insufficient_privilege THEN denied:=true;END;
 IF NOT denied THEN RAISE EXCEPTION 'Agent can acquire human withdrawal lock'; END IF;
 body:=jsonb_build_object('synthetic',false,'summary','Rollback-only protocol fixture; no research performed.','process_steps','[]'::jsonb,'candidates','[]'::jsonb,
  'sources',jsonb_build_array(jsonb_build_object('url','https://www.gov.uk/contracts-finder','title','Unretrieved protocol fixture')),
  'unresolved_gaps',jsonb_build_array('No website fetched; fixture only.'),'queries',jsonb_build_array(jsonb_build_object('query','Protocol fixture query, not executed','observed_at',clock_timestamp())),'capture_ids',jsonb_build_array(capture));
 IF NOT app.intake_research_report_valid(task,body) THEN RAISE EXCEPTION 'Bounded report fixture rejected'; END IF;
 IF app.intake_research_report_valid(task,jsonb_set(body,'{capture_ids}',jsonb_build_array(gen_random_uuid()))) THEN RAISE EXCEPTION 'Foreign or missing capture accepted'; END IF;
 IF app.intake_research_report_valid(task,body||'{"approved":true}') THEN RAISE EXCEPTION 'Report approval authority accepted'; END IF;
 INSERT INTO grimoire.intake_research_reports(id,org_id,scion_id,scion_revision,agent_task_id,input,created_by,request_sha256)
 VALUES(report,app.current_org_id(),scion,1,task,body,app.current_principal_id(),repeat('b',64));
 PERFORM set_config('app.current_principal_id','d3520000-0000-4000-8000-000000000011',true);
 denied:=false;BEGIN
 INSERT INTO grimoire.intake_research_reviews(id,org_id,report_id,reviewer_id,note,request_key) VALUES(gen_random_uuid(),app.current_org_id(),report,app.current_principal_id(),'Premature review','premature');
 EXCEPTION WHEN SQLSTATE 'G2901' THEN denied:=true;END;
 IF NOT denied THEN RAISE EXCEPTION 'Running research accepted human review'; END IF;
 PERFORM set_config('app.current_principal_id','d3520000-0000-4000-8000-000000000012',true);
 UPDATE grimoire.intake_agent_tasks SET status='completed',completed_at=clock_timestamp(),proposal_id=report,output_sha256=repeat('c',64),preparation_note='SQL protocol fixture only; no provider run' WHERE id=task;
 IF EXISTS(SELECT 1 FROM grimoire.intake_research_reviews WHERE report_id=report) THEN RAISE EXCEPTION 'Completion created a review'; END IF;
 -- Two genuine native follow-up records, but protocol-only output: one already
 -- saved and one still running when the parent's receipt is withdrawn below.
 -- Neither child lists the parent's capture as its own source receipt.
 parent:=task;
 FOR idx IN 1..2 LOOP
  PERFORM set_config('app.current_principal_id','d3520000-0000-4000-8000-000000000011',true);
  child:=gen_random_uuid();message:=gen_random_uuid();child_report:=gen_random_uuid();
  INSERT INTO grimoire.intake_task_messages(id,org_id,scion_id,scion_revision,thread_task_id,author_principal_id,author_name,body,intent,request_key,request_sha256)
  VALUES(message,app.current_org_id(),scion,1,task,app.current_principal_id(),'Research owner',candidate->>'objective','follow_up',message::text,repeat('e',64));
  INSERT INTO grimoire.intake_agent_tasks(id,org_id,scion_id,scion_revision,task_kind,input,created_by,request_key,request_sha256,timeout_seconds)
  VALUES(child,app.current_org_id(),scion,1,'research_public_web',jsonb_build_object('candidate_proposal',candidate),app.current_principal_id(),child::text,repeat('f',64),240);
  INSERT INTO grimoire.intake_task_followups VALUES(app.current_org_id(),task,parent,message,child,clock_timestamp());
  UPDATE grimoire.intake_agent_tasks SET status='dispatched',dispatched_at=clock_timestamp() WHERE id=child;
  PERFORM set_config('app.current_principal_id','d3520000-0000-4000-8000-000000000012',true);
  PERFORM set_config('app.task_messages_protocol','1',true);
  UPDATE grimoire.intake_agent_tasks SET status='running',attempt=1,claimed_by=app.current_principal_id(),claimed_at=clock_timestamp(),lease_token=lease,lease_until=clock_timestamp()+interval '270 seconds' WHERE id=child;
  PERFORM set_config('app.agent_task_id',child::text,true);
  followup_body:=body||jsonb_build_object('sources','[]'::jsonb,'capture_ids','[]'::jsonb);
  IF idx=1 THEN
   INSERT INTO grimoire.intake_research_reports(id,org_id,scion_id,scion_revision,agent_task_id,input,created_by,request_sha256)
   VALUES(child_report,app.current_org_id(),scion,1,child,followup_body,app.current_principal_id(),repeat('b',64));
   UPDATE grimoire.intake_agent_tasks SET status='completed',completed_at=clock_timestamp(),proposal_id=child_report,output_sha256=repeat('c',64),preparation_note='Protocol-only follow-up; no provider executed' WHERE id=child;
   child_done:=child;parent:=child;
  ELSE child_running:=child; END IF;
 END LOOP;
 PERFORM set_config('app.current_principal_id','d3520000-0000-4000-8000-000000000011',true);
 INSERT INTO grimoire.intake_research_reviews(id,org_id,report_id,reviewer_id,note,request_key) VALUES(gen_random_uuid(),app.current_org_id(),report,app.current_principal_id(),'Reviewed protocol fixture only','explicit-review');
 IF NOT app.intake_research_lock_captures(task,capture) THEN RAISE EXCEPTION 'Handler cannot lock exact receipt for withdrawal'; END IF;
 INSERT INTO grimoire.intake_research_capture_revocations(org_id,capture_id,reason,created_by) VALUES(app.current_org_id(),capture,'Withdraw fixture',app.current_principal_id()) ON CONFLICT DO NOTHING;
 INSERT INTO grimoire.intake_research_capture_revocations(org_id,capture_id,reason,created_by) VALUES(app.current_org_id(),capture,'Withdraw fixture',app.current_principal_id()) ON CONFLICT DO NOTHING;
 IF (SELECT count(*) FROM grimoire.intake_watch_events WHERE subject_id=capture AND kind='research_source_revoked')<>1 THEN RAISE EXCEPTION 'Duplicate withdrawal duplicated audit effects'; END IF;
 IF NOT EXISTS(SELECT 1 FROM grimoire.intake_watch_node_states WHERE node_kind='agent_task' AND node_id=task AND blocked AND stale) THEN RAISE EXCEPTION 'Withdrawal failed to block native task'; END IF;
 IF (SELECT count(*) FROM grimoire.intake_watch_node_states WHERE node_kind='agent_task' AND node_id IN(child_done,child_running) AND blocked AND stale)<>2 THEN RAISE EXCEPTION 'Prior-result withdrawal did not block all dependent follow-ups'; END IF;
 IF NOT EXISTS(SELECT 1 FROM grimoire.intake_research_reports r JOIN grimoire.intake_watch_node_states w ON (w.org_id,w.node_kind,w.node_id)=(r.org_id,'agent_task',r.agent_task_id) WHERE r.agent_task_id=child_done AND w.blocked) THEN RAISE EXCEPTION 'Existing follow-up report escaped global visibility projection'; END IF;
 PERFORM set_config('app.current_principal_id','d3520000-0000-4000-8000-000000000012',true);
 PERFORM set_config('app.agent_task_id',child_running::text,true);
 denied:=false;BEGIN
  INSERT INTO grimoire.intake_research_reports(id,org_id,scion_id,scion_revision,agent_task_id,input,created_by,request_sha256)
  VALUES(gen_random_uuid(),app.current_org_id(),scion,1,child_running,followup_body,app.current_principal_id(),repeat('b',64));
 EXCEPTION WHEN SQLSTATE 'G2601' THEN denied:=true;END;
 IF NOT denied THEN RAISE EXCEPTION 'Withdrawn parent evidence allowed a new follow-up report'; END IF;
 PERFORM set_config('app.current_principal_id','d3520000-0000-4000-8000-000000000011',true);
 IF app.intake_research_report_valid(task,body) THEN RAISE EXCEPTION 'Revoked capture still accepted as report input'; END IF;
 UPDATE grimoire.intake_agent_tasks SET status='cancel_requested' WHERE id=child_running;
 PERFORM set_config('app.current_principal_id','d3520000-0000-4000-8000-000000000012',true);
 UPDATE grimoire.intake_agent_tasks SET status='cancelled',cancelled_at=clock_timestamp(),completed_at=clock_timestamp() WHERE id=child_running;
 PERFORM set_config('app.current_principal_id','d3520000-0000-4000-8000-000000000011',true);
 INSERT INTO grimoire.intake_agent_tasks(id,org_id,scion_id,scion_revision,task_kind,input,created_by,request_key,request_sha256,timeout_seconds)
 VALUES(cancel_task,app.current_org_id(),scion,1,'research_public_web',jsonb_build_object('candidate_proposal',candidate),app.current_principal_id(),cancel_task::text,repeat('d',64),240);
 UPDATE grimoire.intake_agent_tasks SET status='dispatched',dispatched_at=clock_timestamp() WHERE id=cancel_task;
 PERFORM set_config('app.current_principal_id','d3520000-0000-4000-8000-000000000012',true);
 UPDATE grimoire.intake_agent_tasks SET status='running',attempt=1,claimed_by=app.current_principal_id(),claimed_at=clock_timestamp(),lease_token=lease,lease_until=clock_timestamp()+interval '270 seconds' WHERE id=cancel_task;
 PERFORM set_config('app.current_principal_id','d3520000-0000-4000-8000-000000000011',true);
 UPDATE grimoire.intake_agent_tasks SET status='cancel_requested' WHERE id=cancel_task;
 PERFORM set_config('app.current_principal_id','d3520000-0000-4000-8000-000000000012',true);
 denied:=false;BEGIN PERFORM app.intake_research_assert_task(cancel_task,lease);EXCEPTION WHEN SQLSTATE 'G2901' THEN denied:=true;END;
 IF NOT denied THEN RAISE EXCEPTION 'Cancelled research lease still permits capture/submission'; END IF;
 UPDATE grimoire.intake_agent_tasks SET status='cancelled',cancelled_at=clock_timestamp(),completed_at=clock_timestamp() WHERE id=cancel_task;
 RAISE NOTICE 'PASS exact captures, no approval promotion, signed lease, separate review, idempotent withdrawal, cancellation, prior-result withdrawal propagation and artifact-insert rejection';
END $$;
-- Provider protocol fixture only: no search service, model or website is called.
DO $$
DECLARE candidate jsonb;body jsonb;scion uuid:=gen_random_uuid();task uuid:=gen_random_uuid();lease uuid:=gen_random_uuid();capture uuid:=gen_random_uuid();failed_capture uuid:=gen_random_uuid();
BEGIN
 candidate:=jsonb_build_object('synthetic',false,'objective','Public SerpApi protocol fixture','consent',true,'policy_version','public-web-research-v1','worker_connection_id','d3520000-0000-4000-8000-000000000031','search_provider','serpapi');
 IF NOT app.intake_research_candidate_valid(candidate) OR app.intake_research_candidate_valid(candidate||'{"search_provider":"unknown"}') OR app.intake_research_candidate_valid(candidate||'{"search_provider":null}') OR app.intake_research_candidate_valid(candidate||'{"consent":false}') THEN RAISE EXCEPTION 'Explicit provider consent shape not enforced'; END IF;
 PERFORM set_config('app.current_principal_id','d3520000-0000-4000-8000-000000000012',true);
 PERFORM app.intake_research_worker_seen();
 IF app.intake_research_connection(candidate,true) THEN RAISE EXCEPTION 'Legacy worker advertised SerpApi'; END IF;
 PERFORM app.intake_research_worker_seen(true);
 IF NOT app.intake_research_connection(candidate,true) THEN RAISE EXCEPTION 'Configured worker not eligible'; END IF;
 PERFORM app.intake_research_worker_seen(false);
 IF app.intake_research_connection(candidate,true) THEN RAISE EXCEPTION 'Lost SerpApi capability retained'; END IF;
 PERFORM app.intake_research_worker_seen(true);
 PERFORM set_config('app.current_principal_id','d3520000-0000-4000-8000-000000000011',true);
 INSERT INTO grimoire.intake_scions(id,org_id,created_by) VALUES(scion,app.current_org_id(),app.current_principal_id());
 INSERT INTO grimoire.intake_revisions(org_id,scion_id,number,name,product_description,product_category,change_summary,created_by)
 VALUES(app.current_org_id(),scion,1,'SerpApi protocol fixture','No provider call; rollback-only validation.','digital','Guard fixture',app.current_principal_id());
 INSERT INTO grimoire.intake_agent_tasks(id,org_id,scion_id,scion_revision,task_kind,input,created_by,request_key,request_sha256,timeout_seconds)
 VALUES(task,app.current_org_id(),scion,1,'research_public_web',jsonb_build_object('candidate_proposal',candidate),app.current_principal_id(),task::text,repeat('a',64),240);
 UPDATE grimoire.intake_agent_tasks SET status='dispatched',dispatched_at=clock_timestamp() WHERE id=task;
 PERFORM set_config('app.current_principal_id','d3520000-0000-4000-8000-000000000012',true);
 UPDATE grimoire.intake_agent_tasks SET status='running',attempt=1,claimed_by=app.current_principal_id(),claimed_at=clock_timestamp(),lease_token=lease,lease_until=clock_timestamp()+interval '270 seconds' WHERE id=task;
 PERFORM app.intake_research_assert_task(task,lease);
 PERFORM set_config('app.agent_task_id',task::text,true);PERFORM set_config('app.agent_task_lease',lease::text,true);
 INSERT INTO grimoire.intake_research_captures(id,org_id,scion_id,scion_revision,agent_task_id,requested_url,status,fetched_at,content_sha256,byte_length,excerpt,created_by)
 VALUES(capture,app.current_org_id(),scion,1,task,'https://www.gov.uk/contracts-finder','captured',clock_timestamp(),repeat('a',64),41,'Protocol fixture only; no website fetched.',app.current_principal_id());
 INSERT INTO grimoire.intake_research_captures(id,org_id,scion_id,scion_revision,agent_task_id,requested_url,status,fetched_at,failure_code,created_by)
 VALUES(failed_capture,app.current_org_id(),scion,1,task,'https://www.gov.uk/not-fetched-protocol-fixture','failed',clock_timestamp(),'PROTOCOL_FIXTURE_NO_FETCH',app.current_principal_id());
 body:=jsonb_build_object('synthetic',false,'summary','Protocol fixture only, no actual search.','process_steps','[]'::jsonb,'candidates','[]'::jsonb,'sources','[]'::jsonb,'capture_ids','[]'::jsonb,'unresolved_gaps','[]'::jsonb,'queries',jsonb_build_array(jsonb_build_object('query','Protocol fixture, not executed','observed_at',clock_timestamp(),'provider','serpapi','engine','google','search_id','protocol_123')));
 IF app.intake_research_report_valid(task,body) THEN RAISE EXCEPTION 'SerpApi report with no source accepted'; END IF;
 body:=body||jsonb_build_object('sources',jsonb_build_array(jsonb_build_object('url','https://www.gov.uk/contracts-finder','title','Protocol-only receipt')),'capture_ids',jsonb_build_array(capture));
 IF NOT app.intake_research_report_valid(task,body) THEN RAISE EXCEPTION 'Bounded SerpApi metadata rejected'; END IF;
 IF app.intake_research_report_valid(task,body||jsonb_build_object('sources',jsonb_build_array(jsonb_build_object('url','https://www.gov.uk/not-fetched-protocol-fixture','title','Failed protocol receipt')),'capture_ids',jsonb_build_array(failed_capture))) THEN RAISE EXCEPTION 'Failed SerpApi source capture accepted'; END IF;
 IF NOT app.intake_research_report_valid(task,jsonb_set(body,'{queries}',(body->'queries')||(body->'queries')||(body->'queries'))) THEN RAISE EXCEPTION 'Three consented SerpApi queries rejected'; END IF;
 IF app.intake_research_report_valid(task,jsonb_set(body,'{queries}',(body->'queries')||(body->'queries')||(body->'queries')||(body->'queries'))) THEN RAISE EXCEPTION 'SerpApi three-query consent exceeded'; END IF;
 IF app.intake_research_report_valid(task,body#-'{queries,0,provider}') OR app.intake_research_report_valid(task,body#-'{queries,0,engine}') OR app.intake_research_report_valid(task,body#-'{queries,0,search_id}') THEN RAISE EXCEPTION 'Incomplete provider metadata accepted'; END IF;
 IF app.intake_research_report_valid(task,jsonb_set(body,'{queries,0,provider}','"codex"')) OR app.intake_research_report_valid(task,jsonb_set(body,'{queries,0,search_id}','"https://serpapi.com/?api_key=secret"')) THEN RAISE EXCEPTION 'Mismatched or unsafe provider metadata accepted'; END IF;
 IF app.intake_research_report_valid(task,jsonb_set(body,'{queries,0,search_id}','123')) THEN RAISE EXCEPTION 'Non-string SerpApi search ID accepted'; END IF;
 PERFORM app.intake_research_worker_seen();
 IF app.intake_research_connection(candidate,true) THEN RAISE EXCEPTION 'Legacy heartbeat failed to clear SerpApi'; END IF;
 RAISE NOTICE 'PASS explicit SerpApi selection, configured worker presence, lost capability and atomic provider receipts';
END $$;
ROLLBACK;
