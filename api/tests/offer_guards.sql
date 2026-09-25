-- Supplemental rollback-only checks after the real Layer 4 HTTP harness.
-- Run as grimoire_migrator in disposable grimoire_test, never development.
BEGIN;
SET LOCAL search_path=grimoire,public;
SELECT set_config('app.current_org_id','10000000-0000-4000-8000-000000000001',true);
SELECT set_config('app.current_principal_id','10000000-0000-4000-8000-000000000012',true);
SELECT set_config('app.request_id',gen_random_uuid()::text,true);
SELECT set_config('app.effective_role','synthetic_engineering_reviewer',true);
SELECT set_config('app.endpoint_scope','local:offer-guards',true);
SELECT set_config('app.action_reason','Rollback-only exact offer comparison checks',true);
DO $$
DECLARE c intake_comparison_confirmations%ROWTYPE;n normalized_comparison_lines%ROWTYPE;
 offer intake_offer_submissions%ROWTYPE;row_count integer;
BEGIN
 IF current_database()<>'grimoire_test' THEN RAISE EXCEPTION 'offer guards require disposable grimoire_test'; END IF;
 SELECT * INTO STRICT c FROM intake_comparison_confirmations WHERE org_id=app.current_org_id() ORDER BY confirmed_at DESC LIMIT 1;
 SELECT count(*) INTO row_count FROM intake_offer_source_links m
 JOIN source_document_revisions r ON (r.org_id,r.id,r.source_document_id)=(m.org_id,m.source_revision_id,m.source_document_id)
 JOIN intake_source_objects o ON (o.org_id,o.source_id,o.source_revision)=(m.org_id,m.intake_source_id,m.intake_source_revision)
 WHERE m.org_id=app.current_org_id() AND (r.s3_bucket,r.s3_key,r.s3_version_id,r.content_sha256,r.byte_length) IS DISTINCT FROM (o.object_bucket,o.object_key,o.object_version_id,o.content_sha256,o.byte_length::bigint);
 IF row_count<>0 THEN RAISE EXCEPTION 'governed source bridge does not preserve exact private object identity'; END IF;
 IF EXISTS(SELECT 1 FROM source_grants g JOIN principal_roles p ON (p.org_id,p.principal_id)=(g.org_id,g.principal_id)
 JOIN intake_offer_source_links m ON (m.org_id,m.source_document_id)=(g.org_id,g.source_document_id)
 WHERE g.org_id=app.current_org_id() AND p.role IN ('read_only_agent','system_worker')) THEN RAISE EXCEPTION 'offer import escalated governed-source permission to an agent'; END IF;
 IF EXISTS(SELECT 1 FROM normalized_comparison_lines x JOIN offer_lines l ON (l.org_id,l.id)=(x.org_id,x.offer_line_id)
 JOIN intake_comparison_confirmations cc ON (cc.org_id,cc.comparison_revision_id)=(x.org_id,x.comparison_revision_id)
 WHERE x.org_id=app.current_org_id() AND x.state='comparable' AND (x.normalized_unit_price<>l.unit_price OR x.fx_rate<>1 OR x.normalization_evidence_id IS NOT NULL)) THEN RAISE EXCEPTION 'same-basis normalized values did not preserve quoted exact decimal price'; END IF;
 IF EXISTS(SELECT 1 FROM intake_comparison_confirmations cc JOIN derived_artifacts a ON (a.org_id,a.id)=(cc.org_id,cc.artifact_id)
 JOIN intake_comparison_proposals cp ON (cp.org_id,cp.id)=(cc.org_id,cc.proposal_id)
 JOIN intake_scope_proposals sp ON (sp.org_id,sp.id)=(cp.org_id,(cp.input->>'scope_proposal_id')::uuid)
 WHERE cc.org_id=app.current_org_id() AND a.valid AND (
   EXISTS(SELECT 1 FROM jsonb_array_elements(sp.input->'source_claims') r JOIN intake_source_revocations v ON (v.org_id,v.source_id)=(sp.org_id,(r->>'source_id')::uuid))
   OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(cp.input->'offer_revision_ids') r JOIN intake_offer_submissions s ON (s.org_id,s.id)=(cp.org_id,r.value::uuid)
     JOIN intake_source_revocations v ON (v.org_id,v.source_id)=(s.org_id,(s.input#>>'{source,source_id}')::uuid)))) THEN RAISE EXCEPTION 'revoked supplier or physical-scope source left a comparison artifact valid'; END IF;
 IF EXISTS(SELECT 1 FROM intake_comparison_confirmations cc JOIN derived_artifacts a ON (a.org_id,a.id)=(cc.org_id,cc.artifact_id)
 WHERE cc.org_id=app.current_org_id() AND NOT a.valid AND app.intake_comparison_governed(cc.proposal_id) IS NOT NULL) THEN RAISE EXCEPTION 'invalidated comparison helper leaked canonical normalized prices'; END IF;
 SELECT * INTO STRICT offer FROM intake_offer_submissions WHERE org_id=app.current_org_id() AND governed_offer_revision_id IS NOT NULL ORDER BY created_at DESC LIMIT 1;
 BEGIN UPDATE intake_offer_submissions SET input=input WHERE id=offer.id; RAISE EXCEPTION 'offer submission mutation unexpectedly succeeded'; EXCEPTION WHEN SQLSTATE 'G2401' THEN NULL; END;
 BEGIN DELETE FROM intake_comparison_confirmations WHERE proposal_id=c.proposal_id; RAISE EXCEPTION 'normalization confirmation deletion unexpectedly succeeded'; EXCEPTION WHEN SQLSTATE 'G2401' THEN NULL; END;
 BEGIN UPDATE offer_revisions SET currency=currency WHERE id=offer.governed_offer_revision_id; RAISE EXCEPTION 'governed offer mutation unexpectedly succeeded'; EXCEPTION WHEN SQLSTATE 'G2001' THEN NULL; END;
 SELECT x.* INTO STRICT n FROM normalized_comparison_lines x JOIN intake_comparison_confirmations cc ON (cc.org_id,cc.comparison_revision_id)=(x.org_id,x.comparison_revision_id)
 WHERE x.org_id=app.current_org_id() AND x.state='comparable' ORDER BY x.recorded_at DESC LIMIT 1;
 BEGIN
   INSERT INTO normalized_comparison_lines(org_id,comparison_revision_id,offer_line_id,identity_assessment_id,state,normalized_quantity,normalized_uom,normalized_currency,normalized_unit_price,fx_rate,fx_rate_date,normalized_validity_window,normalization_note,reviewed_by)
   VALUES(n.org_id,n.comparison_revision_id,n.offer_line_id,n.identity_assessment_id,'comparable',n.normalized_quantity,n.normalized_uom,n.normalized_currency,n.normalized_unit_price,2,n.fx_rate_date,n.normalized_validity_window,'Rollback-only invented FX rejection',app.current_principal_id());
   RAISE EXCEPTION 'invented same-currency FX unexpectedly succeeded';
 EXCEPTION WHEN SQLSTATE 'G1012' THEN NULL; END;
 IF has_table_privilege('grimoire_intake_app','grimoire.offer_revisions','INSERT,UPDATE,DELETE') OR has_table_privilege('grimoire_intake_app','grimoire.normalized_comparison_lines','INSERT,UPDATE,DELETE')
 OR has_table_privilege('grimoire_intake_app','grimoire.intake_comparison_confirmations','INSERT,UPDATE,DELETE') THEN RAISE EXCEPTION 'runtime bypasses bounded governed write/review helpers'; END IF;
 PERFORM set_config('app.current_principal_id','10000000-0000-4000-8000-000000000018',true);
 BEGIN PERFORM app.intake_offer_confirm((SELECT scion_id FROM intake_comparison_proposals WHERE id=c.proposal_id),c.proposal_id,(SELECT scion_revision FROM intake_comparison_proposals WHERE id=c.proposal_id),'Agent may not confirm normalization'); RAISE EXCEPTION 'agent normalization confirmation unexpectedly succeeded'; EXCEPTION WHEN SQLSTATE 'G2804' THEN NULL; END;
 PERFORM set_config('app.current_org_id','20000000-0000-4000-8000-000000000001',true);
 PERFORM set_config('app.current_principal_id','20000000-0000-4000-8000-000000000011',true);
 IF app.intake_offer_governed(offer.id) IS NOT NULL OR app.intake_comparison_governed(c.proposal_id) IS NOT NULL THEN RAISE EXCEPTION 'foreign governed offer or comparison metadata leaked'; END IF;
 RAISE NOTICE 'PASS: exact governed source-object mapping; no agent source-grant escalation; exact same-basis decimal preservation; supplier/scope revocation artifact invalidation and price-read denial; immutable submission/offer/comparison; invented FX rejection; least privilege; agent review denial; cross-org hiding';
END $$;
ROLLBACK;

-- Isolate the two additive 0033 regressions from unrelated author/task checks.
-- Setup below is migration-owner-only synthetic staging; every row is rolled back.
BEGIN;
SET LOCAL search_path=grimoire,public;
SELECT set_config('app.current_org_id','10000000-0000-4000-8000-000000000001',true);
SELECT set_config('app.current_principal_id','10000000-0000-4000-8000-000000000011',true);
SELECT set_config('app.request_id',gen_random_uuid()::text,true);
SELECT set_config('app.effective_role','synthetic_test_preparer',true);
SELECT set_config('app.endpoint_scope','local:offer-0033-guards',true);
SELECT set_config('app.action_reason','Rollback-only legal identity and historical author regression checks',true);
DO $$
DECLARE scope_row intake_scope_proposals%ROWTYPE;
 org uuid:=app.current_org_id(); author uuid:=gen_random_uuid(); past_author uuid:=gen_random_uuid();
 series_a uuid:=gen_random_uuid();series_b uuid:=gen_random_uuid();series_duplicate uuid:=gen_random_uuid();
 older_a uuid:=gen_random_uuid();current_a uuid:=gen_random_uuid();current_b uuid:=gen_random_uuid();duplicate_revision uuid:=gen_random_uuid();
 proposal uuid:=gen_random_uuid(); payload jsonb;candidate jsonb;basis jsonb;duplicate_candidate jsonb;
BEGIN
 IF current_database()<>'grimoire_test' THEN RAISE EXCEPTION '0033 offer guards require disposable grimoire_test'; END IF;
 SELECT p.* INTO STRICT scope_row FROM intake_scope_proposals p
 JOIN intake_scope_confirmations c ON (c.org_id,c.proposal_id)=(p.org_id,p.id)
 JOIN intake_scions s ON (s.org_id,s.id,s.current_revision)=(p.org_id,p.scion_id,p.scion_revision)
 WHERE p.org_id=org AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.input->'source_claims') r
   WHERE NOT EXISTS(SELECT 1 FROM intake_sources src WHERE (src.org_id,src.id,src.scion_id,src.scion_revision,src.current_revision)=(p.org_id,(r->>'source_id')::uuid,p.scion_id,p.scion_revision,(r->>'source_revision')::integer))
   OR EXISTS(SELECT 1 FROM intake_source_revocations v WHERE (v.org_id,v.source_id)=(p.org_id,(r->>'source_id')::uuid)))
 ORDER BY p.created_at DESC LIMIT 1;
 INSERT INTO principals(id,org_id,external_subject,display_name) VALUES
 (author,org,'rollback-offer-author-'||author::text,'SYNTHETIC rollback current author'),
 (past_author,org,'rollback-offer-reviewer-'||past_author::text,'SYNTHETIC rollback historical author');
 INSERT INTO principal_roles(org_id,principal_id,role) VALUES(org,author,'procurement_preparer'),(org,past_author,'engineering_reviewer');
 INSERT INTO intake_scope_reviewers(org_id,principal_id) VALUES(org,past_author);
 INSERT INTO intake_offer_series(id,org_id,scion_id,current_revision,created_by) VALUES
 (series_a,org,scope_row.scion_id,2,author),(series_b,org,scope_row.scion_id,1,author),(series_duplicate,org,scope_row.scion_id,1,author);
 payload:=jsonb_build_object('synthetic',true,'scion_revision',scope_row.scion_revision,'scope_proposal_id',scope_row.id,
   'supplier',jsonb_build_object('legal_name','SYNTHETIC rollback identity A','jurisdiction','SYNTHETIC-JURISDICTION-A','registration_ref','SAME-LOCAL-REGISTRATION','site_code','SYN-SITE','country_code','US','account_ref','SYN-ACCOUNT'),
   'source',(scope_row.input->'source_claims'->0)-'kind','offer_ref','SYNTHETIC-ROLLBACK-A','identity_match','exact',
   'offered_manufacturer','SYNTHETIC rollback only','offered_part_number','SYNTHETIC rollback only',
   'quantity','2','uom','EA','unit_price',NULL,'currency','USD','destination','Synthetic test lab','incoterm','EXW','payment_terms','Synthetic net 30',
   'quoted_at','2026-09-26T00:00:00Z','valid_from','2026-09-26T00:00:00Z','valid_until','2026-10-26T00:00:00Z','lead_time_days',7,'change_summary','Synthetic rollback regression only');
 INSERT INTO intake_offer_submissions(id,org_id,scion_id,offer_id,number,input,input_hash,missing_fields,created_by) VALUES
 (older_a,org,scope_row.scion_id,series_a,1,payload,encode(digest(older_a::text,'sha256'),'hex'),'["unit_price"]',past_author),
 (current_a,org,scope_row.scion_id,series_a,2,payload||jsonb_build_object('change_summary','New current author'),encode(digest(current_a::text,'sha256'),'hex'),'["unit_price"]',author),
 (current_b,org,scope_row.scion_id,series_b,1,jsonb_set(payload,'{supplier,jurisdiction}','"SYNTHETIC-JURISDICTION-B"'),encode(digest(current_b::text,'sha256'),'hex'),'["unit_price"]',author),
 (duplicate_revision,org,scope_row.scion_id,series_duplicate,1,payload,encode(digest(duplicate_revision::text,'sha256'),'hex'),'["unit_price"]',author);
 basis:=jsonb_build_object('quantity','2','uom','EA','currency','USD','destination','Synthetic test lab','incoterm','EXW','payment_terms','Synthetic net 30',
   'as_of','2026-09-26T12:00:00Z','valid_from','2026-09-26T00:00:00Z','valid_until','2026-10-26T00:00:00Z');
 candidate:=jsonb_build_object('synthetic',true,'scope_proposal_id',scope_row.id,'offer_revision_ids',jsonb_build_array(current_a,current_b),'basis',basis,'change_summary','Synthetic rollback identity and history test');
 PERFORM set_config('app.current_principal_id',author::text,true);
 -- Equal registration references in different jurisdictions are distinct identities.
 PERFORM app.intake_offer_assert_candidate(scope_row.scion_id,scope_row.scion_revision,candidate);
 duplicate_candidate:=jsonb_set(candidate,'{offer_revision_ids}',jsonb_build_array(current_a,duplicate_revision));
 BEGIN
   PERFORM app.intake_offer_assert_candidate(scope_row.scion_id,scope_row.scion_revision,duplicate_candidate);
   RAISE EXCEPTION 'same jurisdiction and registration identity unexpectedly accepted as two suppliers';
 EXCEPTION WHEN SQLSTATE 'G3201' THEN NULL; END;
 INSERT INTO intake_comparison_proposals(id,org_id,scion_id,scion_revision,input,snapshot,created_by)
 VALUES(proposal,org,scope_row.scion_id,scope_row.scion_revision,candidate,'{}',author);
 IF app.intake_offer_reviewer_conflict(proposal) IS DISTINCT FROM true THEN RAISE EXCEPTION 'current author conflict missing'; END IF;
 PERFORM set_config('app.current_principal_id',past_author::text,true);
 IF NOT app.intake_scope_can_confirm() THEN RAISE EXCEPTION 'historical author must otherwise be an enrolled reviewer for this test'; END IF;
 IF EXISTS(SELECT 1 FROM intake_comparison_proposals WHERE id=proposal AND created_by=past_author)
 OR EXISTS(SELECT 1 FROM intake_offer_submissions WHERE id IN(current_a,current_b) AND created_by=past_author)
 OR EXISTS(SELECT 1 FROM intake_offer_series WHERE id IN(series_a,series_b) AND created_by=past_author)
 OR EXISTS(SELECT 1 FROM intake_agent_tasks WHERE org_id=org AND scion_id=scope_row.scion_id AND created_by=past_author) THEN
   RAISE EXCEPTION 'historical-only conflict test was masked by another authorship conflict';
 END IF;
 IF app.intake_offer_reviewer_conflict(proposal) IS DISTINCT FROM true THEN RAISE EXCEPTION 'historical offer preparer conflict missing'; END IF;
 BEGIN
   PERFORM app.intake_offer_confirm(scope_row.scion_id,proposal,scope_row.scion_revision,'Historical preparer must not review this normalization');
   RAISE EXCEPTION 'historical preparer normalization confirmation unexpectedly succeeded';
 EXCEPTION WHEN SQLSTATE 'G2804' THEN NULL; END;
 RAISE NOTICE 'PASS: equal registration references across distinct jurisdictions accepted; duplicate full legal identity denied; earlier offer author denied normalization review despite different current offer, series and proposal authors';
END $$;
ROLLBACK;
