-- Windows-only additive safety boundary. Not GG-53/0037 or GG-54.
-- Keep unverified canonical sourcing-decision/approval paths unavailable.
BEGIN;
GRANT SELECT ON public.grimoire_schema_migrations TO grimoire_intake_app;
REVOKE EXECUTE ON FUNCTION
 app.record_synthetic_sourcing_authority_review(uuid,uuid,uuid,uuid,uuid,uuid,text,text,boolean),
 app.create_synthetic_draft_decision(uuid,uuid,uuid,uuid,text,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,boolean)
FROM PUBLIC,grimoire_intake_app,grimoire_app,grimoire_worker;

CREATE FUNCTION grimoire.windows_deny_unverified_approval() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 -- The unchanged GG-40 contract fixture may run only under an explicitly
 -- selected migration owner in the named disposable test databases. A custom
 -- app.* setting or SECURITY DEFINER current_user cannot supply this authority.
 IF current_setting('role')='grimoire_migrator'
    AND pg_has_role(session_user,'grimoire_migrator','MEMBER')
    AND current_database() IN ('grimoire_test','grimoire_startup_clean_test','grimoire_startup_upgrade_test') THEN
   RETURN NEW;
 END IF;
 RAISE EXCEPTION USING ERRCODE='G3901', MESSAGE='canonical sourcing approval unavailable on this Windows implementation';
END $$;
CREATE TRIGGER windows_approval_disabled BEFORE INSERT ON grimoire.decision_approvals
FOR EACH ROW EXECUTE FUNCTION grimoire.windows_deny_unverified_approval();
CREATE TRIGGER windows_authority_review_disabled BEFORE INSERT ON grimoire.sourcing_authority_reviews
FOR EACH ROW EXECUTE FUNCTION grimoire.windows_deny_unverified_approval();
CREATE TRIGGER windows_decision_write_disabled BEFORE INSERT ON grimoire.decision_revisions
FOR EACH ROW EXECUTE FUNCTION grimoire.windows_deny_unverified_approval();
REVOKE ALL ON FUNCTION grimoire.windows_deny_unverified_approval() FROM PUBLIC;
COMMIT;
