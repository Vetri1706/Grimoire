# Native Grimoire agent verification — 27 September 2026

This supersedes the Paperclip-backend integration described in the earlier OS
and company-workspace reports. Paperclip is now a source/design reference only.
No Paperclip backend request, company mapping, management redirect or fabricated
run remains in the Grimoire agent workflow. Its sibling checkout/service/data
were left untouched, including pre-existing local modifications.

## Executed checks

| Check | Result |
| --- | --- |
| Full live Go harness | 152 passed against Rust, PostgreSQL 17.11 and versioned MinIO |
| Rust unit tests | 20 passed |
| Rust formatting / strict Clippy | Passed |
| Node bridge and local MCP tests | 18 passed |
| Rollback-only SQL guards | Passed, including native mutation grants, immutable history and RLS |
| Startup/catalog adversarial checks | 19 passed on clean and upgraded test databases |
| TypeScript / production Vite build | Passed |
| Git whitespace check | Passed |

The eight new native Go checks exercise idempotent profile creation, Handler-only
writes, authentication, foreign profile/skill/assignment hiding, exact instruction
snapshots, incompatible-worker rejection, immutable revisions, optimistic conflict,
pause cancellation, inert retries, cyclic reporting denial, new-revision assignment,
proposal-only completion and actual Rust restart. Existing OS checks cover source
revocation, revision staleness, dependent work blocking, duplicate watch effects,
organization isolation and browser-independent monitor persistence. Full physical
scope and supplier-offer regressions remain included.

The first full run was blocked by sandbox process permissions at the intentional
MinIO outage test. Subsequent attempts encountered local MinIO storage/permission
failures after restart. Reapplying the **existing** fixed dev/test users and
policies using `storage.ps1 -Task Up` restored the service, without expanding
access. The final full run passed all 152 checks in 1m53s. No application guard was
weakened to achieve that result. Node/Vite required their normal child processes
outside the sandbox.

Local logs: `.local/native-full-harness-final.log`, `.local/native-node-checks.log`,
`.local/native-db-guards.log`, `.local/native-startup-checks.log`.

## Real browser and real Codex run

Used the actual React development UI at `http://127.0.0.1:5180`, backed by the
development Rust API, PostgreSQL and private object store—not a static mock.

- Created **Scion planner** through the native agent form.
- Created **Evidence-first proposals**, assigned it to the profile and saved
  revision 2. No Paperclip agent was imported or impersonated.
- Assigned the synthetic website Scion at revision 1. Its task remained queued
  until the Handler's **Run now** action.
- The real installed Codex CLI completed that task using the existing local login.
  The agent page showed the actual task, provider session and result digest.
- Opening the result showed four capability hypotheses, missing Handler decisions,
  **Needs Review**, **Human required**, and **Completion is not approval**. The
  digital Scion menu had no physical-scope or supplier-offer actions.
- Paused the profile: assignment/run controls became disabled. Resumed it, then
  edited instructions. Revision history retained all five configuration revisions;
  the existing run still identified agent revision 2.
- Stopped only the managed idle Grimoire worker: the open page reported
  **Disconnected** after the server's 15-second heartbeat lease expired. Last seen
  remained the actual recorded time. Restarting the worker restored Connected.
- Restarted only the task-owned Rust API, reloaded the browser and verified the
  same profile, assigned skill and completed run remained. No browser timer
  recreated that state.
- Desktop two-level navigation and the narrow layout were inspected. No browser
  console errors were reported in the checked session.

Actual persisted identities:

| Record | Value |
| --- | --- |
| Agent | `79f92315-bdf7-4be1-9338-03a064808a81` |
| Scion | `1667c0ad-2d9c-473c-898a-9be0b8fe37a6` |
| Task | `57e41aff-1a61-4d8d-90c9-3daf5a1dc7c3` |
| Proposal | `3376120f-36bc-4c47-b09c-e86d082d8de8` |
| Codex session | `01a0df29-ea4a-7131-af0b-631cc06d7b05` |
| Output SHA-256 | `dfd9f63771bccb42b498c29641d8a5132933f18a56939e1c2d11f6d4d7524f7b` |

Screenshots retained locally: `.local/native-agent-overview.png`,
`.local/native-agent-disconnected.png`, `.local/native-agent-proposal.png`.

## Schema and limits

Migration `0043_native_agents.sql` was applied to development, disposable test and
the new clean `grimoire_startup_agents_v1_test` database. SHA-256:
`0e0166046beb221352884954cd5789cdf669a5e46c5193e3de45bf6f210a6d3f`.
Earlier applied migration files were not edited. The regenerated startup catalog
contains 3,184 signatures; the previous catalog was backed up locally.

This is native Grimoire agent management, not complete Paperclip feature parity.
Only the bounded local Codex adapter is implemented. Skills are instruction
documents, not executable plugins. Per-agent secret vaults/API-key issuance,
provider tracing, additional adapters and dollar budgets/metering are not
implemented or represented as working. See [the native contract](native-agents.md).
