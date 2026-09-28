# GG-61 persisted revision-monitoring evidence

Date: 2026-09-28

Implementation under test: `2a65170833143ade4a8d0af15536dbf4b148d749`

## Test boundary

The durability scenario used a fresh native PostgreSQL 17.11 cluster, a
checksum-pinned native MinIO binary with a private versioned test bucket, and
the actual Rust API binary. Migrations `0022` through `0034` were applied in
order. The existing Layer 3 HTTP harness created the synthetic sources, claims,
Scion, and two physical-scope proposals through the real API; no application or
monitoring trigger was disabled. Docker was not invoked. No customer, supplier,
or production data was used.

## Runtime scenario: PASS

1. Revision 2 was recorded through the Rust HTTP API for a Scion with two
   API-created dependent proposals.
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

## Native commands and results: PASS

```text
cd api && cargo fmt --all -- --check
cd api && cargo check --locked
cd api && cargo test --locked
cd web && npm run build
cd byoa && node --test bridge.test.mjs
cd harness && GOPATH=<run-scratch>/go GOCACHE=<run-scratch>/go-cache go test ./...
<run-scratch>/grimoire-harness -api-binary api/target/debug/grimoire-api -scope-only
psql ... -c 'SET ROLE grimoire_migrator;' -f api/tests/revision_monitoring_guards.sql
```

Observed results:

- `cargo fmt`, `cargo check`, and `cargo test`: PASS (14/14 Rust tests).
- Vite production build: PASS (38 modules transformed).
- BYOA Node suite: PASS (13/13).
- Go harness compilation: PASS.
- Native PostgreSQL/Rust HTTP Layer 3/BYOA regression: PASS (33 checks).
- Focused SQL guards: PASS, including atomic pairing, replay idempotency,
  immutable history, least-privilege writes, and organization RLS.

The native processes bound only to loopback and were stopped after the run.
The browser check and screenshot are recorded separately in
`docs/evidence/gg61-digital-scion-browser.md`.

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
