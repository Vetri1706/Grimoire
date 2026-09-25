-- Additive local S3 storage references; preserves all semantic source revisions.
-- Earlier migrations 0022--0026 remain unchanged.
BEGIN;
SET search_path=pg_catalog,grimoire,pg_temp;

ALTER TABLE grimoire.intake_source_revisions ALTER COLUMN source_text DROP NOT NULL;
ALTER TABLE grimoire.intake_source_revisions ADD CONSTRAINT intake_source_content_identity
 UNIQUE (org_id,source_id,number,content_sha256,byte_length);

CREATE TABLE grimoire.intake_source_objects (
 org_id uuid NOT NULL,
 source_id uuid NOT NULL,
 source_revision integer NOT NULL,
 storage_backend text NOT NULL DEFAULT 's3' CHECK (storage_backend='s3'),
 object_bucket text NOT NULL CHECK (object_bucket ~ '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$'),
 object_key text NOT NULL CHECK (length(object_key) BETWEEN 1 AND 1024 AND object_key NOT LIKE '/%' AND object_key NOT LIKE '%..%'),
 object_version_id text NOT NULL CHECK (length(object_version_id) BETWEEN 1 AND 1024 AND object_version_id<>'null'),
 content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
 byte_length integer NOT NULL CHECK (byte_length BETWEEN 1 AND 32000),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 recorded_by uuid NOT NULL,
 PRIMARY KEY (org_id,source_id,source_revision),
 UNIQUE (object_bucket,object_key,object_version_id),
 FOREIGN KEY (org_id,source_id,source_revision,content_sha256,byte_length)
   REFERENCES grimoire.intake_source_revisions(org_id,source_id,number,content_sha256,byte_length)
   DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY (org_id,recorded_by) REFERENCES grimoire.principals(org_id,id)
);
COMMENT ON TABLE grimoire.intake_source_objects IS 'Immutable private S3 object identity. Exact version must be fetched and checked against source SHA-256 and length before source or claim content is returned. No public URLs.';

CREATE FUNCTION grimoire.intake_guard_source_object() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,grimoire,pg_temp AS $$
BEGIN
 IF NEW.object_key NOT LIKE 'org/'||NEW.org_id::text||'/sources/'||NEW.source_id::text||'/revisions/'||NEW.source_revision::text||'/%' THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='object key must match organization/source/revision';
 END IF;
 IF current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='grimoire.intake_source_objects'::regclass)) THEN
   RETURN NEW; -- administrator-only verified legacy export
 END IF;
 IF NEW.org_id IS DISTINCT FROM app.current_org_id() OR NEW.recorded_by IS DISTINCT FROM app.current_principal_id()
    OR NOT app.intake_can_write() THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='source object write is not authorized';
 END IF;
 PERFORM 1 FROM grimoire.intake_sources WHERE (org_id,id)=(NEW.org_id,NEW.source_id) FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='source object owner unavailable'; END IF;
 IF NOT app.intake_source_permitted(NEW.source_id) THEN
   RAISE EXCEPTION USING ERRCODE='G2601',MESSAGE='source permission has been revoked';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER intake_source_object_guard BEFORE INSERT ON grimoire.intake_source_objects
FOR EACH ROW EXECUTE FUNCTION grimoire.intake_guard_source_object();
CREATE TRIGGER intake_source_objects_immutable BEFORE UPDATE OR DELETE ON grimoire.intake_source_objects
FOR EACH ROW EXECUTE FUNCTION grimoire.intake_deny_mutation();

-- One narrowly constrained administrator transition may remove the active inline
-- copy after an immutable matching object reference has been recorded. Every
-- semantic column and all author/time/history identity remain byte-for-byte equal.
CREATE FUNCTION grimoire.intake_source_revision_storage_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,grimoire,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE'
   AND current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='grimoire.intake_source_revisions'::regclass))
   AND OLD.source_text IS NOT NULL AND NEW.source_text IS NULL
   AND (to_jsonb(OLD)-'source_text')=(to_jsonb(NEW)-'source_text')
   AND EXISTS(SELECT 1 FROM grimoire.intake_source_objects o
      WHERE (o.org_id,o.source_id,o.source_revision,o.content_sha256,o.byte_length)=
            (OLD.org_id,OLD.source_id,OLD.number,OLD.content_sha256,OLD.byte_length)) THEN
   RETURN NEW;
 END IF;
 RAISE EXCEPTION USING ERRCODE='G2401',MESSAGE='source history is immutable';
END $$;
DROP TRIGGER intake_source_revisions_immutable ON grimoire.intake_source_revisions;
CREATE TRIGGER intake_source_revisions_immutable BEFORE UPDATE OR DELETE ON grimoire.intake_source_revisions
FOR EACH ROW EXECUTE FUNCTION grimoire.intake_source_revision_storage_guard();

CREATE OR REPLACE FUNCTION grimoire.intake_guard_source_write() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,grimoire,pg_temp AS $$
DECLARE current_number integer; source_length integer;
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
   IF NEW.source_text IS NOT NULL OR NOT EXISTS(SELECT 1 FROM grimoire.intake_source_objects o
      WHERE (o.org_id,o.source_id,o.source_revision,o.content_sha256,o.byte_length)=
            (NEW.org_id,NEW.source_id,NEW.number,NEW.content_sha256,NEW.byte_length)) THEN
     RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='new source revision requires an exact immutable S3 object reference and no inline text';
   END IF;
 ELSIF TG_TABLE_NAME='intake_source_revocations' THEN
   IF NEW.source_revision<>current_number THEN
     RAISE EXCEPTION USING ERRCODE='G2402',MESSAGE='revocation must reference the current revision';
   END IF;
 ELSE
   SELECT byte_length INTO STRICT source_length FROM grimoire.intake_source_revisions
     WHERE (org_id,source_id,number)=(NEW.org_id,NEW.source_id,NEW.source_revision);
   IF NEW.start_byte<0 OR NEW.end_byte<=NEW.start_byte OR NEW.end_byte>source_length
      OR octet_length(NEW.quote)<>NEW.end_byte-NEW.start_byte THEN
     RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='claim locator must have valid UTF-8 byte bounds';
   END IF;
   -- Exact quote matching now requires a verified version-specific object read
   -- in the Rust API. PostgreSQL deliberately has no source-text fallback.
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION app.intake_externalize_source_revision(wanted_org uuid,wanted_source uuid,wanted_revision integer,
 wanted_bucket text,wanted_key text,wanted_version text,wanted_hash text,wanted_bytes integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,grimoire,pg_temp SET row_security=off AS $$
DECLARE r grimoire.intake_source_revisions%ROWTYPE;
BEGIN
 PERFORM 1 FROM grimoire.intake_sources WHERE (org_id,id)=(wanted_org,wanted_source) FOR UPDATE;
 SELECT * INTO STRICT r FROM grimoire.intake_source_revisions WHERE (org_id,source_id,number)=(wanted_org,wanted_source,wanted_revision);
 IF r.source_text IS NULL THEN RETURN false; END IF;
 IF r.content_sha256<>wanted_hash OR r.byte_length<>wanted_bytes
   OR encode(public.digest(convert_to(r.source_text,'UTF8'),'sha256'),'hex')<>wanted_hash
   OR octet_length(r.source_text)<>wanted_bytes THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='legacy source bytes do not match immutable identity';
 END IF;
 INSERT INTO grimoire.intake_source_objects(org_id,source_id,source_revision,object_bucket,object_key,object_version_id,content_sha256,byte_length,recorded_by)
 VALUES(wanted_org,wanted_source,wanted_revision,wanted_bucket,wanted_key,wanted_version,wanted_hash,wanted_bytes,r.created_by);
 UPDATE grimoire.intake_source_revisions SET source_text=NULL WHERE (org_id,source_id,number)=(wanted_org,wanted_source,wanted_revision);
 RETURN true;
END $$;

ALTER TABLE grimoire.intake_source_objects ENABLE ROW LEVEL SECURITY;
CREATE POLICY intake_source_object_read ON grimoire.intake_source_objects FOR SELECT TO grimoire_intake_app
USING (org_id=app.current_org_id() AND app.intake_source_permitted(source_id));
CREATE POLICY intake_source_object_create ON grimoire.intake_source_objects FOR INSERT TO grimoire_intake_app
WITH CHECK (org_id=app.current_org_id() AND recorded_by=app.current_principal_id() AND app.intake_can_write() AND app.intake_source_permitted(source_id));
REVOKE ALL ON grimoire.intake_source_objects FROM PUBLIC;
GRANT SELECT,INSERT ON grimoire.intake_source_objects TO grimoire_intake_app;
REVOKE ALL ON FUNCTION grimoire.intake_guard_source_object(),grimoire.intake_source_revision_storage_guard(),
 app.intake_externalize_source_revision(uuid,uuid,integer,text,text,text,text,integer) FROM PUBLIC;
-- Deliberately no externalization execution grant to the HTTP runtime. Run the
-- one-off administrator command only after exact upload/download verification.
COMMIT;
