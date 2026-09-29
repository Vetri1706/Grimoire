# Layers 1–4 synthetic black-box acceptance harness

This separate Go program starts the compiled Rust API, sends real HTTP requests,
terminates that process, starts it again, and verifies persisted Scions through
HTTP. It also exercises synthetic source/claim storage, exact physical scope,
two-offer normalization and bounded Codex task protocols. PostgreSQL
remains running during the restarts. There is no mocked API, Go
HTTP server, direct database query, or in-memory persistence substitute.

The only dependency is Go 1.23 or newer. The database (including the new source
migration) and Rust binary are setup prerequisites; use the repository's root
startup/reset instructions first. The existing 21 Layer 1 checks run first and
must still pass before the source checks run.

## Run on Windows PowerShell

From `C:\proj\Grimoire\grim\harness`, set the three required environment
variables to the disposable database connection and the two seeded Handler tokens:

```powershell
$env:DATABASE_URL = 'postgresql://grimoire_intake_app:<local-password>@127.0.0.1:5432/grimoire_test'
$env:GRIMOIRE_TOKEN_A = '<seeded-organization-A-token>'
$env:GRIMOIRE_TOKEN_B = '<seeded-organization-B-token>'
go run . -api-binary ..\api\target\debug\grimoire-api.exe
```

Use the actual port/password from the local Compose configuration. Do not use a
Paperclip database or development database. The harness refuses to run mutation
checks unless `/api/health` reports all of:

- PostgreSQL major version 17, queried by the Rust API from its database.
- A database name ending with `_test`.
- The restricted `grimoire_intake_app` runtime role.

`GRIMOIRE_API_BINARY` may replace `-api-binary`. By default the harness selects an
unused loopback port and passes `GRIMOIRE_BIND` to the child API. For a fixed port:

```powershell
go run . -api-binary ..\api\target\debug\grimoire-api.exe -bind 127.0.0.1:39177
```

To build and inspect without running acceptance checks:

```powershell
go vet ./...
go build -o grimoire-harness.exe .
.\grimoire-harness.exe -api-binary ..\api\target\debug\grimoire-api.exe
```

On Unix-like systems use the corresponding binary path without `.exe`. A missing
runtime, missing binary, unavailable database, failed guard, failed assertion, or
startup failure returns a nonzero exit code. An unexecuted harness is not a pass.

## Coverage and isolation

Every successful check prints a numbered `PASS`. Checks cover:

- Actual PostgreSQL 17/database identity and independent authenticated organizations.
- Missing/invalid authentication, including revision history endpoints.
- Creation with explicit `null` unknowns, actionable missing information, authenticated authorship, and no generated sourcing fields.
- Reopening an intake and reading each immutable revision.
- History author display names match authenticated `/api/me` identities, remain separate from immutable revision payloads, and include only authors referenced by the case history. Unauthorized and cross-organization denials disclose no Handler names or principal metadata.
- Exact status/body/ETag replay for an idempotent create or revision, even after newer revisions or process restart.
- Conflicting idempotency payloads (`409`).
- Required `If-Match` (`428`) and stale revisions (`412`).
- Concurrent writes from the same base revision: exactly one success and one conflict.
- Organization isolation for list, latest, full history, individual revision, and revision writes. Foreign and unknown resources produce identical `404` bodies and no resource headers.
- Reopening the same record and immutable history after a real Rust process termination/restart.
- Digital intake drafts explicitly stating that vendor comparison is unavailable.

Layer 2 checks additionally cover:

- Missing, null, or denied rights, absent/blank permission basis, and disallowed
  permitted use return `403` without changing the source list. A revision with
  missing rights also fails without changing source history.
- Only synthetic input is accepted. Client-supplied hashes and unknown fields
  fail validation; the API hash and byte length must match exact UTF-8 bytes,
  including a multibyte character and CRLF. Provenance and the linked Scion
  revision are preserved.
- Source revision history and exact revisions remain immutable across later
  writes and a real API restart. Source additions do not rewrite intake snapshots.
- Exact half-open byte locators reject split UTF-8 boundaries, mismatched quotes,
  empty/reversed/out-of-range spans, and quotes from the wrong revision.
- A Handler claim remains `handler_entered` and `unverified`. Forged verification,
  extracted authority, and approval fields are rejected. Each revision permits
  one claim; duplicate or changed claims cannot overwrite it. Automated
  extraction is explicitly unavailable, and verified facts remain an empty list.
- Source, revision, claim, and revocation receipts support exact idempotent
  retries. Missing/stale source preconditions return `428`/`412`.
- Every source list/detail/history/revision/claim and mutation endpoint denies
  unauthenticated access. Foreign Scions and source IDs return the same `404` body
  as unknown resources, without identity/content/count/resource-header leakage.
- Revocation blocks source text and claims, historical reads, processing, and
  previously successful content/claim retry keys. Content-free audit metadata
  remains visible to the owning organization. Safe creation and revocation
  receipt retries cannot restore rights. These behaviors persist through another
  real API restart, including cross-organization hiding after revocation.
- Every tested source response, including denials, carries `Cache-Control: no-store`.

Each numbered result may include several assertions/requests. The harness does
not equate a request count with a test count.

Each run uses unique record names and idempotency keys. Records are deliberately
left in the disposable database for inspection. Reset that database with the root
repository's reset command between clean test runs. The verified synthetic GG-40
fixture belongs only in this disposable database; this harness does not load it.
Layer 3/4 checks use the real API to create synthetic governed identity, offer
and reviewed-normalization records. They create no sourcing approval.

## GG-46 focused decision-authority guard

`harness/gg46` is a small PostgreSQL-focused Go harness for the additive `0034`
gate. Against a disposable database containing the unchanged GG-40 fixture and
`0034`, it checks exact revision identifiers, explicit comparability/exclusions,
stale scope and offer/source revisions, revocation, cross-organization
non-disclosure, idempotent retries, agent/quality-role denial, the rejection of a
decision write without human authority, and one clearly labelled synthetic
positive path. The positive result remains a draft and creates no sourcing
approval.

```sh
cd harness
go run ./gg46 \
  -dsn 'postgresql://postgres@127.0.0.1:55446/grimoire_gg46?sslmode=disable' \
  -fixture ../fixtures/gg46-two-offer.json \
  -code-revision '<commit>'
```

Layer 2B additionally uses the real private versioned object store. Runtime
credentials are tested for read/write access without version deletion. A separate
test-bucket-only credential injects overwrites and missing objects. A local,
strictly scoped helper corrupts an actual disposable object part; application
assertions still go through Rust HTTP. No mocked API/store or direct database
edits are used. Administrative fault credentials are removed from the Rust child
environment. Fault tests refuse any bucket except `grimoire-sources-test`.

Checks include exact uploaded/retrieved SHA-256 and length, pinned versions after
newer same-key uploads, idempotent version counts, private anonymous reads,
organization hiding, missing/corrupt objects, storage outages, API and storage
restarts, and revoked access. The frontend's already-open-tab behavior is tested
separately in a real browser, not inferred from HTTP results.

Run `scripts/storage.ps1 -Task Up` before the harness. The root `dev.ps1 -Task
Harness` selects test credentials automatically. Direct invocation also requires
`GRIMOIRE_S3_ENDPOINT`, `GRIMOIRE_S3_REGION`, `GRIMOIRE_S3_BUCKET`,
`GRIMOIRE_S3_ACCESS_KEY`, `GRIMOIRE_S3_SECRET_KEY`,
`GRIMOIRE_S3_TEST_ADMIN_ACCESS_KEY`, `GRIMOIRE_S3_TEST_ADMIN_SECRET_KEY`, and an
absolute `GRIMOIRE_STORAGE_SCRIPT` pointing to the scoped local helper.

No download URLs are issued. Signed-URL expiry/revocation, Object Lock/legal
holds, physical erasure, backup restore, orphan cleanup, and crashes between
object upload and database commit remain untested. Restart recovery is not a
backup restore. An API denial cannot retract bytes a client previously copied.

The harness does not claim customer validation, production identity-provider
readiness, a Paperclip connector, digital vendor comparison, or human sourcing
approval. Its authored supplier quotations and synthetic reviewer identities
exist solely to test the local API. No real supplier was contacted.

Layer 4 adds exact two-offer comparison, immutable offer revisions, wrong-part,
missing-field and differing-basis exclusions, stale input rejection, cross-case
and organization hiding, revocation redaction and canonical artifact invalidation.
The Codex protocol checks cover explicit dispatch, concurrent claims, cancellation,
immutable result provenance, and an actual 30-second execution deadline followed
by the shutdown lease. Each full run therefore waits about a minute for the time
boundary; it does not accelerate the database clock.

For focused development runs use `dev.ps1 -Task Harness -HarnessSlice offers`
or `-HarnessSlice scope`. Only the default full run establishes regression results.
An actual Codex CLI run and browser checks are separate from this Go protocol client.

`-HarnessSlice control-surface` runs thirteen OS and eight native-agent checks: revision-only staleness,
authorized graph edges, foreign-organization hiding, completion without approval,
source revisions, revocation/redaction, blocked dispatch and running-worker
control, replay idempotency, browser-independent checks and actual API restart.
The full harness also runs these checks and preserves physical-workflow coverage.
`api/tests/control_surface_guards.sql` separately redelivers the same watch event
under rollback and checks unchanged audit/review/task effects and direct RLS.
See [control-surface verification and boundaries](../docs/control-surface.md) for
the separate browser protocol fixture. [Native agent verification](../docs/native-agents.md)
covers persistent profiles/skills, exact assignment snapshots, compatible worker
protocol, pause/cancellation, idempotent retries, foreign organization isolation,
reporting-cycle rejection, proposal-only completion and actual Rust restart.
`api/tests/native_agent_guards.sql` checks immutable native history and direct RLS.
Paperclip is a source reference only; the suite uses no Paperclip backend.
