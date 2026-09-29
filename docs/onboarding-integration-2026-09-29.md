# Login and owner setup integration

The incoming GitHub branch is `gg67-organization-onboarding`, commit
`0df33383186c924f8102c5cb2f3ea8cf55fc5b2c`. Its login and one-time owner setup
are integrated with the existing `feature/windows-adaptive-scion` control
surface, company workspace, native agents and physical workflow.

This is local installation authentication. It is not unrestricted public signup
and does not register additional independent users. First use creates a Handler
identity and an empty organization; later visits use the login form. The opaque
session cookie is HttpOnly, SameSite=Strict and server-revocable. Keep this local
release bound to loopback HTTP as required by the API.

## Integration decisions

- Retain current Watchtower/Operations/case graph and native Grimoire workspace
  screens. The branch's earlier directional case-board design is superseded.
- Retain the existing Watchtower schema and revision reactions. Do not install
  a second older review-task pipeline from the incoming branch.
- Apply the incoming onboarding schema as additive
  `0044_organization_onboarding.sql`, after the current migration history through
  `0043`. Existing accepted/applied SQL files remain unchanged. Original branch
  documentation mentioning `0035` is historical provenance, not this checkout's
  migration sequence.
- Check compiled migration hashes and regenerate the reviewed catalog from a
  clean database. Existing development databases upgrade without resetting
  Scions, sources, agents, or organizations.
- Give an organization owner workspace-management capability while preserving
  separate sourcing, task-execution and approval permissions.
- Bind session workspace requests to the organization displayed by that page.
  The server checks the expected organization against canonical session state;
  a client header never selects an arbitrary organization. Cross-tab changes
  invalidate stale views instead of silently writing into another workspace.
- A failed logout remains visible and retryable. Serialize organization switches
  and apply the existing HTTP audit context to cookie and bearer identities.

## Running after pulling

From the main checkout, start PostgreSQL and run `scripts/dev.ps1 -Task Migrate`
before starting the new API. This applies only unapplied migrations and preserves
the existing database. Start the existing object store and API, then the Vite
frontend as described in the README. The browser uses Handler setup/login;
`.env` tokens remain only for the development harness.

## Verification on 29 September 2026

- Rust: 23 unit tests, formatting and strict Clippy passed.
- Frontend: typecheck/production build and 4 request/session contract tests passed.
- Live authentication: [22 checks passed](evidence/onboarding-integration-http-20260929.log), including real login/logout, CSRF, authority denials, organization isolation, stale-tab writes and revoked sessions.
- Real Chrome: 6 scenario groups passed with no JavaScript page errors. Covered owner setup/login, digital graph/intake action, native agent configuration without task authority, organization switching, desktop/mobile layout, cross-tab invalidation and logout recovery. Only the failed-logout outage response was deliberately injected; successful authentication used the real API.
- [Full live Go regression](evidence/onboarding-integration-go-20260929.log): 152 checks passed against Rust, PostgreSQL 17.11 and versioned MinIO, including physical scope/offers, source revocation, Watchtower idempotency, foreign organization denial, native agents and actual API restarts. Go vet/package compilation also passed.
- All rollback-only database guards passed after the live harness populated the required physical fixtures; the new onboarding guards also passed independently.
- [Startup attestation](evidence/onboarding-integration-startup-20260929.log): 19 checks passed, including catalog, migration-ledger, function, privilege and trigger tampering denial and restoration.
- [Nonempty upgrade](evidence/onboarding-integration-upgrade-20260929.md): `0043` to `0044` preserved the exact synthetic Scion revision and measured organization/principal/audit/watch counts. All 20 preexisting SQL files and 105 unrelated function definitions remained unchanged.

Tests used a separate checkout and PostgreSQL port 55434, MinIO port 19002,
API ports 8082/8083, and Vite port 5182. The Go harness and storage helper were
copied into ignored test scratch space with only their fixed MinIO port changed
to 19002; production harness source stayed unchanged. No provider/model calls
or real approval decisions were made.

Screenshots: [desktop graph](evidence/onboarding-integration-graph-20260929.png)
and [mobile workspace](evidence/onboarding-integration-mobile-20260929.png).
