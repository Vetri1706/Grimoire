-- Run as migration owner on a disposable _test database. Every row rolls back.
BEGIN;
SET LOCAL search_path=pg_catalog,grimoire,pg_temp;
DO $$
DECLARE first_id uuid:=gen_random_uuid(); second_id uuid:=gen_random_uuid(); first_hash text:=encode(public.gen_random_bytes(32),'hex'); second_hash text:=encode(public.gen_random_bytes(32),'hex');
BEGIN
 IF current_database() NOT LIKE '%\_test' ESCAPE '\' THEN RAISE EXCEPTION 'Worker pairing guards require disposable _test database'; END IF;
 INSERT INTO grimoire.handler_identities(id,login_name,display_name,password_hash) VALUES
 (first_id,'pair_'||replace(first_id::text,'-',''),'Pairing Handler',public.crypt('synthetic pairing passphrase',public.gen_salt('bf',4))),
 (second_id,'pair_'||replace(second_id::text,'-',''),'Other Handler',public.crypt('synthetic pairing passphrase',public.gen_salt('bf',4)));
 INSERT INTO grimoire.handler_sessions(token_sha256,identity_id,expires_at) VALUES(first_hash,first_id,clock_timestamp()+interval '1 hour'),(second_hash,second_id,clock_timestamp()+interval '1 hour');
 PERFORM app.intake_create_organization(first_hash,'worker-first',repeat('a',64),'Pairing first organization');
 PERFORM app.intake_create_organization(second_hash,'worker-second',repeat('b',64),'Pairing other organization');
 PERFORM set_config('test.pair_session',first_hash,true); PERFORM set_config('test.pair_other_session',second_hash,true);
 PERFORM set_config('test.pair_identity',first_id::text,true);
 PERFORM set_config('test.pair_org',(SELECT org_id::text FROM app.intake_session_context(first_hash)),true);
 PERFORM set_config('test.pair_other_org',(SELECT org_id::text FROM app.intake_session_context(second_hash)),true);
 PERFORM set_config('test.pair_principal',(SELECT principal_id::text FROM app.intake_session_context(first_hash)),true);
 PERFORM set_config('test.pair_other_principal',(SELECT principal_id::text FROM app.intake_session_context(second_hash)),true);
 DELETE FROM grimoire.intake_worker_pairing_limits;
 IF has_table_privilege('grimoire_intake_app','grimoire.intake_worker_pairings','SELECT,INSERT,UPDATE,DELETE') THEN RAISE EXCEPTION 'Runtime has direct pairing access'; END IF;
 IF has_column_privilege('grimoire_intake_app','grimoire.intake_worker_connections','credential_sha256','SELECT') THEN RAISE EXCEPTION 'Runtime can read worker credential hashes'; END IF;
 IF has_function_privilege('grimoire_intake_app','app.intake_worker_pairing_limit(text,integer)','EXECUTE') OR has_function_privilege('grimoire_intake_app','app.intake_worker_handler(text)','EXECUTE') THEN RAISE EXCEPTION 'Private pairing helpers are exposed'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace,
 LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
 WHERE n.nspname='app' AND p.proname IN ('intake_start_worker_pairing','intake_review_worker_pairing','intake_approve_worker_pairing','intake_poll_worker_pairing','intake_revoke_worker_connection') AND a.grantee=0 AND a.privilege_type='EXECUTE') THEN RAISE EXCEPTION 'Public may call pairing database functions'; END IF;
END $$;
SET LOCAL ROLE grimoire_intake_app;
DO $$
DECLARE pairing jsonb; result jsonb; name text;
BEGIN
 pairing:=app.intake_start_worker_pairing('Synthetic local laptop');
 IF pairing->>'device_secret' !~ '^[a-f0-9]{64}$' OR pairing->>'user_code' !~ '^[A-F0-9]{16}$' OR pairing->>'adapter'<>'codex_cli' THEN RAISE EXCEPTION 'Pairing proofs/adapter wrong'; END IF;
 PERFORM set_config('test.pair_request',pairing::text,true);
 result:=app.intake_poll_worker_pairing(pairing->>'device_secret');
 IF result->>'status'<>'pending' OR result ? 'credential' THEN RAISE EXCEPTION 'Unapproved device received credential'; END IF;
 IF app.intake_poll_worker_pairing(pairing->>'device_secret')->>'status'<>'rate_limited' THEN RAISE EXCEPTION 'Fast polling not bounded'; END IF;
 IF app.intake_review_worker_pairing(repeat('0',64),pairing->>'user_code',current_setting('test.pair_org')::uuid)->>'status'<>'unauthorized' THEN RAISE EXCEPTION 'Unknown session can review pairing'; END IF;
 IF app.intake_review_worker_pairing(current_setting('test.pair_session'),pairing->>'user_code',current_setting('test.pair_other_org')::uuid)->>'status'<>'organization_changed' THEN RAISE EXCEPTION 'Review ignores mounted organization'; END IF;
 result:=app.intake_review_worker_pairing(current_setting('test.pair_session'),pairing->>'user_code',current_setting('test.pair_org')::uuid);
 IF result->>'status'<>'pending' OR result ? 'device_secret' OR result ? 'credential' OR result->>'policy_version'<>'codex-synthetic-v1' THEN RAISE EXCEPTION 'Browser review reveals secret or wrong policy'; END IF;
 IF app.intake_approve_worker_pairing(current_setting('test.pair_session'),pairing->>'user_code',current_setting('test.pair_org')::uuid,false,'codex-synthetic-v1')->>'status'<>'consent_required' THEN RAISE EXCEPTION 'Missing consent accepted'; END IF;
 IF app.intake_approve_worker_pairing(current_setting('test.pair_session'),pairing->>'user_code',current_setting('test.pair_org')::uuid,true,'any-adapter')->>'status'<>'consent_required' THEN RAISE EXCEPTION 'Unreviewed policy accepted'; END IF;
 IF app.intake_approve_worker_pairing(current_setting('test.pair_session'),pairing->>'user_code',current_setting('test.pair_other_org')::uuid,true,'codex-synthetic-v1')->>'status'<>'organization_changed' THEN RAISE EXCEPTION 'Consent ignored active organization'; END IF;
 result:=app.intake_approve_worker_pairing(current_setting('test.pair_session'),pairing->>'user_code',current_setting('test.pair_org')::uuid,true,'codex-synthetic-v1');
 IF result->>'status'<>'approved' OR result ? 'credential' OR result ? 'device_secret' THEN RAISE EXCEPTION 'Approval failed or browser received secret'; END IF;
 IF app.intake_approve_worker_pairing(current_setting('test.pair_session'),pairing->>'user_code',current_setting('test.pair_org')::uuid,true,'codex-synthetic-v1')->>'status'<>'approved' THEN RAISE EXCEPTION 'Identical approval not idempotent'; END IF;
 IF app.intake_review_worker_pairing(current_setting('test.pair_other_session'),pairing->>'user_code',current_setting('test.pair_other_org')::uuid)->>'status'<>'not_found' THEN RAISE EXCEPTION 'Foreign organization sees approved pairing'; END IF;
 IF app.intake_approve_worker_pairing(current_setting('test.pair_other_session'),pairing->>'user_code',current_setting('test.pair_other_org')::uuid,true,'codex-synthetic-v1')->>'status'<>'not_found' THEN RAISE EXCEPTION 'Foreign organization can steal pairing'; END IF;
 RAISE NOTICE 'PASS pairing pending, throttling, session/mounted organization binding, explicit consent, secret hiding and cross-organization isolation';
END $$;
RESET ROLE;
DO $$ BEGIN
 IF (SELECT count(*) FROM grimoire.intake_worker_pairing_consents WHERE pairing_id=(current_setting('test.pair_request')::jsonb->>'pairing_id')::uuid)<>1 THEN RAISE EXCEPTION 'Duplicate approval duplicated consent'; END IF;
END $$;
UPDATE grimoire.intake_worker_pairings SET last_polled_at=NULL WHERE id=(current_setting('test.pair_request')::jsonb->>'pairing_id')::uuid;
UPDATE grimoire.handler_identities SET disabled_at=clock_timestamp() WHERE id=current_setting('test.pair_identity')::uuid;
SET LOCAL ROLE grimoire_intake_app;
DO $$ BEGIN
 IF app.intake_poll_worker_pairing(current_setting('test.pair_request')::jsonb->>'device_secret')->>'status'<>'denied' THEN RAISE EXCEPTION 'Disabled approving Handler still provisions worker'; END IF;
END $$;
RESET ROLE;
UPDATE grimoire.handler_identities SET disabled_at=NULL WHERE id=current_setting('test.pair_identity')::uuid;
UPDATE grimoire.intake_worker_pairings SET last_polled_at=NULL WHERE id=(current_setting('test.pair_request')::jsonb->>'pairing_id')::uuid;
DO $$ BEGIN
 PERFORM set_config('app.current_org_id',current_setting('test.pair_org'),true);
 PERFORM set_config('app.current_principal_id',current_setting('test.pair_principal'),true);
 PERFORM set_config('app.request_id',gen_random_uuid()::text,true);
 INSERT INTO grimoire.principal_roles(org_id,principal_id,role) VALUES(current_setting('test.pair_org')::uuid,current_setting('test.pair_principal')::uuid,'read_only_agent');
END $$;
SET LOCAL ROLE grimoire_intake_app;
DO $$ BEGIN
 IF app.intake_poll_worker_pairing(current_setting('test.pair_request')::jsonb->>'device_secret')->>'status'<>'denied' THEN RAISE EXCEPTION 'Approver changed to agent but still provisions worker'; END IF;
END $$;
RESET ROLE;
DELETE FROM grimoire.principal_roles WHERE (org_id,principal_id,role)=(current_setting('test.pair_org')::uuid,current_setting('test.pair_principal')::uuid,'read_only_agent');
UPDATE grimoire.intake_worker_pairings SET last_polled_at=NULL WHERE id=(current_setting('test.pair_request')::jsonb->>'pairing_id')::uuid;
SET LOCAL ROLE grimoire_intake_app;
DO $$
DECLARE result jsonb; again jsonb;
BEGIN
 result:=app.intake_poll_worker_pairing(current_setting('test.pair_request')::jsonb->>'device_secret');
 IF result->>'status'<>'approved' OR result->>'credential' !~ '^[a-f0-9]{64}$' OR result->>'organization_id'<>current_setting('test.pair_org') THEN RAISE EXCEPTION 'Approved worker issuance failed: %',result->>'status'; END IF;
 PERFORM set_config('test.pair_connection',result::text,true);
 again:=app.intake_poll_worker_pairing(current_setting('test.pair_request')::jsonb->>'device_secret');
 IF again->>'status'<>'consumed' OR again ? 'credential' THEN RAISE EXCEPTION 'Repeated poll reveals or recreates credential'; END IF;
 PERFORM set_config('app.current_org_id',current_setting('test.pair_org'),true);
 PERFORM set_config('app.current_principal_id',(SELECT principal_id::text FROM app.intake_authenticate(encode(public.digest(result->>'credential','sha256'),'hex'))),true);
 IF NOT app.intake_scope_is_agent() OR NOT app.intake_scope_can_propose() OR app.intake_can_write() OR app.intake_scope_can_confirm() OR app.intake_can_manage_workspace() THEN RAISE EXCEPTION 'Paired principal gained human authority'; END IF;
 PERFORM set_config('test.pair_worker',app.current_principal_id()::text,true);
 PERFORM app.intake_worker_seen();
 IF app.intake_approve_worker_pairing(encode(public.digest(result->>'credential','sha256'),'hex'),current_setting('test.pair_request')::jsonb->>'user_code',current_setting('test.pair_org')::uuid,true,'codex-synthetic-v1')->>'status'<>'unauthorized' THEN RAISE EXCEPTION 'Worker credential consented as human'; END IF;
 IF EXISTS(SELECT 1 FROM grimoire.intake_worker_connections) THEN RAISE EXCEPTION 'Worker sees organization connection administration'; END IF;
 PERFORM set_config('app.current_org_id',current_setting('test.pair_other_org'),true);
 PERFORM set_config('app.current_principal_id',current_setting('test.pair_other_principal'),true);
 IF EXISTS(SELECT 1 FROM grimoire.intake_worker_connections WHERE id=(result->>'connection_id')::uuid) OR EXISTS(SELECT 1 FROM grimoire.intake_worker_connection_events WHERE connection_id=(result->>'connection_id')::uuid) THEN RAISE EXCEPTION 'Foreign organization reads connection or events'; END IF;
 RAISE NOTICE 'PASS one-time issuance, proposal-only worker, no bearer human consent, connection/event RLS';
END $$;
RESET ROLE;
DO $$ DECLARE blocked boolean:=false; BEGIN
 IF (SELECT count(*) FROM grimoire.intake_worker_connections WHERE id=(current_setting('test.pair_connection')::jsonb->>'connection_id')::uuid)<>1 OR
 (SELECT count(*) FROM grimoire.intake_worker_connection_events WHERE connection_id=(current_setting('test.pair_connection')::jsonb->>'connection_id')::uuid AND event_kind='paired')<>1 THEN RAISE EXCEPTION 'Duplicate poll duplicated connection or paired event'; END IF;
 IF (SELECT array_agg(role::text) FROM grimoire.principal_roles WHERE principal_id=current_setting('test.pair_worker')::uuid)<>ARRAY['read_only_agent'] THEN RAISE EXCEPTION 'Worker gained extra roles'; END IF;
 IF EXISTS(SELECT 1 FROM grimoire.intake_worker_pairings WHERE device_sha256=current_setting('test.pair_request')::jsonb->>'device_secret') THEN RAISE EXCEPTION 'Plain device proof stored'; END IF;
 BEGIN UPDATE grimoire.intake_worker_pairing_consents SET policy_version='codex-synthetic-v1' WHERE pairing_id=(current_setting('test.pair_request')::jsonb->>'pairing_id')::uuid;
 EXCEPTION WHEN SQLSTATE 'G2401' THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'Consent row is mutable'; END IF;
END $$;
SET LOCAL ROLE grimoire_intake_app;
DO $$ DECLARE result jsonb; blocked boolean:=false; BEGIN
 IF app.intake_revoke_worker_connection(current_setting('test.pair_other_session'),(current_setting('test.pair_connection')::jsonb->>'connection_id')::uuid,current_setting('test.pair_other_org')::uuid)->>'status'<>'not_found' THEN RAISE EXCEPTION 'Foreign organization revokes worker'; END IF;
 result:=app.intake_revoke_worker_connection(current_setting('test.pair_session'),(current_setting('test.pair_connection')::jsonb->>'connection_id')::uuid,current_setting('test.pair_org')::uuid);
 IF result->>'status'<>'revoked' THEN RAISE EXCEPTION 'Revocation failed'; END IF;
 PERFORM app.intake_revoke_worker_connection(current_setting('test.pair_session'),(current_setting('test.pair_connection')::jsonb->>'connection_id')::uuid,current_setting('test.pair_org')::uuid);
 IF EXISTS(SELECT 1 FROM app.intake_authenticate(encode(public.digest(current_setting('test.pair_connection')::jsonb->>'credential','sha256'),'hex'))) THEN RAISE EXCEPTION 'Revoked credential still authenticates'; END IF;
 PERFORM set_config('app.current_org_id',current_setting('test.pair_org'),true);
 PERFORM set_config('app.current_principal_id',current_setting('test.pair_worker'),true);
 IF app.intake_scope_can_propose() THEN RAISE EXCEPTION 'Disabled worker still proposes'; END IF;
 BEGIN PERFORM app.intake_worker_seen(); EXCEPTION WHEN insufficient_privilege THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'Revoked worker recreated presence'; END IF;
 RAISE NOTICE 'PASS revocation invalidates credential/principal immediately and prevents new heartbeat';
END $$;
RESET ROLE;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM grimoire.intake_worker_presence WHERE principal_id=current_setting('test.pair_worker')::uuid) THEN RAISE EXCEPTION 'Revoked presence retained'; END IF;
 IF (SELECT count(*) FROM grimoire.intake_worker_connection_events WHERE connection_id=(current_setting('test.pair_connection')::jsonb->>'connection_id')::uuid AND event_kind='revoked')<>1 THEN RAISE EXCEPTION 'Duplicate revocation created duplicate event'; END IF;
END $$;
-- Expiry and invalid proof cannot mint a credential; bounds persist separately.
SET LOCAL ROLE grimoire_intake_app;
DO $$ BEGIN PERFORM set_config('test.pair_expired',app.intake_start_worker_pairing('Expiring synthetic device')::text,true); END $$;
RESET ROLE;
UPDATE grimoire.intake_worker_pairings SET created_at=clock_timestamp()-interval '20 minutes',expires_at=clock_timestamp()-interval '10 minutes' WHERE id=(current_setting('test.pair_expired')::jsonb->>'pairing_id')::uuid;
SET LOCAL ROLE grimoire_intake_app;
DO $$ DECLARE result jsonb; i integer; BEGIN
 IF app.intake_poll_worker_pairing(current_setting('test.pair_expired')::jsonb->>'device_secret')->>'status'<>'expired' THEN RAISE EXCEPTION 'Expired pairing remained usable'; END IF;
 IF app.intake_poll_worker_pairing(repeat('f',64))->>'status'<>'not_found' THEN RAISE EXCEPTION 'Unknown proof accepted'; END IF;
 FOR i IN 1..21 LOOP result:=app.intake_start_worker_pairing('Rate fixture'); END LOOP;
 IF result->>'status'<>'rate_limited' THEN RAISE EXCEPTION 'Global start cap not enforced'; END IF;
 RAISE NOTICE 'PASS expired/unknown proofs and global creation rate bound';
END $$;
RESET ROLE;
ROLLBACK;
