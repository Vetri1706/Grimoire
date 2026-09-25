BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE SCHEMA IF NOT EXISTS grimoire;
CREATE SCHEMA IF NOT EXISTS app;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grimoire_app') THEN
    CREATE ROLE grimoire_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grimoire_worker') THEN
    CREATE ROLE grimoire_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END $$;

SET search_path = grimoire, public;

CREATE DOMAIN currency_code AS text
  CHECK (VALUE ~ '^[A-Z]{3}$');
CREATE DOMAIN positive_decimal AS numeric(24,8)
  CHECK (VALUE > 0);
CREATE DOMAIN sha256_hex AS text
  CHECK (VALUE ~ '^[0-9a-f]{64}$');
CREATE DOMAIN nonempty_text AS text
  CHECK (length(btrim(VALUE)) > 0);

CREATE TYPE actor_role AS ENUM (
  'org_admin', 'procurement_preparer', 'engineering_reviewer',
  'quality_reviewer', 'commercial_approver', 'records_officer',
  'read_only_agent', 'system_worker'
);
CREATE TYPE authority_kind AS ENUM (
  'source_claim', 'extraction', 'inference', 'proposal', 'approved_fact'
);
CREATE TYPE source_access_state AS ENUM ('authorized', 'revoked', 'expired');
CREATE TYPE source_lifecycle_state AS ENUM (
  'active', 'tombstone_requested', 'tombstoned', 'retention_expired'
);
CREATE TYPE review_state AS ENUM ('pending', 'accepted', 'rejected');
CREATE TYPE identity_match_state AS ENUM ('exact_match', 'substitution', 'ambiguous');
CREATE TYPE comparison_line_state AS ENUM ('comparable', 'excluded');
CREATE TYPE qualification_outcome AS ENUM ('pass', 'fail', 'inconclusive');
CREATE TYPE decision_state AS ENUM (
  'draft', 'submitted', 'approved', 'stale', 'superseded', 'revoked', 'reopened'
);
CREATE TYPE approval_domain AS ENUM ('engineering', 'quality', 'commercial');
CREATE TYPE approval_event_kind AS ENUM ('granted', 'revoked');
CREATE TYPE artifact_kind AS ENUM ('comparison', 'decision_packet', 'graph_export');
CREATE TYPE claim_relation_kind AS ENUM ('conflicts_with', 'supports', 'supersedes');
CREATE TYPE job_state AS ENUM ('pending', 'running', 'succeeded', 'dead');

CREATE FUNCTION app.current_org_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT nullif(current_setting('app.current_org_id', true), '')::uuid $$;

CREATE FUNCTION app.current_principal_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT nullif(current_setting('app.current_principal_id', true), '')::uuid $$;

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name nonempty_text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, name)
);

CREATE TABLE principals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  external_subject nonempty_text NOT NULL,
  display_name nonempty_text NOT NULL,
  disabled_at timestamptz,
  UNIQUE (org_id, id),
  UNIQUE (org_id, external_subject)
);

CREATE TABLE principal_roles (
  org_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  role actor_role NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, principal_id, role),
  FOREIGN KEY (org_id, principal_id) REFERENCES principals(org_id, id)
);

CREATE FUNCTION app.has_role(wanted actor_role) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = grimoire, pg_temp
SET row_security = off
AS $$
  SELECT EXISTS (
    SELECT 1 FROM principal_roles pr
    JOIN principals p ON (p.org_id, p.id) = (pr.org_id, pr.principal_id)
    WHERE pr.org_id = app.current_org_id()
      AND pr.principal_id = app.current_principal_id()
      AND pr.role = wanted AND p.disabled_at IS NULL
  )
$$;

CREATE TABLE org_security_epochs (
  org_id uuid PRIMARY KEY REFERENCES organizations(id),
  access_epoch bigint NOT NULL DEFAULT 1 CHECK (access_epoch > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  product_code nonempty_text NOT NULL,
  name nonempty_text NOT NULL,
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  UNIQUE (org_id, id), UNIQUE (org_id, product_code)
);

CREATE TABLE product_configurations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  product_id uuid NOT NULL,
  configuration_code nonempty_text NOT NULL,
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  UNIQUE (org_id, id), UNIQUE (org_id, product_id, configuration_code),
  FOREIGN KEY (org_id, product_id) REFERENCES products(org_id, id)
);

CREATE TABLE product_configuration_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  configuration_id uuid NOT NULL,
  revision_no integer NOT NULL CHECK (revision_no > 0),
  effective_during tstzrange NOT NULL CHECK (NOT isempty(effective_during)),
  specification jsonb NOT NULL CHECK (jsonb_typeof(specification) = 'object'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by uuid NOT NULL,
  UNIQUE (org_id, id), UNIQUE (org_id, configuration_id, revision_no),
  FOREIGN KEY (org_id, configuration_id) REFERENCES product_configurations(org_id, id),
  FOREIGN KEY (org_id, created_by) REFERENCES principals(org_id, id),
  EXCLUDE USING gist (
    org_id WITH =, configuration_id WITH =, effective_during WITH &&
  )
);

CREATE TABLE components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  internal_part_code nonempty_text NOT NULL,
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  UNIQUE (org_id, id), UNIQUE (org_id, internal_part_code)
);

CREATE TABLE component_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  component_id uuid NOT NULL,
  revision_no integer NOT NULL CHECK (revision_no > 0),
  approved_manufacturer nonempty_text NOT NULL,
  approved_part_number nonempty_text NOT NULL,
  attributes jsonb NOT NULL CHECK (jsonb_typeof(attributes) = 'object'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by uuid NOT NULL,
  UNIQUE (org_id, id), UNIQUE (org_id, component_id, revision_no),
  UNIQUE (org_id, component_id, approved_manufacturer, approved_part_number, revision_no),
  FOREIGN KEY (org_id, component_id) REFERENCES components(org_id, id),
  FOREIGN KEY (org_id, created_by) REFERENCES principals(org_id, id)
);

CREATE TABLE bom_occurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  configuration_id uuid NOT NULL,
  occurrence_path nonempty_text NOT NULL,
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  UNIQUE (org_id, id), UNIQUE (org_id, configuration_id, occurrence_path),
  FOREIGN KEY (org_id, configuration_id) REFERENCES product_configurations(org_id, id)
);

CREATE TABLE bom_occurrence_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  occurrence_id uuid NOT NULL,
  configuration_revision_id uuid NOT NULL,
  component_revision_id uuid NOT NULL,
  revision_no integer NOT NULL CHECK (revision_no > 0),
  quantity positive_decimal NOT NULL,
  uom nonempty_text NOT NULL,
  effective_during tstzrange NOT NULL CHECK (NOT isempty(effective_during)),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by uuid NOT NULL,
  UNIQUE (org_id, id), UNIQUE (org_id, occurrence_id, revision_no),
  FOREIGN KEY (org_id, occurrence_id) REFERENCES bom_occurrences(org_id, id),
  FOREIGN KEY (org_id, configuration_revision_id)
    REFERENCES product_configuration_revisions(org_id, id),
  FOREIGN KEY (org_id, component_revision_id) REFERENCES component_revisions(org_id, id),
  FOREIGN KEY (org_id, created_by) REFERENCES principals(org_id, id),
  EXCLUDE USING gist (org_id WITH =, occurrence_id WITH =, effective_during WITH &&)
);

CREATE TABLE requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  occurrence_id uuid NOT NULL,
  requirement_code nonempty_text NOT NULL,
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  UNIQUE (org_id, id), UNIQUE (org_id, occurrence_id, requirement_code),
  FOREIGN KEY (org_id, occurrence_id) REFERENCES bom_occurrences(org_id, id)
);

CREATE TABLE requirement_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  requirement_id uuid NOT NULL,
  occurrence_revision_id uuid NOT NULL,
  component_revision_id uuid NOT NULL,
  revision_no integer NOT NULL CHECK (revision_no > 0),
  effective_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  criteria jsonb NOT NULL CHECK (jsonb_typeof(criteria) = 'object'),
  content_hash sha256_hex NOT NULL,
  created_by uuid NOT NULL,
  UNIQUE (org_id, id), UNIQUE (org_id, requirement_id, revision_no),
  UNIQUE (org_id, requirement_id, content_hash),
  FOREIGN KEY (org_id, requirement_id) REFERENCES requirements(org_id, id),
  FOREIGN KEY (org_id, occurrence_revision_id) REFERENCES bom_occurrence_revisions(org_id, id),
  FOREIGN KEY (org_id, component_revision_id) REFERENCES component_revisions(org_id, id),
  FOREIGN KEY (org_id, created_by) REFERENCES principals(org_id, id)
);

CREATE TABLE sourcing_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  case_code nonempty_text NOT NULL,
  title nonempty_text NOT NULL,
  prepared_by uuid NOT NULL,
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  UNIQUE (org_id, id), UNIQUE (org_id, case_code),
  FOREIGN KEY (org_id, prepared_by) REFERENCES principals(org_id, id)
);

CREATE TABLE sourcing_case_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  sourcing_case_id uuid NOT NULL,
  revision_no integer NOT NULL CHECK (revision_no > 0),
  configuration_revision_id uuid NOT NULL,
  occurrence_revision_id uuid NOT NULL,
  component_revision_id uuid NOT NULL,
  requirement_revision_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by uuid NOT NULL,
  UNIQUE (org_id, id), UNIQUE (org_id, sourcing_case_id, revision_no),
  FOREIGN KEY (org_id, sourcing_case_id) REFERENCES sourcing_cases(org_id, id),
  FOREIGN KEY (org_id, configuration_revision_id)
    REFERENCES product_configuration_revisions(org_id, id),
  FOREIGN KEY (org_id, occurrence_revision_id) REFERENCES bom_occurrence_revisions(org_id, id),
  FOREIGN KEY (org_id, component_revision_id) REFERENCES component_revisions(org_id, id),
  FOREIGN KEY (org_id, requirement_revision_id) REFERENCES requirement_revisions(org_id, id),
  FOREIGN KEY (org_id, created_by) REFERENCES principals(org_id, id)
);

CREATE TABLE supplier_legal_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  legal_name nonempty_text NOT NULL,
  jurisdiction nonempty_text NOT NULL,
  registration_ref nonempty_text NOT NULL,
  UNIQUE (org_id, id), UNIQUE (org_id, jurisdiction, registration_ref)
);

CREATE TABLE supplier_sites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  supplier_entity_id uuid NOT NULL,
  site_code nonempty_text NOT NULL,
  country_code text NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  UNIQUE (org_id, id), UNIQUE (org_id, supplier_entity_id, site_code),
  FOREIGN KEY (org_id, supplier_entity_id) REFERENCES supplier_legal_entities(org_id, id)
);

CREATE TABLE supplier_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  supplier_entity_id uuid NOT NULL,
  account_ref nonempty_text NOT NULL,
  UNIQUE (org_id, id), UNIQUE (org_id, supplier_entity_id, account_ref),
  FOREIGN KEY (org_id, supplier_entity_id) REFERENCES supplier_legal_entities(org_id, id)
);

CREATE TABLE source_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  source_code nonempty_text NOT NULL,
  title nonempty_text NOT NULL,
  purpose nonempty_text NOT NULL,
  supplier_entity_id uuid,
  retention_class nonempty_text NOT NULL,
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (org_id, id), UNIQUE (org_id, source_code),
  FOREIGN KEY (org_id, supplier_entity_id) REFERENCES supplier_legal_entities(org_id, id),
  FOREIGN KEY (org_id, created_by) REFERENCES principals(org_id, id)
);

CREATE TABLE source_document_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  source_document_id uuid NOT NULL,
  revision_no integer NOT NULL CHECK (revision_no > 0),
  s3_bucket nonempty_text NOT NULL,
  s3_key nonempty_text NOT NULL,
  s3_version_id nonempty_text NOT NULL,
  content_sha256 sha256_hex NOT NULL,
  media_type nonempty_text NOT NULL,
  byte_length bigint NOT NULL CHECK (byte_length >= 0),
  effective_at timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  imported_by uuid NOT NULL,
  UNIQUE (org_id, id), UNIQUE (org_id, source_document_id, revision_no),
  UNIQUE (org_id, source_document_id, content_sha256),
  UNIQUE (org_id, s3_bucket, s3_key, s3_version_id),
  FOREIGN KEY (org_id, source_document_id) REFERENCES source_documents(org_id, id),
  FOREIGN KEY (org_id, imported_by) REFERENCES principals(org_id, id)
);

CREATE TABLE source_access_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  source_document_id uuid NOT NULL,
  state source_access_state NOT NULL,
  reason nonempty_text NOT NULL,
  effective_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_id uuid NOT NULL,
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, source_document_id) REFERENCES source_documents(org_id, id),
  FOREIGN KEY (org_id, actor_id) REFERENCES principals(org_id, id)
);
CREATE INDEX source_access_events_latest_idx
  ON source_access_events(org_id, source_document_id, recorded_at DESC, id DESC);

CREATE TABLE source_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  source_document_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  purpose nonempty_text NOT NULL,
  valid_during tstzrange NOT NULL CHECK (NOT isempty(valid_during)),
  granted_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, source_document_id) REFERENCES source_documents(org_id, id),
  FOREIGN KEY (org_id, principal_id) REFERENCES principals(org_id, id),
  FOREIGN KEY (org_id, granted_by) REFERENCES principals(org_id, id),
  EXCLUDE USING gist (
    org_id WITH =, source_document_id WITH =, principal_id WITH =,
    purpose WITH =, valid_during WITH &&
  )
);

CREATE TABLE source_grant_revocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  source_grant_id uuid NOT NULL,
  revoked_at timestamptz NOT NULL,
  reason nonempty_text NOT NULL,
  revoked_by uuid NOT NULL,
  UNIQUE (org_id, id), UNIQUE (org_id, source_grant_id),
  FOREIGN KEY (org_id, source_grant_id) REFERENCES source_grants(org_id, id),
  FOREIGN KEY (org_id, revoked_by) REFERENCES principals(org_id, id)
);

CREATE TABLE legal_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  hold_ref nonempty_text NOT NULL,
  reason nonempty_text NOT NULL,
  starts_at timestamptz NOT NULL,
  released_at timestamptz CHECK (released_at IS NULL OR released_at >= starts_at),
  authorized_by uuid NOT NULL,
  UNIQUE (org_id, id), UNIQUE (org_id, hold_ref),
  FOREIGN KEY (org_id, authorized_by) REFERENCES principals(org_id, id)
);

CREATE TABLE source_legal_holds (
  org_id uuid NOT NULL,
  source_document_id uuid NOT NULL,
  legal_hold_id uuid NOT NULL,
  PRIMARY KEY (org_id, source_document_id, legal_hold_id),
  FOREIGN KEY (org_id, source_document_id) REFERENCES source_documents(org_id, id),
  FOREIGN KEY (org_id, legal_hold_id) REFERENCES legal_holds(org_id, id)
);

CREATE TABLE source_lifecycle_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  source_document_id uuid NOT NULL,
  state source_lifecycle_state NOT NULL,
  reason nonempty_text NOT NULL,
  erasure_request_ref text,
  effective_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_id uuid NOT NULL,
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, source_document_id) REFERENCES source_documents(org_id, id),
  FOREIGN KEY (org_id, actor_id) REFERENCES principals(org_id, id)
);

CREATE FUNCTION app.can_read_source(wanted_source uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = grimoire, pg_temp
SET row_security = off
AS $$
  WITH latest_access AS (
    SELECT sae.state
    FROM source_access_events sae
    WHERE sae.org_id = app.current_org_id()
      AND sae.source_document_id = wanted_source
      AND sae.effective_at <= clock_timestamp()
    ORDER BY sae.recorded_at DESC, sae.id DESC LIMIT 1
  ), latest_lifecycle AS (
    SELECT sle.state
    FROM source_lifecycle_events sle
    WHERE sle.org_id = app.current_org_id()
      AND sle.source_document_id = wanted_source
      AND sle.effective_at <= clock_timestamp()
    ORDER BY sle.recorded_at DESC, sle.id DESC LIMIT 1
  )
  SELECT COALESCE((SELECT state = 'authorized' FROM latest_access), false)
    AND COALESCE((SELECT state = 'active' FROM latest_lifecycle), false)
    AND EXISTS (
      SELECT 1 FROM source_grants sg
      WHERE sg.org_id = app.current_org_id()
        AND sg.source_document_id = wanted_source
        AND sg.principal_id = app.current_principal_id()
        AND sg.valid_during @> clock_timestamp()
        AND NOT EXISTS (
          SELECT 1 FROM source_grant_revocations r
          WHERE (r.org_id, r.source_grant_id) = (sg.org_id, sg.id)
            AND r.revoked_at <= clock_timestamp()
        )
    )
$$;

CREATE TABLE claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  source_revision_id uuid NOT NULL,
  authority authority_kind NOT NULL,
  subject_type nonempty_text NOT NULL,
  subject_id uuid NOT NULL,
  predicate nonempty_text NOT NULL,
  value jsonb NOT NULL,
  source_locator jsonb NOT NULL CHECK (jsonb_typeof(source_locator) = 'object'),
  effective_at timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by uuid NOT NULL,
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, source_revision_id) REFERENCES source_document_revisions(org_id, id),
  FOREIGN KEY (org_id, created_by) REFERENCES principals(org_id, id)
);
CREATE INDEX claims_subject_idx ON claims(org_id, subject_type, subject_id, predicate);

CREATE TABLE claim_relations (
  org_id uuid NOT NULL,
  left_claim_id uuid NOT NULL,
  relation claim_relation_kind NOT NULL,
  right_claim_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_id uuid NOT NULL,
  PRIMARY KEY (org_id, left_claim_id, relation, right_claim_id),
  CHECK (left_claim_id <> right_claim_id),
  FOREIGN KEY (org_id, left_claim_id) REFERENCES claims(org_id, id),
  FOREIGN KEY (org_id, right_claim_id) REFERENCES claims(org_id, id),
  FOREIGN KEY (org_id, actor_id) REFERENCES principals(org_id, id)
);

CREATE TABLE qualification_tests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  test_code nonempty_text NOT NULL,
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  UNIQUE (org_id, id), UNIQUE (org_id, test_code)
);

CREATE TABLE qualification_test_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  qualification_test_id uuid NOT NULL,
  revision_no integer NOT NULL CHECK (revision_no > 0),
  requirement_revision_id uuid NOT NULL,
  occurrence_revision_id uuid NOT NULL,
  component_revision_id uuid NOT NULL,
  method jsonb NOT NULL CHECK (jsonb_typeof(method) = 'object'),
  acceptance_criteria jsonb NOT NULL CHECK (jsonb_typeof(acceptance_criteria) = 'object'),
  content_hash sha256_hex NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by uuid NOT NULL,
  UNIQUE (org_id, id), UNIQUE (org_id, qualification_test_id, revision_no),
  UNIQUE (org_id, qualification_test_id, content_hash),
  FOREIGN KEY (org_id, qualification_test_id) REFERENCES qualification_tests(org_id, id),
  FOREIGN KEY (org_id, requirement_revision_id) REFERENCES requirement_revisions(org_id, id),
  FOREIGN KEY (org_id, occurrence_revision_id) REFERENCES bom_occurrence_revisions(org_id, id),
  FOREIGN KEY (org_id, component_revision_id) REFERENCES component_revisions(org_id, id),
  FOREIGN KEY (org_id, created_by) REFERENCES principals(org_id, id)
);

CREATE TABLE qualification_test_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  test_revision_id uuid NOT NULL,
  supplier_site_id uuid NOT NULL,
  offered_component_revision_id uuid NOT NULL,
  execution_ref nonempty_text NOT NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz CHECK (completed_at IS NULL OR completed_at >= started_at),
  executed_by uuid NOT NULL,
  UNIQUE (org_id, id), UNIQUE (org_id, test_revision_id, execution_ref),
  FOREIGN KEY (org_id, test_revision_id) REFERENCES qualification_test_revisions(org_id, id),
  FOREIGN KEY (org_id, supplier_site_id) REFERENCES supplier_sites(org_id, id),
  FOREIGN KEY (org_id, offered_component_revision_id) REFERENCES component_revisions(org_id, id),
  FOREIGN KEY (org_id, executed_by) REFERENCES principals(org_id, id)
);

CREATE TABLE test_result_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  execution_id uuid NOT NULL,
  revision_no integer NOT NULL CHECK (revision_no > 0),
  outcome qualification_outcome NOT NULL,
  measurements jsonb NOT NULL CHECK (jsonb_typeof(measurements) = 'object'),
  source_revision_id uuid NOT NULL,
  supersedes_result_revision_id uuid,
  effective_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by uuid NOT NULL,
  content_hash sha256_hex NOT NULL,
  UNIQUE (org_id, id), UNIQUE (org_id, execution_id, revision_no),
  UNIQUE (org_id, execution_id, content_hash),
  UNIQUE (org_id, execution_id, id),
  FOREIGN KEY (org_id, execution_id) REFERENCES qualification_test_executions(org_id, id),
  FOREIGN KEY (org_id, source_revision_id) REFERENCES source_document_revisions(org_id, id),
  FOREIGN KEY (org_id, execution_id, supersedes_result_revision_id)
    REFERENCES test_result_revisions(org_id, execution_id, id),
  FOREIGN KEY (org_id, created_by) REFERENCES principals(org_id, id),
  CHECK (supersedes_result_revision_id IS NULL OR supersedes_result_revision_id <> id)
);

CREATE TABLE test_result_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  result_revision_id uuid NOT NULL,
  domain approval_domain NOT NULL CHECK (domain IN ('engineering', 'quality')),
  state review_state NOT NULL,
  reviewer_id uuid NOT NULL,
  rationale nonempty_text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (org_id, id), UNIQUE (org_id, result_revision_id, domain),
  FOREIGN KEY (org_id, result_revision_id) REFERENCES test_result_revisions(org_id, id),
  FOREIGN KEY (org_id, reviewer_id) REFERENCES principals(org_id, id)
);

CREATE FUNCTION enforce_test_result_review() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = grimoire, pg_temp
SET row_security = off
AS $$
DECLARE required_role actor_role;
BEGIN
  required_role := CASE NEW.domain
    WHEN 'engineering' THEN 'engineering_reviewer'::actor_role
    WHEN 'quality' THEN 'quality_reviewer'::actor_role END;
  IF NOT EXISTS (
    SELECT 1 FROM principal_roles
    WHERE (org_id,principal_id,role) = (NEW.org_id,NEW.reviewer_id,required_role)
  ) OR EXISTS (
    SELECT 1 FROM test_result_reviews r
    WHERE (r.org_id,r.result_revision_id) = (NEW.org_id,NEW.result_revision_id)
      AND r.reviewer_id = NEW.reviewer_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'G2005',
      MESSAGE = 'test review requires the matching role and a distinct reviewer per domain';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER test_result_review_guard
BEFORE INSERT ON test_result_reviews
FOR EACH ROW EXECUTE FUNCTION enforce_test_result_review();

CREATE TABLE supplier_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  sourcing_case_id uuid NOT NULL,
  supplier_entity_id uuid NOT NULL,
  supplier_site_id uuid NOT NULL,
  supplier_account_id uuid NOT NULL,
  offer_ref nonempty_text NOT NULL,
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  UNIQUE (org_id, id), UNIQUE (org_id, supplier_account_id, offer_ref),
  FOREIGN KEY (org_id, sourcing_case_id) REFERENCES sourcing_cases(org_id, id),
  FOREIGN KEY (org_id, supplier_entity_id) REFERENCES supplier_legal_entities(org_id, id),
  FOREIGN KEY (org_id, supplier_site_id) REFERENCES supplier_sites(org_id, id),
  FOREIGN KEY (org_id, supplier_account_id) REFERENCES supplier_accounts(org_id, id)
);

CREATE TABLE offer_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  offer_id uuid NOT NULL,
  revision_no integer NOT NULL CHECK (revision_no > 0),
  source_revision_id uuid NOT NULL,
  quoted_at timestamptz NOT NULL,
  validity_window tstzrange NOT NULL CHECK (NOT isempty(validity_window)),
  currency currency_code NOT NULL,
  destination nonempty_text NOT NULL,
  incoterm nonempty_text NOT NULL,
  payment_terms nonempty_text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by uuid NOT NULL,
  content_hash sha256_hex NOT NULL,
  UNIQUE (org_id, id), UNIQUE (org_id, offer_id, revision_no),
  UNIQUE (org_id, offer_id, content_hash),
  FOREIGN KEY (org_id, offer_id) REFERENCES supplier_offers(org_id, id),
  FOREIGN KEY (org_id, source_revision_id) REFERENCES source_document_revisions(org_id, id),
  FOREIGN KEY (org_id, created_by) REFERENCES principals(org_id, id)
);

CREATE TABLE offer_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  offer_revision_id uuid NOT NULL,
  line_no integer NOT NULL CHECK (line_no > 0),
  occurrence_revision_id uuid NOT NULL,
  offered_manufacturer nonempty_text NOT NULL,
  offered_part_number nonempty_text NOT NULL,
  quantity positive_decimal NOT NULL,
  uom nonempty_text NOT NULL,
  unit_price positive_decimal NOT NULL,
  lead_time_days integer NOT NULL CHECK (lead_time_days >= 0),
  UNIQUE (org_id, id), UNIQUE (org_id, offer_revision_id, line_no),
  FOREIGN KEY (org_id, offer_revision_id) REFERENCES offer_revisions(org_id, id),
  FOREIGN KEY (org_id, occurrence_revision_id) REFERENCES bom_occurrence_revisions(org_id, id)
);

CREATE TABLE offer_line_identity_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  offer_line_id uuid NOT NULL,
  case_revision_id uuid NOT NULL,
  state identity_match_state NOT NULL,
  rationale nonempty_text NOT NULL,
  reviewed_by uuid NOT NULL,
  reviewed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (org_id, id), UNIQUE (org_id, offer_line_id, case_revision_id),
  FOREIGN KEY (org_id, offer_line_id) REFERENCES offer_lines(org_id, id),
  FOREIGN KEY (org_id, case_revision_id) REFERENCES sourcing_case_revisions(org_id, id),
  FOREIGN KEY (org_id, reviewed_by) REFERENCES principals(org_id, id)
);

CREATE TABLE derived_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  kind artifact_kind NOT NULL,
  content_hash sha256_hex NOT NULL,
  valid boolean NOT NULL DEFAULT true,
  invalidated_at timestamptz,
  invalidation_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by uuid NOT NULL,
  UNIQUE (org_id, id), UNIQUE (org_id, kind, content_hash),
  FOREIGN KEY (org_id, created_by) REFERENCES principals(org_id, id),
  CHECK ((valid AND invalidated_at IS NULL AND invalidation_reason IS NULL)
      OR (NOT valid AND invalidated_at IS NOT NULL AND invalidation_reason IS NOT NULL))
);

CREATE TABLE artifact_source_inputs (
  org_id uuid NOT NULL,
  artifact_id uuid NOT NULL,
  source_revision_id uuid NOT NULL,
  PRIMARY KEY (org_id, artifact_id, source_revision_id),
  FOREIGN KEY (org_id, artifact_id) REFERENCES derived_artifacts(org_id, id),
  FOREIGN KEY (org_id, source_revision_id) REFERENCES source_document_revisions(org_id, id)
);

CREATE FUNCTION app.can_read_artifact(wanted_artifact uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = grimoire, pg_temp
SET row_security = off
AS $$
  SELECT EXISTS (
    SELECT 1 FROM derived_artifacts da
    WHERE da.org_id = app.current_org_id() AND da.id = wanted_artifact AND da.valid
  ) AND EXISTS (
    SELECT 1 FROM artifact_source_inputs asi
    WHERE asi.org_id = app.current_org_id() AND asi.artifact_id = wanted_artifact
  ) AND NOT EXISTS (
    SELECT 1
    FROM artifact_source_inputs asi
    JOIN source_document_revisions sr
      ON (sr.org_id, sr.id) = (asi.org_id, asi.source_revision_id)
    WHERE asi.org_id = app.current_org_id() AND asi.artifact_id = wanted_artifact
      AND NOT app.can_read_source(sr.source_document_id)
  )
$$;

CREATE TABLE comparison_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  artifact_id uuid NOT NULL,
  sourcing_case_revision_id uuid NOT NULL,
  requirement_revision_id uuid NOT NULL,
  revision_no integer NOT NULL CHECK (revision_no > 0),
  as_of timestamptz NOT NULL,
  target_quantity positive_decimal NOT NULL,
  target_uom nonempty_text NOT NULL,
  target_currency currency_code NOT NULL,
  destination nonempty_text NOT NULL,
  required_validity_window tstzrange NOT NULL CHECK (NOT isempty(required_validity_window)),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by uuid NOT NULL,
  UNIQUE (org_id, id), UNIQUE (org_id, sourcing_case_revision_id, revision_no),
  UNIQUE (org_id, artifact_id),
  FOREIGN KEY (org_id, artifact_id) REFERENCES derived_artifacts(org_id, id),
  FOREIGN KEY (org_id, sourcing_case_revision_id) REFERENCES sourcing_case_revisions(org_id, id),
  FOREIGN KEY (org_id, requirement_revision_id) REFERENCES requirement_revisions(org_id, id),
  FOREIGN KEY (org_id, created_by) REFERENCES principals(org_id, id)
);

CREATE TABLE normalized_comparison_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  comparison_revision_id uuid NOT NULL,
  offer_line_id uuid NOT NULL,
  identity_assessment_id uuid NOT NULL,
  state comparison_line_state NOT NULL,
  normalized_quantity numeric(24,8),
  normalized_uom text,
  normalized_currency currency_code,
  normalized_unit_price numeric(24,8),
  fx_rate numeric(24,12),
  fx_rate_date date,
  normalized_validity_window tstzrange,
  normalization_note nonempty_text NOT NULL,
  exclusion_reason text,
  reviewed_by uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (org_id, id), UNIQUE (org_id, comparison_revision_id, offer_line_id),
  FOREIGN KEY (org_id, comparison_revision_id) REFERENCES comparison_revisions(org_id, id),
  FOREIGN KEY (org_id, offer_line_id) REFERENCES offer_lines(org_id, id),
  FOREIGN KEY (org_id, identity_assessment_id)
    REFERENCES offer_line_identity_assessments(org_id, id),
  FOREIGN KEY (org_id, reviewed_by) REFERENCES principals(org_id, id),
  CHECK (
    (state = 'excluded' AND exclusion_reason IS NOT NULL
      AND normalized_unit_price IS NULL)
    OR
    (state = 'comparable' AND exclusion_reason IS NULL
      AND normalized_quantity > 0 AND normalized_uom IS NOT NULL
      AND normalized_currency IS NOT NULL AND normalized_unit_price > 0
      AND fx_rate > 0 AND fx_rate_date IS NOT NULL
      AND normalized_validity_window IS NOT NULL
      AND NOT isempty(normalized_validity_window))
  )
);

CREATE FUNCTION enforce_comparison_line() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = grimoire, pg_temp
SET row_security = off
AS $$
DECLARE
  v_case sourcing_case_revisions%ROWTYPE;
  v_cmp comparison_revisions%ROWTYPE;
  v_line offer_lines%ROWTYPE;
  v_offer offer_revisions%ROWTYPE;
  v_assess offer_line_identity_assessments%ROWTYPE;
  v_component component_revisions%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_cmp FROM comparison_revisions
    WHERE (org_id, id) = (NEW.org_id, NEW.comparison_revision_id);
  SELECT * INTO STRICT v_case FROM sourcing_case_revisions
    WHERE (org_id, id) = (NEW.org_id, v_cmp.sourcing_case_revision_id);
  SELECT * INTO STRICT v_line FROM offer_lines
    WHERE (org_id, id) = (NEW.org_id, NEW.offer_line_id);
  SELECT * INTO STRICT v_offer FROM offer_revisions
    WHERE (org_id, id) = (NEW.org_id, v_line.offer_revision_id);
  SELECT * INTO STRICT v_assess FROM offer_line_identity_assessments
    WHERE (org_id, id) = (NEW.org_id, NEW.identity_assessment_id);
  SELECT * INTO STRICT v_component FROM component_revisions
    WHERE (org_id, id) = (NEW.org_id, v_case.component_revision_id);

  IF v_assess.offer_line_id <> NEW.offer_line_id
     OR v_assess.case_revision_id <> v_case.id THEN
    RAISE EXCEPTION USING ERRCODE = 'G1001',
      MESSAGE = 'identity assessment does not bind this line and case revision';
  END IF;

  IF NEW.state = 'comparable' AND (
      v_assess.state <> 'exact_match'
      OR v_line.occurrence_revision_id <> v_case.occurrence_revision_id
      OR v_line.offered_manufacturer <> v_component.approved_manufacturer
      OR v_line.offered_part_number <> v_component.approved_part_number
      OR v_cmp.requirement_revision_id <> v_case.requirement_revision_id
      OR NEW.normalized_quantity <> v_cmp.target_quantity
      OR NEW.normalized_uom <> v_cmp.target_uom
      OR NEW.normalized_currency <> v_cmp.target_currency
      OR NEW.normalized_validity_window IS DISTINCT FROM v_cmp.required_validity_window
      OR v_offer.destination <> v_cmp.destination
      OR NOT (v_offer.validity_window @> v_cmp.as_of)
      OR NOT (v_offer.validity_window @> v_cmp.required_validity_window)
    ) THEN
    RAISE EXCEPTION USING ERRCODE = 'G1002',
      MESSAGE = 'line is not comparable to the exact case, quantity, currency, destination, or validity basis';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER normalized_comparison_lines_guard
BEFORE INSERT OR UPDATE ON normalized_comparison_lines
FOR EACH ROW EXECUTE FUNCTION enforce_comparison_line();

CREATE VIEW comparison_totals WITH (security_barrier = true, security_invoker = true) AS
SELECT n.org_id, n.comparison_revision_id,
       count(*) AS comparable_line_count,
       sum(n.normalized_quantity * n.normalized_unit_price) AS comparable_total
FROM normalized_comparison_lines n
WHERE n.state = 'comparable'
GROUP BY n.org_id, n.comparison_revision_id;

CREATE TABLE decision_packets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  sourcing_case_id uuid NOT NULL,
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, sourcing_case_id) REFERENCES sourcing_cases(org_id, id)
);

CREATE TABLE decision_packet_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  packet_id uuid NOT NULL,
  artifact_id uuid NOT NULL,
  revision_no integer NOT NULL CHECK (revision_no > 0),
  case_revision_id uuid NOT NULL,
  requirement_revision_id uuid NOT NULL,
  comparison_revision_id uuid NOT NULL,
  summary jsonb NOT NULL CHECK (jsonb_typeof(summary) = 'object'),
  content_hash sha256_hex NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by uuid NOT NULL,
  UNIQUE (org_id, id), UNIQUE (org_id, packet_id, revision_no),
  UNIQUE (org_id, artifact_id),
  FOREIGN KEY (org_id, packet_id) REFERENCES decision_packets(org_id, id),
  FOREIGN KEY (org_id, artifact_id) REFERENCES derived_artifacts(org_id, id),
  FOREIGN KEY (org_id, case_revision_id) REFERENCES sourcing_case_revisions(org_id, id),
  FOREIGN KEY (org_id, requirement_revision_id) REFERENCES requirement_revisions(org_id, id),
  FOREIGN KEY (org_id, comparison_revision_id) REFERENCES comparison_revisions(org_id, id),
  FOREIGN KEY (org_id, created_by) REFERENCES principals(org_id, id)
);

CREATE TABLE decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  sourcing_case_id uuid NOT NULL,
  decision_code nonempty_text NOT NULL,
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  UNIQUE (org_id, id), UNIQUE (org_id, decision_code),
  FOREIGN KEY (org_id, sourcing_case_id) REFERENCES sourcing_cases(org_id, id)
);

CREATE TABLE decision_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  decision_id uuid NOT NULL,
  revision_no integer NOT NULL CHECK (revision_no > 0),
  case_revision_id uuid NOT NULL,
  requirement_revision_id uuid NOT NULL,
  comparison_revision_id uuid NOT NULL,
  packet_revision_id uuid NOT NULL,
  selected_offer_revision_id uuid NOT NULL,
  selected_offer_line_id uuid NOT NULL,
  rationale nonempty_text NOT NULL,
  content_hash sha256_hex NOT NULL,
  prepared_by uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (org_id, id), UNIQUE (org_id, decision_id, revision_no),
  UNIQUE (org_id, decision_id, content_hash),
  FOREIGN KEY (org_id, decision_id) REFERENCES decisions(org_id, id),
  FOREIGN KEY (org_id, case_revision_id) REFERENCES sourcing_case_revisions(org_id, id),
  FOREIGN KEY (org_id, requirement_revision_id) REFERENCES requirement_revisions(org_id, id),
  FOREIGN KEY (org_id, comparison_revision_id) REFERENCES comparison_revisions(org_id, id),
  FOREIGN KEY (org_id, packet_revision_id) REFERENCES decision_packet_revisions(org_id, id),
  FOREIGN KEY (org_id, selected_offer_revision_id) REFERENCES offer_revisions(org_id, id),
  FOREIGN KEY (org_id, selected_offer_line_id) REFERENCES offer_lines(org_id, id),
  FOREIGN KEY (org_id, prepared_by) REFERENCES principals(org_id, id)
);

CREATE TABLE decision_offer_inputs (
  org_id uuid NOT NULL,
  decision_revision_id uuid NOT NULL,
  offer_revision_id uuid NOT NULL,
  offer_line_id uuid NOT NULL,
  PRIMARY KEY (org_id, decision_revision_id, offer_revision_id, offer_line_id),
  FOREIGN KEY (org_id, decision_revision_id) REFERENCES decision_revisions(org_id, id),
  FOREIGN KEY (org_id, offer_revision_id) REFERENCES offer_revisions(org_id, id),
  FOREIGN KEY (org_id, offer_line_id) REFERENCES offer_lines(org_id, id)
);

CREATE TABLE decision_qualification_inputs (
  org_id uuid NOT NULL,
  decision_revision_id uuid NOT NULL,
  test_revision_id uuid NOT NULL,
  result_revision_id uuid NOT NULL,
  PRIMARY KEY (org_id, decision_revision_id, test_revision_id, result_revision_id),
  FOREIGN KEY (org_id, decision_revision_id) REFERENCES decision_revisions(org_id, id),
  FOREIGN KEY (org_id, test_revision_id) REFERENCES qualification_test_revisions(org_id, id),
  FOREIGN KEY (org_id, result_revision_id) REFERENCES test_result_revisions(org_id, id)
);

CREATE TABLE decision_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  decision_revision_id uuid NOT NULL,
  domain approval_domain NOT NULL,
  approver_id uuid NOT NULL,
  signature_hash sha256_hex NOT NULL,
  rationale nonempty_text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (org_id, id), UNIQUE (org_id, decision_revision_id, domain),
  FOREIGN KEY (org_id, decision_revision_id) REFERENCES decision_revisions(org_id, id),
  FOREIGN KEY (org_id, approver_id) REFERENCES principals(org_id, id)
);

CREATE TABLE approval_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  approval_id uuid NOT NULL,
  kind approval_event_kind NOT NULL,
  actor_id uuid NOT NULL,
  rationale nonempty_text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, approval_id) REFERENCES decision_approvals(org_id, id),
  FOREIGN KEY (org_id, actor_id) REFERENCES principals(org_id, id)
);

CREATE TABLE decision_state_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  decision_revision_id uuid NOT NULL,
  state decision_state NOT NULL,
  actor_id uuid,
  reason nonempty_text NOT NULL,
  caused_by_requirement_revision_id uuid,
  caused_by_offer_revision_id uuid,
  idempotency_key nonempty_text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (org_id, id), UNIQUE (org_id, idempotency_key),
  FOREIGN KEY (org_id, decision_revision_id) REFERENCES decision_revisions(org_id, id),
  FOREIGN KEY (org_id, actor_id) REFERENCES principals(org_id, id),
  FOREIGN KEY (org_id, caused_by_requirement_revision_id)
    REFERENCES requirement_revisions(org_id, id),
  FOREIGN KEY (org_id, caused_by_offer_revision_id) REFERENCES offer_revisions(org_id, id),
  CHECK (num_nonnulls(caused_by_requirement_revision_id, caused_by_offer_revision_id) <= 1)
);
CREATE INDEX decision_state_events_latest_idx
  ON decision_state_events(org_id, decision_revision_id, recorded_at DESC, id DESC);

CREATE VIEW current_decision_state WITH (security_barrier = true, security_invoker = true) AS
SELECT DISTINCT ON (org_id, decision_revision_id)
  org_id, decision_revision_id, state, reason, recorded_at,
  caused_by_requirement_revision_id, caused_by_offer_revision_id
FROM decision_state_events
ORDER BY org_id, decision_revision_id, recorded_at DESC, id DESC;

CREATE TABLE change_impacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  decision_revision_id uuid NOT NULL,
  cause_requirement_revision_id uuid,
  cause_offer_revision_id uuid,
  effect nonempty_text NOT NULL CHECK (effect IN ('stale', 'unaffected')),
  explanation nonempty_text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, decision_revision_id) REFERENCES decision_revisions(org_id, id),
  FOREIGN KEY (org_id, cause_requirement_revision_id) REFERENCES requirement_revisions(org_id, id),
  FOREIGN KEY (org_id, cause_offer_revision_id) REFERENCES offer_revisions(org_id, id),
  CHECK (num_nonnulls(cause_requirement_revision_id, cause_offer_revision_id) = 1),
  UNIQUE NULLS NOT DISTINCT (
    org_id, decision_revision_id, cause_requirement_revision_id, cause_offer_revision_id
  )
);

CREATE TABLE idempotency_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  operation nonempty_text NOT NULL,
  idempotency_key nonempty_text NOT NULL,
  request_hash sha256_hex NOT NULL,
  response_status integer CHECK (response_status BETWEEN 100 AND 599),
  response_body jsonb,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  UNIQUE (org_id, id), UNIQUE (org_id, operation, idempotency_key),
  CHECK ((completed_at IS NULL AND response_status IS NULL AND response_body IS NULL)
      OR (completed_at IS NOT NULL AND response_status IS NOT NULL AND response_body IS NOT NULL))
);

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  topic nonempty_text NOT NULL,
  aggregate_type nonempty_text NOT NULL,
  aggregate_id uuid NOT NULL,
  dedupe_key nonempty_text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  state job_state NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_until timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  UNIQUE (org_id, id), UNIQUE (org_id, topic, dedupe_key)
);
CREATE INDEX outbox_claim_idx ON outbox_events(state, available_at, created_at)
  WHERE state IN ('pending', 'running');

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  request_id uuid NOT NULL,
  actor_id uuid,
  action nonempty_text NOT NULL,
  object_type nonempty_text NOT NULL,
  object_id uuid NOT NULL,
  before_hash sha256_hex,
  after_hash sha256_hex,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (org_id, id)
);

CREATE FUNCTION deny_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'G2001', MESSAGE = 'append-only relation';
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'product_configuration_revisions','component_revisions','bom_occurrence_revisions',
    'requirement_revisions','sourcing_case_revisions','source_document_revisions',
    'source_access_events','source_grant_revocations','source_lifecycle_events',
    'claims','claim_relations','qualification_test_revisions','qualification_test_executions',
    'test_result_revisions','test_result_reviews','offer_revisions','offer_lines',
    'offer_line_identity_assessments','comparison_revisions','normalized_comparison_lines',
    'decision_packet_revisions','decision_revisions','decision_offer_inputs',
    'decision_qualification_inputs','decision_approvals','approval_events',
    'decision_state_events','change_impacts','audit_events'
  ] LOOP
    EXECUTE format('CREATE TRIGGER %I_append_only BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION deny_change()', t, t);
  END LOOP;
END $$;

CREATE FUNCTION enforce_decision_approval() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = grimoire, pg_temp
SET row_security = off
AS $$
DECLARE prepared uuid; required_role actor_role;
BEGIN
  SELECT prepared_by INTO STRICT prepared FROM decision_revisions
   WHERE (org_id, id) = (NEW.org_id, NEW.decision_revision_id);
  IF NEW.approver_id = prepared THEN
    RAISE EXCEPTION USING ERRCODE = 'G2002', MESSAGE = 'preparer cannot approve own decision';
  END IF;
  IF EXISTS (
    SELECT 1 FROM decision_approvals a
    WHERE (a.org_id,a.decision_revision_id) = (NEW.org_id,NEW.decision_revision_id)
      AND a.approver_id = NEW.approver_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'G2002',
      MESSAGE = 'one principal cannot satisfy multiple approval domains';
  END IF;
  required_role := CASE NEW.domain
    WHEN 'engineering' THEN 'engineering_reviewer'::actor_role
    WHEN 'quality' THEN 'quality_reviewer'::actor_role
    WHEN 'commercial' THEN 'commercial_approver'::actor_role END;
  IF NOT EXISTS (
    SELECT 1 FROM principal_roles
    WHERE (org_id, principal_id, role) = (NEW.org_id, NEW.approver_id, required_role)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'G2003', MESSAGE = 'approver lacks domain role';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER decision_approval_guard
BEFORE INSERT ON decision_approvals
FOR EACH ROW EXECUTE FUNCTION enforce_decision_approval();

CREATE FUNCTION enforce_decision_state() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = grimoire, pg_temp
SET row_security = off
AS $$
BEGIN
  IF NEW.state = 'approved' THEN
    IF NOT EXISTS (
      SELECT 1 FROM decision_state_events e
      WHERE (e.org_id, e.decision_revision_id) = (NEW.org_id, NEW.decision_revision_id)
        AND e.state = 'submitted'
    ) OR 3 <> (
      SELECT count(DISTINCT a.domain)
      FROM decision_approvals a
      WHERE (a.org_id, a.decision_revision_id) = (NEW.org_id, NEW.decision_revision_id)
        AND NOT EXISTS (
          SELECT 1 FROM approval_events ae
          WHERE (ae.org_id, ae.approval_id) = (a.org_id, a.id) AND ae.kind = 'revoked'
        )
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'G2004',
        MESSAGE = 'approved requires submitted state and active engineering, quality, commercial approvals';
    END IF;
    IF NEW.actor_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM principal_roles
      WHERE (org_id,principal_id,role) =
            (NEW.org_id,NEW.actor_id,'commercial_approver'::actor_role)
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'G2003',
        MESSAGE = 'only a commercial approver may finalize the approved state';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER decision_state_guard
BEFORE INSERT ON decision_state_events
FOR EACH ROW EXECUTE FUNCTION enforce_decision_state();

CREATE FUNCTION mark_requirement_decisions_stale() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = grimoire, pg_temp
SET row_security = off
AS $$
DECLARE d record;
BEGIN
  FOR d IN
    SELECT dr.id
    FROM decision_revisions dr
    JOIN requirement_revisions old_rr
      ON (old_rr.org_id, old_rr.id) = (dr.org_id, dr.requirement_revision_id)
    JOIN current_decision_state cds
      ON (cds.org_id, cds.decision_revision_id) = (dr.org_id, dr.id)
    WHERE dr.org_id = NEW.org_id AND old_rr.requirement_id = NEW.requirement_id
      AND old_rr.id <> NEW.id AND cds.state = 'approved'
  LOOP
    INSERT INTO change_impacts (
      org_id, decision_revision_id, cause_requirement_revision_id, effect, explanation
    ) VALUES (NEW.org_id, d.id, NEW.id, 'stale', 'new requirement revision')
    ON CONFLICT DO NOTHING;
    INSERT INTO decision_state_events (
      org_id, decision_revision_id, state, reason,
      caused_by_requirement_revision_id, idempotency_key
    ) VALUES (
      NEW.org_id, d.id, 'stale', 'new requirement revision requires re-review',
      NEW.id, 'stale:requirement:' || NEW.id || ':decision:' || d.id
    ) ON CONFLICT DO NOTHING;
    INSERT INTO outbox_events (org_id, topic, aggregate_type, aggregate_id, dedupe_key, payload)
    VALUES (NEW.org_id, 'revision-impact', 'decision_revision', d.id,
      'requirement:' || NEW.id || ':decision:' || d.id,
      jsonb_build_object('decisionRevisionId', d.id, 'requirementRevisionId', NEW.id))
    ON CONFLICT DO NOTHING;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER requirement_revision_staleness
AFTER INSERT ON requirement_revisions
FOR EACH ROW EXECUTE FUNCTION mark_requirement_decisions_stale();

CREATE FUNCTION mark_offer_decisions_stale() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = grimoire, pg_temp
SET row_security = off
AS $$
DECLARE d record;
BEGIN
  FOR d IN
    SELECT DISTINCT dr.id
    FROM decision_revisions dr
    JOIN decision_offer_inputs doi
      ON (doi.org_id, doi.decision_revision_id) = (dr.org_id, dr.id)
    JOIN offer_revisions old_or
      ON (old_or.org_id, old_or.id) = (doi.org_id, doi.offer_revision_id)
    JOIN current_decision_state cds
      ON (cds.org_id, cds.decision_revision_id) = (dr.org_id, dr.id)
    WHERE dr.org_id = NEW.org_id AND old_or.offer_id = NEW.offer_id
      AND old_or.id <> NEW.id AND cds.state = 'approved'
  LOOP
    INSERT INTO change_impacts (
      org_id, decision_revision_id, cause_offer_revision_id, effect, explanation
    ) VALUES (NEW.org_id, d.id, NEW.id, 'stale', 'new offer revision')
    ON CONFLICT DO NOTHING;
    INSERT INTO decision_state_events (
      org_id, decision_revision_id, state, reason,
      caused_by_offer_revision_id, idempotency_key
    ) VALUES (
      NEW.org_id, d.id, 'stale', 'new offer revision requires re-review',
      NEW.id, 'stale:offer:' || NEW.id || ':decision:' || d.id
    ) ON CONFLICT DO NOTHING;
    INSERT INTO outbox_events (org_id, topic, aggregate_type, aggregate_id, dedupe_key, payload)
    VALUES (NEW.org_id, 'revision-impact', 'decision_revision', d.id,
      'offer:' || NEW.id || ':decision:' || d.id,
      jsonb_build_object('decisionRevisionId', d.id, 'offerRevisionId', NEW.id))
    ON CONFLICT DO NOTHING;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER offer_revision_staleness
AFTER INSERT ON offer_revisions
FOR EACH ROW EXECUTE FUNCTION mark_offer_decisions_stale();

CREATE FUNCTION bump_source_access_epoch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = grimoire, pg_temp
AS $$
BEGIN
  UPDATE org_security_epochs SET access_epoch = access_epoch + 1,
    updated_at = clock_timestamp() WHERE org_id = NEW.org_id;
  INSERT INTO outbox_events (org_id, topic, aggregate_type, aggregate_id, dedupe_key, payload)
  VALUES (NEW.org_id, 'access-revoked', TG_TABLE_NAME, NEW.id,
    TG_TABLE_NAME || ':' || NEW.id,
    jsonb_build_object('sourceDocumentId', NEW.source_document_id))
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER source_access_epoch AFTER INSERT ON source_access_events
FOR EACH ROW WHEN (NEW.state IN ('revoked','expired')) EXECUTE FUNCTION bump_source_access_epoch();

CREATE FUNCTION bump_grant_access_epoch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = grimoire, pg_temp
AS $$
DECLARE source_id uuid;
BEGIN
  SELECT source_document_id INTO STRICT source_id
  FROM source_grants WHERE (org_id, id) = (NEW.org_id, NEW.source_grant_id);
  UPDATE org_security_epochs SET access_epoch = access_epoch + 1,
    updated_at = clock_timestamp() WHERE org_id = NEW.org_id;
  INSERT INTO outbox_events (org_id, topic, aggregate_type, aggregate_id, dedupe_key, payload)
  VALUES (NEW.org_id, 'access-revoked', TG_TABLE_NAME, NEW.id,
    TG_TABLE_NAME || ':' || NEW.id, jsonb_build_object('sourceDocumentId', source_id))
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER source_grant_epoch AFTER INSERT ON source_grant_revocations
FOR EACH ROW EXECUTE FUNCTION bump_grant_access_epoch();

CREATE FUNCTION enforce_case_revision_identity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = grimoire, pg_temp
SET row_security = off
AS $$
DECLARE occ bom_occurrence_revisions%ROWTYPE; req requirement_revisions%ROWTYPE;
BEGIN
  SELECT * INTO STRICT occ FROM bom_occurrence_revisions
    WHERE (org_id,id) = (NEW.org_id,NEW.occurrence_revision_id);
  SELECT * INTO STRICT req FROM requirement_revisions
    WHERE (org_id,id) = (NEW.org_id,NEW.requirement_revision_id);
  IF occ.configuration_revision_id <> NEW.configuration_revision_id
     OR occ.component_revision_id <> NEW.component_revision_id
     OR req.occurrence_revision_id <> NEW.occurrence_revision_id
     OR req.component_revision_id <> NEW.component_revision_id THEN
    RAISE EXCEPTION USING ERRCODE = 'G1003',
      MESSAGE = 'case revision identity chain is inconsistent';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sourcing_case_revision_identity_guard
BEFORE INSERT ON sourcing_case_revisions
FOR EACH ROW EXECUTE FUNCTION enforce_case_revision_identity();

CREATE FUNCTION enforce_test_revision_identity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = grimoire, pg_temp
SET row_security = off
AS $$
DECLARE req requirement_revisions%ROWTYPE;
BEGIN
  SELECT * INTO STRICT req FROM requirement_revisions
    WHERE (org_id,id) = (NEW.org_id,NEW.requirement_revision_id);
  IF req.occurrence_revision_id <> NEW.occurrence_revision_id
     OR req.component_revision_id <> NEW.component_revision_id THEN
    RAISE EXCEPTION USING ERRCODE = 'G1004',
      MESSAGE = 'qualification test does not bind the requirement occurrence and component';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER qualification_test_revision_identity_guard
BEFORE INSERT ON qualification_test_revisions
FOR EACH ROW EXECUTE FUNCTION enforce_test_revision_identity();

CREATE FUNCTION enforce_supplier_offer_identity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = grimoire, pg_temp
SET row_security = off
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM supplier_sites s
    WHERE (s.org_id,s.id,s.supplier_entity_id) =
          (NEW.org_id,NEW.supplier_site_id,NEW.supplier_entity_id)
  ) OR NOT EXISTS (
    SELECT 1 FROM supplier_accounts a
    WHERE (a.org_id,a.id,a.supplier_entity_id) =
          (NEW.org_id,NEW.supplier_account_id,NEW.supplier_entity_id)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'G1005',
      MESSAGE = 'supplier site or account belongs to another legal entity';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER supplier_offer_identity_guard
BEFORE INSERT ON supplier_offers
FOR EACH ROW EXECUTE FUNCTION enforce_supplier_offer_identity();

CREATE FUNCTION enforce_offer_revision_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = grimoire, pg_temp
SET row_security = off
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM supplier_offers o
    JOIN source_document_revisions sr
      ON (sr.org_id,sr.id) = (NEW.org_id,NEW.source_revision_id)
    JOIN source_documents sd
      ON (sd.org_id,sd.id) = (sr.org_id,sr.source_document_id)
    WHERE (o.org_id,o.id) = (NEW.org_id,NEW.offer_id)
      AND sd.supplier_entity_id = o.supplier_entity_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'G1007',
      MESSAGE = 'offer source is not owned by the bound supplier legal entity';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER offer_revision_source_guard
BEFORE INSERT ON offer_revisions
FOR EACH ROW EXECUTE FUNCTION enforce_offer_revision_source();

CREATE FUNCTION enforce_decision_revision_bindings() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = grimoire, pg_temp
SET row_security = off
AS $$
DECLARE pkt decision_packet_revisions%ROWTYPE; cmp comparison_revisions%ROWTYPE;
BEGIN
  SELECT * INTO STRICT pkt FROM decision_packet_revisions
    WHERE (org_id,id) = (NEW.org_id,NEW.packet_revision_id);
  SELECT * INTO STRICT cmp FROM comparison_revisions
    WHERE (org_id,id) = (NEW.org_id,NEW.comparison_revision_id);
  IF pkt.case_revision_id <> NEW.case_revision_id
     OR pkt.requirement_revision_id <> NEW.requirement_revision_id
     OR pkt.comparison_revision_id <> NEW.comparison_revision_id
     OR cmp.sourcing_case_revision_id <> NEW.case_revision_id
     OR cmp.requirement_revision_id <> NEW.requirement_revision_id
     OR NOT EXISTS (
       SELECT 1 FROM offer_lines l
       WHERE (l.org_id,l.id,l.offer_revision_id) =
             (NEW.org_id,NEW.selected_offer_line_id,NEW.selected_offer_revision_id)
     ) OR NOT EXISTS (
       SELECT 1 FROM normalized_comparison_lines n
       WHERE (n.org_id,n.comparison_revision_id,n.offer_line_id,n.state) =
             (NEW.org_id,NEW.comparison_revision_id,NEW.selected_offer_line_id,'comparable')
     ) THEN
    RAISE EXCEPTION USING ERRCODE = 'G1006',
      MESSAGE = 'decision revision inputs do not bind one exact case and comparable selected line';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER decision_revision_binding_guard
BEFORE INSERT ON decision_revisions
FOR EACH ROW EXECUTE FUNCTION enforce_decision_revision_bindings();

CREATE FUNCTION enforce_decision_offer_input() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = grimoire, pg_temp
SET row_security = off
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM decision_revisions d
    JOIN sourcing_cases c ON (c.org_id,c.id) = (d.org_id,
      (SELECT sourcing_case_id FROM sourcing_case_revisions
       WHERE (org_id,id) = (d.org_id,d.case_revision_id)))
    JOIN offer_revisions r ON (r.org_id,r.id) = (NEW.org_id,NEW.offer_revision_id)
    JOIN supplier_offers o ON (o.org_id,o.id) = (r.org_id,r.offer_id)
    JOIN offer_lines l ON (l.org_id,l.id,l.offer_revision_id) =
      (NEW.org_id,NEW.offer_line_id,NEW.offer_revision_id)
    WHERE (d.org_id,d.id) = (NEW.org_id,NEW.decision_revision_id)
      AND o.sourcing_case_id = c.id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'G1008',
      MESSAGE = 'decision offer input is not an offer line for the same sourcing case';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER decision_offer_input_guard
BEFORE INSERT ON decision_offer_inputs
FOR EACH ROW EXECUTE FUNCTION enforce_decision_offer_input();

CREATE FUNCTION enforce_decision_qualification_input() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = grimoire, pg_temp
SET row_security = off
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM decision_revisions d
    JOIN qualification_test_revisions t
      ON (t.org_id,t.id) = (NEW.org_id,NEW.test_revision_id)
    JOIN test_result_revisions r
      ON (r.org_id,r.id) = (NEW.org_id,NEW.result_revision_id)
    JOIN qualification_test_executions e
      ON (e.org_id,e.id,e.test_revision_id) = (r.org_id,r.execution_id,t.id)
    WHERE (d.org_id,d.id) = (NEW.org_id,NEW.decision_revision_id)
      AND t.requirement_revision_id = d.requirement_revision_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'G1009',
      MESSAGE = 'decision qualification input is not a result for the bound test and requirement';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER decision_qualification_input_guard
BEFORE INSERT ON decision_qualification_inputs
FOR EACH ROW EXECUTE FUNCTION enforce_decision_qualification_input();

CREATE INDEX source_revisions_document_idx
  ON source_document_revisions(org_id, source_document_id, revision_no DESC);
CREATE INDEX claims_source_idx ON claims(org_id, source_revision_id, recorded_at);
CREATE INDEX test_results_execution_idx
  ON test_result_revisions(org_id, execution_id, revision_no DESC);
CREATE INDEX offer_revisions_offer_idx ON offer_revisions(org_id, offer_id, revision_no DESC);
CREATE INDEX offer_lines_revision_idx ON offer_lines(org_id, offer_revision_id, line_no);
CREATE INDEX artifact_inputs_source_idx
  ON artifact_source_inputs(org_id, source_revision_id, artifact_id);
CREATE INDEX comparison_lines_revision_idx
  ON normalized_comparison_lines(org_id, comparison_revision_id, state);
CREATE INDEX decision_offer_revision_idx
  ON decision_offer_inputs(org_id, offer_revision_id, decision_revision_id);
CREATE INDEX decision_result_idx
  ON decision_qualification_inputs(org_id, result_revision_id, decision_revision_id);
CREATE INDEX change_impacts_decision_idx
  ON change_impacts(org_id, decision_revision_id, recorded_at DESC);

CREATE FUNCTION audit_row_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = grimoire, pg_temp
SET row_security = off
AS $$
DECLARE
  before_row jsonb;
  after_row jsonb;
  selected_row jsonb;
  req uuid;
BEGIN
  req := nullif(current_setting('app.request_id', true), '')::uuid;
  IF req IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'G2006', MESSAGE = 'app.request_id is required';
  END IF;
  before_row := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) END;
  after_row := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN to_jsonb(NEW) END;
  selected_row := COALESCE(after_row,before_row);
  INSERT INTO audit_events(
    org_id,request_id,actor_id,action,object_type,object_id,before_hash,after_hash,metadata
  ) VALUES (
    (selected_row->>'org_id')::uuid, req, app.current_principal_id(), lower(TG_OP),
    TG_TABLE_NAME, COALESCE((selected_row->>'id')::uuid,(selected_row->>'org_id')::uuid),
    CASE WHEN before_row IS NULL THEN NULL ELSE encode(public.digest(before_row::text,'sha256'),'hex') END,
    CASE WHEN after_row IS NULL THEN NULL ELSE encode(public.digest(after_row::text,'sha256'),'hex') END,
    jsonb_build_object('schema','grimoire','table',TG_TABLE_NAME)
  );
  RETURN COALESCE(NEW,OLD);
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'principals','org_security_epochs','products','product_configurations',
    'product_configuration_revisions','components','component_revisions','bom_occurrences',
    'bom_occurrence_revisions','requirements','requirement_revisions','sourcing_cases',
    'sourcing_case_revisions','supplier_legal_entities','supplier_sites','supplier_accounts',
    'source_documents','source_document_revisions','source_access_events','source_grants',
    'source_grant_revocations','legal_holds','source_lifecycle_events','claims',
    'qualification_tests','qualification_test_revisions','qualification_test_executions',
    'test_result_revisions','test_result_reviews','supplier_offers','offer_revisions',
    'offer_lines','offer_line_identity_assessments','derived_artifacts','comparison_revisions',
    'normalized_comparison_lines','decision_packets','decision_packet_revisions','decisions',
    'decision_revisions','decision_approvals','approval_events','decision_state_events',
    'change_impacts','idempotency_records','outbox_events'
  ] LOOP
    EXECUTE format('CREATE TRIGGER %I_audit AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row_change()', t, t);
  END LOOP;
END $$;

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
    'normalized_comparison_lines','decision_packets','decision_packet_revisions',
    'decisions','decision_revisions','decision_offer_inputs','decision_qualification_inputs',
    'decision_approvals','approval_events','decision_state_events','change_impacts',
    'idempotency_records','outbox_events','audit_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I_tenant_select ON %I FOR SELECT USING (org_id = app.current_org_id())', t, t);
    EXECUTE format('CREATE POLICY %I_tenant_insert ON %I FOR INSERT WITH CHECK (org_id = app.current_org_id())', t, t);
    EXECUTE format('CREATE POLICY %I_tenant_update ON %I FOR UPDATE USING (org_id = app.current_org_id()) WITH CHECK (org_id = app.current_org_id())', t, t);
    EXECUTE format('CREATE POLICY %I_tenant_delete ON %I FOR DELETE USING (org_id = app.current_org_id())', t, t);
  END LOOP;
END $$;

DROP POLICY source_documents_tenant_select ON source_documents;
CREATE POLICY source_documents_authorized_select ON source_documents FOR SELECT
  USING (org_id = app.current_org_id() AND app.can_read_source(id));
DROP POLICY source_document_revisions_tenant_select ON source_document_revisions;
CREATE POLICY source_revisions_authorized_select ON source_document_revisions FOR SELECT
  USING (org_id = app.current_org_id() AND app.can_read_source(source_document_id));
DROP POLICY claims_tenant_select ON claims;
CREATE POLICY claims_authorized_select ON claims FOR SELECT USING (
  org_id = app.current_org_id() AND EXISTS (
    SELECT 1 FROM source_document_revisions sr
    WHERE (sr.org_id, sr.id) = (claims.org_id, claims.source_revision_id)
      AND app.can_read_source(sr.source_document_id)
  )
);
DROP POLICY derived_artifacts_tenant_select ON derived_artifacts;
CREATE POLICY derived_artifacts_authorized_select ON derived_artifacts FOR SELECT
  USING (org_id = app.current_org_id() AND app.can_read_artifact(id));
DROP POLICY comparison_revisions_tenant_select ON comparison_revisions;
CREATE POLICY comparison_authorized_select ON comparison_revisions FOR SELECT
  USING (org_id = app.current_org_id() AND app.can_read_artifact(artifact_id));
DROP POLICY decision_packet_revisions_tenant_select ON decision_packet_revisions;
CREATE POLICY packet_authorized_select ON decision_packet_revisions FOR SELECT
  USING (org_id = app.current_org_id() AND app.can_read_artifact(artifact_id));
DROP POLICY artifact_source_inputs_tenant_select ON artifact_source_inputs;
CREATE POLICY artifact_inputs_authorized_select ON artifact_source_inputs FOR SELECT
  USING (org_id = app.current_org_id() AND app.can_read_artifact(artifact_id));
DROP POLICY offer_revisions_tenant_select ON offer_revisions;
CREATE POLICY offer_revisions_authorized_select ON offer_revisions FOR SELECT USING (
  org_id = app.current_org_id() AND EXISTS (
    SELECT 1 FROM source_document_revisions sr
    WHERE (sr.org_id,sr.id) = (offer_revisions.org_id,offer_revisions.source_revision_id)
      AND app.can_read_source(sr.source_document_id)
  )
);
DROP POLICY offer_lines_tenant_select ON offer_lines;
CREATE POLICY offer_lines_authorized_select ON offer_lines FOR SELECT USING (
  org_id = app.current_org_id() AND EXISTS (
    SELECT 1 FROM offer_revisions r
    JOIN source_document_revisions sr ON (sr.org_id,sr.id) = (r.org_id,r.source_revision_id)
    WHERE (r.org_id,r.id) = (offer_lines.org_id,offer_lines.offer_revision_id)
      AND app.can_read_source(sr.source_document_id)
  )
);
DROP POLICY normalized_comparison_lines_tenant_select ON normalized_comparison_lines;
CREATE POLICY comparison_lines_authorized_select ON normalized_comparison_lines FOR SELECT USING (
  org_id = app.current_org_id() AND EXISTS (
    SELECT 1 FROM comparison_revisions c
    WHERE (c.org_id,c.id) =
          (normalized_comparison_lines.org_id,normalized_comparison_lines.comparison_revision_id)
      AND app.can_read_artifact(c.artifact_id)
  )
);
DROP POLICY offer_line_identity_assessments_tenant_select ON offer_line_identity_assessments;
CREATE POLICY offer_assessments_authorized_select ON offer_line_identity_assessments FOR SELECT USING (
  org_id = app.current_org_id() AND EXISTS (
    SELECT 1 FROM offer_lines l
    JOIN offer_revisions r ON (r.org_id,r.id) = (l.org_id,l.offer_revision_id)
    JOIN source_document_revisions sr ON (sr.org_id,sr.id) = (r.org_id,r.source_revision_id)
    WHERE (l.org_id,l.id) =
          (offer_line_identity_assessments.org_id,offer_line_identity_assessments.offer_line_id)
      AND app.can_read_source(sr.source_document_id)
  )
);
DROP POLICY test_result_revisions_tenant_select ON test_result_revisions;
CREATE POLICY result_revisions_authorized_select ON test_result_revisions FOR SELECT USING (
  org_id = app.current_org_id() AND EXISTS (
    SELECT 1 FROM source_document_revisions sr
    WHERE (sr.org_id,sr.id) = (test_result_revisions.org_id,test_result_revisions.source_revision_id)
      AND app.can_read_source(sr.source_document_id)
  )
);
DROP POLICY test_result_reviews_tenant_select ON test_result_reviews;
CREATE POLICY result_reviews_authorized_select ON test_result_reviews FOR SELECT USING (
  org_id = app.current_org_id() AND EXISTS (
    SELECT 1 FROM test_result_revisions r
    JOIN source_document_revisions sr ON (sr.org_id,sr.id) = (r.org_id,r.source_revision_id)
    WHERE (r.org_id,r.id) = (test_result_reviews.org_id,test_result_reviews.result_revision_id)
      AND app.can_read_source(sr.source_document_id)
  )
);
DROP POLICY decision_revisions_tenant_select ON decision_revisions;
CREATE POLICY decision_revisions_authorized_select ON decision_revisions FOR SELECT USING (
  org_id = app.current_org_id() AND EXISTS (
    SELECT 1 FROM decision_packet_revisions p
    WHERE (p.org_id,p.id) = (decision_revisions.org_id,decision_revisions.packet_revision_id)
      AND app.can_read_artifact(p.artifact_id)
  )
);
DROP POLICY decision_offer_inputs_tenant_select ON decision_offer_inputs;
CREATE POLICY decision_offer_inputs_authorized_select ON decision_offer_inputs FOR SELECT USING (
  org_id = app.current_org_id() AND EXISTS (
    SELECT 1 FROM decision_revisions d
    JOIN decision_packet_revisions p ON (p.org_id,p.id) = (d.org_id,d.packet_revision_id)
    WHERE (d.org_id,d.id) = (decision_offer_inputs.org_id,decision_offer_inputs.decision_revision_id)
      AND app.can_read_artifact(p.artifact_id)
  )
);
DROP POLICY decision_qualification_inputs_tenant_select ON decision_qualification_inputs;
CREATE POLICY decision_qualification_inputs_authorized_select ON decision_qualification_inputs FOR SELECT USING (
  org_id = app.current_org_id() AND EXISTS (
    SELECT 1 FROM decision_revisions d
    JOIN decision_packet_revisions p ON (p.org_id,p.id) = (d.org_id,d.packet_revision_id)
    WHERE (d.org_id,d.id) = (decision_qualification_inputs.org_id,decision_qualification_inputs.decision_revision_id)
      AND app.can_read_artifact(p.artifact_id)
  )
);
DROP POLICY claim_relations_tenant_select ON claim_relations;
CREATE POLICY claim_relations_authorized_select ON claim_relations FOR SELECT USING (
  org_id = app.current_org_id()
  AND EXISTS (SELECT 1 FROM claims c WHERE (c.org_id,c.id) = (claim_relations.org_id,claim_relations.left_claim_id))
  AND EXISTS (SELECT 1 FROM claims c WHERE (c.org_id,c.id) = (claim_relations.org_id,claim_relations.right_claim_id))
);
DROP POLICY source_access_events_tenant_select ON source_access_events;
CREATE POLICY source_access_admin_select ON source_access_events FOR SELECT USING (
  org_id = app.current_org_id() AND (app.has_role('records_officer') OR app.has_role('org_admin'))
);
DROP POLICY source_grants_tenant_select ON source_grants;
CREATE POLICY source_grants_admin_select ON source_grants FOR SELECT USING (
  org_id = app.current_org_id() AND
  (principal_id = app.current_principal_id() OR app.has_role('records_officer') OR app.has_role('org_admin'))
);
DROP POLICY source_grant_revocations_tenant_select ON source_grant_revocations;
CREATE POLICY source_grant_revocations_admin_select ON source_grant_revocations FOR SELECT USING (
  org_id = app.current_org_id() AND (app.has_role('records_officer') OR app.has_role('org_admin'))
);
DROP POLICY source_lifecycle_events_tenant_select ON source_lifecycle_events;
CREATE POLICY source_lifecycle_admin_select ON source_lifecycle_events FOR SELECT USING (
  org_id = app.current_org_id() AND (app.has_role('records_officer') OR app.has_role('org_admin'))
);
DROP POLICY legal_holds_tenant_select ON legal_holds;
CREATE POLICY legal_holds_admin_select ON legal_holds FOR SELECT USING (
  org_id = app.current_org_id() AND (app.has_role('records_officer') OR app.has_role('org_admin'))
);

REVOKE ALL ON SCHEMA grimoire FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA grimoire FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
GRANT USAGE ON SCHEMA grimoire, app TO grimoire_app, grimoire_worker;
GRANT SELECT ON ALL TABLES IN SCHEMA grimoire TO grimoire_app;
GRANT SELECT, INSERT, UPDATE ON idempotency_records TO grimoire_app;
GRANT SELECT, INSERT, UPDATE ON outbox_events TO grimoire_worker;
GRANT EXECUTE ON FUNCTION app.current_org_id(), app.current_principal_id(),
  app.has_role(actor_role), app.can_read_source(uuid), app.can_read_artifact(uuid)
  TO grimoire_app, grimoire_worker;

COMMIT;
