#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
[[ $(uname -s) == Linux ]] || { echo 'Run on the dedicated Linux deployment host.' >&2; exit 1; }
[[ -f .env ]] || { echo 'Run configure.sh first.' >&2; exit 1; }
dc=(docker compose --env-file .env -f compose.yaml)
# Images must already be built off-host or loaded from a verified release.
images=$("${dc[@]}" --profile tools config --images)
while IFS= read -r image; do
  docker image inspect "$image" >/dev/null 2>&1 || {
    echo "Missing release image: $image. Pull all images with --profile tools or load the release archive first." >&2
    exit 1
  }
done <<< "$images"
"${dc[@]}" up -d --no-build --wait db storage
"${dc[@]}" run --rm --no-deps migrate
"${dc[@]}" run --rm --no-deps storage-init
"${dc[@]}" up -d --no-build api
ready=false
for _ in {1..30}; do
  if curl -fsS http://127.0.0.1:8080/api/health >/dev/null; then ready=true; break; fi
  sleep 2
done
$ready || { echo 'API startup/attestation failed; public ingress has not been started.' >&2; exit 1; }
"${dc[@]}" up -d --no-build web https
echo 'Services started. Verify HTTPS, private routes, sign-in and /demo before sharing the URL.'
