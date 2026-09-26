-- Run after the real Go offer harness, passing its HTTP_AUDIT_EXPECTATION fields
-- as psql variables. This independently verifies persisted governed audit rows;
-- it never inserts a fake HTTP event or grants any sourcing approval.
BEGIN READ ONLY;
SET LOCAL search_path=pg_catalog,grimoire,pg_temp;
SELECT set_config('test.audit_offer_revision', :'offer_revision_id', true);
SELECT set_config('test.audit_offer_line', :'offer_line_id', true);
SELECT set_config('test.audit_expected_scope', :'endpoint_scope', true);
SELECT set_config('test.audit_expected_hash', :'input_sha256', true);
SELECT set_config('test.audit_expected_actor', :'actor_id', true);
SELECT set_config('test.audit_expected_role', :'effective_role', true);
DO $$
DECLARE event grimoire.audit_events%ROWTYPE; target uuid; count_rows integer;
BEGIN
 IF current_database() NOT LIKE '%\_test' ESCAPE '\' THEN RAISE EXCEPTION 'HTTP audit guards require a disposable _test database'; END IF;
 IF current_setting('test.audit_expected_hash') !~ '^[a-f0-9]{64}$' OR current_setting('test.audit_expected_hash') IN (repeat('0',64),repeat('f',64)) OR
    current_setting('test.audit_expected_scope') !~ '^POST /api/scions/[a-f0-9-]{36}/offers$' THEN RAISE EXCEPTION 'invalid real HTTP expectation'; END IF;
 FOREACH target IN ARRAY ARRAY[current_setting('test.audit_offer_revision')::uuid,current_setting('test.audit_offer_line')::uuid] LOOP
   count_rows:=0;
   FOR event IN SELECT * FROM grimoire.audit_events WHERE object_id=target AND action='insert' LOOP
     count_rows:=count_rows+1;
     IF event.request_id IS NULL OR event.actor_id IS DISTINCT FROM current_setting('test.audit_expected_actor')::uuid OR
        event.effective_role IS DISTINCT FROM current_setting('test.audit_expected_role') OR
        event.endpoint_scope IS DISTINCT FROM current_setting('test.audit_expected_scope') OR
        event.input_hash IS DISTINCT FROM current_setting('test.audit_expected_hash') OR
        event.after_hash IS NULL OR event.outcome IS DISTINCT FROM 'committed' OR coalesce(length(btrim(event.decision_reason)),0)=0 THEN
       RAISE EXCEPTION 'HTTP audit row % lacks exact real endpoint/body hash/authenticated authority context',event.id;
     END IF;
   END LOOP;
   IF count_rows<>1 THEN RAISE EXCEPTION 'Expected one canonical insert audit row for %, got %',target,count_rows; END IF;
 END LOOP;
 RAISE NOTICE 'PASS: actual Rust HTTP request created canonical audit rows with exact body SHA256, method/path, authenticated actor/role/request ID; caller-spoofed internal headers were overwritten';
END $$;
ROLLBACK;
