-- New Windows adaptive draft preparation. Not part of verified GG-40.
-- 0035-0037 are reserved for unavailable Mac-origin work; this does not recreate it.
-- Apply to the verified Windows migration chain through 0034.
BEGIN;
SET search_path=pg_catalog,grimoire,pg_temp;

CREATE TABLE grimoire.intake_capability_plans (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, scion_id uuid NOT NULL, scion_revision integer NOT NULL,
 agent_task_id uuid NOT NULL,
 input jsonb NOT NULL CHECK(jsonb_typeof(input)='object' AND (input->'synthetic'='true'::jsonb) IS TRUE AND octet_length(input::text)<=64000),
 created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 request_key text NOT NULL CHECK(length(request_key) BETWEEN 1 AND 128),
 request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
 UNIQUE(org_id,id), UNIQUE(org_id,agent_task_id), UNIQUE(org_id,created_by,request_key),
 FOREIGN KEY(org_id,scion_id,scion_revision) REFERENCES grimoire.intake_revisions(org_id,scion_id,number),
 FOREIGN KEY(org_id,created_by) REFERENCES grimoire.principals(org_id,id),
 FOREIGN KEY(org_id,agent_task_id) REFERENCES grimoire.intake_agent_tasks(org_id,id)
);
CREATE TABLE grimoire.intake_evidence_comparisons (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, scion_id uuid NOT NULL, scion_revision integer NOT NULL,
 plan_id uuid NOT NULL,
 input jsonb NOT NULL CHECK(jsonb_typeof(input)='object' AND (input->'synthetic'='true'::jsonb) IS TRUE AND octet_length(input::text)<=48000),
 created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 request_key text NOT NULL CHECK(length(request_key) BETWEEN 1 AND 128),
 request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
 UNIQUE(org_id,id), UNIQUE(org_id,created_by,request_key),
 FOREIGN KEY(org_id,scion_id,scion_revision) REFERENCES grimoire.intake_revisions(org_id,scion_id,number),
 FOREIGN KEY(org_id,created_by) REFERENCES grimoire.principals(org_id,id),
 FOREIGN KEY(org_id,plan_id) REFERENCES grimoire.intake_capability_plans(org_id,id)
);
COMMENT ON TABLE grimoire.intake_capability_plans IS 'Immutable synthetic agent preparation pinned to Handler intake and a leased task. Never evidence verification, reviewer confirmation or sourcing approval.';
COMMENT ON TABLE grimoire.intake_evidence_comparisons IS 'Handler-labelled review drafts linking exact unverified claims. No provider listing, recommendation, commercial offer or governed decision.';

-- This is a registry of implemented local data paths, not a provider catalog.
-- Adding an external adapter requires separate configuration and permission work.
CREATE FUNCTION app.intake_capability_connectors() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_array(
   jsonb_build_object('id','handler_intake','name','Handler intake','kind','local_intake','enabled',true,'status','available','description','Exact Handler-provided Scion revision through the organization-scoped Rust API; unverified.'),
   jsonb_build_object('id','scion_sources','name','Authorized Scion sources','kind','local_evidence','enabled',true,'status','permission_checked_on_read','description','Existing synthetic source revisions and claims through Rust, PostgreSQL and pinned hash-verified MinIO objects. Permission is required for every read.'))
$$;
CREATE FUNCTION app.intake_capability_candidate(scion uuid,revision integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE r grimoire.intake_revisions%ROWTYPE; current_number integer; gaps jsonb;
BEGIN
 current_number:=app.intake_scope_lock_scion(scion);
 IF current_number IS NULL THEN RAISE EXCEPTION USING ERRCODE='G3804',MESSAGE='Scion unavailable'; END IF;
 IF current_number<>revision THEN RAISE EXCEPTION USING ERRCODE='G2402',MESSAGE='stale capability revision'; END IF;
 SELECT * INTO STRICT r FROM grimoire.intake_revisions WHERE (org_id,scion_id,number)=(app.current_org_id(),scion,revision);
 gaps:=jsonb_build_array('External data connectors are not configured; no external provider evidence has been retrieved.','Handler-provided intake is unverified; a capability plan grants no approval.');
 IF r.product_description IS NULL OR length(btrim(r.product_description))=0 THEN gaps:=gaps||jsonb_build_array('Product description is missing.'); END IF;
 IF r.product_category='unspecified' THEN gaps:=gaps||jsonb_build_array('Product category is unresolved.'); END IF;
 IF r.decision IS NULL OR length(btrim(r.decision))=0 THEN gaps:=gaps||jsonb_build_array('The decision to be made is unresolved.'); END IF;
 IF r.requirements IS NULL OR jsonb_array_length(r.requirements)=0 THEN gaps:=gaps||jsonb_build_array('Known requirements have not been recorded.'); END IF;
 IF r.questions IS NULL THEN gaps:=gaps||jsonb_build_array('Unresolved questions have not been recorded.');
 ELSIF jsonb_array_length(r.questions)>0 THEN gaps:=gaps||jsonb_build_array(format('%s Handler questions remain open; resolve the exact questions in the pinned intake.',jsonb_array_length(r.questions))); END IF;
 RETURN jsonb_build_object('synthetic',true,'intake',jsonb_build_object('scion_id',scion,'revision',revision,'name',r.name,'product_description',r.product_description,'product_category',r.product_category,'decision',r.decision,'requirements',r.requirements,'questions',r.questions),'connectors',app.intake_capability_connectors(),'unresolved_gaps',gaps);
END $$;

CREATE FUNCTION app.intake_capability_matches(candidate jsonb,proposal jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE cap jsonb; connector jsonb; item jsonb; keys text[]:=ARRAY[]::text[];
BEGIN
 IF jsonb_typeof(proposal) IS DISTINCT FROM 'object' OR NOT (proposal ?& ARRAY['synthetic','summary','capabilities','unresolved_gaps','change_summary']) OR proposal-'synthetic'-'summary'-'capabilities'-'unresolved_gaps'-'change_summary'<>'{}'::jsonb OR
    jsonb_typeof(proposal->'summary') IS DISTINCT FROM 'string' OR jsonb_typeof(proposal->'change_summary') IS DISTINCT FROM 'string' OR
    proposal->'synthetic' IS DISTINCT FROM 'true'::jsonb OR length(btrim(proposal->>'summary')) NOT BETWEEN 1 AND 4000 OR
    length(btrim(proposal->>'change_summary')) NOT BETWEEN 1 AND 1000 OR
    jsonb_typeof(proposal->'capabilities') IS DISTINCT FROM 'array' OR jsonb_typeof(proposal->'unresolved_gaps') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF jsonb_array_length(proposal->'capabilities') NOT BETWEEN 1 AND 12 OR jsonb_array_length(proposal->'unresolved_gaps')>40 OR
    NOT ((proposal->'unresolved_gaps') @> (candidate->'unresolved_gaps')) THEN RETURN false; END IF;
 FOR cap IN SELECT value FROM jsonb_array_elements(proposal->'capabilities') LOOP
  IF jsonb_typeof(cap) IS DISTINCT FROM 'object' OR NOT (cap ?& ARRAY['key','title','reason','evidence_needed','connector_ids']) OR cap-'key'-'title'-'reason'-'evidence_needed'-'connector_ids'<>'{}'::jsonb OR
     jsonb_typeof(cap->'key') IS DISTINCT FROM 'string' OR jsonb_typeof(cap->'title') IS DISTINCT FROM 'string' OR jsonb_typeof(cap->'reason') IS DISTINCT FROM 'string' OR
     cap->>'key' IS NULL OR cap->>'key' !~ '^[a-z0-9_]{1,80}$' OR cap->>'key'=ANY(keys) OR
     length(btrim(cap->>'title')) NOT BETWEEN 1 AND 200 OR length(btrim(cap->>'reason')) NOT BETWEEN 1 AND 2000 OR
     jsonb_typeof(cap->'evidence_needed') IS DISTINCT FROM 'array' OR jsonb_typeof(cap->'connector_ids') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  keys:=array_append(keys,cap->>'key');
  IF jsonb_array_length(cap->'evidence_needed') NOT BETWEEN 1 AND 20 OR jsonb_array_length(cap->'connector_ids')>2 THEN RETURN false; END IF;
  FOR connector IN SELECT value FROM jsonb_array_elements(cap->'connector_ids') LOOP
   IF jsonb_typeof(connector)<>'string' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(candidate->'connectors') c WHERE c->'id'=connector AND c->'enabled'='true'::jsonb) THEN RETURN false; END IF;
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(cap->'evidence_needed') LOOP
   IF jsonb_typeof(item)<>'string' OR length(btrim(item#>>'{}')) NOT BETWEEN 1 AND 2000 THEN RETURN false; END IF;
  END LOOP;
 END LOOP;
 FOR item IN SELECT value FROM jsonb_array_elements(proposal->'unresolved_gaps') LOOP
  IF jsonb_typeof(item)<>'string' OR length(btrim(item#>>'{}')) NOT BETWEEN 1 AND 2000 THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $$;

CREATE OR REPLACE FUNCTION app.intake_task_candidate_matches(kind text,candidate jsonb,proposal jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
BEGIN
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
 IF kind='prepare_capability_plan' THEN
  IF candidate IS DISTINCT FROM app.intake_capability_candidate(scion,revision) THEN RAISE EXCEPTION USING ERRCODE='G3801',MESSAGE='capability task must use the exact server-pinned intake and local connector registry'; END IF;
 ELSIF kind='prepare_physical_scope' THEN
  IF NOT EXISTS(SELECT 1 FROM grimoire.intake_revisions WHERE (org_id,scion_id,number,product_category)=(app.current_org_id(),scion,revision,'physical')) THEN RAISE EXCEPTION USING ERRCODE='G2801',MESSAGE='physical scope required'; END IF;
  PERFORM app.intake_scope_assert_sources(scion,revision,candidate);
 ELSE
  PERFORM app.intake_offer_assert_candidate(scion,revision,candidate);
 END IF;
END $$;
ALTER TABLE grimoire.intake_agent_tasks DROP CONSTRAINT intake_agent_tasks_task_kind_check;
ALTER TABLE grimoire.intake_agent_tasks ADD CONSTRAINT intake_agent_tasks_task_kind_check CHECK(task_kind IN ('prepare_physical_scope','prepare_offer_normalization','prepare_capability_plan'));

-- Shared queue guard retains the full 0031 transitions, cancellation, execution
-- bounds, lease provenance and one-running-task-per-organization checks.
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
  ELSIF NEW.task_kind='prepare_capability_plan' THEN
   SELECT input INTO proposal FROM grimoire.intake_capability_plans WHERE (org_id,id,scion_id,scion_revision,created_by,agent_task_id)=(NEW.org_id,NEW.proposal_id,NEW.scion_id,NEW.scion_revision,app.current_principal_id(),NEW.id);
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

CREATE FUNCTION grimoire.intake_capability_plan_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
BEGIN
 IF NEW.org_id IS DISTINCT FROM app.current_org_id() OR NEW.created_by IS DISTINCT FROM app.current_principal_id() OR
    NOT app.intake_scope_is_agent() OR NOT app.intake_scope_can_propose() OR app.intake_can_write() OR app.intake_scope_can_confirm() THEN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='only an enrolled nonapproving preparation agent can submit a capability plan';
 END IF;
 IF NOT app.intake_capability_matches(app.intake_capability_candidate(NEW.scion_id,NEW.scion_revision),NEW.input) THEN
  RAISE EXCEPTION USING ERRCODE='G3801',MESSAGE='invalid capability plan or omitted evidence gaps';
 END IF;
 IF NEW.agent_task_id IS DISTINCT FROM nullif(current_setting('app.agent_task_id',true),'')::uuid THEN RAISE EXCEPTION USING ERRCODE='G2901',MESSAGE='matching task provenance required'; END IF;
 PERFORM app.intake_task_assert_submission(NEW.agent_task_id,nullif(current_setting('app.agent_task_lease',true),'')::uuid,NEW.scion_id,NEW.scion_revision,'prepare_capability_plan',NEW.input);
 RETURN NEW;
END $$;
CREATE TRIGGER intake_capability_plan_guard BEFORE INSERT ON grimoire.intake_capability_plans FOR EACH ROW EXECUTE FUNCTION grimoire.intake_capability_plan_guard();

CREATE FUNCTION app.intake_capability_assert_claim(scion uuid,revision integer,claim uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE c grimoire.intake_source_claims%ROWTYPE; s grimoire.intake_sources%ROWTYPE; r grimoire.intake_source_revisions%ROWTYPE; current_number integer;
BEGIN
 current_number:=app.intake_scope_lock_scion(scion);
 IF current_number IS NULL THEN RAISE EXCEPTION USING ERRCODE='G3804',MESSAGE='Scion unavailable'; END IF;
 IF current_number<>revision THEN RAISE EXCEPTION USING ERRCODE='G2402',MESSAGE='stale Scion revision'; END IF;
 SELECT * INTO c FROM grimoire.intake_source_claims WHERE id=claim AND org_id=app.current_org_id();
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='G3804',MESSAGE='claim unavailable'; END IF;
 SELECT * INTO s FROM grimoire.intake_sources WHERE (org_id,id,scion_id)=(app.current_org_id(),c.source_id,scion) FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='G3804',MESSAGE='claim unavailable'; END IF;
 IF NOT app.intake_source_permitted(s.id) THEN RAISE EXCEPTION USING ERRCODE='G2601',MESSAGE='source permission unavailable'; END IF;
 IF s.scion_revision<>revision OR s.current_revision<>c.source_revision THEN RAISE EXCEPTION USING ERRCODE='G3802',MESSAGE='claim is bound to a stale Scion or source revision'; END IF;
 SELECT * INTO STRICT r FROM grimoire.intake_source_revisions WHERE (org_id,source_id,number)=(s.org_id,s.id,c.source_revision);
 IF r.rights_status<>'granted' OR r.permitted_use<>'scion_review' OR length(btrim(r.permission_basis))=0 THEN RAISE EXCEPTION USING ERRCODE='G2601',MESSAGE='source permission unavailable'; END IF;
 IF NOT EXISTS(SELECT 1 FROM grimoire.intake_source_objects o WHERE (o.org_id,o.source_id,o.source_revision,o.content_sha256,o.byte_length)=(r.org_id,r.source_id,r.number,r.content_sha256,r.byte_length)) THEN
  RAISE EXCEPTION USING ERRCODE='G3802',MESSAGE='source object binding is missing';
 END IF;
END $$;
CREATE FUNCTION grimoire.intake_evidence_comparison_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE plan grimoire.intake_capability_plans%ROWTYPE; alternative jsonb; criterion jsonb; claim uuid; current_number integer; item jsonb; labels text[]:=ARRAY[]::text[]; keys text[];
BEGIN
 IF NEW.org_id IS DISTINCT FROM app.current_org_id() OR NEW.created_by IS DISTINCT FROM app.current_principal_id() OR NOT app.intake_can_write() OR app.intake_scope_is_agent() THEN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Handler-only comparison draft';
 END IF;
 current_number:=app.intake_scope_lock_scion(NEW.scion_id);
 IF current_number IS NULL OR current_number<>NEW.scion_revision THEN RAISE EXCEPTION USING ERRCODE='G2402',MESSAGE='stale comparison revision'; END IF;
 SELECT * INTO plan FROM grimoire.intake_capability_plans WHERE (org_id,id,scion_id)=(NEW.org_id,NEW.plan_id,NEW.scion_id);
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='G3804',MESSAGE='plan unavailable'; END IF;
 IF plan.scion_revision<>NEW.scion_revision THEN RAISE EXCEPTION USING ERRCODE='G3802',MESSAGE='plan pins an older revision'; END IF;
 IF NOT (NEW.input ?& ARRAY['synthetic','plan_id','alternatives','unresolved_gaps','change_summary']) OR NEW.input->>'plan_id' IS DISTINCT FROM NEW.plan_id::text OR
    NEW.input-'synthetic'-'plan_id'-'alternatives'-'unresolved_gaps'-'change_summary'<>'{}'::jsonb OR
    jsonb_typeof(NEW.input->'change_summary') IS DISTINCT FROM 'string' OR length(btrim(NEW.input->>'change_summary')) NOT BETWEEN 1 AND 1000 OR
    jsonb_typeof(NEW.input->'alternatives') IS DISTINCT FROM 'array' OR jsonb_typeof(NEW.input->'unresolved_gaps') IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION USING ERRCODE='G3801',MESSAGE='invalid comparison shape';
 END IF;
 IF jsonb_array_length(NEW.input->'alternatives') NOT BETWEEN 2 AND 6 OR jsonb_array_length(NEW.input->'unresolved_gaps')>40 THEN RAISE EXCEPTION USING ERRCODE='G3801',MESSAGE='bounded Handler alternatives and gaps required'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(NEW.input->'unresolved_gaps') LOOP
  IF jsonb_typeof(item)<>'string' OR length(btrim(item#>>'{}')) NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION USING ERRCODE='G3801',MESSAGE='invalid evidence gap'; END IF;
 END LOOP;
 FOR alternative IN SELECT value FROM jsonb_array_elements(NEW.input->'alternatives') LOOP
  IF NOT (alternative ?& ARRAY['label','criteria']) OR alternative-'label'-'criteria'<>'{}'::jsonb OR jsonb_typeof(alternative->'label') IS DISTINCT FROM 'string' OR length(btrim(alternative->>'label')) NOT BETWEEN 1 AND 200 OR jsonb_typeof(alternative->'criteria') IS DISTINCT FROM 'array' OR lower(btrim(alternative->>'label'))=ANY(labels) THEN RAISE EXCEPTION USING ERRCODE='G3801',MESSAGE='invalid or duplicate alternative'; END IF;
  labels:=array_append(labels,lower(btrim(alternative->>'label')));
  keys:=ARRAY[]::text[];
  IF jsonb_array_length(alternative->'criteria') NOT BETWEEN 1 AND 12 THEN RAISE EXCEPTION USING ERRCODE='G3801',MESSAGE='explicit capability criteria required'; END IF;
  FOR criterion IN SELECT value FROM jsonb_array_elements(alternative->'criteria') LOOP
   IF NOT (criterion ?& ARRAY['capability_key','claim_ids']) OR criterion-'capability_key'-'claim_ids'<>'{}'::jsonb OR jsonb_typeof(criterion->'capability_key') IS DISTINCT FROM 'string' OR jsonb_typeof(criterion->'claim_ids') IS DISTINCT FROM 'array' OR criterion->>'capability_key'=ANY(keys) OR
      NOT EXISTS(SELECT 1 FROM jsonb_array_elements(plan.input->'capabilities') c WHERE c->>'key'=criterion->>'capability_key') THEN RAISE EXCEPTION USING ERRCODE='G3801',MESSAGE='criterion must name this exact plan capability'; END IF;
   IF jsonb_array_length(criterion->'claim_ids')>12 THEN RAISE EXCEPTION USING ERRCODE='G3801',MESSAGE='claim count exceeded'; END IF;
   keys:=array_append(keys,criterion->>'capability_key');
   IF (SELECT count(DISTINCT value) FROM jsonb_array_elements(criterion->'claim_ids'))<>jsonb_array_length(criterion->'claim_ids') THEN RAISE EXCEPTION USING ERRCODE='G3801',MESSAGE='claim references must be unique'; END IF;
  END LOOP;
 END LOOP;
 FOR claim IN SELECT DISTINCT c.value::uuid FROM jsonb_array_elements(NEW.input->'alternatives') a CROSS JOIN LATERAL jsonb_array_elements(a->'criteria') r CROSS JOIN LATERAL jsonb_array_elements_text(r->'claim_ids') c ORDER BY 1 LOOP
  PERFORM app.intake_capability_assert_claim(NEW.scion_id,NEW.scion_revision,claim);
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER intake_evidence_comparison_guard BEFORE INSERT ON grimoire.intake_evidence_comparisons FOR EACH ROW EXECUTE FUNCTION grimoire.intake_evidence_comparison_guard();

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['intake_capability_plans','intake_evidence_comparisons'] LOOP
  EXECUTE format('ALTER TABLE grimoire.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY %I_org_read ON grimoire.%I FOR SELECT TO grimoire_intake_app USING(org_id=app.current_org_id() AND app.intake_can_access())',t,t);
  EXECUTE format('CREATE TRIGGER %I_immutable BEFORE UPDATE OR DELETE ON grimoire.%I FOR EACH ROW EXECUTE FUNCTION grimoire.intake_deny_mutation()',t,t);
  EXECUTE format('REVOKE ALL ON grimoire.%I FROM PUBLIC',t);
  EXECUTE format('GRANT SELECT,INSERT ON grimoire.%I TO grimoire_intake_app',t);
 END LOOP;
END $$;
CREATE POLICY intake_capability_plan_insert ON grimoire.intake_capability_plans FOR INSERT TO grimoire_intake_app WITH CHECK(org_id=app.current_org_id() AND created_by=app.current_principal_id() AND app.intake_scope_is_agent() AND app.intake_scope_can_propose() AND NOT app.intake_can_write());
CREATE POLICY intake_evidence_comparison_insert ON grimoire.intake_evidence_comparisons FOR INSERT TO grimoire_intake_app WITH CHECK(org_id=app.current_org_id() AND created_by=app.current_principal_id() AND app.intake_can_write() AND NOT app.intake_scope_is_agent());
REVOKE ALL ON FUNCTION app.intake_capability_connectors(),app.intake_capability_candidate(uuid,integer),app.intake_capability_matches(jsonb,jsonb),app.intake_capability_assert_claim(uuid,integer,uuid),grimoire.intake_capability_plan_guard(),grimoire.intake_evidence_comparison_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.intake_capability_candidate(uuid,integer),app.intake_capability_assert_claim(uuid,integer,uuid) TO grimoire_intake_app;
COMMIT;
