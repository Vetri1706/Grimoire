-- Additive local BYOA preparation queue. Not part of verified GG-40.
BEGIN;
SET search_path=pg_catalog,grimoire,pg_temp;
CREATE TABLE grimoire.intake_agent_tasks (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, scion_id uuid NOT NULL, scion_revision integer NOT NULL,
 task_kind text NOT NULL CHECK(task_kind='prepare_physical_scope'),
 adapter text NOT NULL DEFAULT 'codex_cli' CHECK(adapter='codex_cli'),
 input jsonb NOT NULL CHECK(jsonb_typeof(input)='object' AND (input->'candidate_proposal'->'synthetic'='true'::jsonb) IS TRUE AND octet_length(input::text)<=64000),
 created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 request_key text NOT NULL CHECK(length(request_key) BETWEEN 1 AND 128),
 request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed')),
 attempt integer NOT NULL DEFAULT 0 CHECK(attempt>=0),
 claimed_by uuid, claimed_at timestamptz, lease_token uuid, lease_until timestamptz,
 completed_at timestamptz, proposal_id uuid, failure_code text,
 provider_run_id text CHECK(length(provider_run_id)<=100),
 output_sha256 text CHECK(output_sha256 ~ '^[a-f0-9]{64}$'),
 preparation_note text CHECK(length(preparation_note)<=2000),
 UNIQUE(org_id,id), UNIQUE(org_id,created_by,request_key),
 FOREIGN KEY(org_id,scion_id,scion_revision) REFERENCES grimoire.intake_revisions(org_id,scion_id,number),
 FOREIGN KEY(org_id,created_by) REFERENCES grimoire.principals(org_id,id),
 FOREIGN KEY(org_id,claimed_by) REFERENCES grimoire.principals(org_id,id),
 FOREIGN KEY(org_id,proposal_id) REFERENCES grimoire.intake_scope_proposals(org_id,id)
);
CREATE INDEX intake_agent_tasks_queue ON grimoire.intake_agent_tasks(org_id,status,created_at,id);
CREATE TABLE grimoire.intake_agent_task_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, task_id uuid NOT NULL,
 status text NOT NULL, attempt integer NOT NULL, principal_id uuid NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(org_id,task_id) REFERENCES grimoire.intake_agent_tasks(org_id,id),
 FOREIGN KEY(org_id,principal_id) REFERENCES grimoire.principals(org_id,id)
);
CREATE TRIGGER intake_agent_task_events_immutable BEFORE UPDATE OR DELETE ON grimoire.intake_agent_task_events
FOR EACH ROW EXECUTE FUNCTION grimoire.intake_deny_mutation();
CREATE FUNCTION grimoire.intake_agent_task_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE current_number integer; proposal grimoire.intake_scope_proposals%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='task audit cannot be deleted'; END IF;
 IF NEW.org_id IS DISTINCT FROM app.current_org_id() OR NOT app.intake_can_access() THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='task access denied'; END IF;
 IF TG_OP='INSERT' THEN
   IF NOT app.intake_can_write() OR app.intake_scope_is_agent() OR NEW.created_by IS DISTINCT FROM app.current_principal_id()
      OR NEW.status<>'queued' OR NEW.attempt<>0 OR NEW.claimed_by IS NOT NULL OR NEW.lease_token IS NOT NULL OR NEW.proposal_id IS NOT NULL OR NEW.completed_at IS NOT NULL THEN
     RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='only a Handler can enqueue a preparation task';
   END IF;
 ELSE
   IF (NEW.id,NEW.org_id,NEW.scion_id,NEW.scion_revision,NEW.task_kind,NEW.adapter,NEW.input,NEW.created_by,NEW.created_at,NEW.request_key,NEW.request_sha256)
      IS DISTINCT FROM (OLD.id,OLD.org_id,OLD.scion_id,OLD.scion_revision,OLD.task_kind,OLD.adapter,OLD.input,OLD.created_by,OLD.created_at,OLD.request_key,OLD.request_sha256) THEN
     RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='task input and identity are immutable';
   END IF;
   IF NOT app.intake_scope_is_agent() OR NOT app.intake_scope_can_propose() THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='enrolled preparation agent required'; END IF;
   IF NEW.status='running' THEN
     IF NOT (OLD.status='queued' OR (OLD.status='running' AND OLD.lease_until<clock_timestamp()))
       OR NEW.claimed_by IS DISTINCT FROM app.current_principal_id() OR NEW.lease_token IS NULL OR NEW.lease_until IS NULL
       OR NEW.lease_until<=clock_timestamp() OR NEW.lease_until>clock_timestamp()+interval '10 minutes 1 second'
       OR NEW.attempt<>OLD.attempt+1 THEN RAISE EXCEPTION USING ERRCODE='G2901',MESSAGE='task already claimed'; END IF;
   ELSIF NEW.status='failed' AND NEW.failure_code='INPUT_UNAVAILABLE' AND
     (OLD.status='queued' OR (OLD.status='running' AND OLD.lease_until<clock_timestamp())) THEN
     IF NEW.completed_at IS NULL OR NEW.proposal_id IS NOT NULL OR
       (NEW.claimed_by,NEW.claimed_at,NEW.lease_token,NEW.lease_until,NEW.attempt) IS DISTINCT FROM (OLD.claimed_by,OLD.claimed_at,OLD.lease_token,OLD.lease_until,OLD.attempt) THEN
       RAISE EXCEPTION USING ERRCODE='G2901',MESSAGE='invalid unavailable-task disposition';
     END IF;
   ELSIF NEW.status IN ('completed','failed') THEN
     IF OLD.status<>'running' OR OLD.claimed_by IS DISTINCT FROM app.current_principal_id() OR OLD.lease_until<clock_timestamp()
       OR (NEW.claimed_by,NEW.claimed_at,NEW.lease_token,NEW.lease_until,NEW.attempt) IS DISTINCT FROM (OLD.claimed_by,OLD.claimed_at,OLD.lease_token,OLD.lease_until,OLD.attempt)
       OR NEW.completed_at IS NULL THEN RAISE EXCEPTION USING ERRCODE='G2901',MESSAGE='active task lease required'; END IF;
     IF NEW.status='failed' AND (NEW.failure_code IS NULL OR NEW.failure_code !~ '^[A-Z0-9_]{1,100}$' OR NEW.proposal_id IS NOT NULL) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='bounded task failure code required'; END IF;
     IF NEW.status='completed' THEN
       SELECT * INTO proposal FROM grimoire.intake_scope_proposals WHERE (org_id,id,scion_id,scion_revision,created_by)=(NEW.org_id,NEW.proposal_id,NEW.scion_id,NEW.scion_revision,app.current_principal_id());
       IF NOT FOUND OR NEW.failure_code IS NOT NULL OR NEW.output_sha256 IS NULL OR NEW.preparation_note IS NULL OR length(btrim(NEW.preparation_note))<1 THEN RAISE EXCEPTION USING ERRCODE='G2901',MESSAGE='task result requires its own agent proposal'; END IF;
       IF (proposal.input-ARRAY['identity_match','unresolved_gaps','change_summary']) IS DISTINCT FROM ((NEW.input->'candidate_proposal')-ARRAY['identity_match','unresolved_gaps','change_summary'])
          OR ((NEW.input->'candidate_proposal'->>'identity_match')='ambiguous' AND proposal.input->>'identity_match'<>'ambiguous')
          OR NOT ((proposal.input->'unresolved_gaps') @> (NEW.input->'candidate_proposal'->'unresolved_gaps')) THEN
         RAISE EXCEPTION USING ERRCODE='G2901',MESSAGE='agent changed explicit task input';
       END IF;
     END IF;
   ELSE RAISE EXCEPTION USING ERRCODE='G2901',MESSAGE='invalid task transition'; END IF;
 END IF;
 IF NEW.status<>'failed' THEN
   current_number:=app.intake_scope_lock_scion(NEW.scion_id);
   IF current_number IS NULL OR current_number<>NEW.scion_revision THEN RAISE EXCEPTION USING ERRCODE='G2402',MESSAGE='stale task revision'; END IF;
   IF NOT EXISTS(SELECT 1 FROM grimoire.intake_revisions WHERE (org_id,scion_id,number,product_category)=(NEW.org_id,NEW.scion_id,NEW.scion_revision,'physical')) THEN RAISE EXCEPTION USING ERRCODE='G2801',MESSAGE='physical scope required'; END IF;
   PERFORM app.intake_scope_assert_sources(NEW.scion_id,NEW.scion_revision,NEW.input->'candidate_proposal');
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER intake_agent_task_guard BEFORE INSERT OR UPDATE OR DELETE ON grimoire.intake_agent_tasks FOR EACH ROW EXECUTE FUNCTION grimoire.intake_agent_task_guard();
CREATE FUNCTION grimoire.intake_agent_task_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp AS $$
BEGIN
 INSERT INTO grimoire.intake_agent_task_events(org_id,task_id,status,attempt,principal_id) VALUES(NEW.org_id,NEW.id,NEW.status,NEW.attempt,app.current_principal_id());
 RETURN NEW;
END $$;
CREATE TRIGGER intake_agent_task_event AFTER INSERT OR UPDATE ON grimoire.intake_agent_tasks FOR EACH ROW EXECUTE FUNCTION grimoire.intake_agent_task_event();
ALTER TABLE grimoire.intake_agent_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE grimoire.intake_agent_task_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY intake_agent_task_read ON grimoire.intake_agent_tasks FOR SELECT TO grimoire_intake_app USING(org_id=app.current_org_id() AND app.intake_can_access());
CREATE POLICY intake_agent_task_create ON grimoire.intake_agent_tasks FOR INSERT TO grimoire_intake_app WITH CHECK(org_id=app.current_org_id() AND created_by=app.current_principal_id() AND app.intake_can_write() AND NOT app.intake_scope_is_agent());
CREATE POLICY intake_agent_task_update ON grimoire.intake_agent_tasks FOR UPDATE TO grimoire_intake_app USING(org_id=app.current_org_id() AND app.intake_scope_is_agent() AND app.intake_scope_can_propose()) WITH CHECK(org_id=app.current_org_id() AND app.intake_scope_is_agent() AND app.intake_scope_can_propose());
CREATE POLICY intake_agent_event_read ON grimoire.intake_agent_task_events FOR SELECT TO grimoire_intake_app USING(org_id=app.current_org_id() AND app.intake_can_access());
REVOKE ALL ON grimoire.intake_agent_tasks,grimoire.intake_agent_task_events FROM PUBLIC;
GRANT SELECT,INSERT ON grimoire.intake_agent_tasks TO grimoire_intake_app;
GRANT UPDATE(status,attempt,claimed_by,claimed_at,lease_token,lease_until,completed_at,proposal_id,failure_code,provider_run_id,output_sha256,preparation_note) ON grimoire.intake_agent_tasks TO grimoire_intake_app;
GRANT SELECT ON grimoire.intake_agent_task_events TO grimoire_intake_app;
REVOKE ALL ON FUNCTION grimoire.intake_agent_task_guard(),grimoire.intake_agent_task_event() FROM PUBLIC;
COMMIT;
