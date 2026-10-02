#!/usr/bin/env bash
# Private logical backup. Pair with a bounded Lightsail snapshot to retain object versions.
set -euo pipefail
umask 077
cd "$(dirname "$0")"
mkdir -p backups
chmod 700 backups
stamp=$(date -u +%Y%m%dT%H%M%SZ)
target="backups/grimoire-prod-$stamp.dump"
trap 'rm -f "$target.partial"' EXIT
docker compose --env-file .env -f compose.yaml exec -T db sh -ec \
  'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h 127.0.0.1 -p 55432 -U postgres -d grimoire_prod -Fc' > "$target.partial"
[[ -s "$target.partial" ]] || { echo 'Empty backup refused.' >&2; exit 1; }
mv "$target.partial" "$target"
echo "Created $target. Take one Lightsail snapshot after this completes; retain the pinned object volume with the database."
echo 'Backups are private and not automatically deleted. Remove superseded copies deliberately to bound disk and snapshot costs.'
