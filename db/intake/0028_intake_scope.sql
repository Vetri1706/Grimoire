-- Additive synthetic physical-scope review. Not part of verified GG-40.
-- All confirmed physical identities are written to the existing GG-40 tables.
BEGIN;
SET search_path=pg_catalog,grimoire,pg_temp;

CREATE TABLE grimoire.intake_scope_reviewers (
 org_id uuid NOT NULL, principal_id uuid NOT NULL,
 synthetic_only boolean NOT NULL DEFAULT true CHECK(synthetic_only),
 PRIMARY KEY(org_id,principal_id),
 FOREIGN KEY(org_id,principal_id) REFERENCES grimoire.principals(org_id,id)
);
CREATE TABLE grimoire.intake_scope_agents (
 org_id uuid NOT NULL, principal_id uuid NOT NULL,
 PRIMARY KEY(org_id,principal_id),
 FOREIGN KEY(org_id,principal_id) REFERENCES grimoire.principals(org_id,id)
);
REVOKE ALL ON grimoire.intake_scope_reviewers,grimoire.intake_scope_agents FROM PUBLIC;

CREATE FUNCTION app.intake_scope_is_agent() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
 SELECT EXISTS(SELECT 1 FROM grimoire.principal_roles r WHERE (r.org_id,r.principal_id)=(app.current_org_id(),app.current_principal_id()) AND r.role IN ('read_only_agent','system_worker'))
$$;
CREATE FUNCTION app.intake_scope_can_propose() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
 SELECT app.intake_can_access() AND (
   (app.intake_can_write() AND NOT app.intake_scope_is_agent()) OR
   (EXISTS(SELECT 1 FROM grimoire.intake_scope_agents e WHERE (e.org_id,e.principal_id)=(app.current_org_id(),app.current_principal_id()))
    AND EXISTS(SELECT 1 FROM grimoire.principal_roles r WHERE (r.org_id,r.principal_id)=(app.current_org_id(),app.current_principal_id()) AND r.role='read_only_agent')))
$$;
CREATE FUNCTION app.intake_scope_can_confirm() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
 SELECT app.intake_can_access() AND NOT app.intake_scope_is_agent()
   AND EXISTS(SELECT 1 FROM grimoire.intake_scope_reviewers e WHERE (e.org_id,e.principal_id)=(app.current_org_id(),app.current_principal_id()))
   AND EXISTS(SELECT 1 FROM grimoire.principal_roles r WHERE (r.org_id,r.principal_id)=(app.current_org_id(),app.current_principal_id()) AND r.role='engineering_reviewer')
$$;

CREATE TABLE grimoire.intake_scope_proposals (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, scion_id uuid NOT NULL, scion_revision integer NOT NULL,
 input jsonb NOT NULL CHECK(jsonb_typeof(input)='object' AND (input->'synthetic'='true'::jsonb) IS TRUE),
 created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,scion_id,scion_revision) REFERENCES grimoire.intake_revisions(org_id,scion_id,number),
 FOREIGN KEY(org_id,created_by) REFERENCES grimoire.principals(org_id,id)
);
CREATE TABLE grimoire.intake_scope_confirmations (
 proposal_id uuid PRIMARY KEY, org_id uuid NOT NULL, scion_id uuid NOT NULL, scion_revision integer NOT NULL,
 configuration_revision_id uuid NOT NULL, component_revision_id uuid NOT NULL,
 occurrence_revision_id uuid NOT NULL, requirement_revision_id uuid NOT NULL,
 sourcing_case_id uuid NOT NULL, sourcing_case_revision_id uuid NOT NULL,
 confirmed_by uuid NOT NULL, confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 review_note text NOT NULL CHECK(length(btrim(review_note)) BETWEEN 1 AND 2000),
 synthetic boolean NOT NULL DEFAULT true CHECK(synthetic),
 UNIQUE(org_id,scion_id),
 FOREIGN KEY(org_id,proposal_id) REFERENCES grimoire.intake_scope_proposals(org_id,id),
 FOREIGN KEY(org_id,scion_id,scion_revision) REFERENCES grimoire.intake_revisions(org_id,scion_id,number),
 FOREIGN KEY(org_id,confirmed_by) REFERENCES grimoire.principals(org_id,id),
 FOREIGN KEY(org_id,configuration_revision_id) REFERENCES grimoire.product_configuration_revisions(org_id,id),
 FOREIGN KEY(org_id,component_revision_id) REFERENCES grimoire.component_revisions(org_id,id),
 FOREIGN KEY(org_id,occurrence_revision_id) REFERENCES grimoire.bom_occurrence_revisions(org_id,id),
 FOREIGN KEY(org_id,requirement_revision_id) REFERENCES grimoire.requirement_revisions(org_id,id),
 FOREIGN KEY(org_id,sourcing_case_id) REFERENCES grimoire.sourcing_cases(org_id,id),
 FOREIGN KEY(org_id,sourcing_case_revision_id) REFERENCES grimoire.sourcing_case_revisions(org_id,id)
);
CREATE TABLE grimoire.intake_scope_receipts (
 org_id uuid NOT NULL,principal_id uuid NOT NULL,key text NOT NULL CHECK(length(key) BETWEEN 1 AND 128),
 request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
 response_body text NOT NULL,response_etag text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(org_id,principal_id,key),
 FOREIGN KEY(org_id,principal_id) REFERENCES grimoire.principals(org_id,id)
);
COMMENT ON TABLE grimoire.intake_scope_confirmations IS 'Synthetic engineering scope confirmation only; no sourcing decision or approval. Governed identity rows live in GG-40 tables.';

CREATE FUNCTION app.intake_scope_lock_scion(wanted_scion uuid) RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
 SELECT current_revision FROM grimoire.intake_scions
 WHERE id=wanted_scion AND org_id=app.current_org_id() AND app.intake_can_access() FOR UPDATE
$$;

-- Caller takes the Scion lock first. Each source is then locked in UUID order.
-- Matching provenance is independently checked here even for a direct SQL caller.
CREATE FUNCTION app.intake_scope_assert_sources(wanted_scion uuid,wanted_revision integer,payload jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE ref jsonb; source_uuid uuid; source_row grimoire.intake_sources%ROWTYPE;
BEGIN
 IF NOT app.intake_can_access() OR jsonb_typeof(payload->'source_claims') IS DISTINCT FROM 'array'
    OR jsonb_array_length(payload->'source_claims')<>4 THEN
   RAISE EXCEPTION USING ERRCODE='G2801',MESSAGE='four explicit source claim links are required';
 END IF;
 IF (SELECT count(DISTINCT x->>'kind') FROM jsonb_array_elements(payload->'source_claims') x
     WHERE x->>'kind' IN ('configuration','component','occurrence','requirement'))<>4 THEN
   RAISE EXCEPTION USING ERRCODE='G2801',MESSAGE='scope link kinds must be unique and complete';
 END IF;
 FOR source_uuid IN SELECT DISTINCT (x->>'source_id')::uuid FROM jsonb_array_elements(payload->'source_claims') x ORDER BY 1 LOOP
   SELECT * INTO source_row FROM grimoire.intake_sources
   WHERE (org_id,id,scion_id)=(app.current_org_id(),source_uuid,wanted_scion) FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='G2801',MESSAGE='source is unavailable for this Scion'; END IF;
   IF source_row.scion_revision<>wanted_revision THEN RAISE EXCEPTION USING ERRCODE='G2802',MESSAGE='source pins another Scion revision'; END IF;
 END LOOP;
 FOR ref IN SELECT value FROM jsonb_array_elements(payload->'source_claims') LOOP
   IF EXISTS(SELECT 1 FROM grimoire.intake_source_revocations WHERE (org_id,source_id)=(app.current_org_id(),(ref->>'source_id')::uuid)) THEN
     RAISE EXCEPTION USING ERRCODE='G2601',MESSAGE='source permission revoked';
   END IF;
   IF NOT EXISTS(
     SELECT 1 FROM grimoire.intake_sources s JOIN grimoire.intake_source_revisions r ON (r.org_id,r.source_id,r.number)=(s.org_id,s.id,s.current_revision)
     JOIN grimoire.intake_source_claims c ON (c.org_id,c.source_id,c.source_revision)=(r.org_id,r.source_id,r.number)
     JOIN grimoire.intake_source_objects o ON (o.org_id,o.source_id,o.source_revision,o.content_sha256,o.byte_length)=(r.org_id,r.source_id,r.number,r.content_sha256,r.byte_length)
     WHERE (s.org_id,s.id,s.scion_id,s.scion_revision)=(app.current_org_id(),(ref->>'source_id')::uuid,wanted_scion,wanted_revision)
       AND r.number=(ref->>'source_revision')::integer AND r.synthetic AND r.rights_status='granted' AND r.permitted_use='scion_review'
       AND c.id=(ref->>'claim_id')::uuid AND r.content_sha256=ref->>'content_sha256'
       AND (c.start_byte,c.end_byte)=((ref->>'start_byte')::integer,(ref->>'end_byte')::integer)) THEN
     RAISE EXCEPTION USING ERRCODE='G2802',MESSAGE='source revision or exact claim binding is stale or mismatched';
   END IF;
 END LOOP;
END $$;

CREATE FUNCTION grimoire.intake_scope_proposal_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE current_number integer;
BEGIN
 IF NEW.org_id IS DISTINCT FROM app.current_org_id() OR NEW.created_by IS DISTINCT FROM app.current_principal_id() OR NOT app.intake_scope_can_propose() THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='scope proposal denied';
 END IF;
 current_number:=app.intake_scope_lock_scion(NEW.scion_id);
 IF current_number IS NULL OR NEW.scion_revision<>current_number THEN RAISE EXCEPTION USING ERRCODE='G2402',MESSAGE='Scion revision changed'; END IF;
 IF NOT EXISTS(SELECT 1 FROM grimoire.intake_revisions WHERE (org_id,scion_id,number,product_category)=(NEW.org_id,NEW.scion_id,NEW.scion_revision,'physical')) THEN
   RAISE EXCEPTION USING ERRCODE='G2801',MESSAGE='physical product intake required';
 END IF;
 PERFORM app.intake_scope_assert_sources(NEW.scion_id,NEW.scion_revision,NEW.input);
 RETURN NEW;
END $$;
CREATE TRIGGER intake_scope_proposal_guard BEFORE INSERT ON grimoire.intake_scope_proposals
FOR EACH ROW EXECUTE FUNCTION grimoire.intake_scope_proposal_guard();

CREATE FUNCTION app.intake_scope_confirm(wanted_scion uuid,wanted_proposal uuid,wanted_revision integer,note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE p grimoire.intake_scope_proposals%ROWTYPE; d jsonb; current_number integer;
 product_id uuid:=gen_random_uuid(); configuration_id uuid:=gen_random_uuid(); configuration_rev uuid:=gen_random_uuid();
 component_id uuid:=gen_random_uuid(); component_rev uuid:=gen_random_uuid(); occurrence_id uuid:=gen_random_uuid(); occurrence_rev uuid:=gen_random_uuid();
 requirement_id uuid:=gen_random_uuid(); requirement_rev uuid:=gen_random_uuid(); case_id uuid:=gen_random_uuid(); case_rev uuid:=gen_random_uuid();
 actor uuid:=app.current_principal_id(); org uuid:=app.current_org_id(); effective_time timestamptz:=clock_timestamp(); result jsonb; stored_criteria jsonb;
BEGIN
 IF NOT app.intake_scope_can_confirm() THEN RAISE EXCEPTION USING ERRCODE='G2804',MESSAGE='separate enrolled synthetic engineering reviewer required'; END IF;
 current_number:=app.intake_scope_lock_scion(wanted_scion);
 SELECT * INTO p FROM grimoire.intake_scope_proposals WHERE (org_id,id,scion_id)=(org,wanted_proposal,wanted_scion);
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='G2801',MESSAGE='proposal unavailable'; END IF;
 IF p.created_by=actor THEN RAISE EXCEPTION USING ERRCODE='G2804',MESSAGE='proposer cannot confirm own scope'; END IF;
 IF current_number IS NULL OR current_number<>wanted_revision OR current_number<>p.scion_revision THEN RAISE EXCEPTION USING ERRCODE='G2402',MESSAGE='Scion revision changed'; END IF;
 IF EXISTS(SELECT 1 FROM grimoire.intake_scope_confirmations WHERE (org_id,scion_id)=(org,wanted_scion)) THEN
   RAISE EXCEPTION USING ERRCODE='G2803',MESSAGE='Scion scope already confirmed';
 END IF;
 d:=p.input;
 IF (d->'synthetic'='true'::jsonb) IS NOT TRUE OR d->>'identity_match' IS DISTINCT FROM 'exact'
    OR jsonb_typeof(d->'unresolved_gaps') IS DISTINCT FROM 'array' OR jsonb_array_length(d->'unresolved_gaps')<>0 THEN
   RAISE EXCEPTION USING ERRCODE='G2802',MESSAGE='synthetic exact scope with no unresolved gaps required';
 END IF;
 PERFORM app.intake_scope_assert_sources(wanted_scion,p.scion_revision,d);
 PERFORM set_config('app.effective_role','synthetic_engineering_reviewer',true),set_config('app.endpoint_scope','intake:synthetic-scope-confirm',true),
   set_config('app.input_hash',encode(public.digest(d::text,'sha256'),'hex'),true),set_config('app.action_reason',note,true),set_config('app.action_outcome','committed',true);
 INSERT INTO grimoire.products(id,org_id,product_code,name) VALUES(product_id,org,d#>>'{configuration,product_code}',d#>>'{configuration,product_name}');
 INSERT INTO grimoire.product_configurations(id,org_id,product_id,configuration_code) VALUES(configuration_id,org,product_id,d#>>'{configuration,configuration_code}');
 INSERT INTO grimoire.product_configuration_revisions(id,org_id,configuration_id,revision_no,effective_during,specification,created_by)
 VALUES(configuration_rev,org,configuration_id,1,tstzrange(effective_time,NULL,'[)'),(d#>'{configuration,specification}')||jsonb_build_object('synthetic',true,'scope_proposal_id',p.id),actor);
 INSERT INTO grimoire.components(id,org_id,internal_part_code) VALUES(component_id,org,d#>>'{component,internal_part_code}');
 INSERT INTO grimoire.component_revisions(id,org_id,component_id,revision_no,approved_manufacturer,approved_part_number,attributes,created_by)
 VALUES(component_rev,org,component_id,1,d#>>'{component,manufacturer}',d#>>'{component,part_number}',(d#>'{component,attributes}')||jsonb_build_object('synthetic',true,'scope_proposal_id',p.id),actor);
 INSERT INTO grimoire.bom_occurrences(id,org_id,configuration_id,occurrence_path) VALUES(occurrence_id,org,configuration_id,d#>>'{occurrence,path}');
 INSERT INTO grimoire.bom_occurrence_revisions(id,org_id,occurrence_id,configuration_revision_id,component_revision_id,revision_no,quantity,uom,effective_during,created_by)
 VALUES(occurrence_rev,org,occurrence_id,configuration_rev,component_rev,1,(d#>>'{occurrence,quantity}')::numeric,d#>>'{occurrence,uom}',tstzrange(effective_time,NULL,'[)'),actor);
 INSERT INTO grimoire.requirements(id,org_id,occurrence_id,requirement_code) VALUES(requirement_id,org,occurrence_id,d#>>'{requirement,code}');
 stored_criteria:=(d#>'{requirement,criteria}')||jsonb_build_object('synthetic',true,'scope_proposal_id',p.id);
 INSERT INTO grimoire.requirement_revisions(id,org_id,requirement_id,occurrence_revision_id,component_revision_id,revision_no,effective_at,criteria,content_hash,created_by)
 VALUES(requirement_rev,org,requirement_id,occurrence_rev,component_rev,1,effective_time,stored_criteria,encode(public.digest(stored_criteria::text,'sha256'),'hex'),actor);
 INSERT INTO grimoire.sourcing_cases(id,org_id,case_code,title,prepared_by) VALUES(case_id,org,d->>'case_code',d->>'case_title',p.created_by);
 INSERT INTO grimoire.sourcing_case_revisions(id,org_id,sourcing_case_id,revision_no,configuration_revision_id,occurrence_revision_id,component_revision_id,requirement_revision_id,created_by)
 VALUES(case_rev,org,case_id,1,configuration_rev,occurrence_rev,component_rev,requirement_rev,actor);
 INSERT INTO grimoire.intake_scope_confirmations(proposal_id,org_id,scion_id,scion_revision,configuration_revision_id,component_revision_id,occurrence_revision_id,requirement_revision_id,sourcing_case_id,sourcing_case_revision_id,confirmed_by,review_note)
 VALUES(p.id,org,wanted_scion,p.scion_revision,configuration_rev,component_rev,occurrence_rev,requirement_rev,case_id,case_rev,actor,note);
 SELECT to_jsonb(c)-'org_id' INTO result FROM grimoire.intake_scope_confirmations c WHERE c.proposal_id=p.id;
 RETURN result;
END $$;

-- Read exact governed identities through the confirmed binding without granting
-- the runtime broad governed-table access or source-derived descriptive text.
CREATE FUNCTION app.intake_scope_chain(wanted_proposal uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
 SELECT jsonb_build_object('table','sourcing_case_revisions','revision_no',cr.revision_no,
   'configuration_revision_id',cr.configuration_revision_id,'component_revision_id',cr.component_revision_id,
   'occurrence_revision_id',cr.occurrence_revision_id,'requirement_revision_id',cr.requirement_revision_id,
   'configuration_revision_no',cfg.revision_no,'component_revision_no',comp.revision_no,
   'occurrence_revision_no',occ.revision_no,'requirement_revision_no',req.revision_no,
   'criteria_hash_matches',req.content_hash=encode(public.digest(req.criteria::text,'sha256'),'hex'),
   'consistent',occ.configuration_revision_id=cfg.id AND occ.component_revision_id=comp.id
     AND req.occurrence_revision_id=occ.id AND req.component_revision_id=comp.id)
 FROM grimoire.intake_scope_confirmations c
 JOIN grimoire.sourcing_case_revisions cr ON (cr.org_id,cr.id,cr.sourcing_case_id)=(c.org_id,c.sourcing_case_revision_id,c.sourcing_case_id)
 JOIN grimoire.product_configuration_revisions cfg ON (cfg.org_id,cfg.id)=(c.org_id,c.configuration_revision_id)
 JOIN grimoire.component_revisions comp ON (comp.org_id,comp.id)=(c.org_id,c.component_revision_id)
 JOIN grimoire.bom_occurrence_revisions occ ON (occ.org_id,occ.id)=(c.org_id,c.occurrence_revision_id)
 JOIN grimoire.requirement_revisions req ON (req.org_id,req.id)=(c.org_id,c.requirement_revision_id)
 WHERE c.proposal_id=wanted_proposal AND c.org_id=app.current_org_id() AND app.intake_can_access()
$$;

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['intake_scope_proposals','intake_scope_confirmations','intake_scope_receipts'] LOOP
   EXECUTE format('CREATE TRIGGER %I_immutable BEFORE UPDATE OR DELETE ON grimoire.%I FOR EACH ROW EXECUTE FUNCTION grimoire.intake_deny_mutation()',t,t);
   EXECUTE format('ALTER TABLE grimoire.%I ENABLE ROW LEVEL SECURITY',t);
 END LOOP;
END $$;
CREATE POLICY intake_scope_proposal_read ON grimoire.intake_scope_proposals FOR SELECT TO grimoire_intake_app USING(org_id=app.current_org_id() AND app.intake_can_access());
CREATE POLICY intake_scope_proposal_create ON grimoire.intake_scope_proposals FOR INSERT TO grimoire_intake_app WITH CHECK(org_id=app.current_org_id() AND created_by=app.current_principal_id() AND app.intake_scope_can_propose());
CREATE POLICY intake_scope_confirmation_read ON grimoire.intake_scope_confirmations FOR SELECT TO grimoire_intake_app USING(org_id=app.current_org_id() AND app.intake_can_access());
CREATE POLICY intake_scope_receipt_read ON grimoire.intake_scope_receipts FOR SELECT TO grimoire_intake_app USING(org_id=app.current_org_id() AND principal_id=app.current_principal_id() AND app.intake_can_access());
CREATE POLICY intake_scope_receipt_create ON grimoire.intake_scope_receipts FOR INSERT TO grimoire_intake_app WITH CHECK(org_id=app.current_org_id() AND principal_id=app.current_principal_id() AND (app.intake_scope_can_propose() OR app.intake_scope_can_confirm()));
REVOKE ALL ON grimoire.intake_scope_proposals,grimoire.intake_scope_confirmations,grimoire.intake_scope_receipts FROM PUBLIC;
GRANT SELECT,INSERT ON grimoire.intake_scope_proposals,grimoire.intake_scope_receipts TO grimoire_intake_app;
GRANT SELECT ON grimoire.intake_scope_confirmations TO grimoire_intake_app;
REVOKE ALL ON FUNCTION app.intake_scope_is_agent(),app.intake_scope_can_propose(),app.intake_scope_can_confirm(),app.intake_scope_lock_scion(uuid),
 app.intake_scope_assert_sources(uuid,integer,jsonb),app.intake_scope_confirm(uuid,uuid,integer,text),app.intake_scope_chain(uuid),grimoire.intake_scope_proposal_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.intake_scope_is_agent(),app.intake_scope_can_propose(),app.intake_scope_can_confirm(),app.intake_scope_lock_scion(uuid),
 app.intake_scope_assert_sources(uuid,integer,jsonb),app.intake_scope_confirm(uuid,uuid,integer,text),app.intake_scope_chain(uuid) TO grimoire_intake_app;
COMMIT;
