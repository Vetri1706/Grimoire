# Layer 3 local verification — 26 September 2026

Implemented a synthetic, reviewable draft-to-physical-scope path and a functioning
local Codex CLI preparation adapter. The original intake/source revisions remain
unchanged. The confirmed physical chain is stored in existing GG-40 tables in
`grimoire_dev`; additive application tables retain proposal and confirmation
provenance. It creates no supplier offer, RFQ, quality release or sourcing
decision approval. All source claims remain unverified.

## Results actually executed

| Check | Result and evidence |
| --- | --- |
| Go against real Rust, PostgreSQL 17.11 and versioned MinIO | **81/81 passed**, final full run 26.111 seconds. [Raw output](evidence/layer-3-harness.txt). |
| Layer 1/2 regression | All prior 55 checks passed, including persistence, immutable revisions, stale edits, retries, organization hiding, exact stored versions, missing/corrupt objects and revocation. |
| Layer 3/BYOA protocol | 26 additional checks passed: typed identity completeness, exact four links, wrong revision/hash/claim/locator, cross-case/organization denial, ambiguous/gapped confirmation denial, separate authority, one winner under concurrent confirmation, exact governed joins/hash readback, unchanged intake/source/claim history, restart persistence, source/intake staleness, revocation, task leases, durable task state and proposal-only completion. |
| Database invariants | Rollback-only guards passed: immutable proposals/confirmations/component revisions; wrong governed configuration rejected; runtime cannot enroll reviewers or write governed tables; dual-role task requester cannot self-confirm through agent attribution. [Output](evidence/layer-3-database-guards.txt). |
| Rust | 13 unit tests passed; `cargo fmt -- --check`, strict Clippy and build passed. |
| Go tooling | `go vet ./...` and build passed. |
| Web | TypeScript typecheck and Vite production build passed. |
| Local bridge guards | 8 Node tests passed: credential filtering, exact input preservation, no missing-field generation, no gap removal/ambiguity promotion, output schema, and refusal of external-tool events. |
| Actual Codex CLI | Installed CLI 0.149.0 used the existing ChatGPT login and returned a real structured proposal; task completed through Rust. This is separate from Go protocol tests. [Execution receipt](evidence/layer3-codex.txt). |
| Browser | Explicit empty form, exact locator inspector, actual task completion, scope audit display and open-tab revocation clearing observed at desktop size. [Detailed observations and limits](evidence/layer-3-browser.txt). |
| Paperclip | `git status --porcelain=v1` returned no changes in the sibling clone. No connector was enabled. |

An initial regression run stopped at check 50 because MinIO briefly denied a
policy operation immediately after restart. Bounded retries of the same
idempotent administration call resolved it without changing credentials or
broadening policy. Two subsequent full 81-check runs passed. Initial Codex
attempts remained failed task records while the adapter's diagnostic-event guard
and temporary cleanup handling were corrected; the later real task completed.

## Inspectable development records

- [Codex preparation demo](http://127.0.0.1:5173/#/scions/f2f3b2ab-d9e7-45af-8897-a11698cf3cb7): task `b6fe5dc5-fb21-45e2-b399-c055e1e501a1`, proposal `7bdf2955-16f5-40e5-84a6-ea50c434b59a`, author `Local Codex Proposal Agent A`. It remains **unconfirmed**, awaiting separate reviewer action.
- Provider run: `01a0d9e8-293d-7601-a49a-6c882d73ba84`; output SHA-256 `b254869d4d8d03baddef22c8566fd9791d00fdc47154949bcee24421216a4aba`. Source bodies and claim quotes were not sent to this adapter. It checked/prepared supplied candidate data, not source truth.
- [Revocation probe](http://127.0.0.1:5173/#/scions/41cf489a-f0c8-43a6-acbb-2209b77aadf8): separately confirmed using the synthetic reviewer over HTTP, then two source permissions revoked. The UI retains the confirmation audit record but blocks the binding and hides derived content.
- The original Layer 1/2 demonstration Scion `d83bbaf8-412a-42f6-979b-4fbac68673bd` and its sources were not changed by this slice.

No real qualified reviewer or customer validation is claimed. A synthetic role
exercises the authorization mechanism only. Revision numbers are allocated by
the governed model on confirmation, never guessed for a missing field. This
slice creates one initial synthetic chain per Scion; subsequent governed
revision/change-control, substitution, and production qualification flows are
not implemented.

## Applied migrations

Both canonical `grimoire_dev` and disposable `grimoire_test` have matching ledger
and file hashes through `0030`. [Full applied/file hash output](evidence/layer-3-migrations.txt)
includes all migrations and the unchanged fixture. The fixture remains confined
to `grimoire_test`.

```text
0022 5af2c09b31f1be6b537fba05b7af7c561e4b7e959849532bbed43a8d8de4205b
0023 9f7012c8ea6f9e0a32395fa9e569b6f83bff8bbbb7b36862e2a80523b4e82df9
0028 c5a4e8f949686c3d59a013cdae6d6b72b9a8c5181abc1e923cf65b9c8b52091e
0029 2e76207e877b9677296cad0587c621667768fabe12d3deda36c0d149f514966e
0030 df75406373d3e5b7b73e1499712e6f4e8085e76afd9acd1e268cd0e34741b9a0
```

`0022`–`0027` were preserved byte-for-byte. `0028` adds scope proposals and links;
`0029` adds the local agent queue; `0030` adds complete chain readback and original
task-requester self-review protection. These additions are not part of the
verified GG-40 migration package.

## Run and reproduce

From `C:\proj\Grimoire\grim`, using the already configured native local runtimes:

```powershell
pwsh -NoProfile -File scripts/dev.ps1 -Task DbUp
pwsh -NoProfile -File scripts/storage.ps1 -Task Up
pwsh -NoProfile -File scripts/dev.ps1 -Task Migrate
pwsh -NoProfile -File scripts/dev.ps1 -Task Api
# Separate terminals:
pwsh -NoProfile -File scripts/dev.ps1 -Task Web
pwsh -NoProfile -File scripts/byoa.ps1 -Mode Watch
```

The API listens on `127.0.0.1:8080`, Vite on `5173`, PostgreSQL on `55432`, and
MinIO on `19000`. See [BYOA commands](byoa-local.md) for single-task/background
operation. Tokens remain in ignored `.env`; choose Handler A for preparation
and the separate synthetic reviewer token for confirmation. Never supply the
reviewer token to Codex. The UI reports task state rather than a live worker
heartbeat; the adapter supports only synthetic scope preparation.

A managed background worker was left running after an actual Stop → Start →
Status check (PID 30096 at verification). `scripts/byoa.ps1 -Mode Status` reads
its current process state; `-Mode Stop` stops only the verified managed worker
when no Codex child task is active. This process status is separate from the
successful model-task receipt above. No additional model run was triggered by
the lifecycle check.

To reset disposable test data and repeat acceptance:

```powershell
pwsh -NoProfile -File scripts/storage.ps1 -Task ResetTest
pwsh -NoProfile -File scripts/dev.ps1 -Task ResetTest
pwsh -NoProfile -File scripts/dev.ps1 -Task Harness
pwsh -NoProfile -File scripts/dev.ps1 -Task DbGuards
node --test byoa/bridge.test.mjs
```

These reset only the fixed test database and test bucket. Development has a
persistent database cluster and object directory. No deployment, AWS action,
supplier contact or Paperclip database dependency occurred.

## Changed files

| Area | Files |
| --- | --- |
| Rust/domain | `api/src/scope.rs`, `byoa.rs`, `main.rs`, `error.rs`, `domain.rs`; `api/tests/scope_guards.sql` |
| PostgreSQL | `db/intake/0028_intake_scope.sql`, `0029_intake_agent_tasks.sql`, `0030_scope_chain_guard.sql`; `db/local-scope-actors.sql` |
| React interface | `web/src/PhysicalScope.tsx`, `scope-api.ts`, `physical-scope.css`, `App.tsx` |
| Acceptance harness | `harness/scope.go`, `agents.go`, `main.go`, `process.go` |
| Local execution | `byoa/bridge.mjs`, `bridge.test.mjs`; `scripts/byoa.ps1`, `seed-synthetic-scope.ps1`, `dev.ps1`, `storage.ps1` |
| Documentation/evidence | `README.md`, `docs/layer-3-api-contract.md`, `byoa-local.md`, `storage-recovery-backlog.md`, `ui-style.md`, this report and linked evidence files |

Paperclip architectural references are listed in [the BYOA boundary](byoa-local.md#architecture-references):
`skills/paperclip/SKILL.md`, `packages/adapters/codex-local/src/server/execute.ts`,
`codex-args.ts`, `server/src/routes/issues.ts`, `server/src/services/issues.ts`,
and `server/src/routes/approvals.ts`.

## Remaining gates and cleanup

The [separate storage backlog](storage-recovery-backlog.md) retains upload crash
recovery, orphan reconciliation, consistent backup/restore, physical erasure,
Object Lock, signed-URL expiry/revocation, production/cloud storage behavior and
role-specific audit metadata policy. These were not demonstrated by Layer 3.
All enabled same-organization roles currently retain audit metadata access,
including hashes after revocation; real-data role policy remains unapproved.

Automatic approval review rejected recursive cleanup of
`C:\Users\Nemean Cestus\AppData\Local\Temp\grimoire-byoa-OcOsV2` with the reason
`blocked by policy`; no more detailed reason was provided. That first-attempt
folder remains with synthetic `task.json` and `output-schema.json`, no credentials.
The successful task's temporary workspace was cleaned normally. No alternate
deletion method was attempted, and no physical-erasure claim is made.
