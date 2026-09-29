# GG-61 independent-review reconciliation

Date: 2026-09-28

## Finding and correction

The independent review correctly found that the original `0034` installed the
revision trigger without backfilling proposals that were already stale before
the migration. The live computed blocker therefore remained safe, but computed
and persisted state could disagree immediately after an upgrade.

The corrected migration enumerates qualifying historical revisions in stable
`(org_id, scion_id, revision_number)` order and calls the same idempotent helper
used by the live trigger before the migration transaction commits. No new event
path, mutable history, approval authority, or runtime write privilege was added.

Two focused SQL fixtures make the upgrade boundary executable:

- `api/tests/revision_monitoring_upgrade_seed.sql` applies after `0033`, creates
  one physical-scope and one offer-comparison proposal at revision 1, then
  advances the Scion through revisions 2 and 3 before `0034` exists.
- `api/tests/revision_monitoring_upgrade_assert.sql` applies after `0034` and
  requires exactly four paired reactions, zero orphans, no growth on explicit
  replay, and exactly one later-revision reaction per proposal.

## Native PostgreSQL 17.11 result

A clean, run-owned native PostgreSQL 17.11 cluster applied unchanged migrations
`0022` through `0033`, the pre-upgrade fixture, corrected `0034`, and the
post-upgrade assertions. The assertion emitted:

```text
PASS: 0034 backfilled scope and comparison reactions, paired tasks atomically,
replayed idempotently, and handled a later revision exactly once
```

The actual Rust API then read both pre-existing stale proposals from the same
upgraded database:

| Proposal kind | `computed_stale` | Status | Latest persisted revision | Review task |
| --- | --- | --- | --- | --- |
| `physical_scope` | `true` | `blocked` | 3 | `required` |
| `offer_comparison` | `true` | `blocked` | 3 | `required` |

The API process was stopped and restarted without restarting or rebuilding the
database. The `revision-reviews` response SHA-256 was identical before and
after restart:

```text
2a0c2586b53146692e5f2a0aee82d7caf12626a06c1b34ad655799befac19205
```

`cargo test --manifest-path api/Cargo.toml --locked` also passed 14/14.

## Residual scope

This correction closes the high-severity upgrade-history contradiction. The
reviewer's broader pagination/load-bound, intra-organization role-matrix, and
timing-side-channel questions remain explicit follow-up design/test concerns;
they do not change the bounded issue authority, which is organization isolation
and one persisted revision reaction. Synthetic fixtures prove software behavior
only and do not establish customer value.
