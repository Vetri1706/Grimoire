-- Persist the first bounded monitoring reaction: a Scion revision supersedes
-- proposal inputs, and exactly one required-review work item is recorded for
-- each proposal/new-revision pair. PostgreSQL remains the canonical state.
BEGIN;
SET search_path = grimoire, public;

CREATE TABLE grimoire.intake_proposal_stale_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  scion_id uuid NOT NULL,
  proposal_kind text NOT NULL CHECK (proposal_kind IN ('physical_scope','offer_comparison')),
  proposal_id uuid NOT NULL,
  proposal_scion_revision integer NOT NULL CHECK (proposal_scion_revision>0),
  superseded_by_revision integer NOT NULL CHECK (superseded_by_revision>proposal_scion_revision),
  reason text NOT NULL CHECK (reason='scion_revision_changed'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (org_id,id),
  UNIQUE (org_id,proposal_kind,proposal_id,superseded_by_revision),
  UNIQUE (org_id,id,scion_id,proposal_kind,proposal_id,superseded_by_revision),
  FOREIGN KEY (org_id,scion_id,proposal_scion_revision)
    REFERENCES grimoire.intake_revisions(org_id,scion_id,number),
  FOREIGN KEY (org_id,scion_id,superseded_by_revision)
    REFERENCES grimoire.intake_revisions(org_id,scion_id,number)
);

CREATE TABLE grimoire.intake_proposal_review_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  scion_id uuid NOT NULL,
  transition_id uuid NOT NULL,
  proposal_kind text NOT NULL CHECK (proposal_kind IN ('physical_scope','offer_comparison')),
  proposal_id uuid NOT NULL,
  required_for_revision integer NOT NULL CHECK (required_for_revision>1),
  task_kind text NOT NULL CHECK (task_kind='revision_change_review'),
  status text NOT NULL CHECK (status='required'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (org_id,id),
  UNIQUE (org_id,transition_id),
  FOREIGN KEY (org_id,transition_id,scion_id,proposal_kind,proposal_id,required_for_revision)
    REFERENCES grimoire.intake_proposal_stale_transitions
      (org_id,id,scion_id,proposal_kind,proposal_id,superseded_by_revision),
  FOREIGN KEY (org_id,scion_id,required_for_revision)
    REFERENCES grimoire.intake_revisions(org_id,scion_id,number)
);

CREATE INDEX intake_proposal_stale_scion_revision
  ON grimoire.intake_proposal_stale_transitions(org_id,scion_id,superseded_by_revision,recorded_at,id);
CREATE INDEX intake_proposal_review_required
  ON grimoire.intake_proposal_review_tasks(org_id,scion_id,required_for_revision,created_at,id);

COMMENT ON TABLE grimoire.intake_proposal_stale_transitions IS
  'Append-only persisted observations that a saved proposal pins an older Scion revision. Live currentness checks remain authoritative safety blockers.';
COMMENT ON TABLE grimoire.intake_proposal_review_tasks IS
  'Append-only required-review work created atomically with each persisted proposal/new-Scion-revision transition. This table does not grant approval authority.';

CREATE FUNCTION grimoire.intake_record_revision_reactions(
  wanted_org uuid,wanted_scion uuid,wanted_revision integer
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE inserted_transitions integer:=0;
BEGIN
  IF wanted_revision<=1 OR NOT EXISTS(
    SELECT 1 FROM grimoire.intake_revisions
    WHERE (org_id,scion_id,number)=(wanted_org,wanted_scion,wanted_revision)
  ) THEN
    RETURN 0;
  END IF;

  INSERT INTO grimoire.intake_proposal_stale_transitions(
    org_id,scion_id,proposal_kind,proposal_id,proposal_scion_revision,
    superseded_by_revision,reason
  )
  SELECT wanted_org,wanted_scion,p.proposal_kind,p.proposal_id,
    p.proposal_scion_revision,wanted_revision,'scion_revision_changed'
  FROM (
    SELECT 'physical_scope'::text AS proposal_kind,id AS proposal_id,
      scion_revision AS proposal_scion_revision
    FROM grimoire.intake_scope_proposals
    WHERE (org_id,scion_id)=(wanted_org,wanted_scion)
    UNION ALL
    SELECT 'offer_comparison'::text,id,scion_revision
    FROM grimoire.intake_comparison_proposals
    WHERE (org_id,scion_id)=(wanted_org,wanted_scion)
  ) p
  WHERE p.proposal_scion_revision<wanted_revision
  ON CONFLICT (org_id,proposal_kind,proposal_id,superseded_by_revision) DO NOTHING;
  GET DIAGNOSTICS inserted_transitions=ROW_COUNT;

  INSERT INTO grimoire.intake_proposal_review_tasks(
    org_id,scion_id,transition_id,proposal_kind,proposal_id,
    required_for_revision,task_kind,status
  )
  SELECT t.org_id,t.scion_id,t.id,t.proposal_kind,t.proposal_id,
    t.superseded_by_revision,'revision_change_review','required'
  FROM grimoire.intake_proposal_stale_transitions t
  WHERE (t.org_id,t.scion_id,t.superseded_by_revision)=
    (wanted_org,wanted_scion,wanted_revision)
  ON CONFLICT (org_id,transition_id) DO NOTHING;

  RETURN inserted_transitions;
END $$;

CREATE FUNCTION grimoire.intake_revision_monitoring_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
BEGIN
  PERFORM grimoire.intake_record_revision_reactions(NEW.org_id,NEW.scion_id,NEW.number);
  RETURN NEW;
END $$;

CREATE TRIGGER intake_revision_monitoring
AFTER INSERT ON grimoire.intake_revisions
FOR EACH ROW EXECUTE FUNCTION grimoire.intake_revision_monitoring_trigger();

-- A database may already contain proposals whose pinned Scion revision was
-- superseded before this trigger existed. Replay every qualifying historical
-- revision in a stable order while the migration transaction still owns the
-- trigger-install lock. The helper's uniqueness rules make this replay safe if
-- the same event is evaluated again after installation.
DO $$
DECLARE historical_event record;
BEGIN
  FOR historical_event IN
    SELECT r.org_id,r.scion_id,r.number
    FROM grimoire.intake_revisions r
    WHERE r.number>1 AND (
      EXISTS(
        SELECT 1 FROM grimoire.intake_scope_proposals p
        WHERE (p.org_id,p.scion_id)=(r.org_id,r.scion_id)
          AND p.scion_revision<r.number
      ) OR EXISTS(
        SELECT 1 FROM grimoire.intake_comparison_proposals p
        WHERE (p.org_id,p.scion_id)=(r.org_id,r.scion_id)
          AND p.scion_revision<r.number
      )
    )
    ORDER BY r.org_id,r.scion_id,r.number
  LOOP
    PERFORM grimoire.intake_record_revision_reactions(
      historical_event.org_id,
      historical_event.scion_id,
      historical_event.number
    );
  END LOOP;
END $$;

CREATE TRIGGER intake_proposal_stale_transitions_immutable
BEFORE UPDATE OR DELETE ON grimoire.intake_proposal_stale_transitions
FOR EACH ROW EXECUTE FUNCTION grimoire.intake_deny_mutation();
CREATE TRIGGER intake_proposal_review_tasks_immutable
BEFORE UPDATE OR DELETE ON grimoire.intake_proposal_review_tasks
FOR EACH ROW EXECUTE FUNCTION grimoire.intake_deny_mutation();

ALTER TABLE grimoire.intake_proposal_stale_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE grimoire.intake_proposal_review_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY intake_proposal_stale_read
ON grimoire.intake_proposal_stale_transitions FOR SELECT TO grimoire_intake_app
USING (org_id=app.current_org_id() AND app.intake_can_access());
CREATE POLICY intake_proposal_review_read
ON grimoire.intake_proposal_review_tasks FOR SELECT TO grimoire_intake_app
USING (org_id=app.current_org_id() AND app.intake_can_access());

REVOKE ALL ON grimoire.intake_proposal_stale_transitions,
  grimoire.intake_proposal_review_tasks FROM PUBLIC;
GRANT SELECT ON grimoire.intake_proposal_stale_transitions,
  grimoire.intake_proposal_review_tasks TO grimoire_intake_app;
REVOKE EXECUTE ON FUNCTION
  grimoire.intake_record_revision_reactions(uuid,uuid,integer),
  grimoire.intake_revision_monitoring_trigger() FROM PUBLIC;

COMMIT;
