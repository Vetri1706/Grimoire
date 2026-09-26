# Windows adaptive Scion implementation

This slice extends the available Windows Grimoire implementation with capability
preparation and reviewable evidence comparisons. The implementation branch is
`feature/windows-adaptive-scion`, based on
`572697cdadb20906294fbe6d552b1ad935a7b6de`. It uses Grimoire's existing Rust API,
PostgreSQL 17 database and private versioned MinIO storage. It does not merge the
Paperclip application or depend on the unavailable Mac-local Paperclip instance.

This document describes behavior and reproducible commands. Execution results,
the resulting Windows commit and any failed or unexecuted checks belong in the
separate verification report; a command listed here is not a reported pass.

## From free-text intake to an evidence draft

1. A Handler creates a Scion with a name and a free-text product description.
   Physical, digital and unspecified categories retain the same immutable intake
   revision history. Other unknown fields remain missing.
2. The **Capability plan** tab reads the actual local connector registry and
   evidence gaps from Rust. The Handler attests that this is synthetic input and
   queues `prepare_capability_plan` against the displayed intake revision.
3. The Handler explicitly dispatches the task. The existing local Codex CLI
   bridge claims a bounded lease and uses the user's existing Codex login. The
   server supplies the saved intake revision, connector registry and mandatory
   gaps. The browser cannot replace this input with a fabricated registry.
4. Codex proposes capabilities, reasons, needed evidence and applicable local
   connector IDs. The bridge validates the typed output and retains every
   server-supplied gap. Rust binds the immutable proposal to the exact task and
   Scion revision. Completion is preparation, never approval.
5. The Handler names two to six synthetic alternatives in an **evidence
   comparison draft**. Each criterion refers to a capability key in that plan.
   The Handler can link current authorized source claims using their exact
   immutable locators, or leave unsupported criteria visibly empty.
6. Rust rechecks source organization, case, revision, rights and stored object
   bytes before recording or displaying linked evidence. Claims remain
   Handler-entered and unverified. The worksheet provides no scores, ranking,
   preferred provider, offer, price or sourcing decision.

The website demonstration can describe a community workshop website whose
visitors read class descriptions and request a place, while the Handler edits
pages. Those are Handler intentions, not established requirements or evidence
that a named provider supports them. Synthetic approach labels and authored
source text must be explicitly entered. No provider catalog or external search
result is generated to fill a gap.

An intake edit makes older capability plans stale and withholds their content.
The immutable identifiers remain available. A stale, revoked or unavailable
source blocks its evidence comparison and withholds the comparison input,
statements and quotations. Hash and byte checks establish integrity only.

The open capability tab rechecks access nominally every two seconds. A successful
check permits display only until five seconds after that check began. Hidden or
offline tabs, failed checks and expired display access clear derived content and
unsaved comparison forms. Every assigned source in an unsaved comparison is also
rechecked, including a source no longer selected in the picker. Browser
suspension and scheduling prevent an absolute two-second wall-clock guarantee;
content already copied or photographed cannot be recalled.

## API and persistence boundary

All routes require a local bearer credential. Organization access, task leases,
revision preconditions and idempotency remain enforced by Rust/PostgreSQL.

| Route | Purpose and authority |
| --- | --- |
| `GET /api/scions/{id}/capabilities` | Actual enabled connectors, current gaps, immutable plans and permission-checked evidence comparisons. Foreign Scions are hidden. |
| `POST /api/scions/{id}/agent-tasks` | Handler queues `prepare_capability_plan` with `candidate_proposal: {"synthetic":true}` and a 30–300 second limit. Requires current `If-Match` and `Idempotency-Key`. |
| `POST /api/scions/{id}/agent-tasks/{task}/dispatch` | Explicit Handler dispatch using the pinned revision. Existing cancellation, concurrency and immutable event rules apply. |
| `POST /api/scions/{id}/capability-plans` | Proposal-only agent submits typed output through an active matching task lease. A Handler cannot impersonate a completed agent result. |
| `POST /api/scions/{id}/evidence-comparisons` | Handler records a synthetic, revision-bound worksheet with a plan ID, alternative labels, capability keys, exact claim IDs and unresolved gaps. Requires `If-Match` and `Idempotency-Key`. |
| `GET /api/authority-status` | Authenticated statement that Windows sourcing approval is disabled. |
| `POST /api/approvals` | Authenticated request is denied with `403 APPROVAL_UNAVAILABLE`. |
| `POST /api/scions/{id}/sourcing-approval` | Scion access is checked first; accessible requests are denied with `403 APPROVAL_UNAVAILABLE`, foreign Scions remain hidden. |

`0038_windows_adaptive_plans.sql` adds immutable draft plan/comparison tables in
the same `grimoire` schema and canonical database. It also extends the existing
bounded task protocol. It is new Windows application SQL, not verified GG-40 or
reconstructed Mac SQL. The source, intake and existing physical revisions remain
unchanged. A comparison stores exact claim references rather than promoting a
claim to a verified fact.

## Actual data connectors and MCP

The registry contains only two implemented local data paths:

| Connector | Available data |
| --- | --- |
| `handler_intake` | The exact organization-scoped Handler intake revision; unverified. |
| `scion_sources` | Synthetic source revisions and Handler claims, behind current Rust rights checks and exact version/hash verification in MinIO. |

`external_connectors_available` is false. There is no external provider search,
vendor list, automatic website fetch, general connector marketplace, RFQ route
or supplier contact. The Codex CLI bridge is an agent adapter, not a data
connector. Its preparation child receives the intake and registry, without
source text/quotes or Grimoire/database/object-store credentials. Its tool,
browser, shell and external-search features are disabled for this task. It is
not arbitrary repository coding or Paperclip multi-agent orchestration.

`connectors/local-mcp.mjs` is a separate local stdio MCP facade using protocol
version `2025-03-26`. It exposes three read-only tools:

- `grimoire_discover_connectors`
- `grimoire_read_intake`
- `grimoire_read_source`

Each tool calls the real Rust API using the configured local bearer token. It
accepts exact UUID inputs, rejects non-loopback API hosts, caches no responses
and exposes no mutation or approval tool. An already open MCP session must
re-read to check current permission; it cannot retract results retained by its
client. The facade does not automatically install itself into a user's coding
agent, and the bounded Codex preparation child does not use it to fetch evidence.

To launch the stdio server for an explicitly configured local MCP client, from
the project root:

```powershell
$env:GRIMOIRE_API_URL = 'http://127.0.0.1:8080'
$env:GRIMOIRE_MCP_TOKEN = $null
Get-Content -LiteralPath .env | ForEach-Object {
    if ($_ -match '^GRIMOIRE_TOKEN_AGENT_A=(.+)$') {
        $env:GRIMOIRE_MCP_TOKEN = $Matches[1]
    }
}
node connectors/local-mcp.mjs
```

The process waits for MCP JSON-RPC over stdin/stdout; it is not an HTTP server.
Keep the token in the client process environment, never in a committed config or
browser variable. The existing proposal-only agent credential has the local
read-only-agent role; an MCP reader gains no confirmation authority.

## Windows authority protections and unavailable Mac work

The original requested GG-53/GG-54 integration cannot be asserted from this
checkout. These references came from a separate unavailable Mac instance:

| Mac material | Reference to reconcile when source becomes available |
| --- | --- |
| GG-54 corrected startup implementation | `edc0d2080e01c2138c8a16946a2c787d70a862c3` |
| GG-54 evidence | `504748a31ddcc4b535ef5cd5a4ac6b86c4016eaf` |
| GG-53 approval-session implementation | `6748bf733c0f8afbfe6605073812e5925093fdec` |
| GG-53 evidence | `72e05dc74669030d52a16686e102d438f03dae4c` |
| GG-53 migration | `0037_authenticate_approval_sessions.sql` |
| Independent reviews | GG-57 actual verdict and GG-58 review/source evidence |

Windows has no reconstructed `0035`–`0037` migration files. The new work begins
at `0038`. The Mac commits, SQL and review verdicts are not claimed as integrated.
No Windows localhost Paperclip service is treated as a replacement for those
Mac links. When the exact source/patch is available, verify its object/patch
hashes and reconcile it on a new reviewed head; do not rename this Windows work
as those commits or alter already applied migrations.

The new Windows startup verifier in `api/src/attestation.rs` compares the entire
applied migration-name/hash map to compiled migration bytes and checks catalog
hashes generated from clean PostgreSQL 17. Catalog material includes function
definitions and ACLs, trigger definitions/enabled state, policies, table owners
and RLS flags/ACLs, column definitions and privileges, constraints, and internal
foreign-key trigger state. Runtime role membership and database/schema
creation privileges are checked separately. A same-name function replacement
cannot pass merely because the ledger is unchanged. This is a new implementation
with its own verification evidence, not the unavailable GG-54 result.

`0039_windows_approval_lockdown.sql` revokes runtime execution of canonical
synthetic authority-review/decision helpers and adds denial triggers to
canonical decision, authority-review and approval inserts. Its narrowly named
disposable-test fixture exception requires an explicitly selected migration
owner with actual session membership; an `app.*` role label supplies no such
authority. Rust also denies the approval routes. These controls do not claim
that authenticated GG-53 approval sessions exist.

Synthetic engineering confirmation of exact physical scope and normalization
review remain the existing separate workflow. They do not authorize sourcing.
The new digital worksheet neither substitutes for physical identity bindings
nor promotes a digital Scion into governed physical sourcing records.

## Startup and verification commands

Use the existing native PostgreSQL instance and ignored local credentials. Start
MinIO and migrate development before launching the API:

```powershell
Set-Location C:\proj\Grimoire\grim
pwsh -NoProfile -File scripts/dev.ps1 -Task DbUp
pwsh -NoProfile -File scripts/storage.ps1 -Task Up
pwsh -NoProfile -File scripts/dev.ps1 -Task Migrate
pwsh -NoProfile -File scripts/dev.ps1 -Task Api
```

In another terminal, use the explicit Windows demonstration port:

```powershell
npm.cmd --prefix web run dev -- --host 127.0.0.1 --port 5180
```

Open <http://127.0.0.1:5180>. Vite's default configuration remains port 5173;
the explicit command above selects 5180 and still proxies `/api` to Rust on
8080. Start the bounded worker only when the Handler intends to dispatch work:

```powershell
pwsh -NoProfile -File scripts/byoa.ps1 -Mode Check
pwsh -NoProfile -File scripts/byoa.ps1 -Mode Watch
```

For a separately labeled synthetic website demonstration through the real API,
stop any competing worker first and use the following sequence:

```powershell
pwsh -NoProfile -File scripts/adaptive-demo.ps1 -Task Intake
pwsh -NoProfile -File scripts/byoa.ps1 -Mode Once
pwsh -NoProfile -File scripts/adaptive-demo.ps1 -Task Evidence
```

`Intake` creates the free-text website Scion, queues and explicitly dispatches
its plan task. `Once` runs the actual installed Codex CLI using the existing
login. `Evidence` requires a current plan returned for that task; it stops if the
plan is missing and never substitutes synthetic agent output. It then authors
two explicitly synthetic notes, exact UTF-8 claim locators and a review worksheet
through Rust. The notes say that they do not demonstrate working capabilities.
These examples are fixture evidence for the flow, not researched providers.
Identifiers are retained in ignored `.local/adaptive-demo.json`; existing demo
records are preserved rather than reset. Keep the case's Capability plan tab
open to test revocation, then optionally run:

```powershell
# Test only: withdraw permission for the first synthetic demonstration source.
pwsh -NoProfile -File scripts/adaptive-demo.ps1 -Task Revoke
```

Revocation must hide comparison input and quoted claims on the next successful
access recheck. Its plain-language explanation identifies the missing permission;
the machine-readable code remains in details. This test does not erase source
versions or establish that previously copied content was recalled.

Prepare the existing disposable database without resetting its records, then
run the adaptive real-API slice or all physical/adaptive regressions:

```powershell
pwsh -NoProfile -File scripts/dev.ps1 -Task Migrate -TestDatabase
pwsh -NoProfile -File scripts/dev.ps1 -Task Harness -HarnessSlice adaptive
pwsh -NoProfile -File scripts/dev.ps1 -Task Harness
node --test byoa/bridge.test.mjs connectors/local-mcp.test.mjs
npm.cmd --prefix web run typecheck
npm.cmd --prefix web run build
```

The Go harness launches the compiled Rust HTTP server against PostgreSQL 17 and
the real test MinIO bucket. The adaptive slice also launches the actual MCP
stdio process and exercises its HTTP boundary. Known synthetic agent output in
that harness verifies the leased submission protocol; it is not an LLM run or
proof of model quality. A separately recorded Codex execution is needed for that
integration claim. The adaptive-only switch does not execute physical regression
checks; the full harness does.

Startup attestation checks use a separate retained
`grimoire_startup_clean_test` database plus upgraded `grimoire_test`:

```powershell
# Initial clean catalog reproduction only; refuses if that clean DB exists.
pwsh -NoProfile -File scripts/windows-startup-checks.ps1 -Task PrepareCatalog
# Review the catalog generated from exact migration bytes before compiling it.
cargo build --manifest-path api/Cargo.toml --locked
pwsh -NoProfile -File scripts/windows-startup-checks.ps1 -Task Check
```

The clean catalog database has already been created for this Windows task; do
not rerun `PrepareCatalog` as an ordinary startup step. It deliberately refuses
to delete or reset an existing database. `Check` tests function replacement with
an unchanged ledger, a ledger mismatch, runtime DDL authority and a revoked
approval-helper permission. Each temporary fault affects only the dedicated
clean test database and is restored in `finally`. The script retains restoration
SQL and writes a timestamped report under ignored `.local`; both databases remain
available for inspection. It does not load the supplied fixture into development.

The recorded Windows run in
`.local/windows-startup-checks-20260926T170832522Z.json` contains **19 passing
checks**. The clean catalog contains **2,955 entries**, including column ACLs and
internal foreign-key trigger state. The negative checks include expanded runtime
column update authority and a disabled internal foreign-key trigger; both are
restored before startup is rechecked. This is local Windows evidence, not a
verification of the unavailable Mac implementation.

The normal disposable reset commands remain `scripts/storage.ps1 -Task ResetTest`
and `scripts/dev.ps1 -Task ResetTest`. These erase only the documented test bucket
and `grimoire_test`, respectively, so use them only when a test reset is intended.
No reset or source-branch deletion is part of migration, startup or integration.

## Remaining storage limits

Adaptive comparisons inherit the existing permission/version/hash boundary.
They do not demonstrate upload crash recovery, orphan reconciliation, coordinated
database/object restore, physical erasure, Object Lock, cloud S3 parity, or signed
download-URL expiry/revocation. No browser object download URLs are issued.
Process restart is not restore; revocation is not erasure. Audit metadata remains
visible to the existing authorized organization roles and needs an approved
real-data role policy. The retained synthetic temporary folder whose cleanup was
previously blocked is left in place. See the [storage recovery backlog](storage-recovery-backlog.md).
