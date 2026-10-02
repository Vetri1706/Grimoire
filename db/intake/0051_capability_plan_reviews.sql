-- A Handler's immutable review receipt is neither an approval nor resolution
-- of Watchtower alerts. Existing proposal/task stores remain authoritative.
BEGIN;
SET search_path=pg_catalog,grimoire,pg_temp;

CREATE TABLE grimoire.intake_capability_plan_reviews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL,
 scion_id uuid NOT NULL, scion_revision integer NOT NULL, plan_id uuid NOT NULL,
 reviewer_id uuid NOT NULL, note text NOT NULL CHECK(length(btrim(note)) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 request_key text NOT NULL CHECK(length(request_key) BETWEEN 1 AND 128),
 request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
 UNIQUE(org_id,id), UNIQUE(org_id,reviewer_id,request_key),
 FOREIGN KEY(org_id,scion_id,scion_revision) REFERENCES grimoire.intake_revisions(org_id,scion_id,number),
 FOREIGN KEY(org_id,plan_id) REFERENCES grimoire.intake_capability_plans(org_id,id),
 FOREIGN KEY(org_id,reviewer_id) REFERENCES grimoire.principals(org_id,id)
);
CREATE INDEX intake_capability_reviews_plan ON grimoire.intake_capability_plan_reviews(org_id,plan_id,created_at,id);
COMMENT ON TABLE grimoire.intake_capability_plan_reviews IS
 'Immutable human review notes on completed current capability proposals. Not engineering, sourcing, commercial or execution approval; does not close Watchtower alerts.';

-- Also protects direct runtime SELECT: historical notes disappear from visible
-- projection when any exact input becomes stale or permission is withdrawn.
CREATE FUNCTION app.intake_capability_review_visible(wanted_plan uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
 SELECT app.intake_can_access() AND EXISTS (
  SELECT 1 FROM grimoire.intake_capability_plans p
  JOIN grimoire.intake_scions s ON (s.org_id,s.id,s.current_revision)=(p.org_id,p.scion_id,p.scion_revision)
  JOIN grimoire.intake_agent_tasks t ON (t.org_id,t.id,t.proposal_id)=(p.org_id,p.agent_task_id,p.id)
  WHERE p.org_id=app.current_org_id() AND p.id=wanted_plan AND t.status='completed'
   AND NOT EXISTS(SELECT 1 FROM grimoire.intake_watch_node_states n WHERE n.org_id=p.org_id
    AND ((n.node_kind='capability_proposal' AND n.node_id=p.id) OR (n.node_kind='agent_task' AND n.node_id=t.id)) AND (n.stale OR n.blocked))
   AND NOT EXISTS(SELECT 1 FROM grimoire.intake_watch_dependencies d
    LEFT JOIN grimoire.intake_sources source ON (source.org_id,source.id)=(d.org_id,d.source_id)
    LEFT JOIN grimoire.intake_source_revisions r ON (r.org_id,r.source_id,r.number)=(d.org_id,d.source_id,d.source_revision)
    WHERE d.org_id=p.org_id AND d.source_id IS NOT NULL
     AND ((d.node_kind='capability_proposal' AND d.node_id=p.id) OR (d.node_kind='agent_task' AND d.node_id=t.id))
     AND (source.id IS NULL OR source.current_revision<>d.source_revision OR r.rights_status IS DISTINCT FROM 'granted'
      OR r.permitted_use IS DISTINCT FROM 'scion_review' OR COALESCE(length(btrim(r.permission_basis)),0)=0
      OR NOT app.intake_source_permitted(d.source_id)))
 )
$$;

CREATE FUNCTION app.intake_record_capability_review(wanted_scion uuid,wanted_plan uuid,expected_revision integer,review_note text,retry_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE organization uuid:=app.current_org_id(); reviewer uuid:=app.current_principal_id(); current_number integer;
 plan grimoire.intake_capability_plans%ROWTYPE; saved grimoire.intake_capability_plan_reviews%ROWTYPE;
 dependency record; state record; wanted_hash text; replayed boolean:=false;
BEGIN
 IF NOT app.intake_can_prepare_workspace() OR app.intake_scope_is_agent() THEN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='human workspace preparation authority required'; END IF;
 current_number:=app.intake_scope_lock_scion(wanted_scion);
 IF current_number IS NULL THEN RAISE EXCEPTION USING ERRCODE='G3804',MESSAGE='Scion unavailable'; END IF;
 SELECT * INTO plan FROM grimoire.intake_capability_plans WHERE (org_id,id,scion_id)=(organization,wanted_plan,wanted_scion);
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='G3804',MESSAGE='proposal unavailable'; END IF;
 IF current_number IS DISTINCT FROM expected_revision OR plan.scion_revision<>current_number THEN
  RAISE EXCEPTION USING ERRCODE='G2402',MESSAGE='review requires current proposal and Scion revision'; END IF;
 IF NOT app.intake_can_control_preparation(wanted_scion,current_number,'prepare_capability_plan') THEN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='capability preparation authority required'; END IF;
 IF review_note IS NULL OR length(btrim(review_note)) NOT BETWEEN 1 AND 2000 OR length(review_note)>2000
  OR retry_key IS NULL OR retry_key !~ '^[!-~]{1,128}$' THEN
  RAISE EXCEPTION USING ERRCODE='G3801',MESSAGE='bounded review note and retry key required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM grimoire.intake_agent_tasks WHERE (org_id,id,proposal_id,status)=(organization,plan.agent_task_id,plan.id,'completed')) THEN
  RAISE EXCEPTION USING ERRCODE='G3801',MESSAGE='completed proposal task required before review'; END IF;
 -- Source mutation/revocation takes FOR UPDATE; serialize this read against it.
 FOR dependency IN SELECT DISTINCT source_id,source_revision FROM grimoire.intake_watch_dependencies
  WHERE org_id=organization AND source_id IS NOT NULL
   AND ((node_kind='capability_proposal' AND node_id=plan.id) OR (node_kind='agent_task' AND node_id=plan.agent_task_id))
  ORDER BY source_id,source_revision LOOP
  IF app.intake_source_read_lock(wanted_scion,dependency.source_id) IS DISTINCT FROM dependency.source_revision THEN
   RAISE EXCEPTION USING ERRCODE='G3802',MESSAGE='review source revision changed'; END IF;
  IF NOT app.intake_source_permitted(dependency.source_id) OR NOT EXISTS(
   SELECT 1 FROM grimoire.intake_source_revisions WHERE (org_id,source_id,number)=(organization,dependency.source_id,dependency.source_revision)
    AND rights_status='granted' AND permitted_use='scion_review' AND length(btrim(permission_basis))>0) THEN
   RAISE EXCEPTION USING ERRCODE='G2601',MESSAGE='review source permission unavailable'; END IF;
 END LOOP;
 FOR state IN SELECT stale,blocked FROM grimoire.intake_watch_node_states WHERE org_id=organization
  AND ((node_kind='capability_proposal' AND node_id=plan.id) OR (node_kind='agent_task' AND node_id=plan.agent_task_id)) LOOP
  IF state.blocked THEN RAISE EXCEPTION USING ERRCODE='G2601',MESSAGE='review dependency permission revoked'; END IF;
  IF state.stale THEN RAISE EXCEPTION USING ERRCODE='G3802',MESSAGE='review dependency stale'; END IF;
 END LOOP;
 wanted_hash:=encode(public.digest(jsonb_build_array(wanted_scion,wanted_plan,expected_revision,review_note)::text,'sha256'),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended('capability-review:'||organization||':'||reviewer||':'||retry_key,0));
 SELECT * INTO saved FROM grimoire.intake_capability_plan_reviews WHERE (org_id,reviewer_id,request_key)=(organization,reviewer,retry_key);
 IF FOUND THEN
  IF saved.request_sha256<>wanted_hash THEN RAISE EXCEPTION USING ERRCODE='G3303',MESSAGE='review retry differs'; END IF;
  replayed:=true;
 ELSE
  INSERT INTO grimoire.intake_capability_plan_reviews(org_id,scion_id,scion_revision,plan_id,reviewer_id,note,request_key,request_sha256)
  VALUES(organization,wanted_scion,current_number,wanted_plan,reviewer,review_note,retry_key,wanted_hash) RETURNING * INTO saved;
  INSERT INTO grimoire.intake_watch_events(org_id,scion_id,event_key,kind,subject_id,subject_revision,summary)
  VALUES(organization,wanted_scion,'capability-review:'||saved.id,'capability_plan_reviewed',wanted_plan,current_number,
   'Handler recorded a capability proposal review. No approval was granted; required Watchtower reviews remain open.');
 END IF;
 RETURN jsonb_build_object('review',jsonb_build_object('id',saved.id,'plan_id',saved.plan_id,'scion_revision',saved.scion_revision,
  'reviewer_id',saved.reviewer_id,'note',saved.note,'created_at',saved.created_at),'replayed',replayed);
END $$;

ALTER TABLE grimoire.intake_capability_plan_reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY intake_capability_reviews_org_read ON grimoire.intake_capability_plan_reviews FOR SELECT TO grimoire_intake_app
 USING(org_id=app.current_org_id() AND app.intake_capability_review_visible(plan_id));
CREATE TRIGGER intake_capability_reviews_immutable BEFORE UPDATE OR DELETE ON grimoire.intake_capability_plan_reviews
 FOR EACH ROW EXECUTE FUNCTION grimoire.intake_deny_mutation();
REVOKE ALL ON grimoire.intake_capability_plan_reviews FROM PUBLIC,grimoire_intake_app;
GRANT SELECT ON grimoire.intake_capability_plan_reviews TO grimoire_intake_app;
REVOKE ALL ON FUNCTION app.intake_capability_review_visible(uuid),app.intake_record_capability_review(uuid,uuid,integer,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.intake_capability_review_visible(uuid),app.intake_record_capability_review(uuid,uuid,integer,text,text) TO grimoire_intake_app;
COMMIT;
