-- Self-service profile changes, executed through the unprivileged runtime role.
-- All data and successful/denied mutations roll back on a disposable database.
BEGIN;
SET LOCAL search_path=pg_catalog,grimoire,pg_temp;
DO $$
DECLARE identity_one uuid:=gen_random_uuid(); identity_two uuid:=gen_random_uuid();
  hash_one text:=encode(public.digest(gen_random_uuid()::text,'sha256'),'hex');
  hash_two text:=encode(public.digest(gen_random_uuid()::text,'sha256'),'hex');
BEGIN
  IF current_database() NOT LIKE '%\_test' ESCAPE '\' THEN RAISE EXCEPTION 'Profile guards require a disposable _test database'; END IF;
  INSERT INTO grimoire.handler_identities(id,login_name,display_name,password_hash)
    VALUES(identity_one,'profile_'||replace(identity_one::text,'-',''),'First Handler',public.crypt('synthetic profile test',public.gen_salt('bf',4))),
    (identity_two,'profile_'||replace(identity_two::text,'-',''),'Other Handler',public.crypt('synthetic profile test',public.gen_salt('bf',4)));
  INSERT INTO grimoire.handler_sessions(token_sha256,identity_id,expires_at)
    VALUES(hash_one,identity_one,clock_timestamp()+interval '1 hour'),(hash_two,identity_two,clock_timestamp()+interval '1 hour');
  PERFORM app.intake_create_organization(hash_one,'profile-one',repeat('a',64),'Profile organization one');
  PERFORM app.intake_create_organization(hash_one,'profile-two',repeat('b',64),'Profile organization two');
  PERFORM app.intake_create_organization(hash_two,'profile-other',repeat('c',64),'Unrelated organization');
  PERFORM set_config('test.profile_identity',identity_one::text,true);
  PERFORM set_config('test.profile_other_identity',identity_two::text,true);
  PERFORM set_config('test.profile_hash',hash_one,true);
  PERFORM set_config('test.profile_other_hash',hash_two,true);
  PERFORM set_config('test.profile_identity_before',(SELECT (to_jsonb(h)-'display_name')::text FROM grimoire.handler_identities h WHERE h.id=identity_one),true);
  PERFORM set_config('test.profile_memberships_before',(SELECT jsonb_agg(to_jsonb(m) ORDER BY m.org_id)::text FROM grimoire.handler_organization_memberships m WHERE m.identity_id=identity_one),true);
  PERFORM set_config('test.profile_roles_before',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.org_id,r.principal_id,r.role)::text FROM grimoire.principal_roles r),true);
  IF has_table_privilege('grimoire_intake_app','grimoire.handler_identities','SELECT,INSERT,UPDATE,DELETE') THEN RAISE EXCEPTION 'Runtime has direct identity access'; END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid='app.intake_update_handler_profile(text,text)'::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE') THEN RAISE EXCEPTION 'Public can edit profiles'; END IF;
END $$;
SET LOCAL ROLE grimoire_intake_app;
DO $$
DECLARE blocked boolean;
BEGIN
  PERFORM set_config('app.request_id','',true);
  PERFORM set_config('app.current_org_id','',true);
  PERFORM set_config('app.current_principal_id','',true);
  IF NOT app.intake_update_handler_profile(current_setting('test.profile_hash'),'  Renamed Handler  ') THEN RAISE EXCEPTION 'Valid profile update rejected'; END IF;
  IF (SELECT handler_display_name FROM app.intake_session_context(current_setting('test.profile_hash')))<>'Renamed Handler' THEN RAISE EXCEPTION 'Profile update not visible to session'; END IF;
  IF (SELECT handler_display_name FROM app.intake_session_context(current_setting('test.profile_other_hash')))<>'Other Handler' THEN RAISE EXCEPTION 'Foreign identity changed'; END IF;
  IF app.intake_update_handler_profile(repeat('f',64),'Intruder') OR app.intake_update_handler_profile(NULL,'Intruder') THEN RAISE EXCEPTION 'Unknown session may edit a profile'; END IF;
  blocked:=false;
  BEGIN PERFORM app.intake_update_handler_profile(current_setting('test.profile_hash'),'   ');
  EXCEPTION WHEN check_violation THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Empty profile name accepted'; END IF;
  blocked:=false;
  BEGIN PERFORM app.intake_update_handler_profile(current_setting('test.profile_hash'),repeat('x',121));
  EXCEPTION WHEN check_violation THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Long profile name accepted'; END IF;
  RAISE NOTICE 'PASS profile runtime self-update, normalized name, invalid inputs and foreign identity isolation';
END $$;
RESET ROLE;
DO $$ BEGIN
  IF (SELECT to_jsonb(h)-'display_name' FROM grimoire.handler_identities h WHERE h.id=current_setting('test.profile_identity')::uuid)<>current_setting('test.profile_identity_before')::jsonb THEN RAISE EXCEPTION 'Profile changed immutable identity/auth fields'; END IF;
  IF (SELECT jsonb_agg(to_jsonb(m) ORDER BY m.org_id) FROM grimoire.handler_organization_memberships m WHERE m.identity_id=current_setting('test.profile_identity')::uuid)<>current_setting('test.profile_memberships_before')::jsonb THEN RAISE EXCEPTION 'Profile changed membership'; END IF;
  IF (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.org_id,r.principal_id,r.role) FROM grimoire.principal_roles r)<>current_setting('test.profile_roles_before')::jsonb THEN RAISE EXCEPTION 'Profile changed authority'; END IF;
  IF (SELECT count(*) FROM grimoire.principals p JOIN grimoire.handler_organization_memberships m ON (p.org_id,p.id)=(m.org_id,m.principal_id) WHERE m.identity_id=current_setting('test.profile_identity')::uuid AND p.display_name='Renamed Handler')<>2 THEN RAISE EXCEPTION 'Owned directory labels not synchronized'; END IF;
  IF (SELECT count(*) FROM grimoire.audit_events a JOIN grimoire.handler_organization_memberships m ON (a.org_id,a.actor_id)=(m.org_id,m.principal_id) WHERE m.identity_id=current_setting('test.profile_identity')::uuid AND a.endpoint_scope='session:profile' AND a.effective_role='handler_self_service')<>2 THEN RAISE EXCEPTION 'Profile directory audit attribution missing'; END IF;
  RAISE NOTICE 'PASS profile preserves login, credentials, ownership, memberships and roles; owned directory labels synchronized';
END $$;
SET LOCAL ROLE grimoire_intake_app;
SELECT app.intake_update_handler_profile(current_setting('test.profile_hash'),'Renamed Handler');
RESET ROLE;
DO $$ BEGIN
  IF (SELECT count(*) FROM grimoire.audit_events a JOIN grimoire.handler_organization_memberships m ON (a.org_id,a.actor_id)=(m.org_id,m.principal_id) WHERE m.identity_id=current_setting('test.profile_identity')::uuid AND a.endpoint_scope='session:profile')<>2 THEN RAISE EXCEPTION 'Identical profile retry duplicated audit effects'; END IF;
  RAISE NOTICE 'PASS profile audit context is session-derived and identical retries have no duplicate effect';
END $$;
UPDATE grimoire.handler_sessions SET expires_at=clock_timestamp()-interval '1 minute',created_at=clock_timestamp()-interval '1 hour' WHERE token_sha256=current_setting('test.profile_hash');
SET LOCAL ROLE grimoire_intake_app;
DO $$ BEGIN IF app.intake_update_handler_profile(current_setting('test.profile_hash'),'Expired') THEN RAISE EXCEPTION 'Expired session edited profile'; END IF; END $$;
RESET ROLE;
UPDATE grimoire.handler_sessions SET expires_at=clock_timestamp()+interval '1 hour',revoked_at=clock_timestamp() WHERE token_sha256=current_setting('test.profile_hash');
SET LOCAL ROLE grimoire_intake_app;
DO $$ BEGIN IF app.intake_update_handler_profile(current_setting('test.profile_hash'),'Revoked') THEN RAISE EXCEPTION 'Revoked session edited profile'; END IF; END $$;
RESET ROLE;
UPDATE grimoire.handler_sessions SET revoked_at=NULL WHERE token_sha256=current_setting('test.profile_hash');
UPDATE grimoire.handler_identities SET disabled_at=clock_timestamp() WHERE id=current_setting('test.profile_identity')::uuid;
SET LOCAL ROLE grimoire_intake_app;
DO $$ BEGIN
  IF app.intake_update_handler_profile(current_setting('test.profile_hash'),'Disabled') THEN RAISE EXCEPTION 'Disabled identity edited profile'; END IF;
  RAISE NOTICE 'PASS expired/revoked sessions and disabled identities cannot edit profiles';
END $$;
RESET ROLE;
ROLLBACK;
