-- Apply after revision_monitoring_upgrade_seed.sql and migration 0034 in the
-- same disposable database. The transaction rolls back the post-install
-- revision; migration-created backfill records remain committed evidence.
BEGIN;
SET LOCAL search_path=grimoire,public;
SET LOCAL app.current_org_id='61000000-0000-4000-8000-000000000001';
SET LOCAL app.current_principal_id='61000000-0000-4000-8000-000000000011';
SET LOCAL app.request_id='61000000-0000-4000-8000-000000000022';

DO $$
DECLARE transitions_before bigint; tasks_before bigint;
BEGIN
  SELECT count(*) INTO transitions_before
  FROM grimoire.intake_proposal_stale_transitions
  WHERE org_id='61000000-0000-4000-8000-000000000001';
  SELECT count(*) INTO tasks_before
  FROM grimoire.intake_proposal_review_tasks
  WHERE org_id='61000000-0000-4000-8000-000000000001';
  IF (transitions_before,tasks_before) IS DISTINCT FROM (4::bigint,4::bigint) THEN
    RAISE EXCEPTION '0034 backfill expected 4 transitions/tasks, got %/%',
      transitions_before,tasks_before;
  END IF;
  IF EXISTS(
    SELECT proposal_kind,superseded_by_revision,count(*)
    FROM grimoire.intake_proposal_stale_transitions
    WHERE org_id='61000000-0000-4000-8000-000000000001'
    GROUP BY proposal_kind,superseded_by_revision
    HAVING count(*)<>1
  ) OR (
    SELECT count(DISTINCT (proposal_kind,superseded_by_revision))
    FROM grimoire.intake_proposal_stale_transitions
    WHERE org_id='61000000-0000-4000-8000-000000000001'
  )<>4 THEN
    RAISE EXCEPTION '0034 did not backfill both proposal kinds for revisions 2 and 3 exactly once';
  END IF;
  IF EXISTS(
    SELECT 1 FROM grimoire.intake_proposal_stale_transitions t
    FULL JOIN grimoire.intake_proposal_review_tasks w
      ON (w.org_id,w.transition_id)=(t.org_id,t.id)
    WHERE COALESCE(t.org_id,w.org_id)='61000000-0000-4000-8000-000000000001'
      AND (t.id IS NULL OR w.id IS NULL)
  ) THEN
    RAISE EXCEPTION '0034 upgrade backfill created an orphan transition or task';
  END IF;

  PERFORM grimoire.intake_record_revision_reactions(
    '61000000-0000-4000-8000-000000000001',
    '61000000-0000-4000-8000-000000000101',2
  );
  PERFORM grimoire.intake_record_revision_reactions(
    '61000000-0000-4000-8000-000000000001',
    '61000000-0000-4000-8000-000000000101',3
  );
  IF (SELECT count(*) FROM grimoire.intake_proposal_stale_transitions
      WHERE org_id='61000000-0000-4000-8000-000000000001')<>transitions_before
     OR (SELECT count(*) FROM grimoire.intake_proposal_review_tasks
         WHERE org_id='61000000-0000-4000-8000-000000000001')<>tasks_before THEN
    RAISE EXCEPTION 'explicit replay duplicated an upgrade-backfilled reaction';
  END IF;
END $$;

INSERT INTO grimoire.intake_revisions(
  org_id,scion_id,number,name,product_category,change_summary,created_by
) VALUES(
  '61000000-0000-4000-8000-000000000001',
  '61000000-0000-4000-8000-000000000101',
  4,'Upgrade fixture','physical','Post-install revision',
  '61000000-0000-4000-8000-000000000011'
);

DO $$
BEGIN
  IF (SELECT count(*) FROM grimoire.intake_proposal_stale_transitions
      WHERE org_id='61000000-0000-4000-8000-000000000001')<>6
     OR (SELECT count(*) FROM grimoire.intake_proposal_review_tasks
         WHERE org_id='61000000-0000-4000-8000-000000000001')<>6 THEN
    RAISE EXCEPTION 'post-install revision did not create one new pair per proposal';
  END IF;
  RAISE NOTICE 'PASS: 0034 backfilled scope and comparison reactions, paired tasks atomically, replayed idempotently, and handled a later revision exactly once';
END $$;
ROLLBACK;
