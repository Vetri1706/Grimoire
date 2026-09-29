# Grimoire OS verification — 2026-09-26

This is local Windows execution evidence against React, the Rust API,
PostgreSQL 17.11 and versioned MinIO. The adjacent Paperclip backend already
running on port 3100 was inspected, not replaced or reset. Existing Grimoire
development cases and earlier clean startup databases were retained.

## Automated checks

- Full Go HTTP acceptance harness: **141 checks passed**, including ten OS
  checks and the existing intake, evidence, physical, offer, adaptive and worker
  regression checks. The harness terminated and restarted its actual Rust child;
  PostgreSQL and stored watches remained running/persisted.
- Focused OS harness: **10 checks passed** separately.
- Go formatting and `go vet ./...` passed.
- Rust: **21 unit tests passed**; `cargo fmt --check` and
  `cargo clippy --locked -- -D warnings` passed.
- Node bridge/MCP: **17 tests passed**, including termination of the exact managed
  child on lost control permission; unrelated children remain alive.
- React TypeScript check and Vite production build passed.
- Rollback-only database guards passed, including repeated exact watch-event
  delivery, unchanged audit/review/task counts and state identities, runtime
  mutation denial, and direct foreign-organization RLS hiding.
- Windows startup attestation: **19 checks passed** against clean
  `grimoire_startup_os_v3_test` and upgraded `grimoire_test`. Function replacement,
  ledger mismatch, broader runtime authority and disabled FK triggers are denied;
  restoration/startup is verified after each isolated probe.

Local evidence is retained in `.local/os-harness-final.log`,
`.local/os-focused-final.log`, `.local/os-db-guards.log`,
`.local/os-startup-checks.log` and the timestamped startup JSON report.
Initial sandbox esbuild/Go-cache and MinIO lifecycle access failures were
environmental; the build/outage test were rerun with permitted child execution
and service control, and Go with a workspace-local cache.

## Real-browser acceptance

Tested the running application at `http://127.0.0.1:5180` using the Codex
in-app browser, not a static mock or intercepted response.

| Scenario | Observed result |
| --- | --- |
| Actual Codex website case `1667c0ad-2d9c-473c-898a-9be0b8fe37a6` | Current capability proposal and recorded agent provenance; internal sources, unavailable external provider connector, blocked comparison, missing Handler decision and human-only gate. No digital physical/supplier tabs. |
| Separate browser protocol case `5d326e0d-674b-4a02-8fed-1868044221eb` | Actual task starts in active work, then completion removes it from active work and creates human review, not approval. |
| Revise protocol case while open | Plan becomes stale; pinned derivative content is withheld; current Scion revision is refreshed. |
| Revoke selected source while its content is visible | Without a page reload, source becomes `Revoked source`; title, text and quotes disappear, including the unique synthetic marker from the whole DOM. Dependent work is blocked and stale. |
| Replay completion/revision/revocation | Exactly four case watch events remain: initial source revision, task completion, Scion revision and source revocation. No duplicate human review or approval. Direct SQL tests also redeliver an identical event twice. |
| Stop task-owned Grimoire API | Disconnection alert replaces the graph and operations; sensitive content is absent. |
| Restart task-owned API | Persisted stale/blocked state, source revocation and the four events return; heartbeat advances again. |
| Point only the Grimoire Paperclip binding at unreachable loopback port 9 | Paperclip is explicitly disconnected; no remote agents/runs are retained. Grimoire internal monitoring stays healthy. Actual Paperclip server is not stopped. Original binding restored afterward. |
| Log in as foreign workspace B and open the same case URL | `Scion not found`; no case nodes, edges, alerts or Paperclip metadata. |
| Open preserved physical two-offer case | Physical scope and offers tabs remain. The stored exact comparison loads, Supplier A remains comparable and mismatched Supplier B remains excluded. No new physical mutation was made. |

The actual-Codex case is preserved. The new protocol fixture explicitly says
**not LLM**: it exercises the real worker protocol without claiming a new Codex
execution. Its setup/transition script is `scripts/control-surface-demo.ps1`.

## Separate Paperclip verification

The local organization A binding points to the existing company
`387dd903-6cb7-4cd3-9a02-efa7ff66088c`. The live backend returned its existing CEO
`codex_local` agent, six configured skill assignments, and one historical
succeeded workspace run. The latter is explicitly **not Scion-linked**. No run,
agent, company, credential or skill assignment was created by this change.

The real company-specific agents and skills destinations loaded in the browser.
Paperclip's own skills UI showed eight available bundled skills, six enabled for
the agent. The Grimoire connector shows returned assignment state, not a claim
that those skills executed. Codex/BYOA configuration, execution and management
remain in the full separate Paperclip application.

Screenshots: `.local/os-control-surface.png`, `.local/os-browser-revoked.png`,
`.local/os-browser-disconnected.png` and `.local/os-paperclip-skills.png`.

## Boundaries

- No simulated live vendor monitoring, external provider evidence or new
  Paperclip runs. Paperclip integration is read-only and company-scoped.
- Browser polling is a bounded display-access check, not monitoring execution.
  Transactional event capture and persisted server heartbeats operate independently.
  Browser suspension/copies prevent an instantaneous retroactive erasure guarantee.
- Existing sourcing approval remains disabled. Watch review tasks are persisted
  human obligations, not autonomous approvals or a second agent scheduler.
- Native PostgreSQL/MinIO and local-trusted Paperclip were verified; remote
  Paperclip authentication, cloud deployment and backup restoration were not.
- The separately unavailable Mac work is not represented as verified here.
