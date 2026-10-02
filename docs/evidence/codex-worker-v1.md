# Codex worker pairing verification — 1 October 2026

Implementation tested in the working tree based on commit
`00a542d8e65e7e3c8107dd506151dee8d5ee2801`.

## Result

An ordinary signed-up Handler can create an isolated organization, prepare
digital Scion work, and explicitly authorize a local Codex worker. Pairing never
uploads the Codex login, grants human approval authority, or dispatches work.
The local connector receives one scoped credential, stores it privately, and
uses it only with its enrolled origin. Runtime settings display persisted
enrollment, server heartbeat, disconnection and revocation.

## Checks actually run

| Check | Result |
| --- | --- |
| `cargo test --manifest-path api/Cargo.toml` | 45 passed |
| `cargo fmt --manifest-path api/Cargo.toml -- --check` | Passed after formatting |
| `node --test byoa/bridge.test.mjs byoa/connection.test.mjs` | 29 passed |
| Frontend `npm.cmd test` | 10 passed |
| Frontend `npm.cmd run build` | Passed; Vite reports the existing large-chunk advisory |
| Go vet and package checks | Passed |
| Full running-API Go acceptance harness | 152 passed, including physical workflows, exact source storage, revocation, Watchtower, native agents and actual Rust restarts |
| `scripts/verify-worker-connections.mjs --disposable` | 11 passed, including concurrent one-time credential consumption |
| `scripts/verify-registration.mjs --disposable` | 16 passed |
| `scripts/verify-onboarding.mjs --disposable` | 23 passed |
| `web/tests/codex-worker-pairing.mjs` | 10 real Chrome/CLI checks passed; no browser errors |
| `scripts/windows-startup-checks.ps1 -Task Check` | 19 passed against clean and genuinely upgraded PostgreSQL 17 databases |
| Workspace preparation SQL guards | 13 assertions passed |
| Worker connection / onboarding SQL guards | Both passed, four groups each |

All destructive fault checks used isolated databases on PostgreSQL port 55434
and the disposable object-store bucket on port 19002. The Go storage fault
helper intentionally pins port 19000 in the repository; an ignored copy of the
current harness changed only that fixed endpoint to 19002 for this run.
The runtime was `grimoire_intake_app`, not the migration owner.

The genuine upgrade test built migrations through 0048, persisted a digital
Scion and queued task, then applied 0049/0050. Scion, revision, task, task-event
and watch-record digests remained unchanged. The resulting 3,516 schema catalog
entries matched the clean migration database exactly.

## Browser evidence

The test used the actual installed Codex CLI for local login discovery, the
actual pairing command, and the actual idle worker. It exercised fresh signup,
organization creation and fresh-browser login without losing the pairing link;
explicit consent; foreign organization and foreign account denial; heartbeat;
transport failure; worker stop/restart; and browser revocation. Refreshing the
browser did not advance a stopped worker's last heartbeat.

Test screenshots and the machine-readable result remain ignored under
`.local/codex-worker-pairing/1790873967650/`. No scoped credential reached browser
storage or responses. Test children were stopped, their connection was revoked,
and their local credential file was removed.

No model was invoked in this pairing verification. The completion and approval
boundaries were exercised with explicit synthetic protocol fixtures in the
Rust/PostgreSQL/Go checks; they are not represented as live Codex generations.
The user's first provider task still requires their explicit browser connection
consent and task dispatch.

## Migration identity and boundaries

- `0049_workspace_preparation.sql`: `8f40d7032b706d80839dfcc8aedb66fa657ca29984f57d93a1e5a646528a00be`
- `0050_worker_connections.sql`: `7875cc79ff6afcad9f59a266e8883e84b7e77e1a70fa792c1d675f51788d5ec1`

Permission remains synthetic preparation only. This is not the outstanding
provider-policy decision or Windows process-tree containment certification.
Revocation invalidates authorization immediately; interrupted tasks retain their
existing lease until the established expiry-recovery path runs.

A schema dump/restore trial changed the textual representation of 20 expressions
and 15 default ACLs and was rejected by startup attestation. That database was
preserved for inspection. The catalog check was not weakened to accept it;
clean migrations and in-place upgrades both passed.

AWS deployment remains deferred. These checks created no AWS resources.

## Normal local installation

After verification, the existing `grimoire_dev` database on port 55432 was backed
up and migrated in place through 0050. All 101 pre-existing table fingerprints
and counts, plus all 24 historical migration rows, were identical before API
startup. The two additive migration entries bring the ledger to 26. Existing
`.env` and object-store configuration bytes were unchanged.

The normal frontend on `http://127.0.0.1:5180/` and Rust API on port 8080 passed
their health checks with the least-privilege runtime role and startup attestation.
The backup, fingerprints, ledger comparison and runtime report are retained in
ignored `.local/backups/codex-v1-primary-20261001T170341399Z/`. Isolated test
services were stopped while their databases and evidence were retained.
