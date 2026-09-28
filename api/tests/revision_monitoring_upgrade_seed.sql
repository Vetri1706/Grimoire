-- Apply after migrations 0022 through 0033, before migration 0034, in a
-- disposable database owned by grimoire_migrator. This fixture deliberately
-- creates both proposal kinds at revision 1, then advances the Scion twice so
-- the proposals are already stale when 0034 is installed.
BEGIN;
SET LOCAL search_path=grimoire,public;
SET LOCAL app.current_org_id='61000000-0000-4000-8000-000000000001';
SET LOCAL app.current_principal_id='61000000-0000-4000-8000-000000000011';
SET LOCAL app.request_id='61000000-0000-4000-8000-000000000021';

INSERT INTO grimoire.organizations(id,name)
VALUES('61000000-0000-4000-8000-000000000001','GG-61 upgrade fixture');
INSERT INTO grimoire.principals(id,org_id,external_subject,display_name)
VALUES(
  '61000000-0000-4000-8000-000000000011',
  '61000000-0000-4000-8000-000000000001',
  'gg61-upgrade-fixture-handler',
  'GG-61 upgrade fixture Handler'
);
INSERT INTO grimoire.principal_roles(org_id,principal_id,role)
VALUES(
  '61000000-0000-4000-8000-000000000001',
  '61000000-0000-4000-8000-000000000011',
  'procurement_preparer'
);
INSERT INTO grimoire.intake_scions(id,org_id,created_by)
VALUES(
  '61000000-0000-4000-8000-000000000101',
  '61000000-0000-4000-8000-000000000001',
  '61000000-0000-4000-8000-000000000011'
);
INSERT INTO grimoire.intake_revisions(
  org_id,scion_id,number,name,product_category,change_summary,created_by
) VALUES(
  '61000000-0000-4000-8000-000000000001',
  '61000000-0000-4000-8000-000000000101',
  1,'Upgrade fixture','physical','Initial revision',
  '61000000-0000-4000-8000-000000000011'
);

-- Proposal validation belongs to the already-tested creation paths. This
-- migration-boundary fixture needs only FK-valid immutable proposals, so it
-- disables the two validation triggers for these direct owner inserts and
-- re-enables them before advancing the Scion.
ALTER TABLE grimoire.intake_scope_proposals
  DISABLE TRIGGER intake_scope_proposal_guard;
ALTER TABLE grimoire.intake_comparison_proposals
  DISABLE TRIGGER intake_comparison_proposal_guard;
INSERT INTO grimoire.intake_scope_proposals(
  id,org_id,scion_id,scion_revision,input,created_by
) VALUES(
  '61000000-0000-4000-8000-000000000201',
  '61000000-0000-4000-8000-000000000001',
  '61000000-0000-4000-8000-000000000101',
  1,'{
    "synthetic":true,
    "identity_match":"exact",
    "configuration":{"product_code":"SYN-UPGRADE","product_name":"Upgrade fixture","configuration_code":"REV-1","specification":{}},
    "component":{"internal_part_code":"SYN-COMPONENT","manufacturer":"Synthetic manufacturer","part_number":"SYN-PART","attributes":{}},
    "occurrence":{"path":"/synthetic[1]","quantity":"1","uom":"EA"},
    "requirement":{"code":"SYN-REQ","criteria":{}},
    "case_code":"SYN-UPGRADE-CASE",
    "case_title":"GG-61 upgrade fixture",
    "source_claims":[],
    "unresolved_gaps":[],
    "change_summary":"Synthetic migration-boundary fixture only"
  }',
  '61000000-0000-4000-8000-000000000011'
);
INSERT INTO grimoire.intake_comparison_proposals(
  id,org_id,scion_id,scion_revision,input,snapshot,created_by
) VALUES(
  '61000000-0000-4000-8000-000000000202',
  '61000000-0000-4000-8000-000000000001',
  '61000000-0000-4000-8000-000000000101',
  1,'{
    "synthetic":true,
    "scope_proposal_id":"61000000-0000-4000-8000-000000000201",
    "offer_revision_ids":[],
    "basis":{"quantity":"1","uom":"EA","currency":"USD","destination":"Synthetic lab","incoterm":"EXW","payment_terms":"Synthetic test terms","as_of":"2026-09-28T00:00:00Z","valid_from":"2026-09-28T00:00:00Z","valid_until":"2026-09-29T00:00:00Z"},
    "change_summary":"Synthetic migration-boundary fixture only"
  }','{}',
  '61000000-0000-4000-8000-000000000011'
);
ALTER TABLE grimoire.intake_scope_proposals
  ENABLE TRIGGER intake_scope_proposal_guard;
ALTER TABLE grimoire.intake_comparison_proposals
  ENABLE TRIGGER intake_comparison_proposal_guard;

INSERT INTO grimoire.intake_revisions(
  org_id,scion_id,number,name,product_category,change_summary,created_by
) VALUES(
  '61000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000101',
  2,'Upgrade fixture','physical','Already stale before 0034, revision 2',
  '61000000-0000-4000-8000-000000000011'
);
INSERT INTO grimoire.intake_revisions(
  org_id,scion_id,number,name,product_category,change_summary,created_by
) VALUES(
  '61000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000101',
  3,'Upgrade fixture','physical','Already stale before 0034, revision 3',
  '61000000-0000-4000-8000-000000000011'
);
COMMIT;
