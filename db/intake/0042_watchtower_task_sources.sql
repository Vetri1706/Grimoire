BEGIN;
SET search_path=pg_catalog,grimoire,pg_temp;

CREATE FUNCTION grimoire.intake_watch_task_sources() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE dependency record;
BEGIN
 IF NEW.task_kind='prepare_capability_plan' THEN
  FOR dependency IN SELECT id,current_revision FROM grimoire.intake_sources source
   WHERE source.org_id=NEW.org_id AND source.scion_id=NEW.scion_id AND source.current_revision>0
    AND NOT EXISTS(SELECT 1 FROM grimoire.intake_source_revocations revocation WHERE revocation.org_id=source.org_id AND revocation.source_id=source.id)
  LOOP PERFORM grimoire.intake_watch_register_dependency(NEW.org_id,NEW.scion_id,'agent_task',NEW.id,NEW.scion_revision,dependency.id,dependency.current_revision); END LOOP;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER intake_watch_task_sources AFTER INSERT ON grimoire.intake_agent_tasks FOR EACH ROW EXECUTE FUNCTION grimoire.intake_watch_task_sources();
REVOKE ALL ON FUNCTION grimoire.intake_watch_task_sources() FROM PUBLIC;

DO $$ DECLARE task record; dependency record; BEGIN
 FOR task IN SELECT * FROM grimoire.intake_agent_tasks WHERE task_kind='prepare_capability_plan' LOOP
  FOR dependency IN SELECT DISTINCT ON (revision.source_id) revision.source_id,revision.number FROM grimoire.intake_source_revisions revision
   JOIN grimoire.intake_sources source ON (source.org_id,source.id)=(revision.org_id,revision.source_id)
   WHERE source.org_id=task.org_id AND source.scion_id=task.scion_id AND revision.created_at<=task.created_at
    AND NOT EXISTS(SELECT 1 FROM grimoire.intake_source_revocations revocation WHERE revocation.org_id=source.org_id AND revocation.source_id=source.id AND revocation.created_at<=task.created_at)
   ORDER BY revision.source_id,revision.number DESC
  LOOP PERFORM grimoire.intake_watch_register_dependency(task.org_id,task.scion_id,'agent_task',task.id,task.scion_revision,dependency.source_id,dependency.number); END LOOP;
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION app.intake_watchtower_check() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
BEGIN
 IF (SELECT count(*) FROM pg_trigger trigger JOIN pg_class relation ON relation.oid=trigger.tgrelid JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
     WHERE namespace.nspname='grimoire' AND trigger.tgname IN ('intake_watch_scion_event','intake_watch_source_event','intake_watch_revocation_event','intake_watch_task_event','intake_watch_plan_event','intake_watch_comparison_event','intake_watch_task_sources') AND trigger.tgenabled='O')<>7
 THEN RAISE EXCEPTION 'Watchtower event capture is unavailable'; END IF;
 UPDATE grimoire.intake_watches SET last_successful_check=clock_timestamp() WHERE id IN
 (SELECT id FROM grimoire.intake_watches ORDER BY last_successful_check NULLS FIRST,id LIMIT 500 FOR UPDATE SKIP LOCKED);
END $$;
COMMIT;
