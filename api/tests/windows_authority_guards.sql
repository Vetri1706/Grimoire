-- New Windows-only approval lockdown checks. Not unavailable GG-53/GG-54 work.
-- All probes roll back. The fixed caller uses only the isolated clean database.
BEGIN;
DO $$ BEGIN
 IF current_database() <> 'grimoire_startup_clean_test' THEN
  RAISE EXCEPTION 'Windows startup authority guards require isolated clean database';
 END IF;
END $$;
SET LOCAL ROLE grimoire_intake_app;
-- An untrusted role label is not approval authority.
SET LOCAL app.effective_role='sourcing_approver';
SET LOCAL app.endpoint_scope='approval:confirm';
DO $$
BEGIN
 IF has_function_privilege(current_user,'app.record_synthetic_sourcing_authority_review(uuid,uuid,uuid,uuid,uuid,uuid,text,text,boolean)','EXECUTE')
    OR has_function_privilege(current_user,'app.create_synthetic_draft_decision(uuid,uuid,uuid,uuid,text,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,boolean)','EXECUTE') THEN
  RAISE EXCEPTION 'Unverified approval helper is executable by runtime';
 END IF;
 BEGIN
  PERFORM app.record_synthetic_sourcing_authority_review(NULL::uuid,NULL::uuid,NULL::uuid,NULL::uuid,NULL::uuid,NULL::uuid,'synthetic','forged role setting',true);
  RAISE EXCEPTION 'Forged GUC role reached approval helper';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
 BEGIN
  EXECUTE 'CREATE TABLE public.windows_runtime_ddl_probe(id integer)';
  RAISE EXCEPTION 'Runtime unexpectedly created a table';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
 BEGIN
  EXECUTE 'SET LOCAL ROLE grimoire_migrator';
  RAISE EXCEPTION 'Runtime unexpectedly escalated to migration owner';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
END $$;
ROLLBACK;
