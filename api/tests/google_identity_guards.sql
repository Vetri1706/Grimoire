-- Migration-owner only, disposable *_test database. Every synthetic fixture and
-- successful/denied operation rolls back. JWT authenticity is tested in Rust;
-- these guards test the database boundary after a verified Google subject.
BEGIN;
SET LOCAL search_path=pg_catalog,grimoire,pg_temp;
DO $$
DECLARE table_name text;
BEGIN
  IF current_database() NOT LIKE '%\_test' ESCAPE '\' THEN
    RAISE EXCEPTION 'Google identity guards require a disposable _test database';
  END IF;
  FOREACH table_name IN ARRAY ARRAY['handler_identities','handler_google_identities','handler_google_challenges','handler_sessions'] LOOP
    IF has_table_privilege('grimoire_intake_app','grimoire.'||table_name,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') THEN
      RAISE EXCEPTION 'runtime has direct Google identity/session access: %',table_name;
    END IF;
  END LOOP;
  IF EXISTS(
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace,
      LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
    WHERE n.nspname='app' AND p.proname LIKE 'intake_google_%'
      AND a.grantee=0 AND a.privilege_type='EXECUTE'
  ) THEN RAISE EXCEPTION 'Google function exposed to PUBLIC'; END IF;
  PERFORM set_config('test.google.owner',COALESCE((SELECT owner_identity_id::text FROM grimoire.installation_setup WHERE singleton),''),true);
  PERFORM set_config('test.google.scope_count',(SELECT count(*)::text FROM grimoire.intake_scope_confirmations),true);
  PERFORM set_config('test.google.comparison_count',(SELECT count(*)::text FROM grimoire.intake_comparison_confirmations),true);
  RAISE NOTICE 'PASS Google identity and challenge tables have no runtime or PUBLIC direct access';
END $$;

SET LOCAL ROLE grimoire_intake_app;
DO $$
DECLARE
  subject text:='synthetic-google-'||gen_random_uuid()::text;
  second_subject text:='synthetic-google-'||gen_random_uuid()::text;
  challenge text:=encode(public.digest(gen_random_uuid()::text,'sha256'),'hex');
  second_challenge text:=encode(public.digest(gen_random_uuid()::text,'sha256'),'hex');
  nonce text:=encode(public.digest(gen_random_uuid()::text,'sha256'),'hex');
  second_nonce text:=encode(public.digest(gen_random_uuid()::text,'sha256'),'hex');
  first_session text:=encode(public.digest(gen_random_uuid()::text,'sha256'),'hex');
  second_session text:=encode(public.digest(gen_random_uuid()::text,'sha256'),'hex');
  replay_session text:=encode(public.digest(gen_random_uuid()::text,'sha256'),'hex');
  foreign_session text:=encode(public.digest(gen_random_uuid()::text,'sha256'),'hex');
  password_session text:=encode(public.digest(gen_random_uuid()::text,'sha256'),'hex');
  password_login text:='google_guard_'||replace(gen_random_uuid()::text,'-','');
  expiry timestamptz:=clock_timestamp()+interval '1 hour';
  first_identity uuid; same_identity uuid; second_identity uuid; password_identity uuid;
  first_org uuid; second_org uuid; context record; denied boolean; invalid_field integer;
BEGIN
  password_identity:=app.intake_register_handler(password_login,'Identical synthetic display name',
    'synthetic Google guard passphrase',password_session,expiry);
  IF app.intake_google_login(challenge,nonce,subject,'Identical synthetic display name',first_session,expiry) IS NOT NULL THEN
    RAISE EXCEPTION 'Google identity created without a live challenge';
  END IF;
  IF NOT app.intake_google_challenge_create(challenge,nonce,clock_timestamp()+interval '4 minutes',NULL) THEN
    RAISE EXCEPTION 'Google challenge could not be created';
  END IF;
  IF app.intake_google_challenge_nonce(challenge) IS DISTINCT FROM nonce THEN
    RAISE EXCEPTION 'Google challenge not persisted';
  END IF;
  IF app.intake_google_login(challenge,second_nonce,subject,'Synthetic Handler',first_session,expiry) IS NOT NULL
    OR app.intake_google_challenge_nonce(challenge) IS DISTINCT FROM nonce THEN
    RAISE EXCEPTION 'wrong nonce authenticated or consumed the actual challenge';
  END IF;
  first_identity:=app.intake_google_login(challenge,nonce,subject,'Identical synthetic display name',first_session,expiry);
  IF first_identity IS NULL OR first_identity=password_identity THEN RAISE EXCEPTION 'Google identity linked to a password identity'; END IF;
  SELECT * INTO STRICT context FROM app.intake_session_context(first_session);
  IF context.identity_id<>first_identity OR context.installation_owner IS DISTINCT FROM false
    OR context.org_id IS NOT NULL OR context.principal_id IS NOT NULL
    OR EXISTS(SELECT 1 FROM app.intake_session_organizations(first_session)) THEN
    RAISE EXCEPTION 'Google authentication inherited membership or ownership';
  END IF;
  IF app.intake_login(context.login_name,'synthetic Google guard passphrase',replay_session,expiry) IS NOT NULL THEN
    RAISE EXCEPTION 'Google identity authenticated with a password';
  END IF;
  IF app.intake_google_login(challenge,nonce,subject,'Synthetic replay',replay_session,expiry) IS NOT NULL
    OR app.intake_google_challenge_nonce(challenge) IS NOT NULL
    OR EXISTS(SELECT 1 FROM app.intake_session_context(replay_session)) THEN
    RAISE EXCEPTION 'Google challenge replay created a session';
  END IF;
  RAISE NOTICE 'PASS Google challenge is nonce-bound and one-use; distinct identity has no password, owner or organization';

  SELECT org_id INTO first_org FROM app.intake_create_organization(first_session,
    'google-org-one',repeat('a',64),'Synthetic Google organization one');
  PERFORM app.intake_google_challenge_create(second_challenge,second_nonce,clock_timestamp()+interval '4 minutes',NULL);
  same_identity:=app.intake_google_login(second_challenge,second_nonce,subject,'Changed Google name',second_session,expiry);
  IF same_identity IS DISTINCT FROM first_identity THEN RAISE EXCEPTION 'same Google subject created another identity'; END IF;
  SELECT * INTO STRICT context FROM app.intake_session_context(second_session);
  IF context.org_id IS DISTINCT FROM first_org OR (SELECT count(*) FROM app.intake_session_organizations(second_session))<>1 THEN
    RAISE EXCEPTION 'returning Google subject did not resume its own checked membership';
  END IF;
  PERFORM app.intake_google_challenge_create(second_challenge,second_nonce,clock_timestamp()+interval '4 minutes',NULL);
  second_identity:=app.intake_google_login(second_challenge,second_nonce,second_subject,'Identical synthetic display name',foreign_session,expiry);
  IF second_identity IS NULL OR second_identity=first_identity THEN RAISE EXCEPTION 'different Google subjects merged by display name'; END IF;
  SELECT org_id INTO second_org FROM app.intake_create_organization(foreign_session,
    'google-org-two',repeat('b',64),'Synthetic Google organization two');
  IF app.intake_switch_organization(first_session,second_org) OR app.intake_switch_organization(foreign_session,first_org) THEN
    RAISE EXCEPTION 'Google sessions crossed organization membership boundaries';
  END IF;
  SELECT * INTO STRICT context FROM app.intake_session_context(first_session);
  PERFORM set_config('app.current_org_id',context.org_id::text,true);
  PERFORM set_config('app.current_principal_id',context.principal_id::text,true);
  IF NOT app.intake_can_manage_workspace() OR app.intake_can_write()
    OR app.intake_scope_can_confirm() OR app.intake_scope_can_propose() OR app.intake_scope_is_agent() THEN
    RAISE EXCEPTION 'Google Handler gained approval, sourcing or agent authority';
  END IF;
  IF app.intake_login(password_login,'synthetic Google guard passphrase',replay_session,expiry) IS DISTINCT FROM password_identity THEN
    RAISE EXCEPTION 'Google support broke existing password login';
  END IF;
  RAISE NOTICE 'PASS returning subject reuses one identity; foreign organizations denied; password login retained and no approval authority gained';

  FOR invalid_field IN 1..3 LOOP
    denied:=false;
    BEGIN
      PERFORM app.intake_google_challenge_create(
        CASE WHEN invalid_field=1 THEN NULL ELSE challenge END,
        CASE WHEN invalid_field=2 THEN NULL ELSE nonce END,
        CASE WHEN invalid_field=3 THEN NULL ELSE clock_timestamp()+interval '4 minutes' END,NULL);
    EXCEPTION WHEN check_violation THEN denied:=true; END;
    IF NOT denied THEN RAISE EXCEPTION 'NULL Google challenge field accepted: %',invalid_field; END IF;
  END LOOP;
  FOR invalid_field IN 1..6 LOOP
    denied:=false;
    BEGIN
      PERFORM app.intake_google_login(
        CASE WHEN invalid_field=1 THEN NULL ELSE challenge END,
        CASE WHEN invalid_field=2 THEN NULL ELSE nonce END,
        CASE WHEN invalid_field=3 THEN NULL ELSE subject END,
        CASE WHEN invalid_field=4 THEN NULL ELSE 'Synthetic NULL guard' END,
        CASE WHEN invalid_field=5 THEN NULL ELSE replay_session END,
        CASE WHEN invalid_field=6 THEN NULL ELSE expiry END);
    EXCEPTION WHEN check_violation THEN denied:=true; END;
    IF NOT denied THEN RAISE EXCEPTION 'NULL Google session field accepted: %',invalid_field; END IF;
  END LOOP;
  denied:=false;
  BEGIN PERFORM app.intake_google_challenge_create(challenge,nonce,clock_timestamp()+interval '6 minutes',NULL);
  EXCEPTION WHEN check_violation THEN denied:=true; END;
  IF NOT denied THEN RAISE EXCEPTION 'Google challenge expiry exceeded five minutes'; END IF;
  denied:=false;
  BEGIN PERFORM app.intake_google_login(challenge,nonce,subject,'Synthetic expiry guard',replay_session,clock_timestamp()+interval '31 days');
  EXCEPTION WHEN check_violation THEN denied:=true; END;
  IF NOT denied THEN RAISE EXCEPTION 'Google session expiry exceeded thirty days'; END IF;
  PERFORM app.intake_google_challenge_create(challenge,nonce,clock_timestamp()+interval '4 minutes',NULL);
  PERFORM app.intake_google_challenge_create(second_challenge,second_nonce,clock_timestamp()+interval '4 minutes',challenge);
  IF app.intake_google_challenge_nonce(challenge) IS NOT NULL
    OR app.intake_google_challenge_nonce(second_challenge) IS DISTINCT FROM second_nonce THEN
    RAISE EXCEPTION 'replacement left the previous browser challenge valid';
  END IF;
  IF NOT app.intake_google_challenge_revoke(second_challenge) THEN
    RAISE EXCEPTION 'Google challenge logout revocation failed';
  END IF;
  IF app.intake_google_challenge_revoke(second_challenge)
    OR app.intake_google_challenge_nonce(second_challenge) IS NOT NULL THEN
    RAISE EXCEPTION 'Google challenge logout revocation failed';
  END IF;
  PERFORM set_config('test.google.identity',first_identity::text,true);
  PERFORM set_config('test.google.subject',subject,true);
  PERFORM set_config('test.google.session',first_session,true);
  PERFORM set_config('test.google.challenge',challenge,true);
  PERFORM set_config('test.google.nonce',nonce,true);
  RAISE NOTICE 'PASS NULL inputs, unbounded expiry, replaced challenges and logout revocation denied safely';
END $$;
RESET ROLE;

DO $$
DECLARE identity uuid:=current_setting('test.google.identity')::uuid; denied boolean;
BEGIN
  IF (SELECT count(*) FROM grimoire.handler_google_identities WHERE identity_id=identity)<>1
    OR NOT EXISTS(SELECT 1 FROM grimoire.handler_identities WHERE id=identity
      AND auth_method='google' AND password_hash IS NULL AND NOT is_installation_owner
      AND login_name ~ '^g_[0-9a-f]{32}$') THEN
    RAISE EXCEPTION 'Google identity credential storage or uniqueness invalid';
  END IF;
  denied:=false;
  BEGIN UPDATE grimoire.handler_identities SET is_installation_owner=true WHERE id=identity;
  EXCEPTION WHEN check_violation THEN denied:=true; END;
  IF NOT denied THEN RAISE EXCEPTION 'Google identity accepted installation ownership'; END IF;
  denied:=false;
  BEGIN UPDATE grimoire.handler_identities SET password_hash=public.crypt('synthetic password',public.gen_salt('bf',4)) WHERE id=identity;
  EXCEPTION WHEN check_violation THEN denied:=true; END;
  IF NOT denied THEN RAISE EXCEPTION 'Google identity accepted a password hash'; END IF;
  UPDATE grimoire.handler_identities SET disabled_at=clock_timestamp() WHERE id=identity;
  INSERT INTO grimoire.handler_google_challenges(cookie_sha256,nonce_sha256,created_at,expires_at)
    VALUES(current_setting('test.google.challenge'),current_setting('test.google.nonce'),clock_timestamp()-interval '5 minutes',clock_timestamp()-interval '1 minute');
END $$;
SET LOCAL ROLE grimoire_intake_app;
DO $$
DECLARE rejected_session text:=encode(public.digest(gen_random_uuid()::text,'sha256'),'hex'); authenticated uuid;
BEGIN
  IF app.intake_google_challenge_nonce(current_setting('test.google.challenge')) IS NOT NULL
    OR app.intake_google_login(current_setting('test.google.challenge'),current_setting('test.google.nonce'),
      current_setting('test.google.subject'),'Synthetic expired guard',rejected_session,clock_timestamp()+interval '1 hour') IS NOT NULL THEN
    RAISE EXCEPTION 'expired Google challenge authenticated';
  END IF;
  PERFORM app.intake_google_challenge_create(current_setting('test.google.challenge'),current_setting('test.google.nonce'),clock_timestamp()+interval '4 minutes',NULL);
  authenticated:=app.intake_google_login(current_setting('test.google.challenge'),current_setting('test.google.nonce'),
    current_setting('test.google.subject'),'Disabled Handler',rejected_session,clock_timestamp()+interval '1 hour');
  IF authenticated IS NOT NULL OR EXISTS(SELECT 1 FROM app.intake_session_context(rejected_session))
    OR EXISTS(SELECT 1 FROM app.intake_session_context(current_setting('test.google.session')))
    OR app.intake_google_challenge_nonce(current_setting('test.google.challenge')) IS NOT NULL THEN
    RAISE EXCEPTION 'disabled Google identity retained or gained a session';
  END IF;
  RAISE NOTICE 'PASS expired challenges and disabled Google identities denied, including existing sessions';
END $$;
RESET ROLE;

-- The cap is tested against exactly 1024 synthetic rows inside this rollback.
DELETE FROM grimoire.handler_google_challenges;
INSERT INTO grimoire.handler_google_challenges(cookie_sha256,nonce_sha256,expires_at)
  SELECT encode(public.digest('synthetic challenge cap '||n::text,'sha256'),'hex'),repeat('a',64),clock_timestamp()+interval '4 minutes'
  FROM generate_series(1,1024) n;
SET LOCAL ROLE grimoire_intake_app;
DO $$ BEGIN
  IF app.intake_google_challenge_create(repeat('b',64),repeat('c',64),clock_timestamp()+interval '4 minutes',NULL) THEN
    RAISE EXCEPTION 'Google outstanding challenge cap exceeded';
  END IF;
  RAISE NOTICE 'PASS Google outstanding challenge count is bounded';
END $$;
RESET ROLE;
DO $$ BEGIN
  IF COALESCE((SELECT owner_identity_id::text FROM grimoire.installation_setup WHERE singleton),'')<>current_setting('test.google.owner')
    OR (SELECT count(*) FROM grimoire.intake_scope_confirmations)<>current_setting('test.google.scope_count')::bigint
    OR (SELECT count(*) FROM grimoire.intake_comparison_confirmations)<>current_setting('test.google.comparison_count')::bigint THEN
    RAISE EXCEPTION 'Google authentication changed installation ownership or created approval effects';
  END IF;
  RAISE NOTICE 'PASS Google authentication creates no installation owner or approval effects';
END $$;
ROLLBACK;
