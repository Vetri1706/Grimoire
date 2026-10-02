# Testing

Run commands from the repository root. Test results apply to the source and environment that were actually checked. A successful unit test or worker heartbeat does not establish live model execution.

## Unit tests and build

```powershell
cargo test --manifest-path api/Cargo.toml --locked
cargo fmt --manifest-path api/Cargo.toml -- --check
node --test byoa/*.test.mjs connectors/local-mcp.test.mjs
npm.cmd --prefix web test
npm.cmd --prefix web run typecheck
npm.cmd --prefix web run build
```

The web prebuild runs `npm pack` for the connector and creates the downloadable tarball, Windows ZIP and release manifest under ignored `web/public/downloads/`. It does not publish a package or deploy the app.

## Connector package

After the web build, verify the actual archives outside the checkout:

```powershell
node scripts/verify-connector-package.mjs --node (Get-Command node).Source
powershell -NoProfile -File byoa/bootstrap/windows.test.ps1
```

The package verifier checks the file allowlist, source bytes, checksums, CLI commands and offline npm execution. Its readiness check uses the existing local Codex installation without invoking a model. See the [connector guide](../byoa/README.md) and [Windows bootstrap guide](../byoa/bootstrap/README.md) for supported runtimes and optional download verification.

## Browser and real-stack checks

Use an isolated disposable database and object store. Never point destructive reset, migration-fixture or synthetic-account tests at production or a personal workspace. Follow each script's required configuration and disposable-target guards.

- [Acceptance harness](../harness/README.md): API, database, source permissions, revision changes and persistence.
- [Public demo](judge-access.md): signup, account isolation and current/stale/revoked examples.
- [Google sign-in](google-sign-in.md): verifier, challenge, replay and browser checks. Mocked callbacks do not prove real Google authentication.
- [Native agents](native-agents.md) and [local BYOA](byoa-local.md): assignments, workers, cancellation and proposal authority.
- [Public research](public-web-research.md): source retrieval, report review, withdrawal and restart behavior. Live Codex tests require explicit opt-in and consume account usage.
- `scripts/verify-worker-lifecycle.mjs`: disposable-stack checks for pairing, revocation, heartbeat expiry, receipt replay and cancellation.

Store new screenshots and raw test output under `.local/`. Current release records are retained in [docs/evidence](evidence/); older verification reports and captures remain recoverable from Git history.
