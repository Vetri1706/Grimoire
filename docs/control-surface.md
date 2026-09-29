# Grimoire OS control surface

The React app opens a company dashboard with Paperclip-style navigation. Each
Scion defaults to a focused overview; proposals, evidence, work, activity and
the read-only graph have separate views. Persistent Watchtower is also a
company page, rather than another large panel stacked beneath the graph.
See [company workspace architecture](company-workspace.md). This follows the
adjacent Paperclip checkout's `DESIGN.md`, neutral theme tokens, compact state
rows and progressive disclosure.
The HTML reference was withdrawn by the user in favor of Paperclip's source.
No Paperclip source files or existing user modifications were overwritten.

## Authority and persistence

`GET /api/scions/{id}/control-surface` authenticates the bearer principal before
loading any graph or integration data. PostgreSQL RLS hides foreign cases with
the same 404 as an unknown ID. `nodes[]` and `edges[]` project intake, proposals,
existing Rust tasks, sources, implemented data paths, comparisons and human
gates. Edges with missing endpoints are omitted; no graph editing endpoint
exists. Plans/comparisons/tasks are bounded to the latest 100 of each kind;
the event/review window is the latest 100 watch events. Historical records
remain persisted. The graph is an operational projection, not an unlimited
audit export.

Source reads use the existing organization, permission, exact object-version,
hash and UTF-8 claim guards. Scion and source locks serialize a response with
concurrent revision/revocation transactions. Revoked source text, title and
quotes are withheld. Blocked/stale derivative content is null; provenance and
the content-free reason remain visible. No object-store key or task lease is
part of the graph.

Migrations 0040–0042 add internal watches, immutable events, immutable human
review tasks, dependency records and mutable staleness projections. They are
additive; previously applied migrations were not changed. 0041 corrects the
shared artifact trigger's record-field dispatch, and 0042 registers bounded
capability-task source dependencies using the actual task schema.

Scion/source revisions, source revocation and terminal task outcomes emit events
inside the mutation transaction. A unique organization/event key means duplicate
delivery exits before any audit, review or state effect. Watch events have one
review task each; these are human review obligations, not scheduled agent jobs.
Task failure/cancellation invalidates dependent drafts. Task completion does
not approve anything. Sourcing approval remains unavailable.

Capability tasks conservatively depend on the active source set at queue time;
plans declaring `scion_sources` depend on the active source set at proposal
creation. Evidence comparisons depend on their exact claims and their plan's
source dependencies. Historical backfill considers only source versions that
existed when the task/plan was created. It creates no invented historical checks
or events. Physical tasks retain their pre-existing exact-source guards and
workflow; they are not made dependent on unrelated case sources.

The Rust service runs a two-second internal health check independent of browser
sessions. It checks event-capture triggers and advances up to 500 persisted watch
heartbeats per tick, oldest first. A never-checked watch is pending; checks older
than ten seconds are delayed. Event processing is transactional, not dependent
on this heartbeat. This is neither external vendor polling nor an agent scheduler.

The browser polls the authenticated projection every two seconds, times out a
read after 2.5 seconds, and expires displayed data five seconds after a successful
read began. Failure, hiding/offline state, expired display access and changed
source/revision fingerprints clear content and evidence forms. Server checks
continue while the page is closed. Browser suspension prevents a strict
wall-clock revocation guarantee, and already copied content cannot be recalled.

Digital Scions have no applicable physical-scope or supplier-offer tabs. The
existing synthetic website's actual Codex proposal, internal sources, unavailable
external data connector, missing Handler decision and human gate remain inspectable.
No external provider monitoring is enabled: the implemented data registry has
only Handler intake and authorized internal sources.

## Native agent backend

Paperclip is a source/design reference only. The prior optional connector has
been removed. Grimoire now owns revisioned agent profiles, instruction skills,
task assignment, pause/resume controls and run history in Rust/PostgreSQL.
The operations dock reports the real authenticated Grimoire worker heartbeat,
not Paperclip connectivity or invented company runs. A missing/stopped worker
is disconnected after its 15-second presence lease expires.

The existing bounded Codex bridge retains task leases, source/revision checks,
child cancellation and proposal-only credentials. Protocol-2 claims carry exact
native agent/skill snapshots. It is not a replacement scheduler and cannot
create human approval. See [native agent APIs, workflow and limitations](native-agents.md).

The sibling Paperclip checkout, running service and data were not changed.
Old local connector files are ignored and no longer read by Grimoire.

## Verification

See [the executed OS verification report](verification-2026-09-26-control-surface.md)
for browser observations, automated results and unverified deployment boundaries.

```powershell
pwsh -NoProfile -File scripts/dev.ps1 -Task Migrate
pwsh -NoProfile -File scripts/dev.ps1 -Task Migrate -TestDatabase
cargo test --manifest-path api/Cargo.toml --locked
pwsh -NoProfile -File scripts/dev.ps1 -Task Harness -HarnessSlice control-surface
pwsh -NoProfile -File scripts/dev.ps1 -Task Harness
pwsh -NoProfile -File scripts/dev.ps1 -Task DbGuards
pwsh -NoProfile -File scripts/windows-startup-checks.ps1 -Task Check
node --test byoa/bridge.test.mjs connectors/local-mcp.test.mjs
npm.cmd --prefix web run typecheck
npm.cmd --prefix web run build
```

The current startup catalog uses retained `grimoire_startup_agents_v1_test`; earlier
clean databases remain untouched. `-CleanDatabase` supports explicitly named
new clean targets. `PrepareCatalog` refuses to replace an existing database.
Rebuild/review the clean catalog when adding migrations; never bypass startup
attestation or edit applied migration hashes to make a test pass.

`scripts/control-surface-demo.ps1 -Task Setup` creates a separate labeled
synthetic protocol fixture through real HTTP, PostgreSQL and MinIO. It refuses
to overwrite `.local/os-browser-demo.json`. The fixture is **not an LLM run**.
Open its printed URL, then run `Complete` within five minutes, `Revise`, `Revoke`
and `Replay` while inspecting the UI. The existing actual-Codex website demo is
preserved separately. Completion/revision/revocation steps create no approval.

The Go suite covers revision-only staleness, exact source revision changes,
revocation, blocked queued work, denied running-worker control, idempotent
outcomes, foreign organization hiding, browser-independent checks and process
restart persistence. The rollback-only SQL guard additionally redelivers the
exact same watch event twice and checks audit/task/state identity stability,
runtime mutation restrictions and direct RLS isolation.
