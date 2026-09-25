# Codex worker controls

The sole adapter is `codex_cli`. Creating a task records the Handler's input;
it does not authorize execution. A separate Handler dispatch starts eligibility
for the existing local worker. No task state grants human confirmation.

`POST /api/scions/{scion}/agent-tasks` requires `If-Match` and `Idempotency-Key`:

```json
{"task_kind":"prepare_physical_scope","candidate_proposal":{},"timeout_seconds":240}
```

The candidate must follow its typed proposal contract. Supported kinds are
`prepare_physical_scope` and `prepare_offer_normalization`; normalization uses
the comparison candidate in `layer-4-api-contract.md`. Timeout defaults to 240
seconds and is bounded to 30–300. The response is a direct Task, status `queued`.

Handler control routes return a direct Task:

- `POST /api/scions/{scion}/agent-tasks/{task}/dispatch` with `If-Match` matching
  the task's pinned Scion revision: queued → dispatched, 200. A repeated dispatch
  of a dispatched task is idempotent. Current revision and rights are checked.
- `POST /api/scions/{scion}/agent-tasks/{task}/cancel`: queued/dispatched →
  cancelled, 200; running → cancel_requested, 202. No If-Match is required so
  stale tasks remain cancellable. Repeated cancellation returns the same state.
- `GET /api/scions/{scion}/agent-tasks/{task}/events`: `{events:[...]}` with
  immutable status events and content-free result provenance.

Agent-only routes require the enrolled, non-writing, non-confirming principal:

- `GET /api/agent/tasks/next`: only dispatched tasks are visible; no task when the
  organization has an active execution. Input remains withheld until claim.
- `POST /api/agent/tasks/{task}/claim`: atomic claim returns task, input and random
  `lease_token`. PostgreSQL permits one running/cancel_requested task per org,
  including concurrent claims from separate workers. Execution deadline is exactly
  claimed_at + timeout; lease adds 30s solely for shutdown/failure acknowledgement.
- `GET /api/agent/tasks/{task}/control` with `X-Grimoire-Task-Lease`:
  `{task_id,status,continue,stop_reason,scion_revision,execution_deadline,lease_until}`.
  `stop_reason: "execution_timeout"` ends work at the execution deadline even
  while the cleanup lease is active. The worker polls every
  second. Cancellation, lost rights, stale input, expired lease or unavailable
  control stops its exact spawned Codex process and waits for process exit.
- `POST /api/agent/tasks/{task}/cancelled` with lease: worker acknowledges actual
  process termination; cancel_requested → cancelled. The org slot stays occupied
  until this acknowledgement or lease expiry.
- Existing `/result` and `/fail` require the same active lease. Cancelled work
  cannot record a result. Neither new proposals nor new results are accepted
  after the execution deadline; the grace lease cannot extend execution. Expired
  execution terminally fails; it is never silently
  re-run. A new task and dispatch are required to retry.

Agent proposal POSTs additionally require `X-Grimoire-Task-Id` and the lease.
Rust and PostgreSQL require the matching active task, exact Scion revision,
organization, actor, task kind and input. The proposal stores its task origin.
Only that task can record the proposal result. Cancellation and submission lock
the same task row so a completed cancellation cannot race into a new proposal.
Cancellation is not proposal withdrawal or content erasure. A proposal committed
before the cancellation remains an immutable, unverified proposal and may be
reviewed through the separate human confirmation path. Cancellation prevents
later task completion; it does not undo already recorded history.

Task reads expose IDs, status, Scion revision, adapter, attempts, timeout, lease
deadline, dispatch/claim/completion/cancellation timestamps, proposal ID, provider
run ID, and output SHA-256. Event `details` pins this same provenance. Candidate
inputs, preparation notes, source text, claims, and provider transcripts are not
returned in task history. Proposal views enforce their own evidence redaction.

The local receipt also records the pinned Scion revision and task kind. Provider
completion only creates an unverified proposal; separate human confirmation
retains its own role and author-conflict checks.

Verification includes API/PostgreSQL checks in the Go harness and process-level
Node tests using harmless local Node children for cancellation/timeout. Those
process tests are not a substitute for the live Codex normalization smoke run.
