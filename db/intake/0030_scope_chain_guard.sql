-- Additive corrections after 0028/0029; earlier applied bytes remain unchanged.
BEGIN;
SET search_path=pg_catalog,grimoire,pg_temp;

CREATE OR REPLACE FUNCTION app.intake_scope_chain(wanted_proposal uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
 SELECT jsonb_build_object('table','sourcing_case_revisions','revision_no',cr.revision_no,
   'configuration_revision_id',cr.configuration_revision_id,'component_revision_id',cr.component_revision_id,
   'occurrence_revision_id',cr.occurrence_revision_id,'requirement_revision_id',cr.requirement_revision_id,
   'configuration_revision_no',cfg.revision_no,'component_revision_no',comp.revision_no,
   'occurrence_revision_no',occ.revision_no,'requirement_revision_no',req.revision_no,
   'criteria_hash_matches',req.content_hash=encode(public.digest(req.criteria::text,'sha256'),'hex'),
   'consistent',cr.configuration_revision_id=c.configuration_revision_id
     AND cr.component_revision_id=c.component_revision_id AND cr.occurrence_revision_id=c.occurrence_revision_id
     AND cr.requirement_revision_id=c.requirement_revision_id
     AND occ.configuration_revision_id=cfg.id AND occ.component_revision_id=comp.id
     AND req.occurrence_revision_id=occ.id AND req.component_revision_id=comp.id)
 FROM grimoire.intake_scope_confirmations c
 JOIN grimoire.sourcing_case_revisions cr ON (cr.org_id,cr.id,cr.sourcing_case_id)=(c.org_id,c.sourcing_case_revision_id,c.sourcing_case_id)
 JOIN grimoire.product_configuration_revisions cfg ON (cfg.org_id,cfg.id)=(c.org_id,c.configuration_revision_id)
 JOIN grimoire.component_revisions comp ON (comp.org_id,comp.id)=(c.org_id,c.component_revision_id)
 JOIN grimoire.bom_occurrence_revisions occ ON (occ.org_id,occ.id)=(c.org_id,c.occurrence_revision_id)
 JOIN grimoire.requirement_revisions req ON (req.org_id,req.id)=(c.org_id,c.requirement_revision_id)
 WHERE c.proposal_id=wanted_proposal AND c.org_id=app.current_org_id() AND app.intake_can_access()
$$;

-- Queueing a candidate remains preparation even when an agent creates the
-- resulting proposal. Conservatively exclude that Scion's task requester from
-- confirmation, including the interval before the agent reports task completion.
CREATE FUNCTION app.intake_scope_has_preparer_conflict(wanted_scion uuid,wanted_proposal uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
 SELECT NOT app.intake_can_access()
   OR EXISTS(SELECT 1 FROM grimoire.intake_scope_proposals p
      WHERE (p.org_id,p.scion_id,p.id,p.created_by)=(app.current_org_id(),wanted_scion,wanted_proposal,app.current_principal_id()))
   OR EXISTS(SELECT 1 FROM grimoire.intake_agent_tasks t
      WHERE (t.org_id,t.scion_id,t.created_by)=(app.current_org_id(),wanted_scion,app.current_principal_id()))
$$;
CREATE FUNCTION grimoire.intake_scope_confirmation_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
BEGIN
 IF NEW.org_id IS DISTINCT FROM app.current_org_id() OR NEW.confirmed_by IS DISTINCT FROM app.current_principal_id()
    OR NOT app.intake_scope_can_confirm() OR app.intake_scope_has_preparer_conflict(NEW.scion_id,NEW.proposal_id) THEN
   RAISE EXCEPTION USING ERRCODE='G2804',MESSAGE='scope preparer or task requester cannot confirm through agent indirection';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER intake_scope_confirmation_guard BEFORE INSERT ON grimoire.intake_scope_confirmations
FOR EACH ROW EXECUTE FUNCTION grimoire.intake_scope_confirmation_guard();
REVOKE ALL ON FUNCTION app.intake_scope_has_preparer_conflict(uuid,uuid),grimoire.intake_scope_confirmation_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.intake_scope_has_preparer_conflict(uuid,uuid) TO grimoire_intake_app;
COMMIT;
