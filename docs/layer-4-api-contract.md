# Layer 4: synthetic offer intake and exact comparison

All requests use the existing Rust API and canonical PostgreSQL database. This
slice accepts synthetic material only. It creates no RFQ, supplier contact,
decision, sourcing approval, or recommendation of a winning supplier.

Every POST requires `Idempotency-Key`. Offer create and comparison proposal or
confirmation use `If-Match` containing the current quoted Scion revision.
Offer revision POST uses its current quoted offer revision number and includes
`scion_revision` in the body. Foreign Scions, offers and proposals return 404.

## Offer routes

- `GET /api/scions/{id}/offers` returns `{offers: [...], synthetic_only:true}`.
- `POST /api/scions/{id}/offers` creates an immutable initial submission.
- `GET /api/scions/{id}/offers/{offer}` returns one offer and `revisions`.
- `POST /api/scions/{id}/offers/{offer}/revisions` appends an immutable revision.

Offer input (all keys shown; nullable commercial fields permit an explicitly
incomplete submission, which remains excluded and is never fabricated):

```json
{
  "synthetic":true,
  "scion_revision":4,
  "scope_proposal_id":"CONFIRMED-SCOPE-UUID",
  "supplier":{
    "legal_name":"Synthetic Supplier A",
    "jurisdiction":"SYNTHETIC-US-DE",
    "registration_ref":"SYN-A-UNIQUE",
    "site_code":"SYN-SITE-A",
    "country_code":"US",
    "account_ref":"SYN-ACCOUNT-A"
  },
  "source":{
    "source_id":"SOURCE-UUID","source_revision":1,"claim_id":"CLAIM-UUID",
    "content_sha256":"64-lowercase-hex","start_byte":0,"end_byte":150
  },
  "offer_ref":"SYN-QUOTE-A",
  "identity_match":"exact",
  "offered_manufacturer":"Synthetic manufacturer",
  "offered_part_number":"SYN-PART-001",
  "quantity":"2","uom":"EA","unit_price":"12.50",
  "currency":"USD","destination":"Synthetic test lab",
  "incoterm":"EXW","payment_terms":"Synthetic net 30",
  "quoted_at":"2026-09-26T00:00:00Z",
  "valid_from":"2026-09-26T00:00:00Z",
  "valid_until":"2026-10-26T00:00:00Z",
  "lead_time_days":7,
  "change_summary":"Record this explicitly synthetic quote"
}
```

`supplier`, `source`, scope UUID, offer reference and change summary are required.
`identity_match` is `exact` or `ambiguous`. `offered_manufacturer`,
`offered_part_number`, quantity, UOM, price, currency, destination, incoterm,
payment terms, quote/validity timestamps and lead time may be null to explicitly
record missing data. Blank supplied strings and invalid decimal/date values are
rejected. Wrong or ambiguous parts may be recorded; they cannot be comparable.

An offer view has `id`, `scion_id`, `current_revision`, and `revision` containing
`id` (the immutable **submission revision UUID** used in comparison input),
`number`, `input` (nullable after loss of access), `created_by`, `created_at`,
`missing_fields`, `governed_offer_revision_id` and `governed_offer_line_id`
(null until complete), `blockers`, and `content_redacted`.
History contains these same revision objects. Supplier identity is fixed across
revisions. Duplicate source hash+offer content is rejected unless replaying the
original idempotency key. Two different suppliers must cite their own source.

Complete submissions populate existing GG-40 supplier identity, source,
offer-revision and offer-line tables. Incomplete submissions are explicitly
staging records, not fake GG-40 offers. The governed source references the actual
private S3 bucket/key/version/hash/length and links the original intake source.
Revocation appends a governed source-access revocation and invalidates derived
artifacts; original intake/source histories remain unchanged.

## Comparison routes

- `GET /api/scions/{id}/comparisons` returns `{proposals:[...],can_confirm:boolean,
  can_propose:boolean,synthetic_only:true}`.
- `POST /api/scions/{id}/comparisons/proposals` stores an immutable normalization
  proposal and deterministic comparison snapshot.
- `GET /api/scions/{id}/comparisons/proposals/{proposal}` reads one proposal.
- `POST /api/scions/{id}/comparisons/proposals/{proposal}/confirm` accepts
  `{"confirm_synthetic_normalization":true,"review_note":"Explicit rationale"}`.

```json
{
  "synthetic":true,
  "scope_proposal_id":"CONFIRMED-SCOPE-UUID",
  "offer_revision_ids":["SUBMISSION-REVISION-A-UUID","SUBMISSION-REVISION-B-UUID"],
  "basis":{
    "quantity":"2","uom":"EA","currency":"USD",
    "destination":"Synthetic test lab","incoterm":"EXW",
    "payment_terms":"Synthetic net 30",
    "as_of":"2026-09-26T00:00:00Z",
    "valid_from":"2026-09-26T00:00:00Z",
    "valid_until":"2026-10-01T00:00:00Z"
  },
  "change_summary":"Propose an exact synthetic comparison for human review"
}
```

Exactly two distinct offer series and supplier identities are required. Each
snapshot line has `offer_revision_id`, `state` (`comparable` or `excluded`),
`exclusion_reasons` (string array), `normalized_unit_price`, `extended_price`
(decimal strings or null), `currency`, and `lead_time_days`. Missing fields,
wrong/ambiguous part, stale source or offer revision, mismatched quantity, UOM,
currency, destination, incoterm, payment terms and validity are visible reasons.
There is no sum across alternative suppliers and no winning-vendor label.

All arithmetic uses PostgreSQL exact decimal numeric, never binary floating
point. This slice supports equal currency/UOM only: quoted price is preserved,
FX is exactly 1 by identity, and no invented conversion rate or unit factor is
accepted. Different bases remain excluded pending reviewed conversion evidence.

Proposal view: `id`, `scion_id`, `scion_revision`, `input`, `snapshot`,
`created_by`, `created_at`, `status`, `blockers`, `confirmation`,
`reviewer_conflict`, `can_confirm_this_proposal`, `content_redacted`.
Revoked or unavailable evidence redacts the full input/snapshot/reviewer note;
immutable IDs and generic blockers remain as audit metadata. A later stale or
revoked input never changes the stored snapshot and prevents a ready status.

Agent proposals require their active `prepare_offer_normalization` task lease.
Candidate shape is the comparison input above; the worker may only update
`change_summary`, never offer identities, basis or numbers. A separate enrolled
synthetic engineering reviewer confirms normalization, never its own proposal,
offer preparation or queued task. Confirmation writes existing GG-40 comparison,
identity assessment and normalized line records. It is not commercial approval.

`confirmation` includes `comparison_revision_id`, `artifact_id`,
`sourcing_case_revision_id`, `requirement_revision_id`, `confirmed_by`,
`confirmed_at`, `review_note`, `synthetic:true`. Incomplete offer staging rows
remain explicit exclusions; only real governed offer lines can appear in the
GG-40 normalized-line table.
