#!/bin/sh
# Exact attested migration set; no developer credentials or private fixture data.
set -eu
umask 077
[ "${PGDATABASE:-}" = grimoire_prod ] || { echo 'Refusing a database other than grimoire_prod.' >&2; exit 1; }
[ "${PGHOST:-}" = 127.0.0.1 ] || { echo 'Database must remain on loopback.' >&2; exit 1; }
: "${PGPASSWORD:?Administrative migration credential is required}"
repo=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM

# Derive ordering from the binary's attestation list, avoiding a second registry.
sed -n 's/^[[:space:]]*migration!("\([a-z0-9]*\)", "\([a-z0-9_]*\.sql\)"),[[:space:]]*$/\1\/\2/p' "$repo/api/src/attestation.rs" > "$work/migrations"
[ -s "$work/migrations" ] || { echo 'No attested migrations found.' >&2; exit 1; }
# Accepted GG-40 bytes are immutable, including line endings.
sed -n 's/^[[:space:]]*"\([^"]*\.sql\)": "\([a-f0-9]*\)"[,]\{0,1\}[[:space:]]*$/\2  \1/p' "$repo/db/gg40/checksums.json" > "$work/gg40.sha256"
[ -s "$work/gg40.sha256" ] || { echo 'Accepted SQL checksums are unavailable.' >&2; exit 1; }
(cd "$repo/db/gg40" && sha256sum -c "$work/gg40.sha256")

cat > "$work/apply.sql" <<'SQL'
SELECT pg_advisory_lock(19283746, 2);
SET ROLE grimoire_migrator;
CREATE TABLE IF NOT EXISTS public.grimoire_schema_migrations (
 name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TEMP TABLE expected_migrations(name text PRIMARY KEY, sha256 text NOT NULL);
SQL
while IFS= read -r relative; do
  file="$repo/db/$relative"
  name=${relative##*/}
  [ -f "$file" ] || { echo "Missing migration: $name" >&2; exit 1; }
  hash=$(sha256sum "$file" | cut -d ' ' -f 1)
  printf "INSERT INTO expected_migrations VALUES ('%s','%s');\n" "$name" "$hash" >> "$work/apply.sql"
done < "$work/migrations"
cat >> "$work/apply.sql" <<'SQL'
DO $$ BEGIN
 IF EXISTS (SELECT FROM public.grimoire_schema_migrations a LEFT JOIN expected_migrations e USING(name)
   WHERE e.name IS NULL OR a.sha256<>e.sha256) THEN
   RAISE EXCEPTION 'Applied migration is unknown or changed; refusing to overwrite history';
 END IF;
END $$;
SQL
while IFS= read -r relative; do
  file="$repo/db/$relative"
  name=${relative##*/}
  hash=$(sha256sum "$file" | cut -d ' ' -f 1)
  # Every accepted migration is one explicit transaction. Insert its ledger row
  # before COMMIT so interruption can never commit schema without its receipt.
  awk 'BEGIN {begins=0; commits=0} {sub(/\r$/, "")} /^BEGIN;$/ {begins++} /^COMMIT;$/ {commits++} END {if (begins!=1 || commits!=1) exit 1}' "$file" || {
    echo "Unsupported transaction framing in $name" >&2; exit 1;
  }
  printf '%s\n' "SELECT NOT EXISTS (SELECT FROM public.grimoire_schema_migrations WHERE name='$name') AS apply_migration \gset" '\if :apply_migration' "\echo Applying $name" >> "$work/apply.sql"
  awk -v name="$name" -v hash="$hash" '{line=$0; sub(/\r$/, "", line); if (line=="COMMIT;") printf "INSERT INTO public.grimoire_schema_migrations(name,sha256) VALUES (\047%s\047,\047%s\047);\n",name,hash; print}' "$file" >> "$work/apply.sql"
  printf '\\endif\n' >> "$work/apply.sql"
done < "$work/migrations"
cat >> "$work/apply.sql" <<'SQL'
SELECT pg_advisory_unlock(19283746, 2);
SQL
psql -X -v ON_ERROR_STOP=1 -f "$work/apply.sql"
echo 'Production migrations complete. No development identities or private data were imported.'
