# Layer 2B: private versioned source bytes

This extends the [synthetic-source contract](layer-2-api-contract.md). It does not
promote a Scion, grant evidence approval, create verified facts or supplier offers.
All existing authentication, organization hiding, source locks, revocation,
idempotency and exact UTF-8 locator rules continue to apply.

## Storage and response identity

The Rust API writes bounded source bytes to a private S3-compatible bucket. It
requires a non-null object version identifier from PUT, then GETs that exact
version and verifies every byte against the locally computed SHA-256 and length
before committing the PostgreSQL revision, immutable object reference, and
idempotency receipt. Object keys use
`org/{org}/sources/{source}/revisions/{number}/{random UUID}.txt`.

Every source revision content response adds:

```json
{
  "storage_backend": "s3",
  "object_bucket": "grimoire-sources-dev",
  "object_key": "org/.../sources/.../revisions/1/....txt",
  "object_version_id": "the exact S3 version ID",
  "content_hash_verified": true
}
```

These are identifiers, not download URLs. No public or signed URL is generated.
`content_hash_verified: true` means the bytes fetched for this response matched
their stored SHA-256 and length. It does not establish truth, authorship, rights
verification, or evidence approval. Metadata-only source summaries make no
content-hash verification claim.

Every content read GETs the recorded version, regardless of newer versions at the
same key. Rust verifies response version identity, length, SHA-256, UTF-8 validity
and bounded streaming before returning source text. Source-detail/history reads
verify all requested revisions before returning any claims. Claim reads and
creation verify their exact source revision before returning/processing claim
text or quote. Existing source share/update locks remain held through the
verification, so API revocation serializes against content access and processing.
Revocation itself remains available if object storage is offline.

Storage is explicitly configured with `GRIMOIRE_S3_ENDPOINT`,
`GRIMOIRE_S3_REGION`, `GRIMOIRE_S3_BUCKET`, `GRIMOIRE_S3_ACCESS_KEY`, and
`GRIMOIRE_S3_SECRET_KEY`. This local slice accepts only an HTTP loopback endpoint.
There is no ambient AWS credential discovery or cloud endpoint fallback. The
API has no object-delete code. Bucket policies must separately restrict its
credentials to the documented read/version-read/write operations.

Requests use a one-second connect timeout, a three-second HTTP timeout, no
implicit retries, and a five-second bound on each full streamed operation.
Source text remains limited to 32000 UTF-8 bytes. No PostgreSQL inline-text
fallback is used, including when storage is unavailable.

## Fail-closed responses

Existing 403 rights and 404 organization-hiding behavior takes precedence over
storage access. Storage failures return 503 with no source text, claim statement,
quote or locator in the error response:

| Error code | Meaning |
|---|---|
| `SOURCE_STORAGE_MIGRATION_REQUIRED` | A legacy revision has no external object reference. |
| `SOURCE_OBJECT_MISSING` | The recorded object version is missing. |
| `SOURCE_STORAGE_UNAVAILABLE` | Transport, timeout, authorization or provider failure. |
| `SOURCE_INTEGRITY_FAILED` | Version, length, SHA-256 or UTF-8 validation failed. |

A provider can detect corruption before returning bytes; that produces a storage
failure instead of the Rust hash-mismatch code. Neither failure returns content.
Creation receipts remain identifiers-only; replaying a successful create does
not upload another object. A failed request before the PostgreSQL commit can
leave an unreferenced private version; automatic orphan cleanup is not implemented.

## Additive migration and legacy export

`0027_intake_source_objects.sql` adds immutable object references with same-org,
revision, hash and byte-length foreign-key identity. It permits a single guarded
table-owner transition from non-null inline source text to null, with every
semantic revision column unchanged. New revision inserts require an exact object
reference and null inline text. The API runtime cannot update/delete references
or invoke the administrator export helper.

After applying `0027`, run `grimoire-api.exe externalize-sources` with the table
owner's `DATABASE_URL` and the destination bucket's normal S3 credentials. The
command takes the source update lock, checks the original PostgreSQL bytes
against the immutable hash/length, uploads, verifies the exact returned version,
records the immutable reference and removes the active inline copy in one
PostgreSQL transaction. A failed upload/verification leaves PostgreSQL unchanged.
Rerunning the completed command exports zero rows. It can preserve revoked
historical sources without reinstating permission or making content API-readable.

This is a logical removal of active inline source text, **not physical erasure**:
WAL, backups, old disk pages and already copied client content are not erased.
Claims remain separate immutable PostgreSQL records; the API still withholds
their text/quote when source rights or object verification fail.

PostgreSQL checks object-reference identity, immutability, rights, organization
scope and structural locator bounds. Exact quote-to-source matching now belongs
to the Rust API after verified object retrieval. Database-only guard tests must
not be described as proving object existence or content integrity.

## Remaining guarantees

Ordinary bucket versioning preserves previous versions against runtime writes;
it is not administrator-proof WORM retention. Object Lock/legal holds, physical
erasure, retention policy enforcement, encrypted backups/restore, replication,
atomic cross-store crash recovery, orphan cleanup, production AWS behavior and
internet/TLS deployment remain outside this slice. No expiring URL behavior is
claimed because the API does not issue URLs.

Implementation uses Apache's
[object_store S3 client](https://docs.rs/object_store/0.14.2/object_store/aws/struct.AmazonS3Builder.html)
and its [version-specific GET interface](https://docs.rs/object_store/0.14.2/object_store/struct.GetOptions.html).
