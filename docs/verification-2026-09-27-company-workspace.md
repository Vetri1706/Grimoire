# Company workspace verification — 2026-09-27

Verified against the actual local React app, Rust API, PostgreSQL 17.11 and
versioned MinIO. The separate existing Paperclip service remained untouched.

## Automated checks

- Full Go HTTP harness: **144 passed**, including all existing physical-flow
  regressions and three new workspace projection/authentication/isolation checks.
- Focused OS harness: **13 passed**.
- Rust: **21 unit tests passed**, `cargo fmt --check` and strict Clippy passed.
- Node bounded worker and local MCP: **17 passed**. Sandbox process creation was
  denied initially; the same tests passed with approved local execution.
- PostgreSQL rollback-only guards passed, including direct duplicate-event
  delivery, RLS, source rights and immutable audit/task effects.
- Windows startup/authority checks: **19 passed**.
- TypeScript and production Vite build passed; `git diff --check` passed.

The full harness verifies revision staleness, source revocation, denied worker
control, no approval on completion, duplicate-event idempotency, foreign graph
and alert isolation, autonomous server checks, and actual API restart recovery.
The new company checks additionally assert content-free blocked proposal
metadata, no side effects from repeated reads, authentication, rejected POST,
and absence of another organization's case/proposal/task/source identifiers.

## Real browser

- Desktop company navigation, Dashboard, Proposals and the Blocked filter work.
- The real website Scion opens its saved proposal with five collapsed capability
  rows, missing Handler decision, explicit human review and a task adapter.
- A previously revoked synthetic fixture shows a blocked proposal and hides
  derivative content. This is a UI regression check; fresh mutation/restart
  behavior is covered by the full harness and the prior OS browser report.
- Agents displays the real Paperclip CEO, `codex_local`, idle state and six
  configured skills; Skills distinguishes configured from merely available.
- Watchtower displays persisted healthy checks, not invented provider checks.
- Digital navigation excludes physical scope/supplier offers. The physical
  case still shows its two real synthetic offers and the exact comparison:
  Supplier A comparable, Supplier B excluded for mismatched physical identity.
- Company B has its own empty queues and no Paperclip binding; no A records
  appear in its dashboard, proposals or activity.
- Stopping the owned development API clears company records and shows an
  explicit disconnection; restarting it restores the same counts, required
  reviews and healthy watch state without reloading the browser.
- Narrow-screen layout retains accessible icon navigation and single-column
  Scion content; desktop sidebar labels and property rails were also checked.

Screenshots are local, ignored verification artifacts under `.local/`:
`company-proposal-detail.png` and `company-dashboard.png`. Test logs are
`company-workspace-harness.log` and `company-workspace-db-guards.log`.

No external vendor monitoring, approval, new agent run or Paperclip scheduler
was fabricated. No existing Paperclip edits, credentials or databases were reset.
