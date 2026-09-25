-- Current directory names for visible draft history; separate from snapshots.
-- Additive Layer 1 migration, not part of verified GG-40 v2.2.1.
BEGIN;

CREATE FUNCTION app.intake_history_authors(wanted_scion uuid)
RETURNS TABLE (principal_id uuid, display_name text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
  SELECT DISTINCT p.id,p.display_name::text
  FROM grimoire.intake_revisions r
  JOIN grimoire.principals p ON (p.org_id,p.id)=(r.org_id,r.created_by)
  WHERE r.scion_id=wanted_scion
    AND r.org_id=app.current_org_id()
    AND app.intake_can_access()
  ORDER BY p.id
$$;
COMMENT ON FUNCTION app.intake_history_authors(uuid) IS
  'Current directory names of authors in one visible draft history. Does not alter immutable revision snapshots or confer approval authority.';
REVOKE ALL ON FUNCTION app.intake_history_authors(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.intake_history_authors(uuid) TO grimoire_intake_app;

COMMIT;
