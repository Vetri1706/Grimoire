#!/bin/sh
# Run in the postgres:17 migration container on the dedicated deployment host.
set -eu
umask 077

: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
: "${INTAKE_DB_PASSWORD:?INTAKE_DB_PASSWORD is required}"
for secret in "$POSTGRES_PASSWORD" "$INTAKE_DB_PASSWORD"; do
  case "$secret" in *[!0-9a-f]*|'') echo 'Database passwords must be generated 64-character lowercase hex.' >&2; exit 1;; esac
  [ "${#secret}" -eq 64 ] || { echo 'Invalid generated database password length.' >&2; exit 1; }
done
[ "${PGDATABASE:-grimoire_prod}" = grimoire_prod ] || { echo 'Only the dedicated grimoire_prod database is supported.' >&2; exit 1; }
[ "${PGHOST:-127.0.0.1}" = 127.0.0.1 ] || { echo 'Database must remain on loopback.' >&2; exit 1; }
export PGHOST=127.0.0.1 PGPORT="${PGPORT:-55432}" PGUSER=postgres PGDATABASE=postgres
export PGPASSWORD="$POSTGRES_PASSWORD" PGCLIENTENCODING=UTF8

psql -X -v ON_ERROR_STOP=1 <<'SQL'
SELECT pg_advisory_lock(19283746, 1);
DO $$ BEGIN
 IF current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999 THEN
   RAISE EXCEPTION 'Grimoire requires PostgreSQL 17';
 END IF;
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='grimoire_migrator') THEN
   CREATE ROLE grimoire_migrator NOLOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
 END IF;
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='grimoire_app') THEN
   CREATE ROLE grimoire_app NOLOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOINHERIT NOBYPASSRLS;
 END IF;
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='grimoire_worker') THEN
   CREATE ROLE grimoire_worker NOLOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOINHERIT NOBYPASSRLS;
 END IF;
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='grimoire_intake_app') THEN
   CREATE ROLE grimoire_intake_app LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOINHERIT NOBYPASSRLS;
 END IF;
 IF EXISTS (SELECT FROM pg_roles WHERE rolname IN ('grimoire_migrator','grimoire_app','grimoire_worker','grimoire_intake_app')
   AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls OR rolreplication))
   OR EXISTS (SELECT FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='grimoire_intake_app')) THEN
   RAISE EXCEPTION 'Unsafe pre-existing Grimoire role privileges or runtime memberships';
 END IF;
END $$;
-- Read the password from the environment; never place it in process arguments.
\getenv intake_password INTAKE_DB_PASSWORD
ALTER ROLE grimoire_intake_app PASSWORD :'intake_password';
SELECT 'CREATE DATABASE grimoire_prod OWNER grimoire_migrator TEMPLATE template0 ENCODING ''UTF8'' LC_COLLATE ''C'' LC_CTYPE ''C'''
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='grimoire_prod') \gexec
DO $$ BEGIN
 IF (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='grimoire_prod') <> 'grimoire_migrator' THEN
   RAISE EXCEPTION 'Existing grimoire_prod has an unexpected owner';
 END IF;
END $$;
REVOKE ALL ON DATABASE grimoire_prod FROM PUBLIC;
GRANT CONNECT ON DATABASE grimoire_prod TO grimoire_intake_app;
SELECT pg_advisory_unlock(19283746, 1);
SQL

export PGDATABASE=grimoire_prod
exec sh "$(dirname "$0")/migrate.sh"
