-- Additive correction after immutable 0031/0032: full legal identity and
-- preparation provenance across every immutable revision of a selected offer.
BEGIN;
SET search_path=pg_catalog,grimoire,pg_temp;
CREATE OR REPLACE FUNCTION app.intake_offer_assert_candidate(wanted_scion uuid,wanted_revision integer,candidate jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE row grimoire.intake_offer_submissions%ROWTYPE; seen integer:=0; offers uuid[]:='{}'; suppliers text[]:='{}';
BEGIN
 PERFORM app.intake_offer_assert_scope(wanted_scion,wanted_revision,(candidate->>'scope_proposal_id')::uuid);
 IF (candidate->'synthetic'='true'::jsonb) IS NOT TRUE OR jsonb_typeof(candidate->'offer_revision_ids') IS DISTINCT FROM 'array' OR jsonb_array_length(candidate->'offer_revision_ids')<>2 THEN RAISE EXCEPTION USING ERRCODE='G3201',MESSAGE='exactly two explicit synthetic offers required'; END IF;
 FOR row IN SELECT s.* FROM grimoire.intake_offer_submissions s WHERE s.org_id=app.current_org_id() AND s.scion_id=wanted_scion AND s.id IN(SELECT value::uuid FROM jsonb_array_elements_text(candidate->'offer_revision_ids')) ORDER BY s.offer_id LOOP
   seen:=seen+1;offers:=array_append(offers,row.offer_id);
   suppliers:=array_append(suppliers,jsonb_build_array(row.input#>>'{supplier,jurisdiction}',row.input#>>'{supplier,registration_ref}')::text);
   IF EXISTS(SELECT 1 FROM grimoire.intake_source_revocations WHERE (org_id,source_id)=(row.org_id,(row.input#>>'{source,source_id}')::uuid)) THEN RAISE EXCEPTION USING ERRCODE='G2601',MESSAGE='offer source revoked'; END IF;
   IF row.input->>'scope_proposal_id' IS DISTINCT FROM candidate->>'scope_proposal_id' THEN RAISE EXCEPTION USING ERRCODE='G3201',MESSAGE='offer binds another governed scope'; END IF;
 END LOOP;
 IF seen<>2 THEN RAISE EXCEPTION USING ERRCODE='G3204',MESSAGE='offer revision unavailable'; END IF;
 IF offers[1]=offers[2] OR suppliers[1]=suppliers[2] THEN RAISE EXCEPTION USING ERRCODE='G3201',MESSAGE='comparison requires two distinct offers and supplier legal identities'; END IF;
END $$;
CREATE OR REPLACE FUNCTION app.intake_offer_reviewer_conflict(wanted_proposal uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
 SELECT p.created_by=app.current_principal_id()
  OR EXISTS(SELECT 1 FROM grimoire.intake_offer_submissions selected
    JOIN grimoire.intake_offer_submissions history ON (history.org_id,history.offer_id)=(selected.org_id,selected.offer_id)
    WHERE selected.org_id=p.org_id AND selected.id IN(SELECT value::uuid FROM jsonb_array_elements_text(p.input->'offer_revision_ids')) AND history.created_by=app.current_principal_id())
  OR EXISTS(SELECT 1 FROM grimoire.intake_offer_series series JOIN grimoire.intake_offer_submissions selected ON (selected.org_id,selected.offer_id)=(series.org_id,series.id)
    WHERE selected.org_id=p.org_id AND selected.id IN(SELECT value::uuid FROM jsonb_array_elements_text(p.input->'offer_revision_ids')) AND series.created_by=app.current_principal_id())
  OR EXISTS(SELECT 1 FROM grimoire.intake_agent_tasks t WHERE (t.org_id,t.scion_id,t.created_by)=(p.org_id,p.scion_id,app.current_principal_id()))
 FROM grimoire.intake_comparison_proposals p WHERE p.id=wanted_proposal AND p.org_id=app.current_org_id() AND app.intake_can_access()
$$;
COMMIT;
