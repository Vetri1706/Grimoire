-- A Handler may change their own directory label through an authenticated
-- session. Membership, identity kind, role, credentials and immutable work
-- records are deliberately outside this operation.
BEGIN;

CREATE FUNCTION app.intake_update_handler_profile(
  wanted_session_hash text, wanted_display_name text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE wanted_identity uuid; membership record;
BEGIN
  IF wanted_session_hash IS NULL OR wanted_session_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN false;
  END IF;
  IF wanted_display_name IS NULL OR length(btrim(wanted_display_name)) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='invalid Handler display name';
  END IF;
  -- Row locks serialize revocation/disable with the update. No client-supplied
  -- identity or organization can choose whose profile is changed.
  SELECT h.id INTO wanted_identity
    FROM grimoire.handler_sessions s
    JOIN grimoire.handler_identities h ON h.id=s.identity_id
    WHERE s.token_sha256=wanted_session_hash AND s.revoked_at IS NULL
      AND s.expires_at>clock_timestamp() AND h.disabled_at IS NULL
    FOR UPDATE OF s,h;
  IF wanted_identity IS NULL THEN RETURN false; END IF;
  UPDATE grimoire.handler_identities SET display_name=btrim(wanted_display_name)
    WHERE id=wanted_identity AND display_name IS DISTINCT FROM btrim(wanted_display_name);
  -- Directory rows already carry audit triggers. Establish their context here
  -- from checked ownership, never from caller-provided GUCs or organization IDs.
  PERFORM set_config('app.request_id',gen_random_uuid()::text,true);
  PERFORM set_config('app.effective_role','handler_self_service',true);
  PERFORM set_config('app.endpoint_scope','session:profile',true);
  PERFORM set_config('app.input_hash',encode(public.digest(jsonb_build_object('display_name',btrim(wanted_display_name))::text,'sha256'),'hex'),true);
  PERFORM set_config('app.action_reason','Update own Handler directory display name',true);
  PERFORM set_config('app.action_outcome','committed',true);
  FOR membership IN SELECT org_id,principal_id FROM grimoire.handler_organization_memberships
    WHERE identity_id=wanted_identity ORDER BY org_id LOOP
    PERFORM set_config('app.current_org_id',membership.org_id::text,true);
    PERFORM set_config('app.current_principal_id',membership.principal_id::text,true);
    UPDATE grimoire.principals SET display_name=btrim(wanted_display_name)
      WHERE (org_id,id)=(membership.org_id,membership.principal_id)
        AND display_name IS DISTINCT FROM btrim(wanted_display_name);
  END LOOP;
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION app.intake_update_handler_profile(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.intake_update_handler_profile(text,text) TO grimoire_intake_app;

COMMIT;
