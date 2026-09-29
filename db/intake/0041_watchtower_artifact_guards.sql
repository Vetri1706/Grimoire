BEGIN;
SET search_path=pg_catalog,grimoire,pg_temp;

CREATE OR REPLACE FUNCTION grimoire.intake_watch_artifact_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE kind text; src record;
BEGIN
 kind:=CASE TG_TABLE_NAME WHEN 'intake_capability_plans' THEN 'capability_proposal' WHEN 'intake_evidence_comparisons' THEN 'comparison' ELSE 'agent_task' END;
 IF TG_OP='INSERT' THEN
  PERFORM grimoire.intake_watch_register_dependency(NEW.org_id,NEW.scion_id,kind,NEW.id,NEW.scion_revision);
  IF kind='comparison' THEN
   FOR src IN SELECT DISTINCT c.source_id,c.source_revision FROM grimoire.intake_source_claims c
    WHERE c.org_id=NEW.org_id AND c.id IN
     (SELECT claim.value::uuid FROM jsonb_array_elements(NEW.input->'alternatives') alternative
      CROSS JOIN LATERAL jsonb_array_elements(alternative->'criteria') criterion CROSS JOIN LATERAL jsonb_array_elements_text(criterion->'claim_ids') claim)
   LOOP PERFORM grimoire.intake_watch_register_dependency(NEW.org_id,NEW.scion_id,kind,NEW.id,NEW.scion_revision,src.source_id,src.source_revision); END LOOP;
   FOR src IN SELECT source_id,source_revision FROM grimoire.intake_watch_dependencies
    WHERE org_id=NEW.org_id AND node_kind='capability_proposal' AND node_id=NEW.plan_id AND source_id IS NOT NULL
   LOOP PERFORM grimoire.intake_watch_register_dependency(NEW.org_id,NEW.scion_id,kind,NEW.id,NEW.scion_revision,src.source_id,src.source_revision); END LOOP;
  ELSIF (kind='agent_task' AND NEW.input->>'task_kind'='prepare_capability_plan') OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.input->'capabilities') capability WHERE capability->'connector_ids' ? 'scion_sources') THEN
   FOR src IN SELECT id,current_revision FROM grimoire.intake_sources source
    WHERE source.org_id=NEW.org_id AND source.scion_id=NEW.scion_id AND source.current_revision>0
     AND NOT EXISTS(SELECT 1 FROM grimoire.intake_source_revocations revocation WHERE revocation.org_id=source.org_id AND revocation.source_id=source.id)
   LOOP PERFORM grimoire.intake_watch_register_dependency(NEW.org_id,NEW.scion_id,kind,NEW.id,NEW.scion_revision,src.id,src.current_revision); END LOOP;
  END IF;
 END IF;
 IF kind='agent_task' AND TG_OP='UPDATE' THEN
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('completed','failed','cancelled') THEN
   PERFORM grimoire.intake_watch_emit(NEW.org_id,NEW.scion_id,'agent_outcomes','agent_task_'||NEW.status,NEW.id,NEW.scion_revision,
    'task:'||NEW.id||':attempt:'||NEW.attempt||':'||NEW.status,'Agent task '||NEW.status||'; inspect the recorded outcome.');
   IF NEW.status IN ('failed','cancelled') THEN
    UPDATE grimoire.intake_watch_node_states SET stale=true,reason=CASE WHEN blocked THEN reason ELSE 'agent_task_'||NEW.status END,updated_at=clock_timestamp()
    WHERE org_id=NEW.org_id AND scion_id=NEW.scion_id AND
     ((node_kind='capability_proposal' AND node_id IN (SELECT id FROM grimoire.intake_capability_plans WHERE org_id=NEW.org_id AND agent_task_id=NEW.id)) OR
      (node_kind='comparison' AND node_id IN (SELECT comparison.id FROM grimoire.intake_evidence_comparisons comparison JOIN grimoire.intake_capability_plans plan ON (plan.org_id,plan.id)=(comparison.org_id,comparison.plan_id) WHERE plan.org_id=NEW.org_id AND plan.agent_task_id=NEW.id)));
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;

DO $$ DECLARE dependency record; BEGIN
 FOR dependency IN SELECT comparison.org_id,comparison.scion_id,comparison.id,comparison.scion_revision,parent.source_id,parent.source_revision
  FROM grimoire.intake_evidence_comparisons comparison JOIN grimoire.intake_watch_dependencies parent
   ON parent.org_id=comparison.org_id AND parent.node_kind='capability_proposal' AND parent.node_id=comparison.plan_id AND parent.source_id IS NOT NULL
 LOOP PERFORM grimoire.intake_watch_register_dependency(dependency.org_id,dependency.scion_id,'comparison',dependency.id,dependency.scion_revision,dependency.source_id,dependency.source_revision); END LOOP;
END $$;
COMMIT;
