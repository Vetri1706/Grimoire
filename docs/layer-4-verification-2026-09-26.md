# Layer 4 local synthetic verification — 26 September 2026

Implemented two synthetic supplier offers and an exact comparison, plus explicit
Codex worker dispatch, cancellation, execution limits and durable task provenance.
The Physical scope navigation icon is now neutral. Existing intake/source history
and applied migrations 0022–0030 were preserved. Paperclip remains unchanged.

## Executed results

| Check | Actual result |
| --- | --- |
| Full Go HTTP suite | **105/105 passed** against Rust, PostgreSQL **17.11**, and the real private versioned MinIO store; final run **1m33.871s**. [Raw output](evidence/layer-4-harness.txt). |
| Earlier layers and worker controls | 88 checks cover prior intake/source/storage/scope behavior plus explicit dispatch, simultaneous task claims, one active task per organization, running/queued cancellation, deadline enforcement, expired leases, immutable events/results and exact task origin. The timing test waits through the real 30-second deadline and 30-second shutdown lease; no database clock changes. |
| Offer/comparison slice | 17 checks cover canonical source version/hash readback; exact prices and totals; duplicate denial; wrong part, missing price and different-basis exclusions; wrong source hash/case; stale Scion/offer/source revisions; independent concurrent review; agent task binding; restart persistence; supplier-source and physical-scope revocation; cross-organization hiding. |
| PostgreSQL guards | All five rollback-only guard files passed. They verify immutable intake/governed records, exact GG-40 joins, source-object references, revoked artifact invalidation, no invented FX, least privilege, agent denial, and historical preparer/reviewer separation. [Output](evidence/layer-4-database-guards.txt). |
| Rust | 14 unit tests, formatting, strict Clippy and build passed. |
| Go tooling | `go vet ./...` passed. |
| Frontend | TypeScript and Vite production build passed. |
| Adapter process tests | 13 Node tests passed, including actual harmless child-process termination on cancellation, timeout and permission-control loss, and preservation of an unrelated child. [Output](evidence/worker-controls.txt). |
| Real Codex execution | Existing local ChatGPT login completed a normalization task in about 11.3 seconds. Recorded proposal remains **unconfirmed**. [Receipt](evidence/layer4-codex-normalization.json). |
| Real Codex cancellation | Observed the exact managed `codex.exe` child, requested cancellation, verified `cancel_requested → cancelled`, verified that child exited, and verified no proposal result was recorded. [Receipt](evidence/layer4-codex-cancellation.json). |
| Browser | Neutral scope icon, wrong-part exclusion, exact comparison, real completed Codex provenance/events, explicit dispatch/cancel controls, and already-open comparison clearing after revocation were observed. [Detailed observations](evidence/layer-4-browser.txt). |

The first full run passed 102 checks and stopped on a new test's incorrect
expectation of HTTP 409 for a stale Scion; the API correctly returned its existing
412 response. The test was corrected. A focused offer run passed, then the final
full 105-check run passed. No failed run is presented as a pass.

## What is bound and what is still unverified

Each immutable offer submission pins a confirmed scope proposal, which resolves
to the exact GG-40 configuration, BOM occurrence, component, requirement and case
revisions. It additionally records supplier legal entity/site/account, its own
source revision/hash/claim/byte locator, quantity, UOM, currency, unit price,
destination, incoterm, payment terms, quote/validity timestamps and lead time.
Missing commercial fields remain null and visibly excluded. Complete entries use
the existing GG-40 supplier, source, offer and offer-line tables; incomplete ones
remain additive staging records, without fabricated mandatory values.

The comparison uses two distinct logical offers and supplier legal identities.
Registration reference is scoped by jurisdiction. Rust and PostgreSQL use exact
decimal strings/numeric arithmetic. Same-currency/same-UOM values preserve the
quoted price and FX=1. Different quantity, currency, unit or commercial basis is
excluded. No currency conversion, unit conversion, landed-cost calculation,
supplier ranking or recommended winner is implemented.

The agent receives pinned identifiers and the explicit comparison basis, not
source text or claim quotations. It may summarize a normalization proposal; it
cannot alter identities, terms or numbers. Rust computes the snapshot. A separate
enrolled synthetic Engineering Reviewer confirms normalization into existing
GG-40 comparison and normalized-line records. A preparer anywhere in the selected
offer's history, the proposal author, the task requester and the agent cannot
provide that review. Human confirmation is never inferred from task completion.
All source claims remain unverified; the synthetic role is not a claim of real
reviewer qualification, supplier validation or customer validation.

## Worker boundary

Only the local Codex CLI adapter is implemented. A Handler creates a queued task,
then explicitly dispatches it. PostgreSQL permits one running/cancellation-pending
task per organization across competing workers. Configured execution is 30–300
seconds, default 240; the server rejects new proposals/results after the execution
deadline. An extra 30-second lease holds the slot for shutdown acknowledgement.
Cancellation stops the exact spawned child and waits for process exit before
acknowledgement. A failed or expired execution is not automatically re-run.

Task result and immutable events record exact Scion revision, provider run ID,
output hash, task origin and timing. Cancellation cannot erase a proposal already
committed before cancellation; such a record retains its own separate human review
requirements. No browser credentials, database credentials or object-store keys
are supplied to the Codex child. The adapter does not run arbitrary coding or shell
instructions and is not a Paperclip multi-agent connector.

## Development records

- [Real Codex normalization](http://127.0.0.1:5173/#/scions/44bcfadb-4166-4695-8815-8a57c8e5baf8): proposal `7f127c79-e742-4fe1-ae8c-4ad30a4832f5` remains unconfirmed. Two exact alternatives: USD 12.50 × 2 = 25.00 and USD 11.75 × 2 = 23.50, with separate 7/10-day lead times. No winner is selected. Browser-control and real-running cancellation audit records are also present.
- [Visible wrong-part exclusion](http://127.0.0.1:5173/#/scions/20afd2a7-5a99-463c-8b9e-15fdf35ba4d0): Supplier B's explicitly authored wrong part is excluded. Its normalized price remains absent.
- [Revoked comparison audit](http://127.0.0.1:5173/#/scions/83526c64-cf47-4b9f-a858-087cf2f00187): separate synthetic normalization review was recorded, then Supplier B source permission was revoked while the Offers tab remained open. Binding is blocked; comparison content and reviewer note are withheld while audit IDs remain.
- [Previously blocked scope](http://127.0.0.1:5173/#/scions/41cf489a-f0c8-43a6-acbb-2209b77aadf8): prior review remains visible with blocked binding, and the navigation icon no longer suggests approval.

These URLs are local to this computer. They are not deployed demonstrations.

## Migrations and changed files

Both development and disposable test databases have the same applied migration
hashes, recorded in [the queried ledgers](evidence/layer-4-migrations.txt).
All new migrations are application additions, not part of the verified GG-40
package. Their bytes are frozen after application:

| Migration | SHA-256 |
| --- | --- |
| 0022, preserved | `5af2c09b31f1be6b537fba05b7af7c561e4b7e959849532bbed43a8d8de4205b` |
| 0023, preserved | `9f7012c8ea6f9e0a32395fa9e569b6f83bff8bbbb7b36862e2a80523b4e82df9` |
| 0031 worker controls | `9009d9f61729dc3b36dd901699c233a8c6c6340dced792e752b704204eaf1ac9` |
| 0032 synthetic offers/comparison | `a043753b9581756ef87f1ac11506d70c070ba704a684d564773cf05e18a573f6` |
| 0033 review/identity guards | `24539b0f0682d79d0d262e0fe98ba7a5cd698d187e9baaec92e812367c36c5f9` |

| Files changed for this slice | Purpose |
| --- | --- |
| `api/src/offers.rs`, `scope.rs`, `byoa.rs`, `main.rs`, `error.rs` | Offer/comparison HTTP flow, exact source/chain verification, worker controls and provenance. |
| `db/intake/0031_worker_controls.sql`, `0032_synthetic_offer_comparison.sql`, `0033_offer_review_identity_guards.sql` | Additive state, immutability, bounded canonical writes, concurrency and reviewer separation. |
| `harness/offers.go`, `agents.go`, `main.go`, `README.md` | Real HTTP offer/worker checks and focused-run options. |
| `api/tests/offer_guards.sql`, `worker_guards.sql`, `scope_guards.sql` | PostgreSQL invariants and authentic task-origin self-review regression. |
| `byoa/bridge.mjs`, `bridge.test.mjs` | Bounded normalization candidate, active process supervision and cancellation. |
| `web/src/Offers.tsx`, `offers-api.ts`, `offers.css`, `AgentTasks.tsx`, `PhysicalScope.tsx`, `scope-api.ts`, `App.tsx` | Offer/review UI, evidence clearing, task controls and neutral icon. |
| `scripts/dev.ps1`, `seed-synthetic-scope.ps1`, `seed-synthetic-offers.ps1` | Migration ordering, harness entry points and explicit synthetic demonstration setup. |
| `README.md`, `docs/layer-4-api-contract.md`, `worker-controls-api.md`, `byoa-local.md`, `ui-style.md`, this report and evidence | Commands, contracts, actual results and limitations. |

The sibling Paperclip clone returned an empty `git status --porcelain=v1`.
No connector, runtime adapter beyond Codex, deployment or commit was made.

## Startup and repeatable checks

From `C:\proj\Grimoire\grim`, using the existing native development setup:

```powershell
pwsh -NoProfile -File scripts/dev.ps1 -Task DbUp
pwsh -NoProfile -File scripts/storage.ps1 -Task Up
pwsh -NoProfile -File scripts/dev.ps1 -Task Migrate
# Separate terminals:
pwsh -NoProfile -File scripts/dev.ps1 -Task Api
pwsh -NoProfile -File scripts/dev.ps1 -Task Web
# Managed local adapter, existing Codex login:
pwsh -NoProfile -File scripts/byoa.ps1 -Mode Check
pwsh -NoProfile -File scripts/byoa.ps1 -Mode Start
pwsh -NoProfile -File scripts/byoa.ps1 -Mode Status
```

The API, UI and hidden background worker are running at handoff. Process status
does not establish provider success; the separate real task receipt does.

```powershell
# Only these named disposable test stores are reset; development is preserved:
pwsh -NoProfile -File scripts/storage.ps1 -Task ResetTest
pwsh -NoProfile -File scripts/dev.ps1 -Task ResetTest
pwsh -NoProfile -File scripts/dev.ps1 -Task Harness
pwsh -NoProfile -File scripts/dev.ps1 -Task DbGuards
pwsh -NoProfile -File scripts/dev.ps1 -Task VerifySql
```

## Remaining limits

No RFQ sending, supplier discovery/contact, real supplier offer, supplier selection
or commercial/sourcing approval was performed. No AWS credits were used and no
customer validation is claimed. Source truth and real role qualification remain
unverified. The broad same-organization audit metadata policy still needs a
real-data role decision.

The frontend nominally rechecks every two seconds, with a two-second request
timeout and five-second display lease. Browser/network scheduling means this is
not an absolute two-second wall-clock guarantee. It cannot retract copied content.

Upload crash recovery, orphan cleanup, backup/restore, physical erasure,
Object Lock, signed-URL expiry/revocation and production cloud parity remain
untested. No browser download URLs are issued. See the separate
[storage recovery backlog](storage-recovery-backlog.md). This run used native
PostgreSQL/MinIO, not a Compose object-store deployment.

The previously blocked synthetic folder
`C:\Users\Nemean Cestus\AppData\Local\Temp\grimoire-byoa-OcOsV2`
was left in place. No cleanup or workaround was attempted for that folder.
