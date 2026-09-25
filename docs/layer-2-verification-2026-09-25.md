# Layer 2 synthetic-source slice: local execution evidence

Implemented and exercised on 25 September 2026. This is a synthetic draft-source
workflow, not approved evidence, customer validation, or the complete Layer 2.

## Working flow

The existing development Scion `d83bbaf8-412a-42f6-979b-4fbac68673bd` now has one
synthetic source revision and one Handler-entered unverified claim, created
through the running React UI and Rust API. The intake remains at revision **4**;
the source is pinned to that revision, with its own source revision **1**.

- Title: `SYNTHETIC — enclosure evaluation note`.
- Origin: `synthetic://grimoire/local/enclosure-note`.
- Owner: `Grimoire local prototype fixture`.
- Permission basis: synthetic text created for this prototype and permitted for
  local Scion review only; this is a Handler attestation, not independent rights
  verification.
- Permitted use: `scion_review`; effective rights: `granted`.
- Exact content: 144 UTF-8 bytes, SHA-256
  `f842c6ebdc36ee764ebba8353f78453e8f71512511b50363e24689fc0ebf6a90`.
- Claim: the note states a target enclosure width of 120 mm, explicitly not a
  verified measurement.
- Locator: source revision **1**, zero-based UTF-8 byte interval **[51, 82)**,
  exact quote `Target enclosure width: 120 mm.`

The UI was reloaded, the case reopened, and the saved source/claim displayed
again. Source text, manual unverified claims, automated extraction (not
implemented), and verified facts (zero) are visibly distinct. Evidence readiness
remains **not assessed**. Dark theme and the existing intake/revision history
remain intact. No horizontal overflow was observed at the current browser width.
This was a bounded browser check, not a full accessibility or usability study.

The input fixture is versioned in `fixtures/synthetic-enclosure-source.json`.
It is separate from the accepted GG-40 fixture and contains no real supplier,
manufacturer, offer, price, approval, or measurement evidence.

## Live Go harness: 40/40 passed

Command: `pwsh -NoProfile -File scripts/dev.ps1 -Task Harness`.
Recorded **2026-09-25 23:23:50 +05:30**. Exit code **0**; check duration **1.741s**.
The Go client exercised the compiled Rust API at `127.0.0.1:49274`, backed by
native PostgreSQL **17.11**, disposable database `grimoire_test`, runtime login
`grimoire_intake_app`. No mocked API, object-store substitute, or direct database
queries were used by the HTTP harness.

All **21 Layer 1 checks** remain passing. The **19 new Layer 2 checks** cover:

- Missing/null/denied rights, missing permission basis, and disallowed use return
  403 without creating a source or changing source history.
- Explicitly synthetic input only; client hashes and unauthorized fields are
  rejected. SHA-256 and byte length match exact UTF-8 including CRLF and Unicode.
- Source creation pins the exact Scion revision and requires its current
  `If-Match`; source edits preserve old bytes, claims, and intake snapshots.
- Locators reject split Unicode, mismatched/wrong-revision quotes, empty,
  reversed, and out-of-range intervals.
- Claims remain `handler_entered` / `unverified`; forged approval, extraction
  authority, and verification fields are rejected. A second distinct claim
  cannot overwrite the first.
- Stale/missing preconditions, idempotent receipts, conflicting retry payloads,
  immutable source history, and source/claim persistence after restart.
- Foreign/unknown Scions and source IDs return identical 404 bodies, including
  history, claim locators, and mutation endpoints. Nesting another organization's
  source under an owned Scion does not bypass the check. Authentication is
  required throughout.
- Revocation is terminal, uses the current source revision, and retains its
  reason. Content, history, claim reads, writes, and old content/claim retry keys
  are denied after revocation. Same-organization audit summaries contain no
  source text, claim statements, or quote. Safe identifier-only receipts cannot
  restore rights. Denial and organization hiding persist after restart.

Actual Rust process transitions were **24928 → 1816 → 29900 → 15940**.
PostgreSQL stayed running; the harness child was stopped after completion.
The development API was not used for acceptance mutations.

[Full numbered stdout/stderr and exit code](evidence/layer-2-harness.txt).

## Database, build, and UI checks

- New additive `0026_intake_sources.sql` applied to `grimoire_dev` and
  `grimoire_test` after unchanged 0022–0025, without resetting either database.
  It creates draft intake source tables in the same canonical development
  database; it is not part of the verified GG-40 SQL.
- Both applied migration ledgers and supplied bytes are checked separately in
  [migration evidence](evidence/layer-2-migrations.txt).
  New `0026` SHA-256:
  `1f231a1817652c25092f19aada3f5be65e978b82abef84c84b60588f8b6cab93`.
  The original ZIP hashes for 0022, 0023, and the fixture still match. Development
  contains zero governed cases/offers and exactly one draft source revision and
  one unverified claim; only test contains the supplied governed fixture. SQL
  independently recomputed the browser source hash, byte length, and claim span.
- `pwsh -NoProfile -File scripts/dev.ps1 -Task DbGuards`: passed, with all inserts
  rolled back. Checks include owner-level UPDATE/DELETE immutability; runtime
  forbidden mutation/pointer privileges; independent hash/locator constraints;
  missing rights; revoked-content RLS; and cross-organization summary hiding.
  [Raw database guard output](evidence/layer-2-database-guards.txt).
- Rust: **11 tests passed**, `cargo fmt --check`, `cargo clippy -- -D warnings`,
  and `cargo build --locked` passed.
- Go: formatting, vet, and build passed before the live run.
- React/TypeScript: production build passed. Locator checks covered accented
  text, emoji, repeated and overlapping quotes, CRLF, invalid quotes, and bounded
  ambiguity for repeated source text.
- Live browser: source creation, claim creation, exact locator display, source
  provenance/hash, unchanged Scion revision, and reopening after reload passed.
  Revocation and source-revision mutations were exercised by the real HTTP
  harness and SQL guards, not performed on the retained browser demonstration.
- Paperclip's working tree remains unchanged.

## Reproduction

Run from `C:\proj\Grimoire\grim`. The existing native cluster is persistent.

```powershell
pwsh -File scripts/dev.ps1 -Task DbUp
pwsh -File scripts/dev.ps1 -Task Migrate
pwsh -File scripts/dev.ps1 -Task Migrate -TestDatabase
pwsh -File scripts/dev.ps1 -Task Api
```

In a second terminal, start `pwsh -File scripts/dev.ps1 -Task Web` and open
`http://127.0.0.1:5173`. Open the existing case's **Sources and claims** tab.

```powershell
pwsh -File scripts/dev.ps1 -Task Harness
pwsh -File scripts/dev.ps1 -Task DbGuards
npm.cmd run build --prefix web
```

For a clean disposable database only, run
`pwsh -File scripts/dev.ps1 -Task ResetTest` before the harness. That fixed-target
reset applies the supplied GG-40 fixture only to `grimoire_test`.

## Object storage and remaining scope

This slice stores bounded synthetic text in PostgreSQL. No object-storage client,
emulator, bucket, or S3 requests were used. Docker Compose startup was not
exercised; the previously failing Docker Desktop installation was not modified.

The following remain **untested and unimplemented in this slice**:

- Source upload/download byte integrity against object storage and immutable
  bucket/key/version bindings.
- Signed URL authorization, expiry, revocation, and access through existing URLs.
- Object Lock, legal holds, retention rules, physical erasure and tombstones.
- Object-store backup/restore without resurrecting revoked access.
- Orphan cleanup, database/object-store atomicity, interrupted uploads, worker
  retries, and cross-store crash recovery.

Docker availability alone would not validate any of those behaviors; each needs
an explicit storage implementation and acceptance test. API revocation prevents
subsequent retrieval and processing, not withdrawal of bytes already viewed or
copied. Production identity, per-source external grants, extraction, fact
verification, Paperclip connector work, and governed promotion remain separate.
No supplier offer or governed sourcing case is created by this slice.

## Changed implementation files

- Database: `db/intake/0026_intake_sources.sql`, `api/tests/source_guards.sql`.
- Rust: `api/src/sources.rs`, `api/src/main.rs`, `api/src/error.rs`.
- UI: `web/src/Evidence.tsx`, `web/src/evidence-api.ts`, `web/src/App.tsx`,
  `web/src/styles.css`.
- Go harness: `harness/sources.go`, `harness/main.go`.
- Tooling and fixture: `scripts/dev.ps1`, `fixtures/synthetic-enclosure-source.json`.
- Documentation: root/API/harness READMEs, Layer 2 contract, this report, and raw
  execution evidence.
