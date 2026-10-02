-- Run as the migration owner on a disposable *_test database. All fixtures and
-- successful/denied writes roll back; this never changes a real owner or session.
BEGIN;
SET LOCAL search_path=pg_catalog,grimoire,pg_temp;
DO $$
DECLARE identity uuid:=gen_random_uuid(); session_hash text:=encode(public.digest(gen_random_uuid()::text,'sha256'),'hex');
 other_session text:=encode(public.digest(gen_random_uuid()::text,'sha256'),'hex');
 org_one uuid; org_two uuid; principal uuid; created record; replay record; saved jsonb; blocked boolean; table_name text;
BEGIN
 IF current_database() NOT LIKE '%\_test' ESCAPE '\' THEN RAISE EXCEPTION 'Onboarding guards require a disposable _test database'; END IF;
 FOREACH table_name IN ARRAY ARRAY['handler_identities','installation_setup','handler_organization_memberships','handler_sessions','organization_creation_receipts'] LOOP
  IF has_table_privilege('grimoire_intake_app','grimoire.'||table_name,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') THEN
   RAISE EXCEPTION 'runtime has direct identity/session access: %',table_name;
  END IF;
 END LOOP;
 INSERT INTO grimoire.handler_identities(id,login_name,display_name,password_hash)
 VALUES(identity,'guard_'||replace(identity::text,'-',''),'Synthetic onboarding guard',public.crypt('synthetic guard passphrase',public.gen_salt('bf',4)));
 INSERT INTO grimoire.handler_sessions(token_sha256,identity_id,expires_at)
 VALUES(session_hash,identity,clock_timestamp()+interval '1 hour'),(other_session,identity,clock_timestamp()+interval '1 hour');
 SELECT * INTO created FROM app.intake_create_organization(session_hash,'guard-one',repeat('a',64),'Synthetic guard organization one');
 org_one:=created.org_id;
 SELECT * INTO replay FROM app.intake_create_organization(other_session,'guard-one',repeat('a',64),'Synthetic guard organization one');
 IF replay.org_id<>org_one OR NOT replay.replayed THEN RAISE EXCEPTION 'cross-session retry created another organization'; END IF;
 blocked:=false;
 BEGIN PERFORM app.intake_create_organization(session_hash,'guard-one',repeat('b',64),'Changed request');
 EXCEPTION WHEN SQLSTATE 'G3502' THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'changed organization retry accepted'; END IF;
 SELECT * INTO created FROM app.intake_create_organization(session_hash,'guard-two',repeat('c',64),'Synthetic guard organization two');
 org_two:=created.org_id;
 IF org_one=org_two OR (SELECT count(*) FROM app.intake_session_organizations(session_hash))<>2 THEN
  RAISE EXCEPTION 'organization memberships not persisted separately'; END IF;
 SELECT principal_id INTO principal FROM app.intake_session_context(session_hash);
 PERFORM set_config('app.current_org_id',org_two::text,true);
 PERFORM set_config('app.current_principal_id',principal::text,true);
 IF NOT app.intake_can_manage_workspace() OR NOT app.intake_can_prepare_workspace() OR app.intake_can_write() OR app.intake_scope_can_propose() OR app.intake_scope_can_confirm() OR app.intake_scope_is_agent() THEN
  RAISE EXCEPTION 'organization administration obtained sourcing, engineering, or agent authority'; END IF;
 PERFORM set_config('test.onboarding_session',session_hash,true);
 PERFORM set_config('test.onboarding_other_session',other_session,true);
 PERFORM set_config('test.onboarding_identity',identity::text,true);
 PERFORM set_config('test.onboarding_org_one',org_one::text,true);
 PERFORM set_config('test.onboarding_org_two',org_two::text,true);
 RAISE NOTICE 'PASS onboarding hashed sessions, cross-session retry idempotency and organization authority separation';
END $$;
SET LOCAL ROLE grimoire_intake_app;
DO $$
DECLARE saved jsonb; blocked boolean; foreign_org uuid:='20000000-0000-4000-8000-000000000001';
BEGIN
 saved:=app.intake_save_managed('skill',NULL,0,'{"name":"Synthetic owner skill","description":"Guard fixture","instructions":"Prepare a draft only."}'::jsonb,'owner-config');
 IF saved->>'kind'<>'skill' OR (saved->>'revision')::integer<>1 THEN RAISE EXCEPTION 'workspace owner cannot configure a skill'; END IF;
 blocked:=false;
 BEGIN PERFORM app.intake_bind_agent_task(gen_random_uuid(),gen_random_uuid());
 EXCEPTION WHEN SQLSTATE 'G3804' THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'workspace owner assigned a nonexistent agent or task'; END IF;
 IF app.intake_switch_organization(current_setting('test.onboarding_session'),foreign_org) THEN RAISE EXCEPTION 'foreign organization selected'; END IF;
 IF EXISTS(SELECT 1 FROM grimoire.intake_scions WHERE org_id<>app.current_org_id()) THEN RAISE EXCEPTION 'foreign organization scions leaked'; END IF;
 IF NOT app.intake_switch_organization(current_setting('test.onboarding_session'),current_setting('test.onboarding_org_one')::uuid) THEN
  RAISE EXCEPTION 'valid organization switch failed'; END IF;
 IF NOT app.intake_revoke_session(current_setting('test.onboarding_session')) THEN RAISE EXCEPTION 'session revocation failed'; END IF;
 IF EXISTS(SELECT 1 FROM app.intake_session_context(current_setting('test.onboarding_session'))) OR
    EXISTS(SELECT 1 FROM app.intake_session_authenticate(current_setting('test.onboarding_session'))) OR
    app.intake_switch_organization(current_setting('test.onboarding_session'),current_setting('test.onboarding_org_two')::uuid) THEN
  RAISE EXCEPTION 'revoked session retained access'; END IF;
 RAISE NOTICE 'PASS runtime can configure workspace skill; absent assignment targets, foreign organizations and revoked sessions denied';
END $$;
RESET ROLE;
UPDATE grimoire.handler_sessions SET expires_at=clock_timestamp()-interval '59 minutes',created_at=clock_timestamp()-interval '1 hour'
 WHERE token_sha256=current_setting('test.onboarding_other_session');
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM app.intake_session_context(current_setting('test.onboarding_other_session'))) THEN RAISE EXCEPTION 'expired session retained access'; END IF;
 RAISE NOTICE 'PASS expired session denied';
END $$;
UPDATE grimoire.handler_sessions SET expires_at=clock_timestamp()+interval '1 hour'
 WHERE token_sha256=current_setting('test.onboarding_other_session');
UPDATE grimoire.handler_identities SET disabled_at=clock_timestamp()
 WHERE id=current_setting('test.onboarding_identity')::uuid;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM app.intake_session_context(current_setting('test.onboarding_other_session'))) OR
    app.intake_switch_organization(current_setting('test.onboarding_other_session'),current_setting('test.onboarding_org_two')::uuid) THEN
  RAISE EXCEPTION 'disabled identity retained session authority'; END IF;
 RAISE NOTICE 'PASS disabled identity denied session and organization switching';
END $$;
ROLLBACK;
