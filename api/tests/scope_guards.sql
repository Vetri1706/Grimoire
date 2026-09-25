-- Supplemental rollback-only checks AFTER the live Layer 3 HTTP harness.
-- Execute as grimoire_migrator only in the disposable grimoire_test database.
BEGIN;
SET LOCAL search_path=grimoire,public;
SELECT set_config('app.current_org_id','10000000-0000-4000-8000-000000000001',true);
SELECT set_config('app.current_principal_id','10000000-0000-4000-8000-000000000012',true);
SELECT set_config('app.request_id',gen_random_uuid()::text,true);
SELECT set_config('app.effective_role','synthetic_engineering_reviewer',true);
SELECT set_config('app.endpoint_scope','local:scope-guards',true);
SELECT set_config('app.action_reason','Rollback-only synthetic scope invariant checks',true);
DO $$
DECLARE c intake_scope_confirmations%ROWTYPE; chain jsonb; alternative_cfg uuid:=gen_random_uuid();
 alternative_rev uuid:=gen_random_uuid(); product uuid; candidate intake_scope_proposals%ROWTYPE;
 task_uuid uuid:=gen_random_uuid(); task_lease uuid:=gen_random_uuid(); submitted_proposal uuid:=gen_random_uuid();
BEGIN
 IF current_database()<>'grimoire_test' THEN RAISE EXCEPTION 'scope guards require disposable grimoire_test'; END IF;
 SELECT * INTO STRICT c FROM intake_scope_confirmations WHERE org_id=app.current_org_id() ORDER BY confirmed_at DESC LIMIT 1;
 chain:=app.intake_scope_chain(c.proposal_id);
 IF chain IS NULL OR (chain->>'consistent')::boolean IS NOT TRUE OR (chain->>'criteria_hash_matches')::boolean IS NOT TRUE
    OR (chain->>'configuration_revision_id')::uuid<>c.configuration_revision_id
    OR (chain->>'component_revision_id')::uuid<>c.component_revision_id
    OR (chain->>'occurrence_revision_id')::uuid<>c.occurrence_revision_id
    OR (chain->>'requirement_revision_id')::uuid<>c.requirement_revision_id THEN
   RAISE EXCEPTION 'confirmed binding does not resolve to exact governed GG-40 identity chain';
 END IF;
 BEGIN
   UPDATE intake_scope_proposals SET input=input WHERE id=c.proposal_id;
   RAISE EXCEPTION 'proposal mutation unexpectedly succeeded';
 EXCEPTION WHEN SQLSTATE 'G2401' THEN NULL; END;
 BEGIN
   DELETE FROM intake_scope_confirmations WHERE proposal_id=c.proposal_id;
   RAISE EXCEPTION 'confirmation deletion unexpectedly succeeded';
 EXCEPTION WHEN SQLSTATE 'G2401' THEN NULL; END;
 BEGIN
   UPDATE component_revisions SET attributes=attributes WHERE id=c.component_revision_id;
   RAISE EXCEPTION 'governed component revision mutation unexpectedly succeeded';
 EXCEPTION WHEN SQLSTATE 'G2001' THEN NULL; END;
 SELECT h.product_id INTO STRICT product FROM product_configuration_revisions r JOIN product_configurations h ON (h.org_id,h.id)=(r.org_id,r.configuration_id)
 WHERE (r.org_id,r.id)=(c.org_id,c.configuration_revision_id);
 INSERT INTO product_configurations(id,org_id,product_id,configuration_code)
 VALUES(alternative_cfg,c.org_id,product,'SYNTHETIC-ROLLBACK-'||alternative_cfg::text);
 INSERT INTO product_configuration_revisions(id,org_id,configuration_id,revision_no,effective_during,specification,created_by)
 VALUES(alternative_rev,c.org_id,alternative_cfg,1,tstzrange(clock_timestamp(),NULL,'[)'),'{"synthetic":true,"test":"rollback-only wrong-chain guard"}',app.current_principal_id());
 BEGIN
   INSERT INTO sourcing_case_revisions(org_id,sourcing_case_id,revision_no,configuration_revision_id,occurrence_revision_id,component_revision_id,requirement_revision_id,created_by)
   VALUES(c.org_id,c.sourcing_case_id,2,alternative_rev,c.occurrence_revision_id,c.component_revision_id,c.requirement_revision_id,app.current_principal_id());
   RAISE EXCEPTION 'mismatched governed configuration chain unexpectedly succeeded';
 EXCEPTION WHEN SQLSTATE 'G1003' THEN NULL; END;
 IF has_table_privilege('grimoire_intake_app','grimoire.intake_scope_confirmations','INSERT,UPDATE,DELETE')
    OR has_table_privilege('grimoire_intake_app','grimoire.intake_scope_reviewers','SELECT,INSERT,UPDATE,DELETE')
    OR has_table_privilege('grimoire_intake_app','grimoire.intake_scope_agents','SELECT,INSERT,UPDATE,DELETE')
    OR has_table_privilege('grimoire_intake_app','grimoire.sourcing_case_revisions','INSERT,UPDATE,DELETE') THEN
   RAISE EXCEPTION 'runtime can bypass bounded scope confirmation or enrollment';
 END IF;
 -- A dual-role reviewer can prepare a task, but agent attribution must never
 -- allow that same requester to confirm its output. The proposal below has a
 -- DIFFERENT creator, so the denial specifically proves queued-origin handling.
 SELECT p.* INTO STRICT candidate FROM intake_scope_proposals p JOIN intake_scions s ON (s.org_id,s.id,s.current_revision)=(p.org_id,p.scion_id,p.scion_revision)
 WHERE p.org_id=app.current_org_id() AND p.created_by<>app.current_principal_id()
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.input->'source_claims') r
     WHERE NOT EXISTS(SELECT 1 FROM intake_sources src WHERE (src.org_id,src.id,src.scion_id,src.scion_revision,src.current_revision)=(p.org_id,(r->>'source_id')::uuid,p.scion_id,p.scion_revision,(r->>'source_revision')::integer))
       OR EXISTS(SELECT 1 FROM intake_source_revocations v WHERE (v.org_id,v.source_id)=(p.org_id,(r->>'source_id')::uuid)))
 ORDER BY p.created_at DESC LIMIT 1;
 INSERT INTO principal_roles(org_id,principal_id,role) VALUES(app.current_org_id(),app.current_principal_id(),'procurement_preparer') ON CONFLICT DO NOTHING;
 IF NOT app.intake_scope_can_confirm() OR NOT app.intake_scope_can_propose() THEN RAISE EXCEPTION 'dual-role reviewer test setup failed'; END IF;
 INSERT INTO intake_agent_tasks(id,org_id,scion_id,scion_revision,task_kind,input,created_by,request_key,request_sha256)
 VALUES(task_uuid,app.current_org_id(),candidate.scion_id,candidate.scion_revision,'prepare_physical_scope',jsonb_build_object('candidate_proposal',candidate.input),app.current_principal_id(),task_uuid::text,repeat('a',64));
 UPDATE intake_agent_tasks SET status='dispatched',dispatched_at=clock_timestamp() WHERE id=task_uuid;
 PERFORM set_config('app.current_principal_id','10000000-0000-4000-8000-000000000018',true);
 UPDATE intake_agent_tasks SET status='running',attempt=1,claimed_by=app.current_principal_id(),claimed_at=clock_timestamp(),lease_token=task_lease,lease_until=clock_timestamp()+interval '270 seconds' WHERE id=task_uuid;
 PERFORM set_config('app.agent_task_id',task_uuid::text,true);
 PERFORM set_config('app.agent_task_lease',task_lease::text,true);
 INSERT INTO intake_scope_proposals(id,org_id,scion_id,scion_revision,input,created_by)
 VALUES(submitted_proposal,app.current_org_id(),candidate.scion_id,candidate.scion_revision,candidate.input,app.current_principal_id());
 IF NOT EXISTS(SELECT 1 FROM intake_scope_proposals WHERE id=submitted_proposal AND agent_task_id=task_uuid) THEN RAISE EXCEPTION 'agent proposal lost exact task provenance'; END IF;
 PERFORM set_config('app.current_principal_id','10000000-0000-4000-8000-000000000012',true);
 IF NOT app.intake_scope_has_preparer_conflict(candidate.scion_id,submitted_proposal) THEN RAISE EXCEPTION 'queued-origin preparer conflict missing'; END IF;
 BEGIN
   INSERT INTO intake_scope_confirmations(proposal_id,org_id,scion_id,scion_revision,configuration_revision_id,component_revision_id,occurrence_revision_id,requirement_revision_id,sourcing_case_id,sourcing_case_revision_id,confirmed_by,review_note)
   VALUES(submitted_proposal,c.org_id,candidate.scion_id,candidate.scion_revision,c.configuration_revision_id,c.component_revision_id,c.occurrence_revision_id,c.requirement_revision_id,c.sourcing_case_id,c.sourcing_case_revision_id,app.current_principal_id(),'Rollback-only self-review guard');
   RAISE EXCEPTION 'dual-role queued-origin confirmation unexpectedly succeeded';
 EXCEPTION WHEN SQLSTATE 'G2804' THEN NULL; END;
 PERFORM set_config('app.current_principal_id','10000000-0000-4000-8000-000000000018',true);
 IF app.intake_scope_can_confirm() OR NOT app.intake_scope_can_propose() OR NOT app.intake_scope_is_agent() THEN
   RAISE EXCEPTION 'agent proposal-only capability boundary failed';
 END IF;
 BEGIN
   PERFORM app.intake_scope_confirm(c.scion_id,c.proposal_id,c.scion_revision,'Agent must not confirm');
   RAISE EXCEPTION 'agent direct confirmation unexpectedly succeeded';
 EXCEPTION WHEN SQLSTATE 'G2804' THEN NULL; END;
 PERFORM set_config('app.current_org_id','20000000-0000-4000-8000-000000000001',true);
 PERFORM set_config('app.current_principal_id','20000000-0000-4000-8000-000000000011',true);
 IF app.intake_scope_chain(c.proposal_id) IS NOT NULL THEN RAISE EXCEPTION 'foreign governed binding metadata leaked'; END IF;
 RAISE NOTICE 'PASS: existing GG-40 exact chain, criteria hash, immutable proposal/confirmation/component, mismatched governed chain denial, bounded runtime privileges, dual-role queued-origin self-review denial, agent confirmation denial, cross-org chain denial';
END $$;
ROLLBACK;
