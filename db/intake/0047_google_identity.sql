-- Google authenticates a subject; Grimoire owns the resulting session and
-- organization authorization. Email is never an account-linking identifier.
BEGIN;
SET search_path=grimoire,public;

ALTER TABLE handler_identities ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE handler_identities ADD COLUMN auth_method text NOT NULL DEFAULT 'password';
ALTER TABLE handler_identities ADD CONSTRAINT handler_identity_auth_method
  CHECK ((auth_method='password' AND password_hash IS NOT NULL)
    OR (auth_method='google' AND password_hash IS NULL AND NOT is_installation_owner));
ALTER TABLE handler_identities ADD CONSTRAINT handler_identity_id_auth_method UNIQUE(id,auth_method);

CREATE TABLE handler_google_identities (
  google_subject text PRIMARY KEY CHECK (length(google_subject) BETWEEN 1 AND 255
    AND btrim(google_subject)=google_subject AND google_subject !~ '[[:cntrl:]]'),
  identity_id uuid NOT NULL UNIQUE,
  auth_method text NOT NULL DEFAULT 'google' CHECK (auth_method='google'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(identity_id,auth_method) REFERENCES handler_identities(id,auth_method)
);

CREATE TABLE handler_google_challenges (
  cookie_sha256 text PRIMARY KEY CHECK (cookie_sha256 ~ '^[0-9a-f]{64}$'),
  nonce_sha256 text NOT NULL CHECK (nonce_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at>created_at AND expires_at<=created_at+interval '5 minutes')
);
CREATE INDEX handler_google_challenges_expiry ON handler_google_challenges(expires_at);

COMMENT ON TABLE handler_google_identities IS
  'Verified Google subject to independent human Handler identity. No email matching, installation ownership, or inherited memberships.';
COMMENT ON TABLE handler_google_challenges IS
  'Five-minute, one-use Google browser challenges. Only SHA-256 digests of the separate HttpOnly cookie and GIS nonce are stored.';

CREATE FUNCTION app.intake_google_challenge_create(
  wanted_cookie_hash text,wanted_nonce_hash text,wanted_expiry timestamptz,previous_cookie_hash text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
BEGIN
  IF (wanted_cookie_hash ~ '^[0-9a-f]{64}$'
    AND wanted_nonce_hash ~ '^[0-9a-f]{64}$'
    AND wanted_expiry>clock_timestamp()
    AND wanted_expiry<=clock_timestamp()+interval '5 minutes'
    AND (previous_cookie_hash IS NULL OR previous_cookie_hash ~ '^[0-9a-f]{64}$')) IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='invalid Google challenge bounds';
  END IF;
  -- Serialize cleanup and the cap so parallel anonymous requests cannot exceed
  -- the global outstanding-challenge bound. Repeated starts replace this browser's challenge.
  PERFORM pg_advisory_xact_lock(hashtextextended('grimoire-google-challenge-cap',47));
  DELETE FROM grimoire.handler_google_challenges
    WHERE expires_at<=clock_timestamp() OR cookie_sha256=previous_cookie_hash;
  IF (SELECT count(*) FROM grimoire.handler_google_challenges)>=1024 THEN RETURN false; END IF;
  INSERT INTO grimoire.handler_google_challenges(cookie_sha256,nonce_sha256,expires_at)
    VALUES(wanted_cookie_hash,wanted_nonce_hash,wanted_expiry);
  RETURN true;
END $$;

CREATE FUNCTION app.intake_google_challenge_nonce(wanted_cookie_hash text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
  SELECT nonce_sha256 FROM grimoire.handler_google_challenges
    WHERE cookie_sha256=wanted_cookie_hash AND expires_at>clock_timestamp()
$$;

CREATE FUNCTION app.intake_google_challenge_revoke(wanted_cookie_hash text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE changed integer;
BEGIN
  DELETE FROM grimoire.handler_google_challenges WHERE cookie_sha256=wanted_cookie_hash;
  GET DIAGNOSTICS changed=ROW_COUNT;
  RETURN changed=1;
END $$;

CREATE FUNCTION app.intake_google_login(
  wanted_cookie_hash text,wanted_nonce_hash text,verified_google_subject text,
  wanted_display_name text,wanted_session_hash text,wanted_session_expiry timestamptz
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE matched_identity uuid; selected_org uuid; changed integer;
BEGIN
  IF (wanted_cookie_hash ~ '^[0-9a-f]{64}$'
    AND wanted_nonce_hash ~ '^[0-9a-f]{64}$'
    AND length(verified_google_subject) BETWEEN 1 AND 255
    AND btrim(verified_google_subject)=verified_google_subject
    AND verified_google_subject !~ '[[:cntrl:]]'
    AND length(btrim(wanted_display_name)) BETWEEN 1 AND 120
    AND wanted_session_hash ~ '^[0-9a-f]{64}$'
    AND wanted_session_expiry>clock_timestamp()
    AND wanted_session_expiry<=clock_timestamp()+interval '30 days') IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='invalid Google session bounds';
  END IF;
  -- This function is called only after the Rust API has verified Google's
  -- signature, issuer, audience, expiry and the challenge's nonce digest.
  DELETE FROM grimoire.handler_google_challenges
    WHERE cookie_sha256=wanted_cookie_hash AND nonce_sha256=wanted_nonce_hash
      AND expires_at>clock_timestamp();
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed<>1 THEN RETURN NULL; END IF;

  -- Different browser challenges for the same new subject must create exactly
  -- one identity, including concurrent requests from separate connections.
  PERFORM pg_advisory_xact_lock(hashtextextended('grimoire-google-sub:'||verified_google_subject,47));
  SELECT g.identity_id INTO matched_identity FROM grimoire.handler_google_identities g
    WHERE g.google_subject=verified_google_subject;
  IF matched_identity IS NULL THEN
    INSERT INTO grimoire.handler_identities(login_name,display_name,password_hash,auth_method,is_installation_owner)
      VALUES('g_'||replace(gen_random_uuid()::text,'-',''),btrim(wanted_display_name),NULL,'google',false)
      RETURNING id INTO matched_identity;
    INSERT INTO grimoire.handler_google_identities(google_subject,identity_id)
      VALUES(verified_google_subject,matched_identity);
  ELSIF NOT EXISTS(SELECT 1 FROM grimoire.handler_identities
      WHERE id=matched_identity AND auth_method='google' AND disabled_at IS NULL) THEN
    RETURN NULL;
  END IF;
  SELECT m.org_id INTO selected_org
    FROM grimoire.handler_organization_memberships m
    JOIN grimoire.principals p ON (p.org_id,p.id)=(m.org_id,m.principal_id) AND p.disabled_at IS NULL
    JOIN grimoire.principal_roles r ON (r.org_id,r.principal_id,r.role)=(p.org_id,p.id,'org_admin'::grimoire.actor_role)
    WHERE m.identity_id=matched_identity AND m.disabled_at IS NULL
    ORDER BY m.created_at,m.org_id LIMIT 1;
  INSERT INTO grimoire.handler_sessions(token_sha256,identity_id,active_org_id,expires_at)
    VALUES(wanted_session_hash,matched_identity,selected_org,wanted_session_expiry);
  RETURN matched_identity;
END $$;

-- Password identities remain separate. A Google identity has no password hash
-- and can never authenticate by guessing or supplying its generated login name.
CREATE OR REPLACE FUNCTION app.intake_login(
  wanted_login text,wanted_passphrase text,wanted_session_hash text,wanted_session_expiry timestamptz
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE matched_identity uuid; selected_org uuid;
BEGIN
  IF (wanted_login ~ '^[a-z0-9][a-z0-9._-]{2,63}$'
    AND octet_length(wanted_passphrase) BETWEEN 12 AND 72
    AND wanted_session_hash ~ '^[0-9a-f]{64}$'
    AND wanted_session_expiry>clock_timestamp()
    AND wanted_session_expiry<=clock_timestamp()+interval '30 days') IS NOT TRUE THEN RETURN NULL; END IF;
  SELECT id INTO matched_identity FROM grimoire.handler_identities
    WHERE login_name=wanted_login AND disabled_at IS NULL AND auth_method='password'
      AND password_hash=public.crypt(wanted_passphrase,password_hash);
  IF matched_identity IS NULL THEN RETURN NULL; END IF;
  SELECT m.org_id INTO selected_org
    FROM grimoire.handler_organization_memberships m
    JOIN grimoire.principals p ON (p.org_id,p.id)=(m.org_id,m.principal_id) AND p.disabled_at IS NULL
    JOIN grimoire.principal_roles r ON (r.org_id,r.principal_id,r.role)=(p.org_id,p.id,'org_admin'::grimoire.actor_role)
    WHERE m.identity_id=matched_identity AND m.disabled_at IS NULL
    ORDER BY m.created_at,m.org_id LIMIT 1;
  INSERT INTO grimoire.handler_sessions(token_sha256,identity_id,active_org_id,expires_at)
    VALUES(wanted_session_hash,matched_identity,selected_org,wanted_session_expiry);
  RETURN matched_identity;
END $$;

REVOKE ALL ON handler_google_identities,handler_google_challenges FROM PUBLIC,grimoire_intake_app;
REVOKE EXECUTE ON FUNCTION
  app.intake_google_challenge_create(text,text,timestamptz,text),
  app.intake_google_challenge_nonce(text),
  app.intake_google_challenge_revoke(text),
  app.intake_google_login(text,text,text,text,text,timestamptz)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  app.intake_google_challenge_create(text,text,timestamptz,text),
  app.intake_google_challenge_nonce(text),
  app.intake_google_challenge_revoke(text),
  app.intake_google_login(text,text,text,text,text,timestamptz)
TO grimoire_intake_app;

COMMIT;
