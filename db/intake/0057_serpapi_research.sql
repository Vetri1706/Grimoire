-- SerpApi is an explicit provider choice on the existing consented research task.
BEGIN;
SET search_path=pg_catalog,grimoire,pg_temp;

ALTER TABLE grimoire.intake_research_worker_presence ADD COLUMN serpapi_capable boolean NOT NULL DEFAULT false;

CREATE FUNCTION app.intake_research_worker_seen(has_serpapi boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
BEGIN
 IF NOT app.intake_scope_is_agent() OR NOT app.intake_scope_can_propose() THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='worker required'; END IF;
 INSERT INTO grimoire.intake_research_worker_presence(org_id,principal_id,last_seen,serpapi_capable)
 VALUES(app.current_org_id(),app.current_principal_id(),clock_timestamp(),COALESCE(has_serpapi,false))
 ON CONFLICT(org_id,principal_id) DO UPDATE SET last_seen=EXCLUDED.last_seen,serpapi_capable=EXCLUDED.serpapi_capable;
END $$;
CREATE OR REPLACE FUNCTION app.intake_research_worker_seen() RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
 SELECT app.intake_research_worker_seen(false)
$$;

CREATE OR REPLACE FUNCTION app.intake_research_candidate_valid(candidate jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT COALESCE(jsonb_typeof(candidate)='object' AND candidate ?& ARRAY['synthetic','objective','consent','policy_version','worker_connection_id']
 AND candidate-ARRAY['synthetic','objective','consent','policy_version','worker_connection_id','search_provider']='{}'::jsonb
 AND (NOT candidate ? 'search_provider' OR candidate->'search_provider'='"serpapi"'::jsonb)
 AND candidate->'synthetic'='false'::jsonb AND candidate->'consent'='true'::jsonb
 AND candidate->>'policy_version'='public-web-research-v1' AND jsonb_typeof(candidate->'objective')='string'
 AND length(btrim(candidate->>'objective')) BETWEEN 1 AND 4000
 AND candidate->>'worker_connection_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',false)
$$;
CREATE OR REPLACE FUNCTION app.intake_research_connection(candidate jsonb,require_worker boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
 SELECT app.intake_research_candidate_valid(candidate) AND EXISTS(
 SELECT 1 FROM grimoire.intake_worker_connections c JOIN grimoire.principals p ON (p.org_id,p.id)=(c.org_id,c.principal_id)
 WHERE c.org_id=app.current_org_id() AND c.id::text=lower(candidate->>'worker_connection_id') AND c.revoked_at IS NULL AND p.disabled_at IS NULL
 AND (NOT require_worker OR c.principal_id=app.current_principal_id())
 AND (NOT candidate ? 'search_provider' OR EXISTS(
  SELECT 1 FROM grimoire.intake_research_worker_presence presence
  WHERE (presence.org_id,presence.principal_id)=(c.org_id,c.principal_id) AND presence.serpapi_capable
  AND presence.last_seen>clock_timestamp()-interval '15 seconds')))
$$;

CREATE OR REPLACE FUNCTION app.intake_research_report_valid(wanted_task uuid,body jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE source jsonb; step jsonb; candidate jsonb; item jsonb; url text; receipt uuid; idx integer; started timestamptz; expected_provider text;
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
 SELECT claimed_at,input->'candidate_proposal'->>'search_provider' INTO started,expected_provider FROM grimoire.intake_agent_tasks WHERE (org_id,id)=(app.current_org_id(),wanted_task);
 IF started IS NULL THEN RETURN false; END IF;
 IF expected_provider='serpapi' AND (jsonb_array_length(body->'queries')>3 OR jsonb_array_length(body->'sources')=0) THEN RETURN false; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(body->'queries') LOOP
  IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR item-ARRAY['query','observed_at','provider','engine','search_id']<>'{}'::jsonb THEN RETURN false; END IF;
  IF expected_provider='serpapi' THEN
   IF item->>'provider' IS DISTINCT FROM 'serpapi' OR item->>'engine' IS DISTINCT FROM 'google'
   OR jsonb_typeof(item->'search_id') IS DISTINCT FROM 'string' OR item->>'search_id' !~ '^[a-zA-Z0-9_-]{1,128}$' THEN RETURN false; END IF;
  ELSIF item ?| ARRAY['provider','engine','search_id'] THEN RETURN false;
  END IF;
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
    AND (expected_provider IS DISTINCT FROM 'serpapi' OR c.status='captured')
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
REVOKE ALL ON FUNCTION app.intake_research_worker_seen(boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.intake_research_worker_seen(boolean) TO grimoire_intake_app;
COMMIT;
