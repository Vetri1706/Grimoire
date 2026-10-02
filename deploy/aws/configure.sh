#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")"
[[ $# == 2 ]] || { echo 'Usage: bash deploy/aws/configure.sh app.example.com operator@example.com' >&2; exit 1; }
[[ ! -e .env ]] || { echo 'Existing .env preserved. Edit it deliberately; credentials were not rotated.' >&2; exit 1; }
[[ $1 =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$ && $1 != *..* ]] || { echo 'Use a DNS hostname, without protocol/path.' >&2; exit 1; }
[[ $2 =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || { echo 'A certificate contact email is required.' >&2; exit 1; }
command -v openssl >/dev/null
cat > .env <<EOF
DOMAIN=$1
ACME_EMAIL=$2
POSTGRES_PASSWORD=$(openssl rand -hex 32)
INTAKE_DB_PASSWORD=$(openssl rand -hex 32)
MINIO_ROOT_USER=grimoire-storage-admin
MINIO_ROOT_PASSWORD=$(openssl rand -hex 32)
GRIMOIRE_S3_ACCESS_KEY=grimoire-production-api
GRIMOIRE_S3_SECRET_KEY=$(openssl rand -hex 32)
GRIMOIRE_S3_BUCKET=grimoire-sources-prod
PGPORT=55432
API_IMAGE=grimoire-api:local
WEB_IMAGE=grimoire-web:local
OPS_IMAGE=grimoire-ops:local
STORAGE_IMAGE=grimoire-storage:local
MC_IMAGE=grimoire-mc:local
GRIMOIRE_GOOGLE_CLIENT_ID=
EOF
chmod 600 .env
echo 'Generated deploy/aws/.env with fresh deployment-only credentials. Keep it private.'
