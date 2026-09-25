-- Additive synthetic offer staging and exact same-basis normalization.
-- Complete offers and confirmed comparisons use the existing GG-40 tables.
BEGIN;
SET search_path=pg_catalog,grimoire,pg_temp;
CREATE TABLE grimoire.intake_offer_series (
 id uuid PRIMARY KEY,org_id uuid NOT NULL,scion_id uuid NOT NULL,current_revision integer NOT NULL DEFAULT 0,
 governed_offer_id uuid,created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(org_id,id),FOREIGN KEY(org_id,scion_id) REFERENCES grimoire.intake_scions(org_id,id),
 FOREIGN KEY(org_id,governed_offer_id) REFERENCES grimoire.supplier_offers(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES grimoire.principals(org_id,id)
);
CREATE TABLE grimoire.intake_offer_submissions (
 id uuid PRIMARY KEY,org_id uuid NOT NULL,scion_id uuid NOT NULL,offer_id uuid NOT NULL,number integer NOT NULL CHECK(number>0),
 input jsonb NOT NULL CHECK((input->'synthetic'='true'::jsonb) IS TRUE),input_hash text NOT NULL,
 missing_fields jsonb NOT NULL CHECK(jsonb_typeof(missing_fields)='array'),
 governed_offer_revision_id uuid,governed_offer_line_id uuid,created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(org_id,id),UNIQUE(org_id,offer_id,number),UNIQUE(org_id,scion_id,input_hash),
 FOREIGN KEY(org_id,offer_id) REFERENCES grimoire.intake_offer_series(org_id,id),
 FOREIGN KEY(org_id,governed_offer_revision_id) REFERENCES grimoire.offer_revisions(org_id,id),
 FOREIGN KEY(org_id,governed_offer_line_id) REFERENCES grimoire.offer_lines(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES grimoire.principals(org_id,id)
);
CREATE TABLE grimoire.intake_offer_source_links (
 org_id uuid NOT NULL,intake_source_id uuid NOT NULL,intake_source_revision integer NOT NULL,
 source_document_id uuid NOT NULL,source_revision_id uuid NOT NULL,
 PRIMARY KEY(org_id,intake_source_id,intake_source_revision),
 FOREIGN KEY(org_id,intake_source_id,intake_source_revision) REFERENCES grimoire.intake_source_revisions(org_id,source_id,number),
 FOREIGN KEY(org_id,source_document_id) REFERENCES grimoire.source_documents(org_id,id),
 FOREIGN KEY(org_id,source_revision_id) REFERENCES grimoire.source_document_revisions(org_id,id)
);
CREATE TABLE grimoire.intake_comparison_proposals (
 id uuid PRIMARY KEY,org_id uuid NOT NULL,scion_id uuid NOT NULL,scion_revision integer NOT NULL,
 input jsonb NOT NULL,snapshot jsonb NOT NULL,agent_task_id uuid,
 created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(org_id,id),FOREIGN KEY(org_id,scion_id,scion_revision) REFERENCES grimoire.intake_revisions(org_id,scion_id,number),
 FOREIGN KEY(org_id,agent_task_id) REFERENCES grimoire.intake_agent_tasks(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES grimoire.principals(org_id,id)
);
CREATE TABLE grimoire.intake_comparison_confirmations (
 proposal_id uuid PRIMARY KEY,org_id uuid NOT NULL,comparison_revision_id uuid NOT NULL,artifact_id uuid NOT NULL,
 sourcing_case_revision_id uuid NOT NULL,requirement_revision_id uuid NOT NULL,
 confirmed_by uuid NOT NULL,confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp(),review_note text NOT NULL CHECK(length(btrim(review_note)) BETWEEN 1 AND 2000),
 synthetic boolean NOT NULL DEFAULT true CHECK(synthetic),
 FOREIGN KEY(org_id,proposal_id) REFERENCES grimoire.intake_comparison_proposals(org_id,id),
 FOREIGN KEY(org_id,comparison_revision_id) REFERENCES grimoire.comparison_revisions(org_id,id),
 FOREIGN KEY(org_id,artifact_id) REFERENCES grimoire.derived_artifacts(org_id,id),
 FOREIGN KEY(org_id,confirmed_by) REFERENCES grimoire.principals(org_id,id)
);

CREATE FUNCTION app.intake_offer_assert_scope(wanted_scion uuid,wanted_revision integer,wanted_scope uuid) RETURNS grimoire.intake_scope_confirmations
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE c grimoire.intake_scope_confirmations%ROWTYPE; p jsonb;
BEGIN
 IF app.intake_scope_lock_scion(wanted_scion) IS DISTINCT FROM wanted_revision THEN RAISE EXCEPTION USING ERRCODE='G2402',MESSAGE='stale Scion'; END IF;
 SELECT * INTO c FROM grimoire.intake_scope_confirmations WHERE (org_id,scion_id,scion_revision,proposal_id)=(app.current_org_id(),wanted_scion,wanted_revision,wanted_scope);
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='G3201',MESSAGE='current confirmed scope required'; END IF;
 SELECT input INTO STRICT p FROM grimoire.intake_scope_proposals WHERE id=c.proposal_id;
 PERFORM app.intake_scope_assert_sources(wanted_scion,wanted_revision,p);
 RETURN c;
END $$;
CREATE FUNCTION app.intake_offer_assert_source(wanted_scion uuid,wanted_revision integer,reference jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE links jsonb;
BEGIN
 SELECT jsonb_agg(reference||jsonb_build_object('kind',k)) INTO links FROM unnest(ARRAY['configuration','component','occurrence','requirement']) k;
 PERFORM app.intake_scope_assert_sources(wanted_scion,wanted_revision,jsonb_build_object('source_claims',links));
END $$;

CREATE FUNCTION app.intake_offer_submit(wanted_scion uuid,wanted_offer uuid,wanted_number integer,payload jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE org uuid:=app.current_org_id(); actor uuid:=app.current_principal_id(); c grimoire.intake_scope_confirmations%ROWTYPE;
 series grimoire.intake_offer_series%ROWTYPE; first_input jsonb; missing jsonb; submission uuid:=gen_random_uuid();
 supplier uuid; site uuid; account uuid; governed_offer uuid; offer_rev uuid; line uuid; src_doc uuid; src_rev uuid;
 src grimoire.intake_source_revisions%ROWTYPE; obj grimoire.intake_source_objects%ROWTYPE; ref jsonb:=payload->'source';
 governed_number integer; source_owner uuid;
BEGIN
 IF NOT app.intake_can_write() OR app.intake_scope_is_agent() OR (payload->'synthetic'='true'::jsonb) IS NOT TRUE THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Handler synthetic offer entry required'; END IF;
 c:=app.intake_offer_assert_scope(wanted_scion,(payload->>'scion_revision')::integer,(payload->>'scope_proposal_id')::uuid);
 PERFORM app.intake_offer_assert_source(wanted_scion,c.scion_revision,ref);
 SELECT * INTO series FROM grimoire.intake_offer_series WHERE (org_id,id,scion_id)=(org,wanted_offer,wanted_scion) FOR UPDATE;
 IF NOT FOUND THEN
   IF wanted_number<>1 THEN RAISE EXCEPTION USING ERRCODE='G2402',MESSAGE='initial offer revision required'; END IF;
   INSERT INTO grimoire.intake_offer_series(id,org_id,scion_id,created_by) VALUES(wanted_offer,org,wanted_scion,actor);
 ELSE
   IF series.current_revision+1<>wanted_number THEN RAISE EXCEPTION USING ERRCODE='G2402',MESSAGE='offer revision stale'; END IF;
   SELECT input INTO STRICT first_input FROM grimoire.intake_offer_submissions WHERE offer_id=wanted_offer AND number=1;
   IF first_input->'supplier' IS DISTINCT FROM payload->'supplier' OR first_input->>'offer_ref' IS DISTINCT FROM payload->>'offer_ref' THEN RAISE EXCEPTION USING ERRCODE='G3201',MESSAGE='supplier identity and offer reference are immutable'; END IF;
 END IF;
 SELECT COALESCE(jsonb_agg(k),'[]'::jsonb) INTO missing FROM unnest(ARRAY['offered_manufacturer','offered_part_number','quantity','uom','unit_price','currency','destination','incoterm','payment_terms','quoted_at','valid_from','valid_until','lead_time_days']) k WHERE payload->k IS NULL OR payload->k='null'::jsonb;
 IF jsonb_array_length(missing)=0 THEN
   INSERT INTO grimoire.supplier_legal_entities(org_id,legal_name,jurisdiction,registration_ref)
    VALUES(org,payload#>>'{supplier,legal_name}',payload#>>'{supplier,jurisdiction}',payload#>>'{supplier,registration_ref}') ON CONFLICT DO NOTHING;
   SELECT id INTO STRICT supplier FROM grimoire.supplier_legal_entities WHERE org_id=org AND jurisdiction=payload#>>'{supplier,jurisdiction}' AND registration_ref=payload#>>'{supplier,registration_ref}' AND legal_name=payload#>>'{supplier,legal_name}';
   INSERT INTO grimoire.supplier_sites(org_id,supplier_entity_id,site_code,country_code) VALUES(org,supplier,payload#>>'{supplier,site_code}',payload#>>'{supplier,country_code}') ON CONFLICT DO NOTHING;
   SELECT id INTO STRICT site FROM grimoire.supplier_sites WHERE org_id=org AND supplier_entity_id=supplier AND site_code=payload#>>'{supplier,site_code}' AND country_code=payload#>>'{supplier,country_code}';
   INSERT INTO grimoire.supplier_accounts(org_id,supplier_entity_id,account_ref) VALUES(org,supplier,payload#>>'{supplier,account_ref}') ON CONFLICT DO NOTHING;
   SELECT id INTO STRICT account FROM grimoire.supplier_accounts WHERE org_id=org AND supplier_entity_id=supplier AND account_ref=payload#>>'{supplier,account_ref}';
   SELECT * INTO STRICT src FROM grimoire.intake_source_revisions WHERE (org_id,source_id,number)=(org,(ref->>'source_id')::uuid,(ref->>'source_revision')::integer);
   SELECT * INTO STRICT obj FROM grimoire.intake_source_objects WHERE (org_id,source_id,source_revision)=(org,src.source_id,src.number);
   SELECT source_document_id,source_revision_id INTO src_doc,src_rev FROM grimoire.intake_offer_source_links WHERE (org_id,intake_source_id,intake_source_revision)=(org,src.source_id,src.number);
   IF FOUND THEN
     SELECT supplier_entity_id INTO source_owner FROM grimoire.source_documents WHERE id=src_doc;
     IF source_owner<>supplier THEN RAISE EXCEPTION USING ERRCODE='G3201',MESSAGE='source belongs to another supplier'; END IF;
   ELSE
     src_doc:=gen_random_uuid();src_rev:=gen_random_uuid();
     INSERT INTO grimoire.source_documents(id,org_id,source_code,title,purpose,supplier_entity_id,retention_class,created_by)
      VALUES(src_doc,org,'SYN-OFFER-SOURCE-'||src_doc::text,src.title,'synthetic_offer_comparison',supplier,'synthetic_local_test',actor);
     INSERT INTO grimoire.source_document_revisions(id,org_id,source_document_id,revision_no,s3_bucket,s3_key,s3_version_id,content_sha256,media_type,byte_length,imported_by)
      VALUES(src_rev,org,src_doc,1,obj.object_bucket,obj.object_key,obj.object_version_id,src.content_sha256,'text/plain; charset=utf-8',src.byte_length,actor);
     INSERT INTO grimoire.source_access_events(org_id,source_document_id,state,reason,effective_at,actor_id) VALUES(org,src_doc,'authorized','Synthetic Handler source permission attestation',clock_timestamp(),actor);
     INSERT INTO grimoire.source_lifecycle_events(org_id,source_document_id,state,reason,effective_at,actor_id) VALUES(org,src_doc,'active','Synthetic source reference; original intake immutable',clock_timestamp(),actor);
     -- No agent gains a governed-source grant. Existing intake access remains
     -- the only authority available to the proposal-only local agent.
     INSERT INTO grimoire.source_grants(org_id,source_document_id,principal_id,purpose,valid_during,granted_by)
      SELECT org,src_doc,p.id,'synthetic_offer_comparison',tstzrange(clock_timestamp(),NULL,'[)'),actor FROM grimoire.principals p
      WHERE p.org_id=org AND p.disabled_at IS NULL AND (p.id=actor OR EXISTS(SELECT 1 FROM grimoire.intake_scope_reviewers e WHERE (e.org_id,e.principal_id)=(p.org_id,p.id)))
       AND NOT EXISTS(SELECT 1 FROM grimoire.principal_roles r WHERE (r.org_id,r.principal_id)=(p.org_id,p.id) AND r.role IN ('read_only_agent','system_worker'));
     INSERT INTO grimoire.intake_offer_source_links VALUES(org,src.source_id,src.number,src_doc,src_rev);
   END IF;
   governed_offer:=series.governed_offer_id;
   IF governed_offer IS NULL THEN
     governed_offer:=gen_random_uuid();
     INSERT INTO grimoire.supplier_offers(id,org_id,sourcing_case_id,supplier_entity_id,supplier_site_id,supplier_account_id,offer_ref)
      VALUES(governed_offer,org,c.sourcing_case_id,supplier,site,account,payload->>'offer_ref');
   END IF;
   SELECT COALESCE(max(revision_no),0)+1 INTO governed_number FROM grimoire.offer_revisions WHERE offer_id=governed_offer;
   offer_rev:=gen_random_uuid();line:=gen_random_uuid();
   INSERT INTO grimoire.offer_revisions(id,org_id,offer_id,revision_no,source_revision_id,quoted_at,validity_window,currency,destination,incoterm,payment_terms,created_by,content_hash)
    VALUES(offer_rev,org,governed_offer,governed_number,src_rev,(payload->>'quoted_at')::timestamptz,tstzrange((payload->>'valid_from')::timestamptz,(payload->>'valid_until')::timestamptz,'[)'),payload->>'currency',payload->>'destination',payload->>'incoterm',payload->>'payment_terms',actor,encode(public.digest(payload::text,'sha256'),'hex'));
   INSERT INTO grimoire.offer_lines(id,org_id,offer_revision_id,line_no,occurrence_revision_id,offered_manufacturer,offered_part_number,quantity,uom,unit_price,lead_time_days)
    VALUES(line,org,offer_rev,1,c.occurrence_revision_id,payload->>'offered_manufacturer',payload->>'offered_part_number',(payload->>'quantity')::numeric,payload->>'uom',(payload->>'unit_price')::numeric,(payload->>'lead_time_days')::integer);
 END IF;
 INSERT INTO grimoire.intake_offer_submissions(id,org_id,scion_id,offer_id,number,input,input_hash,missing_fields,governed_offer_revision_id,governed_offer_line_id,created_by)
  VALUES(submission,org,wanted_scion,wanted_offer,wanted_number,payload,encode(public.digest((payload-'change_summary')::text,'sha256'),'hex'),missing,offer_rev,line,actor);
 UPDATE grimoire.intake_offer_series SET current_revision=wanted_number,governed_offer_id=COALESCE(governed_offer,governed_offer_id) WHERE id=wanted_offer AND org_id=org;
 RETURN submission;
END $$;

CREATE FUNCTION grimoire.intake_offer_revoke_bridge() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE source uuid;
BEGIN
 FOR source IN SELECT DISTINCT source_document_id FROM grimoire.intake_offer_source_links WHERE (org_id,intake_source_id)=(NEW.org_id,NEW.source_id) LOOP
   INSERT INTO grimoire.source_access_events(org_id,source_document_id,state,reason,effective_at,actor_id) VALUES(NEW.org_id,source,'revoked',NEW.reason,clock_timestamp(),NEW.created_by);
 END LOOP;
 -- A confirmed physical scope is also an artifact dependency even when its
 -- intake source was never imported as a supplier's governed quotation source.
 UPDATE grimoire.derived_artifacts a SET valid=false,invalidated_at=clock_timestamp(),invalidation_reason='confirmed scope source permission revoked'
 WHERE a.org_id=NEW.org_id AND a.valid AND EXISTS(
   SELECT 1 FROM grimoire.intake_comparison_confirmations cc
   JOIN grimoire.intake_comparison_proposals cp ON (cp.org_id,cp.id)=(cc.org_id,cc.proposal_id)
   JOIN grimoire.intake_scope_proposals sp ON (sp.org_id,sp.id)=(cp.org_id,(cp.input->>'scope_proposal_id')::uuid)
   WHERE (cc.org_id,cc.artifact_id)=(a.org_id,a.id)
     AND EXISTS(SELECT 1 FROM jsonb_array_elements(sp.input->'source_claims') r WHERE (r->>'source_id')::uuid=NEW.source_id));
 RETURN NEW;
END $$;
CREATE TRIGGER intake_offer_revoke_bridge AFTER INSERT ON grimoire.intake_source_revocations FOR EACH ROW EXECUTE FUNCTION grimoire.intake_offer_revoke_bridge();

CREATE FUNCTION app.intake_offer_assert_candidate(wanted_scion uuid,wanted_revision integer,candidate jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE row grimoire.intake_offer_submissions%ROWTYPE; seen integer:=0; offers uuid[]:='{}'; suppliers text[]:='{}';
BEGIN
 PERFORM app.intake_offer_assert_scope(wanted_scion,wanted_revision,(candidate->>'scope_proposal_id')::uuid);
 IF (candidate->'synthetic'='true'::jsonb) IS NOT TRUE OR jsonb_typeof(candidate->'offer_revision_ids') IS DISTINCT FROM 'array' OR jsonb_array_length(candidate->'offer_revision_ids')<>2 THEN RAISE EXCEPTION USING ERRCODE='G3201',MESSAGE='exactly two explicit synthetic offers required'; END IF;
 FOR row IN SELECT s.* FROM grimoire.intake_offer_submissions s WHERE s.org_id=app.current_org_id() AND s.scion_id=wanted_scion AND s.id IN(SELECT value::uuid FROM jsonb_array_elements_text(candidate->'offer_revision_ids')) ORDER BY s.offer_id LOOP
   seen:=seen+1;offers:=array_append(offers,row.offer_id);suppliers:=array_append(suppliers,(row.input->'supplier')->>'registration_ref');
   -- Current rights are mandatory even for an excluded/stale historical input.
   IF EXISTS(SELECT 1 FROM grimoire.intake_source_revocations WHERE (org_id,source_id)=(row.org_id,(row.input#>>'{source,source_id}')::uuid)) THEN RAISE EXCEPTION USING ERRCODE='G2601',MESSAGE='offer source revoked'; END IF;
   IF row.input->>'scope_proposal_id' IS DISTINCT FROM candidate->>'scope_proposal_id' THEN RAISE EXCEPTION USING ERRCODE='G3201',MESSAGE='offer binds another governed scope'; END IF;
 END LOOP;
 IF seen<>2 THEN RAISE EXCEPTION USING ERRCODE='G3204',MESSAGE='offer revision unavailable'; END IF;
 IF offers[1]=offers[2] OR suppliers[1]=suppliers[2] THEN RAISE EXCEPTION USING ERRCODE='G3201',MESSAGE='comparison requires two distinct offers and suppliers'; END IF;
END $$;

CREATE FUNCTION app.intake_offer_snapshot(wanted_scion uuid,wanted_revision integer,candidate jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE c grimoire.intake_scope_confirmations%ROWTYPE; row grimoire.intake_offer_submissions%ROWTYPE; reasons jsonb; lines jsonb:='[]'; b jsonb:=candidate->'basis'; comp grimoire.component_revisions%ROWTYPE; k text; price text; total text;
BEGIN
 PERFORM app.intake_offer_assert_candidate(wanted_scion,wanted_revision,candidate);
 SELECT * INTO STRICT c FROM grimoire.intake_scope_confirmations WHERE proposal_id=(candidate->>'scope_proposal_id')::uuid AND org_id=app.current_org_id();
 SELECT * INTO STRICT comp FROM grimoire.component_revisions WHERE (org_id,id)=(c.org_id,c.component_revision_id);
 FOR row IN SELECT s.* FROM jsonb_array_elements_text(candidate->'offer_revision_ids') WITH ORDINALITY a(id,n) JOIN grimoire.intake_offer_submissions s ON s.id=a.id::uuid WHERE s.org_id=app.current_org_id() ORDER BY a.n LOOP
   reasons:='[]';price:=NULL;total:=NULL;
   IF jsonb_array_length(row.missing_fields)>0 THEN reasons:=reasons||jsonb_build_array('Missing fields: '||(SELECT string_agg(value,', ') FROM jsonb_array_elements_text(row.missing_fields))); END IF;
   IF row.number<>(SELECT current_revision FROM grimoire.intake_offer_series WHERE id=row.offer_id) THEN reasons:=reasons||'"Offer revision is stale"'::jsonb; END IF;
   IF (row.input#>>'{source,source_revision}')::integer<>(SELECT current_revision FROM grimoire.intake_sources WHERE id=(row.input#>>'{source,source_id}')::uuid) THEN reasons:=reasons||'"Source revision is stale"'::jsonb; END IF;
   IF row.input->>'identity_match'<>'exact' THEN reasons:=reasons||'"Identity is ambiguous"'::jsonb; END IF;
   IF row.input->>'offered_manufacturer' IS DISTINCT FROM comp.approved_manufacturer::text OR row.input->>'offered_part_number' IS DISTINCT FROM comp.approved_part_number::text THEN reasons:=reasons||'"Manufacturer or orderable part does not exactly match the confirmed component"'::jsonb; END IF;
   FOREACH k IN ARRAY ARRAY['uom','currency','destination','incoterm','payment_terms'] LOOP
     IF row.input->>k IS DISTINCT FROM b->>k THEN reasons:=reasons||jsonb_build_array('Different '||k||'; no conversion or commercial assumption is supplied'); END IF;
   END LOOP;
   IF (row.input->>'quantity')::numeric IS DISTINCT FROM (b->>'quantity')::numeric THEN reasons:=reasons||'"Quoted quantity differs from the explicit comparison basis"'::jsonb; END IF;
   IF row.input->>'valid_from' IS NULL OR row.input->>'valid_until' IS NULL OR NOT(tstzrange((row.input->>'valid_from')::timestamptz,(row.input->>'valid_until')::timestamptz,'[)') @> (b->>'as_of')::timestamptz) OR NOT(tstzrange((row.input->>'valid_from')::timestamptz,(row.input->>'valid_until')::timestamptz,'[)') @> tstzrange((b->>'valid_from')::timestamptz,(b->>'valid_until')::timestamptz,'[)')) THEN reasons:=reasons||'"Offer validity does not cover the comparison basis"'::jsonb; END IF;
   IF jsonb_array_length(reasons)=0 THEN price:=((row.input->>'unit_price')::numeric(24,8))::text;total:=((b->>'quantity')::numeric(24,8)*(row.input->>'unit_price')::numeric(24,8))::text; END IF;
   lines:=lines||jsonb_build_array(jsonb_build_object('offer_id',row.offer_id,'offer_revision_id',row.id,'governed_offer_line_id',row.governed_offer_line_id,'state',CASE WHEN jsonb_array_length(reasons)=0 THEN 'comparable' ELSE 'excluded' END,'exclusion_reasons',reasons,'normalized_unit_price',price,'extended_price',total,'currency',b->>'currency','lead_time_days',row.input->'lead_time_days'));
 END LOOP;
 RETURN jsonb_build_object('lines',lines,'basis',b,'synthetic',true,'algorithm','same-basis-exact-v1');
END $$;

CREATE FUNCTION app.intake_offer_task_result(wanted_org uuid,wanted_scion uuid,wanted_revision integer,wanted_principal uuid,wanted_proposal uuid,wanted_task uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
 SELECT input FROM grimoire.intake_comparison_proposals WHERE (org_id,scion_id,scion_revision,created_by,id,agent_task_id)=(wanted_org,wanted_scion,wanted_revision,wanted_principal,wanted_proposal,wanted_task) AND org_id=app.current_org_id() AND app.intake_can_access()
$$;
CREATE FUNCTION grimoire.intake_comparison_proposal_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
BEGIN
 IF NEW.org_id IS DISTINCT FROM app.current_org_id() OR NEW.created_by IS DISTINCT FROM app.current_principal_id() OR NOT app.intake_scope_can_propose() THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='normalization proposal denied'; END IF;
 IF app.intake_scope_is_agent() THEN
   NEW.agent_task_id:=nullif(current_setting('app.agent_task_id',true),'')::uuid;
   PERFORM app.intake_task_assert_submission(NEW.agent_task_id,nullif(current_setting('app.agent_task_lease',true),'')::uuid,NEW.scion_id,NEW.scion_revision,'prepare_offer_normalization',NEW.input);
 END IF;
 NEW.snapshot:=app.intake_offer_snapshot(NEW.scion_id,NEW.scion_revision,NEW.input);
 RETURN NEW;
END $$;
CREATE TRIGGER intake_comparison_proposal_guard BEFORE INSERT ON grimoire.intake_comparison_proposals FOR EACH ROW EXECUTE FUNCTION grimoire.intake_comparison_proposal_guard();

CREATE FUNCTION app.intake_offer_reviewer_conflict(wanted_proposal uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
 SELECT p.created_by=app.current_principal_id()
  OR EXISTS(SELECT 1 FROM grimoire.intake_offer_submissions s WHERE s.org_id=p.org_id AND s.id IN(SELECT value::uuid FROM jsonb_array_elements_text(p.input->'offer_revision_ids')) AND s.created_by=app.current_principal_id())
  OR EXISTS(SELECT 1 FROM grimoire.intake_agent_tasks t WHERE (t.org_id,t.scion_id,t.created_by)=(p.org_id,p.scion_id,app.current_principal_id()))
 FROM grimoire.intake_comparison_proposals p WHERE p.id=wanted_proposal AND p.org_id=app.current_org_id() AND app.intake_can_access()
$$;

CREATE FUNCTION app.intake_offer_confirm(wanted_scion uuid,wanted_proposal uuid,wanted_revision integer,note text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE p grimoire.intake_comparison_proposals%ROWTYPE;c grimoire.intake_scope_confirmations%ROWTYPE;fresh jsonb;b jsonb;item jsonb;s grimoire.intake_offer_submissions%ROWTYPE;
 actor uuid:=app.current_principal_id();org uuid:=app.current_org_id();cmp uuid:=gen_random_uuid();artifact uuid:=gen_random_uuid();assess uuid;cmp_number integer;source_rev uuid;
BEGIN
 IF NOT app.intake_scope_can_confirm() OR app.intake_offer_reviewer_conflict(wanted_proposal) IS DISTINCT FROM false THEN RAISE EXCEPTION USING ERRCODE='G2804',MESSAGE='independent enrolled human normalization reviewer required'; END IF;
 PERFORM app.intake_scope_lock_scion(wanted_scion);
 SELECT * INTO p FROM grimoire.intake_comparison_proposals WHERE (org_id,id,scion_id,scion_revision)=(org,wanted_proposal,wanted_scion,wanted_revision);
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='G3204',MESSAGE='comparison unavailable'; END IF;
 IF EXISTS(SELECT 1 FROM grimoire.intake_comparison_confirmations WHERE proposal_id=p.id) THEN RAISE EXCEPTION USING ERRCODE='G3203',MESSAGE='normalization already confirmed'; END IF;
 fresh:=app.intake_offer_snapshot(wanted_scion,wanted_revision,p.input);
 IF fresh IS DISTINCT FROM p.snapshot THEN RAISE EXCEPTION USING ERRCODE='G3202',MESSAGE='comparison inputs changed; prepare a new proposal'; END IF;
 c:=app.intake_offer_assert_scope(wanted_scion,wanted_revision,(p.input->>'scope_proposal_id')::uuid);b:=p.input->'basis';
 PERFORM set_config('app.effective_role','synthetic_engineering_reviewer',true),set_config('app.endpoint_scope','intake:synthetic-normalization-confirm',true),set_config('app.action_reason',note,true);
 INSERT INTO grimoire.derived_artifacts(id,org_id,kind,content_hash,created_by,algorithm_version) VALUES(artifact,org,'comparison',encode(public.digest((p.id::text||p.snapshot::text),'sha256'),'hex'),actor,'same-basis-exact-v1');
 FOR s IN SELECT * FROM grimoire.intake_offer_submissions WHERE org_id=org AND id IN(SELECT value::uuid FROM jsonb_array_elements_text(p.input->'offer_revision_ids')) LOOP
   IF s.governed_offer_revision_id IS NOT NULL THEN
     SELECT source_revision_id INTO STRICT source_rev FROM grimoire.offer_revisions WHERE id=s.governed_offer_revision_id;
     INSERT INTO grimoire.artifact_source_inputs VALUES(org,artifact,source_rev) ON CONFLICT DO NOTHING;
   END IF;
 END LOOP;
 SELECT COALESCE(max(revision_no),0)+1 INTO cmp_number FROM grimoire.comparison_revisions WHERE (org_id,sourcing_case_revision_id)=(org,c.sourcing_case_revision_id);
 INSERT INTO grimoire.comparison_revisions(id,org_id,artifact_id,sourcing_case_revision_id,requirement_revision_id,revision_no,as_of,target_quantity,target_uom,target_currency,destination,required_validity_window,created_by)
 VALUES(cmp,org,artifact,c.sourcing_case_revision_id,c.requirement_revision_id,cmp_number,(b->>'as_of')::timestamptz,(b->>'quantity')::numeric,b->>'uom',b->>'currency',b->>'destination',tstzrange((b->>'valid_from')::timestamptz,(b->>'valid_until')::timestamptz,'[)'),actor);
 FOR item IN SELECT value FROM jsonb_array_elements(p.snapshot->'lines') LOOP
   SELECT * INTO STRICT s FROM grimoire.intake_offer_submissions WHERE (org_id,id)=(org,(item->>'offer_revision_id')::uuid);
   IF s.governed_offer_line_id IS NULL THEN CONTINUE; END IF;
   SELECT id INTO assess FROM grimoire.offer_line_identity_assessments WHERE (org_id,offer_line_id,case_revision_id)=(org,s.governed_offer_line_id,c.sourcing_case_revision_id);
   IF NOT FOUND THEN
     assess:=gen_random_uuid();
     INSERT INTO grimoire.offer_line_identity_assessments(id,org_id,offer_line_id,case_revision_id,state,rationale,reviewed_by)
      VALUES(assess,org,s.governed_offer_line_id,c.sourcing_case_revision_id,CASE WHEN s.input->>'identity_match'<>'exact' THEN 'ambiguous'::grimoire.identity_match_state WHEN EXISTS(SELECT 1 FROM grimoire.component_revisions r WHERE r.id=c.component_revision_id AND r.approved_manufacturer=s.input->>'offered_manufacturer' AND r.approved_part_number=s.input->>'offered_part_number') THEN 'exact_match'::grimoire.identity_match_state ELSE 'substitution'::grimoire.identity_match_state END,note,actor);
   END IF;
   INSERT INTO grimoire.normalized_comparison_lines(org_id,comparison_revision_id,offer_line_id,identity_assessment_id,state,normalized_quantity,normalized_uom,normalized_currency,normalized_unit_price,fx_rate,fx_rate_date,normalized_validity_window,normalization_note,exclusion_reason,reviewed_by)
    VALUES(org,cmp,s.governed_offer_line_id,assess,(item->>'state')::grimoire.comparison_line_state,
     CASE WHEN item->>'state'='comparable' THEN (b->>'quantity')::numeric END,
     CASE WHEN item->>'state'='comparable' THEN b->>'uom' END,CASE WHEN item->>'state'='comparable' THEN b->>'currency' END,
     (item->>'normalized_unit_price')::numeric,CASE WHEN item->>'state'='comparable' THEN 1 END,CASE WHEN item->>'state'='comparable' THEN (b->>'as_of')::timestamptz::date END,
     CASE WHEN item->>'state'='comparable' THEN tstzrange((b->>'valid_from')::timestamptz,(b->>'valid_until')::timestamptz,'[)') END,note,
     CASE WHEN item->>'state'='excluded' THEN (item->'exclusion_reasons')::text END,actor);
 END LOOP;
 INSERT INTO grimoire.intake_comparison_confirmations(proposal_id,org_id,comparison_revision_id,artifact_id,sourcing_case_revision_id,requirement_revision_id,confirmed_by,review_note)
 VALUES(p.id,org,cmp,artifact,c.sourcing_case_revision_id,c.requirement_revision_id,actor,note);
END $$;

CREATE FUNCTION app.intake_offer_governed(wanted_revision uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
 SELECT jsonb_build_object('table','offer_revisions','id',r.id,'revision_no',r.revision_no,'offer_line_id',l.id,'sourcing_case_id',o.sourcing_case_id,'source_revision_id',r.source_revision_id,'supplier_entity_id',o.supplier_entity_id,'supplier_site_id',o.supplier_site_id,'supplier_account_id',o.supplier_account_id,'occurrence_revision_id',l.occurrence_revision_id,'source_sha256',src.content_sha256,'source_version_id',src.s3_version_id)
 FROM grimoire.intake_offer_submissions s JOIN grimoire.offer_revisions r ON r.id=s.governed_offer_revision_id JOIN grimoire.offer_lines l ON l.id=s.governed_offer_line_id JOIN grimoire.supplier_offers o ON o.id=r.offer_id JOIN grimoire.source_document_revisions src ON src.id=r.source_revision_id
 WHERE s.id=wanted_revision AND s.org_id=app.current_org_id() AND app.intake_can_access()
$$;
CREATE FUNCTION app.intake_comparison_governed(wanted_proposal uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
 SELECT jsonb_build_object('table','comparison_revisions','revision_no',r.revision_no,'sourcing_case_revision_id',r.sourcing_case_revision_id,'requirement_revision_id',r.requirement_revision_id,'artifact_valid',a.valid,
 'lines',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',n.id,'offer_line_id',n.offer_line_id,'state',n.state,'normalized_unit_price',n.normalized_unit_price::text,'fx_rate',n.fx_rate::text,'normalization_evidence_id',n.normalization_evidence_id)) FROM grimoire.normalized_comparison_lines n WHERE (n.org_id,n.comparison_revision_id)=(r.org_id,r.id)),'[]'::jsonb))
 FROM grimoire.intake_comparison_confirmations c JOIN grimoire.comparison_revisions r ON r.id=c.comparison_revision_id JOIN grimoire.derived_artifacts a ON a.id=c.artifact_id
 WHERE c.proposal_id=wanted_proposal AND c.org_id=app.current_org_id() AND app.intake_can_access()
   AND a.valid AND app.can_read_artifact(a.id)
$$;

DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['intake_offer_series','intake_offer_submissions','intake_offer_source_links','intake_comparison_proposals','intake_comparison_confirmations'] LOOP
   EXECUTE format('ALTER TABLE grimoire.%I ENABLE ROW LEVEL SECURITY',t);
   EXECUTE format('CREATE POLICY %I_org_read ON grimoire.%I FOR SELECT TO grimoire_intake_app USING(org_id=app.current_org_id() AND app.intake_can_access())',t,t);
   EXECUTE format('REVOKE ALL ON grimoire.%I FROM PUBLIC',t);
   EXECUTE format('GRANT SELECT ON grimoire.%I TO grimoire_intake_app',t);
   IF t<>'intake_offer_series' THEN EXECUTE format('CREATE TRIGGER %I_immutable BEFORE UPDATE OR DELETE ON grimoire.%I FOR EACH ROW EXECUTE FUNCTION grimoire.intake_deny_mutation()',t,t); END IF;
 END LOOP;
END $$;
CREATE POLICY intake_comparison_propose ON grimoire.intake_comparison_proposals FOR INSERT TO grimoire_intake_app WITH CHECK(org_id=app.current_org_id() AND created_by=app.current_principal_id() AND app.intake_scope_can_propose());
GRANT INSERT ON grimoire.intake_comparison_proposals TO grimoire_intake_app;
REVOKE ALL ON FUNCTION app.intake_offer_assert_scope(uuid,integer,uuid),app.intake_offer_assert_source(uuid,integer,jsonb),app.intake_offer_submit(uuid,uuid,integer,jsonb),
 app.intake_offer_assert_candidate(uuid,integer,jsonb),app.intake_offer_snapshot(uuid,integer,jsonb),app.intake_offer_task_result(uuid,uuid,integer,uuid,uuid,uuid),app.intake_offer_reviewer_conflict(uuid),app.intake_offer_confirm(uuid,uuid,integer,text),app.intake_offer_governed(uuid),app.intake_comparison_governed(uuid),grimoire.intake_offer_revoke_bridge(),grimoire.intake_comparison_proposal_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.intake_offer_assert_scope(uuid,integer,uuid),app.intake_offer_assert_source(uuid,integer,jsonb),app.intake_offer_submit(uuid,uuid,integer,jsonb),
 app.intake_offer_assert_candidate(uuid,integer,jsonb),app.intake_offer_snapshot(uuid,integer,jsonb),app.intake_offer_task_result(uuid,uuid,integer,uuid,uuid,uuid),app.intake_offer_reviewer_conflict(uuid),app.intake_offer_confirm(uuid,uuid,integer,text),app.intake_offer_governed(uuid),app.intake_comparison_governed(uuid) TO grimoire_intake_app;
COMMIT;
