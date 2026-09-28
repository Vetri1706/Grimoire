-- Local installation ownership, human Handler sessions, and organization
-- onboarding. Additive application migration; accepted 0022/0023 stay unchanged.
BEGIN;
SET search_path = grimoire, public;

CREATE TABLE handler_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  login_name text NOT NULL UNIQUE
    CHECK (login_name ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
  password_hash text NOT NULL CHECK (password_hash LIKE '$2%'),
  identity_kind text NOT NULL DEFAULT 'human_handler'
    CHECK (identity_kind = 'human_handler'),
  is_installation_owner boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  disabled_at timestamptz
);

CREATE TABLE installation_setup (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  owner_identity_id uuid UNIQUE REFERENCES handler_identities(id),
  completed_at timestamptz,
  CHECK ((owner_identity_id IS NULL) = (completed_at IS NULL))
);
INSERT INTO installation_setup(singleton) VALUES (true);

CREATE TABLE handler_organization_memberships (
  identity_id uuid NOT NULL REFERENCES handler_identities(id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  principal_id uuid NOT NULL,
  membership_role text NOT NULL CHECK (membership_role = 'org_admin'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  disabled_at timestamptz,
  PRIMARY KEY (identity_id, org_id),
  UNIQUE (org_id, principal_id),
  FOREIGN KEY (org_id, principal_id) REFERENCES principals(org_id, id)
);

CREATE TABLE handler_sessions (
  token_sha256 text PRIMARY KEY CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  identity_id uuid NOT NULL REFERENCES handler_identities(id),
  active_org_id uuid REFERENCES organizations(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX handler_sessions_identity_active
  ON handler_sessions(identity_id, expires_at DESC)
  WHERE revoked_at IS NULL;

CREATE TABLE organization_creation_receipts (
  identity_id uuid NOT NULL REFERENCES handler_identities(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  org_id uuid NOT NULL REFERENCES organizations(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (identity_id, idempotency_key),
  UNIQUE (identity_id, org_id)
);

COMMENT ON TABLE installation_setup IS
  'Singleton installation-owner setup state. It is intentionally independent of organization count and seeded development workspaces.';
COMMENT ON TABLE handler_identities IS
  'Human local-installation identities only. Agent and seeded bearer credentials are not Handler identities.';
COMMENT ON TABLE handler_organization_memberships IS
  'Checked mapping from one human Handler identity to an organization-scoped principal. org_admin grants workspace management only.';
COMMENT ON TABLE handler_sessions IS
  'Hashed opaque server-managed browser sessions. The active organization is accepted only through a live checked membership.';
COMMENT ON TABLE organization_creation_receipts IS
  'Immutable retry receipts for atomic organization, epoch, principal, and org_admin membership creation.';

CREATE FUNCTION app.intake_installation_setup_required() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
  SELECT owner_identity_id IS NULL FROM grimoire.installation_setup WHERE singleton
$$;

CREATE FUNCTION app.intake_setup_owner(
  wanted_login text,
  wanted_display_name text,
  wanted_passphrase text,
  wanted_session_hash text,
  wanted_session_expiry timestamptz
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE
  existing_owner uuid;
  created_identity uuid;
BEGIN
  SELECT owner_identity_id INTO STRICT existing_owner
  FROM grimoire.installation_setup WHERE singleton FOR UPDATE;
  IF existing_owner IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE='G3501',MESSAGE='installation owner already configured';
  END IF;
  IF wanted_login !~ '^[a-z0-9][a-z0-9._-]{2,63}$'
    OR length(btrim(wanted_display_name)) NOT BETWEEN 1 AND 120
    OR octet_length(wanted_passphrase) NOT BETWEEN 12 AND 72
    OR wanted_session_hash !~ '^[0-9a-f]{64}$'
    OR wanted_session_expiry <= clock_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='invalid installation owner input';
  END IF;

  INSERT INTO grimoire.handler_identities(
    login_name,display_name,password_hash,is_installation_owner
  ) VALUES (
    wanted_login,btrim(wanted_display_name),
    public.crypt(wanted_passphrase,public.gen_salt('bf',12)),true
  ) RETURNING id INTO created_identity;

  INSERT INTO grimoire.handler_sessions(
    token_sha256,identity_id,active_org_id,expires_at
  ) VALUES (wanted_session_hash,created_identity,NULL,wanted_session_expiry);

  UPDATE grimoire.installation_setup
  SET owner_identity_id=created_identity,completed_at=clock_timestamp()
  WHERE singleton;
  RETURN created_identity;
END $$;

CREATE FUNCTION app.intake_login(
  wanted_login text,
  wanted_passphrase text,
  wanted_session_hash text,
  wanted_session_expiry timestamptz
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE
  matched_identity uuid;
  selected_org uuid;
BEGIN
  IF wanted_session_hash !~ '^[0-9a-f]{64}$'
    OR wanted_session_expiry <= clock_timestamp() THEN
    RETURN NULL;
  END IF;
  SELECT id INTO matched_identity
  FROM grimoire.handler_identities
  WHERE login_name=wanted_login AND disabled_at IS NULL
    AND password_hash=public.crypt(wanted_passphrase,password_hash);
  IF matched_identity IS NULL THEN RETURN NULL; END IF;

  SELECT m.org_id INTO selected_org
  FROM grimoire.handler_organization_memberships m
  JOIN grimoire.principals p ON (p.org_id,p.id)=(m.org_id,m.principal_id)
  WHERE m.identity_id=matched_identity AND m.disabled_at IS NULL
    AND p.disabled_at IS NULL
  ORDER BY m.created_at,m.org_id LIMIT 1;

  INSERT INTO grimoire.handler_sessions(
    token_sha256,identity_id,active_org_id,expires_at
  ) VALUES (wanted_session_hash,matched_identity,selected_org,wanted_session_expiry);
  RETURN matched_identity;
END $$;

CREATE FUNCTION app.intake_session_context(wanted_session_hash text)
RETURNS TABLE (
  identity_id uuid,
  login_name text,
  handler_display_name text,
  installation_owner boolean,
  principal_id uuid,
  org_id uuid,
  organization_name text,
  can_write boolean
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
  SELECT h.id,h.login_name,h.display_name,h.is_installation_owner,
    p.id,o.id,o.name::text,(pr.role='org_admin'::grimoire.actor_role)
  FROM grimoire.handler_sessions s
  JOIN grimoire.handler_identities h ON h.id=s.identity_id
  LEFT JOIN grimoire.handler_organization_memberships m
    ON (m.identity_id,m.org_id)=(s.identity_id,s.active_org_id)
    AND m.disabled_at IS NULL
  LEFT JOIN grimoire.principals p
    ON (p.org_id,p.id)=(m.org_id,m.principal_id) AND p.disabled_at IS NULL
  LEFT JOIN grimoire.principal_roles pr
    ON (pr.org_id,pr.principal_id,pr.role)=(p.org_id,p.id,'org_admin'::grimoire.actor_role)
  LEFT JOIN grimoire.organizations o ON o.id=m.org_id
  WHERE s.token_sha256=wanted_session_hash AND s.revoked_at IS NULL
    AND s.expires_at>clock_timestamp() AND h.disabled_at IS NULL
$$;

CREATE FUNCTION app.intake_session_organizations(wanted_session_hash text)
RETURNS TABLE (org_id uuid, organization_name text, is_active boolean, joined_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
  SELECT o.id,o.name::text,(o.id=s.active_org_id),m.created_at
  FROM grimoire.handler_sessions s
  JOIN grimoire.handler_identities h ON h.id=s.identity_id AND h.disabled_at IS NULL
  JOIN grimoire.handler_organization_memberships m
    ON m.identity_id=s.identity_id AND m.disabled_at IS NULL
  JOIN grimoire.principals p
    ON (p.org_id,p.id)=(m.org_id,m.principal_id) AND p.disabled_at IS NULL
  JOIN grimoire.principal_roles pr
    ON (pr.org_id,pr.principal_id,pr.role)=(p.org_id,p.id,'org_admin'::grimoire.actor_role)
  JOIN grimoire.organizations o ON o.id=m.org_id
  WHERE s.token_sha256=wanted_session_hash AND s.revoked_at IS NULL
    AND s.expires_at>clock_timestamp()
  ORDER BY m.created_at,m.org_id
$$;

CREATE FUNCTION app.intake_session_authenticate(wanted_session_hash text)
RETURNS TABLE (
  principal_id uuid, org_id uuid, display_name text,
  organization_name text, can_write boolean
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
  SELECT p.id,o.id,p.display_name::text,o.name::text,true
  FROM grimoire.handler_sessions s
  JOIN grimoire.handler_identities h ON h.id=s.identity_id AND h.disabled_at IS NULL
  JOIN grimoire.handler_organization_memberships m
    ON (m.identity_id,m.org_id)=(s.identity_id,s.active_org_id)
    AND m.disabled_at IS NULL
  JOIN grimoire.principals p
    ON (p.org_id,p.id)=(m.org_id,m.principal_id) AND p.disabled_at IS NULL
  JOIN grimoire.principal_roles pr
    ON (pr.org_id,pr.principal_id,pr.role)=(p.org_id,p.id,'org_admin'::grimoire.actor_role)
  JOIN grimoire.organizations o ON o.id=m.org_id
  WHERE s.token_sha256=wanted_session_hash AND s.revoked_at IS NULL
    AND s.expires_at>clock_timestamp()
$$;

CREATE FUNCTION app.intake_switch_organization(
  wanted_session_hash text,wanted_org uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE changed integer;
BEGIN
  UPDATE grimoire.handler_sessions s SET active_org_id=wanted_org
  WHERE s.token_sha256=wanted_session_hash AND s.revoked_at IS NULL
    AND s.expires_at>clock_timestamp()
    AND EXISTS (
      SELECT 1
      FROM grimoire.handler_organization_memberships m
      JOIN grimoire.principals p
        ON (p.org_id,p.id)=(m.org_id,m.principal_id) AND p.disabled_at IS NULL
      JOIN grimoire.principal_roles pr
        ON (pr.org_id,pr.principal_id,pr.role)=(p.org_id,p.id,'org_admin'::grimoire.actor_role)
      WHERE (m.identity_id,m.org_id)=(s.identity_id,wanted_org)
        AND m.disabled_at IS NULL
    );
  GET DIAGNOSTICS changed=ROW_COUNT;
  RETURN changed=1;
END $$;

CREATE FUNCTION app.intake_create_organization(
  wanted_session_hash text,
  wanted_key text,
  wanted_request_hash text,
  wanted_name text
) RETURNS TABLE (org_id uuid, replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE
  session_identity uuid;
  identity_display text;
  existing_receipt record;
  created_org uuid;
  created_principal uuid;
BEGIN
  SELECT s.identity_id,h.display_name INTO session_identity,identity_display
  FROM grimoire.handler_sessions s
  JOIN grimoire.handler_identities h ON h.id=s.identity_id
  WHERE s.token_sha256=wanted_session_hash AND s.revoked_at IS NULL
    AND s.expires_at>clock_timestamp() AND h.disabled_at IS NULL
  FOR UPDATE OF s;
  IF session_identity IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='valid human Handler session required';
  END IF;
  IF length(wanted_key) NOT BETWEEN 1 AND 128
    OR wanted_request_hash !~ '^[0-9a-f]{64}$'
    OR length(btrim(wanted_name)) NOT BETWEEN 1 AND 160 THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='invalid organization creation input';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(session_identity::text||':'||wanted_key,0)
  );
  SELECT r.request_sha256,r.org_id INTO existing_receipt
  FROM grimoire.organization_creation_receipts r
  WHERE (r.identity_id,r.idempotency_key)=(session_identity,wanted_key);
  IF FOUND THEN
    IF existing_receipt.request_sha256<>wanted_request_hash THEN
      RAISE EXCEPTION USING ERRCODE='G3502',MESSAGE='organization idempotency key reused';
    END IF;
    UPDATE grimoire.handler_sessions SET active_org_id=existing_receipt.org_id
    WHERE token_sha256=wanted_session_hash;
    RETURN QUERY SELECT existing_receipt.org_id,true;
    RETURN;
  END IF;

  INSERT INTO grimoire.organizations(name) VALUES (btrim(wanted_name))
  RETURNING id INTO created_org;
  -- The accepted GG-40 audit triggers require explicit request context for
  -- principal, role, and security-epoch writes. The first principal does not
  -- exist yet, so its creation/initial epoch events correctly have no actor;
  -- the role grant below is attributed after the principal is available.
  PERFORM pg_catalog.set_config('app.current_org_id',created_org::text,true);
  PERFORM pg_catalog.set_config('app.request_id',gen_random_uuid()::text,true);
  PERFORM pg_catalog.set_config('app.effective_role','installation_owner',true);
  PERFORM pg_catalog.set_config('app.endpoint_scope','organization:create',true);
  PERFORM pg_catalog.set_config('app.input_hash',wanted_request_hash,true);
  PERFORM pg_catalog.set_config('app.action_reason','Create an empty organization workspace and its administrative membership',true);
  PERFORM pg_catalog.set_config('app.action_outcome','committed',true);
  INSERT INTO grimoire.org_security_epochs(org_id) VALUES (created_org);
  INSERT INTO grimoire.principals(org_id,external_subject,display_name)
  VALUES (created_org,'handler:'||session_identity::text,identity_display)
  RETURNING id INTO created_principal;
  PERFORM pg_catalog.set_config('app.current_principal_id',created_principal::text,true);
  INSERT INTO grimoire.principal_roles(org_id,principal_id,role)
  VALUES (created_org,created_principal,'org_admin');
  INSERT INTO grimoire.handler_organization_memberships(
    identity_id,org_id,principal_id,membership_role
  ) VALUES (session_identity,created_org,created_principal,'org_admin');
  INSERT INTO grimoire.organization_creation_receipts(
    identity_id,idempotency_key,request_sha256,org_id
  ) VALUES (session_identity,wanted_key,wanted_request_hash,created_org);
  UPDATE grimoire.handler_sessions SET active_org_id=created_org
  WHERE token_sha256=wanted_session_hash;
  RETURN QUERY SELECT created_org,false;
END $$;

CREATE FUNCTION app.intake_revoke_session(wanted_session_hash text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE changed integer;
BEGIN
  UPDATE grimoire.handler_sessions SET revoked_at=clock_timestamp()
  WHERE token_sha256=wanted_session_hash AND revoked_at IS NULL;
  GET DIAGNOSTICS changed=ROW_COUNT;
  RETURN changed=1;
END $$;

-- Separate ordinary workspace administration from sourcing preparation. The
-- original Layer 1 function grouped org_admin and procurement_preparer because
-- there was no self-service organization owner yet. New owners may manage
-- Scion intake records, but source, scope, offer, engineering, commercial, and
-- approval surfaces continue to require their separately enrolled roles.
CREATE OR REPLACE FUNCTION app.intake_can_write() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=grimoire,pg_temp SET row_security=off AS $$
  SELECT EXISTS (
    SELECT 1 FROM principals p JOIN principal_roles r
      ON (p.org_id,p.id)=(r.org_id,r.principal_id)
    WHERE (p.org_id,p.id)=(app.current_org_id(),app.current_principal_id())
      AND p.disabled_at IS NULL AND r.role='procurement_preparer'
  )
$$;

CREATE FUNCTION app.intake_can_manage_workspace() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=grimoire,pg_temp SET row_security=off AS $$
  SELECT EXISTS (
    SELECT 1 FROM principals p JOIN principal_roles r
      ON (p.org_id,p.id)=(r.org_id,r.principal_id)
    WHERE (p.org_id,p.id)=(app.current_org_id(),app.current_principal_id())
      AND p.disabled_at IS NULL
      AND r.role IN ('org_admin','procurement_preparer')
  )
$$;

CREATE OR REPLACE FUNCTION intake_guard_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path=grimoire,pg_temp AS $$
DECLARE current_number integer; item jsonb;
BEGIN
  IF NEW.org_id IS DISTINCT FROM app.current_org_id()
    OR NEW.created_by IS DISTINCT FROM app.current_principal_id()
    OR NOT app.intake_can_manage_workspace() THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='intake write is not authorized';
  END IF;
  SELECT current_revision INTO STRICT current_number FROM intake_scions
    WHERE (org_id,id)=(NEW.org_id,NEW.scion_id) FOR UPDATE;
  IF NEW.number<>current_number+1 THEN
    RAISE EXCEPTION USING ERRCODE='G2402',MESSAGE='revision must follow current revision';
  END IF;
  FOR item IN
    SELECT value FROM jsonb_array_elements(COALESCE(NEW.requirements,'[]'::jsonb))
    UNION ALL
    SELECT value FROM jsonb_array_elements(COALESCE(NEW.questions,'[]'::jsonb))
  LOOP
    IF jsonb_typeof(item)<>'string'
      OR length(btrim(item#>>'{}')) NOT BETWEEN 1 AND 2000 THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='intake lists must contain nonempty bounded strings';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

DROP POLICY intake_scion_create ON intake_scions;
CREATE POLICY intake_scion_create ON intake_scions FOR INSERT TO grimoire_intake_app
WITH CHECK (
  org_id=app.current_org_id() AND created_by=app.current_principal_id()
  AND current_revision=0 AND app.intake_can_manage_workspace()
);
DROP POLICY intake_scion_lock ON intake_scions;
CREATE POLICY intake_scion_lock ON intake_scions FOR UPDATE TO grimoire_intake_app
USING (org_id=app.current_org_id() AND app.intake_can_manage_workspace())
WITH CHECK (org_id=app.current_org_id() AND app.intake_can_manage_workspace());
DROP POLICY intake_revision_create ON intake_revisions;
CREATE POLICY intake_revision_create ON intake_revisions FOR INSERT TO grimoire_intake_app
WITH CHECK (
  org_id=app.current_org_id() AND created_by=app.current_principal_id()
  AND app.intake_can_manage_workspace()
);
DROP POLICY intake_retry_create ON intake_idempotency;
CREATE POLICY intake_retry_create ON intake_idempotency FOR INSERT TO grimoire_intake_app
WITH CHECK (
  org_id=app.current_org_id() AND principal_id=app.current_principal_id()
  AND app.intake_can_manage_workspace()
);

CREATE TRIGGER organization_creation_receipts_immutable
BEFORE UPDATE OR DELETE ON organization_creation_receipts
FOR EACH ROW EXECUTE FUNCTION intake_deny_mutation();

REVOKE ALL ON handler_identities,installation_setup,
  handler_organization_memberships,handler_sessions,
  organization_creation_receipts FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION
  app.intake_installation_setup_required(),
  app.intake_setup_owner(text,text,text,text,timestamptz),
  app.intake_login(text,text,text,timestamptz),
  app.intake_session_context(text),
  app.intake_session_organizations(text),
  app.intake_session_authenticate(text),
  app.intake_switch_organization(text,uuid),
  app.intake_create_organization(text,text,text,text),
  app.intake_revoke_session(text),
  app.intake_can_manage_workspace()
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  app.intake_installation_setup_required(),
  app.intake_setup_owner(text,text,text,text,timestamptz),
  app.intake_login(text,text,text,timestamptz),
  app.intake_session_context(text),
  app.intake_session_organizations(text),
  app.intake_session_authenticate(text),
  app.intake_switch_organization(text,uuid),
  app.intake_create_organization(text,text,text,text),
  app.intake_revoke_session(text),
  app.intake_can_manage_workspace()
TO grimoire_intake_app;

COMMIT;
