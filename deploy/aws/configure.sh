#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")"
[[ $# == 2 || $# == 3 ]] || { echo 'Usage: bash deploy/aws/configure.sh app.example.com operator@example.com [small]' >&2; exit 1; }
profile=${3:-standard}
[[ $profile == standard || $profile == small ]] || { echo 'The optional memory profile is small (1 GB) or standard (2 GB).' >&2; exit 1; }
[[ ! -e .env ]] || { echo 'Existing .env preserved. Edit it deliberately; credentials were not rotated.' >&2; exit 1; }
[[ $1 =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$ && $1 != *..* ]] || { echo 'Use a DNS hostname, without protocol/path.' >&2; exit 1; }
[[ $2 =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || { echo 'A certificate contact email is required.' >&2; exit 1; }
command -v openssl >/dev/null
cat > .env <<EOF
DOMAIN=$1
ACME_EMAIL=$2
AWS_MEMORY_PROFILE=$profile
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
if [[ $profile == small ]]; then
  cat >> .env <<'EOF'
# Opt-in 1-GB judging profile. Requires bootstrap.sh small and measured smoke checks.
GRIMOIRE_PG_SHARED_BUFFERS=32MB
GRIMOIRE_PG_MAX_CONNECTIONS=24
GRIMOIRE_PG_WORK_MEM=1MB
GRIMOIRE_PG_MAINTENANCE_WORK_MEM=32MB
GRIMOIRE_PG_AUTOVACUUM_WORK_MEM=16MB
GRIMOIRE_PG_PARALLEL_WORKERS=0
GRIMOIRE_DB_MEMORY=224m
GRIMOIRE_DB_MEMORY_SWAP=448m
GRIMOIRE_STORAGE_MEMORY=320m
GRIMOIRE_STORAGE_MEMORY_SWAP=768m
GRIMOIRE_STORAGE_GOMEMLIMIT=192MiB
GRIMOIRE_API_MEMORY=160m
GRIMOIRE_API_MEMORY_SWAP=320m
GRIMOIRE_WEB_MEMORY=48m
GRIMOIRE_WEB_MEMORY_SWAP=64m
GRIMOIRE_HTTPS_MEMORY=64m
GRIMOIRE_HTTPS_MEMORY_SWAP=128m
GRIMOIRE_HTTPS_GOMEMLIMIT=32MiB
EOF
fi
chmod 600 .env
echo 'Generated deploy/aws/.env with fresh deployment-only credentials. Keep it private.'
if [[ $profile == small ]]; then
  echo 'Small profile selected: 816 MiB combined long-running container RAM limits. Run bootstrap.sh small and verify memory under load before sharing.'
fi
