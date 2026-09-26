# Windows adaptive Scion drafts

This local slice adds capability preparation and evidence comparison drafts to the existing Scion workflow. It accepts synthetic data only. It does not approve a sourcing decision, discover vendors, import a provider catalog, or create a commercial offer.

The additive migration is `db/intake/0038_windows_adaptive_plans.sql`, following the available Windows chain through `0034`. Numbers `0035`–`0037` are reserved for unavailable Mac-origin source. This migration does not claim to integrate GG-53/GG-54 or reproduce their SQL.

## Discovery and plan preparation

`GET /api/scions/{id}/capabilities` returns the current Scion revision, enabled connector metadata, explicit evidence gaps, immutable plan history, and evidence comparison drafts. Other organizations receive a not-found response. Name-only drafts may use discovery, but agent preparation requires a nonempty product description.

The only registered connectors are implemented local data paths:

| ID | Data and limitations |
| --- | --- |
| `handler_intake` | The exact Handler-provided Scion revision, through the Rust API and organization-scoped PostgreSQL records. It remains unverified. |
| `scion_sources` | Existing synthetic sources and Handler-entered claims, with permission checked on each access and the pinned MinIO object version hash verified before quoting. |

`enabled` describes an implemented local data path, not a guarantee that a Scion has usable evidence or that object storage is healthy. External data connectors are unavailable and `external_connectors_available` is always false in this slice.

A Handler queues the existing task route with `If-Match` and `Idempotency-Key`:

```json
{
  "task_kind": "prepare_capability_plan",
  "candidate_proposal": { "synthetic": true },
  "timeout_seconds": 240
}
```

The API pins the authenticated current intake snapshot, real local connector registry, and mandatory evidence gaps. The caller cannot substitute them. Existing explicit Handler dispatch, cancellation, one-active-task-per-organization, lease, and deadline controls remain in use. A bounded task rejects an intake too large to fit the preparation envelope rather than silently truncating it.

Only a leased enrolled agent may submit `POST /api/scions/{id}/capability-plans`. It supplies `If-Match`, `Idempotency-Key`, `X-Grimoire-Task-Id`, and `X-Grimoire-Task-Lease`:

```json
{
  "synthetic": true,
  "summary": "A proposed capability plan, not verified facts",
  "capabilities": [{
    "key": "content_editing",
    "title": "Editable website content",
    "reason": "The Handler wants to maintain the site",
    "evidence_needed": ["Authorized evidence of the editing workflow"],
    "connector_ids": ["handler_intake", "scion_sources"]
  }],
  "unresolved_gaps": ["Retain every gap in the server-pinned task input"],
  "change_summary": "Agent preparation"
}
```

The example gap is explanatory; real submissions must preserve the actual task's full mandatory gap list. Unknown connectors, removed gaps, extra approval fields, stale Scion revisions, unleased submissions, and Handler impersonation of an agent are rejected. A plan is immutable and tied to exactly one task and Scion revision. Its result must also pass the existing agent result route; an agent result never supplies reviewer authority.

Discovery returns current plans as `authority: "agent_proposal"`, `verification_status: "unverified"`, and `approval_available: false`. Older Scion-bound plans are marked `stale`, retain audit identity and timestamps, and have `input: null`.

## Handler evidence comparison drafts

`POST /api/scions/{id}/evidence-comparisons` is Handler-only and requires `If-Match` and `Idempotency-Key`. It accepts two to six explicitly labelled synthetic alternatives and exact claim IDs:

```json
{
  "synthetic": true,
  "plan_id": "UUID of the current revision's capability plan",
  "alternatives": [
    { "label": "Synthetic approach A", "criteria": [
      { "capability_key": "content_editing", "claim_ids": [] }
    ] },
    { "label": "Synthetic approach B", "criteria": [
      { "capability_key": "content_editing", "claim_ids": [] }
    ] }
  ],
  "unresolved_gaps": ["No independently verified provider evidence is present"],
  "change_summary": "Handler review draft"
}
```

Empty claim lists create explicit evidence gaps; they are never filled with generated evidence. Each supplied claim must belong to this organization and Scion, pin the current Scion and source revisions, retain permission for Scion review, and have matching recorded object metadata. The API retrieves the exact object version, checks SHA-256 and byte length, and checks the quoted UTF-8 locator before returning the claim. PostgreSQL source share locks remain held through the storage read and transaction commit, serializing against source changes and revocations.

All comparisons are immutable unverified Handler drafts. `reviewable` means the draft can be inspected; it does not mean that its claims are verified, its evidence gaps are closed, an alternative is recommended, or any sourcing action is authorized. Responses preserve the plan's mandatory gaps as well as Handler-entered gaps and unsupported criteria.

Discovery revalidates each comparison. Stale intake, changed source revisions, revoked permission, missing objects, corrupt objects, or unavailable storage block it and withhold the entire stored input, alternative labels, claim statements, and quotations. Only content-free audit identity, timestamps, and a blocking code remain. The immutable original stays in PostgreSQL. No browser object download URL is issued.

Successful retries return the original record and `Idempotency-Replayed: true`. Plan replay is additionally bound to the same leased task. A reused key with different input returns `409`. Rights and current-revision checks still apply before replay, so idempotency cannot recover content whose permission has been revoked.

| Failure | HTTP status |
| --- | --- |
| Unknown fields/connectors, omitted mandatory gaps, invalid comparison criterion | 422 |
| Stale Scion `If-Match` | 412 |
| Stale plan or source revision | 409 |
| Missing/revoked source permission; wrong actor role | 403 |
| Cross-organization/cross-case Scion, plan, or claim | 404 |
| Missing/corrupt/unavailable pinned object on a write | 503 |

There is no approval endpoint for these new drafts. Existing synthetic physical scope and normalization workflows remain separate from adaptive drafts and governed sourcing authority.
