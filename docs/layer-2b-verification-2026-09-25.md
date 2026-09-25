# Layer 2B: local storage execution report

Implemented and exercised on 25 September 2026 using synthetic content only.
PostgreSQL 17.11 remains canonical for revision identity, rights and claim locators.
Full source bytes now live in private versioned MinIO, behind the Rust API.
Claims remain Handler-entered and unverified; verified facts remain zero.

## Verified behavior

- Every upload computes SHA-256, writes an object version, reads that exact
  version back and checks its bytes before PostgreSQL commits the reference.
- Every source/claim content read fetches its pinned version and checks version
  identity, bounded length, SHA-256 and valid UTF-8. There is no inline-text or
  latest-version fallback. Missing, corrupt or unavailable storage fails closed.
- Permission checks and organization hiding occur before object access. Source
  locks serialize reads/processing against revocation. No public or signed
  browser download URL is generated.
- Runtime object credentials cannot delete versions or access the other bucket.
  Separate disposable-test credentials inject faults; the Rust child does not
  inherit those administrative credentials.
- The open Sources and claims view revalidates access and clears source text,
  claim text, quotations and forms when authorization cannot be confirmed.

The original accepted demo was externalized without changing its Scion revision 4,
source revision 1, claim identity or exact UTF-8 locator [51,82). Its source is still
144 bytes with SHA-256
`f842c6ebdc36ee764ebba8353f78453e8f71512511b50363e24689fc0ebf6a90`.
Its stored object version is `bb08ee8f-9ac7-4c78-9543-581aeac806e1`.
The active PostgreSQL `source_text` column is NULL. This is not physical erasure
of database pages, WAL, backups, previously viewed text or copied content.

## Acceptance results

**55/55 Go checks passed**, exit 0, check duration 21.276s. Run recorded
2026-09-25T23:52:55.9881228+05:30. The actual Rust API ran at
`127.0.0.1:51843`, against PostgreSQL 17.11 `grimoire_test` using the restricted
`grimoire_intake_app` role and real MinIO at `127.0.0.1:19000`.

The original 40 checks remain passing. Fifteen new storage checks cover versioning,
no object writes without rights, upload/read hash equality, retries without new
keys or versions, immutable historical object identity, exact-version reads after
newer same-key uploads, anonymous denial, runtime delete denial, organization
hiding, Rust restart, storage outage/recovery, storage restart, revocation and
restart persistence, deleted versions, and corruption of an actual test object.

Actual Rust PIDs: 32636→31320→31452→26272→3212→27992. The object-store process was
stopped/started and restarted twice; data stayed on its persistent local path.
The test child API was stopped at completion. The development API was then started
on 8080. [Full numbered output](evidence/layer-2b-harness.txt).

The corruption fault overwrites one checked disposable `part.1` file. A 503 with
no content proves corrupted real storage is denied. MinIO may reject its own
checksum before delivering bytes; that test alone does not isolate Rust's
SHA-256 mismatch branch. Rust unit tests separately exercise changed bytes,
length mismatch and invalid UTF-8. Normal live PUT/GET checks execute Rust hashing.

Additional checks:

- 13 Rust unit tests, formatting, clippy with warnings denied and build passed.
- Go vet and build passed.
- TypeScript/Vite production build passed.
- [Rollback-only SQL guards passed](evidence/layer-2b-database-guards.txt), including
  immutable object references, same-revision hash identity, no runtime
  externalization, source/claim/revocation immutability, rights and organization
  policies. Exact object bytes/quotes are now verified in Rust, not PostgreSQL.
- [Storage runtime checks](evidence/layer-2b-object-store.txt) verified private,
  versioned buckets, narrow credentials, cross-bucket denial and real corruption.
- [Browser check passed](evidence/layer-2b-browser.txt): a separate synthetic source
  was already displayed when an external API request revoked permission. Without
  navigation or reload, source text, claim text and quotation disappeared and the
  view changed to audit metadata only. The original accepted source remains granted.
- Paperclip `git status --short` remained empty.

During integration, an S3 TLS-provider initialization panic was fixed and the
externalization rerun successfully. The first Go attempt stalled at Windows
background-process output handles after 49 passes; file-backed subprocess capture
fixed the runner, then a clean disposable reset and full 55-check run passed.

## Migration hashes

Additive `0027_intake_source_objects.sql` was applied after unchanged 0022–0026 in
both development and test. It is new Grimoire intake work, not part of verified
GG-40. [Database ledgers, disk hashes and original ZIP comparison](evidence/layer-2b-migrations.txt)
agree. Development governed cases, offers and supplied-fixture counts remain 0.

|Migration|SHA-256|
|---|---|
|0022|`5af2c09b31f1be6b537fba05b7af7c561e4b7e959849532bbed43a8d8de4205b`|
|0023|`9f7012c8ea6f9e0a32395fa9e569b6f83bff8bbbb7b36862e2a80523b4e82df9`|
|0027|`913fd147b09b959535fca2aeb4779ed60e41fe63057caba1f0b04fa97316add9`|

## Run locally

From `C:\proj\Grimoire\grim`:

```powershell
# Once on a fresh checkout (native source-built local object store):
pwsh -File scripts/install-local-tools.ps1 -ObjectStore
pwsh -File scripts/storage.ps1 -Task Init

pwsh -File scripts/dev.ps1 -Task DbUp
pwsh -File scripts/storage.ps1 -Task Up
pwsh -File scripts/dev.ps1 -Task Migrate
pwsh -File scripts/dev.ps1 -Task ExternalizeSources

# Separate terminals:
pwsh -File scripts/dev.ps1 -Task Api
pwsh -File scripts/dev.ps1 -Task Web

# Disposable synthetic storage/database reset and acceptance:
pwsh -File scripts/storage.ps1 -Task ResetTest
pwsh -File scripts/dev.ps1 -Task ResetTest
pwsh -File scripts/dev.ps1 -Task Harness
pwsh -File scripts/dev.ps1 -Task DbGuards
```

UI: `http://127.0.0.1:5173`; API: `http://127.0.0.1:8080`. Existing local Handler
tokens remain in ignored `.env`. Object credentials are in ignored
`.local/storage.env`; they are never frontend variables.

Docker Engine is now reachable. Attempted official MinIO image pulls were
unavailable and historical native binaries returned 410, so the real local server
was built from pinned official source. PostgreSQL's existing native cluster was
retained. [Pins, provenance, persistent paths and setup](object-storage.md).
Docker Compose execution of the object store remains untested.

## Changed files

- `api/src/storage.rs`, `main.rs`, `sources.rs`, `Cargo.toml`, `Cargo.lock`:
  private object client, integrity checks, version references and administrator
  externalization. `api/tests/source_guards.sql` updates database-boundary checks.
- `db/intake/0027_intake_source_objects.sql`: additive immutable references and
  constrained inline-to-object transition.
- `harness/storage.go`, `main.go`, `process.go`, `go.mod`, `go.sum`:
  real-store checks, scoped fault injection and subprocess credential isolation.
- `web/src/Evidence.tsx`, `evidence-api.ts`, `styles.css`: bounded permission
  revalidation, stale-response protection, content clearing and storage identity.
- `scripts/storage.ps1`, `install-local-tools.ps1`, `dev.ps1`: local runtime,
  pinned installation, private bucket policies, transfer and disposable reset.
- `README.md`, `api/README.md`, `harness/README.md`, `docs/ui-style.md`,
  `docs/object-storage.md`, `docs/layer-2b-api-contract.md`, this report and evidence.

## Remaining storage limits

No browser download URLs are issued; signed-URL expiry and revocation have not
been tested. No physical erasure, backup restore, WORM/Object Lock, lifecycle
retention, multi-node replication, cloud-S3 parity, encryption-at-rest/KMS or
disaster recovery is claimed. Successful process restarts do not demonstrate
restoring from backups.

The object PUT and PostgreSQL commit are separate operations. A failure between
them can leave an unreferenced private object version. Atomic rollback, orphan
cleanup and controlled crash injection at every upload/commit boundary remain
untested. Client-side clearing cannot retract copied bytes or guarantee browser
memory erasure; background-timer suspension and offline/late-response races were
not separately browser-simulated in this gate.

No supplier offers, sourcing-case promotion, AWS use/spend, deployment, supplier
contact or customer validation occurred.
