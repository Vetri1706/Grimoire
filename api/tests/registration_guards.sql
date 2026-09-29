-- Run as the migration owner on a disposable *_test database. The complete
-- exercise, including resetting the setup singleton, is rolled back.
BEGIN;
SET LOCAL search_path=pg_catalog,grimoire,pg_temp;
DO $$
BEGIN
  IF current_database() NOT LIKE '%\_test' ESCAPE '\' THEN
    RAISE EXCEPTION 'Registration guards require a disposable _test database';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace,
      LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
    WHERE n.nspname='app' AND p.proname='intake_register_handler'
      AND a.grantee=0 AND a.privilege_type='EXECUTE'
  ) THEN RAISE EXCEPTION 'registration function exposed to PUBLIC'; END IF;
  UPDATE grimoire.installation_setup SET owner_identity_id=NULL,completed_at=NULL WHERE singleton;
END $$;

SET LOCAL ROLE grimoire_intake_app;
DO $$
DECLARE
  first_login text:='registration_'||replace(gen_random_uuid()::text,'-','');
  second_login text:='registration_'||replace(gen_random_uuid()::text,'-','');
  owner_login text:='registration_'||replace(gen_random_uuid()::text,'-','');
  first_hash text:=encode(public.digest(gen_random_uuid()::text,'sha256'),'hex');
  second_hash text:=encode(public.digest(gen_random_uuid()::text,'sha256'),'hex');
  login_hash text:=encode(public.digest(gen_random_uuid()::text,'sha256'),'hex');
  owner_hash text:=encode(public.digest(gen_random_uuid()::text,'sha256'),'hex');
  rejected_hash text:=encode(public.digest(gen_random_uuid()::text,'sha256'),'hex');
  expiry timestamptz:=clock_timestamp()+interval '1 hour';
  first_identity uuid; second_identity uuid; owner_identity uuid;
  first_org uuid; second_org uuid; context record; denied boolean; invalid_field integer;
BEGIN
  -- Both sides of the one-time installation setup boundary allow ordinary signup.
  first_identity:=app.intake_register_handler(first_login,'Synthetic registered Handler',
    'synthetic signup passphrase',first_hash,expiry);
  IF NOT app.intake_installation_setup_required() THEN RAISE EXCEPTION 'signup seized installation ownership'; END IF;
  SELECT * INTO STRICT context FROM app.intake_session_context(first_hash);
  IF context.identity_id<>first_identity OR context.installation_owner IS DISTINCT FROM false
    OR context.org_id IS NOT NULL OR context.principal_id IS NOT NULL
    OR EXISTS(SELECT 1 FROM app.intake_session_organizations(first_hash)) THEN
    RAISE EXCEPTION 'signup inherited an owner or organization';
  END IF;
  owner_identity:=app.intake_setup_owner(owner_login,'Synthetic setup owner',
    'synthetic owner passphrase',owner_hash,expiry);
  IF app.intake_installation_setup_required() THEN RAISE EXCEPTION 'ordinary signup blocked legitimate owner setup'; END IF;
  second_identity:=app.intake_register_handler(second_login,'Synthetic second Handler',
    'synthetic second passphrase',second_hash,expiry);
  IF first_identity=second_identity OR first_identity=owner_identity OR second_identity=owner_identity THEN
    RAISE EXCEPTION 'independent signup reused an identity';
  END IF;
  SELECT * INTO STRICT context FROM app.intake_session_context(second_hash);
  IF context.installation_owner IS DISTINCT FROM false OR context.org_id IS NOT NULL THEN
    RAISE EXCEPTION 'signup after setup inherited authority';
  END IF;
  IF app.intake_login(first_login,'synthetic signup passphrase',login_hash,expiry) IS DISTINCT FROM first_identity THEN
    RAISE EXCEPTION 'registered Handler cannot log in';
  END IF;
  IF app.intake_login(first_login,'incorrect synthetic passphrase',rejected_hash,expiry) IS NOT NULL THEN
    RAISE EXCEPTION 'registration accepted an incorrect login passphrase';
  END IF;
  RAISE NOTICE 'PASS independent signup before and after setup; real login; no inherited ownership or memberships';

  denied:=false;
  BEGIN
    PERFORM app.intake_register_handler(first_login,'Duplicate Handler',
      'synthetic duplicate passphrase',rejected_hash,expiry);
  EXCEPTION WHEN unique_violation THEN denied:=true; END;
  IF NOT denied OR EXISTS(SELECT 1 FROM app.intake_session_context(rejected_hash)) THEN
    RAISE EXCEPTION 'duplicate signup created a session';
  END IF;
  FOR invalid_field IN 1..5 LOOP
    denied:=false;
    BEGIN
      PERFORM app.intake_register_handler(
        CASE WHEN invalid_field=1 THEN NULL ELSE 'null_guard' END,
        CASE WHEN invalid_field=2 THEN NULL ELSE 'Synthetic NULL guard' END,
        CASE WHEN invalid_field=3 THEN NULL ELSE 'synthetic null passphrase' END,
        CASE WHEN invalid_field=4 THEN NULL ELSE rejected_hash END,
        CASE WHEN invalid_field=5 THEN NULL ELSE expiry END);
    EXCEPTION WHEN check_violation THEN denied:=true; END;
    IF NOT denied THEN RAISE EXCEPTION 'NULL signup field accepted: %',invalid_field; END IF;
  END LOOP;
  denied:=false;
  BEGIN
    PERFORM app.intake_register_handler('long_session_guard','Synthetic expiry guard',
      'synthetic expiry passphrase',rejected_hash,clock_timestamp()+interval '31 days');
  EXCEPTION WHEN check_violation THEN denied:=true; END;
  IF NOT denied THEN RAISE EXCEPTION 'unbounded signup session accepted'; END IF;
  RAISE NOTICE 'PASS duplicate signup is atomic; NULL arguments and unbounded session expiry denied';

  SELECT org_id INTO first_org FROM app.intake_create_organization(first_hash,
    'registration-one',repeat('a',64),'Synthetic signup organization one');
  SELECT org_id INTO second_org FROM app.intake_create_organization(second_hash,
    'registration-two',repeat('b',64),'Synthetic signup organization two');
  IF first_org=second_org OR (SELECT count(*) FROM app.intake_session_organizations(first_hash))<>1
    OR (SELECT count(*) FROM app.intake_session_organizations(second_hash))<>1
    OR app.intake_switch_organization(first_hash,second_org)
    OR app.intake_switch_organization(second_hash,first_org) THEN
    RAISE EXCEPTION 'registered identities crossed organization boundaries';
  END IF;
  SELECT * INTO STRICT context FROM app.intake_session_context(first_hash);
  PERFORM set_config('app.current_org_id',context.org_id::text,true);
  PERFORM set_config('app.current_principal_id',context.principal_id::text,true);
  IF NOT app.intake_can_manage_workspace() OR app.intake_can_write()
    OR app.intake_scope_can_confirm() OR app.intake_scope_can_propose() OR app.intake_scope_is_agent() THEN
    RAISE EXCEPTION 'registered Handler obtained sourcing, approval or agent authority';
  END IF;
  PERFORM set_config('test.registration_identity',first_identity::text,true);
  RAISE NOTICE 'PASS registered organizations remain isolated and workspace management grants no sourcing, approval or agent authority';
END $$;
RESET ROLE;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM grimoire.handler_identities
    WHERE id=current_setting('test.registration_identity')::uuid
      AND NOT is_installation_owner AND password_hash LIKE '$2%'
      AND password_hash=public.crypt('synthetic signup passphrase',password_hash)
      AND password_hash<>'synthetic signup passphrase'
  ) THEN RAISE EXCEPTION 'registered password was not stored as a bcrypt hash'; END IF;
  RAISE NOTICE 'PASS registered passphrase is stored only as a bcrypt hash';
END $$;
ROLLBACK;
