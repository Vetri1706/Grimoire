-- Row-lock receipts without granting the runtime UPDATE on immutable artifacts.
BEGIN;
CREATE FUNCTION app.intake_research_lock_captures(wanted_task uuid,wanted_capture uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
BEGIN
 IF NOT app.intake_can_access() THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='research access required'; END IF;
 IF wanted_capture IS NULL THEN
  PERFORM id FROM grimoire.intake_research_captures WHERE org_id=app.current_org_id() AND agent_task_id=wanted_task ORDER BY id FOR SHARE;
  RETURN true;
 END IF;
 IF NOT app.intake_can_prepare_workspace() THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='human research withdrawal required'; END IF;
 PERFORM id FROM grimoire.intake_research_captures WHERE org_id=app.current_org_id() AND agent_task_id=wanted_task AND id=wanted_capture FOR UPDATE;
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION app.intake_research_lock_captures(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.intake_research_lock_captures(uuid,uuid) TO grimoire_intake_app;

CREATE FUNCTION grimoire.intake_research_revocation_lock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE task uuid;
BEGIN
 SELECT agent_task_id INTO task FROM grimoire.intake_research_captures WHERE (org_id,id)=(app.current_org_id(),NEW.capture_id);
 IF NEW.org_id IS DISTINCT FROM app.current_org_id() OR NOT app.intake_research_lock_captures(task,NEW.capture_id)
 THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='research capture unavailable'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION grimoire.intake_research_revocation_lock() FROM PUBLIC;
CREATE TRIGGER intake_research_revocation_lock BEFORE INSERT ON grimoire.intake_research_capture_revocations FOR EACH ROW EXECUTE FUNCTION grimoire.intake_research_revocation_lock();
COMMIT;
