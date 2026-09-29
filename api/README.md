# Grimoire draft intake API

This Rust crate implements draft intake, synthetic source/claim storage, exact
physical-scope binding and two-offer normalization. Separate enrolled synthetic
reviewers confirm scope and normalization into existing GG-40 tables. Source
claims remain unverified; no sourcing/commercial approval, RFQ or Paperclip work
is created. Additive intake migrations are not part of verified GG-40 v2.2.1.
The repository root README contains database provisioning and startup commands.

See the current [physical scope contract](../docs/layer-3-api-contract.md),
[offer/comparison contract](../docs/layer-4-api-contract.md), and
[Codex task-control contract](../docs/worker-controls-api.md).

The HTTP executable requires `DATABASE_URL` for the dedicated `grimoire_intake_app`
login, PostgreSQL 17, and the explicit `GRIMOIRE_S3_*` settings documented below.
`GRIMOIRE_BIND` defaults to `127.0.0.1:8080`; non-loopback
binds and privileged/table-owning runtime roles are rejected. Migrations are an
explicit administrator operation, never performed automatically by the API.

## HTTP contract

Ordinary browser requests use an opaque HttpOnly `grimoire_session` cookie.
PostgreSQL stores only its SHA-256 digest and accepts an active organization only
through a live Handler membership joined to an enabled organization-scoped
principal. Session writes require the same-origin `X-Grimoire-CSRF: 1` marker.
The legacy `Authorization: Bearer <local token>` path remains available for
the development harness and local adapters. Cookie-authenticated workspace
requests must include `X-Grimoire-Organization` matching the session's active
organization. A mismatch returns `409 ACTIVE_ORGANIZATION_CHANGED`; this header
checks displayed context and never selects or grants access to an organization.
This local identity/session mechanism is not a production identity integration.

| Method | Path | Success |
|---|---|---|
| GET | `/api/health` | Actual database name, PostgreSQL version and runtime role |
| GET | `/api/setup/status` | Whether the one-time local installation owner is still unconfigured |
| POST | `/api/setup/owner` | `201 SessionState` + HttpOnly cookie; unauthenticated first-use only |
| POST | `/api/session/login` | `200 SessionState` + HttpOnly cookie |
| GET / DELETE | `/api/session` | Read the Handler/membership state or revoke the current session |
| POST | `/api/organizations` | `201 SessionState`; atomic creation; requires `Idempotency-Key` |
| POST | `/api/session/active-organization` | Checked membership switch; returns `SessionState` |
| GET | `/api/me` | Current principal, organization, display names, sourcing `can_write` and separate `can_manage_workspace` |
| GET | `/api/scions` | `{ "scions": [Scion] }`, current organization only |
| POST | `/api/scions` | `201 Scion`, requires `Idempotency-Key` |
| GET | `/api/scions/{id}` | `200 Scion`, `ETag: "N"` |
| GET | `/api/scions/{id}/revisions` | `{ "revisions": [Revision], "authors": [HistoryAuthor] }`, newest first |
| GET | `/api/scions/{id}/revisions/{N}` | Historical `Revision`, `ETag: "N"` |
| POST | `/api/scions/{id}/revisions` | `201 Scion`, requires `If-Match: "N"` and `Idempotency-Key` |

Create and revision writes accept complete snapshots:

```json
{
  "name": "Sensor enclosure",
  "product_description": null,
  "product_category": "unspecified",
  "decision": null,
  "requirements": null,
  "questions": null,
  "change_summary": "Initial intake"
}
```

Only a nonblank name is required. Category is `physical`, `digital`, or
`unspecified`. Null lists mean not reported; empty arrays mean explicitly none
reported. Unknown fields are rejected. Snapshots preserve Handler input and
derive missing-information messages without inventing content. Product
description is limited to 12000 characters, decision to 4000, name to 160,
summary to 1000, and each list to 100 nonempty entries of at most 2000 characters.

`Scion` contains `id`, `current_revision`, `revision`, `missing_information`,
`next_safe_action`, and `category_notice`. Each revision adds `number`,
`created_at`, and `created_by` to the intake fields. A digital draft explicitly
reports that digital vendor comparison is unavailable.

`HistoryAuthor` contains `principal_id` and `display_name`. These names come from
the current organization directory; they are display metadata outside the
immutable revision snapshots, not historical name attestations. The revision's
`created_by` principal ID remains its stable author identity. Directory renames
therefore do not rewrite snapshots or stored idempotent responses. Migration
`0025` adds a narrowly scoped database helper returning only authors of the
requested Scion in the authenticated organization. The runtime has no direct
principal-directory access. Hidden or unknown Scions still return the same 404
before any author metadata is queried, within the same authenticated transaction.

Errors use `{ "error": { "code": "...", "message": "..." } }`. Invalid
credentials return 401; insufficient same-organization write role 403; hidden or
unknown Scions 404 (including history and writes); invalid intake 422; missing
`If-Match` 428; stale edits 412; and conflicting idempotency-key reuse 409.
Scion intake creation/revision permits workspace managers (`org_admin`) and
`procurement_preparer`. Source, scope, offer, engineering, commercial, and
approval operations do not inherit authority from `org_admin`; they continue to
require their explicit role/enrollment boundaries.

## Persistence and concurrency

Each request authenticates against PostgreSQL, then sets organization, principal,
and request identity with transaction-local `set_config(..., true)`. Commit or
rollback discards that context before a pooled connection can be reused. RLS
checks enabled organization membership, with role checks for writes. The
runtime has no direct access to credential rows or governed sourcing tables.
Database provisioning also removes runtime `TEMPORARY` and `CREATE` privileges
and denies creation in `public`, `grimoire`, and `app`. This is required: legacy
GG-40 trigger functions retain some PUBLIC execute privileges, so the runtime
must never be able to attach them to a table it creates. Supplemental database
checks assert this boundary and attempt actual temporary-table creation.

Writes acquire a transaction advisory lock on organization/principal/idempotency
key; revisions additionally lock the Scion row and compare the base revision in
the same transaction. The request fingerprint binds method, path, base revision,
and the parsed full snapshot. JSON property order is immaterial. Reusing a key
for an equivalent parsed request returns the original status, body bytes, and
ETag with `Idempotency-Replayed: true`, even after subsequent revisions. A key
with different contents, path, or base returns 409. Keys are scoped to the
authenticated principal and organization.

Revision rows, retry receipts, and audit events reject updates and deletes.
Database triggers enforce sequential revisions and atomically advance the
current pointer and append audit metadata. The response and retry receipt
commit together. There is no approval endpoint and no task-completion hook.

## Synthetic draft sources (migration 0026)

Migration `0026` adds `intake_sources`, immutable `intake_source_revisions`,
immutable `intake_source_claims`, and terminal immutable
`intake_source_revocations` in the same canonical PostgreSQL database. These
tables are additive intake records, not the verified GG-40 governed source
objects. The original Scion revision is pinned when a source is linked;
subsequent source revisions do not rewrite that Scion or its history.

See [the complete Layer 2 contract](../docs/layer-2-api-contract.md) for request
and response fields. The routes under `/api/scions/{id}/sources` support linking
a synthetic UTF-8 source, reopening it, appending source revisions, recording
one Handler-entered claim per exact revision, and revoking access. All writes
require a Handler role and an idempotency key. Linking requires the current
Scion `If-Match`; source revisions and revocation require the current source
`If-Match`. Claim creation names an immutable source revision in its path.

Every source must explicitly attest `synthetic: true`, `rights_status: granted`,
a nonblank permission basis, and `permitted_use: scion_review`. Missing, null,
denied, or incompatible rights return 403 before content hashing or storage.
This attestation permits local draft review; it is not an independent rights
verification or evidence approval. Source text is limited to 32000 exact UTF-8
bytes, with no normalization; the server computes its SHA-256, uploads it, and
verifies that exact S3 object version by download before storing the matching
PostgreSQL revision/reference identity. Metadata limits are 160 characters
for title, 2000 for origin, 300 for owner, 4000 for permission basis, and 1000 for
change summary. NUL characters and blank required strings are rejected.

A manual claim is limited to 4000 characters and has a nonempty half-open
zero-based UTF-8 byte interval plus its exact quote. Rust checks the interval
against the exact version's hash-verified source bytes; PostgreSQL checks
structural bounds and immutable identity without an inline text fallback. A second
distinct claim for that revision returns 409. Claim identity, authority
`handler_entered`, and verification status `unverified` are immutable. Unknown
fields attempting to set approval, verification, hashes, or other authority
are rejected. Automated extraction is not implemented and verified facts remain
an empty set; neither source text nor a manual claim is promoted into a fact.

Revocation is terminal for one source. Its immutable audit event leaves historical
permission attestations intact but blocks later source-content, source-history,
claim reads and content/claim writes, including idempotent retries. List responses
retain only metadata, the revocation reason and claim count for organization
audit; they contain no source text, claim statements or quote. Safe creation
receipts and revocation receipts can be retried because they contain only IDs,
numbers and status. A receipt cannot restore rights. Revocation cannot retract
bytes that a client previously viewed or copied.

Source content reads acquire a share lock through a narrowly scoped database
helper. Content/claim writes and revocation acquire a source row update lock;
permission is rechecked in a separate statement after obtaining that lock so a
revocation committed during a wait cannot be missed by a stale query snapshot.
Reads therefore serialize with revocation and source writes. RLS separately
hides foreign organization records and revoked content; the summary helper
returns only bounded audit metadata. Source pointers and Scion links have no
runtime update privilege. Fixed database triggers advance the source pointer
atomically and enforce a first revision in the creation transaction.

## Private versioned source storage (migration 0027)

Layer 2B stores bounded source bytes in a private versioned S3-compatible bucket;
PostgreSQL stores immutable revisions, object bucket/key/version identity,
SHA-256, byte length, rights, claims and locators. Each content read fetches the
recorded object version and verifies its identity, length, SHA-256 and UTF-8 before
source text or claim quotes can be returned or processed. Metadata lists do not
claim content verification. Responses containing validated source bytes add
`storage_backend`, `object_bucket`, `object_key`, `object_version_id`, and
`content_hash_verified: true`. These identifiers are not download URLs and hash
verification does not establish a verified fact or evidence approval.

Set `GRIMOIRE_S3_ENDPOINT`, `GRIMOIRE_S3_REGION`, `GRIMOIRE_S3_BUCKET`,
`GRIMOIRE_S3_ACCESS_KEY`, and `GRIMOIRE_S3_SECRET_KEY` explicitly. The endpoint
must be HTTP loopback for this local slice; no ambient AWS credentials or cloud
fallback are used. Source operations have bounded timeouts and streaming size.
Missing versions, corruption, unavailable storage, or legacy rows without object
references return 503 without source text or claim quotes. There is no PostgreSQL
fallback and no object-delete or public/signed-URL code in the API.

The administrator command `grimoire-api.exe externalize-sources` uses a table-owner
`DATABASE_URL` and the normal S3 settings. It locks each legacy source, checks its
original exact bytes, uploads and verifies the resulting pinned version, records
the immutable reference, and nulls the active inline text in a guarded database
transaction. Every semantic revision, timestamp, author, claim, right and
revocation stays unchanged. The HTTP runtime cannot invoke the database export
helper. This logical transition does not erase WAL, backups, disk pages or copies
that clients already made. A failed database commit after upload can leave a
private orphan version; automatic cleanup is not implemented.

See [the full Layer 2B contract](../docs/layer-2b-api-contract.md) for error codes,
locks and remaining boundaries. Object Lock/legal holds, physical erasure,
retention policy enforcement, backup/restore, atomic cross-store crash recovery,
production AWS and internet/TLS deployment remain outside this local slice.

Run `cargo test`, `cargo fmt --check`, and `cargo clippy -- -D warnings` in this
directory. `tests/database_guards.sql` adds rollback-only SQL privilege and
immutability checks in the disposable `_test` database, and
`tests/source_guards.sql` extends those checks to synthetic sources, claims,
rights and revocations. The separate Go harness is the live HTTP/PostgreSQL
acceptance suite, including process restart.

## OS control surface

`GET /api/workspace` returns organization-scoped Scions, content-free proposal
summaries, existing Rust task state, watch reviews, events and monitoring health.
It uses the authenticated PostgreSQL RLS transaction, not client-side filtering.
Proposal/task/review/event collections each contain at most the newest 300 rows.
No source text, derivative inputs, task leases or credentials are included.
There is no workspace mutation endpoint. See [company navigation and API
boundaries](../docs/company-workspace.md).

`GET /api/scions/{id}/control-surface` returns the authenticated, read-only case
graph (`nodes[]`, `edges[]`), persisted internal Watchtower health, required human
reviews and existing Rust task state. PostgreSQL records revision, permission
and outcome changes transactionally; a Rust background check advances durable
watch heartbeats independently of browser polling. Restricted/stale derivative
content is withheld, and agent completion cannot approve a case.

Agent profiles, skills and task assignments are native Rust/PostgreSQL records.
`/api/agents` and `/api/skills` provide authenticated, Handler-managed revisioned
configuration; native task assignment pins exact instruction and skill snapshots.
The existing worker reports authenticated presence and consumes those snapshots.
No Paperclip process, credentials or company mapping are used.
See [native API fields and constraints](../docs/native-agents.md) and
[control-surface architecture](../docs/control-surface.md).
