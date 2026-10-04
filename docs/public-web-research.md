# Public web research

Public web research is a native Grimoire agent task that produces an **unverified research report** with public URLs, observed search queries and server retrieval receipts. It can outline procurement processes and possible alternatives. It does not select a supplier, contact anyone, place an order, verify a commercial claim or grant approval.

## Run a research task

1. Update the API/database and local Grimoire worker from the same checkout. Keep the user's Codex login on their own computer.
2. In the Scion's Tasks surface, choose public research. Write an explicitly public brief, choose Codex web or SerpApi Google search, select an agent and the exact connected capable computer, and consent to that brief being sent to the selected providers. Grimoire does not fill the brief with private Scion/source content. SerpApi requires `SERPAPI_API_KEY` on that connector and separate consent for up to three credit-consuming searches; see [connector setup](../byoa/README.md#optional-serpapi-research).
3. Start research. The same native queue, agent binding, lease, cancellation and revision rules govern this work. A connected computer or heartbeat alone is not evidence of successful provider execution.
4. Review the resulting process steps, candidates, gaps and source receipts. A completed agent task creates no human review. Record a review separately; it is not procurement approval.
5. If a captured source must no longer be used, withdraw it. Its captured content and dependent report/review content are hidden, the native task is blocked/stale, and Watchtower records the withdrawal. Repeating the withdrawal does not create another event.

For an already paired Windows computer, restart only its idle managed worker after updating the checkout:

```powershell
pwsh -File scripts/byoa.ps1 -Mode Stop -Connection YOUR_CONNECTION_UUID
pwsh -File scripts/byoa.ps1 -Mode Start -Connection YOUR_CONNECTION_UUID
```

The stop command refuses to interrupt an active child task. Wait for that task to finish first. For a new computer:

```powershell
pwsh -File scripts/byoa.ps1 -Mode Connect -ApiUrl YOUR_GRIMOIRE_ORIGIN -WatchAfterConnect
```

Approve pairing through Grimoire. Existing `codex-synthetic-v1` pairing is not itself permission for public research. Each `research_public_web` task separately records `public-web-research-v1` consent and the selected worker connection. Updated workers advertise public research support; older workers cannot claim this task kind.

## Native records and boundaries

- `intake_agent_tasks` stores the task and immutable public brief/consent. `intake_task_agent_bindings` retains the actual assigned agent revision. No second workflow store is introduced.
- `intake_research_reports` stores one immutable deliverable per task. Task completion references that report through the existing proposal/result binding.
- `intake_research_captures` stores bounded public-page excerpts, requested/final URLs, retrieval time, HTTP status, raw-response SHA-256 and byte length, or an explicit retrieval-failure code. Full original response bytes are **not retained**. The hash therefore identifies retrieved bytes, not a downloadable archived original or a verified quotation.
- For Codex web, queries and referenced URLs come from completed Codex web-search events. For SerpApi, they come directly from successful Google Search API responses, including the actual query, search ID and observation timestamp. The worker rejects undiscovered citations. SerpApi synthesis sees only successfully captured source excerpts and cannot run alternative search tools. This is provenance from the user's worker, not a cryptographic attestation of the provider.
- API retrieval is independent of model citations. A successful receipt establishes retrieval of bytes; it does not verify the report's interpretation, a price, stock, supplier suitability, or permission to reuse the page.
- Reviews and source withdrawals are separate append-only records. Organization access, agent/human authority, current revision, signed lease and active selected connection are checked server-side and in database guards.
- Reports never automatically materialize governed core facts, source claims, offers, confirmations or sourcing approvals. Existing synthetic preparation and physical procurement workflows retain their existing authority checks.

## Bounds

Reports allow at most 8 source receipts, 8 process steps, 8 candidates and a 300-second task timeout. The task respects a shorter timeout configured on its selected agent. Codex web permits 5 observed queries, checked against completed events rather than a pre-call network budget. SerpApi limits the plan to 3 queries before making requests and accepts at most 3 query receipts; each included source must have a successful capture. The connector uses one fresh `no_cache=true` request per query, with a 45-second per-request timeout, no automatic retry and no fallback provider. Empty results, unavailable captures, invalid credentials and quota failures are reported explicitly. It is bounded research, not a crawl of the entire internet. It does not add authenticated data connectors or bypass website access controls.

The server fetcher accepts public HTTP(S) on standard ports only, with no URL credentials or ambient proxy/cookies. Every redirect is revalidated; resolved addresses must be public and are pinned for that request. Local/private/special IPv4 and IPv6 destinations are rejected. Fetches have a 10-second overall bound, at most 3 redirects, a 256 KiB response limit and HTML/plain-text content-type checks. Active HTML elements are removed from the stored text excerpt, limited to 32 KiB. External text remains untrusted data.

Network I/O runs outside the database lock. The lease, cancellation, source access, consent and revision are rechecked before storing a receipt. Concurrent retries may retrieve a URL twice but create one persisted receipt. Runtime roles retain no UPDATE/DELETE privileges over immutable research artifacts; scoped database functions provide the locks needed to serialize reads and withdrawals.

## Database rollout

Back up the target database, stop only the API instance being upgraded, and use the repository's normal migration runner. Apply these additive migrations in order, recording the exact file SHA-256 in `public.grimoire_schema_migrations`:

1. `0052_public_web_research.sql`: native research records, consent and task transitions.
2. `0053_research_capture_guards.sql`: bounded report validation, revision locking and completion-before-review checks.
3. `0054_research_receipt_locks.sql`: scoped immutable-receipt read/withdraw locks, without granting runtime UPDATE.
4. `0055_task_conversations.sql` and `0056_task_conversation_dependencies.sql`: the subsequent native conversation migrations required before the SerpApi increment.
5. `0057_serpapi_research.sql`: explicit provider selection, fresh SerpApi-capable worker presence, provider-bound query receipts and captured-source requirements.

`scripts/dev.ps1` and `scripts/windows-startup-checks.ps1` include the complete migration sequence. The compiled API's migration list and `db/windows-catalog.json` must match the migrated schema exactly. Do not edit an already-applied migration, bypass startup attestation, or run reset/seed operations on an existing workspace.

For a clean, disposable Windows schema/catalog verification:

```powershell
pwsh -File scripts/windows-startup-checks.ps1 -Task PrepareCatalog -CleanDatabase grimoire_startup_research_verification_test
```

For the research SQL guard probes, run `api/tests/research_guards.sql` using `psql -X -v ON_ERROR_STOP=1 -f ...` against a disposable database whose name ends in `_test`, after applying the exact migration set. The fixture rolls back and clearly labels protocol-only records; it makes no provider or website call. It requires the local migration/test administrator connection to switch into the restricted runtime role during assertions. Supply credentials through the existing local environment, never command-line literals or public logs.

## Validation record

### SerpApi increment, 4 October 2026

The local SerpApi increment passed 80 connector tests, 55 Rust tests, 31 frontend tests, restricted-runtime research SQL guards, Clippy and the production frontend/connector build. Fresh migrations through 0057 produced 3,782 catalog entries. These local checks used `grimoire_startup_serpapi_final_20261004_test` and did not migrate the main local database. The separate AWS release is recorded below. A follow-up to a SerpApi task must explicitly name SerpApi again; omitted provider selection is rejected rather than spending search credits through inherited consent.

The API/web images from commit `51d5142cd9992ed3c3f70f6a337024ac21d7c25c` and connector 0.1.2 were deployed to the [public AWS site](https://grimoire-52-71-93-70.sslip.io) on 4 October 2026. A private backup preceded production migration 0057; startup attestation and existing-row preservation passed. Hosted Chrome verified downloads, public demos, sign-in, provider capability/consent, a cancelled native task, explicit follow-up and missing-provider rejection. The isolated test worker was revoked, and both tasks were cancelled before execution. These hosted tests made no model, SerpApi or source-capture calls; live hosted research has not been established by them. The SerpApi key remains local to the operator's connector. See [deployment scope and evidence](evidence/aws-serpapi-20261004.json).

Protocol-only Chrome checks verified provider selection, capability filtering, fresh consent, explicit follow-up provider selection (including rejection when omitted) and desktop/mobile layout without any provider calls (`.local/serpapi-ui/1791120956079/results.json`). Expanded research consent stays in normal flow on mobile; desktop retains its sticky composer. Mobile document, body and viewport heights all measured 844 pixels without outer overflow.

Real SerpApi Google searches and two tool-free Codex passes produced persisted native reports, query/search-ID receipts and captured source hashes. Task `a295ce1a-dc1a-4432-bd6b-26737dd22fe8` completed with two search receipts, two capture attempts and one cited official source. The older all-in-one browser test stopped at its outdated collapsed-report selector, subsequently corrected. Further live attempts failed on unavailable captures or report validation; no successful report was manufactured for those attempts. Live discovery quality and source availability vary, so the complete paid browser journey is not recorded as passing. Reports remain unverified and completion grants no approval.

Separate Chrome verification on that real persisted report passed provider/search-ID/timestamp rendering, review persistence without approval, mobile width, foreign-organization read/revoke denial, and withdrawal of a cited source hiding the report after reload. This used a disposable authentication fixture for the original test Handler, not a fabricated report, and made no additional model/search calls. Evidence: `.local/serpapi-review/1791120745660/results.json` and screenshots. It verifies the post-report workflow, not a passing all-in-one paid run.

### Earlier public-research verification

The navigation sidebar and task inspector support pointer and keyboard resizing. Move the inspector using its header drag handle or layout menu, dock it left or right, or hide it. Settings → Appearance provides layout controls and a reset. Only bounded layout preferences are saved in browser storage, scoped to the current user and organization; research content is not cached there. Narrow screens stack the inspector while retaining desktop preferences.

Six real Chrome layout checks passed resizing, docking, focus restoration, reload persistence, small-screen behavior, organization isolation and reset (`.local/layout-personalization/1790910241086/results.json`). A separate no-model Chrome check verified that a 120-second agent produces a 120-second saved research task, the Tasks navigation stays active, and cancellation completes before a worker claims the task (`.local/research-timeout/1790911552946/results.json`). The frontend production build and all 26 frontend unit tests passed.

On 2 October 2026, the research increment passed 48 Rust tests and `go test ./...` / `go vet ./...` (the Go packages reported no unit test files). Clean Windows migrations through 0054 produced 3,697 catalog entries. Restricted-runtime SQL probes passed explicit consent and worker checks, foreign-organization isolation, signed leases, immutable history, exact capture/report binding, read-lock access without UPDATE grants, completion separate from review, idempotent source withdrawal and native blocking/cancellation.

An HTTP preflight against the isolated real stack also passed enrollment, task dispatch/claim, a real GOV.UK public-page capture (64,855 bytes with hash and excerpt), same-URL receipt replay, and human withdrawal/replay. It invoked no model and created no research report or approval.

The opt-in browser journey `web/tests/research-journey.mjs` subsequently passed against the isolated real stack: one actual Codex run, two real GOV.UK captures (64,855 and 74,647 bytes), native task/report completion, separate Handler review, lost-response review retry producing one receipt, foreign-organization denial, source withdrawal hiding the already-open report and surviving reload, mobile layout without horizontal overflow, and no browser errors. It granted no procurement approval. Evidence is in `.local/research-journey/1790911202718/results.json` and sibling screenshots. An earlier attempt correctly recorded a failed task when the immutable-receipt lock privilege defect was encountered; migration 0054 and the HTTP preflight fixed and verified that defect before the successful run.

Restart persistence was verified separately without another model call or source fetch: the isolated API process changed from PID 11916 to 9124 and returned healthy against the same test database. Read-only before/after SHA-256 fingerprints matched for all seven scoped record sets (task, report, captures, reviews, withdrawals, watch state and withdrawal events). The completed task retained two captures, one review, one withdrawal, one watch event and its stale/blocked state. Evidence: `restart-before.json` and `restart-after.json` beside the live journey results. This verifies persisted records across an API restart; it is not a second authenticated browser-content check or a database-service restart.

The live journey requires `GRIMOIRE_TEST_DISPOSABLE=1` and `GRIMOIRE_TEST_LIVE_CODEX=1`. By default it invokes the user's installed Codex once on an invented public GOV.UK brief. `GRIMOIRE_TEST_SEARCH_PROVIDER=serpapi` selects two real Codex calls with live SerpApi requests between them and requires the private local key. This opt-in spends both model usage and search credits. Do not treat a configured test, heartbeat, SQL fixture, failed run or interrupted run as live provider success.

The main local database (`grimoire_dev`, port 55432) was then backed up and upgraded through 0054. Row counts and content fingerprints for all 107 existing tables, and the historical migration ledger, remained unchanged. The exact tested API binary passed startup attestation and is serving the existing API on 8080 and web proxy on 5180. This rollout did not start a personal worker or dispatch work in the user's workspace. The archive and comparison result are under `.local/backups/grimoire-dev-public-research-upgrade-20261002T085517.dump*`.
