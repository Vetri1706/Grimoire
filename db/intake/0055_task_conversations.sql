-- Task conversation metadata reuses native execution, proposal and revision records.
BEGIN;
CREATE TABLE grimoire.intake_task_messages (
 id uuid PRIMARY KEY,org_id uuid NOT NULL,scion_id uuid NOT NULL,scion_revision integer NOT NULL,thread_task_id uuid NOT NULL,
 author_principal_id uuid NOT NULL,author_name text NOT NULL CHECK(length(author_name) BETWEEN 1 AND 160),
 body text NOT NULL CHECK(length(btrim(body)) BETWEEN 1 AND 4000),intent text NOT NULL CHECK(intent IN ('note','follow_up')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),request_key text NOT NULL CHECK(length(request_key) BETWEEN 1 AND 128),
 request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
 UNIQUE(org_id,id),UNIQUE(org_id,author_principal_id,request_key),
 FOREIGN KEY(org_id,thread_task_id) REFERENCES grimoire.intake_agent_tasks(org_id,id),
 FOREIGN KEY(org_id,scion_id,scion_revision) REFERENCES grimoire.intake_revisions(org_id,scion_id,number),
 FOREIGN KEY(org_id,author_principal_id) REFERENCES grimoire.principals(org_id,id)
);
CREATE TABLE grimoire.intake_task_followups (
 org_id uuid NOT NULL,thread_task_id uuid NOT NULL,parent_task_id uuid NOT NULL,message_id uuid NOT NULL,agent_task_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(org_id,agent_task_id),UNIQUE(org_id,message_id),
 FOREIGN KEY(org_id,thread_task_id) REFERENCES grimoire.intake_agent_tasks(org_id,id),
 FOREIGN KEY(org_id,parent_task_id) REFERENCES grimoire.intake_agent_tasks(org_id,id),
 FOREIGN KEY(org_id,agent_task_id) REFERENCES grimoire.intake_agent_tasks(org_id,id),
 FOREIGN KEY(org_id,message_id) REFERENCES grimoire.intake_task_messages(org_id,id),
 CHECK(agent_task_id<>thread_task_id AND agent_task_id<>parent_task_id)
);
CREATE INDEX intake_task_messages_thread ON grimoire.intake_task_messages(org_id,thread_task_id,created_at,id);
CREATE INDEX intake_task_followups_thread ON grimoire.intake_task_followups(org_id,thread_task_id,created_at,agent_task_id);

CREATE FUNCTION app.intake_conversation_blocked(wanted_root uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
 SELECT EXISTS(SELECT 1 FROM grimoire.intake_watch_node_states s WHERE s.org_id=app.current_org_id() AND s.node_kind='agent_task' AND s.blocked
 AND (s.node_id=wanted_root OR s.node_id IN(SELECT agent_task_id FROM grimoire.intake_task_followups WHERE org_id=s.org_id AND thread_task_id=wanted_root)))
$$;
REVOKE ALL ON FUNCTION app.intake_conversation_blocked(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.intake_conversation_blocked(uuid) TO grimoire_intake_app;

CREATE FUNCTION grimoire.intake_conversation_write_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE root grimoire.intake_agent_tasks%ROWTYPE; parent grimoire.intake_agent_tasks%ROWTYPE; child grimoire.intake_agent_tasks%ROWTYPE; message grimoire.intake_task_messages%ROWTYPE;
BEGIN
 IF TG_OP<>'INSERT' OR NEW.org_id IS DISTINCT FROM app.current_org_id() OR NOT app.intake_can_prepare_workspace()
 THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Handler task messages are append-only'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('agent-org:'||NEW.org_id,0));
 SELECT * INTO root FROM grimoire.intake_agent_tasks WHERE (org_id,id)=(NEW.org_id,NEW.thread_task_id);
 IF NOT FOUND OR EXISTS(SELECT 1 FROM grimoire.intake_task_followups WHERE (org_id,agent_task_id)=(NEW.org_id,NEW.thread_task_id))
 THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='canonical task thread required'; END IF;
 PERFORM app.intake_scope_lock_scion(root.scion_id);
 IF TG_TABLE_NAME='intake_task_messages' THEN
  IF NEW.author_principal_id IS DISTINCT FROM app.current_principal_id() OR NEW.scion_id IS DISTINCT FROM root.scion_id
  OR NOT EXISTS(SELECT 1 FROM grimoire.principals WHERE (org_id,id,display_name)=(NEW.org_id,NEW.author_principal_id,NEW.author_name))
  THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='message author and task scope must match'; END IF;
  IF NOT EXISTS(SELECT 1 FROM grimoire.intake_scions WHERE (org_id,id,current_revision)=(NEW.org_id,NEW.scion_id,NEW.scion_revision))
  THEN RAISE EXCEPTION USING ERRCODE='G2402',MESSAGE='message revision changed'; END IF;
 ELSE
  SELECT * INTO message FROM grimoire.intake_task_messages WHERE (org_id,id)=(NEW.org_id,NEW.message_id);
  SELECT * INTO child FROM grimoire.intake_agent_tasks WHERE (org_id,id)=(NEW.org_id,NEW.agent_task_id);
  SELECT * INTO parent FROM grimoire.intake_agent_tasks WHERE (org_id,id)=(NEW.org_id,NEW.parent_task_id);
  IF message.id IS NULL OR child.id IS NULL OR parent.id IS NULL OR message.intent<>'follow_up' OR message.author_principal_id IS DISTINCT FROM app.current_principal_id()
  OR message.thread_task_id<>root.id OR child.created_by IS DISTINCT FROM message.author_principal_id OR child.scion_id<>root.scion_id OR parent.scion_id<>root.scion_id
  OR child.scion_revision<>message.scion_revision OR child.status<>'queued' OR child.task_kind<>root.task_kind OR parent.task_kind<>root.task_kind
  OR child.task_kind NOT IN ('prepare_capability_plan','research_public_web')
  OR (parent.id<>root.id AND NOT EXISTS(SELECT 1 FROM grimoire.intake_task_followups WHERE (org_id,thread_task_id,agent_task_id)=(NEW.org_id,root.id,parent.id)))
  OR (child.task_kind='prepare_capability_plan' AND NOT EXISTS(SELECT 1 FROM grimoire.intake_revisions WHERE (org_id,scion_id,number,product_category)=(NEW.org_id,root.scion_id,child.scion_revision,'digital')))
  OR (child.task_kind='research_public_web' AND child.input->'candidate_proposal'->>'objective' IS DISTINCT FROM message.body)
  THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='follow-up must bind this Handler message to a new native task'; END IF;
  IF app.intake_conversation_blocked(root.id) THEN RAISE EXCEPTION USING ERRCODE='G2601',MESSAGE='thread evidence is blocked'; END IF;
  IF EXISTS(SELECT 1 FROM grimoire.intake_agent_tasks t WHERE t.org_id=NEW.org_id AND t.status IN ('queued','dispatched','running','cancel_requested')
    AND (t.id=root.id OR t.id IN(SELECT agent_task_id FROM grimoire.intake_task_followups WHERE org_id=NEW.org_id AND thread_task_id=root.id)))
  THEN RAISE EXCEPTION USING ERRCODE='G5501',MESSAGE='wait for the active thread task before requesting follow-up'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION grimoire.intake_conversation_write_guard() FROM PUBLIC;
CREATE TRIGGER intake_task_message_guard BEFORE INSERT OR UPDATE OR DELETE ON grimoire.intake_task_messages FOR EACH ROW EXECUTE FUNCTION grimoire.intake_conversation_write_guard();
CREATE TRIGGER intake_task_followup_guard BEFORE INSERT OR UPDATE OR DELETE ON grimoire.intake_task_followups FOR EACH ROW EXECUTE FUNCTION grimoire.intake_conversation_write_guard();

CREATE FUNCTION grimoire.intake_conversation_task_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE root uuid;
BEGIN
 SELECT thread_task_id INTO root FROM grimoire.intake_task_followups WHERE (org_id,agent_task_id)=(NEW.org_id,NEW.id);
 IF root IS NOT NULL AND NEW.status IN ('dispatched','running','completed') THEN
  IF app.intake_conversation_blocked(root) THEN RAISE EXCEPTION USING ERRCODE='G2601',MESSAGE='thread evidence is blocked'; END IF;
  IF NEW.status='running' AND OLD.status<>'running' AND current_setting('app.task_messages_protocol',true) IS DISTINCT FROM '1'
  THEN RAISE EXCEPTION USING ERRCODE='G5502',MESSAGE='message-aware worker required'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION grimoire.intake_conversation_task_guard() FROM PUBLIC;
CREATE TRIGGER intake_conversation_task_guard BEFORE UPDATE ON grimoire.intake_agent_tasks FOR EACH ROW EXECUTE FUNCTION grimoire.intake_conversation_task_guard();

DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['intake_task_messages','intake_task_followups'] LOOP
  EXECUTE format('ALTER TABLE grimoire.%I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY conversation_read ON grimoire.%I FOR SELECT TO grimoire_intake_app USING(org_id=app.current_org_id() AND app.intake_can_access())',name);
  EXECUTE format('CREATE POLICY conversation_insert ON grimoire.%I FOR INSERT TO grimoire_intake_app WITH CHECK(org_id=app.current_org_id() AND app.intake_can_prepare_workspace())',name);
  EXECUTE format('GRANT SELECT,INSERT ON grimoire.%I TO grimoire_intake_app',name);
 END LOOP;
END $$;
COMMIT;
