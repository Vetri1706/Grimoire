#!/bin/sh
set -eu
# Compose represents the absent optional setting as empty; the API deliberately
# rejects an explicitly configured empty OAuth client ID.
if [ -z "${GRIMOIRE_GOOGLE_CLIENT_ID:-}" ]; then
  unset GRIMOIRE_GOOGLE_CLIENT_ID
fi
exec /usr/local/bin/grimoire-api "$@"
