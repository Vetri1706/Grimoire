# GG-61 persisted Scion revision reaction

## Boundary

PostgreSQL is authoritative for the first monitoring reaction. A successful
Scion revision greater than one is the event. The event affects every saved
physical-scope or offer-comparison proposal for the same organization and Scion
whose recorded `scion_revision` is lower than the new revision. Source changes,
revocations, polling, connectors, graph/feed routes, notifications, and review
completion are outside this increment.

## Persisted records and idempotency

`intake_proposal_stale_transitions` records one immutable observation per:

```text
(org_id, proposal_kind, proposal_id, superseded_by_revision)
```

That database uniqueness constraint is the event idempotency key. The row pins
the proposal's recorded Scion revision, the new Scion revision, the fixed reason
`scion_revision_changed`, and recorded time.

`intake_proposal_review_tasks` records exactly one immutable `required`
`revision_change_review` task for each transition. Its unique
`(org_id, transition_id)` and exact composite foreign key prevent duplicate or
mismatched work. A later distinct Scion revision is a distinct transition and
may therefore create the next legitimate required-review task exactly once.

## Transaction and retry behavior

Migration `0034_persisted_revision_monitoring.sql` attaches an `AFTER INSERT`
trigger to `intake_revisions`. The trigger inserts transitions and review tasks
inside the Rust revision request's existing PostgreSQL transaction, before its
idempotency receipt and response commit. A failure rolls back the revision,
transition, task, and receipt together.

The trigger helper uses `ON CONFLICT DO NOTHING` on both uniqueness boundaries,
so replaying the same event cannot duplicate either record. The existing Rust
request receipt remains the first retry boundary: an exact HTTP retry replays
the saved response without inserting another revision. The database uniqueness
rules are the second boundary and also protect explicit event re-evaluation.

## Read contract and safety check

`GET /api/scions/{scion_id}/revision-reviews` returns the authenticated
organization's ordered persisted transitions with their required-review tasks.
Scope and comparison proposal responses also expose:

- `computed_stale`: the existing live comparison between the proposal's pinned
  Scion revision and the current Scion revision;
- `persisted_revision_reaction`: the latest durable transition/task pair, or
  `null` when none has been recorded.

The live computed blocker is preserved and still controls proposal status and
confirmation. Persisted state is additive evidence and routing work; it cannot
make a stale proposal current or grant confirmation/approval authority.

Both tables use deny-by-default privileges and organization RLS. The runtime
can select only rows for `app.current_org_id()` and cannot insert, update,
delete, or execute the internal reaction helper directly. The public endpoint
first resolves Scion visibility, so a foreign or nonexistent Scion returns the
same not-found response.
