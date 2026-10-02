# Grimoire: AWS judging deployment, USD 10–15/month target

Use one **Lightsail Linux IPv4 2 GB / 2 vCPU / 60 GB instance: USD 12/month**. Keep React's compiled files, Rust API, PostgreSQL 17 and private versioned object storage on that host. Codex stays on the operator's computer and connects over HTTPS. This is a small judging deployment with one failure domain, not a highly available production service. Two-GB capacity has not been load-tested.

No AWS resources are created by these files or by the verification performed so far.

## Cost and limits

| Item | Monthly estimate |
|---|---:|
| Lightsail 2 GB IPv4 bundle | $12.00 |
| One small snapshot, 10–20 GB stored | $0.50–1.00 |
| Existing domain, DNS and ACME TLS | $0 additional hosting cost |
| Expected infrastructure subtotal | **$12.50–13.00** |

Allow **$13–15 before applicable tax**. A new domain, transfer overages and model/provider usage are additional. Credits are not a reason to increase the server size, and their service eligibility/expiry must be checked in Billing. AWS promotional credits normally exclude domain registration. If $15 must include tax, check the account's tax treatment before applying the plan. Do not purchase a domain or add a paid service silently.

This setup has no managed database, load balancer, NAT gateway, paid container registry, or cloud-hosted model. Compile all images off the 2 GB instance. Keep one small current snapshot, inspect its billed size, and deliberately remove superseded snapshots after verifying recovery. PostgreSQL dumps alone do not back up pinned object versions: retain the storage volume in the same instance snapshot.

`budget.json` alerts at a $15 **account-wide** monthly budget, including tax and excluding credits/refunds so credits do not hide spending. `budget-notifications.example.json` contains placeholder email recipients: replace privately before applying. Alerts do not enforce a spending cap. Existing unrelated AWS usage also counts.

Sources checked 2026-10-02: [AWS Lightsail pricing](https://aws.amazon.com/lightsail/pricing/), [snapshot and billing FAQ](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-frequently-asked-questions-faq-billing-and-account-management.html), [credit terms](https://aws.amazon.com/awscredits/). Mumbai has a smaller included transfer allowance than the headline pricing. The provisioner queries the selected region's current bundle before creating anything.

## Network and authority

```text
Browser / local enrolled Codex worker
                 │ HTTPS :443
              Caddy (TLS)
                 │ loopback :8088
        nginx (static UI, rate limits)
                 │ loopback :8080
           existing Rust API
              /          \
 PostgreSQL17 :55432    versioned MinIO :19000
     loopback               loopback
```

Only 80/443 are public; SSH 22 is restricted to one operator IPv4 `/32`. API, PostgreSQL and storage retain their existing loopback checks. Linux host networking is intentional. Do not replace it with public database/API ports or remove startup attestation. `/api/health` and `/api/setup/owner` return 404 at the public proxy; diagnostics and first-owner setup run on the host. Login/signup/Google sign-in share a 5/minute per-IP limit with a small burst. Other API traffic has a separate 20/second limit, allowing worker polling. Caddy supplies the trusted client IP; don't place another proxy in front without reviewing that trust configuration.

Fresh deployment generates separate credentials and a `grimoire_prod` database. It does not upload your local `.env`, personal Codex session, source documents, development database, or seeded developer bearer accounts. The API has its existing non-owner, non-superuser database role and a storage account that cannot delete objects or change bucket permissions. Migration files and compiled catalog checks remain authoritative.

## 1. Review the host plan

The locally configured AWS profile is `default` in `us-east-1`; confirm that is the intended account/region. Use an existing regional Lightsail SSH key whose private key you hold. The operator IP below is an example, not a deployable value.

```powershell
.\deploy\aws\lightsail.ps1 -Profile default -Region us-east-1 `
  -SshCidr YOUR_PUBLIC_IP/32 -KeyPairName YOUR_EXISTING_KEY
```

This is read-only. It discovers the Ubuntu 24.04 image and 2 GB IPv4 bundle, rejects a bundle above **$12/month**, and checks for existing resource names. It creates no key and downloads no private key.

After confirming the exact account, region, price and key, repeat with `-ExpectedAccountId YOUR_12_DIGIT_ACCOUNT -Apply`. `-WhatIf` previews the mutation. The script creates only a new host/static IP/firewall; it does not replace resources or install the app. If creation is interrupted, inspect the named resources before retrying: resources left behind can bill.

Create a DNS A record for an **existing hostname you control** pointing to the returned static IPv4. For judging without a purchased domain, use `grimoire-STATIC-IP-WITH-DASHES.sslip.io`; this free DNS service resolves the embedded address automatically. Verify it resolves to the allocated address before startup. Caddy obtains HTTPS certificates once DNS and ports 80/443 work. No paid domain purchase is included. The free hostname depends on [sslip.io's shared DNS service](https://nip.io/) and should be replaced with an owned hostname for long-term use.

Budget setup is optional until the account and private alert recipient are confirmed:

```powershell
aws budgets create-budget --profile default --region us-east-1 --account-id YOUR_ACCOUNT `
  --budget file://deploy/aws/budget.json `
  --notifications-with-subscribers file://YOUR_PRIVATE_NOTIFICATIONS.json
```

## 2. Build outside the small AWS instance

The manually triggered `.github/workflows/aws-images.yml` builds Linux amd64 images; its `publish` input defaults to false. Select `publish: true` explicitly to publish checked SHA-tagged packages to GHCR. It runs only when explicitly dispatched; creating this file does not build or deploy anything. Use one successful run's exact commit for **all five images** and for the host checkout: `ghcr.io/vetri1706/grimoire-{api,web,ops,storage,mc}:sha-FULL_COMMIT_SHA`. Confirm the packages are publicly pullable (the application repo is public), or authenticate the host using a narrowly scoped read-only package credential. Never publish an image containing `.env` or user data.

Alternatively, on a sufficiently provisioned Linux Docker build machine:

```bash
npm --prefix web ci
npm --prefix web run build
docker build -f deploy/aws/Dockerfile.api -t grimoire-api:local .
docker build -f deploy/aws/Dockerfile.web -t grimoire-web:local .
docker build -f deploy/aws/Dockerfile.ops -t grimoire-ops:local .
docker build -f deploy/aws/Dockerfile.storage -t grimoire-storage:local .
docker build -f deploy/aws/Dockerfile.mc -t grimoire-mc:local .
docker pull postgres:17-bookworm
docker pull caddy:2.10.2-alpine
docker save grimoire-api:local grimoire-web:local grimoire-ops:local grimoire-storage:local grimoire-mc:local postgres:17-bookworm caddy:2.10.2-alpine | gzip > grimoire-images.tar.gz
```

Copy this release archive privately to the host and run `docker load < grimoire-images.tar.gz`. Do not build Rust/Go on the 2 GB host.

Upstream MinIO's old Docker Hub/Quay images were unavailable during verification. The storage Dockerfiles build pinned upstream source instead, including the October 2025 security release and licensing files. [Upstream build instructions](https://github.com/minio/minio/releases/tag/RELEASE.2025-10-15T17-29-55Z). The community repository is archived; this preserves the current bounded judging stack, not a long-term storage maintenance strategy. A future AWS S3 adapter requires an explicit supported cloud-storage path and tests; the current app intentionally accepts only local object storage.

## 3. Start a fresh deployment

SSH as `ubuntu`, clone this repository at the exact tested release SHA, and use Docker via `sudo` (or a deliberately configured operator Docker group). Run:

```bash
sudo bash deploy/aws/bootstrap.sh
sudo bash deploy/aws/configure.sh app.YOUR_DOMAIN operator@YOUR_DOMAIN
```

If using GHCR, edit the root-only `deploy/aws/.env` image fields to the five exact image tags from the successful workflow. Pull them before startup:

```bash
sudo docker compose --env-file deploy/aws/.env -f deploy/aws/compose.yaml --profile tools pull
sudo bash deploy/aws/up.sh
sudo python3 deploy/aws/setup-owner.py
sudo docker compose --env-file deploy/aws/.env -f deploy/aws/compose.yaml run --rm seed-demo
```

`up.sh` creates private storage/database services, runs idempotent migrations, configures a private versioned bucket, then starts the API. It checks API startup before starting public ingress on first deployment. Existing deployments should be backed up and maintained deliberately; this is not a zero-downtime rolling updater. An attestation failure must be diagnosed, never bypassed or “fixed” by regenerating the trusted catalog.

The owner script prompts privately for a new passphrase and does not print session cookies. Use normal HTTPS sign-in afterward. The `/demo` seed creates only explicit synthetic judging cases. It does not execute a model and it never imports private development records. Seed credentials are temporary and revoked by the existing seeder.

For real agent work on the operator's own computer:

```powershell
node byoa/connect.mjs --api https://app.YOUR_DOMAIN --watch
```

Approve the normal organization pairing in the app. Your computer and worker must stay online for real tasks. The public synthetic `/demo` remains inspectable without your computer. Existing Codex/model subscription or provider costs are separate from the AWS hosting estimate.

## 4. Verify before sharing with judges

- A fresh signed-out browser can open `https://HOST/demo`; cases are labeled synthetic.
- Login/signup work with Secure, HttpOnly, SameSite cookies; Google sign-in remains optional.
- `/api/health` and `/api/setup/owner` return public 404, private account routes return 401 without a session.
- Repeated invalid sign-in requests receive 429; another IP cannot spoof `X-Forwarded-For` through Caddy.
- No DB/storage/API port is reachable from the internet; only HTTPS, HTTP redirect, and restricted SSH.
- A separate organization cannot read the first organization's task; revoked evidence disappears from replies/artifacts.
- A real paired worker completes one intended task if live execution is part of the judging demo.
- Desktop/mobile layouts, refresh, logout and network failures work on the actual HTTPS URL.

Locally verified: production nginx image build; isolated proxy tests for SPA routes, blocked diagnostics/setup/dotfiles and authentication throttling; Caddy configuration validation without certificate issuance; deployment scripts/Compose validation; provisioner no-write/price/account/firewall tests; fresh and repeated **Linux PostgreSQL 17** migrations; exact catalog attestation using the existing Windows API against that Linux database; changed migration history rejected. The isolated proxy test had no API backend and confirms proxy behavior only. This is **not** a completed Linux API/storage image build, AWS deployment, end-to-end HTTPS check, or 2 GB load test. The release workflow and hosted checks above still need to pass before submission.

## Backups and end of judging

Run `sudo bash deploy/aws/backup.sh` before a release or snapshot. Keep the private logical dump with an instance snapshot containing the object volume. Verify restoration on an isolated host before trusting a backup. Do not leave daily snapshots accumulating: snapshot billing is incremental but grows with changed data and retained copies.

Set a calendar reminder for the actual end of judging. After judges are finished: export the necessary private backups, delete the named Lightsail instance, release its static IP, and delete snapshots no longer needed. **Stopping an instance does not stop Lightsail billing.** The provisioner deliberately contains no automatic destructive teardown. No teardown date has been supplied, so nothing is scheduled.
