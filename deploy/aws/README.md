# Grimoire: AWS judging deployment, USD 10–15/month target

The judging deployment is live at **[Grimoire](https://grimoire-52-71-93-70.sslip.io)**, with a public **[synthetic judge demo](https://grimoire-52-71-93-70.sslip.io/demo)**. It uses an explicitly approved **Lightsail Linux IPv4 1 GB / 2 vCPU / 40 GB instance: USD 7/month**, with the `small` memory profile and a **2 GiB swap file on its included disk**. React's compiled files, Rust API, PostgreSQL 17 and private versioned object storage run on that host. A real Codex worker must run on the operator's computer and connect over HTTPS; no real worker or model task was run during deployment verification.

HTTPS, password sign-in, the three public demo cases and a bounded host-local capacity check passed on 2026-10-02. The instance runs in `us-east-1`. Its initial five application images came from **`899a9fbcc8ca753f07349940a0f70f14788da607`**; the API and web now run the **SerpApi / connector 0.1.2 release**, deployed on 2026-10-04. See [initial deployment evidence](../../docs/evidence/aws-judging-20261002.json), [connector 0.1.1 evidence](../../docs/evidence/aws-connector-20261002.json), [SerpApi release evidence](../../docs/evidence/aws-serpapi-20261004.json), and the verification scope below. This is a single-host judging deployment, not a high-availability service. The original 2 GB / 60 GB / USD 12 profile remains the scripts' default, but the account blocked that instance size during provisioning. Selecting `small` is explicit; the scripts do not silently downgrade a host.

## Cost and limits

| Item | Monthly estimate |
|---|---:|
| Lightsail 1 GB IPv4 bundle, selected `small` profile | $7.00 |
| 2 GiB swap within the included 40 GB disk | $0 additional storage charge |
| One small snapshot, 10–20 GB stored | $0.50–1.00 |
| Shared sslip.io hostname, DNS and ACME TLS | $0 additional hosting cost |
| Expected infrastructure subtotal | **$7.50–8.00** |

Keep total spending within the user's **USD 10–15/month ceiling**, allowing room for applicable tax and small backups. A new domain, transfer overages and model/provider usage are additional. Credits are not a reason to increase the server size, and their service eligibility/expiry must be checked in Billing. AWS promotional credits normally exclude domain registration. Check actual account tax and usage before promising a total bill. Do not purchase a domain or add a paid service silently.

This setup has no managed database, load balancer, NAT gateway, paid container registry, or cloud-hosted model. Compile all images off the deployment instance. Swap is a pressure buffer, not additional RAM or proof of adequate performance. Keep one small current snapshot, inspect its billed size, and deliberately remove superseded snapshots after verifying recovery. PostgreSQL dumps alone do not back up pinned object versions: retain the storage volume in the same instance snapshot.

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
  -SshCidr YOUR_PUBLIC_IP/32 -KeyPairName YOUR_EXISTING_KEY `
  -MemoryGb 1 -MaxBundleMonthlyUsd 7
```

This explicit small-host plan is read-only. It discovers the Ubuntu 24.04 image and 1 GB IPv4 bundle, rejects a bundle above **$7/month**, and checks for existing resource names. Without those two flags the defaults remain 2 GB and a $12 ceiling. It creates no key and downloads no private key. The judging instance already exists: inspect it rather than rerunning this create-only provisioner against the same name.

After confirming the exact account, region, price and key, repeat with `-ExpectedAccountId YOUR_12_DIGIT_ACCOUNT -Apply`. `-WhatIf` previews the mutation. The script creates only a new host/static IP/firewall; it does not replace resources or install the app. If creation is interrupted, inspect the named resources before retrying: resources left behind can bill.

Create a DNS A record for an **existing hostname you control** pointing to the returned static IPv4. For judging without a purchased domain, use `grimoire-STATIC-IP-WITH-DASHES.sslip.io`; this free DNS service resolves the embedded address automatically. Verify it resolves to the allocated address before startup. Caddy obtains HTTPS certificates once DNS and ports 80/443 work. No paid domain purchase is included. The free hostname depends on [sslip.io's shared DNS service](https://nip.io/) and should be replaced with an owned hostname for long-term use.

Budget setup is optional until the account and private alert recipient are confirmed:

```powershell
aws budgets create-budget --profile default --region us-east-1 --account-id YOUR_ACCOUNT `
  --budget file://deploy/aws/budget.json `
  --notifications-with-subscribers file://YOUR_PRIVATE_NOTIFICATIONS.json
```

## 2. Build outside the small AWS instance

Current API/web release: **SerpApi / connector 0.1.2**, deployed 2026-10-04 at 13:51 UTC from committed source **`51d5142cd9992ed3c3f70f6a337024ac21d7c25c`**. Both Linux amd64 images were built off-host, labeled with that revision, and transferred in a SHA-256-verified archive alongside an exact Git source archive with 328 file hashes. The live `API_IMAGE` is pinned to `sha256:8f78d2389b470206b043985b473bd21b0dc4c364e5da21522af3aa962b9a3285` and `WEB_IMAGE` to `sha256:65b3a3eb0a13968d795fb2c053f614a197771ec5087cbe8eaf7406437cee576a`. The host's existing checkout was retained; only the new migration, compiled catalog, and attestation source were copied into its migration inputs. API and web execution uses the new immutable images, not that checkout's historical HEAD.

With no active tasks, public web and API were stopped for a private database/configuration backup. Only `0057_serpapi_research.sql` was applied. Historical migration receipts and all 114 existing table fingerprints remained unchanged, excluding the new `serpapi_capable` column, whose existing rows defaulted to false. The new API passed full startup attestation before public web restarted. Database, storage and HTTPS container identities, nginx configuration, Google configuration, secrets and small-host resource limits were preserved. After this migration, an old API image alone is not a valid rollback: any database restore needs a separately reviewed recovery plan. The backup archive was verified and copied privately off-host; no restore was performed.

Previous release: **connector 0.1.1**, deployed 2026-10-02 at 06:42 UTC. Both Linux amd64 images were built off-host from the checkout based on `e7d63a81162f78736d9dbc904984b745a5475adb` plus the locally validated connector changes. A 194-file source SHA-256 manifest records those uncommitted source bytes. Its API image was `sha256:db6da234d2876890413b4178c09aad40d670e50d624b821938b4155a0cc20d19`, and web image was `sha256:948280e152494bd419c2111daed40cb5603062ae2af368191bc9695d2b89351c`. That release added live busy-state projection and exact receipt recovery, updated the bind-mounted nginx download rules, and applied no migration. Both connector releases serve a versioned npm-pack tarball and Windows ZIP; neither was published to the npm registry.

Earlier favicon update on 2026-10-02: the web container used `grimoire-web:sha-9124c628ed334abd6751e1cd5ff9b70c1ca04a76`, built off-host and transferred as a checksum-verified image archive. Only `web/index.html` changed in that release; at that point the other four application images retained their original digest pins. [Favicon release evidence](../../docs/evidence/aws-favicon-20261002.json) records its image identity and hosted Chrome checks. That image remains available for rollback; the connector release preserves the supplied favicon.

The manually triggered `.github/workflows/aws-images.yml` builds Linux amd64 images; its `publish` input defaults to false. [Successful release run 36968370011](https://github.com/Vetri1706/Grimoire/actions/runs/36968370011) built and published all five images from **`899a9fbcc8ca753f07349940a0f70f14788da607`**. The packages are publicly pullable as `ghcr.io/vetri1706/grimoire-{api,web,ops,storage,mc}:sha-899a9fbcc8ca753f07349940a0f70f14788da607`. Never publish an image containing `.env` or user data.

Resolve each published image's registry digest and put its immutable `ghcr.io/vetri1706/grimoire-COMPONENT@sha256:DIGEST` reference in the corresponding `.env` image field. Use all five images from the same successful run. Keep the tested source SHA for the host checkout, or use a later configuration-only commit only after confirming that `api`, `db`, `web`, `scripts/seed-judge-demo.mjs`, all five `deploy/aws/Dockerfile.*` files, and `deploy/aws/api-entrypoint.sh` are unchanged from the image source. That comparison passed for the current configuration changes; repeat it for any subsequent release. Preserve the exact migration bytes embedded by the API build.

Future builds run only when explicitly dispatched. Select `publish: true` to publish checked SHA-tagged packages; workflow success checks packaging, not the hosted application's readiness.

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

Copy this release archive privately to the host and run `docker load < grimoire-images.tar.gz`. Do not build Rust/Go on either small deployment host profile.

Upstream MinIO's old Docker Hub/Quay images were unavailable during verification. The storage Dockerfiles build pinned upstream source instead, including the October 2025 security release and licensing files. [Upstream build instructions](https://github.com/minio/minio/releases/tag/RELEASE.2025-10-15T17-29-55Z). The community repository is archived; this preserves the current bounded judging stack, not a long-term storage maintenance strategy. A future AWS S3 adapter requires an explicit supported cloud-storage path and tests; the current app intentionally accepts only local object storage.

## 3. Start a fresh deployment

SSH as `ubuntu`, clone this repository at the tested release SHA or a verified configuration-only successor described above, and use Docker via `sudo` (or a deliberately configured operator Docker group). For the selected **1 GB** host, run both scripts with the explicit `small` argument:

```bash
sudo bash deploy/aws/bootstrap.sh small
sudo bash deploy/aws/configure.sh HOST EMAIL small
```

Replace `HOST` with the verified DNS hostname and `EMAIL` with the private certificate contact. `bootstrap.sh small` creates or validates a private 2 GiB swap file and preserves existing unrelated swap; it refuses to overwrite an unknown file. `configure.sh HOST EMAIL small` writes the full memory overrides: 816 MiB combined long-running container RAM limits, lower PostgreSQL allocations and bounded swap allowances. Setting only `AWS_MEMORY_PROFILE=small` does not apply those overrides. Existing `.env` files are preserved rather than regenerated. The standard 2 GB profile is still available by omitting `small` from both commands.

If using GHCR, edit the root-only `deploy/aws/.env` image fields to the five verified digest references from the successful workflow. Pull them before startup:

```bash
sudo docker compose --env-file deploy/aws/.env -f deploy/aws/compose.yaml --profile tools pull
sudo bash deploy/aws/up.sh
sudo python3 deploy/aws/setup-owner.py
sudo docker compose --env-file deploy/aws/.env -f deploy/aws/compose.yaml run --rm seed-demo
```

`up.sh` creates private storage/database services, runs idempotent migrations, configures a private versioned bucket, then starts the API. It checks API startup before starting public ingress on first deployment. Existing deployments should be backed up and maintained deliberately; this is not a zero-downtime rolling updater. An attestation failure must be diagnosed, never bypassed or “fixed” by regenerating the trusted catalog.

The owner script prompts privately for a new passphrase and does not print session cookies. Use normal HTTPS sign-in afterward. The `/demo` seed creates only explicit synthetic judging cases. It does not execute a model and it never imports private development records. Seed credentials are temporary and revoked by the existing seeder.

For real agent work, sign in to the deployed website and open **Settings → Runtime → Connect Codex**. Copy its current versioned command; no source-code checkout is needed. The deployed 0.1.2 command for PowerShell is:

```powershell
npx.cmd --yes --package="https://grimoire-52-71-93-70.sslip.io/downloads/grimoire-connector.tgz?v=0.1.2" grimoire-connector --api "https://grimoire-52-71-93-70.sslip.io" --watch
```

Users without compatible Node.js can use **Download Connector for Windows** from the same setup page. Approve the organization pairing in the app. Grimoire login authorizes the workspace connection; Codex login remains local and supplies model access. Your computer and terminal must stay running for real tasks. The public synthetic `/demo` remains inspectable without your computer. Existing Codex/model subscription or provider costs are separate from the AWS hosting estimate.

For SerpApi research, configure `SERPAPI_API_KEY` privately in that local connector's environment, restart it using 0.1.2, then choose **SerpApi Google Search** and consent to the public brief. An ordinary connected worker without the key is not SerpApi-capable. The key is not deployed to AWS or embedded in browser assets/downloads. See [local connector setup](../../byoa/README.md#optional-serpapi-research).

## 4. Hosted verification and release checks

### SerpApi release, 4 October 2026

The 0.1.2 hosted checks passed over verified TLS: both connector downloads matched the local release SHA-256 values and retained `no-store`/`nosniff`; public diagnostic/private-file boundaries remained closed; owner password sign-in and logout retained the Secure, HttpOnly, Strict cookie. All three read-only synthetic demo cases and the SerpApi forms were checked in Chrome at 1440 px desktop and 390 px mobile, without document overflow or page errors. The downloaded package also passed `grimoire-connector --check` without pairing or executing a model.

An isolated protocol-only test verified provider changes clear consent, an incapable worker is rejected, explicit SerpApi selection persists through task creation and follow-up, and a follow-up without explicit provider consent returns 422. It created one test Handler, organization, Scion, agent and protocol worker, plus two tasks cancelled before claim. The worker was revoked and both test/owner sessions logged out. The isolated test records remain; existing workspace content was not changed. No real worker, model, SerpApi request, or source capture ran in this hosted check. Earlier successful local provider runs do not establish hosted end-to-end research success. Google OAuth completion, capacity under live model work and full hosted evidence withdrawal were not reverified. [Release evidence](../../docs/evidence/aws-serpapi-20261004.json)

### Initial deployment, 2 October 2026

The following checks passed on the hosted release on 2026-10-02:

- Fresh PostgreSQL 17 setup applied **32 migrations**; API startup attestation and private storage initialization passed. The three explicitly synthetic demo cases were seeded.
- Actual Chrome at **1440 px desktop and 390 px mobile** loaded the supplied logo and all three cases through their real navigation links. Refresh passed, with no page errors or document overflow.
- The installation owner signed in through the hosted UI. The session cookie was **Secure, HttpOnly and SameSite=Strict**; CSRF protection, logout and signed-out reload passed. Google sign-in was disabled during that initial verification; the later activation is recorded below.
- Normal HTTPS signup and organization creation passed for independent accounts. The owning organization read a synthetic brief with **200**; another organization received **404**. A spoofed `X-Grimoire-Organization` header received the application's expected **409 `ACTIVE_ORGANIZATION_CHANGED`**. Four synthetic verification accounts were created across two runs, and all verification sessions were revoked afterward; no model tasks were run.
- Public `/api/health` and `/api/setup/owner` returned **404**; anonymous `/api/me` returned **401**. Five private service ports were closed to external connections.
- Nine invalid login attempts with varying client-supplied `X-Forwarded-For` values returned **six 401s followed by three 429s**. Those changing headers did not bypass the observed throttle.
- A **host-local public synthetic workload of 480 requests over 120 seconds (4 requests/second)** had **p95 24.28 ms**, **maximum 153.952 ms**, and **zero request errors, container restarts or OOM events**. Subsequent `vmstat` observation showed no sustained swap activity. These timings exclude external network latency and do not establish capacity for model execution, a real worker or sustained multi-user traffic.

Previous local evidence also covers isolated proxy behavior, migration repeatability and tamper rejection. The hosted isolation check above covers brief reads and organization-header enforcement. Source/task/artifact revocation has **not been fully reverified on the hosted deployment beyond the public revoked demo case**; do not describe earlier local coverage as hosted tests. [The sanitized evidence record](../../docs/evidence/aws-judging-20261002.json) separates the completed hosted checks from these limits.

For later releases, repeat HTTPS signup/sign-in, cookie/CSRF/logout, organization isolation, public route boundaries, demo refresh, desktop/mobile layout and capacity checks against the actual URL. Verify source/task/artifact revocation and withdrawn evidence in replies on the hosted app before relying on those paths. If judging includes live agent execution, enroll a real worker and complete one intended task, measuring memory pressure and response times during that run. Keep the worker's computer online. Network-failure behavior and any newly configured Google flow need their own hosted verification.

### Google sign-in activation — 2 October 2026

Google sign-in is enabled on the deployed site. The operator confirmed adding `https://grimoire-52-71-93-70.sslip.io` to the existing Google Web client's authorized JavaScript origins. The existing public client ID was added to the private deployment environment after a configuration backup and a check that no task was executing. Only the API container was recreated; its image and all other containers were unchanged. No migration or frontend build was needed.

Hosted Chrome verified the official Google button and real Google account-entry popup without an origin/client rejection. Google displays `sslip.io` as the destination domain. Opening the popup did not create a Grimoire session, and `/demo` remained available without Google requests. The three Google frontend request tests passed. Full interactive Google sign-in, returning sign-in and real-account isolation still require operator verification; opening the provider page is not proof of a completed login. [Activation evidence](../../docs/evidence/aws-google-signin-20261002.json)

Google accounts remain separate from password accounts: matching email addresses do not automatically link workspaces. See [Google sign-in setup](../../docs/google-sign-in.md).

## Backups and end of judging

Before the 0.1.2 migration on 2026-10-04, a quiesced **1,120,638-byte** private PostgreSQL dump and copies of the prior configuration/catalog were retained on the host. `pg_restore --list` passed, and the dump was downloaded into the operator-only local release directory with matching SHA-256. Its recorded hash is in the SerpApi release evidence. This verifies archive readability and transfer integrity, not a completed restore; object storage was retained in place and is not contained in the SQL dump.

A private PostgreSQL logical backup of approximately **1.1 MB** was created and downloaded on 2026-10-02. Its archive catalog parsed successfully with `pg_restore --list`, and the remote/local SHA-256 hashes matched. These checks verify archive readability and transfer integrity, not a completed restore. The single Lightsail snapshot **`grimoire-demo-backup-20261002`** was **in progress at this verification point**; snapshot completion and restoration have not yet been verified. The logical dump alone does not contain pinned object versions.

Run `sudo bash deploy/aws/backup.sh` before a release or snapshot. Keep the private logical dump with an instance snapshot containing the object volume. Verify restoration on an isolated host before trusting a backup. Do not leave daily snapshots accumulating: snapshot billing is incremental but grows with changed data and retained copies.

Set a calendar reminder for the actual end of judging. After judges are finished: export the necessary private backups, delete the named Lightsail instance, release its static IP, and delete snapshots no longer needed. **Stopping an instance does not stop Lightsail billing.** The provisioner deliberately contains no automatic destructive teardown. No teardown date has been supplied, so nothing is scheduled.
