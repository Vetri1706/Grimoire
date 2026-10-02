# Task-first workspace verification — 2 October 2026

Working tree based on `00a542d8e65e7e3c8107dd506151dee8d5ee2801`.

## Delivered behavior

The workspace opens on Tasks; a digital Scion opens on its own task list. Each
task keeps its agent, execution state, questions, evidence, activity, and
capability-plan deliverable together. Current actionable work is selected ahead
of historical work. The existing physical scope and supplier workflow remains
available for physical Scions.

Paperclip's local `IssuesList.tsx`, `IssueDetail.tsx`, agent detail and provider
connection components informed the compact list, detail header, assignee link,
activity and disclosure patterns. Execution still uses Grimoire's existing Rust
tasks and local Codex connector. No Paperclip scheduler or parallel task store
was added. There are no invented subtasks or subagent runs.

The original proposal bug was reproduced in Chrome: a successful queue command
retained its idempotency key, so a later request returned the old cancelled task
while announcing a new queue entry. Confirmed success now retires that key;
uncertain retries preserve it. Task creation and dispatch recover independently.
Definitive validation failures leave fields editable, and mutation errors survive
successful background reads.

Handler answers use the existing revision API with `If-Match`. Failed saves and
competing revisions retain the entered draft. A saved revision invalidates old
plans; replacement work uses the current revision and source permissions.

Migration `0051_capability_plan_reviews.sql` adds immutable, organization-scoped
review receipts and one content-free audit event per idempotent review request.
Receipts do not approve anything, alter authority, or close Watchtower alerts.
Only an authorized human may review a completed, current, permitted plan.
Revoked or stale dependencies hide the result and its review text.

## Real browser evidence

`web/tests/task-journey.mjs` passed with **two actual Codex executions**, using
only synthetic Handler input in an isolated organization/database:

1. Create a digital Scion in Chrome; Tasks opens automatically.
2. Start planning with an actual assigned native agent and paired Codex worker.
3. Observe the completed agent result as Needs input, with no human receipt or approval.
4. Answer the brief question inside Tasks; save revision 2; observe the old plan stale and hidden.
5. Prepare replacement work with Codex; review the new result as the Handler.
6. Reload and confirm the saved review and Completed presentation; approval remains unavailable.

Evidence: `.local/task-journey/1790879636603/results.json`, plus desktop and
390px mobile screenshots. Provider session IDs and task IDs are recorded there;
no provider credentials or raw execution transcript is included.

`web/tests/task-recovery.mjs` exercises real application routes and PostgreSQL
records using explicitly labelled protocol fixtures, **without model calls**:

- New-task route and a real paused-agent rejection; editable recovery.
- Lost create response; exactly one task, queued event and dispatch.
- Lost dispatch response followed by a claim; recovery from recorded running state.
- Failed answer save; preserved draft and error through successful polling.
- Competing revision; actual 412 response and preserved answer draft.
- Source revocation while a task is open; source title and result hidden, blocked state, no approval.

The original regression is separately reproducible with `web/tests/proposal-retry.mjs`.
Its before evidence is `.local/proposal-retry/1790878902397-before/results.json`;
the corrected three-check run is `.local/proposal-retry/1790879135626-after/results.json`.

Final recovery evidence: `.local/task-recovery/1790879859738/results.json`.
All six cases passed together, including navigation between tasks with an
unsaved answer and no discard dialog. Desktop and 390px layouts were inspected;
the mobile checks assert no horizontal overflow.

## Backend and local installation checks

| Check | Result |
| --- | --- |
| Frontend production build and unit tests | Passed; 18 tests |
| `cargo test --manifest-path api/Cargo.toml -- --test-threads=1` | 45 passed |
| Rust formatting and Git whitespace checks | Passed |
| Go vet, package tests and full running-API acceptance harness | 160 acceptance checks passed |
| `api/tests/capability_review_guards.sql` | Authorization, RLS, direct-write and immutability checks passed |
| Windows startup checks on clean and upgraded PostgreSQL 17 databases | 19 passed |
| Onboarding/organization/home navigation in real Chrome | 7 passed; default Tasks and explicit Dashboard both verified |
| Fresh Chrome against updated primary local stack | Login and published synthetic demo passed; no browser errors |

The Go checks cover receipt replay, exactly one review audit event, worker and
foreign-organization denial, source revisions/revocation, persisted review state
after actual Rust restart, Watchtower event idempotency and the existing physical
workflow. The test harness is protocol-fixture evidence, not model execution;
the separate browser journey above supplies actual Codex evidence.

An initial parallel Rust run hit the existing Google-token expiry-boundary
wall-clock test; its individual rerun and the full sequential suite passed.
An initial Go run received a transient 503 in an existing concurrent physical
review check; its focused rerun and subsequent complete 160-check run passed.
No authority checks were relaxed to obtain these results.

The primary local database `grimoire_dev` was backed up before migration 0051.
All 106 pre-existing table counts/content fingerprints and all historical
migration ledger entries were unchanged; one new review-receipt table was added.
Backup and verification report:
`.local/backups/codex-v1-primary-20261001T184030386Z/`.
The updated API passed startup attestation and `/api/health` reports the normal
`grimoire_intake_app` runtime role on PostgreSQL 17.11. The local UI is served at
`http://127.0.0.1:5180`. This is a local update, not an AWS deployment.
Primary browser evidence: `.local/task-primary-smoke/results.json`.

## Reproduction

Use a disposable local installation. These tests create synthetic accounts,
organizations and records; worker enrollments are revoked during cleanup.

```powershell
$env:GRIMOIRE_TEST_DISPOSABLE='1'
$env:GRIMOIRE_TEST_DATABASE='grimoire_codex_flow_test'
$env:GRIMOIRE_WEB_URL='http://127.0.0.1:5182'
node web/tests/proposal-retry.mjs
node web/tests/task-recovery.mjs

# Requires explicit authorization for actual Codex use and an installed CLI.
$env:GRIMOIRE_TEST_LIVE_CODEX='1'
node web/tests/task-journey.mjs
```

The browser polls authenticated state with expiring display leases. The existing
server Watchtower supplies continuous internal monitoring. External research and
provider monitoring remain unavailable. Agent hierarchy in a profile is not
presented as executed delegation. Human sourcing/engineering approval remains
outside this increment.
