# Grimoire Layer 1 boundaries

Layer 1 captures Handler-provided product intake and its immutable revision history. These are draft statements, not qualified engineering facts, approved BOMs, supplier offers, prices, or sourcing approvals. A named Scion can be saved with every other field missing. Nothing fills the gaps automatically.

## One canonical database

Development uses `grimoire_dev` on PostgreSQL 17. The unchanged accepted `0022_grimoire_contract.sql` and `0023_grimoire_review_corrections.sql` establish the governed physical-sourcing contract. The new `0024_intake.sql` adds `grimoire.intake_*` tables in that same database and reuses the canonical organization/principal records. This additive migration is new work; it was not part of the GG-40 verification. Runtime credentials have only the permissions needed for intake. The API is not the database owner or superuser.

Additive `0025_intake_history_authors.sql` exposes only current directory names
of authors referenced in a visible Scion's revisions. The Rust history endpoint
first checks Scion visibility, then obtains names within the same authenticated
organization transaction. It returns those labels separately from immutable
snapshots and never grants the runtime direct principal-directory access. The
stored author principal ID remains the historical identity; a later directory
rename does not rewrite a revision or an idempotency receipt.

`grimoire_test` is a disposable verification database on the same local server, not a second product authority. Only that database receives the unchanged synthetic fixture. Reset tooling names this fixed target and never drops development data. No Mac or Paperclip database is imported or needed.

Accepted SQL is copied as raw bytes, guarded by SHA-256 checks before migration, and exempted from Git newline conversion. An applied-migration ledger rejects changed checksums. Run migrations from a single local administrator process; the setup runner is not a concurrent production migration orchestrator. If it is interrupted between a migration's COMMIT and recording its checksum, inspect the database before repairing the ledger; never blindly reapply or edit accepted SQL.

The first Layer 2 slice adds `0026_intake_sources.sql` after these migrations.
It links bounded synthetic UTF-8 source revisions and unverified manual claims
to an exact intake revision, with permission enforcement and terminal source
revocation. It uses new intake tables in the same canonical database and does
not claim GG-40 governed-source or S3 behavior. See the
[Layer 2 contract](layer-2-api-contract.md) and
[test commands](testing.md).

## Draft semantics

- `name` identifies the draft; the server assigns its UUID and revision number.
- `product_description` and `decision` use null for information not provided.
- `product_category` is physical, digital, or unspecified. It selects no vendors and grants no capabilities.
- `requirements` and `questions` distinguish null (not supplied) from an explicitly empty list (none reported by the Handler).
- Missing information and the next safe intake action are deterministic explanations, not agent guesses or qualification scores.
- Every successful write appends a complete immutable snapshot and audit event. Expected revision and idempotency guard the transaction.

Digital products stay intake drafts. Layer 1 does not implement digital vendor comparison or a digital procurement ontology.

## Later promotion to governed sourcing

Promotion is not implemented. A future reviewed migration/API would link the exact Scion draft revision to a new governed `sourcing_case_revision`; it would never rewrite an intake snapshot into an approved fact.

For the accepted physical path, a qualified human must confirm an authorized product configuration revision, exact approved BOM occurrence and manufacturer/orderable component revision, controlled requirement revision, and their common organization. A changed MPN, package, rating, material, requirement, or governed process must enter its appropriate substitution/change-control workflow. Source rights and domain-specific reviews must be established separately. The Grimoire API must check current authority, exact revisions, optimistic concurrency and idempotency in one transaction and retain explicit promotion provenance. Intake completeness alone is insufficient.

No promotion endpoint, approval button, sourcing state advancement, or implicit authority is provided by this slice.

## Paperclip integration boundary

Paperclip remains coordination infrastructure. The clone is a read-only architectural reference. No connector is implemented or enabled, and there is no Paperclip database dependency.

A future agent may submit a proposal through a scoped Rust endpoint with an authenticated agent principal, mapped Grimoire organization, Scion ID, base revision, idempotency key, source references, and Paperclip company/issue/agent/run provenance. Provenance strings cannot authenticate a caller. The API must deny any agent attempt to approve or promote a sourcing decision. Paperclip issue `done`, successful execution, and organizational approvals never confer Grimoire sourcing authority. Human acceptance would be a separate explicit action with its own exact-revision and authority checks.

Files inspected in the sibling Paperclip clone:

| Reference path | Boundary informed |
| --- | --- |
| `skills/paperclip/SKILL.md` lines 20, 105-126, 180-191, 299 | Agent context, assignment, checkout, task completion, and separation of action authorization |
| `packages/adapters/codex-local/src/server/execute.ts` line 892 | Task/run wake context |
| `server/src/middleware/auth.ts` lines 340-433 | Hashed keys/run JWTs and retained agent identity |
| `server/src/routes/authz.ts` lines 75, 157-194 | Company scope and hidden-resource responses |
| `server/src/routes/issues.ts` line 15011 | Self-checkout and required agent run identity |
| `server/src/services/issues.ts` lines 11368, 11533-11555 | Atomic checkout and conflicts |
| `server/src/routes/approvals.ts` line 286 | Human board approval is separate from issue completion |
| `server/src/services/documents.ts` line 172 | Immutable document revision retrieval |

## Deliberately deferred

Production authentication and deployment, MCP transport, worker/outbox processing for governed sourcing, S3 source evidence, supplier contact, price normalization, governed approvals, and Paperclip connector work are outside Layer 1. Local bearer credentials are development-only and generated into ignored `.env`; they are not production sign-in. No customer validation or production-readiness claim follows from these tests.
