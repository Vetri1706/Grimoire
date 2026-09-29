# Grimoire Scion intake

Working local Scion intake, synthetic evidence, adaptive capability proposals, physical-scope review and two-offer exact comparison. React/TypeScript calls a Rust HTTP API backed by PostgreSQL 17 and private versioned MinIO source storage. Exact configuration, BOM occurrence, component, requirement, supplier, source and commercial terms remain pinned. Separate synthetic engineering review creates the identity chain and confirms normalization in existing GG-40 tables. The Go harness exercises the real API, database and object store, including process restarts, conflicts, revocation and organization isolation.

Draft and source history stay immutable. No physical values are generated from missing fields. Synthetic scope confirmation records exact identity only; claims remain unverified and sourcing approval is disabled. Digital Scions support revision-bound capability proposals and Handler-authored evidence comparison drafts; digital vendor comparison remains unavailable. Supplier discovery, real supplier offers, RFQs and production qualification remain deferred. Agent profiles, instructions, skills and assignments belong to Grimoire's native Rust/PostgreSQL backend; Paperclip is a design/source reference only. A local BYOA bridge executes bounded preparation tasks using the user's installed **Codex CLI and existing login**, returning proposals without human confirmation authority. See [Windows adaptive Scions, authority boundaries and commands](docs/windows-adaptive-scion.md), [BYOA setup](docs/byoa-local.md), [Layer 4 results](docs/layer-4-verification-2026-09-26.md), and [remaining storage work](docs/storage-recovery-backlog.md).

## Company workspace

The [company-first workspace](docs/company-workspace.md) separates Dashboard,
Inbox, Proposals, Scions, Agent work, Watchtower, Agents, Skills, Connectors and
Activity. Scions open a focused overview, and proposals open one selected record
instead of a stacked case board. [Current verification](docs/verification-2026-09-27-native-agents.md)
records 152 live Go checks, 20 Rust tests and real browser checks.

## Current local run

The browser offers normal Handler signup and sign-in with HttpOnly sessions.
Each new account creates its own isolated organization. Installation-owner
setup remains a separate one-time action; signup never claims it.
Organization administration grants workspace access, not sourcing or approval
authority. The public `/demo` entry shows three persisted synthetic cases
without an account or personal Codex login. See [judge access and setup](docs/judge-access.md).

Optional [Sign in with Google](docs/google-sign-in.md) uses server-verified Google
tokens and Grimoire-owned sessions. It stays disabled until a Web application
client ID is configured. Google accounts never inherit existing memberships.

The [Windows adaptive verification report](docs/windows-adaptive-verification.md)
records the 131-check live regression, real Codex digital demonstration, applied
migration hashes, startup protections and unavailable Mac work.

- Windows adaptive UI: <http://127.0.0.1:5180> (explicit command below; Vite default remains 5173).
- Rust API: <http://127.0.0.1:8080/api/health>
- PostgreSQL: `127.0.0.1:55432`, canonical development database `grimoire_dev`.
- Database runtime: native PostgreSQL **17.11**, stored persistently in `.local/pgdata`, retained from the earlier Docker Desktop startup failure. Docker Engine is now reachable; Layer 2B uses a native source-built MinIO because the attempted official images/binaries were unavailable. No Docker settings, existing volumes, WSL distributions or Paperclip databases were reset.
- Open the browser to create an account, sign in, or explore the judge demo. The operator can separately choose “Set up this installation.” The generated `.env` bearer credentials remain server-side development-harness inputs; the UI does not ask for them.

A clearly labelled `UI smoke test — enclosure intake` draft with four revisions remains in development for inspection. It contains no real product/supplier evidence and is independent of the supplied GG-40 fixture. The supplied fixture is present only in disposable `grimoire_test`.

## Prerequisites

PowerShell 7 (`pwsh`), Rust/Cargo, Node/npm, and either Docker Desktop with a running Linux engine or the portable PostgreSQL 17 fallback. The Go harness requires Go 1.23+. Portable verified Go and PostgreSQL downloads can be installed under the ignored `.tools` directory without changing machine-wide PATH or installing a Windows service.

Run all commands below from:

```powershell
Set-Location C:\proj\Grimoire\grim
```

## Fresh database with Docker Compose

With Docker Desktop running, choose Docker on a fresh checkout:

```powershell
pwsh -File scripts/dev.ps1 -Task Init -Mode docker
pwsh -File scripts/dev.ps1 -Task DbUp
pwsh -File scripts/dev.ps1 -Task Migrate
```

Compose uses the official `postgres:17` image and a persistent named volume, `grimoire-local_grimoire_pg17`. It binds PostgreSQL only to loopback. `DbUp` runs `docker compose up -d --wait db`. `DbDown` stops it without deleting the volume. Do not use `docker compose down -v` unless you deliberately intend to erase development data.

## Native PostgreSQL fallback used on this machine

For a fresh setup when Docker cannot run:

```powershell
pwsh -File scripts/install-local-tools.ps1 -Postgres -Go
pwsh -File scripts/dev.ps1 -Task Init -Mode native
pwsh -File scripts/dev.ps1 -Task DbUp
pwsh -File scripts/dev.ps1 -Task Migrate
```

`Init` never replaces an existing `.env` or its credentials. This checkout is already initialized with `GRIMOIRE_DB_MODE=native`; use `DbUp` to restart it. The native cluster persists inside this project and listens only on `127.0.0.1:55432`. `pwsh -File scripts/dev.ps1 -Task DbDown` stops the selected runtime without removing data.

Choose one runtime. Changing `GRIMOIRE_DB_MODE` does not migrate data between a native cluster and a Docker volume. Do not start both on the same port or create a second development authority as a shortcut. No Mac migration is required.

## Migration and fixture handling

`Migrate` creates a fresh `grimoire_dev` if necessary, verifies every supplied SQL hash, and applies **0022 → 0023 → 0024 → 0025 → 0026 → 0027 → 0028 → 0029 → 0030 → 0031 → 0032 → 0033 → 0034 → 0038 → 0039 → 0040 → 0041 → 0042 → 0043 → 0044 → 0045 → 0046 → 0047 → 0048**. Mac-origin migrations 0035–0037 are unavailable and have not been reconstructed. It seeds local Handler identities, a separate synthetic engineering reviewer and a proposal-only Codex agent. Missing new credentials are appended after backing up `.env`; existing values are preserved. Use `-TestDatabase` to migrate the disposable test database without resetting it. The API login has no database CREATE/TEMP, schema CREATE, ownership, superuser or RLS bypass. Bounded database functions create the governed identity chain only after the Rust authority, revision and source-byte checks.

- `db/gg40/0022_grimoire_contract.sql`, `0023_grimoire_review_corrections.sql`, and `fixture_one_case_two_event.sql` are unchanged supplied bytes.
- `db/gg40/checksums.json` contains the supplied expected SHA-256 values. `.gitattributes` prevents newline conversion of these SQL files.
- `db/intake/0024_intake.sql` is newly authored additive draft storage in the **same canonical database**, not part of the verified GG-40 contract. It also narrows exposed governed helper permissions for the intake role.
- `db/intake/0025_intake_history_authors.sql` adds a scoped lookup for current Handler display names. Names travel separately from immutable snapshots; the recorded principal ID remains available in revision details. This is additive intake work, not verified GG-40 SQL.
- `db/intake/0026_intake_sources.sql` adds immutable synthetic draft source revisions, exact-locator manual claims, and revocation. This is new intake work in the same database, not a change to the verified GG-40 source contract.
- `db/intake/0027_intake_source_objects.sql` adds immutable object-version references and the constrained administrator transition from inline source text. This is additive Layer 2B work, not verified GG-40 SQL. Apply it, then run `ExternalizeSources` for existing inline sources before reopening their content.
- `0028_intake_scope.sql` adds immutable scope proposals and confirmation links to the existing governed tables. `0029_intake_agent_tasks.sql` adds the scoped BYOA preparation queue. `0030_scope_chain_guard.sql` strengthens exact-chain readback and prevents a task requester from confirming work returned by their agent. All three are new application migrations, not part of verified GG-40.
- `0031_worker_controls.sql` adds explicit dispatch, cancellation, execution bounds and immutable task provenance. `0032_synthetic_offer_comparison.sql` adds synthetic offer staging and reviewed exact comparison through existing GG-40 tables. `0033_offer_review_identity_guards.sql` enforces jurisdiction-scoped supplier identity and review separation across full offer history. `0034_sourcing_authority_gate.sql` rejects every future canonical decision revision unless an immutable, exact-scope review exists from a distinct enabled commercial authority; its positive fixture is synthetic software-behavior evidence only. These are additive application migrations, not verified GG-40 files.
- `public.grimoire_schema_migrations` records applied file hashes and refuses changed migrations.
- `0045_handler_registration.sql` adds independent non-owner signup. `0046_public_judge_demo.sql` reserves a separate synthetic organization and a read-only publication registry. The operator seed command in [judge access](docs/judge-access.md) publishes the three cases through real API transitions; ordinary page visits never create fixtures or run agents.
- `0047_google_identity.sql` adds separate Google identities and single-use browser challenges. Google sign-in creates a normal non-owner account with no inherited organization membership; password accounts are not automatically linked.
- `0048_handler_profile.sql` permits an authenticated Handler to update their own display name and corresponding membership display labels with an audit record. It does not change login credentials, organization roles, or approval authority; see the [workspace alignment verification](docs/paperclip-workspace-alignment-2026-09-30.md).
- `0038_windows_adaptive_plans.sql` adds revision-bound capability proposals and reviewable evidence drafts. `0039_windows_approval_lockdown.sql` keeps unverified canonical approval/decision paths disabled. Neither is GG-53/GG-54 or the unavailable Mac 0037 work. Startup verifies compiled migration hashes and a clean PostgreSQL catalog; see the [Windows authority boundary](docs/windows-adaptive-scion.md#windows-authority-protections-and-unavailable-mac-work).
- `db/local-handlers.sql` creates no governed product, offer, price or approval records.
- `db/local-scope-actors.sql` enrolls only separate synthetic reviewer and proposal-agent principals. `GRIMOIRE_TOKEN_REVIEWER_A` is a test identity, not a qualified real reviewer. `GRIMOIRE_TOKEN_AGENT_A` cannot confirm scope or edit intake/source history.
- The fixture is never applied by `Migrate` or API startup. Only `ResetTest` applies it, in `grimoire_test`.

Recheck the supplied bytes at any time:

```powershell
pwsh -File scripts/dev.ps1 -Task VerifySql
pwsh -File scripts/dev.ps1 -Task DbStatus
```

## Start the application

Terminal 1:

```powershell
pwsh -File scripts/storage.ps1 -Task Up
pwsh -File scripts/dev.ps1 -Task Api
```

Terminal 2:

```powershell
npm.cmd --prefix web ci
npm.cmd --prefix web run dev -- --host 127.0.0.1 --port 5180
```

Open <http://127.0.0.1:5180>, complete one-time Handler setup or sign in, then create or select an organization. Create a Scion with just a name; the missing fields stay visible. Field-entry counts and unresolved questions are displayed separately from evidence readiness, which remains unassessed. Revision history selects the current snapshot immediately and shows the Handler's readable directory name, with the principal ID in details. A stale form must load the latest record and explicitly reapply intended changes; it never silently overwrites another save.

Vite proxies `/api` to Rust at `127.0.0.1:8080`. Rust rejects non-loopback binds, non-PostgreSQL-17 databases and privileged/owning runtime roles. No database credential is sent to the browser. No deployment or paid service is required.

## Adaptive Scions and local MCP

Enter a free-text description, then use **Capability plan** to queue and explicitly dispatch a revision-bound Codex proposal. The API reports the actual `handler_intake` and `scion_sources` data connectors. External provider discovery is unavailable. A Handler can name alternatives and link exact authorized claims in an evidence comparison draft; unsupported criteria stay visible and all claims remain unverified. Existing physical workflows remain separate. See the [complete flow and API contract](docs/windows-adaptive-scion.md).

```powershell
pwsh -NoProfile -File scripts/dev.ps1 -Task Migrate -TestDatabase
pwsh -NoProfile -File scripts/dev.ps1 -Task Harness -HarnessSlice adaptive
node --test byoa/bridge.test.mjs connectors/local-mcp.test.mjs
pwsh -NoProfile -File scripts/windows-startup-checks.ps1 -Task Check
```

The adaptive Go slice uses the running Rust API, PostgreSQL and MinIO, and launches the real MCP stdio facade. The full harness remains necessary for physical regression checks. The startup script checks both the retained clean startup database and upgraded disposable database; [catalog reproduction instructions](docs/windows-adaptive-scion.md#startup-and-verification-commands) explain its one-time `PrepareCatalog` mode.

The read-only MCP server is launched with `node connectors/local-mcp.mjs`, using `GRIMOIRE_API_URL=http://127.0.0.1:8080` and an existing local credential in `GRIMOIRE_MCP_TOKEN`. See [MCP setup and access boundaries](docs/windows-adaptive-scion.md#actual-data-connectors-and-mcp) for a command that reads the ignored local credential without printing it. This does not install an agent configuration or connect Paperclip; it exposes no writes or approval tool.

For the synthetic digital website demonstration, run `scripts/adaptive-demo.ps1 -Task Intake`, `scripts/byoa.ps1 -Mode Once`, then `scripts/adaptive-demo.ps1 -Task Evidence`. The evidence step requires the real Codex task result and never supplies fake agent output. Optional `scripts/adaptive-demo.ps1 -Task Revoke` withdraws permission for a synthetic source so an already open comparison can be checked. See [the full commands and their effects](docs/windows-adaptive-scion.md#startup-and-verification-commands).

## First Layer 2 slice: synthetic source and claim

Apply the new migration before restarting the API:

```powershell
pwsh -File scripts/dev.ps1 -Task Migrate
pwsh -File scripts/dev.ps1 -Task Migrate -TestDatabase
```

Open a Scion's **Sources and claims** tab. Link a synthetic text source with its
origin, owner, explicit permission basis, and permitted local review use. The
server computes SHA-256 over exact UTF-8 bytes and binds the source to the current
Scion revision. Missing rights prevent ingestion. The versioned example in
`fixtures/synthetic-enclosure-source.json` contains no manufacturer evidence.

Enter a claim separately and choose its exact quote in a source revision. The
locator records a zero-based, half-open UTF-8 byte range and quote. The source
text is retained independently; the claim remains Handler-entered and
unverified. Automated extraction is not implemented and there are no verified
facts. New source revisions preserve prior snapshots and claims. Revoking a
source blocks subsequent content/claim reads and writes; a same-organization
provenance summary remains visible. Revocation cannot retract bytes already
viewed or copied by a client.

The [Layer 2A API contract](docs/layer-2-api-contract.md) records the original
rights, revision, and locator behavior. Layer 2B moves source bytes into private,
versioned S3-compatible storage while PostgreSQL retains canonical revision and
permission records. Rust reads the exact stored version and verifies SHA-256 and
length before returning content or using a locator. A missing, corrupt, or
unavailable object denies source and claim content; PostgreSQL text is never a
fallback. No browser download URLs are issued.

See [local object-store setup](docs/object-storage.md) and the
[Layer 2B execution report](docs/layer-2b-verification-2026-09-25.md) for commands,
actual checks, and limits. The source UI rechecks permission while open and
clears content on revocation, expired access, hidden tabs, or network failure.
This cannot retract bytes already copied or independently retained by a client.

Signed-URL expiry and revocation, Object Lock, physical erasure, backup restore,
orphan cleanup, and crashes between object upload and database commit are not
established by this slice. Source fetching, binary uploads, and real-data sourcing
qualification remain unavailable. Synthetic offer comparison is described below.

The [Layer 2 execution report](docs/layer-2-verification-2026-09-25.md) records
the 40-check live Go run, database guard checks, browser flow, migration hashes,
and the exact remaining storage limits.

## Layer 3: physical scope and your local coding agent

The **Physical scope** tab starts with blank identity fields. Supply all four
physical identity sections, inspect each permitted synthetic source and its
unverified claim, and assign an exact source revision/hash/locator to every link.
Save a proposal directly or queue Codex preparation. Ambiguity and unresolved
gaps block confirmation. A stale intake/source revision or revoked source also
blocks it. A matching byte hash establishes integrity, not source truth.

Run the local worker in another terminal using your existing Codex CLI login:

```powershell
pwsh -NoProfile -File scripts/byoa.ps1 -Mode Check
pwsh -NoProfile -File scripts/byoa.ps1 -Mode Watch
# Or manage a background worker:
pwsh -NoProfile -File scripts/byoa.ps1 -Mode Start
pwsh -NoProfile -File scripts/byoa.ps1 -Mode Status
pwsh -NoProfile -File scripts/byoa.ps1 -Mode Stop
```

`Watch` runs only while that process is alive; stop it with Ctrl+C. To process one
dispatched task and exit, use `-Mode Once`. Creating a queued task never starts
execution; use the explicit Dispatch control. This adapter performs bounded
synthetic scope/normalization preparation, not arbitrary shell/coding tasks. It supplies no Grimoire,
database or storage credentials to Codex. It consumes your existing Codex
account usage. The app reports queue/task states; it has no bridge heartbeat or
general agent-connection status endpoint yet.

To create a separate, clearly labelled demonstration through the real API:

```powershell
pwsh -NoProfile -File scripts/seed-synthetic-scope.ps1 -QueueCodex
```

This creates a synthetic draft and four explicitly authored sources/claims,
then queues and explicitly dispatches a proposal task. It never applies the supplied GG-40 test fixture to
development. It records IDs in ignored `.local/layer3-demo.json`.

Switch the local UI credential to `GRIMOIRE_TOKEN_REVIEWER_A` to exercise the
separate synthetic reviewer form. Check the exact identities, evidence and gaps,
enter a rationale, and explicitly confirm synthetic scope. The API creates the
chain in existing GG-40 tables while preserving the draft/source snapshots.
The preparer, task requester and agent cannot approve their own output.
This test role proves neither a real person's qualification nor customer
validation. Claims remain unverified; sourcing decisions are later
work. See [Layer 3 results](docs/layer-3-verification-2026-09-26.md).

## Layer 4: two synthetic offers and exact comparison

The **Offers and comparison** tab records Handler-entered synthetic supplier
identity, source revision/hash/claim locator and commercial terms against one
confirmed physical scope. Missing terms stay missing; wrong parts, stale
revisions and different comparison bases are excluded with visible reasons.
Equal-currency/equal-unit quotes preserve their exact decimal prices. This slice
does not invent FX rates, unit conversions, freight, taxes or a preferred supplier.

Complete offers use existing GG-40 supplier/source/offer tables. Incomplete
submissions remain additive staging records. A separately enrolled synthetic
engineering reviewer confirms normalization into the existing GG-40 comparison
tables; this is neither commercial approval nor supplier selection.

```powershell
pwsh -NoProfile -File scripts/dev.ps1 -Task Migrate
pwsh -NoProfile -File scripts/seed-synthetic-offers.ps1 -QueueCodex
pwsh -NoProfile -File scripts/byoa.ps1 -Mode Once
# Separate new case demonstrating visible wrong-part exclusion:
pwsh -NoProfile -File scripts/seed-synthetic-offers.ps1 -WrongPart
```

The first seed command explicitly dispatches a synthetic normalization task
using the existing local Codex login. Codex receives pinned IDs and the comparison
basis, never source text or source quotations, and can change only its preparation
summary. Rust computes all comparison lines. Default execution is bounded to
240 seconds (configurable 30–300), with one active task per organization.
Cancellation stops the exact spawned process before releasing its slot.
Immutable task events and result provenance pin the Scion revision. The adapter
is not a Paperclip multi-agent system; there is no RFQ route or supplier contact.

See [offer API contract](docs/layer-4-api-contract.md),
[worker controls](docs/worker-controls-api.md), and the separate
[storage recovery backlog](docs/storage-recovery-backlog.md).

## Disposable database and live Go harness

The reset command **destroys only `grimoire_test`**, recreates it, applies the migrations in order, seeds local Handler identities, then applies the unchanged synthetic GG-40 fixture. It never removes the development database, persistent cluster or Compose volume.

```powershell
pwsh -File scripts/storage.ps1 -Task ResetTest
pwsh -File scripts/dev.ps1 -Task ResetTest
pwsh -File scripts/dev.ps1 -Task Harness
pwsh -File scripts/dev.ps1 -Task DbGuards
```

`Harness` builds Rust, finds Go on PATH or in `.tools/go/bin`, supplies the local test credentials and starts the actual Rust binary on a free loopback port. It asserts the API reports PostgreSQL 17, a `_test` database and the restricted role before writing. It kills/restarts the actual child process and reopens the same record. There is no mocked API or in-memory substitute. Failures, unavailable runtimes, or an unexecuted suite are not passes; the command exits nonzero.

Additional checks:

```powershell
cargo test --manifest-path api/Cargo.toml --locked
cargo fmt --manifest-path api/Cargo.toml -- --check
cargo clippy --manifest-path api/Cargo.toml --all-targets --locked -- -D warnings
npm.cmd --prefix web run typecheck
npm.cmd --prefix web run build
```

## Code and further reading

| Path | Responsibility |
| --- | --- |
| `web/` | React/TypeScript case workspace, intake form, conflict recovery and history |
| `api/` | Rust domain validation, authentication, organization scope and HTTP mutations |
| `harness/` | Independent Go black-box HTTP acceptance checks and real process restart |
| `db/gg40/` | Unchanged supplied migrations/fixture and hash manifest |
| `db/intake/0024_intake.sql` | New additive draft schema, immutable history and restricted runtime grants |
| `db/intake/0025_intake_history_authors.sql` | Organization-scoped history author labels, separate from immutable records |
| `scripts/` and `compose.yaml` | Local database/app startup, migration, isolated reset and checks |
| `docs/layer-1-boundaries.md` | Draft promotion prerequisites and exact Paperclip files informing the boundary |
| `docs/verification-2026-09-25.md` | Actual execution evidence and remaining limitations |
| `docs/reference/GG40_page_capture.txt` | Supplied reference capture; not a canonical document-body hash |

See `api/README.md` for request/response shapes and limits, and `harness/README.md` for direct harness invocation. The [Grimoire OS control surface](docs/control-surface.md) projects the case graph, persistent internal Watchtower, and existing Rust tasks. [Native Grimoire agents](docs/native-agents.md) own versioned profiles, skills, assignments, pause/resume and real Codex task history; no Paperclip backend or management redirect is used. Completion never grants approval. The sibling Paperclip clone is unchanged.
