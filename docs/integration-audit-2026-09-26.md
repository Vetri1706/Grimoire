# Grimoire integration audit — 2026-09-26

## Result and limits

The available GG-46 implementation branch was merged into the new local branch
`integration/grimoire-authority-20260926`. This is a partial integration, not a
Stage A acceptance result. GG-54, GG-53/0037, GG-57 and GG-58 source material is
unavailable on this machine and from the configured Grimoire origin. Stage B
has not started. No missing code or migration was reconstructed.

The integration branch requires migration 0034 at API startup. The development
and disposable test databases still have migrations through 0033. No migration
was applied in this audit; this branch is not a verified running application.

## Repositories and worktrees inspected before changes

| Repository | Initial branch and head | Worktrees | Initial working tree |
| --- | --- | --- | --- |
| `C:\proj\Grimoire\grim` | `main`, `9f6d36c9266d30fcddfda1508ed2fcbede2b8df1` | Only the named checkout | Clean |
| `C:\proj\Grimoire\paperclip` | `master`, `bd203093235b28631760a76b602b35028322e06f` | Only the named checkout | Seven tracked modifications and three untracked files |

Grimoire origin is `https://github.com/Vetri1706/Grimoire.git`; Paperclip origin
is `https://github.com/paperclipai/paperclip`. Grimoire's advertised remote heads
were `main`, `master`, and `gg46-synthetic-two-offer-authority-gate`. Its remote
default is `master` at `226c01c4d98b0257e7cc1f965d1f42c707ada920`.
Paperclip has one local branch, `master`; its upstream application branches were
not merged into Grimoire. No `Grimoire-GG49-v2` checkout was identified among the
inspected repositories or their registered worktrees.

The Paperclip working changes were preserved byte for byte:

- `packages/adapter-utils/src/server-utils.ts`
- `packages/paperclip-runner/runner/crates/runner-core/src/generated_acpx_sidecar_contract.rs`
- `packages/paperclip-runner/src/drivers/acpx/generated-sidecar-contract.ts`
- `packages/paperclip-runner/src/protocol/generated/schema-bundle.ts`
- `packages/paperclip-runner/src/protocol/generated/standalone-validators.ts`
- `packages/shared/package.json`
- `server/src/__tests__/codex-local-adapter-environment.test.ts`
- Untracked `package-lock.json`
- Untracked `packages/adapter-utils/src/server-utils.windows.test.ts`
- Untracked `packages/shared/scripts/copy-cliplab-assets.mjs`

Before/after status and SHA-256 comparisons found zero differences. Local audit
snapshots are in ignored `.local/integration-audit-20260926/`.

## Available implementation provenance

`origin/gg46-synthetic-two-offer-authority-gate` is a **Grimoire** branch.
Its commits include Paperclip co-author attribution; they are not changes to
the Paperclip application repository.

- Common base: `226c01c4d98b0257e7cc1f965d1f42c707ada920`
- Source implementation: `1160f06963117a072c975d6df57ff695e35a860d`
- Harness invocation correction: `50fc841d29bfe9054a8c406e4f01619dba005d75`
- Evidence report: `78ded2449db0963f877dbbe4c973c7d0a99c61d1`
- Source head: `e877e648a75d2a2ee6d1b7810cbd69ee9d7ea168`
- Original local main: `9f6d36c9266d30fcddfda1508ed2fcbede2b8df1`
- Resulting merge: `fde9095965d1bf1e3c0d25f9dc0c93c999cc107d`

The merge has the original main and source head as its two parents. Both are
verified ancestors of the result. All four source commits were absent from
original main. Their files do not overlap the theme commit, so the merge had
no conflicts. Original main, all source commits and the remote source branch
were retained. No history was rebased, reset, squashed or deleted.

Source branch changed files:

- `README.md`
- `api/src/main.rs`
- `db/intake/0034_sourcing_authority_gate.sql`
- `docs/evidence/gg46-harness-2026-09-26.json`
- `docs/gg46-synthetic-two-offer-evidence.md`
- `fixtures/gg46-two-offer.json`
- `harness/README.md`
- `harness/gg46/main.go`
- `scripts/dev.ps1`

The source migration 0034 SHA-256 is
`e2f6b91136c7080b50bec92a0a68ce6126b01e243c48615f02f04c1a49508992`.
The source fixture SHA-256 is
`21adf081282aa051c3e2db45a511247065b524c3d94d3bfdf24208aecd04f2e2`.
These match the merged files. All previously present SQL files retain their
original bytes, including accepted 0022, 0023 and the supplied fixture.

## Missing Stage A sources

`git cat-file -e <sha>^{commit}` failed for every following commit in **both**
local repositories. `git fetch origin <sha>` from Grimoire then failed for each
with exit 128 and `upload-pack: not our ref`:

| Referenced work | Missing commit |
| --- | --- |
| GG-54 corrected startup code | `edc0d2080e01c2138c8a16946a2c787d70a862c3` |
| GG-54 evidence | `504748a31ddcc4b535ef5cd5a4ac6b86c4016eaf` |
| GG-53 implementation | `6748bf733c0f8afbfe6605073812e5925093fdec` |
| GG-53 evidence reviewed by GG-58 | `72e05dc74669030d52a16686e102d438f03dae4c` |

The local Paperclip server is reachable, but GET `/api/issues/GG-54`,
`/api/issues/GG-57`, `/api/issues/GG-53` and `/api/issues/GG-58` each returns
HTTP 404, `Issue not found`. Its company inventory reports a Grimoire company
with issue prefix **GRI**, containing the onboarding task GRI-1; it does not
provide the referenced GG task records.

GET `http://localhost:3100/api/attachments/ea6f05cf-e44d-445e-93e5-a32b8a2aefcb/content`
returns HTTP 404, `Attachment not found`. No patch for these commits was supplied
in this task or found in the inspected project/Downloads locations. Therefore
no patch bytes, declared patch hashes, or reconstructed commit identities could
be verified. Migration 0037 and the cited `api/src/approvals.rs`,
`api/src/error.rs`, and `api/tests/approval_actor_guards.sql` are unavailable.
The available branch stops at migration 0034; 0035 and 0036 are also unavailable.

Consequently, overlap between the actual GG-54 and GG-53 edits to `main.rs` and
their authority functions cannot be reviewed. GG-57's actual verdict has not
been read. GG-58's same-name replacement, HTTP audit-context and HTTP mapping
findings are user-reported context, not findings independently reproduced here.
GG-54 verification through 0036 must not be described as verification of 0037.

## Review of the available authority boundary

0034 adds immutable, tenant-bound synthetic authority reviews and decision
receipts, distinct commercial-review/preparer identities, exact selected inputs,
source-access checks, and idempotency. A positive synthetic result remains draft.
The merge retains those protections and the existing theme behavior.

Code review also identifies unresolved concerns in this older line:

- Actor identity is based on application session GUCs and role records; there
  is no authenticated approval-session proof in 0034.
- The deferred decision trigger's fallback requires an active commercial grant,
  despite a comment describing a fully granted three-domain chain. The existing
  0023 approved-state guard is a separate check.
- Currentness checks cover the selected offer, exact supplied IDs, artifact
  validity and source access, but do not independently prove rejection of a
  newly created source/configuration/case/requirement revision. The focused
  harness's wrong-ID and older-offer tests do not establish those cases.
- The focused GG-46 harness uses direct PostgreSQL calls, not authenticated Rust
  HTTP routes. Its original report is 14/14 on PostgreSQL 15.18/macOS.

These are review concerns, not a reproduced exploit report. They must be
reconciled with the actual later migrations and reviews rather than guessing
replacement 0037 code or rewriting applied SQL.

## Checks actually executed on the merge

- `cargo test --manifest-path api/Cargo.toml --locked`: **14 passed**.
- `npm.cmd --prefix web run build`: TypeScript and Vite production build passed.
- `.tools/go/bin/go.exe -C harness test ./gg46`: package compiled; **no test files**.
- `.tools/go/bin/go.exe -C harness vet ./gg46`: passed.
- `pwsh -NoProfile -File scripts/dev.ps1 -Task VerifySql`: all three supplied
  SQL/fixture hashes passed.
- Native PostgreSQL started successfully and reported **17.11**. Read-only
  migration-ledger inspection found 0022–0033 in both `grimoire_dev` and
  `grimoire_test`. No database was reset and no fixture or migration was applied.
- Source ancestry, unchanged existing SQL bytes and unchanged Paperclip working
  bytes/status were verified.

No new real-HTTP, clean-install, upgrade, approval-session, GG-57 re-review or
GG-58 regression result is claimed. Those Stage A checks require the missing
source line. This audit does not repeat the earlier 105-check HTTP acceptance
run or turn the source branch's historical 14-check result into a current pass.

## Resume boundary

To complete Stage A, supply an accessible remote or Git bundle containing the
four exact commits and their ancestor migrations, or the original patches plus
their manifests/hashes and base tree. Also supply GG-57's actual verdict and
GG-58's full review/evidence. Verify that material before reconciling startup
attestation with 0037, fixing the findings additively, and testing clean and
upgraded PostgreSQL 17 plus real Rust HTTP routes on one resulting head.

Stage B is the subsequently requested product capability-plan and connector
flow, demonstrated with a digital website Scion while preserving physical
workflow. It remains unstarted until Stage A passes. Agent completion must
remain distinct from human approval. No deployment, RFQ, supplier contact or
customer-validation claim was made.
