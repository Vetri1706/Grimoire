-- Supplemental rollback-only checks after the real HTTP worker harness.
-- Execute as grimoire_migrator only in disposable grimoire_test.
BEGIN;
SET LOCAL search_path=grimoire,public;
SELECT set_config('app.current_org_id','10000000-0000-4000-8000-000000000001',true);
SELECT set_config('app.current_principal_id','10000000-0000-4000-8000-000000000011',true);
SELECT set_config('app.request_id',gen_random_uuid()::text,true);
SELECT set_config('app.effective_role','procurement_preparer',true);
SELECT set_config('app.endpoint_scope','local:worker-guards',true);
SELECT set_config('app.action_reason','Rollback-only synthetic worker invariant checks',true);
DO $$
DECLARE candidate intake_scope_proposals%ROWTYPE; first_task uuid:=gen_random_uuid(); second_task uuid:=gen_random_uuid();
 token uuid:=gen_random_uuid(); event_id uuid; finished intake_agent_tasks%ROWTYPE;
BEGIN
 IF current_database()<>'grimoire_test' THEN RAISE EXCEPTION 'worker guards require disposable grimoire_test'; END IF;
 SELECT p.* INTO STRICT candidate FROM intake_scope_proposals p JOIN intake_scions s ON (s.org_id,s.id,s.current_revision)=(p.org_id,p.scion_id,p.scion_revision)
 WHERE p.org_id=app.current_org_id() AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.input->'source_claims') r
   WHERE NOT EXISTS(SELECT 1 FROM intake_sources src WHERE (src.org_id,src.id,src.scion_id,src.scion_revision,src.current_revision)=(p.org_id,(r->>'source_id')::uuid,p.scion_id,p.scion_revision,(r->>'source_revision')::integer))
   OR EXISTS(SELECT 1 FROM intake_source_revocations v WHERE (v.org_id,v.source_id)=(p.org_id,(r->>'source_id')::uuid)))
 ORDER BY p.created_at DESC LIMIT 1;
 INSERT INTO intake_agent_tasks(id,org_id,scion_id,scion_revision,task_kind,input,created_by,request_key,request_sha256,timeout_seconds)
 SELECT id,app.current_org_id(),candidate.scion_id,candidate.scion_revision,'prepare_physical_scope',jsonb_build_object('candidate_proposal',candidate.input),app.current_principal_id(),id::text,repeat('a',64),30
 FROM unnest(ARRAY[first_task,second_task]) id;
 PERFORM set_config('app.current_principal_id','10000000-0000-4000-8000-000000000018',true);
 BEGIN
  UPDATE intake_agent_tasks SET status='running',attempt=1,claimed_by=app.current_principal_id(),claimed_at=clock_timestamp(),lease_token=token,lease_until=clock_timestamp()+interval '60 seconds' WHERE id=first_task;
  RAISE EXCEPTION 'undispatched claim unexpectedly succeeded';
 EXCEPTION WHEN SQLSTATE 'G2901' THEN NULL; END;
 BEGIN
  UPDATE intake_agent_tasks SET status='dispatched',dispatched_at=clock_timestamp() WHERE id=first_task;
  RAISE EXCEPTION 'agent self-dispatch unexpectedly succeeded';
 EXCEPTION WHEN SQLSTATE 'G2901' THEN NULL; END;
 PERFORM set_config('app.current_principal_id','10000000-0000-4000-8000-000000000011',true);
 UPDATE intake_agent_tasks SET status='dispatched',dispatched_at=clock_timestamp() WHERE id IN (first_task,second_task);
 PERFORM set_config('app.current_principal_id','10000000-0000-4000-8000-000000000018',true);
 BEGIN
  UPDATE intake_agent_tasks SET status='running',attempt=1,claimed_by=app.current_principal_id(),claimed_at=clock_timestamp()+interval '1 day',lease_token=token,lease_until=clock_timestamp()+interval '60 seconds' WHERE id=first_task;
  RAISE EXCEPTION 'future execution deadline spoof unexpectedly succeeded';
 EXCEPTION WHEN SQLSTATE 'G2901' THEN NULL; END;
 UPDATE intake_agent_tasks SET status='running',attempt=1,claimed_by=app.current_principal_id(),claimed_at=clock_timestamp(),lease_token=token,lease_until=clock_timestamp()+interval '60 seconds' WHERE id=first_task;
 BEGIN
  UPDATE intake_agent_tasks SET status='running',attempt=1,claimed_by=app.current_principal_id(),claimed_at=clock_timestamp(),lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '60 seconds' WHERE id=second_task;
  RAISE EXCEPTION 'second active organization task unexpectedly succeeded';
 EXCEPTION WHEN SQLSTATE 'G2901' THEN NULL; END;
 BEGIN
  UPDATE intake_agent_tasks SET timeout_seconds=300 WHERE id=first_task;
  RAISE EXCEPTION 'execution bound mutation unexpectedly succeeded';
 EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
 BEGIN
  UPDATE intake_agent_tasks SET status='completed',completed_at=clock_timestamp(),proposal_id=candidate.id,output_sha256=repeat('0',64),preparation_note='Unrelated proposal cannot be reused' WHERE id=first_task;
  RAISE EXCEPTION 'unrelated task result unexpectedly succeeded';
 EXCEPTION WHEN SQLSTATE 'G2901' THEN NULL; END;
 SELECT id INTO STRICT event_id FROM intake_agent_task_events WHERE task_id=first_task ORDER BY recorded_at LIMIT 1;
 BEGIN
  UPDATE intake_agent_task_events SET details='{}' WHERE id=event_id;
  RAISE EXCEPTION 'event provenance mutation unexpectedly succeeded';
 EXCEPTION WHEN SQLSTATE 'G2401' THEN NULL; END;
 BEGIN
  DELETE FROM intake_agent_task_events WHERE id=event_id;
  RAISE EXCEPTION 'event deletion unexpectedly succeeded';
 EXCEPTION WHEN SQLSTATE 'G2401' THEN NULL; END;
 PERFORM set_config('app.current_principal_id','10000000-0000-4000-8000-000000000011',true);
 UPDATE intake_agent_tasks SET status='cancel_requested' WHERE id=first_task;
 PERFORM set_config('app.current_principal_id','10000000-0000-4000-8000-000000000018',true);
 BEGIN
  PERFORM app.intake_task_assert_submission(first_task,token,candidate.scion_id,candidate.scion_revision,'prepare_physical_scope',candidate.input);
  RAISE EXCEPTION 'cancelled execution submitted proposal';
 EXCEPTION WHEN SQLSTATE 'G2901' THEN NULL; END;
 UPDATE intake_agent_tasks SET status='cancelled',completed_at=clock_timestamp(),cancelled_at=clock_timestamp() WHERE id=first_task;
 BEGIN
  UPDATE intake_agent_tasks SET status='running',attempt=2,claimed_by=app.current_principal_id(),claimed_at=clock_timestamp(),lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '60 seconds' WHERE id=first_task;
  RAISE EXCEPTION 'terminal task restarted without new dispatch';
 EXCEPTION WHEN SQLSTATE 'G2901' THEN NULL; END;
 SELECT * INTO STRICT finished FROM intake_agent_tasks WHERE org_id=app.current_org_id() AND status='completed' ORDER BY completed_at DESC LIMIT 1;
 BEGIN
  UPDATE intake_agent_tasks SET output_sha256=repeat('f',64) WHERE id=finished.id;
  RAISE EXCEPTION 'completed result provenance mutation unexpectedly succeeded';
 EXCEPTION WHEN SQLSTATE 'G2901' THEN NULL; END;
 IF has_table_privilege('grimoire_intake_app','grimoire.intake_agent_task_events','INSERT,UPDATE,DELETE') OR
    has_column_privilege('grimoire_intake_app','grimoire.intake_agent_tasks','timeout_seconds','UPDATE') THEN
  RAISE EXCEPTION 'runtime can bypass event immutability or pinned execution bounds';
 END IF;
 RAISE NOTICE 'PASS: explicit Handler dispatch, no agent self-dispatch, no future deadline spoof, one active org task, immutable execution bounds/events/completed results, exact task-result origin, cancellation prevents proposals/restarts, bounded runtime grants';
END $$;
ROLLBACK;
