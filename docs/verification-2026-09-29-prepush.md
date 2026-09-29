# Windows feature branch pre-push verification

Verified the local Windows control surface, company workspace and native agent
changes on 29 September 2026. The separate remote
`gg67-organization-onboarding` branch was not integrated. The merged `master`
history is included without replacing these local features.

## Checks run

- Rust formatting, 20 unit tests and strict Clippy: passed.
- TypeScript and Vite production build: passed after both UI corrections below.
- Node bridge and local MCP tests: 18 passed.
- Go vet and package compilation: passed (the harness packages have no unit tests).
- Live `control-surface` Go slice: 21 checks passed against the Rust API,
  PostgreSQL 17.11 and the real versioned test bucket. This includes organization
  isolation, source revocation, stale proposals, duplicate events, monitoring
  without a browser, native agent guards and actual API restarts.
- All `dev.ps1 -Task DbGuards` rollback-only SQL guards: passed, including
  Watchtower and native agent isolation and immutability.
- Migration lists agree across development startup, Rust attestation and the
  Windows startup script; the API accepted the compiled catalog during the live
  harness run. No applied migration was edited.
- Git whitespace check and review of changed paths for credentials: passed.

The full 152-check regression and browser evidence remain the historical results
in [native agent verification](verification-2026-09-27-native-agents.md).
The full harness, browser scenarios and adversarial startup script were not
rerun for this pre-push check.

## Small corrections from review

- Editing a live-updated Scion now passes its current revision into the parent
  form rather than reopening the older cached revision.
- An empty activity feed no longer claims that monitoring is active; monitoring
  health remains derived from the server response.
- README now links the superseding native-agent verification report.

The reviewed implementation contains no external provider monitoring or
Paperclip runs. Agent completion still creates only a proposal requiring human
review, never an approval.
