# Bring your own coding agent: local synthetic preparation

This slice connects the user's installed **Codex CLI** using its existing local
ChatGPT login. It runs a real noninteractive agent task and submits the resulting
structured proposal through the Rust API. It is not a Paperclip connector, a
generic command runner, a source extraction service, or a human approval path.

Supported tasks are `prepare_physical_scope` and `prepare_offer_normalization`.
A Handler enters explicit synthetic values and exact revision references, creates
a queued task, then separately dispatches it. No values are filled from empty fields.
The local bridge claims a dispatched task, gives Codex the explicit synthetic input,
validates its output, submits an immutable scope proposal, then records the task
as completed with its proposal ID. Human confirmation remains a separate API
action requiring the appropriate enrolled reviewer. The agent cannot perform it.

## Run the user's agent

From `C:\proj\Grimoire\grim`:

```powershell
# Local discovery only; this does not invoke the model.
codex --version
codex login status
pwsh -NoProfile -File scripts/byoa.ps1 -Mode Check

# Execute one explicitly dispatched synthetic task using the current Codex login.
pwsh -NoProfile -File scripts/byoa.ps1 -Mode Once

# Remain connected while the local process runs; poll for dispatched tasks.
pwsh -NoProfile -File scripts/byoa.ps1 -Mode Watch

# Alternatively, manage a hidden local worker with redirected local logs.
pwsh -NoProfile -File scripts/byoa.ps1 -Mode Start
pwsh -NoProfile -File scripts/byoa.ps1 -Mode Status
pwsh -NoProfile -File scripts/byoa.ps1 -Mode Stop

# Tests of bridge credential filtering and output guards (no model invocation).
node --test byoa/bridge.test.mjs
```

The API and its canonical PostgreSQL database must already be running. Provision
the local proposal-only agent identity through the development migration/seed
workflow; its credential is `GRIMOIRE_TOKEN_AGENT_A` in ignored `.env`. The launcher
loads only that credential into the bridge. It does not pass the Handler token,
PostgreSQL credentials, MinIO credentials, or test administration credentials.

`Start` records the actual Node PID, start time, executable and command line in
ignored `.local/byoa/worker.json`; `Status` checks that exact process, without
claiming provider authentication. `Stop` verifies all those fields before stopping
it and refuses to kill a worker with an active child task. It never selects all
Node processes by name. Worker output and bounded error diagnostics go to local
files under `.local/byoa/`.

The optional `GRIMOIRE_API_URL` must be an HTTP loopback origin (default
`http://127.0.0.1:8080`). `GRIMOIRE_CODEX_BIN` can identify an existing native Codex
executable; otherwise the Windows npm installation is discovered. There is no
browser-controlled executable, shell argument, working-directory, or destination
URL field. This first adapter is Codex only. Other providers require their own
reviewed adapter and actual execution test before the UI may call them connected.

## Process and permission boundaries

- The bridge holds an enrolled agent credential with proposal authority only.
  Rust rechecks organization, principal enrollment, Scion revision, and source
  rights at task claim and completion. Task input is withheld until claim passes.
- Every task uses a unique temporary directory outside the Grimoire repository.
  Only a synthetic task file, JSON output schema, and structured result are staged.
  Neither `.env`, source bytes, quoted claim text, database files nor object-store
  data is copied there.
- Codex receives **no Grimoire API credential**. Its child environment is an
  allowlist of operating-system and existing Codex-home variables. The trusted
  bridge submits its structured output through the Rust endpoint.
- Codex runs with `--sandbox read-only`, `--ephemeral`, `--ignore-user-config`,
  `--ignore-rules`, an output schema, and per-invocation disabled shell, exec,
  browser, app, plugin, hook, memory, and multi-agent capabilities. Web search is
  disabled. These options do not rewrite global settings or sign the user out.
  Existing authentication is used only to reach the selected model provider.
- The output schema pins provided identities and citations. A second bridge
  check rejects any changed physical value or locator, extra field, removed gap,
  or upgrade from ambiguous to exact. The API/database independently require the
  completed task's proposal to preserve those same input fields and its own
  Scion, revision, organization and agent author.
- Codex may add an unresolved gap or downgrade identity matching to ambiguous.
  Its preparation note must not claim source truth verification: source bodies
  are not sent to this adapter. Model output remains unverified preparation.

The Handler chooses a 30–300 second execution timeout (default 240); the lease
adds 30 seconds. PostgreSQL permits one active task per organization across all
workers. Cancellation stops the exact managed Codex process before its slot is
released. The worker polls task control every second and fails closed on lost
permission or unavailable control. Expired tasks fail without automatic retry.
A stale/revoked task at claim fails as `INPUT_UNAVAILABLE`. Agent proposals and
results require the same active lease and exact task/revision binding. A completed
task is never human confirmation. See [worker-controls-api.md](worker-controls-api.md)
for dispatch, cancellation, provenance and timeout contracts.

Local job receipts under ignored `.local/byoa/jobs/` contain bounded identifiers,
status, output SHA-256 and provider run ID. Unrestricted transcripts are not
retained by the bridge. Temporary task cleanup uses bounded retries; cleanup
failures must be reported rather than described as successful deletion.
The provider's own data handling is outside this local cleanup; no provider-side
deletion or physical erasure is claimed.

The first live adapter test completed on 26 September 2026 using the existing
Codex CLI login. Its proposal `7bdf2955-16f5-40e5-84a6-ea50c434b59a` remained
unconfirmed and was authored by the enrolled agent principal. Eight Node tests
cover the credential/output guards and CLI event classification. Actual run
identifiers, SHA-256, API readback, retained failed attempts, and one earlier
temporary-folder cleanup limitation are recorded in
[`evidence/layer3-codex.txt`](evidence/layer3-codex.txt).

## Queue API

All endpoints require the existing Rust bearer authentication. Foreign and absent
task identifiers use the same hidden-resource response. The Handler list omits
the input payload and lease token.

| Route | Authority and result |
| --- | --- |
| `POST /api/scions/{id}/agent-tasks` | Handler; `If-Match` and `Idempotency-Key`; `{task_kind:"prepare_physical_scope",candidate_proposal:<typed scope payload>}`; returns task with 201 |
| `GET /api/scions/{id}/agent-tasks` | Organization read access; `{tasks:[...]}` |
| `GET /api/agent/tasks/next` | Enrolled proposal-only agent; `{task:null}` or `{task:{id}}`; no input |
| `POST /api/agent/tasks/{id}/claim` | Enrolled agent; 200 with immutable input and `lease_token`; concurrent claim 409 |
| `POST /api/agent/tasks/{id}/result` | Active claimant and `X-Grimoire-Task-Lease`; `{proposal_id,provider_run_id,output_sha256,preparation_note}`; 200 |
| `POST /api/agent/tasks/{id}/fail` | Active claimant and lease; `{failure_code}` using a bounded machine code; 200 |

Task states are `queued`, `dispatched`, `running`, `cancel_requested`, `cancelled`,
`completed`, `failed`. Queued means not dispatched; dispatched means waiting for
the local worker. Neither proves a connected worker. `running` follows an atomic
claim. Additive `0031` hardens the original `0029` queue; verified GG-40
`0022`/`0023` remain unchanged. The queue owns no sourcing approval authority.

## Architecture references

The supplied master document does not use the literal term BYOA. Its §6.1
specifies installed Codex/Claude-style agent adapters, scoped Rust proposals,
and a distinct human authority boundary. That is reference material; the user's
current instruction selects the local Codex adapter and defers Paperclip itself.

Read-only Paperclip files informing this adapter:

- `skills/paperclip/SKILL.md`: run identity, atomic checkout, task context, and
  explicit completion states (lines 20–28, 118–128, 178–191 at inspection).
- `packages/adapters/codex-local/src/server/execute.ts`: isolated workspace/run
  environment and run-token boundary (around lines 940–989).
- `packages/adapters/codex-local/src/server/codex-args.ts`: noninteractive CLI
  invocation and JSON events. Grimoire chooses its own restrictive flags and
  does not inherit Paperclip's sandbox bypass defaults.
- `server/src/routes/issues.ts`, `server/src/services/issues.ts`, and
  `server/src/routes/approvals.ts`: previously documented checkout/conflict and
  separate approval boundary in `layer-1-boundaries.md`.

The Paperclip clone remains unchanged. No Paperclip issue completion, agent run,
or bridge receipt is treated as Grimoire sourcing approval.
