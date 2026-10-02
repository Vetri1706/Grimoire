-- Human-approved pairing for an organization-owned, proposal-only Codex worker.
-- Device/provider credentials never pass through the browser. Existing seeded
-- development workers keep their existing authentication and task protocol.
BEGIN;
SET search_path=pg_catalog,grimoire,pg_temp;

CREATE TABLE grimoire.intake_worker_pairings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 device_sha256 text NOT NULL UNIQUE CHECK(device_sha256 ~ '^[a-f0-9]{64}$'),
 user_code text NOT NULL UNIQUE CHECK(user_code ~ '^[A-F0-9]{16}$'),
 device_name text NOT NULL CHECK(length(btrim(device_name)) BETWEEN 1 AND 80),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '10 minutes',
 last_polled_at timestamptz,
 org_id uuid REFERENCES grimoire.organizations(id),
 approved_by uuid REFERENCES grimoire.handler_identities(id),
 approved_principal uuid,
 approved_at timestamptz,
 consumed_at timestamptz,
 connection_id uuid UNIQUE,
 policy_version text NOT NULL DEFAULT 'codex-synthetic-v1' CHECK(policy_version='codex-synthetic-v1'),
 content_class text NOT NULL DEFAULT 'synthetic_only' CHECK(content_class='synthetic_only'),
 FOREIGN KEY(org_id,approved_principal) REFERENCES grimoire.principals(org_id,id),
 CHECK((org_id IS NULL)=(approved_by IS NULL) AND (org_id IS NULL)=(approved_principal IS NULL)
   AND (org_id IS NULL)=(approved_at IS NULL)),
 CHECK((consumed_at IS NULL)=(connection_id IS NULL)),
 CHECK(expires_at>created_at)
);
CREATE TABLE grimoire.intake_worker_connections (
 id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES grimoire.organizations(id),
 principal_id uuid NOT NULL, device_name text NOT NULL,
 credential_sha256 text NOT NULL UNIQUE REFERENCES grimoire.intake_credentials(token_sha256),
 approved_by uuid NOT NULL REFERENCES grimoire.handler_identities(id),
 approved_principal uuid NOT NULL, approved_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), revoked_at timestamptz,
 revoked_by uuid REFERENCES grimoire.handler_identities(id),
 adapter text NOT NULL DEFAULT 'codex_cli' CHECK(adapter='codex_cli'),
 policy_version text NOT NULL CHECK(policy_version='codex-synthetic-v1'),
 content_class text NOT NULL CHECK(content_class='synthetic_only'),
 UNIQUE(org_id,id), UNIQUE(org_id,principal_id),
 FOREIGN KEY(org_id,principal_id) REFERENCES grimoire.principals(org_id,id),
 FOREIGN KEY(org_id,approved_principal) REFERENCES grimoire.principals(org_id,id),
 CHECK((revoked_at IS NULL)=(revoked_by IS NULL))
);
ALTER TABLE grimoire.intake_worker_pairings ADD FOREIGN KEY(connection_id) REFERENCES grimoire.intake_worker_connections(id);
CREATE TABLE grimoire.intake_worker_pairing_consents (
 pairing_id uuid PRIMARY KEY REFERENCES grimoire.intake_worker_pairings(id),
 org_id uuid NOT NULL REFERENCES grimoire.organizations(id),
 identity_id uuid NOT NULL REFERENCES grimoire.handler_identities(id),
 principal_id uuid NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 policy_version text NOT NULL CHECK(policy_version='codex-synthetic-v1'),
 content_class text NOT NULL CHECK(content_class='synthetic_only'),
 FOREIGN KEY(org_id,principal_id) REFERENCES grimoire.principals(org_id,id)
);
CREATE TRIGGER intake_worker_pairing_consents_immutable BEFORE UPDATE OR DELETE ON grimoire.intake_worker_pairing_consents
 FOR EACH ROW EXECUTE FUNCTION grimoire.intake_deny_mutation();
CREATE TABLE grimoire.intake_worker_connection_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL,
 connection_id uuid NOT NULL, event_kind text NOT NULL CHECK(event_kind IN ('paired','revoked')),
 actor_id uuid NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 policy_version text NOT NULL CHECK(policy_version='codex-synthetic-v1'),
 content_class text NOT NULL CHECK(content_class='synthetic_only'),
 UNIQUE(connection_id,event_kind),
 FOREIGN KEY(org_id,connection_id) REFERENCES grimoire.intake_worker_connections(org_id,id),
 FOREIGN KEY(org_id,actor_id) REFERENCES grimoire.principals(org_id,id)
);
CREATE TRIGGER intake_worker_connection_events_immutable BEFORE UPDATE OR DELETE ON grimoire.intake_worker_connection_events
 FOR EACH ROW EXECUTE FUNCTION grimoire.intake_deny_mutation();
CREATE TABLE grimoire.intake_worker_pairing_limits (
 scope text PRIMARY KEY, window_start timestamptz NOT NULL, requests integer NOT NULL CHECK(requests>0)
);
REVOKE ALL ON grimoire.intake_worker_pairings,grimoire.intake_worker_connections,
 grimoire.intake_worker_pairing_consents,grimoire.intake_worker_connection_events,grimoire.intake_worker_pairing_limits FROM PUBLIC,grimoire_intake_app;
ALTER TABLE grimoire.intake_worker_pairings ENABLE ROW LEVEL SECURITY;
ALTER TABLE grimoire.intake_worker_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE grimoire.intake_worker_connection_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE grimoire.intake_worker_pairing_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE grimoire.intake_worker_pairing_consents ENABLE ROW LEVEL SECURITY;
CREATE POLICY intake_worker_connections_org_read ON grimoire.intake_worker_connections FOR SELECT TO grimoire_intake_app
 USING(org_id=app.current_org_id() AND app.intake_can_manage_workspace() AND NOT app.intake_scope_is_agent());
CREATE POLICY intake_worker_connection_events_org_read ON grimoire.intake_worker_connection_events FOR SELECT TO grimoire_intake_app
 USING(org_id=app.current_org_id() AND app.intake_can_manage_workspace() AND NOT app.intake_scope_is_agent());
CREATE POLICY intake_worker_pairing_consents_org_read ON grimoire.intake_worker_pairing_consents FOR SELECT TO grimoire_intake_app
 USING(org_id=app.current_org_id() AND app.intake_can_manage_workspace() AND NOT app.intake_scope_is_agent());
-- Never grant direct access to pairing proofs, credential hashes or rate state.
GRANT SELECT(id,org_id,principal_id,device_name,approved_by,approved_principal,approved_at,created_at,revoked_at,revoked_by,adapter,policy_version,content_class)
 ON grimoire.intake_worker_connections TO grimoire_intake_app;
GRANT SELECT ON grimoire.intake_worker_connection_events,grimoire.intake_worker_pairing_consents TO grimoire_intake_app;

CREATE FUNCTION app.intake_worker_pairing_limit(wanted_scope text,maximum integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE count_now integer; moment timestamptz:=clock_timestamp();
BEGIN
 INSERT INTO grimoire.intake_worker_pairing_limits(scope,window_start,requests) VALUES(wanted_scope,moment,1)
 ON CONFLICT(scope) DO UPDATE SET
 requests=CASE WHEN intake_worker_pairing_limits.window_start<moment-interval '1 minute' THEN 1 ELSE least(intake_worker_pairing_limits.requests+1,maximum+1) END,
 window_start=CASE WHEN intake_worker_pairing_limits.window_start<moment-interval '1 minute' THEN moment ELSE intake_worker_pairing_limits.window_start END
 RETURNING requests INTO count_now;
 RETURN count_now<=maximum;
END $$;

-- Re-derive the human and active organization from a real session, not caller
-- GUCs or a seeded bearer. Locks serialize disable/revoke with consent writes.
CREATE FUNCTION app.intake_worker_handler(wanted_session text)
RETURNS TABLE(identity_id uuid,org_id uuid,principal_id uuid,organization_name text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
BEGIN
 RETURN QUERY SELECT h.id,m.org_id,m.principal_id,o.name::text
 FROM grimoire.handler_sessions s JOIN grimoire.handler_identities h ON h.id=s.identity_id
 JOIN grimoire.handler_organization_memberships m ON (m.identity_id,m.org_id)=(h.id,s.active_org_id)
 JOIN grimoire.principals p ON (p.org_id,p.id)=(m.org_id,m.principal_id)
 JOIN grimoire.principal_roles r ON (r.org_id,r.principal_id)=(p.org_id,p.id) AND r.role='org_admin'
 JOIN grimoire.organizations o ON o.id=m.org_id
 WHERE s.token_sha256=wanted_session AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
 AND h.disabled_at IS NULL AND m.disabled_at IS NULL AND p.disabled_at IS NULL
 AND NOT EXISTS(SELECT 1 FROM grimoire.principal_roles a WHERE (a.org_id,a.principal_id)=(p.org_id,p.id) AND a.role IN ('read_only_agent','system_worker'))
 FOR SHARE OF s,h,m,p,r;
END $$;

CREATE FUNCTION app.intake_start_worker_pairing(wanted_name text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE secret text; pairing grimoire.intake_worker_pairings%ROWTYPE;
BEGIN
 IF wanted_name IS NULL OR length(btrim(wanted_name)) NOT BETWEEN 1 AND 80 OR wanted_name ~ '[[:cntrl:]]' THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='bounded device name required'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('worker-pairing-start',0));
 IF NOT app.intake_worker_pairing_limit('start',20) THEN RETURN jsonb_build_object('status','rate_limited'); END IF;
 DELETE FROM grimoire.intake_worker_pairings WHERE expires_at<clock_timestamp()-interval '1 hour' AND approved_at IS NULL;
 DELETE FROM grimoire.intake_worker_pairing_limits WHERE window_start<clock_timestamp()-interval '1 day';
 IF (SELECT count(*) FROM grimoire.intake_worker_pairings WHERE expires_at>clock_timestamp() AND consumed_at IS NULL)>=100 THEN
  RETURN jsonb_build_object('status','rate_limited'); END IF;
 secret:=encode(public.gen_random_bytes(32),'hex');
 INSERT INTO grimoire.intake_worker_pairings(device_sha256,user_code,device_name)
 VALUES(encode(public.digest(secret,'sha256'),'hex'),upper(encode(public.gen_random_bytes(8),'hex')),btrim(wanted_name)) RETURNING * INTO pairing;
 RETURN jsonb_build_object('pairing_id',pairing.id,'device_secret',secret,'user_code',pairing.user_code,'expires_at',pairing.expires_at,
  'poll_interval_seconds',3,'adapter','codex_cli','policy_version',pairing.policy_version,'content_class',pairing.content_class);
END $$;

CREATE FUNCTION app.intake_review_worker_pairing(wanted_session text,wanted_code text,wanted_org uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE handler record; pairing grimoire.intake_worker_pairings%ROWTYPE;
BEGIN
 SELECT * INTO handler FROM app.intake_worker_handler(wanted_session);
 IF NOT FOUND THEN RETURN jsonb_build_object('status','unauthorized'); END IF;
 IF wanted_org IS DISTINCT FROM handler.org_id THEN RETURN jsonb_build_object('status','organization_changed'); END IF;
 IF NOT app.intake_worker_pairing_limit('review:'||handler.identity_id::text,20) THEN RETURN jsonb_build_object('status','rate_limited'); END IF;
 SELECT * INTO pairing FROM grimoire.intake_worker_pairings WHERE user_code=wanted_code AND (org_id IS NULL OR org_id=handler.org_id);
 IF NOT FOUND THEN RETURN jsonb_build_object('status','not_found'); END IF;
 RETURN jsonb_build_object('status',CASE WHEN pairing.consumed_at IS NOT NULL THEN 'consumed' WHEN pairing.expires_at<=clock_timestamp() THEN 'expired' WHEN pairing.approved_at IS NOT NULL THEN 'approved' ELSE 'pending' END,
  'pairing_id',pairing.id,'user_code',pairing.user_code,'device_name',pairing.device_name,'expires_at',pairing.expires_at,
  'organization_id',handler.org_id,'organization_name',handler.organization_name,'connection_id',pairing.connection_id,
  'adapter','codex_cli','policy_version',pairing.policy_version,'content_class',pairing.content_class,
  'consent_text','Allow this local Codex worker to prepare synthetic Scion proposals for this organization using your installed Codex account. Synthetic task input and assigned instructions are sent to that provider. Provider credentials stay on your device. This does not grant engineering, commercial, sourcing, or human approval authority.');
END $$;

CREATE FUNCTION app.intake_approve_worker_pairing(wanted_session text,wanted_code text,wanted_org uuid,wanted_consent boolean,wanted_policy text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE handler record; pairing grimoire.intake_worker_pairings%ROWTYPE;
BEGIN
 SELECT * INTO handler FROM app.intake_worker_handler(wanted_session);
 IF NOT FOUND THEN RETURN jsonb_build_object('status','unauthorized'); END IF;
 IF wanted_org IS DISTINCT FROM handler.org_id THEN RETURN jsonb_build_object('status','organization_changed'); END IF;
 IF wanted_consent IS DISTINCT FROM true OR wanted_policy IS DISTINCT FROM 'codex-synthetic-v1' THEN RETURN jsonb_build_object('status','consent_required'); END IF;
 IF NOT app.intake_worker_pairing_limit('review:'||handler.identity_id::text,20) THEN RETURN jsonb_build_object('status','rate_limited'); END IF;
 SELECT * INTO pairing FROM grimoire.intake_worker_pairings WHERE user_code=wanted_code AND (org_id IS NULL OR org_id=handler.org_id) FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','not_found'); END IF;
 IF pairing.consumed_at IS NOT NULL THEN RETURN jsonb_build_object('status','consumed','connection_id',pairing.connection_id); END IF;
 IF pairing.expires_at<=clock_timestamp() THEN RETURN jsonb_build_object('status','expired'); END IF;
 IF pairing.approved_at IS NULL THEN
  UPDATE grimoire.intake_worker_pairings SET org_id=handler.org_id,approved_by=handler.identity_id,approved_principal=handler.principal_id,approved_at=clock_timestamp() WHERE id=pairing.id;
  INSERT INTO grimoire.intake_worker_pairing_consents(pairing_id,org_id,identity_id,principal_id,policy_version,content_class)
  VALUES(pairing.id,handler.org_id,handler.identity_id,handler.principal_id,pairing.policy_version,pairing.content_class);
 END IF;
 RETURN jsonb_build_object('status','approved','pairing_id',pairing.id,'organization_id',handler.org_id,'expires_at',pairing.expires_at);
END $$;

CREATE FUNCTION app.intake_poll_worker_pairing(wanted_secret text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE pairing grimoire.intake_worker_pairings%ROWTYPE; secret text; credential_hash text; new_principal uuid; new_connection uuid; organization_name text;
BEGIN
 IF NOT app.intake_worker_pairing_limit('poll',600) THEN RETURN jsonb_build_object('status','rate_limited'); END IF;
 IF wanted_secret IS NULL OR wanted_secret !~ '^[a-f0-9]{64}$' THEN RETURN jsonb_build_object('status','not_found'); END IF;
 SELECT * INTO pairing FROM grimoire.intake_worker_pairings WHERE device_sha256=encode(public.digest(wanted_secret,'sha256'),'hex') FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','not_found'); END IF;
 IF pairing.consumed_at IS NOT NULL THEN RETURN jsonb_build_object('status','consumed'); END IF;
 IF pairing.expires_at<=clock_timestamp() THEN RETURN jsonb_build_object('status','expired'); END IF;
 IF pairing.last_polled_at>clock_timestamp()-interval '3 seconds' THEN RETURN jsonb_build_object('status','rate_limited'); END IF;
 UPDATE grimoire.intake_worker_pairings SET last_polled_at=clock_timestamp() WHERE id=pairing.id;
 IF pairing.approved_at IS NULL THEN RETURN jsonb_build_object('status','pending','expires_at',pairing.expires_at,'poll_interval_seconds',3); END IF;
 -- Recheck that the approving Handler still has live organization membership.
 PERFORM 1 FROM grimoire.handler_identities h JOIN grimoire.handler_organization_memberships m ON m.identity_id=h.id
 JOIN grimoire.principals p ON (p.org_id,p.id)=(m.org_id,m.principal_id)
 JOIN grimoire.principal_roles r ON (r.org_id,r.principal_id)=(p.org_id,p.id) AND r.role='org_admin'
 WHERE (h.id,m.org_id,m.principal_id)=(pairing.approved_by,pairing.org_id,pairing.approved_principal)
 AND h.disabled_at IS NULL AND m.disabled_at IS NULL AND p.disabled_at IS NULL
 AND NOT EXISTS(SELECT 1 FROM grimoire.principal_roles a WHERE (a.org_id,a.principal_id)=(p.org_id,p.id) AND a.role IN ('read_only_agent','system_worker'))
 FOR SHARE OF h,m,p,r;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','denied'); END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('agent-org:'||pairing.org_id::text,0));
 IF (SELECT count(*) FROM grimoire.intake_worker_connections WHERE org_id=pairing.org_id AND revoked_at IS NULL)>=10 THEN
  RETURN jsonb_build_object('status','connection_limit'); END IF;
 PERFORM set_config('app.current_org_id',pairing.org_id::text,true);
 PERFORM set_config('app.current_principal_id',pairing.approved_principal::text,true);
 PERFORM set_config('app.request_id',gen_random_uuid()::text,true);
 PERFORM set_config('app.effective_role','handler_worker_pairing',true);
 PERFORM set_config('app.endpoint_scope','worker:pairing',true);
 PERFORM set_config('app.action_reason','Human consent for proposal-only synthetic Codex worker',true);
 PERFORM set_config('app.action_outcome','committed',true);
 secret:=encode(public.gen_random_bytes(32),'hex'); credential_hash:=encode(public.digest(secret,'sha256'),'hex');
 new_principal:=gen_random_uuid(); new_connection:=gen_random_uuid();
 INSERT INTO grimoire.principals(id,org_id,external_subject,display_name)
 VALUES(new_principal,pairing.org_id,'worker:codex:'||new_connection::text,pairing.device_name);
 INSERT INTO grimoire.principal_roles(org_id,principal_id,role) VALUES(pairing.org_id,new_principal,'read_only_agent');
 INSERT INTO grimoire.intake_scope_agents(org_id,principal_id) VALUES(pairing.org_id,new_principal);
 INSERT INTO grimoire.intake_credentials(token_sha256,org_id,principal_id,label)
 VALUES(credential_hash,pairing.org_id,new_principal,'Human-paired synthetic Codex worker');
 INSERT INTO grimoire.intake_worker_connections(id,org_id,principal_id,device_name,credential_sha256,approved_by,approved_principal,approved_at,policy_version,content_class)
 VALUES(new_connection,pairing.org_id,new_principal,pairing.device_name,credential_hash,pairing.approved_by,pairing.approved_principal,pairing.approved_at,pairing.policy_version,pairing.content_class);
 INSERT INTO grimoire.intake_worker_connection_events(org_id,connection_id,event_kind,actor_id,policy_version,content_class)
 VALUES(pairing.org_id,new_connection,'paired',pairing.approved_principal,pairing.policy_version,pairing.content_class);
 UPDATE grimoire.intake_worker_pairings SET consumed_at=clock_timestamp(),connection_id=new_connection WHERE id=pairing.id;
 SELECT name::text INTO organization_name FROM grimoire.organizations WHERE id=pairing.org_id;
 RETURN jsonb_build_object('status','approved','connection_id',new_connection,'organization_id',pairing.org_id,'organization_name',organization_name,
  'credential',secret,'adapter','codex_cli','policy_version',pairing.policy_version,'content_class',pairing.content_class);
END $$;

CREATE FUNCTION app.intake_revoke_worker_connection(wanted_session text,wanted_connection uuid,wanted_org uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE handler record; connection grimoire.intake_worker_connections%ROWTYPE;
BEGIN
 SELECT * INTO handler FROM app.intake_worker_handler(wanted_session);
 IF NOT FOUND THEN RETURN jsonb_build_object('status','unauthorized'); END IF;
 IF wanted_org IS DISTINCT FROM handler.org_id THEN RETURN jsonb_build_object('status','organization_changed'); END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('agent-org:'||handler.org_id::text,0));
 SELECT * INTO connection FROM grimoire.intake_worker_connections WHERE id=wanted_connection AND org_id=handler.org_id FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','not_found'); END IF;
 IF connection.revoked_at IS NOT NULL THEN RETURN jsonb_build_object('status','revoked','connection_id',connection.id); END IF;
 PERFORM set_config('app.current_org_id',handler.org_id::text,true);
 PERFORM set_config('app.current_principal_id',handler.principal_id::text,true);
 PERFORM set_config('app.request_id',gen_random_uuid()::text,true);
 PERFORM set_config('app.effective_role','handler_worker_pairing',true);
 PERFORM set_config('app.endpoint_scope','worker:revocation',true);
 PERFORM set_config('app.action_reason','Revoke local Codex worker connection',true);
 PERFORM set_config('app.action_outcome','committed',true);
 UPDATE grimoire.intake_worker_connections SET revoked_at=clock_timestamp(),revoked_by=handler.identity_id WHERE id=connection.id;
 UPDATE grimoire.intake_credentials SET revoked_at=clock_timestamp() WHERE token_sha256=connection.credential_sha256 AND revoked_at IS NULL;
 UPDATE grimoire.principals SET disabled_at=clock_timestamp() WHERE (org_id,id)=(handler.org_id,connection.principal_id) AND disabled_at IS NULL;
 DELETE FROM grimoire.intake_worker_presence WHERE (org_id,principal_id)=(handler.org_id,connection.principal_id);
 INSERT INTO grimoire.intake_worker_connection_events(org_id,connection_id,event_kind,actor_id,policy_version,content_class)
 VALUES(handler.org_id,connection.id,'revoked',handler.principal_id,connection.policy_version,connection.content_class);
 RETURN jsonb_build_object('status','revoked','connection_id',connection.id);
END $$;

REVOKE ALL ON FUNCTION app.intake_worker_pairing_limit(text,integer),app.intake_worker_handler(text),app.intake_start_worker_pairing(text),
 app.intake_review_worker_pairing(text,text,uuid),app.intake_approve_worker_pairing(text,text,uuid,boolean,text),app.intake_poll_worker_pairing(text),app.intake_revoke_worker_connection(text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.intake_start_worker_pairing(text),app.intake_review_worker_pairing(text,text,uuid),
 app.intake_approve_worker_pairing(text,text,uuid,boolean,text),app.intake_poll_worker_pairing(text),app.intake_revoke_worker_connection(text,uuid,uuid) TO grimoire_intake_app;
COMMIT;
