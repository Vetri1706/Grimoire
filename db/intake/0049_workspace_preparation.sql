-- Own-organization workspace preparation is not procurement or approval authority.
-- Existing can_write, physical scope, supplier offer and worker result gates remain unchanged.
-- Earlier migration files are immutable; this migration replaces only preparation predicates.
BEGIN;
SET search_path=pg_catalog,grimoire,pg_temp;

CREATE FUNCTION app.intake_can_prepare_workspace() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
 SELECT app.intake_can_access() AND app.intake_can_manage_workspace()
   AND NOT app.intake_scope_is_agent()
$$;
COMMENT ON FUNCTION app.intake_can_prepare_workspace() IS
 'Own-organization human preparation of internal evidence and digital capability drafts. Does not grant procurement, engineering, commercial, agent-result or approval authority.';

-- Authorize the immutable task revision, not the current Scion category: a Handler
-- must still be able to cancel old digital work after revising the intake.
CREATE FUNCTION app.intake_can_control_preparation(wanted_scion uuid,wanted_revision integer,wanted_kind text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
 SELECT wanted_kind IN ('prepare_capability_plan','prepare_physical_scope','prepare_offer_normalization')
   AND app.intake_can_prepare_workspace()
   AND EXISTS (
     SELECT 1 FROM grimoire.intake_revisions r
     WHERE (r.org_id,r.scion_id,r.number)=(app.current_org_id(),wanted_scion,wanted_revision)
       AND (app.intake_can_write()
         OR (wanted_kind='prepare_capability_plan' AND r.product_category='digital'))
   )
$$;
COMMENT ON FUNCTION app.intake_can_control_preparation(uuid,integer,text) IS
 'A plain organization administrator controls only digital capability-plan work. Existing procurement preparers retain their supported physical/offer task controls.';

REVOKE ALL ON FUNCTION app.intake_can_prepare_workspace(),
 app.intake_can_control_preparation(uuid,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.intake_can_prepare_workspace(),
 app.intake_can_control_preparation(uuid,integer,text) TO grimoire_intake_app;

CREATE OR REPLACE FUNCTION grimoire.intake_guard_source() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,grimoire,pg_temp AS $$
DECLARE current_number integer;
BEGIN
 IF NEW.org_id IS DISTINCT FROM app.current_org_id() OR NEW.created_by IS DISTINCT FROM app.current_principal_id()
   OR NEW.current_revision<>0 OR NOT app.intake_can_prepare_workspace() THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='source creation is not authorized';
 END IF;
 SELECT current_revision INTO STRICT current_number FROM grimoire.intake_scions
   WHERE (org_id,id)=(NEW.org_id,NEW.scion_id) FOR UPDATE;
 IF NEW.scion_revision<>current_number THEN
   RAISE EXCEPTION USING ERRCODE='G2402',MESSAGE='source must link the current Scion revision';
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION grimoire.intake_guard_source_write() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,grimoire,pg_temp AS $$
DECLARE current_number integer; source_length integer;
BEGIN
 IF NEW.org_id IS DISTINCT FROM app.current_org_id() OR NEW.created_by IS DISTINCT FROM app.current_principal_id()
   OR NOT app.intake_can_prepare_workspace() THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='source write is not authorized';
 END IF;
 SELECT current_revision INTO STRICT current_number FROM grimoire.intake_sources
   WHERE (org_id,id)=(NEW.org_id,NEW.source_id) FOR UPDATE;
 IF NOT app.intake_source_permitted(NEW.source_id) THEN
   RAISE EXCEPTION USING ERRCODE='G2601',MESSAGE='source permission has been revoked';
 END IF;
 IF TG_TABLE_NAME='intake_source_revisions' THEN
   IF NEW.number<>current_number+1 THEN
     RAISE EXCEPTION USING ERRCODE='G2402',MESSAGE='source revision must follow current revision';
   END IF;
   IF NEW.source_text IS NOT NULL OR NOT EXISTS(SELECT 1 FROM grimoire.intake_source_objects o
      WHERE (o.org_id,o.source_id,o.source_revision,o.content_sha256,o.byte_length)=
            (NEW.org_id,NEW.source_id,NEW.number,NEW.content_sha256,NEW.byte_length)) THEN
     RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='new source revision requires an exact immutable S3 object reference and no inline text';
   END IF;
 ELSIF TG_TABLE_NAME='intake_source_revocations' THEN
   IF NEW.source_revision<>current_number THEN
     RAISE EXCEPTION USING ERRCODE='G2402',MESSAGE='revocation must reference the current revision';
   END IF;
 ELSE
   SELECT byte_length INTO STRICT source_length FROM grimoire.intake_source_revisions
     WHERE (org_id,source_id,number)=(NEW.org_id,NEW.source_id,NEW.source_revision);
   IF NEW.start_byte<0 OR NEW.end_byte<=NEW.start_byte OR NEW.end_byte>source_length
      OR octet_length(NEW.quote)<>NEW.end_byte-NEW.start_byte THEN
     RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='claim locator must have valid UTF-8 byte bounds';
   END IF;
   -- Exact quote matching now requires a verified version-specific object read
   -- in the Rust API. PostgreSQL deliberately has no source-text fallback.
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION grimoire.intake_guard_source_object() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,grimoire,pg_temp AS $$
BEGIN
 IF NEW.object_key NOT LIKE 'org/'||NEW.org_id::text||'/sources/'||NEW.source_id::text||'/revisions/'||NEW.source_revision::text||'/%' THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='object key must match organization/source/revision';
 END IF;
 IF current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='grimoire.intake_source_objects'::regclass)) THEN
   RETURN NEW; -- administrator-only verified legacy export
 END IF;
 IF NEW.org_id IS DISTINCT FROM app.current_org_id() OR NEW.recorded_by IS DISTINCT FROM app.current_principal_id()
    OR NOT app.intake_can_prepare_workspace() THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='source object write is not authorized';
 END IF;
 PERFORM 1 FROM grimoire.intake_sources WHERE (org_id,id)=(NEW.org_id,NEW.source_id) FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='source object owner unavailable'; END IF;
 IF NOT app.intake_source_permitted(NEW.source_id) THEN
   RAISE EXCEPTION USING ERRCODE='G2601',MESSAGE='source permission has been revoked';
 END IF;
 RETURN NEW;
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

CREATE OR REPLACE FUNCTION grimoire.intake_evidence_comparison_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE plan grimoire.intake_capability_plans%ROWTYPE; alternative jsonb; criterion jsonb; claim uuid; current_number integer; item jsonb; labels text[]:=ARRAY[]::text[]; keys text[];
BEGIN
 IF NEW.org_id IS DISTINCT FROM app.current_org_id() OR NEW.created_by IS DISTINCT FROM app.current_principal_id() OR NOT app.intake_can_control_preparation(NEW.scion_id,NEW.scion_revision,'prepare_capability_plan') THEN
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

CREATE OR REPLACE FUNCTION app.intake_bind_agent_task(task_arg uuid,agent_arg uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE organization uuid:=app.current_org_id(); profile jsonb; version integer; task grimoire.intake_agent_tasks%ROWTYPE; skills jsonb; previous uuid;
BEGIN
 IF NOT app.intake_can_prepare_workspace() THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Handler required'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('agent-org:'||organization::text,0));
 SELECT r.config,r.number INTO profile,version FROM grimoire.intake_managed_entities e
  JOIN grimoire.intake_managed_revisions r ON (r.org_id,r.entity_id,r.number)=(e.org_id,e.id,e.current_revision)
  WHERE e.org_id=organization AND e.id=agent_arg AND e.kind='agent' FOR SHARE OF e;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='G3804',MESSAGE='agent not found'; END IF;
 SELECT * INTO task FROM grimoire.intake_agent_tasks WHERE org_id=organization AND id=task_arg FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='G3804',MESSAGE='task not found'; END IF;
 IF NOT app.intake_can_control_preparation(task.scion_id,task.scion_revision,task.task_kind) THEN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='task preparation is not authorized';
 END IF;
 SELECT agent_id INTO previous FROM grimoire.intake_task_agent_bindings WHERE org_id=organization AND task_id=task_arg;
 IF FOUND THEN
  IF previous=agent_arg THEN RETURN; END IF;
  RAISE EXCEPTION USING ERRCODE='G2901',MESSAGE='assignment immutable';
 END IF;
 IF task.status<>'queued' OR task.timeout_seconds>(profile->>'timeout_seconds')::integer OR (profile->>'paused')::boolean THEN
  RAISE EXCEPTION USING ERRCODE='G4301',MESSAGE='agent paused or execution bounds incompatible';
 END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('id',e.id,'revision',r.number,'name',r.config->>'name','instructions',r.config->>'instructions') ORDER BY e.id),'[]'::jsonb)
  INTO skills FROM grimoire.intake_managed_entities e JOIN grimoire.intake_managed_revisions r ON (r.org_id,r.entity_id,r.number)=(e.org_id,e.id,e.current_revision)
  WHERE e.org_id=organization AND e.kind='skill' AND e.id IN (SELECT value::uuid FROM jsonb_array_elements_text(profile->'skill_ids'));
 INSERT INTO grimoire.intake_task_agent_bindings(org_id,task_id,agent_id,agent_revision,snapshot)
 VALUES(organization,task_arg,agent_arg,version,jsonb_build_object('id',agent_arg,'revision',version,'name',profile->>'name','instructions',profile->>'instructions','skills',skills,'adapter','codex_cli'));
END $$;
-- Internal source content remains subject to exact object, permission, revision
-- and claim checks. Agents and foreign organizations gain no write access.
ALTER POLICY intake_source_create ON grimoire.intake_sources
 WITH CHECK (org_id=app.current_org_id() AND created_by=app.current_principal_id()
   AND current_revision=0 AND app.intake_can_prepare_workspace());
ALTER POLICY intake_source_lock ON grimoire.intake_sources
 USING (org_id=app.current_org_id() AND app.intake_can_prepare_workspace())
 WITH CHECK (org_id=app.current_org_id() AND app.intake_can_prepare_workspace());
ALTER POLICY intake_source_revision_create ON grimoire.intake_source_revisions
 WITH CHECK (org_id=app.current_org_id() AND created_by=app.current_principal_id()
   AND app.intake_can_prepare_workspace() AND app.intake_source_permitted(source_id));
ALTER POLICY intake_source_claim_create ON grimoire.intake_source_claims
 WITH CHECK (org_id=app.current_org_id() AND created_by=app.current_principal_id()
   AND app.intake_can_prepare_workspace() AND app.intake_source_permitted(source_id));
ALTER POLICY intake_source_revocation_create ON grimoire.intake_source_revocations
 WITH CHECK (org_id=app.current_org_id() AND created_by=app.current_principal_id()
   AND app.intake_can_prepare_workspace());
ALTER POLICY intake_source_object_create ON grimoire.intake_source_objects
 WITH CHECK (org_id=app.current_org_id() AND recorded_by=app.current_principal_id()
   AND app.intake_can_prepare_workspace() AND app.intake_source_permitted(source_id));

-- No human can claim, complete or forge the result of a task; the existing
-- trigger still enforces all lease, result-provenance and state-transition rules.
ALTER POLICY intake_agent_task_create ON grimoire.intake_agent_tasks
 WITH CHECK (org_id=app.current_org_id() AND created_by=app.current_principal_id()
   AND app.intake_can_control_preparation(scion_id,scion_revision,task_kind));
ALTER POLICY intake_agent_task_update ON grimoire.intake_agent_tasks
 USING (org_id=app.current_org_id() AND (
   app.intake_can_control_preparation(scion_id,scion_revision,task_kind)
   OR (app.intake_scope_is_agent() AND app.intake_scope_can_propose())))
 WITH CHECK (org_id=app.current_org_id() AND (
   app.intake_can_control_preparation(scion_id,scion_revision,task_kind)
   OR (app.intake_scope_is_agent() AND app.intake_scope_can_propose())));
ALTER POLICY intake_evidence_comparison_insert ON grimoire.intake_evidence_comparisons
 WITH CHECK (org_id=app.current_org_id() AND created_by=app.current_principal_id()
   AND app.intake_can_control_preparation(scion_id,scion_revision,'prepare_capability_plan'));

COMMIT;

