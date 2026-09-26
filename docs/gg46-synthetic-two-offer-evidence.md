# GG-46 synthetic two-offer comparison evidence

## Outcome

The focused Go/PostgreSQL harness passed **14/14** checks against implementation
commit `1160f06963117a072c975d6df57ff695e35a860d`. The fixture hash is
`21adf081282aa051c3e2db45a511247065b524c3d94d3bfdf24208aecd04f2e2`.
All records and identities are explicitly synthetic. The positive path records a
draft only; it is neither submitted nor approved.

Raw expected-versus-actual evidence is in
[`evidence/gg46-harness-2026-09-26.json`](evidence/gg46-harness-2026-09-26.json).

## Command and environment

```sh
cd harness
go run ./gg46 -dsn postgresql://postgres@127.0.0.1:55446/grimoire_gg46_test?sslmode=disable -fixture ../fixtures/gg46-two-offer.json -code-revision 1160f06963117a072c975d6df57ff695e35a860d
```

- Go: official `go1.27.1.darwin-arm64`, archive SHA-256
  `ee215d57e0ec269c60cc9ceca68e6bda321ba9ee5afe24f4b0988703c2d87d12`.
- Database for this focused run: PostgreSQL 15.18 in a run-owned disposable
  cluster. All migrations `0022` through `0034` and the unchanged synthetic
  GG-40 fixture applied successfully before the harness ran.
- Static checks: `go test ./gg46` and `go vet ./gg46` passed.
- The selected application runtime remains PostgreSQL 17. This focused result
  does not replace the existing full HTTP/Rust/PostgreSQL-17/MinIO evidence.

## Implemented boundary

- `0034_sourcing_authority_gate.sql` adds immutable, tenant-scoped sourcing
  authority reviews and idempotent synthetic draft-decision receipts.
- A deferred canonical-table constraint rejects a `decision_revision` at commit
  unless either an exact matching review exists from a distinct enabled
  `commercial_approver`, or the unchanged rollback fixture supplies its stronger
  fully granted three-domain approval chain in the same transaction.
- Agent and quality-review identities cannot satisfy sourcing authority.
- The authority review is distinct from the decision preparer, comparison
  author, and normalization reviewer.
- The gate rechecks exact case, requirement, comparison, offer and line revisions,
  current offer revision, source authorization, and comparison-artifact validity.
- Retry keys return the original immutable review/draft; changed retry inputs are
  rejected. The positive retry retained one decision, one decision revision, two
  input rows, one receipt, one state event, and an unchanged audit count of six.

## Exact fixture and comparison

[`fixtures/gg46-two-offer.json`](../fixtures/gg46-two-offer.json) exposes the
stable Scion, configuration revision, BOM occurrence revision, component
revision, requirement revision, two source revisions, two offer revisions/lines,
comparison revision and packet revision. Its comparability matrix records:

- exact manufacturer/orderable-part identity;
- quantity/UOM, currency, destination, incoterm, payment and validity basis;
- identity FX only (`USD → USD = 1`), no unit conversion and no rounding;
- lead time displayed but excluded from normalized price/selection because no
  delivery-risk model is authorized; and
- freight, taxes, duties, quality risk and supplier performance left unknown and
  excluded because no evidence or approved normalization exists.

The Codex CLI record remains `proposal_only`, contains no selected offer or
recommended supplier, and receives no source text.

## Guard evidence

| Scenario | Expected | Actual |
| --- | --- | --- |
| Missing human-authority review | `G3301` rejection | `G3301` rejection |
| Agent or quality review used as authority | `G3302` rejection | `G3302` rejection |
| Stale scope revision | `G3305` rejection | `G3305` rejection |
| Stale offer/source revision | `G3305` rejection | `G3305` rejection |
| Revoked source | `G3305` rejection | `G3305` rejection after artifact invalidation |
| Cross-organization exact ID vs absent ID | identical non-leaking `G3304` | identical non-leaking `G3304` |
| Same-key review/decision retries | one immutable result | one immutable result; audit count stable |
| Changed same-key retries | `G3303` rejection | `G3303` rejection |
| Synthetic commercial-authority positive path | one draft, no approval | one draft, no approval |

## Residual gaps and non-claims

- This macOS worker lacks the repository's PostgreSQL 17, Rust, PowerShell and
  MinIO runtime, so the full HTTP harness was not rerun here. An attempted legacy
  database-guard run on PostgreSQL 15 stopped at the suite's expected PostgreSQL
  17 role/DDL privilege assertion and is not reported as a pass.
- The separate independent review issue must challenge this implementation;
  this evidence is the author run, not independent review.
- Synthetic role fixtures demonstrate software behavior only. They do not prove
  a real reviewer's qualification, customer value, production readiness,
  security certification, or sourcing approval.
- No supplier contact, RFQ, deployment, purchase, production data, or external
  system write occurred.
