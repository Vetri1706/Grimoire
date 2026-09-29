BEGIN;
SET search_path=pg_catalog,grimoire,pg_temp;

CREATE TABLE grimoire.intake_managed_entities (
 id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES grimoire.organizations(id),
 kind text NOT NULL CHECK(kind IN ('agent','skill')), current_revision integer NOT NULL CHECK(current_revision>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(org_id,id)
);
CREATE TABLE grimoire.intake_managed_revisions (
 org_id uuid NOT NULL, entity_id uuid NOT NULL, number integer NOT NULL CHECK(number>0),
 config jsonb NOT NULL CHECK(jsonb_typeof(config)='object' AND octet_length(config::text)<64000),
 created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(org_id,entity_id,number),
 FOREIGN KEY(org_id,entity_id) REFERENCES grimoire.intake_managed_entities(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES grimoire.principals(org_id,id)
);
ALTER TABLE grimoire.intake_managed_entities ADD CONSTRAINT managed_current_revision
 FOREIGN KEY(org_id,id,current_revision) REFERENCES grimoire.intake_managed_revisions(org_id,entity_id,number) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE grimoire.intake_managed_receipts (
 org_id uuid NOT NULL, principal_id uuid NOT NULL, request_key text NOT NULL CHECK(length(request_key) BETWEEN 1 AND 128),
 request jsonb NOT NULL, response jsonb NOT NULL, PRIMARY KEY(org_id,principal_id,request_key),
 FOREIGN KEY(org_id,principal_id) REFERENCES grimoire.principals(org_id,id)
);
CREATE TABLE grimoire.intake_task_agent_bindings (
 org_id uuid NOT NULL, task_id uuid NOT NULL, agent_id uuid NOT NULL, agent_revision integer NOT NULL,
 snapshot jsonb NOT NULL CHECK(octet_length(snapshot::text)<128000), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(org_id,task_id),
 FOREIGN KEY(org_id,task_id) REFERENCES grimoire.intake_agent_tasks(org_id,id),
 FOREIGN KEY(org_id,agent_id,agent_revision) REFERENCES grimoire.intake_managed_revisions(org_id,entity_id,number)
);
CREATE INDEX intake_native_agent_tasks ON grimoire.intake_task_agent_bindings(org_id,agent_id,created_at);
CREATE TABLE grimoire.intake_worker_presence (
 org_id uuid NOT NULL, principal_id uuid NOT NULL, protocol integer NOT NULL CHECK(protocol=2),
 last_seen timestamptz NOT NULL, PRIMARY KEY(org_id,principal_id),
 FOREIGN KEY(org_id,principal_id) REFERENCES grimoire.principals(org_id,id)
);

CREATE FUNCTION app.intake_save_managed(kind_arg text,id_arg uuid,expected integer,body jsonb,retry_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE organization uuid:=app.current_org_id(); principal uuid:=app.current_principal_id();
 request_body jsonb:=jsonb_build_object('kind',kind_arg,'id',id_arg,'expected',expected,'config',body);
 receipt grimoire.intake_managed_receipts%ROWTYPE; entity grimoire.intake_managed_entities%ROWTYPE;
 result jsonb; ancestor uuid; visited uuid[]; skill uuid; revision integer; new_id uuid:=COALESCE(id_arg,gen_random_uuid());
BEGIN
 IF NOT app.intake_can_write() OR app.intake_scope_is_agent() THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Handler required'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('agent-org:'||organization::text,0));
 SELECT * INTO receipt FROM grimoire.intake_managed_receipts WHERE (org_id,principal_id,request_key)=(organization,principal,retry_key);
 IF FOUND THEN
  IF receipt.request<>request_body THEN RAISE EXCEPTION USING ERRCODE='G3303',MESSAGE='retry differs'; END IF;
  RETURN receipt.response;
 END IF;
 IF kind_arg NOT IN ('agent','skill') OR jsonb_typeof(body)<>'object' OR length(btrim(body->>'name')) NOT BETWEEN 1 AND 100
  OR length(body->>'instructions')>12000 OR jsonb_typeof(body->'instructions') IS DISTINCT FROM 'string' OR jsonb_typeof(body->'name') IS DISTINCT FROM 'string' THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='invalid managed configuration';
 END IF;
 IF id_arg IS NULL THEN
  IF expected<>0 THEN RAISE EXCEPTION USING ERRCODE='G4302',MESSAGE='invalid create revision'; END IF;
  revision:=1;
 ELSE
  SELECT * INTO entity FROM grimoire.intake_managed_entities WHERE (org_id,id,kind)=(organization,id_arg,kind_arg) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='G3804',MESSAGE='record not found'; END IF;
  IF entity.current_revision<>expected THEN RAISE EXCEPTION USING ERRCODE='G4302',MESSAGE='configuration changed'; END IF;
  revision:=expected+1;
 END IF;
 IF kind_arg='agent' THEN
  IF body - ARRAY['name','role','title','instructions','capabilities','reports_to','adapter','timeout_seconds','skill_ids','paused']<>'{}'::jsonb
   OR NOT(body ?& ARRAY['name','role','title','instructions','capabilities','reports_to','adapter','timeout_seconds','skill_ids','paused'])
   OR body->>'adapter'<>'codex_cli' OR (body->>'timeout_seconds')::integer NOT BETWEEN 30 AND 300
   OR jsonb_typeof(body->'paused')<>'boolean' OR jsonb_typeof(body->'skill_ids')<>'array' OR jsonb_array_length(body->'skill_ids')>8
   OR jsonb_typeof(body->'role') IS DISTINCT FROM 'string' OR jsonb_typeof(body->'title') IS DISTINCT FROM 'string'
   OR jsonb_typeof(body->'capabilities') IS DISTINCT FROM 'string' OR jsonb_typeof(body->'timeout_seconds') IS DISTINCT FROM 'number'
   OR length(body->>'role') NOT BETWEEN 1 AND 100 OR length(body->>'title')>160 OR length(body->>'capabilities')>2000
   OR (SELECT count(*)<>count(DISTINCT value) FROM jsonb_array_elements_text(body->'skill_ids')) THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='bounded agent config required';
  END IF;
  ancestor:=(body->>'reports_to')::uuid; visited:=ARRAY[new_id];
  WHILE ancestor IS NOT NULL LOOP
   IF ancestor=ANY(visited) OR cardinality(visited)>64 THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='reporting cycle'; END IF;
   visited:=array_append(visited,ancestor);
   SELECT (r.config->>'reports_to')::uuid INTO ancestor FROM grimoire.intake_managed_entities e
    JOIN grimoire.intake_managed_revisions r ON (r.org_id,r.entity_id,r.number)=(e.org_id,e.id,e.current_revision)
    WHERE e.org_id=organization AND e.id=ancestor AND e.kind='agent';
   IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='G3804',MESSAGE='manager not found'; END IF;
  END LOOP;
  FOR skill IN SELECT value::uuid FROM jsonb_array_elements_text(body->'skill_ids') LOOP
   IF NOT EXISTS(SELECT 1 FROM grimoire.intake_managed_entities WHERE org_id=organization AND id=skill AND kind='skill') THEN
    RAISE EXCEPTION USING ERRCODE='G3804',MESSAGE='skill not found';
   END IF;
  END LOOP;
 ELSE
  IF body - ARRAY['name','description','instructions']<>'{}'::jsonb OR NOT(body ?& ARRAY['name','description','instructions'])
    OR jsonb_typeof(body->'description') IS DISTINCT FROM 'string' OR length(body->>'description')>2000 OR length(btrim(body->>'instructions'))<1 THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='bounded skill required';
  END IF;
 END IF;
 IF id_arg IS NULL THEN INSERT INTO grimoire.intake_managed_entities(id,org_id,kind,current_revision) VALUES(new_id,organization,kind_arg,revision);
 ELSE UPDATE grimoire.intake_managed_entities SET current_revision=revision,updated_at=clock_timestamp() WHERE id=new_id AND org_id=organization; END IF;
 INSERT INTO grimoire.intake_managed_revisions(org_id,entity_id,number,config,created_by) VALUES(organization,new_id,revision,body,principal);
 IF kind_arg='agent' AND (body->>'paused')::boolean THEN
  UPDATE grimoire.intake_agent_tasks SET status='cancel_requested' WHERE org_id=organization AND status='running' AND id IN
   (SELECT task_id FROM grimoire.intake_task_agent_bindings WHERE org_id=organization AND agent_id=new_id);
 END IF;
 result:=jsonb_build_object('id',new_id,'kind',kind_arg,'revision',revision,'config',body);
 INSERT INTO grimoire.intake_managed_receipts VALUES(organization,principal,retry_key,request_body,result);
 RETURN result;
END $$;

CREATE FUNCTION app.intake_bind_agent_task(task_arg uuid,agent_arg uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE organization uuid:=app.current_org_id(); profile jsonb; version integer; task grimoire.intake_agent_tasks%ROWTYPE; skills jsonb; previous uuid;
BEGIN
 IF NOT app.intake_can_write() OR app.intake_scope_is_agent() THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Handler required'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('agent-org:'||organization::text,0));
 SELECT r.config,r.number INTO profile,version FROM grimoire.intake_managed_entities e
  JOIN grimoire.intake_managed_revisions r ON (r.org_id,r.entity_id,r.number)=(e.org_id,e.id,e.current_revision)
  WHERE e.org_id=organization AND e.id=agent_arg AND e.kind='agent' FOR SHARE OF e;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='G3804',MESSAGE='agent not found'; END IF;
 SELECT * INTO task FROM grimoire.intake_agent_tasks WHERE org_id=organization AND id=task_arg FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='G3804',MESSAGE='task not found'; END IF;
 SELECT agent_id INTO previous FROM grimoire.intake_task_agent_bindings WHERE org_id=organization AND task_id=task_arg;
 IF FOUND THEN
  IF previous=agent_arg THEN RETURN; END IF;
  RAISE EXCEPTION USING ERRCODE='G2901',MESSAGE='assignment immutable';
 END IF;
 IF task.status<>'queued' OR task.timeout_seconds>(profile->>'timeout_seconds')::integer OR (profile->>'paused')::boolean THEN
  RAISE EXCEPTION USING ERRCODE='G4301',MESSAGE='agent paused or execution bounds incompatible';
 END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('id',e.id,'revision',r.number,'name',r.config->>'name','instructions',r.config->>'instructions') ORDER BY e.id),'[]'::jsonb)
  INTO skills FROM grimoire.intake_managed_entities e JOIN grimoire.intake_managed_revisions r ON (r.org_id,r.entity_id,r.number)=(e.org_id,e.id,e.current_revision)
  WHERE e.org_id=organization AND e.kind='skill' AND e.id IN (SELECT value::uuid FROM jsonb_array_elements_text(profile->'skill_ids'));
 INSERT INTO grimoire.intake_task_agent_bindings(org_id,task_id,agent_id,agent_revision,snapshot)
 VALUES(organization,task_arg,agent_arg,version,jsonb_build_object('id',agent_arg,'revision',version,'name',profile->>'name','instructions',profile->>'instructions','skills',skills,'adapter','codex_cli'));
END $$;

CREATE FUNCTION app.intake_assert_managed_task(task_arg uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM grimoire.intake_task_agent_bindings b JOIN grimoire.intake_managed_entities e ON (e.org_id,e.id)=(b.org_id,b.agent_id)
  JOIN grimoire.intake_managed_revisions r ON (r.org_id,r.entity_id,r.number)=(e.org_id,e.id,e.current_revision)
  WHERE b.org_id=app.current_org_id() AND b.task_id=task_arg AND (r.config->>'paused')::boolean) THEN
  RAISE EXCEPTION USING ERRCODE='G4301',MESSAGE='agent paused';
 END IF;
END $$;
CREATE FUNCTION grimoire.intake_managed_execution_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
BEGIN
 IF TG_TABLE_NAME='intake_agent_tasks' THEN
  IF NEW.status IN ('dispatched','running','completed') THEN PERFORM app.intake_assert_managed_task(NEW.id); END IF;
 ELSE
  IF app.intake_scope_is_agent() THEN PERFORM app.intake_assert_managed_task(NULLIF(current_setting('app.agent_task_id',true),'')::uuid); END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER intake_managed_task_guard BEFORE UPDATE ON grimoire.intake_agent_tasks FOR EACH ROW EXECUTE FUNCTION grimoire.intake_managed_execution_guard();
CREATE TRIGGER intake_managed_plan_guard BEFORE INSERT ON grimoire.intake_capability_plans FOR EACH ROW EXECUTE FUNCTION grimoire.intake_managed_execution_guard();
CREATE TRIGGER intake_managed_scope_guard BEFORE INSERT ON grimoire.intake_scope_proposals FOR EACH ROW EXECUTE FUNCTION grimoire.intake_managed_execution_guard();
CREATE TRIGGER intake_managed_offer_guard BEFORE INSERT ON grimoire.intake_comparison_proposals FOR EACH ROW EXECUTE FUNCTION grimoire.intake_managed_execution_guard();

CREATE FUNCTION app.intake_worker_seen() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
BEGIN
 IF NOT app.intake_scope_is_agent() OR NOT app.intake_scope_can_propose() THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='worker required'; END IF;
 INSERT INTO grimoire.intake_worker_presence VALUES(app.current_org_id(),app.current_principal_id(),2,clock_timestamp())
 ON CONFLICT(org_id,principal_id) DO UPDATE SET last_seen=EXCLUDED.last_seen;
END $$;
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['intake_managed_entities','intake_managed_revisions','intake_managed_receipts','intake_task_agent_bindings','intake_worker_presence'] LOOP
  EXECUTE format('ALTER TABLE grimoire.%I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY %I_org_read ON grimoire.%I FOR SELECT TO grimoire_intake_app USING(org_id=app.current_org_id() AND app.intake_can_access())',name,name);
  EXECUTE format('REVOKE ALL ON grimoire.%I FROM PUBLIC,grimoire_intake_app',name);
  EXECUTE format('GRANT SELECT ON grimoire.%I TO grimoire_intake_app',name);
 END LOOP;
 FOREACH name IN ARRAY ARRAY['intake_managed_revisions','intake_managed_receipts','intake_task_agent_bindings'] LOOP
  EXECUTE format('CREATE TRIGGER %I_immutable BEFORE UPDATE OR DELETE ON grimoire.%I FOR EACH ROW EXECUTE FUNCTION grimoire.intake_deny_mutation()',name,name);
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION app.intake_save_managed(text,uuid,integer,jsonb,text),app.intake_bind_agent_task(uuid,uuid),app.intake_assert_managed_task(uuid),app.intake_worker_seen(),grimoire.intake_managed_execution_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.intake_save_managed(text,uuid,integer,jsonb,text),app.intake_bind_agent_task(uuid,uuid),app.intake_assert_managed_task(uuid),app.intake_worker_seen() TO grimoire_intake_app;
COMMIT;
