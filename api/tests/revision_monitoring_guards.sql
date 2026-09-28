-- Supplemental rollback-only checks after the live HTTP harness.
-- Execute as grimoire_migrator only in the disposable grimoire_test database.
BEGIN;
SET LOCAL search_path=grimoire,public;

DO $$
DECLARE sample grimoire.intake_proposal_stale_transitions%ROWTYPE;
 transitions_before bigint;tasks_before bigint;transitions_after bigint;tasks_after bigint;
BEGIN
 IF current_database()<>'grimoire_test' THEN RAISE EXCEPTION 'revision monitoring guards require disposable grimoire_test'; END IF;
 IF EXISTS(
   SELECT 1 FROM grimoire.intake_proposal_stale_transitions t
   LEFT JOIN grimoire.intake_proposal_review_tasks w
     ON (w.org_id,w.transition_id)=(t.org_id,t.id)
   WHERE w.id IS NULL
 ) OR EXISTS(
   SELECT 1 FROM grimoire.intake_proposal_review_tasks w
   LEFT JOIN grimoire.intake_proposal_stale_transitions t
     ON (t.org_id,t.id)=(w.org_id,w.transition_id)
   WHERE t.id IS NULL
 ) THEN RAISE EXCEPTION 'transition/review-task atomicity broken'; END IF;
 IF EXISTS(
   SELECT 1 FROM grimoire.intake_proposal_stale_transitions
   GROUP BY org_id,proposal_kind,proposal_id,superseded_by_revision HAVING count(*)<>1
 ) OR EXISTS(
   SELECT 1 FROM grimoire.intake_proposal_review_tasks
   GROUP BY org_id,transition_id HAVING count(*)<>1
 ) THEN RAISE EXCEPTION 'revision reaction uniqueness broken'; END IF;
 IF EXISTS(
   SELECT 1 FROM grimoire.intake_proposal_review_tasks WHERE status<>'required'
 ) OR NOT EXISTS(
   SELECT 1 FROM pg_constraint c
   JOIN pg_class r ON r.oid=c.conrelid
   JOIN pg_namespace n ON n.oid=r.relnamespace
   WHERE n.nspname='grimoire' AND r.relname='intake_proposal_review_tasks'
     AND c.contype='c' AND pg_get_constraintdef(c.oid) LIKE '%status%required%'
 ) THEN RAISE EXCEPTION 'review task status is not required-only'; END IF;
 SELECT * INTO STRICT sample FROM grimoire.intake_proposal_stale_transitions
 ORDER BY recorded_at DESC,id LIMIT 1;
 SELECT count(*) INTO transitions_before FROM grimoire.intake_proposal_stale_transitions;
 SELECT count(*) INTO tasks_before FROM grimoire.intake_proposal_review_tasks;
 PERFORM grimoire.intake_record_revision_reactions(sample.org_id,sample.scion_id,sample.superseded_by_revision);
 PERFORM grimoire.intake_record_revision_reactions(sample.org_id,sample.scion_id,sample.superseded_by_revision);
 SELECT count(*) INTO transitions_after FROM grimoire.intake_proposal_stale_transitions;
 SELECT count(*) INTO tasks_after FROM grimoire.intake_proposal_review_tasks;
 IF (transitions_before,tasks_before) IS DISTINCT FROM (transitions_after,tasks_after) THEN
   RAISE EXCEPTION 'same revision event replay created duplicate work';
 END IF;
 BEGIN
   UPDATE grimoire.intake_proposal_stale_transitions SET reason=reason WHERE id=sample.id;
   RAISE EXCEPTION 'stale transition mutation unexpectedly succeeded';
 EXCEPTION WHEN SQLSTATE 'G2401' THEN NULL; END;
 BEGIN
   DELETE FROM grimoire.intake_proposal_review_tasks WHERE transition_id=sample.id;
   RAISE EXCEPTION 'required review work deletion unexpectedly succeeded';
 EXCEPTION WHEN SQLSTATE 'G2401' THEN NULL; END;
 IF has_table_privilege('grimoire_intake_app','grimoire.intake_proposal_stale_transitions','INSERT,UPDATE,DELETE')
    OR has_table_privilege('grimoire_intake_app','grimoire.intake_proposal_review_tasks','INSERT,UPDATE,DELETE')
    OR has_function_privilege('grimoire_intake_app','grimoire.intake_record_revision_reactions(uuid,uuid,integer)','EXECUTE') THEN
   RAISE EXCEPTION 'runtime can forge or mutate revision monitoring state';
 END IF;
 RAISE NOTICE 'PASS: atomic transition/task pairing, required-only status, replay idempotency, immutable history, and least-privilege writes';
END $$;

SET LOCAL ROLE grimoire_intake_app;
SELECT set_config('app.current_org_id','10000000-0000-4000-8000-000000000001',true);
SELECT set_config('app.current_principal_id','10000000-0000-4000-8000-000000000011',true);
DO $$
BEGIN
 IF EXISTS(SELECT 1 FROM grimoire.intake_proposal_stale_transitions WHERE org_id<>'10000000-0000-4000-8000-000000000001'::uuid)
    OR EXISTS(SELECT 1 FROM grimoire.intake_proposal_review_tasks WHERE org_id<>'10000000-0000-4000-8000-000000000001'::uuid) THEN
   RAISE EXCEPTION 'cross-organization revision monitoring state visible';
 END IF;
 RAISE NOTICE 'PASS: organization RLS hides foreign transitions and review work';
END $$;
RESET ROLE;
ROLLBACK;
