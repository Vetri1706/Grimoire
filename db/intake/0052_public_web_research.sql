-- Public-web research is a separate, explicitly consented preparation capability.
-- Existing synthetic tasks, source claims and governed sourcing authority are unchanged.
BEGIN;
SET search_path=pg_catalog,grimoire,pg_temp;

CREATE TABLE grimoire.intake_research_worker_presence (
 org_id uuid NOT NULL,principal_id uuid NOT NULL,last_seen timestamptz NOT NULL,
 PRIMARY KEY(org_id,principal_id),FOREIGN KEY(org_id,principal_id) REFERENCES grimoire.principals(org_id,id)
);
CREATE FUNCTION app.intake_research_worker_seen() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
BEGIN
 IF NOT app.intake_scope_is_agent() OR NOT app.intake_scope_can_propose() THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='worker required'; END IF;
 INSERT INTO grimoire.intake_research_worker_presence VALUES(app.current_org_id(),app.current_principal_id(),clock_timestamp())
 ON CONFLICT(org_id,principal_id) DO UPDATE SET last_seen=EXCLUDED.last_seen;
END $$;

CREATE FUNCTION app.intake_research_candidate_valid(candidate jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT COALESCE(jsonb_typeof(candidate)='object' AND candidate ?& ARRAY['synthetic','objective','consent','policy_version','worker_connection_id']
 AND candidate-ARRAY['synthetic','objective','consent','policy_version','worker_connection_id']='{}'::jsonb
 AND candidate->'synthetic'='false'::jsonb AND candidate->'consent'='true'::jsonb
 AND candidate->>'policy_version'='public-web-research-v1' AND jsonb_typeof(candidate->'objective')='string'
 AND length(btrim(candidate->>'objective')) BETWEEN 1 AND 4000
 AND candidate->>'worker_connection_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',false)
$$;
CREATE FUNCTION app.intake_research_connection(candidate jsonb,require_worker boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
 SELECT app.intake_research_candidate_valid(candidate) AND EXISTS(
 SELECT 1 FROM grimoire.intake_worker_connections c JOIN grimoire.principals p ON (p.org_id,p.id)=(c.org_id,c.principal_id)
 WHERE c.org_id=app.current_org_id() AND c.id::text=lower(candidate->>'worker_connection_id') AND c.revoked_at IS NULL AND p.disabled_at IS NULL
 AND (NOT require_worker OR c.principal_id=app.current_principal_id()))
$$;
CREATE FUNCTION app.intake_research_assert_task(wanted_task uuid,wanted_lease uuid) RETURNS void
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
 IF NOT EXISTS(SELECT 1 FROM grimoire.intake_scions WHERE (org_id,id,current_revision)=(task.org_id,task.scion_id,task.scion_revision))
 THEN RAISE EXCEPTION USING ERRCODE='G2402',MESSAGE='research revision changed'; END IF;
 IF EXISTS(SELECT 1 FROM grimoire.intake_watch_node_states WHERE org_id=task.org_id AND node_kind='agent_task' AND node_id=task.id AND (stale OR blocked))
 THEN RAISE EXCEPTION USING ERRCODE='G2601',MESSAGE='research input no longer available'; END IF;
END $$;

CREATE TABLE grimoire.intake_research_captures (
 id uuid PRIMARY KEY,org_id uuid NOT NULL,scion_id uuid NOT NULL,scion_revision integer NOT NULL,agent_task_id uuid NOT NULL,
 requested_url text NOT NULL CHECK(length(requested_url) BETWEEN 1 AND 2000),final_url text,
 status text NOT NULL CHECK(status IN ('captured','failed')),http_status integer,
 fetched_at timestamptz NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 content_sha256 text CHECK(content_sha256 ~ '^[a-f0-9]{64}$'),byte_length integer CHECK(byte_length BETWEEN 1 AND 262144),
 excerpt text CHECK(octet_length(excerpt)<=32000),failure_code text,created_by uuid NOT NULL,
 CHECK((status='captured' AND content_sha256 IS NOT NULL AND excerpt IS NOT NULL AND byte_length IS NOT NULL AND failure_code IS NULL)
 OR (status='failed' AND content_sha256 IS NULL AND excerpt IS NULL AND failure_code IS NOT NULL)),
 UNIQUE(org_id,id),UNIQUE(org_id,agent_task_id,requested_url),
 FOREIGN KEY(org_id,agent_task_id) REFERENCES grimoire.intake_agent_tasks(org_id,id),
 FOREIGN KEY(org_id,scion_id,scion_revision) REFERENCES grimoire.intake_revisions(org_id,scion_id,number),
 FOREIGN KEY(org_id,created_by) REFERENCES grimoire.principals(org_id,id)
);
CREATE TABLE grimoire.intake_research_capture_revocations (
 org_id uuid NOT NULL,capture_id uuid NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),
 created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(org_id,capture_id),
 FOREIGN KEY(org_id,capture_id) REFERENCES grimoire.intake_research_captures(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES grimoire.principals(org_id,id)
);
CREATE TABLE grimoire.intake_research_reports (
 id uuid PRIMARY KEY,org_id uuid NOT NULL,scion_id uuid NOT NULL,scion_revision integer NOT NULL,agent_task_id uuid NOT NULL,
 input jsonb NOT NULL CHECK(jsonb_typeof(input)='object' AND input->'synthetic'='false'::jsonb AND octet_length(input::text)<=128000),
 created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),request_sha256 text NOT NULL,
 UNIQUE(org_id,id),UNIQUE(org_id,agent_task_id),
 FOREIGN KEY(org_id,agent_task_id) REFERENCES grimoire.intake_agent_tasks(org_id,id),
 FOREIGN KEY(org_id,scion_id,scion_revision) REFERENCES grimoire.intake_revisions(org_id,scion_id,number),
 FOREIGN KEY(org_id,created_by) REFERENCES grimoire.principals(org_id,id)
);
CREATE TABLE grimoire.intake_research_reviews (
 id uuid PRIMARY KEY,org_id uuid NOT NULL,report_id uuid NOT NULL,reviewer_id uuid NOT NULL,note text NOT NULL CHECK(length(btrim(note)) BETWEEN 1 AND 4000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),request_key text NOT NULL CHECK(length(request_key) BETWEEN 1 AND 128),
 UNIQUE(org_id,reviewer_id,request_key),FOREIGN KEY(org_id,report_id) REFERENCES grimoire.intake_research_reports(org_id,id),
 FOREIGN KEY(org_id,reviewer_id) REFERENCES grimoire.principals(org_id,id)
);
COMMENT ON TABLE grimoire.intake_research_reports IS 'Unverified public research deliverables of native tasks. No canonical procurement facts, offer, verification, or approval is created.';
COMMENT ON TABLE grimoire.intake_research_captures IS 'Bounded server-retrieved public-page excerpts and fetch receipts, untrusted and unverified; not synthetic sources or quote-verified governed evidence.';

CREATE FUNCTION grimoire.intake_research_write_guard() RETURNS trigger
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
 RETURN NEW;
END $$;
CREATE TRIGGER intake_research_capture_guard BEFORE INSERT OR UPDATE OR DELETE ON grimoire.intake_research_captures FOR EACH ROW EXECUTE FUNCTION grimoire.intake_research_write_guard();
CREATE TRIGGER intake_research_report_guard BEFORE INSERT OR UPDATE OR DELETE ON grimoire.intake_research_reports FOR EACH ROW EXECUTE FUNCTION grimoire.intake_research_write_guard();

CREATE FUNCTION grimoire.intake_research_human_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE task_id uuid; scion uuid; revision integer;
BEGIN
 IF TG_OP<>'INSERT' OR NEW.org_id IS DISTINCT FROM app.current_org_id() OR NOT app.intake_can_prepare_workspace() THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='human research review required'; END IF;
 IF TG_TABLE_NAME='intake_research_reviews' THEN
  IF NEW.reviewer_id IS DISTINCT FROM app.current_principal_id() THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='review identity mismatch'; END IF;
  SELECT r.agent_task_id,r.scion_id,r.scion_revision INTO task_id,scion,revision FROM grimoire.intake_research_reports r WHERE (r.org_id,r.id)=(NEW.org_id,NEW.report_id);
  IF NOT EXISTS(SELECT 1 FROM grimoire.intake_scions s WHERE (s.org_id,s.id,s.current_revision)=(NEW.org_id,scion,revision)) OR
   EXISTS(SELECT 1 FROM grimoire.intake_watch_node_states WHERE org_id=NEW.org_id AND node_kind='agent_task' AND node_id=task_id AND (stale OR blocked)) THEN RAISE EXCEPTION USING ERRCODE='G2402',MESSAGE='research report changed'; END IF;
 ELSE
  IF NEW.created_by IS DISTINCT FROM app.current_principal_id() THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='revocation identity mismatch'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER intake_research_review_guard BEFORE INSERT OR UPDATE OR DELETE ON grimoire.intake_research_reviews FOR EACH ROW EXECUTE FUNCTION grimoire.intake_research_human_guard();
CREATE TRIGGER intake_research_revocation_guard BEFORE INSERT OR UPDATE OR DELETE ON grimoire.intake_research_capture_revocations FOR EACH ROW EXECUTE FUNCTION grimoire.intake_research_human_guard();
CREATE FUNCTION grimoire.intake_research_revoke_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE capture grimoire.intake_research_captures%ROWTYPE;
BEGIN
 SELECT * INTO STRICT capture FROM grimoire.intake_research_captures WHERE (org_id,id)=(NEW.org_id,NEW.capture_id);
 PERFORM grimoire.intake_watch_emit(NEW.org_id,capture.scion_id,'source_changes','research_source_revoked',capture.id,capture.scion_revision,
 'research-capture:'||capture.id||':revoked','Public research source withdrawn; dependent research needs review.');
 INSERT INTO grimoire.intake_watch_node_states(org_id,scion_id,node_kind,node_id,stale,blocked,reason)
 VALUES(NEW.org_id,capture.scion_id,'agent_task',capture.agent_task_id,true,true,'source_permission_revoked')
 ON CONFLICT(org_id,node_kind,node_id) DO UPDATE SET stale=true,blocked=true,reason='source_permission_revoked',updated_at=clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER intake_research_revoke_event AFTER INSERT ON grimoire.intake_research_capture_revocations FOR EACH ROW EXECUTE FUNCTION grimoire.intake_research_revoke_event();

DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['intake_research_worker_presence','intake_research_captures','intake_research_capture_revocations','intake_research_reports','intake_research_reviews'] LOOP
  EXECUTE format('ALTER TABLE grimoire.%I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY research_org_read ON grimoire.%I FOR SELECT TO grimoire_intake_app USING(org_id=app.current_org_id() AND app.intake_can_access())',name);
  EXECUTE format('GRANT SELECT ON grimoire.%I TO grimoire_intake_app',name);
 END LOOP;
 FOREACH name IN ARRAY ARRAY['intake_research_captures','intake_research_capture_revocations','intake_research_reports','intake_research_reviews'] LOOP
  EXECUTE format('CREATE POLICY research_scoped_insert ON grimoire.%I FOR INSERT TO grimoire_intake_app WITH CHECK(org_id=app.current_org_id() AND app.intake_can_access())',name);
  EXECUTE format('GRANT INSERT ON grimoire.%I TO grimoire_intake_app',name);
 END LOOP;
END $$;

ALTER TABLE grimoire.intake_agent_tasks DROP CONSTRAINT intake_agent_tasks_task_kind_check;
ALTER TABLE grimoire.intake_agent_tasks ADD CONSTRAINT intake_agent_tasks_task_kind_check CHECK(task_kind IN ('prepare_physical_scope','prepare_offer_normalization','prepare_capability_plan','research_public_web'));
ALTER TABLE grimoire.intake_agent_tasks DROP CONSTRAINT intake_agent_tasks_input_check;
ALTER TABLE grimoire.intake_agent_tasks ADD CONSTRAINT intake_agent_tasks_input_check CHECK(jsonb_typeof(input)='object' AND octet_length(input::text)<=64000 AND
 CASE WHEN task_kind='research_public_web' THEN app.intake_research_candidate_valid(input->'candidate_proposal') ELSE (input->'candidate_proposal'->'synthetic'='true'::jsonb) IS TRUE END);

-- Queue predicate replacements below preserve prior synthetic branches exactly.

CREATE OR REPLACE FUNCTION app.intake_can_control_preparation(wanted_scion uuid,wanted_revision integer,wanted_kind text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
 SELECT wanted_kind IN ('research_public_web','prepare_capability_plan','prepare_physical_scope','prepare_offer_normalization')
   AND app.intake_can_prepare_workspace()
   AND EXISTS (
     SELECT 1 FROM grimoire.intake_revisions r
     WHERE (r.org_id,r.scion_id,r.number)=(app.current_org_id(),wanted_scion,wanted_revision)
       AND (wanted_kind='research_public_web' OR app.intake_can_write()
         OR (wanted_kind='prepare_capability_plan' AND r.product_category='digital'))
   )
$$;

CREATE OR REPLACE FUNCTION app.intake_task_candidate_matches(kind text,candidate jsonb,proposal jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
BEGIN
 IF kind='research_public_web' THEN RETURN app.intake_research_candidate_valid(candidate) AND proposal->'synthetic'='false'::jsonb; END IF;
 IF kind='prepare_capability_plan' THEN RETURN app.intake_capability_matches(candidate,proposal); END IF;
 IF kind='prepare_physical_scope' THEN
  RETURN COALESCE((proposal-ARRAY['identity_match','unresolved_gaps','change_summary']) IS NOT DISTINCT FROM (candidate-ARRAY['identity_match','unresolved_gaps','change_summary'])
    AND (candidate->>'identity_match'<>'ambiguous' OR proposal->>'identity_match'='ambiguous')
    AND ((proposal->'unresolved_gaps') @> (candidate->'unresolved_gaps')),false);
 END IF;
 RETURN candidate IS NOT NULL AND proposal IS NOT NULL AND (proposal-'change_summary') IS NOT DISTINCT FROM (candidate-'change_summary');
END $$;

CREATE OR REPLACE FUNCTION app.intake_task_assert_input(scion uuid,revision integer,kind text,candidate jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE current_number integer;
BEGIN
 current_number:=app.intake_scope_lock_scion(scion);
 IF current_number IS NULL OR current_number<>revision THEN RAISE EXCEPTION USING ERRCODE='G2402',MESSAGE='stale task revision'; END IF;
 IF kind='research_public_web' THEN
  IF NOT app.intake_research_connection(candidate,app.intake_scope_is_agent()) THEN RAISE EXCEPTION USING ERRCODE='G5201',MESSAGE='explicit task research consent and assigned computer required'; END IF;
 ELSIF kind='prepare_capability_plan' THEN
  IF candidate IS DISTINCT FROM app.intake_capability_candidate(scion,revision) THEN RAISE EXCEPTION USING ERRCODE='G3801',MESSAGE='capability task must use the exact server-pinned intake and local connector registry'; END IF;
 ELSIF kind='prepare_physical_scope' THEN
  IF NOT EXISTS(SELECT 1 FROM grimoire.intake_revisions WHERE (org_id,scion_id,number,product_category)=(app.current_org_id(),scion,revision,'physical')) THEN RAISE EXCEPTION USING ERRCODE='G2801',MESSAGE='physical scope required'; END IF;
  PERFORM app.intake_scope_assert_sources(scion,revision,candidate);
 ELSE
  PERFORM app.intake_offer_assert_candidate(scion,revision,candidate);
 END IF;
END $$;

CREATE OR REPLACE FUNCTION grimoire.intake_agent_task_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE proposal jsonb; is_handler boolean; is_agent boolean;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='task audit cannot be deleted'; END IF;
 IF NEW.org_id IS DISTINCT FROM app.current_org_id() OR NOT app.intake_can_access() THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='task access denied'; END IF;
 is_handler:=app.intake_can_control_preparation(NEW.scion_id,NEW.scion_revision,NEW.task_kind);
 is_agent:=app.intake_scope_is_agent() AND app.intake_scope_can_propose();
 IF TG_OP='INSERT' THEN
  IF NOT is_handler OR NEW.created_by IS DISTINCT FROM app.current_principal_id() OR NEW.status<>'queued' OR NEW.attempt<>0 OR
     NEW.claimed_by IS NOT NULL OR NEW.claimed_at IS NOT NULL OR NEW.lease_token IS NOT NULL OR NEW.lease_until IS NOT NULL OR NEW.proposal_id IS NOT NULL OR NEW.completed_at IS NOT NULL OR
     NEW.dispatched_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL OR NEW.provider_run_id IS NOT NULL OR NEW.output_sha256 IS NOT NULL OR NEW.preparation_note IS NOT NULL OR NEW.failure_code IS NOT NULL THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='only a Handler can queue an undispatched preparation task';
  END IF;
 ELSE
  IF (NEW.id,NEW.org_id,NEW.scion_id,NEW.scion_revision,NEW.task_kind,NEW.adapter,NEW.input,NEW.created_by,NEW.created_at,NEW.request_key,NEW.request_sha256,NEW.timeout_seconds)
    IS DISTINCT FROM (OLD.id,OLD.org_id,OLD.scion_id,OLD.scion_revision,OLD.task_kind,OLD.adapter,OLD.input,OLD.created_by,OLD.created_at,OLD.request_key,OLD.request_sha256,OLD.timeout_seconds) THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='task input identity and execution bounds are immutable';
  END IF;
  IF NEW.status='dispatched' THEN
   IF NOT is_handler OR OLD.status<>'queued' OR NEW.dispatched_at IS NULL THEN RAISE EXCEPTION USING ERRCODE='G2901',MESSAGE='Handler dispatch required'; END IF;
  ELSIF NEW.status='cancel_requested' THEN
   IF NOT is_handler OR OLD.status<>'running' THEN RAISE EXCEPTION USING ERRCODE='G2901',MESSAGE='only Handler can request running cancellation'; END IF;
  ELSIF NEW.status='cancelled' THEN
   IF NOT ((is_handler AND OLD.status IN ('queued','dispatched')) OR (is_agent AND OLD.status='cancel_requested' AND OLD.claimed_by=app.current_principal_id())) OR NEW.cancelled_at IS NULL OR NEW.completed_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='G2901',MESSAGE='cancelled task requires Handler or worker termination acknowledgement';
   END IF;
  ELSIF NEW.status='running' THEN
   PERFORM pg_advisory_xact_lock(hashtextextended('agent-org:'||NEW.org_id::text,0));
   IF NOT is_agent OR OLD.status<>'dispatched' OR NEW.claimed_by IS DISTINCT FROM app.current_principal_id() OR NEW.lease_token IS NULL OR NEW.lease_until IS NULL OR
      NEW.claimed_at IS NULL OR abs(extract(epoch FROM NEW.claimed_at-clock_timestamp()))>2 OR NEW.lease_until<=clock_timestamp() OR NEW.lease_until>NEW.claimed_at+make_interval(secs=>NEW.timeout_seconds+31) OR NEW.attempt<>OLD.attempt+1 OR
      EXISTS(SELECT 1 FROM grimoire.intake_agent_tasks WHERE org_id=NEW.org_id AND id<>NEW.id AND status IN ('running','cancel_requested')) THEN
    RAISE EXCEPTION USING ERRCODE='G2901',MESSAGE='one active dispatched task per organization';
   END IF;
  ELSIF NEW.status='failed' AND NEW.failure_code IN ('INPUT_UNAVAILABLE','LEASE_EXPIRED') THEN
   IF NOT is_agent OR NOT (OLD.status='dispatched' AND NEW.failure_code='INPUT_UNAVAILABLE' OR OLD.status IN ('running','cancel_requested') AND OLD.lease_until<clock_timestamp() AND NEW.failure_code='LEASE_EXPIRED') OR NEW.completed_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='G2901',MESSAGE='invalid unavailable-task disposition';
   END IF;
  ELSIF NEW.status IN ('completed','failed') THEN
   IF NOT is_agent OR OLD.status<>'running' OR OLD.claimed_by IS DISTINCT FROM app.current_principal_id() OR OLD.lease_until<=clock_timestamp() OR NEW.completed_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='G2901',MESSAGE='active task lease required';
   END IF;
   IF NEW.status='completed' AND OLD.claimed_at+make_interval(secs=>OLD.timeout_seconds)<=clock_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE='G2901',MESSAGE='task execution deadline passed';
   END IF;
  ELSE RAISE EXCEPTION USING ERRCODE='G2901',MESSAGE='invalid task transition'; END IF;
  IF NEW.status<>'running' AND (NEW.claimed_by,NEW.claimed_at,NEW.lease_token,NEW.lease_until,NEW.attempt) IS DISTINCT FROM (OLD.claimed_by,OLD.claimed_at,OLD.lease_token,OLD.lease_until,OLD.attempt) THEN
   RAISE EXCEPTION USING ERRCODE='G2901',MESSAGE='task lease metadata changed';
  END IF;
  IF NEW.status<>'dispatched' AND NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at OR NEW.status<>'cancelled' AND NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at THEN
   RAISE EXCEPTION USING ERRCODE='G2901',MESSAGE='task control metadata changed';
  END IF;
 END IF;
 IF NEW.status='completed' THEN
  IF NEW.task_kind='prepare_physical_scope' THEN
   SELECT input INTO proposal FROM grimoire.intake_scope_proposals WHERE (org_id,id,scion_id,scion_revision,created_by,agent_task_id)=(NEW.org_id,NEW.proposal_id,NEW.scion_id,NEW.scion_revision,app.current_principal_id(),NEW.id);
  ELSIF NEW.task_kind='prepare_capability_plan' THEN
   SELECT input INTO proposal FROM grimoire.intake_capability_plans WHERE (org_id,id,scion_id,scion_revision,created_by,agent_task_id)=(NEW.org_id,NEW.proposal_id,NEW.scion_id,NEW.scion_revision,app.current_principal_id(),NEW.id);
  ELSIF NEW.task_kind='research_public_web' THEN
   SELECT input INTO proposal FROM grimoire.intake_research_reports WHERE (org_id,id,scion_id,scion_revision,created_by,agent_task_id)=(NEW.org_id,NEW.proposal_id,NEW.scion_id,NEW.scion_revision,app.current_principal_id(),NEW.id);
  ELSE
   proposal:=app.intake_offer_task_result(NEW.org_id,NEW.scion_id,NEW.scion_revision,app.current_principal_id(),NEW.proposal_id,NEW.id);
  END IF;
  IF proposal IS NULL OR NOT app.intake_task_candidate_matches(NEW.task_kind,NEW.input->'candidate_proposal',proposal) OR NEW.failure_code IS NOT NULL OR NEW.output_sha256 IS NULL OR NEW.preparation_note IS NULL OR length(btrim(NEW.preparation_note))<1 THEN
   RAISE EXCEPTION USING ERRCODE='G2901',MESSAGE='result requires its own pinned proposal';
  END IF;
 ELSE
  IF NEW.proposal_id IS NOT NULL OR NEW.output_sha256 IS NOT NULL OR NEW.provider_run_id IS NOT NULL OR NEW.preparation_note IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='G2901',MESSAGE='noncompleted task cannot carry a result'; END IF;
 END IF;
 IF NEW.status='failed' AND (NEW.failure_code IS NULL OR NEW.failure_code !~ '^[A-Z0-9_]{1,100}$') OR NEW.status<>'failed' AND NEW.failure_code IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='invalid failure metadata'; END IF;
 IF NEW.status IN ('queued','dispatched','running','cancel_requested') AND NEW.completed_at IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='G2901',MESSAGE='nonterminal task cannot have completion time'; END IF;
 IF NEW.status IN ('queued','dispatched','running','completed') THEN PERFORM app.intake_task_assert_input(NEW.scion_id,NEW.scion_revision,NEW.task_kind,NEW.input->'candidate_proposal'); END IF;
 RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION app.intake_research_worker_seen(),app.intake_research_candidate_valid(jsonb),app.intake_research_connection(jsonb,boolean),app.intake_research_assert_task(uuid,uuid),grimoire.intake_research_write_guard(),grimoire.intake_research_human_guard(),grimoire.intake_research_revoke_event() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.intake_research_worker_seen(),app.intake_research_candidate_valid(jsonb),app.intake_research_connection(jsonb,boolean),app.intake_research_assert_task(uuid,uuid) TO grimoire_intake_app;
COMMIT;
