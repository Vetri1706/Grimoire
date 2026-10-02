-- A follow-up cannot preserve or publish output derived from withdrawn thread evidence.
BEGIN;
CREATE FUNCTION grimoire.intake_conversation_artifact_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE root uuid; task_ids uuid[]; dependency record;
BEGIN
 SELECT thread_task_id INTO root FROM grimoire.intake_task_followups WHERE (org_id,agent_task_id)=(NEW.org_id,NEW.agent_task_id);
 IF root IS NULL THEN RETURN NEW; END IF;
 IF NEW.org_id IS DISTINCT FROM app.current_org_id() THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='task conversation organization mismatch'; END IF;
 SELECT array_agg(id ORDER BY id) INTO task_ids FROM (
  SELECT root AS id UNION SELECT agent_task_id FROM grimoire.intake_task_followups WHERE org_id=NEW.org_id AND thread_task_id=root
 ) thread;
 -- Use the same source/capture locks as withdrawal, then read fresh Watchtower
 -- state. The existing submission guards still enforce lease, revision and shape.
 FOR dependency IN SELECT DISTINCT d.scion_id,d.source_id FROM grimoire.intake_watch_dependencies d
  WHERE d.org_id=NEW.org_id AND d.node_kind='agent_task' AND d.node_id=ANY(task_ids) AND d.source_id IS NOT NULL ORDER BY d.source_id,d.scion_id
 LOOP PERFORM app.intake_source_read_lock(dependency.scion_id,dependency.source_id); END LOOP;
 PERFORM id FROM grimoire.intake_research_captures WHERE org_id=NEW.org_id AND agent_task_id=ANY(task_ids) ORDER BY id FOR SHARE;
 IF app.intake_conversation_blocked(root) THEN RAISE EXCEPTION USING ERRCODE='G2601',MESSAGE='thread evidence was withdrawn; prepare fresh work from authorized inputs'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION grimoire.intake_conversation_artifact_guard() FROM PUBLIC;
CREATE TRIGGER intake_conversation_plan_guard BEFORE INSERT ON grimoire.intake_capability_plans FOR EACH ROW EXECUTE FUNCTION grimoire.intake_conversation_artifact_guard();
CREATE TRIGGER intake_conversation_report_guard BEFORE INSERT ON grimoire.intake_research_reports FOR EACH ROW EXECUTE FUNCTION grimoire.intake_conversation_artifact_guard();

CREATE FUNCTION grimoire.intake_conversation_sync_blocked(wanted_org uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE root uuid; task_ids uuid[];
BEGIN
 FOR root IN SELECT DISTINCT f.thread_task_id FROM grimoire.intake_task_followups f
  WHERE f.org_id=wanted_org AND EXISTS(SELECT 1 FROM grimoire.intake_watch_node_states s WHERE s.org_id=f.org_id AND s.node_kind='agent_task' AND s.blocked
   AND (s.node_id=f.thread_task_id OR s.node_id IN(SELECT agent_task_id FROM grimoire.intake_task_followups WHERE org_id=f.org_id AND thread_task_id=f.thread_task_id)))
 LOOP
  SELECT array_agg(id) INTO task_ids FROM (SELECT root AS id UNION SELECT agent_task_id FROM grimoire.intake_task_followups WHERE org_id=wanted_org AND thread_task_id=root) thread;
  -- States already exist for every native task/plan. Updating the established
  -- projection makes task lists, deliverables and review guards agree with chat.
  UPDATE grimoire.intake_watch_node_states s SET stale=true,blocked=true,reason='source_permission_revoked',updated_at=clock_timestamp()
  WHERE s.org_id=wanted_org AND NOT s.blocked AND (
   (s.node_kind='agent_task' AND s.node_id=ANY(task_ids)) OR
   (s.node_kind='capability_proposal' AND s.node_id IN(SELECT p.id FROM grimoire.intake_capability_plans p WHERE p.org_id=wanted_org AND p.agent_task_id=ANY(task_ids))) OR
   (s.node_kind='comparison' AND s.node_id IN(SELECT c.id FROM grimoire.intake_evidence_comparisons c JOIN grimoire.intake_capability_plans p ON (p.org_id,p.id)=(c.org_id,c.plan_id) WHERE p.org_id=wanted_org AND p.agent_task_id=ANY(task_ids)))
  );
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION grimoire.intake_conversation_sync_blocked(uuid) FROM PUBLIC;
CREATE FUNCTION grimoire.intake_conversation_revocation_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
BEGIN
 PERFORM grimoire.intake_conversation_sync_blocked(NEW.org_id);
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION grimoire.intake_conversation_revocation_event() FROM PUBLIC;
-- PostgreSQL runs same-event triggers by name: native source events establish
-- the original blocked state before these propagate the real thread dependency.
CREATE TRIGGER zz_intake_conversation_source_revoked AFTER INSERT ON grimoire.intake_source_revocations FOR EACH ROW EXECUTE FUNCTION grimoire.intake_conversation_revocation_event();
CREATE TRIGGER zz_intake_conversation_capture_revoked AFTER INSERT ON grimoire.intake_research_capture_revocations FOR EACH ROW EXECUTE FUNCTION grimoire.intake_conversation_revocation_event();
DO $$ DECLARE org uuid; BEGIN
 FOR org IN SELECT DISTINCT org_id FROM grimoire.intake_task_followups LOOP PERFORM grimoire.intake_conversation_sync_blocked(org); END LOOP;
END $$;
COMMIT;
