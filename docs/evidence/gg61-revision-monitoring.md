# GG-61 persisted revision-monitoring evidence

Date: 2026-09-28

Repository base: `46f27bef19cea5c2fc4e48bbe57b94faf354ee37`

## Test boundary

The durability scenario used an isolated PostgreSQL 17 Docker volume and the actual Rust API binary. Migrations `0022` through `0034` were applied in order. Two synthetic proposals were inserted in one synthetic organization; only the proposal-version guard was disabled for that fixture seed so the test could isolate the revision reaction without configuring storage/provider dependencies. All revision changes and authorization checks then went through the HTTP runtime. No customer, supplier, or production data was used.

## Runtime scenario: PASS

1. Revision 2 was recorded for a Scion with two dependent proposals.
2. The same database transaction created two stale transitions and two required-review tasks: one pair per proposal.
3. Proposal detail reported `computed_stale: true`, the persisted transition/task identifiers, and the existing stale-work blocker rejected confirmation.
4. A second organization could neither read the review list nor record a revision for the Scion; both requests returned `404 SCION_NOT_FOUND`.
5. The Rust process was stopped and restarted against the same PostgreSQL volume.
6. Replaying the exact revision-2 request returned `idempotency-replayed: true`. The saved response digest and review-list digest were identical before and after restart/retry, and counts stayed at two transitions/two tasks.
7. Revision 3 created the next legitimate pair for each proposal exactly once. Replaying revision 3 was idempotent. Final totals were four unique transitions and four unique review tasks, grouped as two reactions for revision 2 and two for revision 3.

## Focused SQL guards: PASS

`api/tests/revision_monitoring_guards.sql` ran inside a rollback-only transaction and reported:

- atomic transition/task pairing;
- replay idempotency;
- immutable reaction history;
- least-privilege write rejection for the runtime role; and
- organization RLS hiding another organization's transitions and review work.

## Regression commands: PASS

```text
cd api && cargo fmt -- --check
cd api && cargo check --locked
cd api && cargo test --locked                 # 14 passed
cd api && cargo build --locked
npm --prefix web ci
npm --prefix web run build                   # Vite production build passed
go test ./...                                # harness compiled
psql ... -f api/tests/revision_monitoring_guards.sql
```

The browser check and screenshot are recorded separately in `docs/evidence/gg61-digital-scion-browser.md`.

## Acceptance mapping

- One qualifying revision → one persisted transition per dependent proposal: PASS.
- One qualifying revision → one persisted review task per dependent proposal: PASS.
- State survives Rust process restart: PASS.
- Exact-event retry creates no duplicate transition or task: PASS.
- A later distinct revision creates the next legitimate reaction exactly once: PASS.
- Existing computed blocker still rejects stale work and agrees with persisted state: PASS.
- Cross-organization reads and mutations are denied: PASS.
- Digital Scion has no physical tabs or direct physical workflow access: PASS.
- Focused migration/integration checks and the smallest relevant regression suites pass: PASS.

This evidence proves synthetic software behavior only. Customer value remains unestablished, consistent with the GG-61 non-goals.
