-- Independent human signup does not claim installation ownership or inherit
-- existing organization memberships. Organizations are created separately by
-- the existing session-bound, idempotent onboarding operation.
BEGIN;
SET search_path = grimoire, public;

CREATE FUNCTION app.intake_register_handler(
  wanted_login text,
  wanted_display_name text,
  wanted_passphrase text,
  wanted_session_hash text,
  wanted_session_expiry timestamptz
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE created_identity uuid;
BEGIN
  -- IS NOT TRUE also rejects NULL arguments for direct runtime-role callers.
  IF (
    wanted_login ~ '^[a-z0-9][a-z0-9._-]{2,63}$'
    AND length(btrim(wanted_display_name)) BETWEEN 1 AND 120
    AND octet_length(wanted_passphrase) BETWEEN 12 AND 72
    AND octet_length(wanted_passphrase)=length(wanted_passphrase)
    AND wanted_session_hash ~ '^[0-9a-f]{64}$'
    AND wanted_session_expiry > clock_timestamp()
    AND wanted_session_expiry <= clock_timestamp()+interval '30 days'
  ) IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='invalid Handler registration input';
  END IF;

  INSERT INTO grimoire.handler_identities(
    login_name,display_name,password_hash,is_installation_owner
  ) VALUES (
    wanted_login,btrim(wanted_display_name),
    public.crypt(wanted_passphrase,public.gen_salt('bf',12)),false
  ) RETURNING id INTO created_identity;

  INSERT INTO grimoire.handler_sessions(
    token_sha256,identity_id,active_org_id,expires_at
  ) VALUES (wanted_session_hash,created_identity,NULL,wanted_session_expiry);
  RETURN created_identity;
END $$;

REVOKE EXECUTE ON FUNCTION
  app.intake_register_handler(text,text,text,text,timestamptz)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  app.intake_register_handler(text,text,text,text,timestamptz)
TO grimoire_intake_app;

COMMENT ON FUNCTION app.intake_register_handler(text,text,text,text,timestamptz) IS
  'Creates an independent human Handler with a hashed session, no memberships and no installation-owner authority. Signup never claims the setup singleton.';

COMMIT;
