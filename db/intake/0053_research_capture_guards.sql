-- Serialize research finalization with revision/revocation and validate research
-- artifacts at the database boundary as well as the Rust boundary.
BEGIN;
SET search_path=pg_catalog,grimoire,pg_temp;
CREATE FUNCTION app.intake_research_report_valid(wanted_task uuid,body jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE source jsonb; step jsonb; candidate jsonb; item jsonb; url text; receipt uuid; idx integer; started timestamptz;
BEGIN
 IF jsonb_typeof(body) IS DISTINCT FROM 'object' OR NOT body ?& ARRAY['synthetic','summary','process_steps','candidates','sources','unresolved_gaps','queries','capture_ids']
 OR body-ARRAY['synthetic','summary','process_steps','candidates','sources','unresolved_gaps','queries','capture_ids']<>'{}'::jsonb
 OR body->'synthetic' IS DISTINCT FROM 'false'::jsonb OR jsonb_typeof(body->'summary') IS DISTINCT FROM 'string'
 OR length(btrim(body->>'summary')) NOT BETWEEN 1 AND 4000 THEN RETURN false; END IF;
 FOREACH url IN ARRAY ARRAY['process_steps','candidates','sources','unresolved_gaps','queries','capture_ids'] LOOP
  IF jsonb_typeof(body->url) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 END LOOP;
 IF jsonb_array_length(body->'process_steps')>8 OR jsonb_array_length(body->'candidates')>8 OR jsonb_array_length(body->'sources')>8
 OR jsonb_array_length(body->'capture_ids')<>jsonb_array_length(body->'sources') OR jsonb_array_length(body->'queries') NOT BETWEEN 1 AND 5
 OR jsonb_array_length(body->'unresolved_gaps')>40 THEN RETURN false; END IF;
 SELECT claimed_at INTO started FROM grimoire.intake_agent_tasks WHERE (org_id,id)=(app.current_org_id(),wanted_task);
 IF started IS NULL THEN RETURN false; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(body->'queries') LOOP
  IF jsonb_typeof(item->'observed_at') IS DISTINCT FROM 'string' OR jsonb_typeof(item->'query') IS DISTINCT FROM 'string' OR length(btrim(item->>'query')) NOT BETWEEN 1 AND 2000
  OR (item->>'observed_at')::timestamptz NOT BETWEEN started-interval '2 minutes' AND clock_timestamp()+interval '2 minutes' THEN RETURN false; END IF;
 END LOOP;
 FOR item IN SELECT value FROM jsonb_array_elements(body->'unresolved_gaps') LOOP
  IF jsonb_typeof(item) IS DISTINCT FROM 'string' OR length(btrim(item#>>'{}')) NOT BETWEEN 1 AND 1000 THEN RETURN false; END IF;
 END LOOP;
 FOR idx IN 0..jsonb_array_length(body->'sources')-1 LOOP
  source:=body->'sources'->idx;receipt:=(body->'capture_ids'->>idx)::uuid;
  IF jsonb_typeof(source->'title') IS DISTINCT FROM 'string' OR length(btrim(source->>'title')) NOT BETWEEN 1 AND 160
  OR NOT EXISTS(SELECT 1 FROM grimoire.intake_research_captures c WHERE (c.org_id,c.id,c.agent_task_id,c.requested_url)=(app.current_org_id(),receipt,wanted_task,source->>'url')
    AND NOT EXISTS(SELECT 1 FROM grimoire.intake_research_capture_revocations r WHERE (r.org_id,r.capture_id)=(c.org_id,c.id))) THEN RETURN false; END IF;
 END LOOP;
 IF (SELECT count(DISTINCT value) FROM jsonb_array_elements(body->'capture_ids'))<>jsonb_array_length(body->'capture_ids')
 OR (SELECT count(DISTINCT value->>'url') FROM jsonb_array_elements(body->'sources'))<>jsonb_array_length(body->'sources') THEN RETURN false; END IF;
 FOR step IN SELECT value FROM jsonb_array_elements(body->'process_steps') LOOP
  IF jsonb_typeof(step->'title') IS DISTINCT FROM 'string' OR length(btrim(step->>'title')) NOT BETWEEN 1 AND 160
  OR jsonb_typeof(step->'detail') IS DISTINCT FROM 'string' OR length(btrim(step->>'detail')) NOT BETWEEN 1 AND 4000
  OR jsonb_typeof(step->'source_urls') IS DISTINCT FROM 'array' OR jsonb_array_length(step->'source_urls')>8 THEN RETURN false; END IF;
  FOR url IN SELECT jsonb_array_elements_text(step->'source_urls') LOOP
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(body->'sources') s WHERE s->>'url'=url) THEN RETURN false; END IF;
  END LOOP;
 END LOOP;
 FOR candidate IN SELECT value FROM jsonb_array_elements(body->'candidates') LOOP
  IF jsonb_typeof(candidate->'name') IS DISTINCT FROM 'string' OR length(btrim(candidate->>'name')) NOT BETWEEN 1 AND 160
  OR jsonb_typeof(candidate->'rationale') IS DISTINCT FROM 'string' OR length(btrim(candidate->>'rationale')) NOT BETWEEN 1 AND 4000
  OR jsonb_typeof(candidate->'source_urls') IS DISTINCT FROM 'array' OR jsonb_array_length(candidate->'source_urls')>8
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(body->'sources') s WHERE s->>'url'=candidate->>'url') THEN RETURN false; END IF;
  FOR url IN SELECT jsonb_array_elements_text(candidate->'source_urls') LOOP
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(body->'sources') s WHERE s->>'url'=url) THEN RETURN false; END IF;
  END LOOP;
 END LOOP;
 RETURN true;
EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR invalid_datetime_format THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION app.intake_research_report_valid(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.intake_research_report_valid(uuid,jsonb) TO grimoire_intake_app;

CREATE OR REPLACE FUNCTION app.intake_research_assert_task(wanted_task uuid,wanted_lease uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE task grimoire.intake_agent_tasks%ROWTYPE;
BEGIN
 SELECT * INTO task FROM grimoire.intake_agent_tasks WHERE (org_id,id)=(app.current_org_id(),wanted_task) FOR UPDATE;
 IF NOT FOUND OR task.task_kind<>'research_public_web' OR NOT app.intake_scope_is_agent() OR NOT app.intake_scope_can_propose()
 OR task.status<>'running' OR task.claimed_by IS DISTINCT FROM app.current_principal_id() OR task.lease_token IS DISTINCT FROM wanted_lease
 OR task.lease_until<=clock_timestamp() OR task.claimed_at+make_interval(secs=>task.timeout_seconds)<=clock_timestamp()
 OR NOT app.intake_research_connection(task.input->'candidate_proposal',true) THEN
 RAISE EXCEPTION USING ERRCODE='G2901',MESSAGE='active research lease and per-task consent required'; END IF;
 PERFORM app.intake_assert_managed_task(task.id);
 PERFORM app.intake_scope_lock_scion(task.scion_id);
 IF NOT EXISTS(SELECT 1 FROM grimoire.intake_scions WHERE (org_id,id,current_revision)=(task.org_id,task.scion_id,task.scion_revision))
 THEN RAISE EXCEPTION USING ERRCODE='G2402',MESSAGE='research revision changed'; END IF;
 IF EXISTS(SELECT 1 FROM grimoire.intake_watch_node_states WHERE org_id=task.org_id AND node_kind='agent_task' AND node_id=task.id AND (stale OR blocked))
 THEN RAISE EXCEPTION USING ERRCODE='G2601',MESSAGE='research input no longer available'; END IF;
END $$;

CREATE OR REPLACE FUNCTION grimoire.intake_research_write_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE task grimoire.intake_agent_tasks%ROWTYPE; lease uuid;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='research artifacts are immutable'; END IF;
 IF NEW.org_id IS DISTINCT FROM app.current_org_id() OR NEW.created_by IS DISTINCT FROM app.current_principal_id() THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='research owner mismatch'; END IF;
 lease:=NULLIF(current_setting('app.agent_task_lease',true),'')::uuid;
 PERFORM app.intake_research_assert_task(NEW.agent_task_id,lease);
 SELECT * INTO STRICT task FROM grimoire.intake_agent_tasks WHERE (org_id,id)=(NEW.org_id,NEW.agent_task_id);
 IF (NEW.scion_id,NEW.scion_revision) IS DISTINCT FROM (task.scion_id,task.scion_revision) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='research task mismatch'; END IF;
 IF TG_TABLE_NAME='intake_research_captures' AND (SELECT count(*) FROM grimoire.intake_research_captures WHERE (org_id,agent_task_id)=(NEW.org_id,NEW.agent_task_id))>=8 THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='research capture limit'; END IF;
 IF TG_TABLE_NAME='intake_research_reports' THEN
  IF NOT app.intake_research_report_valid(NEW.agent_task_id,NEW.input) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='bounded research report and exact capture receipts required'; END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION grimoire.intake_research_human_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE task_id uuid; scion uuid; revision integer;
BEGIN
 IF TG_OP<>'INSERT' OR NEW.org_id IS DISTINCT FROM app.current_org_id() OR NOT app.intake_can_prepare_workspace() THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='human research review required'; END IF;
 IF TG_TABLE_NAME='intake_research_reviews' THEN
  IF NEW.reviewer_id IS DISTINCT FROM app.current_principal_id() THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='review identity mismatch'; END IF;
  SELECT r.agent_task_id,r.scion_id,r.scion_revision INTO task_id,scion,revision FROM grimoire.intake_research_reports r WHERE (r.org_id,r.id)=(NEW.org_id,NEW.report_id);
  PERFORM app.intake_scope_lock_scion(scion);
  IF NOT EXISTS(SELECT 1 FROM grimoire.intake_agent_tasks WHERE (org_id,id,status)=(NEW.org_id,task_id,'completed')) THEN RAISE EXCEPTION USING ERRCODE='G2901',MESSAGE='completed research task required for review'; END IF;
  IF NOT EXISTS(SELECT 1 FROM grimoire.intake_scions s WHERE (s.org_id,s.id,s.current_revision)=(NEW.org_id,scion,revision)) OR
   EXISTS(SELECT 1 FROM grimoire.intake_watch_node_states WHERE org_id=NEW.org_id AND node_kind='agent_task' AND node_id=task_id AND (stale OR blocked)) THEN RAISE EXCEPTION USING ERRCODE='G2402',MESSAGE='research report changed'; END IF;
 ELSE
  IF NEW.created_by IS DISTINCT FROM app.current_principal_id() THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='revocation identity mismatch'; END IF;
 END IF;
 RETURN NEW;
END $$;
COMMIT;
