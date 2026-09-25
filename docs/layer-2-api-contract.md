# Layer 2 first slice: synthetic draft sources

Implementation contract for this local slice. These are additive draft records,
not GG-40 governed source objects or approved evidence. Source bytes live as
bounded UTF-8 text in PostgreSQL for this synthetic slice; no S3 substitute is
claimed. No governed sourcing records are created.

All routes below start with `/api/scions/{scion_id}` and authenticate using the
existing organization-scoped local Handler credentials. Foreign and unknown
resources return the same 404 body without resource headers. Writes require a
Handler role and `Idempotency-Key`. New source links require `If-Match` for the
current Scion revision; source revision and revocation writes require `If-Match`
for the current source revision. Claims name an exact immutable source revision.

## Request and response shapes

- `GET /sources`: `{sources: SourceSummary[], verified_facts: [], extraction_status: "not_implemented"}`.
- `POST /sources`: SourceInput; 201 `{source_id, number: 1}` and ETag.
- `GET /sources/{source_id}`: `{source: SourceSummary, revisions: SourceRevision[], claims: Claim[]}`. Revoked content returns 403.
- `POST /sources/{source_id}/revisions`: SourceInput; 201 `{source_id, number}` and ETag.
- `GET /sources/{source_id}/revisions`: `{revisions: SourceRevision[]}`; revoked content returns 403.
- `GET /sources/{source_id}/revisions/{number}`: SourceRevision; revoked content returns 403.
- `GET /sources/{source_id}/revisions/{number}/claims`: `{claims: Claim[]}`; revoked content returns 403.
- `POST /sources/{source_id}/revisions/{number}/claims`: `{statement, locator: {start_byte, end_byte, quote}}`; 201 `{claim_id, source_id, source_revision}`. One Handler-entered claim per source revision in this slice; a second distinct claim returns 409. Exact retries replay the original receipt.
- `POST /sources/{source_id}/revoke`: `{reason}`; 201 `{source_id, rights_status: "revoked"}`. Revocation is terminal for this source in this slice; repeats with the same key replay safely.

`SourceInput`:

```json
{
  "title": "Synthetic enclosure note",
  "origin": "synthetic://handler/enclosure-note",
  "owner": "Local Handler",
  "synthetic": true,
  "source_text": "Synthetic note: enclosure target is 120 mm.",
  "rights_status": "granted",
  "permission_basis": "I authored this synthetic test note and permit local review.",
  "permitted_use": "scion_review",
  "change_summary": "Initial synthetic source"
}
```

Only `synthetic: true` is accepted. Missing/denied rights, absent permission basis,
or a use other than `scion_review` return 403 without storing/processing content.
The input hash is never trusted: the API computes lowercase SHA-256 over the exact
UTF-8 source text without normalization. Unknown request fields are rejected.

`SourceSummary` has `id`, `scion_id`, `scion_revision`, `current_revision`, `title`,
`origin`, `owner`, `content_sha256`, `rights_status` (`granted` or `revoked`),
`permitted_use`, `permission_basis`, `synthetic: true`, `claim_count`, and
`revocation_reason` (null unless revoked). It contains no source/claim text or
locator quote. Revoked metadata stays available to this organization's Handler
for audit; access to content and claims is blocked. The original Scion revision
is pinned when the source is linked; intake snapshots are not rewritten.

`SourceRevision` contains `source_id`, `number`, all SourceInput fields,
`content_sha256`, `byte_length`, `created_at`, and `created_by`. It is immutable.
Its recorded rights status is a historical attestation, not effective current
permission; source-level revocation is checked before reads and processing.

`Claim` contains `id`, `source_id`, `source_revision`, `statement`, `locator`,
`authority: "handler_entered"`, `verification_status: "unverified"`, `created_at`,
and `created_by`. A locator is a zero-based half-open UTF-8 byte interval plus the
exact quote. The API validates boundaries, nonempty range, and exact matching
bytes. No claim endpoint can set verification or approval state. Manual claims,
source text, automated extraction (not implemented), and verified facts (none)
remain distinct.

Revocation and concurrent content/claim writes serialize on the source row.
Rights checks happen before replaying content/claim operations. Mutation receipts
contain only identifiers, revision numbers, and status, never source/claim text.
Replaying a source-create receipt cannot process content or restore rights.
All responses use `Cache-Control: no-store`. Revocation cannot retract bytes
already viewed or copied by a client; it prevents subsequent API access.

## Remaining object-storage checks

No object-storage client or emulator is exercised. S3 upload/download integrity,
immutable object versions, signed-URL authorization/expiry, revocation of access
to existing links, Object Lock/legal holds, retention and erasure/tombstones,
backup/restore, orphan cleanup, and database/object-store atomicity and crash
recovery remain untested. Docker Compose availability alone would not establish
any of these behaviors; each needs an explicit storage implementation and tests.
