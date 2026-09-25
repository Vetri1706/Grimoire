BEGIN;
SET search_path = grimoire, public;

-- The table owner is a non-login migration role. FORCE made bounded definer
-- functions fail under a non-superuser owner; ordinary runtime roles still use RLS.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'principals','principal_roles','org_security_epochs','products','product_configurations',
    'product_configuration_revisions','components','component_revisions','bom_occurrences',
    'bom_occurrence_revisions','requirements','requirement_revisions','sourcing_cases',
    'sourcing_case_revisions','supplier_legal_entities','supplier_sites','supplier_accounts',
    'source_documents','source_document_revisions','source_access_events','source_grants',
    'source_grant_revocations','legal_holds','source_legal_holds','source_lifecycle_events',
    'claims','claim_relations','qualification_tests','qualification_test_revisions',
    'qualification_test_executions','test_result_revisions','test_result_reviews',
    'supplier_offers','offer_revisions','offer_lines','offer_line_identity_assessments',
    'derived_artifacts','artifact_source_inputs','comparison_revisions',
    'normalized_comparison_lines','decision_packets','decision_packet_revisions','decisions',
    'decision_revisions','decision_offer_inputs','decision_qualification_inputs',
    'decision_approvals','approval_events','decision_state_events','change_impacts',
    'idempotency_records','outbox_events','audit_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

ALTER TABLE derived_artifacts
  ADD COLUMN algorithm_version nonempty_text NOT NULL DEFAULT 'deterministic-v1',
  ADD COLUMN schema_version nonempty_text NOT NULL DEFAULT '2.2.1',
  ADD COLUMN built_access_epoch bigint,
  ADD CONSTRAINT derived_artifact_epoch_positive
    CHECK (built_access_epoch IS NULL OR built_access_epoch > 0);

CREATE FUNCTION set_artifact_epoch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = grimoire, pg_temp
AS $$
BEGIN
  IF NEW.built_access_epoch IS NULL THEN
    SELECT access_epoch INTO STRICT NEW.built_access_epoch
    FROM org_security_epochs WHERE org_id = NEW.org_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER derived_artifact_epoch_guard
BEFORE INSERT ON derived_artifacts
FOR EACH ROW EXECUTE FUNCTION set_artifact_epoch();

CREATE TABLE normalization_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  source_revision_id uuid NOT NULL,
  from_currency currency_code NOT NULL,
  to_currency currency_code NOT NULL,
  fx_rate numeric(24,12) NOT NULL CHECK (fx_rate > 0),
  rate_date date NOT NULL,
  from_uom nonempty_text NOT NULL,
  to_uom nonempty_text NOT NULL,
  unit_factor numeric(24,12) NOT NULL CHECK (unit_factor > 0),
  rounding_scale smallint NOT NULL CHECK (rounding_scale BETWEEN 0 AND 8),
  rounding_mode nonempty_text NOT NULL CHECK (rounding_mode = 'half_even'),
  reviewed_by uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (org_id,id),
  FOREIGN KEY (org_id,source_revision_id) REFERENCES source_document_revisions(org_id,id),
  FOREIGN KEY (org_id,reviewed_by) REFERENCES principals(org_id,id)
);
ALTER TABLE normalization_evidence ENABLE ROW LEVEL SECURITY;
CREATE POLICY normalization_evidence_select ON normalization_evidence FOR SELECT USING (
  org_id=app.current_org_id() AND EXISTS (
    SELECT 1 FROM source_document_revisions sr
    WHERE (sr.org_id,sr.id)=(normalization_evidence.org_id,normalization_evidence.source_revision_id)
      AND app.can_read_source(sr.source_document_id)
  )
);
CREATE POLICY normalization_evidence_insert ON normalization_evidence FOR INSERT
  WITH CHECK (org_id=app.current_org_id());
ALTER TABLE normalized_comparison_lines
  ADD COLUMN normalization_evidence_id uuid,
  ADD CONSTRAINT normalized_line_evidence_fk
    FOREIGN KEY (org_id,normalization_evidence_id)
    REFERENCES normalization_evidence(org_id,id);

ALTER TABLE decision_revisions
  ADD COLUMN supersedes_decision_revision_id uuid,
  ADD CONSTRAINT decision_revision_supersedes_fk
    FOREIGN KEY (org_id,supersedes_decision_revision_id)
    REFERENCES decision_revisions(org_id,id),
  ADD CONSTRAINT decision_revision_not_self_superseding
    CHECK (supersedes_decision_revision_id IS NULL OR supersedes_decision_revision_id <> id);

ALTER TABLE approval_events
  ADD COLUMN idempotency_key nonempty_text NOT NULL DEFAULT ('legacy:' || gen_random_uuid()::text),
  ADD CONSTRAINT approval_event_idempotency UNIQUE (org_id,idempotency_key);

ALTER TABLE outbox_events
  ADD COLUMN lease_owner nonempty_text,
  ADD COLUMN lease_token uuid,
  ADD COLUMN result_hash sha256_hex,
  ADD CONSTRAINT outbox_state_shape CHECK (
    (state='pending' AND lease_owner IS NULL AND lease_token IS NULL AND completed_at IS NULL)
    OR (state='running' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL AND completed_at IS NULL)
    OR (state='succeeded' AND lease_owner IS NULL AND lease_token IS NULL AND lease_until IS NULL AND completed_at IS NOT NULL AND result_hash IS NOT NULL)
    OR (state='dead' AND lease_owner IS NULL AND lease_token IS NULL AND lease_until IS NULL AND completed_at IS NOT NULL AND last_error_code IS NOT NULL)
  );

ALTER TABLE audit_events
  ADD COLUMN effective_role nonempty_text NOT NULL DEFAULT 'migration_fixture',
  ADD COLUMN endpoint_scope nonempty_text NOT NULL DEFAULT 'migration_fixture',
  ADD COLUMN input_hash sha256_hex NOT NULL DEFAULT repeat('0',64),
  ADD COLUMN decision_reason nonempty_text NOT NULL DEFAULT 'migration fixture or legacy event',
  ADD COLUMN outcome nonempty_text NOT NULL DEFAULT 'committed';

CREATE TYPE erasure_action_kind AS ENUM ('object_version','delete_marker','multipart_upload','payload_key');
CREATE TYPE erasure_action_state AS ENUM ('pending','blocked_hold','deleted','verified','failed');
CREATE TABLE source_erasure_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  source_document_id uuid NOT NULL,
  source_revision_id uuid,
  action_kind erasure_action_kind NOT NULL,
  s3_bucket nonempty_text,
  s3_key nonempty_text,
  s3_version_id text,
  state erasure_action_state NOT NULL,
  request_ref nonempty_text NOT NULL,
  attempted_at timestamptz,
  verified_at timestamptz,
  verification_hash sha256_hex,
  last_error_code text,
  UNIQUE (org_id,id),
  UNIQUE NULLS NOT DISTINCT (org_id,source_document_id,action_kind,s3_bucket,s3_key,s3_version_id,request_ref),
  FOREIGN KEY (org_id,source_document_id) REFERENCES source_documents(org_id,id),
  FOREIGN KEY (org_id,source_revision_id) REFERENCES source_document_revisions(org_id,id),
  CHECK ((state='verified' AND verified_at IS NOT NULL AND verification_hash IS NOT NULL)
      OR state<>'verified')
);
CREATE TABLE restore_checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  checkpoint_no bigint NOT NULL CHECK (checkpoint_no > 0),
  audit_recorded_through timestamptz NOT NULL,
  audit_event_id uuid NOT NULL,
  s3_bucket nonempty_text NOT NULL,
  s3_key nonempty_text NOT NULL,
  s3_version_id nonempty_text NOT NULL,
  manifest_sha256 sha256_hex NOT NULL,
  signature_sha256 sha256_hex NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (org_id,id), UNIQUE (org_id,checkpoint_no),
  FOREIGN KEY (org_id,audit_event_id) REFERENCES audit_events(org_id,id)
);
ALTER TABLE source_erasure_actions ENABLE ROW LEVEL SECURITY;
CREATE POLICY source_erasure_worker_all ON source_erasure_actions FOR ALL
  USING (org_id=app.current_org_id() AND (app.has_role('system_worker') OR app.has_role('records_officer')))
  WITH CHECK (org_id=app.current_org_id() AND (app.has_role('system_worker') OR app.has_role('records_officer')));
ALTER TABLE restore_checkpoints ENABLE ROW LEVEL SECURITY;
CREATE POLICY restore_checkpoint_admin_all ON restore_checkpoints FOR ALL
  USING (org_id=app.current_org_id() AND (app.has_role('records_officer') OR app.has_role('org_admin')))
  WITH CHECK (org_id=app.current_org_id() AND (app.has_role('records_officer') OR app.has_role('org_admin')));

CREATE FUNCTION enforce_aggregate_revision_identity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = grimoire, pg_temp
AS $$
DECLARE
  v_occurrence_configuration uuid;
  v_revision_configuration uuid;
  v_requirement_occurrence uuid;
  v_requirement_component uuid;
  v_occurrence_header uuid;
BEGIN
  IF TG_TABLE_NAME='bom_occurrence_revisions' THEN
    SELECT configuration_id INTO STRICT v_occurrence_configuration
    FROM bom_occurrences WHERE (org_id,id)=(NEW.org_id,NEW.occurrence_id);
    SELECT configuration_id INTO STRICT v_revision_configuration
    FROM product_configuration_revisions
    WHERE (org_id,id)=(NEW.org_id,NEW.configuration_revision_id);
    IF v_occurrence_configuration<>v_revision_configuration THEN
      RAISE EXCEPTION USING ERRCODE='G1010', MESSAGE='occurrence revision uses another configuration';
    END IF;
  ELSIF TG_TABLE_NAME='requirement_revisions' THEN
    SELECT occurrence_id INTO STRICT v_requirement_occurrence
    FROM requirements WHERE (org_id,id)=(NEW.org_id,NEW.requirement_id);
    SELECT occurrence_id,component_revision_id
      INTO STRICT v_occurrence_header,v_requirement_component
    FROM bom_occurrence_revisions
    WHERE (org_id,id)=(NEW.org_id,NEW.occurrence_revision_id);
    IF v_requirement_occurrence<>v_occurrence_header
       OR NEW.component_revision_id<>v_requirement_component THEN
      RAISE EXCEPTION USING ERRCODE='G1011', MESSAGE='requirement revision uses another occurrence or component';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bom_occurrence_revision_aggregate_guard
BEFORE INSERT ON bom_occurrence_revisions
FOR EACH ROW EXECUTE FUNCTION enforce_aggregate_revision_identity();
CREATE TRIGGER requirement_revision_aggregate_guard
BEFORE INSERT ON requirement_revisions
FOR EACH ROW EXECUTE FUNCTION enforce_aggregate_revision_identity();

CREATE OR REPLACE FUNCTION enforce_comparison_line() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = grimoire, pg_temp
AS $$
DECLARE
  v_case sourcing_case_revisions%ROWTYPE;
  v_case_header uuid;
  v_cmp comparison_revisions%ROWTYPE;
  v_line offer_lines%ROWTYPE;
  v_offer offer_revisions%ROWTYPE;
  v_offer_header supplier_offers%ROWTYPE;
  v_assess offer_line_identity_assessments%ROWTYPE;
  v_component component_revisions%ROWTYPE;
  v_norm normalization_evidence%ROWTYPE;
  v_expected_price numeric(24,8);
BEGIN
  SELECT * INTO STRICT v_cmp FROM comparison_revisions
    WHERE (org_id,id)=(NEW.org_id,NEW.comparison_revision_id);
  SELECT * INTO STRICT v_case FROM sourcing_case_revisions
    WHERE (org_id,id)=(NEW.org_id,v_cmp.sourcing_case_revision_id);
  SELECT sourcing_case_id INTO STRICT v_case_header FROM sourcing_case_revisions
    WHERE (org_id,id)=(NEW.org_id,v_case.id);
  SELECT * INTO STRICT v_line FROM offer_lines
    WHERE (org_id,id)=(NEW.org_id,NEW.offer_line_id);
  SELECT * INTO STRICT v_offer FROM offer_revisions
    WHERE (org_id,id)=(NEW.org_id,v_line.offer_revision_id);
  SELECT * INTO STRICT v_offer_header FROM supplier_offers
    WHERE (org_id,id)=(NEW.org_id,v_offer.offer_id);
  SELECT * INTO STRICT v_assess FROM offer_line_identity_assessments
    WHERE (org_id,id)=(NEW.org_id,NEW.identity_assessment_id);
  SELECT * INTO STRICT v_component FROM component_revisions
    WHERE (org_id,id)=(NEW.org_id,v_case.component_revision_id);

  IF v_assess.offer_line_id<>NEW.offer_line_id OR v_assess.case_revision_id<>v_case.id THEN
    RAISE EXCEPTION USING ERRCODE='G1001', MESSAGE='identity assessment does not bind this line and case revision';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM principal_roles pr JOIN principals p
      ON (p.org_id,p.id)=(pr.org_id,pr.principal_id)
    WHERE (pr.org_id,pr.principal_id,pr.role)=
      (NEW.org_id,NEW.reviewed_by,'engineering_reviewer'::actor_role)
      AND p.disabled_at IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE='G2003', MESSAGE='comparison line requires an enabled engineering reviewer';
  END IF;

  IF NEW.state='comparable' THEN
    IF v_offer_header.sourcing_case_id<>v_case_header
       OR v_assess.state<>'exact_match'
       OR v_line.occurrence_revision_id<>v_case.occurrence_revision_id
       OR v_line.offered_manufacturer<>v_component.approved_manufacturer
       OR v_line.offered_part_number<>v_component.approved_part_number
       OR v_cmp.requirement_revision_id<>v_case.requirement_revision_id
       OR NEW.normalized_quantity<>v_cmp.target_quantity
       OR NEW.normalized_uom<>v_cmp.target_uom
       OR NEW.normalized_currency<>v_cmp.target_currency
       OR NEW.normalized_validity_window IS DISTINCT FROM v_cmp.required_validity_window
       OR v_offer.destination<>v_cmp.destination
       OR NOT (v_offer.validity_window @> v_cmp.as_of)
       OR NOT (v_offer.validity_window @> v_cmp.required_validity_window)
    THEN
      RAISE EXCEPTION USING ERRCODE='G1002', MESSAGE='line is not comparable to the exact case and basis';
    END IF;

    IF v_offer.currency=v_cmp.target_currency AND v_line.uom=v_cmp.target_uom THEN
      IF NEW.normalization_evidence_id IS NOT NULL OR NEW.fx_rate<>1
         OR NEW.normalized_unit_price<>v_line.unit_price
         OR NEW.fx_rate_date<>v_cmp.as_of::date THEN
        RAISE EXCEPTION USING ERRCODE='G1012', MESSAGE='same-basis normalization must preserve quoted unit price with fx rate 1';
      END IF;
    ELSE
      IF NEW.normalization_evidence_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='G1012', MESSAGE='currency or unit conversion requires reviewed evidence';
      END IF;
      SELECT * INTO STRICT v_norm FROM normalization_evidence
        WHERE (org_id,id)=(NEW.org_id,NEW.normalization_evidence_id);
      v_expected_price := round((v_line.unit_price / v_norm.unit_factor) * v_norm.fx_rate,
                                v_norm.rounding_scale);
      IF v_norm.from_currency<>v_offer.currency OR v_norm.to_currency<>v_cmp.target_currency
         OR v_norm.from_uom<>v_line.uom OR v_norm.to_uom<>v_cmp.target_uom
         OR NEW.fx_rate<>v_norm.fx_rate OR NEW.fx_rate_date<>v_norm.rate_date
         OR NEW.normalized_unit_price<>v_expected_price
         OR v_norm.rate_date>v_cmp.as_of::date
         OR NOT EXISTS (
           SELECT 1 FROM artifact_source_inputs asi
           WHERE (asi.org_id,asi.artifact_id,asi.source_revision_id)=
             (NEW.org_id,v_cmp.artifact_id,v_norm.source_revision_id)
         )
      THEN
        RAISE EXCEPTION USING ERRCODE='G1012', MESSAGE='normalized value is not derivable from the reviewed conversion evidence';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION enforce_packet_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = grimoire, pg_temp
AS $$
DECLARE v_packet_case uuid; v_case_header uuid; v_cmp comparison_revisions%ROWTYPE;
        v_art derived_artifacts%ROWTYPE; v_epoch bigint;
BEGIN
  SELECT sourcing_case_id INTO STRICT v_packet_case FROM decision_packets
    WHERE (org_id,id)=(NEW.org_id,NEW.packet_id);
  SELECT sourcing_case_id INTO STRICT v_case_header FROM sourcing_case_revisions
    WHERE (org_id,id)=(NEW.org_id,NEW.case_revision_id);
  SELECT * INTO STRICT v_cmp FROM comparison_revisions
    WHERE (org_id,id)=(NEW.org_id,NEW.comparison_revision_id);
  SELECT * INTO STRICT v_art FROM derived_artifacts
    WHERE (org_id,id)=(NEW.org_id,NEW.artifact_id);
  SELECT access_epoch INTO STRICT v_epoch FROM org_security_epochs WHERE org_id=NEW.org_id;
  IF v_packet_case<>v_case_header OR v_cmp.sourcing_case_revision_id<>NEW.case_revision_id
     OR v_cmp.requirement_revision_id<>NEW.requirement_revision_id
     OR v_art.kind<>'decision_packet' OR NOT v_art.valid OR v_art.built_access_epoch<>v_epoch
  THEN
    RAISE EXCEPTION USING ERRCODE='G1013', MESSAGE='packet header, case, comparison, artifact kind, validity, or policy epoch differs';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER decision_packet_revision_guard
BEFORE INSERT ON decision_packet_revisions
FOR EACH ROW EXECUTE FUNCTION enforce_packet_revision();

CREATE OR REPLACE FUNCTION enforce_decision_revision_bindings() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = grimoire, pg_temp
AS $$
DECLARE pkt decision_packet_revisions%ROWTYPE; cmp comparison_revisions%ROWTYPE;
        v_decision_case uuid; v_case_header uuid;
BEGIN
  SELECT sourcing_case_id INTO STRICT v_decision_case FROM decisions
    WHERE (org_id,id)=(NEW.org_id,NEW.decision_id);
  SELECT sourcing_case_id INTO STRICT v_case_header FROM sourcing_case_revisions
    WHERE (org_id,id)=(NEW.org_id,NEW.case_revision_id);
  SELECT * INTO STRICT pkt FROM decision_packet_revisions
    WHERE (org_id,id)=(NEW.org_id,NEW.packet_revision_id);
  SELECT * INTO STRICT cmp FROM comparison_revisions
    WHERE (org_id,id)=(NEW.org_id,NEW.comparison_revision_id);
  IF v_decision_case<>v_case_header OR pkt.case_revision_id<>NEW.case_revision_id
     OR pkt.requirement_revision_id<>NEW.requirement_revision_id
     OR pkt.comparison_revision_id<>NEW.comparison_revision_id
     OR cmp.sourcing_case_revision_id<>NEW.case_revision_id
     OR cmp.requirement_revision_id<>NEW.requirement_revision_id
     OR NOT EXISTS (
       SELECT 1 FROM offer_lines l
       WHERE (l.org_id,l.id,l.offer_revision_id)=
             (NEW.org_id,NEW.selected_offer_line_id,NEW.selected_offer_revision_id)
     )
     OR NOT EXISTS (
       SELECT 1 FROM normalized_comparison_lines n
       WHERE (n.org_id,n.comparison_revision_id,n.offer_line_id,n.state)=
             (NEW.org_id,NEW.comparison_revision_id,NEW.selected_offer_line_id,'comparable')
     )
     OR (NEW.supersedes_decision_revision_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM decision_revisions prior
       WHERE (prior.org_id,prior.id,prior.decision_id)=
             (NEW.org_id,NEW.supersedes_decision_revision_id,NEW.decision_id)
     ))
  THEN
    RAISE EXCEPTION USING ERRCODE='G1006', MESSAGE='decision revision inputs do not bind one exact case and comparable selected line';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION enforce_decision_offer_input() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = grimoire, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM decision_revisions d
    JOIN sourcing_case_revisions cr ON (cr.org_id,cr.id)=(d.org_id,d.case_revision_id)
    JOIN offer_revisions r ON (r.org_id,r.id)=(NEW.org_id,NEW.offer_revision_id)
    JOIN supplier_offers o ON (o.org_id,o.id)=(r.org_id,r.offer_id)
    JOIN offer_lines l ON (l.org_id,l.id,l.offer_revision_id)=
      (NEW.org_id,NEW.offer_line_id,NEW.offer_revision_id)
    JOIN normalized_comparison_lines n
      ON (n.org_id,n.comparison_revision_id,n.offer_line_id,n.state)=
         (d.org_id,d.comparison_revision_id,l.id,'comparable')
    WHERE (d.org_id,d.id)=(NEW.org_id,NEW.decision_revision_id)
      AND o.sourcing_case_id=cr.sourcing_case_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE='G1008', MESSAGE='decision offer input is not a comparable offer line for the same sourcing case';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION enforce_decision_qualification_input() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = grimoire, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM decision_revisions d
    JOIN sourcing_case_revisions c ON (c.org_id,c.id)=(d.org_id,d.case_revision_id)
    JOIN qualification_test_revisions t ON (t.org_id,t.id)=(NEW.org_id,NEW.test_revision_id)
    JOIN test_result_revisions r ON (r.org_id,r.id)=(NEW.org_id,NEW.result_revision_id)
    JOIN qualification_test_executions e
      ON (e.org_id,e.id,e.test_revision_id)=(r.org_id,r.execution_id,t.id)
    JOIN supplier_offers selected_offer ON selected_offer.org_id=d.org_id
    JOIN offer_revisions selected_revision
      ON (selected_revision.org_id,selected_revision.id,selected_revision.offer_id)=
         (d.org_id,d.selected_offer_revision_id,selected_offer.id)
    WHERE (d.org_id,d.id)=(NEW.org_id,NEW.decision_revision_id)
      AND t.requirement_revision_id=d.requirement_revision_id
      AND t.occurrence_revision_id=c.occurrence_revision_id
      AND t.component_revision_id=c.component_revision_id
      AND e.offered_component_revision_id=c.component_revision_id
      AND e.supplier_site_id=selected_offer.supplier_site_id
      AND r.outcome='pass'
      AND NOT EXISTS (
        SELECT 1 FROM test_result_revisions later
        WHERE (later.org_id,later.execution_id)=(r.org_id,r.execution_id)
          AND later.revision_no>r.revision_no
      )
      AND 2=(
        SELECT count(*) FROM test_result_reviews rr
        WHERE (rr.org_id,rr.result_revision_id)=(r.org_id,r.id)
          AND rr.state='accepted' AND rr.domain IN ('engineering','quality')
          AND rr.reviewer_id<>r.created_by AND rr.reviewer_id<>e.executed_by
      )
      AND 2=(
        SELECT count(DISTINCT rr.reviewer_id) FROM test_result_reviews rr
        WHERE (rr.org_id,rr.result_revision_id)=(r.org_id,r.id)
          AND rr.state='accepted' AND rr.domain IN ('engineering','quality')
      )
      AND EXISTS (
        SELECT 1 FROM source_document_revisions sr
        WHERE (sr.org_id,sr.id)=(r.org_id,r.source_revision_id)
          AND app.can_read_source(sr.source_document_id)
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE='G1009', MESSAGE='qualification input is not current, passing, independently accepted evidence for the selected case/site/component';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION assert_decision_complete(wanted_org uuid, wanted_decision_revision uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = grimoire, pg_temp
AS $$
DECLARE
  d decision_revisions%ROWTYPE;
  p decision_packet_revisions%ROWTYPE;
  a derived_artifacts%ROWTYPE;
  v_epoch bigint;
  expected_sources uuid[];
  actual_sources uuid[];
BEGIN
  SELECT * INTO STRICT d FROM decision_revisions
    WHERE (org_id,id)=(wanted_org,wanted_decision_revision);
  SELECT * INTO STRICT p FROM decision_packet_revisions
    WHERE (org_id,id)=(wanted_org,d.packet_revision_id);
  SELECT * INTO STRICT a FROM derived_artifacts
    WHERE (org_id,id)=(wanted_org,p.artifact_id);
  SELECT access_epoch INTO STRICT v_epoch FROM org_security_epochs WHERE org_id=wanted_org;

  IF a.kind<>'decision_packet' OR NOT a.valid OR a.built_access_epoch<>v_epoch
     OR 2<>(SELECT count(*) FROM decision_offer_inputs i
            WHERE (i.org_id,i.decision_revision_id)=(wanted_org,d.id))
     OR 1<>(SELECT count(*) FROM decision_qualification_inputs i
            WHERE (i.org_id,i.decision_revision_id)=(wanted_org,d.id))
     OR NOT EXISTS (
       SELECT 1 FROM decision_offer_inputs i
       WHERE (i.org_id,i.decision_revision_id,i.offer_revision_id,i.offer_line_id)=
         (wanted_org,d.id,d.selected_offer_revision_id,d.selected_offer_line_id)
     )
  THEN
    RAISE EXCEPTION USING ERRCODE='G2011', MESSAGE='decision is incomplete or packet artifact is stale';
  END IF;

  IF EXISTS (
    SELECT 1 FROM decision_offer_inputs i
    JOIN offer_revisions r ON (r.org_id,r.id)=(i.org_id,i.offer_revision_id)
    JOIN source_document_revisions sr ON (sr.org_id,sr.id)=(r.org_id,r.source_revision_id)
    WHERE (i.org_id,i.decision_revision_id)=(wanted_org,d.id)
      AND NOT app.can_read_source(sr.source_document_id)
  ) THEN
    RAISE EXCEPTION USING ERRCODE='G2012', MESSAGE='decision contains an unreadable offer source';
  END IF;

  SELECT COALESCE(array_agg(x.source_revision_id ORDER BY x.source_revision_id),'{}'::uuid[])
  INTO expected_sources
  FROM (
    SELECT r.source_revision_id
    FROM decision_offer_inputs i
    JOIN offer_revisions r ON (r.org_id,r.id)=(i.org_id,i.offer_revision_id)
    WHERE (i.org_id,i.decision_revision_id)=(wanted_org,d.id)
    UNION
    SELECT r.source_revision_id
    FROM decision_qualification_inputs i
    JOIN test_result_revisions r ON (r.org_id,r.id)=(i.org_id,i.result_revision_id)
    WHERE (i.org_id,i.decision_revision_id)=(wanted_org,d.id)
  ) x;
  SELECT COALESCE(array_agg(source_revision_id ORDER BY source_revision_id),'{}'::uuid[])
  INTO actual_sources
  FROM artifact_source_inputs
  WHERE (org_id,artifact_id)=(wanted_org,p.artifact_id);
  IF expected_sources IS DISTINCT FROM actual_sources THEN
    RAISE EXCEPTION USING ERRCODE='G2013', MESSAGE='packet source manifest is incomplete or contains an extra source';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION enforce_decision_approval() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = grimoire, pg_temp
AS $$
DECLARE prepared uuid; required_role actor_role; current_state decision_state;
BEGIN
  SELECT prepared_by INTO STRICT prepared FROM decision_revisions
    WHERE (org_id,id)=(NEW.org_id,NEW.decision_revision_id);
  SELECT state INTO current_state FROM current_decision_state
    WHERE (org_id,decision_revision_id)=(NEW.org_id,NEW.decision_revision_id);
  required_role := CASE NEW.domain
    WHEN 'engineering' THEN 'engineering_reviewer'::actor_role
    WHEN 'quality' THEN 'quality_reviewer'::actor_role
    WHEN 'commercial' THEN 'commercial_approver'::actor_role END;
  IF current_state<>'submitted' OR NEW.approver_id=prepared
     OR EXISTS (
       SELECT 1 FROM decision_approvals x
       WHERE (x.org_id,x.decision_revision_id)=(NEW.org_id,NEW.decision_revision_id)
         AND x.approver_id=NEW.approver_id
     )
     OR NOT EXISTS (
       SELECT 1 FROM principal_roles pr JOIN principals p
         ON (p.org_id,p.id)=(pr.org_id,pr.principal_id)
       WHERE (pr.org_id,pr.principal_id,pr.role)=(NEW.org_id,NEW.approver_id,required_role)
         AND p.disabled_at IS NULL
     )
  THEN
    RAISE EXCEPTION USING ERRCODE='G2003', MESSAGE='approval requires submitted current revision, separation, enabled principal, and matching domain role';
  END IF;
  PERFORM assert_decision_complete(NEW.org_id,NEW.decision_revision_id);
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION enforce_decision_state() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = grimoire, pg_temp
AS $$
DECLARE previous decision_state; prepared uuid;
BEGIN
  SELECT state INTO previous FROM current_decision_state
    WHERE (org_id,decision_revision_id)=(NEW.org_id,NEW.decision_revision_id);
  SELECT prepared_by INTO STRICT prepared FROM decision_revisions
    WHERE (org_id,id)=(NEW.org_id,NEW.decision_revision_id);

  IF NOT (
    (previous IS NULL AND NEW.state='draft')
    OR (previous='draft' AND NEW.state='submitted')
    OR (previous='submitted' AND NEW.state IN ('approved','revoked'))
    OR (previous='approved' AND NEW.state IN ('stale','revoked','superseded'))
    OR (previous='stale' AND NEW.state IN ('reopened','revoked','superseded'))
    OR (previous='reopened' AND NEW.state='superseded')
  ) THEN
    RAISE EXCEPTION USING ERRCODE='G2014', MESSAGE='decision state transition is not allowed';
  END IF;

  IF NEW.state='submitted' THEN
    IF NEW.actor_id<>prepared THEN
      RAISE EXCEPTION USING ERRCODE='G2003', MESSAGE='only the decision preparer may submit';
    END IF;
    PERFORM assert_decision_complete(NEW.org_id,NEW.decision_revision_id);
  ELSIF NEW.state='approved' THEN
    PERFORM assert_decision_complete(NEW.org_id,NEW.decision_revision_id);
    IF 3<>(
      SELECT count(DISTINCT x.domain) FROM decision_approvals x
      WHERE (x.org_id,x.decision_revision_id)=(NEW.org_id,NEW.decision_revision_id)
        AND EXISTS (
          SELECT 1 FROM approval_events e
          WHERE (e.org_id,e.approval_id,e.kind)=(x.org_id,x.id,'granted')
        )
        AND NOT EXISTS (
          SELECT 1 FROM approval_events e
          WHERE (e.org_id,e.approval_id,e.kind)=(x.org_id,x.id,'revoked')
        )
    ) OR NEW.actor_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM principal_roles pr JOIN principals p
        ON (p.org_id,p.id)=(pr.org_id,pr.principal_id)
      WHERE (pr.org_id,pr.principal_id,pr.role)=
        (NEW.org_id,NEW.actor_id,'commercial_approver'::actor_role)
        AND p.disabled_at IS NULL
    ) THEN
      RAISE EXCEPTION USING ERRCODE='G2004', MESSAGE='approval requires three active domain grants and an enabled commercial finalizer';
    END IF;
  ELSIF NEW.state IN ('reopened','superseded') THEN
    IF NOT EXISTS (
      SELECT 1 FROM decision_revisions replacement
      WHERE (replacement.org_id,replacement.supersedes_decision_revision_id)=
            (NEW.org_id,NEW.decision_revision_id)
        AND (NEW.state='reopened' OR EXISTS (
          SELECT 1 FROM current_decision_state s
          WHERE (s.org_id,s.decision_revision_id,s.state)=
                (replacement.org_id,replacement.id,'approved')
        ))
    ) THEN
      RAISE EXCEPTION USING ERRCODE='G2015', MESSAGE='reopen or supersede requires an exact linked replacement revision';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION enforce_approval_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = grimoire, pg_temp
AS $$
DECLARE a decision_approvals%ROWTYPE; required_role actor_role; prepared uuid;
BEGIN
  SELECT * INTO STRICT a FROM decision_approvals
    WHERE (org_id,id)=(NEW.org_id,NEW.approval_id);
  SELECT prepared_by INTO STRICT prepared FROM decision_revisions
    WHERE (org_id,id)=(a.org_id,a.decision_revision_id);
  required_role := CASE a.domain
    WHEN 'engineering' THEN 'engineering_reviewer'::actor_role
    WHEN 'quality' THEN 'quality_reviewer'::actor_role
    WHEN 'commercial' THEN 'commercial_approver'::actor_role END;
  IF NEW.kind='granted' AND NEW.actor_id<>a.approver_id THEN
    RAISE EXCEPTION USING ERRCODE='G2003', MESSAGE='approval grant actor must be the bound approver';
  END IF;
  IF NEW.kind='revoked' AND (NEW.actor_id=prepared OR NOT EXISTS (
    SELECT 1 FROM principal_roles pr JOIN principals p
      ON (p.org_id,p.id)=(pr.org_id,pr.principal_id)
    WHERE (pr.org_id,pr.principal_id,pr.role)=(NEW.org_id,NEW.actor_id,required_role)
      AND p.disabled_at IS NULL
  )) THEN
    RAISE EXCEPTION USING ERRCODE='G2003', MESSAGE='revocation requires an enabled actor in the approval domain and separation from preparer';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER approval_event_authority_guard
BEFORE INSERT ON approval_events
FOR EACH ROW EXECUTE FUNCTION enforce_approval_event();

CREATE FUNCTION revoke_decision_with_approval() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = grimoire, pg_temp
AS $$
DECLARE d uuid; s decision_state;
BEGIN
  SELECT decision_revision_id INTO STRICT d FROM decision_approvals
    WHERE (org_id,id)=(NEW.org_id,NEW.approval_id);
  SELECT state INTO s FROM current_decision_state
    WHERE (org_id,decision_revision_id)=(NEW.org_id,d);
  IF s IN ('submitted','approved') THEN
    INSERT INTO decision_state_events(
      org_id,decision_revision_id,state,actor_id,reason,idempotency_key
    ) VALUES (
      NEW.org_id,d,'revoked',NEW.actor_id,
      'domain approval revoked: '||NEW.rationale,
      'approval-revoked:'||NEW.id
    );
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER approval_revocation_decision_guard
AFTER INSERT ON approval_events
FOR EACH ROW WHEN (NEW.kind='revoked')
EXECUTE FUNCTION revoke_decision_with_approval();

CREATE FUNCTION enforce_idempotency_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = grimoire, pg_temp
AS $$
BEGIN
  IF (NEW.org_id,NEW.operation,NEW.idempotency_key,NEW.request_hash)
       IS DISTINCT FROM
     (OLD.org_id,OLD.operation,OLD.idempotency_key,OLD.request_hash)
     OR (OLD.completed_at IS NOT NULL AND NEW IS DISTINCT FROM OLD)
  THEN
    RAISE EXCEPTION USING ERRCODE='G2016', MESSAGE='idempotency identity and completed response are immutable';
  END IF;
  IF OLD.completed_at IS NULL AND NEW.completed_at IS NOT NULL
     AND (NEW.response_status IS NULL OR NEW.response_body IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE='G2016', MESSAGE='completion requires the exact stored status and body';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER idempotency_update_guard
BEFORE UPDATE ON idempotency_records
FOR EACH ROW EXECUTE FUNCTION enforce_idempotency_update();

CREATE FUNCTION enforce_outbox_transition() RETURNS trigger
LANGUAGE plpgsql
SET search_path = grimoire, pg_temp
AS $$
BEGIN
  IF NOT (
    (OLD.state='pending' AND NEW.state='running' AND NEW.attempt_count=OLD.attempt_count+1)
    OR (OLD.state='running' AND OLD.lease_token=NEW.lease_token AND NEW.state IN ('pending','succeeded','dead'))
  ) THEN
    RAISE EXCEPTION USING ERRCODE='G2017', MESSAGE='invalid outbox state, attempt, or lease-token transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER outbox_transition_guard
BEFORE UPDATE ON outbox_events
FOR EACH ROW EXECUTE FUNCTION enforce_outbox_transition();

CREATE FUNCTION bump_revision_parent_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = grimoire, pg_temp
AS $$
DECLARE parent_id uuid;
BEGIN
  parent_id:=(to_jsonb(NEW)->>TG_ARGV[1])::uuid;
  EXECUTE format('UPDATE %I SET row_version=row_version+1 WHERE org_id=$1 AND id=$2',TG_ARGV[0])
    USING NEW.org_id,parent_id;
  RETURN NEW;
END $$;
CREATE TRIGGER source_revision_etag AFTER INSERT ON source_document_revisions
FOR EACH ROW EXECUTE FUNCTION bump_revision_parent_version('source_documents','source_document_id');
CREATE TRIGGER configuration_revision_etag AFTER INSERT ON product_configuration_revisions
FOR EACH ROW EXECUTE FUNCTION bump_revision_parent_version('product_configurations','configuration_id');
CREATE TRIGGER component_revision_etag AFTER INSERT ON component_revisions
FOR EACH ROW EXECUTE FUNCTION bump_revision_parent_version('components','component_id');
CREATE TRIGGER occurrence_revision_etag AFTER INSERT ON bom_occurrence_revisions
FOR EACH ROW EXECUTE FUNCTION bump_revision_parent_version('bom_occurrences','occurrence_id');
CREATE TRIGGER requirement_revision_etag AFTER INSERT ON requirement_revisions
FOR EACH ROW EXECUTE FUNCTION bump_revision_parent_version('requirements','requirement_id');
CREATE TRIGGER case_revision_etag AFTER INSERT ON sourcing_case_revisions
FOR EACH ROW EXECUTE FUNCTION bump_revision_parent_version('sourcing_cases','sourcing_case_id');
CREATE TRIGGER offer_revision_etag AFTER INSERT ON offer_revisions
FOR EACH ROW EXECUTE FUNCTION bump_revision_parent_version('supplier_offers','offer_id');
CREATE TRIGGER test_revision_etag AFTER INSERT ON qualification_test_revisions
FOR EACH ROW EXECUTE FUNCTION bump_revision_parent_version('qualification_tests','qualification_test_id');
CREATE TRIGGER packet_revision_etag AFTER INSERT ON decision_packet_revisions
FOR EACH ROW EXECUTE FUNCTION bump_revision_parent_version('decision_packets','packet_id');
CREATE TRIGGER decision_revision_etag AFTER INSERT ON decision_revisions
FOR EACH ROW EXECUTE FUNCTION bump_revision_parent_version('decisions','decision_id');

CREATE FUNCTION invalidate_source_dependents(wanted_org uuid, wanted_source uuid, dedupe text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = grimoire, pg_temp
AS $$
BEGIN
  UPDATE org_security_epochs SET access_epoch=access_epoch+1, updated_at=clock_timestamp()
  WHERE org_id=wanted_org;
  UPDATE derived_artifacts a
  SET valid=false, invalidated_at=clock_timestamp(),
      invalidation_reason='source authorization or lifecycle changed'
  WHERE a.org_id=wanted_org AND a.valid AND EXISTS (
    SELECT 1 FROM artifact_source_inputs i
    JOIN source_document_revisions r
      ON (r.org_id,r.id)=(i.org_id,i.source_revision_id)
    WHERE (i.org_id,i.artifact_id)=(a.org_id,a.id)
      AND r.source_document_id=wanted_source
  );
  INSERT INTO outbox_events(org_id,topic,aggregate_type,aggregate_id,dedupe_key,payload)
  VALUES (wanted_org,'source-policy-changed','source_document',wanted_source,dedupe,
          jsonb_build_object('sourceDocumentId',wanted_source))
  ON CONFLICT DO NOTHING;
END $$;

CREATE OR REPLACE FUNCTION bump_source_access_epoch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = grimoire, pg_temp
AS $$
BEGIN
  PERFORM invalidate_source_dependents(NEW.org_id,NEW.source_document_id,
    'source-access:'||NEW.id);
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION bump_grant_access_epoch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = grimoire, pg_temp
AS $$
DECLARE source_id uuid;
BEGIN
  SELECT source_document_id INTO STRICT source_id FROM source_grants
    WHERE (org_id,id)=(NEW.org_id,NEW.source_grant_id);
  PERFORM invalidate_source_dependents(NEW.org_id,source_id,'source-grant:'||NEW.id);
  RETURN NEW;
END $$;

CREATE FUNCTION enforce_source_lifecycle() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = grimoire, pg_temp
AS $$
BEGIN
  IF NEW.state IN ('tombstone_requested','tombstoned','retention_expired')
     AND EXISTS (
       SELECT 1 FROM source_legal_holds sh JOIN legal_holds h
         ON (h.org_id,h.id)=(sh.org_id,sh.legal_hold_id)
       WHERE (sh.org_id,sh.source_document_id)=(NEW.org_id,NEW.source_document_id)
         AND h.starts_at<=clock_timestamp() AND h.released_at IS NULL
     )
  THEN
    RAISE EXCEPTION USING ERRCODE='G2010', MESSAGE='active legal hold blocks tombstone or erasure';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER source_lifecycle_hold_guard
BEFORE INSERT ON source_lifecycle_events
FOR EACH ROW EXECUTE FUNCTION enforce_source_lifecycle();

CREATE FUNCTION invalidate_after_source_lifecycle() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = grimoire, pg_temp
AS $$
BEGIN
  PERFORM invalidate_source_dependents(NEW.org_id,NEW.source_document_id,
    'source-lifecycle:'||NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER source_lifecycle_invalidation
AFTER INSERT ON source_lifecycle_events
FOR EACH ROW WHEN (NEW.state IN ('tombstone_requested','tombstoned','retention_expired'))
EXECUTE FUNCTION invalidate_after_source_lifecycle();

CREATE FUNCTION bump_policy_epoch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = grimoire, pg_temp
AS $$
DECLARE wanted_org uuid;
BEGIN
  wanted_org:=COALESCE(NEW.org_id,OLD.org_id);
  UPDATE org_security_epochs SET access_epoch=access_epoch+1,updated_at=clock_timestamp()
  WHERE org_id=wanted_org;
  RETURN COALESCE(NEW,OLD);
END $$;
CREATE TRIGGER principal_role_policy_epoch
AFTER INSERT OR UPDATE OR DELETE ON principal_roles
FOR EACH ROW EXECUTE FUNCTION bump_policy_epoch();
CREATE TRIGGER principal_disable_policy_epoch
AFTER UPDATE OF disabled_at ON principals
FOR EACH ROW WHEN (OLD.disabled_at IS DISTINCT FROM NEW.disabled_at)
EXECUTE FUNCTION bump_policy_epoch();
CREATE TRIGGER source_hold_policy_epoch
AFTER INSERT OR DELETE ON source_legal_holds
FOR EACH ROW EXECUTE FUNCTION bump_policy_epoch();

CREATE OR REPLACE FUNCTION audit_row_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = grimoire, pg_temp
AS $$
DECLARE before_row jsonb; after_row jsonb; selected_row jsonb; req uuid; object uuid;
BEGIN
  req:=nullif(current_setting('app.request_id',true),'')::uuid;
  IF req IS NULL THEN RAISE EXCEPTION USING ERRCODE='G2006',MESSAGE='app.request_id is required'; END IF;
  before_row:=CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) END;
  after_row:=CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN to_jsonb(NEW) END;
  selected_row:=COALESCE(after_row,before_row);
  object:=COALESCE(
    nullif(selected_row->>'id','')::uuid,
    nullif(selected_row->>'decision_revision_id','')::uuid,
    nullif(selected_row->>'source_document_id','')::uuid,
    nullif(selected_row->>'artifact_id','')::uuid,
    nullif(selected_row->>'left_claim_id','')::uuid,
    nullif(selected_row->>'principal_id','')::uuid,
    (selected_row->>'org_id')::uuid
  );
  INSERT INTO audit_events(
    org_id,request_id,actor_id,action,object_type,object_id,before_hash,after_hash,metadata,
    effective_role,endpoint_scope,input_hash,decision_reason,outcome
  ) VALUES (
    (selected_row->>'org_id')::uuid,req,app.current_principal_id(),lower(TG_OP),TG_TABLE_NAME,object,
    CASE WHEN before_row IS NULL THEN NULL ELSE encode(public.digest(before_row::text,'sha256'),'hex') END,
    CASE WHEN after_row IS NULL THEN NULL ELSE encode(public.digest(after_row::text,'sha256'),'hex') END,
    jsonb_build_object('schema','grimoire','table',TG_TABLE_NAME),
    COALESCE(nullif(current_setting('app.effective_role',true),''),'migration_fixture'),
    COALESCE(nullif(current_setting('app.endpoint_scope',true),''),'migration_fixture'),
    COALESCE(nullif(current_setting('app.input_hash',true),''),repeat('0',64)),
    COALESCE(nullif(current_setting('app.action_reason',true),''),'migration fixture or legacy event'),
    COALESCE(nullif(current_setting('app.action_outcome',true),''),'committed')
  );
  RETURN COALESCE(NEW,OLD);
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'principal_roles','source_legal_holds','claim_relations','artifact_source_inputs',
    'decision_offer_inputs','decision_qualification_inputs','normalization_evidence',
    'source_erasure_actions','restore_checkpoints'
  ] LOOP
    EXECUTE format('CREATE TRIGGER %I_audit AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row_change()',t,t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['source_legal_holds','artifact_source_inputs','normalization_evidence','restore_checkpoints'] LOOP
    EXECUTE format('CREATE TRIGGER %I_append_only BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION deny_change()',t,t);
  END LOOP;
END $$;

CREATE FUNCTION app.can_read_case(wanted_case uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = grimoire, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM supplier_offers o
    JOIN offer_revisions r ON (r.org_id,r.offer_id)=(o.org_id,o.id)
    JOIN source_document_revisions sr ON (sr.org_id,sr.id)=(r.org_id,r.source_revision_id)
    WHERE (o.org_id,o.sourcing_case_id)=(app.current_org_id(),wanted_case)
      AND app.can_read_source(sr.source_document_id)
  ) OR EXISTS (
    SELECT 1 FROM decision_packets p
    JOIN decision_packet_revisions pr ON (pr.org_id,pr.packet_id)=(p.org_id,p.id)
    WHERE (p.org_id,p.sourcing_case_id)=(app.current_org_id(),wanted_case)
      AND app.can_read_artifact(pr.artifact_id)
  )
$$;

CREATE FUNCTION app.can_read_decision(wanted_revision uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = grimoire, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM decision_revisions d
    JOIN decision_packet_revisions p ON (p.org_id,p.id)=(d.org_id,d.packet_revision_id)
    WHERE (d.org_id,d.id)=(app.current_org_id(),wanted_revision)
      AND app.can_read_artifact(p.artifact_id)
  )
$$;

-- Replace organization-wide read policies on metadata that revealed hidden facts.
DROP POLICY supplier_legal_entities_tenant_select ON supplier_legal_entities;
CREATE POLICY supplier_entity_authorized_select ON supplier_legal_entities FOR SELECT USING (
  org_id=app.current_org_id() AND EXISTS (
    SELECT 1 FROM source_documents s
    WHERE (s.org_id,s.supplier_entity_id)=(supplier_legal_entities.org_id,supplier_legal_entities.id)
      AND app.can_read_source(s.id)
  )
);
DROP POLICY supplier_sites_tenant_select ON supplier_sites;
CREATE POLICY supplier_site_authorized_select ON supplier_sites FOR SELECT USING (
  org_id=app.current_org_id() AND EXISTS (
    SELECT 1 FROM supplier_legal_entities e
    WHERE (e.org_id,e.id)=(supplier_sites.org_id,supplier_sites.supplier_entity_id)
  )
);
DROP POLICY supplier_accounts_tenant_select ON supplier_accounts;
CREATE POLICY supplier_account_authorized_select ON supplier_accounts FOR SELECT USING (
  org_id=app.current_org_id() AND EXISTS (
    SELECT 1 FROM supplier_legal_entities e
    WHERE (e.org_id,e.id)=(supplier_accounts.org_id,supplier_accounts.supplier_entity_id)
  )
);
DROP POLICY supplier_offers_tenant_select ON supplier_offers;
CREATE POLICY supplier_offer_authorized_select ON supplier_offers FOR SELECT USING (
  org_id=app.current_org_id() AND app.can_read_case(sourcing_case_id)
);
DROP POLICY sourcing_cases_tenant_select ON sourcing_cases;
CREATE POLICY sourcing_case_authorized_select ON sourcing_cases FOR SELECT USING (
  org_id=app.current_org_id() AND app.can_read_case(id)
);
DROP POLICY sourcing_case_revisions_tenant_select ON sourcing_case_revisions;
CREATE POLICY sourcing_case_revision_authorized_select ON sourcing_case_revisions FOR SELECT USING (
  org_id=app.current_org_id() AND app.can_read_case(sourcing_case_id)
);
DROP POLICY decision_packets_tenant_select ON decision_packets;
CREATE POLICY decision_packet_header_authorized_select ON decision_packets FOR SELECT USING (
  org_id=app.current_org_id() AND app.can_read_case(sourcing_case_id)
);
DROP POLICY decisions_tenant_select ON decisions;
CREATE POLICY decision_header_authorized_select ON decisions FOR SELECT USING (
  org_id=app.current_org_id() AND app.can_read_case(sourcing_case_id)
);
DROP POLICY decision_approvals_tenant_select ON decision_approvals;
CREATE POLICY decision_approval_authorized_select ON decision_approvals FOR SELECT USING (
  org_id=app.current_org_id() AND app.can_read_decision(decision_revision_id)
);
DROP POLICY approval_events_tenant_select ON approval_events;
CREATE POLICY approval_event_authorized_select ON approval_events FOR SELECT USING (
  org_id=app.current_org_id() AND EXISTS (
    SELECT 1 FROM decision_approvals a
    WHERE (a.org_id,a.id)=(approval_events.org_id,approval_events.approval_id)
      AND app.can_read_decision(a.decision_revision_id)
  )
);
DROP POLICY decision_state_events_tenant_select ON decision_state_events;
CREATE POLICY decision_state_authorized_select ON decision_state_events FOR SELECT USING (
  org_id=app.current_org_id() AND app.can_read_decision(decision_revision_id)
);
DROP POLICY change_impacts_tenant_select ON change_impacts;
CREATE POLICY change_impact_authorized_select ON change_impacts FOR SELECT USING (
  org_id=app.current_org_id() AND app.can_read_decision(decision_revision_id)
);
DROP POLICY qualification_tests_tenant_select ON qualification_tests;
CREATE POLICY qualification_test_authorized_select ON qualification_tests FOR SELECT USING (
  org_id=app.current_org_id() AND EXISTS (
    SELECT 1 FROM qualification_test_revisions tr
    JOIN qualification_test_executions e ON (e.org_id,e.test_revision_id)=(tr.org_id,tr.id)
    JOIN test_result_revisions r ON (r.org_id,r.execution_id)=(e.org_id,e.id)
    JOIN source_document_revisions sr ON (sr.org_id,sr.id)=(r.org_id,r.source_revision_id)
    WHERE (tr.org_id,tr.qualification_test_id)=(qualification_tests.org_id,qualification_tests.id)
      AND app.can_read_source(sr.source_document_id)
  )
);
DROP POLICY qualification_test_revisions_tenant_select ON qualification_test_revisions;
CREATE POLICY qualification_test_revision_authorized_select ON qualification_test_revisions FOR SELECT USING (
  org_id=app.current_org_id() AND EXISTS (
    SELECT 1 FROM qualification_test_executions e
    JOIN test_result_revisions r ON (r.org_id,r.execution_id)=(e.org_id,e.id)
    JOIN source_document_revisions sr ON (sr.org_id,sr.id)=(r.org_id,r.source_revision_id)
    WHERE (e.org_id,e.test_revision_id)=(qualification_test_revisions.org_id,qualification_test_revisions.id)
      AND app.can_read_source(sr.source_document_id)
  )
);
DROP POLICY qualification_test_executions_tenant_select ON qualification_test_executions;
CREATE POLICY qualification_execution_authorized_select ON qualification_test_executions FOR SELECT USING (
  org_id=app.current_org_id() AND EXISTS (
    SELECT 1 FROM test_result_revisions r JOIN source_document_revisions sr
      ON (sr.org_id,sr.id)=(r.org_id,r.source_revision_id)
    WHERE (r.org_id,r.execution_id)=(qualification_test_executions.org_id,qualification_test_executions.id)
      AND app.can_read_source(sr.source_document_id)
  )
);
DROP POLICY source_legal_holds_tenant_select ON source_legal_holds;
CREATE POLICY source_legal_holds_admin_select ON source_legal_holds FOR SELECT USING (
  org_id=app.current_org_id() AND (app.has_role('records_officer') OR app.has_role('org_admin'))
);
DROP POLICY audit_events_tenant_select ON audit_events;
CREATE POLICY audit_admin_select ON audit_events FOR SELECT USING (
  org_id=app.current_org_id() AND (app.has_role('records_officer') OR app.has_role('org_admin'))
);
DROP POLICY outbox_events_tenant_select ON outbox_events;
CREATE POLICY outbox_worker_select ON outbox_events FOR SELECT USING (
  org_id=app.current_org_id() AND app.has_role('system_worker')
);
CREATE POLICY derived_artifacts_worker_select ON derived_artifacts FOR SELECT USING (
  org_id=app.current_org_id() AND app.has_role('system_worker')
);
CREATE POLICY artifact_inputs_worker_select ON artifact_source_inputs FOR SELECT USING (
  org_id=app.current_org_id() AND app.has_role('system_worker')
);

-- The API can execute the fixed-scope writes under RLS; it cannot change schema,
-- audit rows, worker leases, or immutable history. Guards above are the final gate.
GRANT INSERT ON
  source_documents,source_document_revisions,source_access_events,source_grants,
  source_grant_revocations,source_legal_holds,source_lifecycle_events,claims,claim_relations,
  qualification_tests,qualification_test_revisions,qualification_test_executions,
  test_result_revisions,test_result_reviews,supplier_offers,offer_revisions,offer_lines,
  offer_line_identity_assessments,derived_artifacts,artifact_source_inputs,
  normalization_evidence,comparison_revisions,normalized_comparison_lines,
  decision_packets,decision_packet_revisions,decisions,decision_revisions,
  decision_offer_inputs,decision_qualification_inputs,decision_approvals,approval_events,
  decision_state_events,idempotency_records
TO grimoire_app;
GRANT UPDATE ON idempotency_records TO grimoire_app;
GRANT SELECT,UPDATE ON outbox_events TO grimoire_worker;
GRANT SELECT,UPDATE ON derived_artifacts TO grimoire_worker;
GRANT SELECT ON artifact_source_inputs TO grimoire_worker;
GRANT SELECT,INSERT,UPDATE ON source_erasure_actions TO grimoire_worker;
REVOKE SELECT ON principals,principal_roles,audit_events,outbox_events FROM grimoire_app;
GRANT EXECUTE ON FUNCTION
  app.can_read_case(uuid),app.can_read_decision(uuid),assert_decision_complete(uuid,uuid)
TO grimoire_app,grimoire_worker;

CREATE VIEW graph_projection_nodes_v1_1
WITH (security_barrier=true,security_invoker=true) AS
SELECT c.org_id,'sourcing_case_revision'::text AS node_type,c.id AS internal_id,
       c.revision_no,c.recorded_at,NULL::timestamptz AS effective_at,
       'current'::text AS currentness,
       encode(public.digest(to_jsonb(c)::text,'sha256'),'hex') AS content_hash,
       ARRAY[]::uuid[] AS source_revision_ids,
       jsonb_build_object('configurationRevisionId',c.configuration_revision_id,
                          'occurrenceRevisionId',c.occurrence_revision_id,
                          'componentRevisionId',c.component_revision_id,
                          'requirementRevisionId',c.requirement_revision_id) AS attributes
FROM sourcing_case_revisions c WHERE app.can_read_case(c.sourcing_case_id)
UNION ALL
SELECT r.org_id,'offer_revision',r.id,r.revision_no,r.recorded_at,r.quoted_at,'current',
       r.content_hash,ARRAY[r.source_revision_id],
       jsonb_build_object('offerId',r.offer_id,'currency',r.currency,'destination',r.destination)
FROM offer_revisions r JOIN supplier_offers o ON (o.org_id,o.id)=(r.org_id,r.offer_id)
WHERE app.can_read_case(o.sourcing_case_id)
UNION ALL
SELECT r.org_id,'test_result_revision',r.id,r.revision_no,r.recorded_at,r.effective_at,
       CASE WHEN EXISTS (SELECT 1 FROM test_result_revisions n
                         WHERE (n.org_id,n.execution_id)=(r.org_id,r.execution_id)
                           AND n.revision_no>r.revision_no) THEN 'superseded' ELSE 'current' END,
       r.content_hash,ARRAY[r.source_revision_id],
       jsonb_build_object('executionId',r.execution_id,'outcome',r.outcome)
FROM test_result_revisions r
WHERE EXISTS (SELECT 1 FROM source_document_revisions sr
              WHERE (sr.org_id,sr.id)=(r.org_id,r.source_revision_id)
                AND app.can_read_source(sr.source_document_id))
UNION ALL
SELECT c.org_id,'comparison_revision',c.id,c.revision_no,c.recorded_at,c.as_of,
       CASE WHEN a.valid THEN 'current' ELSE 'revoked' END,
       a.content_hash,array_agg(i.source_revision_id ORDER BY i.source_revision_id),
       jsonb_build_object('caseRevisionId',c.sourcing_case_revision_id,
                          'requirementRevisionId',c.requirement_revision_id,
                          'artifactId',c.artifact_id)
FROM comparison_revisions c JOIN derived_artifacts a ON (a.org_id,a.id)=(c.org_id,c.artifact_id)
JOIN artifact_source_inputs i ON (i.org_id,i.artifact_id)=(a.org_id,a.id)
WHERE app.can_read_artifact(a.id)
GROUP BY c.org_id,c.id,c.revision_no,c.recorded_at,c.as_of,a.valid,a.content_hash,c.sourcing_case_revision_id,c.requirement_revision_id,c.artifact_id
UNION ALL
SELECT p.org_id,'decision_packet_revision',p.id,p.revision_no,p.recorded_at,NULL::timestamptz,
       CASE WHEN a.valid THEN 'current' ELSE 'revoked' END,
       p.content_hash,array_agg(i.source_revision_id ORDER BY i.source_revision_id),
       jsonb_build_object('caseRevisionId',p.case_revision_id,
                          'comparisonRevisionId',p.comparison_revision_id,
                          'artifactId',p.artifact_id)
FROM decision_packet_revisions p JOIN derived_artifacts a ON (a.org_id,a.id)=(p.org_id,p.artifact_id)
JOIN artifact_source_inputs i ON (i.org_id,i.artifact_id)=(a.org_id,a.id)
WHERE app.can_read_artifact(a.id)
GROUP BY p.org_id,p.id,p.revision_no,p.recorded_at,a.valid,p.content_hash,p.case_revision_id,p.comparison_revision_id,p.artifact_id
UNION ALL
SELECT d.org_id,'decision_revision',d.id,d.revision_no,d.recorded_at,NULL::timestamptz,
       COALESCE(s.state::text,'current'),d.content_hash,
       ARRAY[]::uuid[],jsonb_build_object('caseRevisionId',d.case_revision_id,
                                           'packetRevisionId',d.packet_revision_id,
                                           'selectedOfferRevisionId',d.selected_offer_revision_id)
FROM decision_revisions d LEFT JOIN current_decision_state s
  ON (s.org_id,s.decision_revision_id)=(d.org_id,d.id)
WHERE app.can_read_decision(d.id);

CREATE VIEW graph_projection_edges_v1_1
WITH (security_barrier=true,security_invoker=true) AS
WITH raw_edges AS (
  SELECT d.org_id,'DECISION_USES_PACKET'::text AS edge_type,d.id AS from_id,
         d.packet_revision_id AS to_id,d.revision_no AS edge_revision,
         COALESCE(s.state::text,'current') AS currentness
  FROM decision_revisions d LEFT JOIN current_decision_state s
    ON (s.org_id,s.decision_revision_id)=(d.org_id,d.id)
  UNION ALL
  SELECT d.org_id,'DECISION_SELECTS_OFFER',d.id,d.selected_offer_revision_id,d.revision_no,
         COALESCE(s.state::text,'current')
  FROM decision_revisions d LEFT JOIN current_decision_state s
    ON (s.org_id,s.decision_revision_id)=(d.org_id,d.id)
  UNION ALL
  SELECT p.org_id,'PACKET_USES_COMPARISON',p.id,p.comparison_revision_id,p.revision_no,'current'
  FROM decision_packet_revisions p
  UNION ALL
  SELECT d.org_id,'REVISION_SUPERSEDES',d.id,d.supersedes_decision_revision_id,d.revision_no,'current'
  FROM decision_revisions d WHERE d.supersedes_decision_revision_id IS NOT NULL
)
SELECT e.* FROM raw_edges e
JOIN graph_projection_nodes_v1_1 f ON (f.org_id,f.internal_id)=(e.org_id,e.from_id)
JOIN graph_projection_nodes_v1_1 t ON (t.org_id,t.internal_id)=(e.org_id,e.to_id);

GRANT SELECT ON graph_projection_nodes_v1_1,graph_projection_edges_v1_1 TO grimoire_app;

COMMIT;
