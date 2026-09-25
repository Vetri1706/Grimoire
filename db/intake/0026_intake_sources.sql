-- Additive synthetic draft-source slice. Not part of verified GG-40 v2.2.1.
-- Apply after unchanged 0022 -> 0023 -> 0024 -> 0025 in the canonical database.
BEGIN;
SET search_path=pg_catalog,grimoire,pg_temp;

CREATE TABLE grimoire.intake_sources (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES grimoire.organizations(id),
  scion_id uuid NOT NULL,
  scion_revision integer NOT NULL,
  current_revision integer NOT NULL DEFAULT 0 CHECK (current_revision>=0),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (org_id,id),
  FOREIGN KEY (org_id,scion_id,scion_revision) REFERENCES grimoire.intake_revisions(org_id,scion_id,number),
  FOREIGN KEY (org_id,created_by) REFERENCES grimoire.principals(org_id,id)
);
CREATE INDEX intake_sources_scion ON grimoire.intake_sources(org_id,scion_id,created_at,id);
CREATE TABLE grimoire.intake_source_revisions (
  org_id uuid NOT NULL,
  source_id uuid NOT NULL,
  number integer NOT NULL CHECK (number>0),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 160),
  origin text NOT NULL CHECK (length(btrim(origin)) BETWEEN 1 AND 2000),
  owner text NOT NULL CHECK (length(btrim(owner)) BETWEEN 1 AND 300),
  synthetic boolean NOT NULL CHECK (synthetic),
  source_text text NOT NULL CHECK (octet_length(source_text) BETWEEN 1 AND 32000 AND length(btrim(source_text))>0),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  byte_length integer NOT NULL CHECK (byte_length BETWEEN 1 AND 32000),
  rights_status text NOT NULL CHECK (rights_status='granted'),
  permission_basis text NOT NULL CHECK (length(btrim(permission_basis)) BETWEEN 1 AND 4000),
  permitted_use text NOT NULL CHECK (permitted_use='scion_review'),
  change_summary text NOT NULL CHECK (length(btrim(change_summary)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by uuid NOT NULL,
  PRIMARY KEY (org_id,source_id,number),
  FOREIGN KEY (org_id,source_id) REFERENCES grimoire.intake_sources(org_id,id),
  FOREIGN KEY (org_id,created_by) REFERENCES grimoire.principals(org_id,id)
);
CREATE TABLE grimoire.intake_source_revocations (
  org_id uuid NOT NULL,
  source_id uuid NOT NULL,
  source_revision integer NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by uuid NOT NULL,
  PRIMARY KEY (org_id,source_id),
  FOREIGN KEY (org_id,source_id,source_revision) REFERENCES grimoire.intake_source_revisions(org_id,source_id,number),
  FOREIGN KEY (org_id,created_by) REFERENCES grimoire.principals(org_id,id)
);
CREATE TABLE grimoire.intake_source_claims (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  source_id uuid NOT NULL,
  source_revision integer NOT NULL,
  statement text NOT NULL CHECK (length(btrim(statement)) BETWEEN 1 AND 4000),
  start_byte integer NOT NULL CHECK (start_byte>=0),
  end_byte integer NOT NULL CHECK (end_byte>start_byte AND end_byte<=32000),
  quote text NOT NULL CHECK (octet_length(quote) BETWEEN 1 AND 32000),
  authority text NOT NULL DEFAULT 'handler_entered' CHECK (authority='handler_entered'),
  verification_status text NOT NULL DEFAULT 'unverified' CHECK (verification_status='unverified'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by uuid NOT NULL,
  UNIQUE (org_id,source_id,source_revision),
  FOREIGN KEY (org_id,source_id,source_revision) REFERENCES grimoire.intake_source_revisions(org_id,source_id,number),
  FOREIGN KEY (org_id,created_by) REFERENCES grimoire.principals(org_id,id)
);
COMMENT ON TABLE grimoire.intake_source_revisions IS 'Bounded synthetic UTF-8 text with historical permission attestations; not object storage, approved evidence, or governed sourcing sources.';
COMMENT ON TABLE grimoire.intake_source_claims IS 'One immutable Handler-entered unverified claim per source revision. Not automated extraction and not verified facts.';

CREATE FUNCTION app.intake_source_permitted(wanted_source uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
 SELECT app.intake_can_access() AND EXISTS (
   SELECT 1 FROM grimoire.intake_sources s WHERE s.id=wanted_source AND s.org_id=app.current_org_id()
     AND NOT EXISTS (SELECT 1 FROM grimoire.intake_source_revocations r WHERE (r.org_id,r.source_id)=(s.org_id,s.id)))
$$;

-- Readers hold a share lock until their content query commits. This scoped
-- helper lets read-only organization members lock without UPDATE privileges.
-- Writers and revocations take FOR UPDATE, serializing against these reads.
CREATE FUNCTION app.intake_source_read_lock(wanted_scion uuid,wanted_source uuid) RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
 SELECT s.current_revision FROM grimoire.intake_sources s
 WHERE s.id=wanted_source AND s.scion_id=wanted_scion
   AND s.org_id=app.current_org_id() AND app.intake_can_access()
 FOR SHARE
$$;

CREATE FUNCTION grimoire.intake_guard_source() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,grimoire,pg_temp AS $$
DECLARE current_number integer;
BEGIN
 IF NEW.org_id IS DISTINCT FROM app.current_org_id() OR NEW.created_by IS DISTINCT FROM app.current_principal_id()
   OR NEW.current_revision<>0 OR NOT app.intake_can_write() THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='source creation is not authorized';
 END IF;
 SELECT current_revision INTO STRICT current_number FROM grimoire.intake_scions
   WHERE (org_id,id)=(NEW.org_id,NEW.scion_id) FOR UPDATE;
 IF NEW.scion_revision<>current_number THEN
   RAISE EXCEPTION USING ERRCODE='G2402',MESSAGE='source must link the current Scion revision';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER intake_source_guard BEFORE INSERT ON grimoire.intake_sources
FOR EACH ROW EXECUTE FUNCTION grimoire.intake_guard_source();

CREATE FUNCTION grimoire.intake_guard_source_write() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,grimoire,pg_temp AS $$
DECLARE current_number integer; source_bytes bytea;
BEGIN
 IF NEW.org_id IS DISTINCT FROM app.current_org_id() OR NEW.created_by IS DISTINCT FROM app.current_principal_id()
   OR NOT app.intake_can_write() THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='source write is not authorized';
 END IF;
 SELECT current_revision INTO STRICT current_number FROM grimoire.intake_sources
   WHERE (org_id,id)=(NEW.org_id,NEW.source_id) FOR UPDATE;
 IF NOT app.intake_source_permitted(NEW.source_id) THEN
   RAISE EXCEPTION USING ERRCODE='G2601',MESSAGE='source permission has been revoked';
 END IF;
 IF TG_TABLE_NAME='intake_source_revisions' THEN
   IF NEW.number<>current_number+1 THEN
     RAISE EXCEPTION USING ERRCODE='G2402',MESSAGE='source revision must follow current revision';
   END IF;
   IF NEW.byte_length<>octet_length(NEW.source_text)
      OR NEW.content_sha256<>encode(public.digest(convert_to(NEW.source_text,'UTF8'),'sha256'),'hex') THEN
     RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='source content hash or byte length mismatch';
   END IF;
 ELSIF TG_TABLE_NAME='intake_source_revocations' THEN
   IF NEW.source_revision<>current_number THEN
     RAISE EXCEPTION USING ERRCODE='G2402',MESSAGE='revocation must reference the current revision';
   END IF;
 ELSE
   SELECT convert_to(source_text,'UTF8') INTO STRICT source_bytes FROM grimoire.intake_source_revisions
     WHERE (org_id,source_id,number)=(NEW.org_id,NEW.source_id,NEW.source_revision);
   IF NEW.start_byte<0 OR NEW.end_byte<=NEW.start_byte OR NEW.end_byte>octet_length(source_bytes)
     OR substring(source_bytes FROM NEW.start_byte+1 FOR NEW.end_byte-NEW.start_byte)<>convert_to(NEW.quote,'UTF8') THEN
     RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='claim locator must match exact UTF-8 source bytes';
   END IF;
   -- Valid UTF-8 quote bytes matching this interval also prove both boundaries.
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER intake_source_revision_guard BEFORE INSERT ON grimoire.intake_source_revisions
FOR EACH ROW EXECUTE FUNCTION grimoire.intake_guard_source_write();
CREATE TRIGGER intake_source_claim_guard BEFORE INSERT ON grimoire.intake_source_claims
FOR EACH ROW EXECUTE FUNCTION grimoire.intake_guard_source_write();
CREATE TRIGGER intake_source_revocation_guard BEFORE INSERT ON grimoire.intake_source_revocations
FOR EACH ROW EXECUTE FUNCTION grimoire.intake_guard_source_write();

CREATE FUNCTION grimoire.intake_after_source_revision() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,grimoire,pg_temp AS $$
BEGIN
 UPDATE grimoire.intake_sources SET current_revision=NEW.number,updated_at=NEW.created_at
   WHERE (org_id,id)=(NEW.org_id,NEW.source_id);
 RETURN NEW;
END $$;
CREATE TRIGGER intake_source_revision_recorded AFTER INSERT ON grimoire.intake_source_revisions
FOR EACH ROW EXECUTE FUNCTION grimoire.intake_after_source_revision();
CREATE FUNCTION grimoire.intake_require_initial_source_revision() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,grimoire,pg_temp AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM grimoire.intake_source_revisions WHERE (org_id,source_id,number)=(NEW.org_id,NEW.id,1)) THEN
   RAISE EXCEPTION USING ERRCODE='G2602',MESSAGE='source creation requires revision one';
 END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER intake_source_initial_revision AFTER INSERT ON grimoire.intake_sources
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION grimoire.intake_require_initial_source_revision();

CREATE TRIGGER intake_source_revisions_immutable BEFORE UPDATE OR DELETE ON grimoire.intake_source_revisions
FOR EACH ROW EXECUTE FUNCTION grimoire.intake_deny_mutation();
CREATE TRIGGER intake_source_claims_immutable BEFORE UPDATE OR DELETE ON grimoire.intake_source_claims
FOR EACH ROW EXECUTE FUNCTION grimoire.intake_deny_mutation();
CREATE TRIGGER intake_source_revocations_immutable BEFORE UPDATE OR DELETE ON grimoire.intake_source_revocations
FOR EACH ROW EXECUTE FUNCTION grimoire.intake_deny_mutation();

-- Returns only audit metadata, including after revocation. Content and quote are
-- intentionally absent; the runtime cannot bypass content RLS with this helper.
CREATE FUNCTION app.intake_source_summaries(wanted_scion uuid)
RETURNS TABLE (id uuid,scion_id uuid,scion_revision integer,current_revision integer,title text,
 origin text,owner text,content_sha256 text,rights_status text,permitted_use text,
 permission_basis text,synthetic boolean,claim_count bigint,revocation_reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
 SELECT s.id,s.scion_id,s.scion_revision,s.current_revision,r.title,r.origin,r.owner,r.content_sha256,
   CASE WHEN v.source_id IS NULL THEN r.rights_status ELSE 'revoked' END,r.permitted_use,r.permission_basis,r.synthetic,
   (SELECT count(*) FROM grimoire.intake_source_claims c WHERE (c.org_id,c.source_id)=(s.org_id,s.id)),v.reason
 FROM grimoire.intake_sources s JOIN grimoire.intake_source_revisions r
   ON (r.org_id,r.source_id,r.number)=(s.org_id,s.id,s.current_revision)
 LEFT JOIN grimoire.intake_source_revocations v ON (v.org_id,v.source_id)=(s.org_id,s.id)
 WHERE s.scion_id=wanted_scion AND s.org_id=app.current_org_id() AND app.intake_can_access()
 ORDER BY s.created_at,s.id
$$;

ALTER TABLE grimoire.intake_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE grimoire.intake_source_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE grimoire.intake_source_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE grimoire.intake_source_revocations ENABLE ROW LEVEL SECURITY;
CREATE POLICY intake_source_read ON grimoire.intake_sources FOR SELECT TO grimoire_intake_app
USING (org_id=app.current_org_id() AND app.intake_can_access());
CREATE POLICY intake_source_create ON grimoire.intake_sources FOR INSERT TO grimoire_intake_app
WITH CHECK (org_id=app.current_org_id() AND created_by=app.current_principal_id() AND current_revision=0 AND app.intake_can_write());
CREATE POLICY intake_source_lock ON grimoire.intake_sources FOR UPDATE TO grimoire_intake_app
USING (org_id=app.current_org_id() AND app.intake_can_write()) WITH CHECK (org_id=app.current_org_id() AND app.intake_can_write());
CREATE POLICY intake_source_revision_read ON grimoire.intake_source_revisions FOR SELECT TO grimoire_intake_app
USING (org_id=app.current_org_id() AND app.intake_source_permitted(source_id));
CREATE POLICY intake_source_revision_create ON grimoire.intake_source_revisions FOR INSERT TO grimoire_intake_app
WITH CHECK (org_id=app.current_org_id() AND created_by=app.current_principal_id() AND app.intake_can_write() AND app.intake_source_permitted(source_id));
CREATE POLICY intake_source_claim_read ON grimoire.intake_source_claims FOR SELECT TO grimoire_intake_app
USING (org_id=app.current_org_id() AND app.intake_source_permitted(source_id));
CREATE POLICY intake_source_claim_create ON grimoire.intake_source_claims FOR INSERT TO grimoire_intake_app
WITH CHECK (org_id=app.current_org_id() AND created_by=app.current_principal_id() AND app.intake_can_write() AND app.intake_source_permitted(source_id));
CREATE POLICY intake_source_revocation_read ON grimoire.intake_source_revocations FOR SELECT TO grimoire_intake_app
USING (org_id=app.current_org_id() AND app.intake_can_access());
CREATE POLICY intake_source_revocation_create ON grimoire.intake_source_revocations FOR INSERT TO grimoire_intake_app
WITH CHECK (org_id=app.current_org_id() AND created_by=app.current_principal_id() AND app.intake_can_write());

REVOKE ALL ON grimoire.intake_sources,grimoire.intake_source_revisions,grimoire.intake_source_claims,grimoire.intake_source_revocations FROM PUBLIC;
REVOKE ALL ON FUNCTION app.intake_source_permitted(uuid),app.intake_source_summaries(uuid),app.intake_source_read_lock(uuid,uuid),
 grimoire.intake_guard_source(),grimoire.intake_guard_source_write(),grimoire.intake_after_source_revision(),
 grimoire.intake_require_initial_source_revision() FROM PUBLIC;
GRANT SELECT,INSERT ON grimoire.intake_sources,grimoire.intake_source_revisions,grimoire.intake_source_claims,grimoire.intake_source_revocations TO grimoire_intake_app;
-- The source pointer and pinned Scion identity are never directly writable.
GRANT UPDATE(updated_at) ON grimoire.intake_sources TO grimoire_intake_app;
GRANT EXECUTE ON FUNCTION app.intake_source_permitted(uuid),app.intake_source_summaries(uuid),app.intake_source_read_lock(uuid,uuid) TO grimoire_intake_app;
COMMIT;
