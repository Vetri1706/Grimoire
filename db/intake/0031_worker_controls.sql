-- Additive Codex dispatch, cancellation, bounded execution and task provenance.
-- This local intake extension is not part of verified GG-40.
BEGIN;
SET search_path=pg_catalog,grimoire,pg_temp;
ALTER TABLE grimoire.intake_agent_tasks DROP CONSTRAINT intake_agent_tasks_task_kind_check;
ALTER TABLE grimoire.intake_agent_tasks ADD CHECK(task_kind IN ('prepare_physical_scope','prepare_offer_normalization'));
ALTER TABLE grimoire.intake_agent_tasks DROP CONSTRAINT intake_agent_tasks_status_check;
ALTER TABLE grimoire.intake_agent_tasks ADD CHECK(status IN ('queued','dispatched','running','cancel_requested','cancelled','completed','failed'));
ALTER TABLE grimoire.intake_agent_tasks DROP CONSTRAINT intake_agent_tasks_org_id_proposal_id_fkey;
ALTER TABLE grimoire.intake_agent_tasks ADD COLUMN timeout_seconds integer NOT NULL DEFAULT 240 CHECK(timeout_seconds BETWEEN 30 AND 300),
 ADD COLUMN dispatched_at timestamptz, ADD COLUMN cancelled_at timestamptz;
ALTER TABLE grimoire.intake_agent_task_events ADD COLUMN details jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE grimoire.intake_scope_proposals ADD COLUMN agent_task_id uuid REFERENCES grimoire.intake_agent_tasks(id);
CREATE UNIQUE INDEX intake_agent_one_active_per_org ON grimoire.intake_agent_tasks(org_id) WHERE status IN ('running','cancel_requested');

CREATE FUNCTION app.intake_task_candidate_matches(kind text,candidate jsonb,proposal jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
BEGIN
 IF kind='prepare_physical_scope' THEN
  RETURN COALESCE((proposal-ARRAY['identity_match','unresolved_gaps','change_summary']) IS NOT DISTINCT FROM (candidate-ARRAY['identity_match','unresolved_gaps','change_summary'])
    AND (candidate->>'identity_match'<>'ambiguous' OR proposal->>'identity_match'='ambiguous')
    AND ((proposal->'unresolved_gaps') @> (candidate->'unresolved_gaps')),false);
 END IF;
 -- Offer normalization may summarize; offer revisions and comparison basis stay pinned.
 RETURN candidate IS NOT NULL AND proposal IS NOT NULL AND (proposal-'change_summary') IS NOT DISTINCT FROM (candidate-'change_summary');
END $$;

CREATE FUNCTION app.intake_task_assert_input(scion uuid,revision integer,kind text,candidate jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE current_number integer;
BEGIN
 current_number:=app.intake_scope_lock_scion(scion);
 IF current_number IS NULL OR current_number<>revision THEN RAISE EXCEPTION USING ERRCODE='G2402',MESSAGE='stale task revision'; END IF;
 IF kind='prepare_physical_scope' THEN
  IF NOT EXISTS(SELECT 1 FROM grimoire.intake_revisions WHERE (org_id,scion_id,number,product_category)=(app.current_org_id(),scion,revision,'physical')) THEN RAISE EXCEPTION USING ERRCODE='G2801',MESSAGE='physical scope required'; END IF;
  PERFORM app.intake_scope_assert_sources(scion,revision,candidate);
 ELSE
  PERFORM app.intake_offer_assert_candidate(scion,revision,candidate);
 END IF;
END $$;

CREATE FUNCTION app.intake_task_assert_submission(task uuid,lease uuid,scion uuid,revision integer,kind text,proposal jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE job grimoire.intake_agent_tasks%ROWTYPE;
BEGIN
 SELECT * INTO job FROM grimoire.intake_agent_tasks WHERE id=task AND org_id=app.current_org_id() FOR UPDATE;
 IF NOT FOUND OR NOT app.intake_scope_is_agent() OR NOT app.intake_scope_can_propose() OR
    (job.scion_id,job.scion_revision,job.task_kind,job.claimed_by,job.lease_token) IS DISTINCT FROM
    (scion,revision,kind,app.current_principal_id(),lease) OR job.status<>'running' OR job.lease_until<=clock_timestamp() OR
    job.claimed_at+make_interval(secs=>job.timeout_seconds)<=clock_timestamp() OR
    NOT app.intake_task_candidate_matches(kind,job.input->'candidate_proposal',proposal) THEN
  RAISE EXCEPTION USING ERRCODE='G2901',MESSAGE='active dispatched task and matching proposal required';
 END IF;
 PERFORM app.intake_task_assert_input(scion,revision,kind,job.input->'candidate_proposal');
END $$;

CREATE OR REPLACE FUNCTION grimoire.intake_agent_task_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE proposal jsonb; is_handler boolean; is_agent boolean;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='task audit cannot be deleted'; END IF;
 IF NEW.org_id IS DISTINCT FROM app.current_org_id() OR NOT app.intake_can_access() THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='task access denied'; END IF;
 is_handler:=app.intake_can_write() AND NOT app.intake_scope_is_agent();
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

CREATE OR REPLACE FUNCTION grimoire.intake_agent_task_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp AS $$
BEGIN
 INSERT INTO grimoire.intake_agent_task_events(org_id,task_id,status,attempt,principal_id,details)
 VALUES(NEW.org_id,NEW.id,NEW.status,NEW.attempt,app.current_principal_id(),jsonb_build_object('scion_id',NEW.scion_id,'scion_revision',NEW.scion_revision,'task_kind',NEW.task_kind,'timeout_seconds',NEW.timeout_seconds,'execution_deadline',NEW.claimed_at+make_interval(secs=>NEW.timeout_seconds),'lease_until',NEW.lease_until,'proposal_id',NEW.proposal_id,'provider_run_id',NEW.provider_run_id,'output_sha256',NEW.output_sha256,'failure_code',NEW.failure_code));
 RETURN NEW;
END $$;

-- An agent proposal needs an active task even if it bypasses the HTTP adapter.
CREATE FUNCTION grimoire.intake_agent_scope_submission_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp AS $$
BEGIN
 IF app.intake_scope_is_agent() THEN
  PERFORM app.intake_task_assert_submission(nullif(current_setting('app.agent_task_id',true),'')::uuid,nullif(current_setting('app.agent_task_lease',true),'')::uuid,NEW.scion_id,NEW.scion_revision,'prepare_physical_scope',NEW.input);
  NEW.agent_task_id:=nullif(current_setting('app.agent_task_id',true),'')::uuid;
 ELSIF NEW.agent_task_id IS NOT NULL THEN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Handler cannot claim agent task provenance';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER intake_agent_scope_submission_guard BEFORE INSERT ON grimoire.intake_scope_proposals FOR EACH ROW EXECUTE FUNCTION grimoire.intake_agent_scope_submission_guard();
DROP POLICY intake_agent_task_update ON grimoire.intake_agent_tasks;
CREATE POLICY intake_agent_task_update ON grimoire.intake_agent_tasks FOR UPDATE TO grimoire_intake_app USING(org_id=app.current_org_id() AND (app.intake_can_write() OR app.intake_scope_can_propose())) WITH CHECK(org_id=app.current_org_id() AND (app.intake_can_write() OR app.intake_scope_can_propose()));
GRANT UPDATE(dispatched_at,cancelled_at) ON grimoire.intake_agent_tasks TO grimoire_intake_app;
REVOKE ALL ON FUNCTION app.intake_task_candidate_matches(text,jsonb,jsonb),app.intake_task_assert_input(uuid,integer,text,jsonb),app.intake_task_assert_submission(uuid,uuid,uuid,integer,text,jsonb),grimoire.intake_agent_scope_submission_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.intake_task_assert_input(uuid,integer,text,jsonb),app.intake_task_assert_submission(uuid,uuid,uuid,integer,text,jsonb) TO grimoire_intake_app;
COMMIT;
