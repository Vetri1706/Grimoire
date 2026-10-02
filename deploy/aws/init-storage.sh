#!/bin/sh
# One-shot MinIO administration. The API receives only the limited runtime user.
set -eu
umask 077
: "${MINIO_ROOT_USER:?MINIO_ROOT_USER is required}"
: "${MINIO_ROOT_PASSWORD:?MINIO_ROOT_PASSWORD is required}"
: "${GRIMOIRE_S3_ACCESS_KEY:?GRIMOIRE_S3_ACCESS_KEY is required}"
: "${GRIMOIRE_S3_SECRET_KEY:?GRIMOIRE_S3_SECRET_KEY is required}"
for key in "$MINIO_ROOT_USER" "$GRIMOIRE_S3_ACCESS_KEY"; do
  case "$key" in *[!a-zA-Z0-9_-]*|'') echo 'Invalid storage account name.' >&2; exit 1;; esac
done
[ "$MINIO_ROOT_USER" != "$GRIMOIRE_S3_ACCESS_KEY" ] || { echo 'Root and runtime storage identities must differ.' >&2; exit 1; }
for secret in "$MINIO_ROOT_PASSWORD" "$GRIMOIRE_S3_SECRET_KEY"; do
  case "$secret" in *[!0-9a-f]*|'') echo 'Storage secrets must be generated lowercase hex.' >&2; exit 1;; esac
  [ "${#secret}" -eq 64 ] || { echo 'Invalid generated storage secret length.' >&2; exit 1; }
done
[ "${GRIMOIRE_S3_BUCKET:-grimoire-sources-prod}" = grimoire-sources-prod ] || { echo 'Only the dedicated production bucket is supported.' >&2; exit 1; }
export MC_HOST_grimoire="http://${MINIO_ROOT_USER}:${MINIO_ROOT_PASSWORD}@127.0.0.1:19000"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
export MC_CONFIG_DIR="$work/config"
# mc ready retries internally forever; bound the whole process, not an outer loop.
if ! timeout --kill-after=3s 35s mc ready grimoire >/dev/null 2>&1; then
  echo 'Private object storage did not become ready within 35 seconds.' >&2
  exit 1
fi
mc mb --ignore-existing grimoire/grimoire-sources-prod >/dev/null
mc version enable grimoire/grimoire-sources-prod >/dev/null
mc anonymous set none grimoire/grimoire-sources-prod >/dev/null
cat > "$work/runtime-policy.json" <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [
    {"Effect":"Allow","Action":["s3:GetBucketLocation","s3:GetBucketVersioning"],"Resource":["arn:aws:s3:::grimoire-sources-prod"]},
    {"Effect":"Allow","Action":["s3:GetObject","s3:GetObjectVersion","s3:PutObject"],"Resource":["arn:aws:s3:::grimoire-sources-prod/*"]},
    {"Effect":"Deny","Action":["s3:DeleteObject","s3:DeleteObjectVersion","s3:PutBucketPolicy","s3:PutBucketVersioning"],"Resource":["arn:aws:s3:::grimoire-sources-prod","arn:aws:s3:::grimoire-sources-prod/*"]}
  ]
}
JSON
mc admin policy create grimoire grimoire-production-api "$work/runtime-policy.json" >/dev/null
# The pinned mc supports two newline-delimited keys on stdin. Keep credentials
# out of process arguments (and command-argument error traces).
printf '%s\n%s\n' "$GRIMOIRE_S3_ACCESS_KEY" "$GRIMOIRE_S3_SECRET_KEY" | mc admin user add grimoire >/dev/null
mc admin policy attach grimoire grimoire-production-api --user "$GRIMOIRE_S3_ACCESS_KEY" >/dev/null
echo 'Private versioned production storage ready; the API cannot delete objects or change bucket access.'
