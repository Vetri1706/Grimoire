# Native Grimoire agents

Paperclip is a local source/design reference, not a backend dependency. Grimoire
owns agent identities, configuration, skill documents, assignments and execution
history in PostgreSQL. The React UI calls only Grimoire's authenticated Rust API.
The previous optional Paperclip connector and management links have been removed;
the sibling checkout and its running service/data are untouched.

## Agent workflow

1. Open **Agents**, create a named agent and choose its role and reporting line.
2. Edit its instructions, capabilities and bounded task timeout.
3. Create reusable instruction documents under **Skills**, then assign up to eight.
4. Assign a synthetic Scion preparation task. Assignment snapshots the exact agent
   revision and each skill revision. It does not start execution.
5. **Run now** dispatches the oldest eligible queued task through the existing Rust
   task engine and local Codex bridge. No second scheduler is introduced.
6. Inspect actual task state, provider session, result digest, revisions and events.
   A completed task creates a proposal, never human approval.

Every agent has its own overview, instructions, skills, runtime, credentials,
tools, permissions, revisions, activity, runs and usage/limits views. Unsupported
controls are explained rather than simulated. Reporting lines organize work;
they do not confer approval, access or delegation authority.

The profile's Assign task form prepares capability plans. Existing physical
scope and offer-normalization task workflows remain available on physical Scions.
The API can bind a queued task of any supported kind to a compatible agent.
Unassigned legacy tasks remain explicitly labelled and keep their original flow.

## Persistence and authorization

Migration `0043_native_agents.sql` adds organization-scoped entities, immutable
configuration revisions, idempotency receipts, immutable task bindings and real
worker presence. Existing applied migrations are unchanged. RLS hides foreign
profiles, instructions, assignments and heartbeats; runtime has no direct table
mutation grants. Narrow database functions enforce Handler-only management.

| Route | Behavior |
| --- | --- |
| `GET /api/agents` | Organization profiles and authenticated worker health |
| `POST /api/agents` | Create a revisioned profile; Idempotency-Key required |
| `GET /api/agents/{id}` | Profile, latest 100 assignments, revisions and task events |
| `PUT /api/agents/{id}` | Append config revision; If-Match and Idempotency-Key required |
| `POST /api/agents/{id}/tasks/{task}` | Pin an existing queued task; same-assignment retry is inert |
| `GET /api/skills` | Current organization skill revisions |
| `POST /api/skills` | Create instruction document; Idempotency-Key required |
| `PUT /api/skills/{id}` | Append document revision; If-Match and Idempotency-Key required |

Agent configuration is limited to `name`, `role`, `title`, `capabilities`,
`instructions`, `reports_to`, `adapter: "codex_cli"`, `timeout_seconds` (30–300),
`skill_ids` (at most eight unique same-organization skills), and `paused`.
Skill configuration is `name`, `description`, `instructions`. Cyclic reporting,
unknown fields, foreign skills and arbitrary executables/adapters are rejected.
Source text and secrets must not be copied into these instruction documents.

Task creation accepts optional `agent_id`; binding is atomic with creation.
Configuration changes do not rewrite already assigned work. Task/source/revision
guards continue at dispatch, claim, control, proposal submission and completion.
Pausing serializes against these operations, blocks dispatch/claim/submission,
and requests cancellation of active work. The existing child supervisor stops
and acknowledges the child; pause does not falsely report it already stopped.

## Actual runtime, not fabricated readiness

Run `pwsh -File scripts/byoa.ps1 -Mode Start` to start the local managed worker.
The updated bridge sends `X-Grimoire-Worker-Protocol: 2`; a legacy worker cannot
claim native-assigned work and silently omit its instructions. Claim supplies the
immutable instruction/skill snapshot. The bridge includes that bounded snapshot
in the Codex prompt while retaining schema validation and disabled model tools.

The server stores authenticated protocol-2 checks. Connected means the worker
contacted Grimoire within 15 seconds, **not** that the provider is logged in or
that a model call succeeded. Failed model execution is recorded as task failure.
No browser timer creates this heartbeat. The UI polls authenticated reads every
two seconds and clears records on failure, hidden/offline state or an expired
five-second display lease. The internal Watchtower remains server-driven.

One active process per organization and 30–300 second task limits remain enforced.
Codex uses the operator's existing local CLI login and adapter-default model;
Grimoire credentials stay out of the model child. Skills are instruction documents,
not executable plugins. Additional providers, per-agent secret vault/API-key
issuance, provider tracing, dollar metering and monetary budgets are **not
implemented**. Their absence is explicit; no fabricated spend or runs appear.

See [native verification](verification-2026-09-27-native-agents.md) and
[Watchtower boundaries](control-surface.md).
