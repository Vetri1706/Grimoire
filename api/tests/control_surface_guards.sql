BEGIN;
SET LOCAL search_path=pg_catalog,grimoire,pg_temp;
DO $$
DECLARE recorded grimoire.intake_watch_events%ROWTYPE; before_events bigint; before_reviews bigint; before_tasks bigint; before_states jsonb; table_name text;
BEGIN
 IF current_database()<>'grimoire_test' THEN RAISE EXCEPTION 'Watchtower guards require disposable grimoire_test'; END IF;
 SELECT * INTO STRICT recorded FROM grimoire.intake_watch_events WHERE kind='source_permission_revoked' ORDER BY recorded_at DESC LIMIT 1;
 PERFORM 1 FROM grimoire.intake_scions WHERE id=recorded.scion_id FOR UPDATE;
 SELECT count(*) INTO before_events FROM grimoire.intake_watch_events WHERE scion_id=recorded.scion_id;
 SELECT count(*) INTO before_reviews FROM grimoire.intake_watch_reviews WHERE scion_id=recorded.scion_id;
 SELECT count(*) INTO before_tasks FROM grimoire.intake_agent_tasks WHERE scion_id=recorded.scion_id;
 SELECT jsonb_agg(to_jsonb(state) ORDER BY node_kind,node_id) INTO before_states FROM grimoire.intake_watch_node_states state WHERE scion_id=recorded.scion_id;
 PERFORM grimoire.intake_watch_emit(recorded.org_id,recorded.scion_id,'source_changes',recorded.kind,recorded.subject_id,recorded.subject_revision,recorded.event_key,recorded.summary);
 PERFORM grimoire.intake_watch_emit(recorded.org_id,recorded.scion_id,'source_changes',recorded.kind,recorded.subject_id,recorded.subject_revision,recorded.event_key,recorded.summary);
 IF before_events<>(SELECT count(*) FROM grimoire.intake_watch_events WHERE scion_id=recorded.scion_id) OR
    before_reviews<>(SELECT count(*) FROM grimoire.intake_watch_reviews WHERE scion_id=recorded.scion_id) OR
    before_tasks<>(SELECT count(*) FROM grimoire.intake_agent_tasks WHERE scion_id=recorded.scion_id) OR
    before_states IS DISTINCT FROM (SELECT jsonb_agg(to_jsonb(state) ORDER BY node_kind,node_id) FROM grimoire.intake_watch_node_states state WHERE scion_id=recorded.scion_id)
 THEN RAISE EXCEPTION 'duplicate event changed audit, tasks or derivative state'; END IF;
 FOREACH table_name IN ARRAY ARRAY['intake_watches','intake_watch_events','intake_watch_reviews','intake_watch_dependencies','intake_watch_node_states'] LOOP
  IF has_table_privilege('grimoire_intake_app','grimoire.'||table_name,'INSERT,UPDATE,DELETE,TRUNCATE') THEN RAISE EXCEPTION 'runtime can mutate watch data: %',table_name; END IF;
 END LOOP;
 IF has_function_privilege('grimoire_intake_app','grimoire.intake_watch_emit(uuid,uuid,text,text,uuid,integer,text,text)','EXECUTE') THEN RAISE EXCEPTION 'runtime can inject watch events'; END IF;
 RAISE NOTICE 'PASS duplicate direct event deliveries preserve audit/task/state identities; runtime cannot mutate watch records or inject events';
END $$;
SET LOCAL ROLE grimoire_intake_app;
SELECT set_config('app.current_org_id','20000000-0000-4000-8000-000000000001',true);
SELECT set_config('app.current_principal_id','20000000-0000-4000-8000-000000000011',true);
DO $$ DECLARE table_name text; leaked bigint; BEGIN
 FOREACH table_name IN ARRAY ARRAY['intake_watches','intake_watch_events','intake_watch_reviews','intake_watch_dependencies','intake_watch_node_states'] LOOP
  EXECUTE format('SELECT count(*) FROM grimoire.%I WHERE org_id<>app.current_org_id()',table_name) INTO leaked;
  IF leaked<>0 THEN RAISE EXCEPTION 'foreign organization watch rows exposed: %',table_name; END IF;
 END LOOP;
 RAISE NOTICE 'PASS direct runtime RLS hides foreign watch rows, alerts and dependencies';
END $$;
ROLLBACK;
