# Synthetic physical scope review API

This local slice records a reviewable proposal for an exact physical scope. A
separate, explicitly enrolled synthetic engineering reviewer can confirm it.
Confirmation creates the exact identity chain in existing GG-40 tables, not a
parallel physical model. It does not approve sourcing, create offers, or advance
a decision. Digital and unspecified intake remain drafts.

All routes require the existing bearer credential. Foreign and nonexistent
Scions/proposals return the same 404. Every POST requires `Idempotency-Key` and
`If-Match: "<current Scion revision>"`. Proposal records and confirmation records
are immutable. Same-key retries return the original 201 response; changed reuse
returns 409. After confirmation, a different key cannot confirm the Scion again.

## Routes and payload

- `GET /api/scions/{id}/scope`: `{proposals: [...], can_confirm: boolean,
  required_role: "synthetic_engineering_reviewer", synthetic_only: true}`.
- `GET /api/scions/{id}/scope/proposals/{proposal}`: one proposal with current
  blockers and its confirmation (or null).
- `POST /api/scions/{id}/scope/proposals`: accepts the object below; returns the
  saved proposal with `id`, `scion_id`, `scion_revision`, `created_by`,
  `created_at`, `input`, `blockers`, `confirmation`, and `required_role`.
- `POST /api/scions/{id}/scope/proposals/{proposal}/confirm`: accepts
  `{"confirm_synthetic_scope":true,"review_note":"Explicit reviewer rationale"}`;
  returns the proposal plus its confirmation and exact governed revision IDs.

```json
{
  "synthetic": true,
  "identity_match": "exact",
  "configuration": {
    "product_code": "SYN-PRODUCT-EXPLICIT-UNIQUE",
    "product_name": "Synthetic enclosure test article",
    "configuration_code": "SYN-CFG-A",
    "specification": {"enclosure":"synthetic test description"}
  },
  "component": {
    "internal_part_code": "SYN-COMPONENT-EXPLICIT-UNIQUE",
    "manufacturer": "Synthetic manufacturer",
    "part_number": "SYN-PART-001",
    "attributes": {"material":"synthetic specified material"}
  },
  "occurrence": {"path":"/synthetic/enclosure[1]","quantity":"1","uom":"EA"},
  "requirement": {
    "code":"SYN-REQ-001",
    "criteria":{"description":"Explicit synthetic controlled requirement"}
  },
  "case_code":"SYN-CASE-EXPLICIT-UNIQUE",
  "case_title":"Synthetic exact enclosure scope",
  "source_claims":[
    {"kind":"configuration","source_id":"SOURCE-UUID","source_revision":1,"claim_id":"CLAIM-UUID","content_sha256":"64-lowercase-hex","start_byte":0,"end_byte":100},
    {"kind":"component","source_id":"SOURCE-UUID","source_revision":1,"claim_id":"CLAIM-UUID","content_sha256":"64-lowercase-hex","start_byte":0,"end_byte":100},
    {"kind":"occurrence","source_id":"SOURCE-UUID","source_revision":1,"claim_id":"CLAIM-UUID","content_sha256":"64-lowercase-hex","start_byte":0,"end_byte":100},
    {"kind":"requirement","source_id":"SOURCE-UUID","source_revision":1,"claim_id":"CLAIM-UUID","content_sha256":"64-lowercase-hex","start_byte":0,"end_byte":100}
  ],
  "unresolved_gaps": [],
  "change_summary":"Explicitly propose this synthetic exact scope for independent review"
}
```

All physical inputs must be explicit; none are generated from empty fields.
Exactly one reference for each of the four link kinds is required. References
may reuse a claim only when the reviewer finds that the cited statement supports
each use; byte validation establishes provenance, not semantic truth. Each
reference pins source revision, SHA-256, claim ID and its exact UTF-8 interval.
Source must belong to this organization, this Scion and the pinned intake
revision. Source and intake must still be current, permitted and synthetic.

`identity_match` is `exact` or `ambiguous`. An ambiguous proposal or a proposal
with unresolved gaps may be saved for review but cannot be confirmed. Missing
identity fields, missing/duplicate link kinds, malformed evidence or digital
scope are rejected at creation. Confirmation revalidates current authority,
source rights, S3 version/digest/bytes and claim locators under locks, then
atomically creates products, configuration revisions, component revisions,
exact BOM occurrence revisions, requirement revisions and a sourcing case
revision. Existing source and intake history are not edited.

The confirmation object includes `proposal_id`, `scion_id`, `scion_revision`,
`configuration_revision_id`, `component_revision_id`, `occurrence_revision_id`,
`requirement_revision_id`, `sourcing_case_id`, `sourcing_case_revision_id`,
`confirmed_by`, `confirmed_at`, `review_note` and `synthetic: true`.
It also includes `governed_chain`, read from the existing GG-40 tables, with
the exact four IDs, each `*_revision_no`, `revision_no` for the sourcing case,
`consistent` and `criteria_hash_matches`. Requirement `content_hash` hashes the
UTF-8 PostgreSQL `jsonb::text` serialization of the actual stored criteria,
including synthetic/proposal provenance tags.

List/detail responses have `status`: `proposed`, `confirmed`, or `blocked`.
`blockers` is an array of readable strings. If a linked source is revoked,
unavailable, stale or fails object verification, `input` is null and confirmation
`review_note` is null. Immutable governed IDs remain visible as audit metadata;
the binding is blocked rather than presented as ready. No quotation is returned
through this metadata path.

## Authority and limits

The preparer cannot confirm their own proposal. An enabled principal must have
the existing GG-40 `engineering_reviewer` role and separate local synthetic
reviewer enrollment. A read-only-agent or system-worker principal cannot
confirm, even if given another role. Enrollment is administrator provisioning,
never a request field. The local reviewer credential is a synthetic test
identity, not evidence of a qualified real reviewer.

Agent indirection does not remove preparer identity. A principal who queued any
scope-preparation task for this Scion cannot confirm its scope, even with both
preparer and reviewer roles and even before the agent posts a task result.
Proposal views expose `reviewer_conflict` and `can_confirm_this_proposal` for the
current caller. The API and a database insert guard enforce the same separation.

The current local role matrix is intentionally explicit:

| Surface | Current access |
| --- | --- |
| Scion history and source audit metadata, including revoked source metadata | Every enabled principal with any role in the same organization |
| Permitted synthetic source bytes/claims and scope input | Those same organization principals, only while source rights, revision binding and exact object verification succeed |
| Intake/source editing and task enqueue | Handler/preparer or organization administrator, excluding any agent/worker identity |
| Scope proposal submission | Handler or separately enrolled read-only proposal agent |
| Scope confirmation | Separately enrolled engineering reviewer, never an agent, proposer or task requester for this Scion |
| Confirmed governed IDs after source revocation | Same-organization audit metadata remains visible; scope is blocked and derived input/reviewer note is redacted |

This is not a restricted real-data source-metadata policy: even `read_only_agent`
and `system_worker` roles currently receive same-organization source audit
metadata. Real-data work must first define which named human and agent roles may
see title/origin/owner, rights attestations, retained quotations and revoked
metadata. Local role enrollment does not establish real-world authority.

Real data remains blocked pending a qualified engineering authority, controlled
configuration/BOM and manufacturer/orderable-part identity, controlled
requirements, source rights review, substitution/change-control rules, and the
separate quality/commercial reviews required for any later sourcing decision.
Paperclip completion, an agent output, a full intake form, and this synthetic
scope confirmation never count as sourcing approval.

New migration `0028` is additive application work. Accepted GG-40 `0022` and
`0023`, and additive `0024` through `0027`, remain byte-identical.
`0029` adds the preparation-task queue. `0030` adds complete confirmed-chain
comparison and the task-requester self-review guard without changing applied
`0028`/`0029` bytes.
