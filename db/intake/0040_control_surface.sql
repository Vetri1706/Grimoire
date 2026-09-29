-- Organization-scoped Grimoire OS projection and durable internal Watchtower.
-- Events are emitted in the source transaction; the API worker checks health,
-- never schedules agents or polls an unimplemented external provider.
BEGIN;
SET search_path=pg_catalog,grimoire,pg_temp;

CREATE TABLE grimoire.intake_watches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, scion_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('scion_revisions','source_changes','agent_outcomes')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 last_successful_check timestamptz, last_event_at timestamptz,
 UNIQUE(org_id,scion_id,kind), UNIQUE(org_id,id),
 FOREIGN KEY(org_id,scion_id) REFERENCES grimoire.intake_scions(org_id,id)
);
CREATE TABLE grimoire.intake_watch_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, scion_id uuid NOT NULL,
 event_key text NOT NULL CHECK(length(event_key)<=240), kind text NOT NULL,
 subject_id uuid NOT NULL, subject_revision integer,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 summary text NOT NULL CHECK(length(summary)<=500),
 UNIQUE(org_id,event_key), UNIQUE(org_id,id),
 FOREIGN KEY(org_id,scion_id) REFERENCES grimoire.intake_scions(org_id,id)
);
CREATE INDEX intake_watch_events_case ON grimoire.intake_watch_events(org_id,scion_id,recorded_at DESC,id);
CREATE TABLE grimoire.intake_watch_reviews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, scion_id uuid NOT NULL,
 event_id uuid NOT NULL, status text NOT NULL DEFAULT 'required' CHECK(status='required'),
 reason text NOT NULL CHECK(length(reason)<=500), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(org_id,event_id),
 FOREIGN KEY(org_id,event_id) REFERENCES grimoire.intake_watch_events(org_id,id),
 FOREIGN KEY(org_id,scion_id) REFERENCES grimoire.intake_scions(org_id,id)
);
CREATE TABLE grimoire.intake_watch_dependencies (
 org_id uuid NOT NULL, scion_id uuid NOT NULL, node_kind text NOT NULL,
 node_id uuid NOT NULL, scion_revision integer NOT NULL,
 source_id uuid, source_revision integer,
 CHECK(node_kind IN ('capability_proposal','comparison','agent_task')),
 UNIQUE NULLS NOT DISTINCT(org_id,node_kind,node_id,source_id),
 FOREIGN KEY(org_id,scion_id,scion_revision) REFERENCES grimoire.intake_revisions(org_id,scion_id,number),
 FOREIGN KEY(org_id,source_id,source_revision) REFERENCES grimoire.intake_source_revisions(org_id,source_id,number)
);
CREATE TABLE grimoire.intake_watch_node_states (
 org_id uuid NOT NULL, scion_id uuid NOT NULL, node_kind text NOT NULL, node_id uuid NOT NULL,
 stale boolean NOT NULL DEFAULT false, blocked boolean NOT NULL DEFAULT false,
 reason text, event_id uuid, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(org_id,node_kind,node_id),
 FOREIGN KEY(org_id,scion_id) REFERENCES grimoire.intake_scions(org_id,id),
 FOREIGN KEY(org_id,event_id) REFERENCES grimoire.intake_watch_events(org_id,id)
);

CREATE FUNCTION grimoire.intake_watch_ensure(org uuid,scion uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
 INSERT INTO grimoire.intake_watches(org_id,scion_id,kind)
 SELECT org,scion,kind FROM unnest(ARRAY['scion_revisions','source_changes','agent_outcomes']) kind
 ON CONFLICT(org_id,scion_id,kind) DO NOTHING
$$;

-- No externally callable event-injection endpoint. Unique mutation identity is
-- the idempotency boundary for both the append-only event and its review task.
CREATE FUNCTION grimoire.intake_watch_emit(org uuid,scion uuid,watch_kind text,event_kind text,
 subject uuid,revision integer,event_identity text,message text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE recorded uuid; at_time timestamptz:=clock_timestamp();
BEGIN
 PERFORM grimoire.intake_watch_ensure(org,scion);
 INSERT INTO grimoire.intake_watch_events(org_id,scion_id,event_key,kind,subject_id,subject_revision,summary,recorded_at)
 VALUES(org,scion,event_identity,event_kind,subject,revision,message,at_time)
 ON CONFLICT(org_id,event_key) DO NOTHING RETURNING id INTO recorded;
 IF recorded IS NULL THEN RETURN; END IF;
 UPDATE grimoire.intake_watches SET last_event_at=at_time
 WHERE org_id=org AND scion_id=scion AND kind=watch_kind;
 INSERT INTO grimoire.intake_watch_reviews(org_id,scion_id,event_id,reason)
 VALUES(org,scion,recorded,message||' Human review is required; no approval was created.');
 IF event_kind IN ('scion_revision_changed','source_revision_changed','source_permission_revoked') THEN
  INSERT INTO grimoire.intake_watch_node_states(org_id,scion_id,node_kind,node_id,stale,blocked,reason,event_id)
  SELECT DISTINCT org,scion,d.node_kind,d.node_id,true,event_kind='source_permission_revoked',event_kind,recorded
  FROM grimoire.intake_watch_dependencies d
  WHERE d.org_id=org AND d.scion_id=scion AND
    ((event_kind='scion_revision_changed' AND d.scion_revision<revision) OR
     (event_kind='source_revision_changed' AND d.source_id=subject AND d.source_revision<revision) OR
     (event_kind='source_permission_revoked' AND d.source_id=subject))
  ON CONFLICT(org_id,node_kind,node_id) DO UPDATE SET stale=true,
    blocked=grimoire.intake_watch_node_states.blocked OR EXCLUDED.blocked,
    reason=CASE WHEN grimoire.intake_watch_node_states.blocked THEN grimoire.intake_watch_node_states.reason ELSE EXCLUDED.reason END,
    event_id=EXCLUDED.event_id,updated_at=at_time;
 END IF;
END $$;

CREATE FUNCTION grimoire.intake_watch_scion_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
BEGIN
 PERFORM grimoire.intake_watch_ensure(NEW.org_id,NEW.scion_id);
 IF NEW.number>1 THEN
  PERFORM grimoire.intake_watch_emit(NEW.org_id,NEW.scion_id,'scion_revisions','scion_revision_changed',NEW.scion_id,NEW.number,
   'scion:'||NEW.scion_id||':revision:'||NEW.number,'Scion revision changed; dependent drafts must be prepared again.');
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER intake_watch_scion_event AFTER INSERT ON grimoire.intake_revisions
FOR EACH ROW EXECUTE FUNCTION grimoire.intake_watch_scion_event();

CREATE FUNCTION grimoire.intake_watch_source_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE scion uuid;
BEGIN
 SELECT scion_id INTO STRICT scion FROM grimoire.intake_sources WHERE org_id=NEW.org_id AND id=NEW.source_id;
 IF TG_TABLE_NAME='intake_source_revocations' THEN
  PERFORM grimoire.intake_watch_emit(NEW.org_id,scion,'source_changes','source_permission_revoked',NEW.source_id,NEW.source_revision,
   'source:'||NEW.source_id||':permission:revoked','Source permission revoked; source content is hidden and dependent work is blocked.');
 ELSE
  PERFORM grimoire.intake_watch_emit(NEW.org_id,scion,'source_changes','source_revision_changed',NEW.source_id,NEW.number,
   'source:'||NEW.source_id||':revision:'||NEW.number,'Source revision recorded; review its permission and affected evidence.');
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER intake_watch_source_event AFTER INSERT ON grimoire.intake_source_revisions
FOR EACH ROW EXECUTE FUNCTION grimoire.intake_watch_source_event();
CREATE TRIGGER intake_watch_revocation_event AFTER INSERT ON grimoire.intake_source_revocations
FOR EACH ROW EXECUTE FUNCTION grimoire.intake_watch_source_event();

CREATE FUNCTION grimoire.intake_watch_register_dependency(org uuid,scion uuid,kind text,node uuid,revision integer,source uuid DEFAULT NULL,source_number integer DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE is_old boolean; is_revoked boolean;
BEGIN
 INSERT INTO grimoire.intake_watch_dependencies(org_id,scion_id,node_kind,node_id,scion_revision,source_id,source_revision)
 VALUES(org,scion,kind,node,revision,source,source_number) ON CONFLICT DO NOTHING;
 SELECT current_revision<>revision INTO is_old FROM grimoire.intake_scions WHERE org_id=org AND id=scion;
 IF source IS NOT NULL THEN
  SELECT is_old OR current_revision<>source_number INTO is_old FROM grimoire.intake_sources WHERE org_id=org AND id=source;
  SELECT EXISTS(SELECT 1 FROM grimoire.intake_source_revocations WHERE org_id=org AND source_id=source) INTO is_revoked;
 ELSE is_revoked:=false; END IF;
 INSERT INTO grimoire.intake_watch_node_states(org_id,scion_id,node_kind,node_id,stale,blocked,reason)
 VALUES(org,scion,kind,node,is_old OR is_revoked,is_revoked,
  CASE WHEN is_revoked THEN 'source_permission_revoked' WHEN is_old THEN 'stale_dependency' ELSE NULL END)
 ON CONFLICT(org_id,node_kind,node_id) DO UPDATE SET stale=grimoire.intake_watch_node_states.stale OR EXCLUDED.stale,
 blocked=grimoire.intake_watch_node_states.blocked OR EXCLUDED.blocked,
 reason=COALESCE(grimoire.intake_watch_node_states.reason,EXCLUDED.reason);
END $$;

CREATE FUNCTION grimoire.intake_watch_artifact_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE kind text; src record;
BEGIN
 kind:=CASE TG_TABLE_NAME WHEN 'intake_capability_plans' THEN 'capability_proposal' WHEN 'intake_evidence_comparisons' THEN 'comparison' ELSE 'agent_task' END;
 IF TG_OP='INSERT' THEN
  PERFORM grimoire.intake_watch_register_dependency(NEW.org_id,NEW.scion_id,kind,NEW.id,NEW.scion_revision);
  IF kind='comparison' THEN
   FOR src IN SELECT DISTINCT c.source_id,c.source_revision FROM grimoire.intake_source_claims c
    WHERE c.org_id=NEW.org_id AND c.id IN
     (SELECT v.value::uuid FROM jsonb_array_elements(NEW.input->'alternatives') a
      CROSS JOIN LATERAL jsonb_array_elements(a->'criteria') criterion CROSS JOIN LATERAL jsonb_array_elements_text(criterion->'claim_ids') v)
   LOOP PERFORM grimoire.intake_watch_register_dependency(NEW.org_id,NEW.scion_id,kind,NEW.id,NEW.scion_revision,src.source_id,src.source_revision); END LOOP;
   FOR src IN SELECT source_id,source_revision FROM grimoire.intake_watch_dependencies
    WHERE org_id=NEW.org_id AND node_kind='capability_proposal' AND node_id=NEW.plan_id AND source_id IS NOT NULL
   LOOP PERFORM grimoire.intake_watch_register_dependency(NEW.org_id,NEW.scion_id,kind,NEW.id,NEW.scion_revision,src.source_id,src.source_revision); END LOOP;
  ELSE
   -- Capability proposals declaring the source connector conservatively depend
   -- on the current authorized source set. Physical tasks retain their existing
   -- stronger exact-source submission guards as well.
   IF (kind='agent_task' AND NEW.input->>'task_kind'='prepare_capability_plan') OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.input->'capabilities') c WHERE c->'connector_ids' ? 'scion_sources') THEN
    FOR src IN SELECT id,current_revision FROM grimoire.intake_sources s WHERE s.org_id=NEW.org_id AND s.scion_id=NEW.scion_id AND s.current_revision>0
     AND NOT EXISTS(SELECT 1 FROM grimoire.intake_source_revocations v WHERE v.org_id=s.org_id AND v.source_id=s.id)
    LOOP PERFORM grimoire.intake_watch_register_dependency(NEW.org_id,NEW.scion_id,kind,NEW.id,NEW.scion_revision,src.id,src.current_revision); END LOOP;
   END IF;
  END IF;
 END IF;
 IF kind='agent_task' AND TG_OP='UPDATE' AND NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('completed','failed','cancelled') THEN
  PERFORM grimoire.intake_watch_emit(NEW.org_id,NEW.scion_id,'agent_outcomes','agent_task_'||NEW.status,NEW.id,NEW.scion_revision,
   'task:'||NEW.id||':attempt:'||NEW.attempt||':'||NEW.status,'Agent task '||NEW.status||'; inspect the recorded outcome.');
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER intake_watch_plan_event AFTER INSERT ON grimoire.intake_capability_plans FOR EACH ROW EXECUTE FUNCTION grimoire.intake_watch_artifact_event();
CREATE TRIGGER intake_watch_comparison_event AFTER INSERT ON grimoire.intake_evidence_comparisons FOR EACH ROW EXECUTE FUNCTION grimoire.intake_watch_artifact_event();
CREATE TRIGGER intake_watch_task_event AFTER INSERT OR UPDATE ON grimoire.intake_agent_tasks FOR EACH ROW EXECUTE FUNCTION grimoire.intake_watch_artifact_event();

CREATE FUNCTION grimoire.intake_watch_dependency_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE dependency uuid; dependency_kind text; state grimoire.intake_watch_node_states%ROWTYPE;
BEGIN
 IF TG_TABLE_NAME='intake_agent_tasks' THEN
  IF NEW.status NOT IN ('dispatched','running','completed') THEN RETURN NEW; END IF;
  dependency:=NEW.id; dependency_kind:='agent_task';
 ELSIF TG_TABLE_NAME='intake_capability_plans' THEN
  dependency:=NEW.agent_task_id; dependency_kind:='agent_task';
 ELSE dependency:=NEW.plan_id; dependency_kind:='capability_proposal'; END IF;
 SELECT * INTO state FROM grimoire.intake_watch_node_states WHERE org_id=NEW.org_id AND node_kind=dependency_kind AND node_id=dependency;
 IF state.blocked THEN RAISE EXCEPTION USING ERRCODE='G2601',MESSAGE='dependent source permission revoked'; END IF;
 IF state.stale THEN RAISE EXCEPTION USING ERRCODE='G3802',MESSAGE='dependent work is stale'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER intake_watch_task_dependency_guard BEFORE UPDATE ON grimoire.intake_agent_tasks FOR EACH ROW EXECUTE FUNCTION grimoire.intake_watch_dependency_guard();
CREATE TRIGGER intake_watch_plan_dependency_guard BEFORE INSERT ON grimoire.intake_capability_plans FOR EACH ROW EXECUTE FUNCTION grimoire.intake_watch_dependency_guard();
CREATE TRIGGER intake_watch_comparison_dependency_guard BEFORE INSERT ON grimoire.intake_evidence_comparisons FOR EACH ROW EXECUTE FUNCTION grimoire.intake_watch_dependency_guard();

-- Existing cases get durable subscriptions and conservative dependencies without
-- inventing historic vendor checks, agent outcomes, or audit events.
INSERT INTO grimoire.intake_watches(org_id,scion_id,kind)
SELECT s.org_id,s.id,k FROM grimoire.intake_scions s CROSS JOIN unnest(ARRAY['scion_revisions','source_changes','agent_outcomes']) k;
DO $$ DECLARE a record; src record; BEGIN
 FOR a IN SELECT org_id,scion_id,'capability_proposal'::text kind,id,scion_revision,created_at,input FROM grimoire.intake_capability_plans
  UNION ALL SELECT org_id,scion_id,'comparison',id,scion_revision,created_at,input FROM grimoire.intake_evidence_comparisons
  UNION ALL SELECT org_id,scion_id,'agent_task',id,scion_revision,created_at,input FROM grimoire.intake_agent_tasks LOOP
  PERFORM grimoire.intake_watch_register_dependency(a.org_id,a.scion_id,a.kind,a.id,a.scion_revision);
  IF a.kind='comparison' THEN
   FOR src IN SELECT DISTINCT c.source_id,c.source_revision FROM grimoire.intake_source_claims c WHERE c.org_id=a.org_id AND c.id IN
    (SELECT claim.value::uuid FROM jsonb_array_elements(a.input->'alternatives') alternative CROSS JOIN LATERAL jsonb_array_elements(alternative->'criteria') criterion CROSS JOIN LATERAL jsonb_array_elements_text(criterion->'claim_ids') claim)
   LOOP PERFORM grimoire.intake_watch_register_dependency(a.org_id,a.scion_id,a.kind,a.id,a.scion_revision,src.source_id,src.source_revision); END LOOP;
  ELSIF a.input->>'task_kind'='prepare_capability_plan' OR EXISTS(SELECT 1 FROM jsonb_array_elements(a.input->'capabilities') capability WHERE capability->'connector_ids' ? 'scion_sources') THEN
   FOR src IN SELECT DISTINCT ON (r.source_id) r.source_id,r.number FROM grimoire.intake_source_revisions r
    JOIN grimoire.intake_sources s ON (s.org_id,s.id)=(r.org_id,r.source_id)
    WHERE s.org_id=a.org_id AND s.scion_id=a.scion_id AND r.created_at<=a.created_at
     AND NOT EXISTS(SELECT 1 FROM grimoire.intake_source_revocations v WHERE v.org_id=s.org_id AND v.source_id=s.id AND v.created_at<=a.created_at)
    ORDER BY r.source_id,r.number DESC
   LOOP PERFORM grimoire.intake_watch_register_dependency(a.org_id,a.scion_id,a.kind,a.id,a.scion_revision,src.source_id,src.number); END LOOP;
  END IF;
 END LOOP;
END $$;

-- The service can only advance a bounded health check for registered internal
-- watches. This exposes no tenant data and cannot inject events, approve work,
-- mutate agent tasks, or choose an organization. It needs no browser session.
CREATE FUNCTION app.intake_watchtower_check() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
BEGIN
 IF (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='grimoire' AND t.tgname IN ('intake_watch_scion_event','intake_watch_source_event','intake_watch_revocation_event','intake_watch_task_event','intake_watch_plan_event','intake_watch_comparison_event') AND t.tgenabled='O')<>6
 THEN RAISE EXCEPTION 'Watchtower event capture is unavailable'; END IF;
 UPDATE grimoire.intake_watches SET last_successful_check=clock_timestamp() WHERE id IN
 (SELECT id FROM grimoire.intake_watches ORDER BY last_successful_check NULLS FIRST,id LIMIT 500 FOR UPDATE SKIP LOCKED);
END
$$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['intake_watches','intake_watch_events','intake_watch_reviews','intake_watch_dependencies','intake_watch_node_states'] LOOP
  EXECUTE format('ALTER TABLE grimoire.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY %I_org_read ON grimoire.%I FOR SELECT TO grimoire_intake_app USING(org_id=app.current_org_id() AND app.intake_can_access())',t,t);
  EXECUTE format('REVOKE ALL ON grimoire.%I FROM PUBLIC,grimoire_intake_app',t);
  EXECUTE format('GRANT SELECT ON grimoire.%I TO grimoire_intake_app',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['intake_watch_events','intake_watch_reviews','intake_watch_dependencies'] LOOP
  EXECUTE format('CREATE TRIGGER %I_immutable BEFORE UPDATE OR DELETE ON grimoire.%I FOR EACH ROW EXECUTE FUNCTION grimoire.intake_deny_mutation()',t,t);
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION grimoire.intake_watch_ensure(uuid,uuid),
 grimoire.intake_watch_emit(uuid,uuid,text,text,uuid,integer,text,text),grimoire.intake_watch_scion_event(),
 grimoire.intake_watch_source_event(),grimoire.intake_watch_register_dependency(uuid,uuid,text,uuid,integer,uuid,integer),
 grimoire.intake_watch_artifact_event(),grimoire.intake_watch_dependency_guard(),app.intake_watchtower_check() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.intake_watchtower_check() TO grimoire_intake_app;
COMMIT;
