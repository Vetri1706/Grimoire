-- GG-46: require an immutable, exact-scope human-authority review before a
-- canonical sourcing decision revision can be recorded.  This migration does
-- not approve a decision, contact a supplier, or permit an external write.
BEGIN;
SET search_path = pg_catalog, grimoire, pg_temp;

CREATE TABLE grimoire.sourcing_authority_reviews (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  comparison_revision_id uuid NOT NULL,
  sourcing_case_revision_id uuid NOT NULL,
  requirement_revision_id uuid NOT NULL,
  selected_offer_revision_id uuid NOT NULL,
  selected_offer_line_id uuid NOT NULL,
  reviewer_id uuid NOT NULL,
  rationale text NOT NULL CHECK (length(btrim(rationale)) BETWEEN 1 AND 2000),
  synthetic boolean NOT NULL CHECK (synthetic),
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, idempotency_key),
  FOREIGN KEY (org_id, comparison_revision_id)
    REFERENCES grimoire.comparison_revisions(org_id, id),
  FOREIGN KEY (org_id, sourcing_case_revision_id)
    REFERENCES grimoire.sourcing_case_revisions(org_id, id),
  FOREIGN KEY (org_id, requirement_revision_id)
    REFERENCES grimoire.requirement_revisions(org_id, id),
  FOREIGN KEY (org_id, selected_offer_revision_id)
    REFERENCES grimoire.offer_revisions(org_id, id),
  FOREIGN KEY (org_id, selected_offer_line_id)
    REFERENCES grimoire.offer_lines(org_id, id),
  FOREIGN KEY (org_id, reviewer_id)
    REFERENCES grimoire.principals(org_id, id)
);

CREATE TABLE grimoire.synthetic_decision_receipts (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  authority_review_id uuid NOT NULL,
  decision_id uuid NOT NULL,
  decision_revision_id uuid NOT NULL,
  decision_state_event_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, idempotency_key),
  UNIQUE (org_id, decision_revision_id),
  FOREIGN KEY (org_id, authority_review_id)
    REFERENCES grimoire.sourcing_authority_reviews(org_id, id),
  FOREIGN KEY (org_id, decision_id)
    REFERENCES grimoire.decisions(org_id, id),
  FOREIGN KEY (org_id, decision_revision_id)
    REFERENCES grimoire.decision_revisions(org_id, id),
  FOREIGN KEY (org_id, decision_state_event_id)
    REFERENCES grimoire.decision_state_events(org_id, id)
);

COMMENT ON TABLE grimoire.sourcing_authority_reviews IS
  'Synthetic software-test review gate for GG-46. A record is not a sourcing approval or evidence of reviewer qualification.';
COMMENT ON TABLE grimoire.synthetic_decision_receipts IS
  'Idempotency receipts for synthetic draft decision creation. Draft is not submitted or approved.';

CREATE FUNCTION app.sourcing_authority_assert_current(
  wanted_comparison uuid,
  wanted_case_revision uuid,
  wanted_requirement_revision uuid,
  wanted_offer_revision uuid,
  wanted_offer_line uuid
) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, grimoire, pg_temp
SET row_security = off
AS $$
DECLARE
  org uuid := app.current_org_id();
  comparison grimoire.comparison_revisions%ROWTYPE;
  offer grimoire.offer_revisions%ROWTYPE;
  source_document uuid;
BEGIN
  SELECT c.* INTO comparison
  FROM grimoire.comparison_revisions c
  JOIN grimoire.derived_artifacts a
    ON (a.org_id, a.id) = (c.org_id, c.artifact_id)
  WHERE (c.org_id, c.id) = (org, wanted_comparison);
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'G3304', MESSAGE = 'decision inputs unavailable';
  END IF;
  IF comparison.sourcing_case_revision_id <> wanted_case_revision
     OR comparison.requirement_revision_id <> wanted_requirement_revision
     OR NOT EXISTS (
       SELECT 1 FROM grimoire.derived_artifacts a
       WHERE (a.org_id, a.id) = (comparison.org_id, comparison.artifact_id)
         AND a.valid
     )
  THEN
    RAISE EXCEPTION USING ERRCODE = 'G3305', MESSAGE = 'scope revision stale';
  END IF;

  SELECT r.* INTO offer
  FROM grimoire.offer_revisions r
  JOIN grimoire.offer_lines l
    ON (l.org_id, l.offer_revision_id, l.id) = (r.org_id, r.id, wanted_offer_line)
  JOIN grimoire.normalized_comparison_lines n
    ON (n.org_id, n.comparison_revision_id, n.offer_line_id, n.state) =
       (r.org_id, wanted_comparison, l.id, 'comparable')
  WHERE (r.org_id, r.id) = (org, wanted_offer_revision);
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'G3304', MESSAGE = 'decision inputs unavailable';
  END IF;

  IF EXISTS (
    SELECT 1 FROM grimoire.offer_revisions later
    WHERE (later.org_id, later.offer_id) = (offer.org_id, offer.offer_id)
      AND later.revision_no > offer.revision_no
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'G3305', MESSAGE = 'offer or source revision stale';
  END IF;

  SELECT sr.source_document_id INTO STRICT source_document
  FROM grimoire.source_document_revisions sr
  WHERE (sr.org_id, sr.id) = (offer.org_id, offer.source_revision_id);
  IF NOT app.can_read_source(source_document) THEN
    RAISE EXCEPTION USING ERRCODE = 'G3305', MESSAGE = 'offer source is not currently authorized';
  END IF;
END $$;

CREATE FUNCTION app.record_synthetic_sourcing_authority_review(
  wanted_review uuid,
  wanted_comparison uuid,
  wanted_case_revision uuid,
  wanted_requirement_revision uuid,
  wanted_offer_revision uuid,
  wanted_offer_line uuid,
  wanted_rationale text,
  wanted_idempotency_key text,
  wanted_synthetic boolean
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, grimoire, pg_temp
SET row_security = off
AS $$
DECLARE
  org uuid := app.current_org_id();
  actor uuid := app.current_principal_id();
  comparison_author uuid;
  normalization_reviewer uuid;
  request_hash text;
  prior grimoire.sourcing_authority_reviews%ROWTYPE;
BEGIN
  IF org IS NULL OR actor IS NULL OR wanted_synthetic IS DISTINCT FROM true
     OR length(btrim(wanted_rationale)) NOT BETWEEN 1 AND 2000
     OR length(btrim(wanted_idempotency_key)) NOT BETWEEN 1 AND 200
     OR NOT EXISTS (
       SELECT 1 FROM grimoire.principal_roles role
       JOIN grimoire.principals principal
         ON (principal.org_id, principal.id) = (role.org_id, role.principal_id)
       WHERE (role.org_id, role.principal_id, role.role) =
             (org, actor, 'commercial_approver'::grimoire.actor_role)
         AND principal.disabled_at IS NULL
     )
     OR EXISTS (
       SELECT 1 FROM grimoire.principal_roles role
       WHERE (role.org_id, role.principal_id) = (org, actor)
         AND role.role IN ('read_only_agent', 'system_worker')
     )
  THEN
    RAISE EXCEPTION USING ERRCODE = 'G3302', MESSAGE = 'distinct enabled human sourcing authority required';
  END IF;

  PERFORM app.sourcing_authority_assert_current(
    wanted_comparison, wanted_case_revision, wanted_requirement_revision,
    wanted_offer_revision, wanted_offer_line
  );
  SELECT c.created_by, n.reviewed_by
    INTO STRICT comparison_author, normalization_reviewer
  FROM grimoire.comparison_revisions c
  JOIN grimoire.normalized_comparison_lines n
    ON (n.org_id, n.comparison_revision_id, n.offer_line_id) =
       (c.org_id, c.id, wanted_offer_line)
  WHERE (c.org_id, c.id) = (org, wanted_comparison);
  IF actor IN (comparison_author, normalization_reviewer) THEN
    RAISE EXCEPTION USING ERRCODE = 'G3302', MESSAGE = 'distinct enabled human sourcing authority required';
  END IF;

  request_hash := encode(public.digest(concat_ws('|',
    wanted_review::text, wanted_comparison::text, wanted_case_revision::text,
    wanted_requirement_revision::text, wanted_offer_revision::text,
    wanted_offer_line::text, wanted_rationale, wanted_synthetic::text
  ), 'sha256'), 'hex');
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(org::text || ':' || wanted_idempotency_key, 0)
  );
  SELECT * INTO prior FROM grimoire.sourcing_authority_reviews
  WHERE (org_id, idempotency_key) = (org, wanted_idempotency_key);
  IF FOUND THEN
    IF prior.request_hash IS DISTINCT FROM request_hash THEN
      RAISE EXCEPTION USING ERRCODE = 'G3303', MESSAGE = 'idempotency key reused with different authority review';
    END IF;
    RETURN prior.id;
  END IF;

  INSERT INTO grimoire.sourcing_authority_reviews(
    id, org_id, comparison_revision_id, sourcing_case_revision_id,
    requirement_revision_id, selected_offer_revision_id, selected_offer_line_id,
    reviewer_id, rationale, synthetic, idempotency_key, request_hash
  ) VALUES (
    wanted_review, org, wanted_comparison, wanted_case_revision,
    wanted_requirement_revision, wanted_offer_revision, wanted_offer_line,
    actor, wanted_rationale, true, wanted_idempotency_key, request_hash
  );
  RETURN wanted_review;
END $$;

CREATE FUNCTION grimoire.enforce_sourcing_authority_before_decision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, grimoire, pg_temp
SET row_security = off
AS $$
DECLARE has_gate_review boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM grimoire.sourcing_authority_reviews review
    JOIN grimoire.principals reviewer
      ON (reviewer.org_id, reviewer.id) = (review.org_id, review.reviewer_id)
    JOIN grimoire.principal_roles role
      ON (role.org_id, role.principal_id, role.role) =
         (review.org_id, review.reviewer_id, 'commercial_approver'::grimoire.actor_role)
    JOIN grimoire.comparison_revisions comparison
      ON (comparison.org_id, comparison.id) = (review.org_id, review.comparison_revision_id)
    JOIN grimoire.normalized_comparison_lines line
      ON (line.org_id, line.comparison_revision_id, line.offer_line_id, line.state) =
         (review.org_id, review.comparison_revision_id, review.selected_offer_line_id, 'comparable')
    WHERE (review.org_id, review.comparison_revision_id,
           review.sourcing_case_revision_id, review.requirement_revision_id,
           review.selected_offer_revision_id, review.selected_offer_line_id) =
          (NEW.org_id, NEW.comparison_revision_id, NEW.case_revision_id,
           NEW.requirement_revision_id, NEW.selected_offer_revision_id,
           NEW.selected_offer_line_id)
      AND review.synthetic
      AND reviewer.disabled_at IS NULL
      AND review.reviewer_id <> NEW.prepared_by
      AND review.reviewer_id <> comparison.created_by
      AND review.reviewer_id <> line.reviewed_by
      AND NOT EXISTS (
        SELECT 1 FROM grimoire.principal_roles forbidden
        WHERE (forbidden.org_id, forbidden.principal_id) =
              (review.org_id, review.reviewer_id)
          AND forbidden.role IN ('read_only_agent', 'system_worker')
      )
  ) INTO has_gate_review;
  IF NOT has_gate_review AND NOT EXISTS (
    -- The unchanged GG-40 rollback fixture creates its decision and all three
    -- domain approvals in one transaction.  A deferred constraint may accept
    -- that stronger, fully granted authority chain at commit; an agent or QA
    -- record alone never satisfies it.
    SELECT 1
    FROM grimoire.decision_approvals approval
    JOIN grimoire.approval_events event
      ON (event.org_id, event.approval_id, event.kind) =
         (approval.org_id, approval.id, 'granted')
    JOIN grimoire.principals approver
      ON (approver.org_id, approver.id) = (approval.org_id, approval.approver_id)
    JOIN grimoire.principal_roles role
      ON (role.org_id, role.principal_id, role.role) =
         (approval.org_id, approval.approver_id, 'commercial_approver'::grimoire.actor_role)
    WHERE (approval.org_id, approval.decision_revision_id, approval.domain) =
          (NEW.org_id, NEW.id, 'commercial')
      AND approval.approver_id <> NEW.prepared_by
      AND approver.disabled_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM grimoire.approval_events revoked
        WHERE (revoked.org_id, revoked.approval_id, revoked.kind) =
              (approval.org_id, approval.id, 'revoked')
      )
      AND NOT EXISTS (
        SELECT 1 FROM grimoire.principal_roles forbidden
        WHERE (forbidden.org_id, forbidden.principal_id) =
              (approval.org_id, approval.approver_id)
          AND forbidden.role IN ('read_only_agent', 'system_worker')
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'G3301', MESSAGE = 'matching independent human-authority review required before decision write';
  END IF;
  IF has_gate_review THEN
    PERFORM app.sourcing_authority_assert_current(
      NEW.comparison_revision_id, NEW.case_revision_id,
      NEW.requirement_revision_id, NEW.selected_offer_revision_id,
      NEW.selected_offer_line_id
    );
  END IF;
  RETURN NEW;
END $$;

CREATE CONSTRAINT TRIGGER decision_revision_sourcing_authority_guard
AFTER INSERT ON grimoire.decision_revisions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION grimoire.enforce_sourcing_authority_before_decision();

CREATE FUNCTION app.create_synthetic_draft_decision(
  wanted_receipt uuid,
  wanted_decision uuid,
  wanted_decision_revision uuid,
  wanted_state_event uuid,
  wanted_decision_code text,
  wanted_packet_revision uuid,
  wanted_comparison uuid,
  wanted_case_revision uuid,
  wanted_requirement_revision uuid,
  wanted_offer_revision uuid,
  wanted_offer_line uuid,
  wanted_authority_review uuid,
  wanted_rationale text,
  wanted_idempotency_key text,
  wanted_synthetic boolean
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, grimoire, pg_temp
SET row_security = off
AS $$
DECLARE
  org uuid := app.current_org_id();
  actor uuid := app.current_principal_id();
  sourcing_case uuid;
  request_hash text;
  prior grimoire.synthetic_decision_receipts%ROWTYPE;
BEGIN
  IF org IS NULL OR actor IS NULL OR wanted_synthetic IS DISTINCT FROM true
     OR length(btrim(wanted_decision_code)) NOT BETWEEN 1 AND 200
     OR length(btrim(wanted_rationale)) NOT BETWEEN 1 AND 2000
     OR length(btrim(wanted_idempotency_key)) NOT BETWEEN 1 AND 200
     OR NOT EXISTS (
       SELECT 1 FROM grimoire.principal_roles role
       JOIN grimoire.principals principal
         ON (principal.org_id, principal.id) = (role.org_id, role.principal_id)
       WHERE (role.org_id, role.principal_id, role.role) =
             (org, actor, 'procurement_preparer'::grimoire.actor_role)
         AND principal.disabled_at IS NULL
     )
     OR EXISTS (
       SELECT 1 FROM grimoire.principal_roles role
       WHERE (role.org_id, role.principal_id) = (org, actor)
         AND role.role IN ('read_only_agent', 'system_worker')
     )
  THEN
    RAISE EXCEPTION USING ERRCODE = 'G3302', MESSAGE = 'authorized human decision preparer required';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM grimoire.sourcing_authority_reviews review
    WHERE (review.org_id, review.id, review.comparison_revision_id,
           review.sourcing_case_revision_id, review.requirement_revision_id,
           review.selected_offer_revision_id, review.selected_offer_line_id) =
          (org, wanted_authority_review, wanted_comparison,
           wanted_case_revision, wanted_requirement_revision,
           wanted_offer_revision, wanted_offer_line)
      AND review.reviewer_id <> actor
      AND review.synthetic
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'G3301', MESSAGE = 'matching independent human-authority review required before decision write';
  END IF;
  PERFORM app.sourcing_authority_assert_current(
    wanted_comparison, wanted_case_revision, wanted_requirement_revision,
    wanted_offer_revision, wanted_offer_line
  );
  SELECT c.sourcing_case_id INTO STRICT sourcing_case
  FROM grimoire.sourcing_case_revisions c
  WHERE (c.org_id, c.id) = (org, wanted_case_revision);
  IF NOT EXISTS (
    SELECT 1 FROM grimoire.decision_packet_revisions packet
    WHERE (packet.org_id, packet.id, packet.case_revision_id,
           packet.requirement_revision_id, packet.comparison_revision_id) =
          (org, wanted_packet_revision, wanted_case_revision,
           wanted_requirement_revision, wanted_comparison)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'G3304', MESSAGE = 'decision inputs unavailable';
  END IF;

  request_hash := encode(public.digest(concat_ws('|',
    wanted_receipt::text, wanted_decision::text, wanted_decision_revision::text,
    wanted_state_event::text, wanted_decision_code, wanted_packet_revision::text,
    wanted_comparison::text, wanted_case_revision::text,
    wanted_requirement_revision::text, wanted_offer_revision::text,
    wanted_offer_line::text, wanted_authority_review::text,
    wanted_rationale, wanted_synthetic::text
  ), 'sha256'), 'hex');
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(org::text || ':' || wanted_idempotency_key, 0)
  );
  SELECT * INTO prior FROM grimoire.synthetic_decision_receipts
  WHERE (org_id, idempotency_key) = (org, wanted_idempotency_key);
  IF FOUND THEN
    IF prior.request_hash IS DISTINCT FROM request_hash THEN
      RAISE EXCEPTION USING ERRCODE = 'G3303', MESSAGE = 'idempotency key reused with different decision input';
    END IF;
    RETURN prior.decision_revision_id;
  END IF;

  INSERT INTO grimoire.decisions(id, org_id, sourcing_case_id, decision_code)
  VALUES (wanted_decision, org, sourcing_case, wanted_decision_code);
  INSERT INTO grimoire.decision_revisions(
    id, org_id, decision_id, revision_no, case_revision_id,
    requirement_revision_id, comparison_revision_id, packet_revision_id,
    selected_offer_revision_id, selected_offer_line_id, rationale,
    content_hash, prepared_by
  ) VALUES (
    wanted_decision_revision, org, wanted_decision, 1, wanted_case_revision,
    wanted_requirement_revision, wanted_comparison, wanted_packet_revision,
    wanted_offer_revision, wanted_offer_line, wanted_rationale,
    request_hash, actor
  );
  INSERT INTO grimoire.decision_offer_inputs(
    org_id, decision_revision_id, offer_revision_id, offer_line_id
  )
  SELECT org, wanted_decision_revision, line.offer_revision_id, line.id
  FROM grimoire.normalized_comparison_lines normalized
  JOIN grimoire.offer_lines line
    ON (line.org_id, line.id) = (normalized.org_id, normalized.offer_line_id)
  WHERE (normalized.org_id, normalized.comparison_revision_id, normalized.state) =
        (org, wanted_comparison, 'comparable');
  INSERT INTO grimoire.decision_state_events(
    id, org_id, decision_revision_id, state, actor_id, reason, idempotency_key
  ) VALUES (
    wanted_state_event, org, wanted_decision_revision, 'draft', actor,
    'Synthetic software-behavior fixture; not submitted or approved',
    'synthetic-draft:' || wanted_idempotency_key
  );
  INSERT INTO grimoire.synthetic_decision_receipts(
    id, org_id, idempotency_key, request_hash, authority_review_id,
    decision_id, decision_revision_id, decision_state_event_id
  ) VALUES (
    wanted_receipt, org, wanted_idempotency_key, request_hash,
    wanted_authority_review, wanted_decision, wanted_decision_revision,
    wanted_state_event
  );
  RETURN wanted_decision_revision;
END $$;

ALTER TABLE grimoire.sourcing_authority_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE grimoire.synthetic_decision_receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY sourcing_authority_review_org_read
ON grimoire.sourcing_authority_reviews FOR SELECT TO grimoire_intake_app
USING (org_id = app.current_org_id() AND app.intake_can_access());
CREATE POLICY synthetic_decision_receipt_org_read
ON grimoire.synthetic_decision_receipts FOR SELECT TO grimoire_intake_app
USING (org_id = app.current_org_id() AND app.intake_can_access());
REVOKE ALL ON grimoire.sourcing_authority_reviews,
  grimoire.synthetic_decision_receipts FROM PUBLIC;
GRANT SELECT ON grimoire.sourcing_authority_reviews,
  grimoire.synthetic_decision_receipts TO grimoire_intake_app;

CREATE TRIGGER sourcing_authority_reviews_immutable
BEFORE UPDATE OR DELETE ON grimoire.sourcing_authority_reviews
FOR EACH ROW EXECUTE FUNCTION grimoire.deny_change();
CREATE TRIGGER synthetic_decision_receipts_immutable
BEFORE UPDATE OR DELETE ON grimoire.synthetic_decision_receipts
FOR EACH ROW EXECUTE FUNCTION grimoire.deny_change();
CREATE TRIGGER sourcing_authority_reviews_audit
AFTER INSERT ON grimoire.sourcing_authority_reviews
FOR EACH ROW EXECUTE FUNCTION grimoire.audit_row_change();
CREATE TRIGGER synthetic_decision_receipts_audit
AFTER INSERT ON grimoire.synthetic_decision_receipts
FOR EACH ROW EXECUTE FUNCTION grimoire.audit_row_change();

REVOKE ALL ON FUNCTION
  app.sourcing_authority_assert_current(uuid,uuid,uuid,uuid,uuid),
  app.record_synthetic_sourcing_authority_review(uuid,uuid,uuid,uuid,uuid,uuid,text,text,boolean),
  app.create_synthetic_draft_decision(uuid,uuid,uuid,uuid,text,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,boolean),
  grimoire.enforce_sourcing_authority_before_decision()
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  app.record_synthetic_sourcing_authority_review(uuid,uuid,uuid,uuid,uuid,uuid,text,text,boolean),
  app.create_synthetic_draft_decision(uuid,uuid,uuid,uuid,text,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,boolean)
TO grimoire_intake_app;

COMMIT;
