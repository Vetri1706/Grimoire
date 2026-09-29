# Signup and public judge entry verification — 2026-09-29

Implemented on `feature/windows-adaptive-scion`, after base commit `b757562`. Normal signup creates independent non-owner accounts; `/demo` exposes only the three published synthetic cases. Source code changes are local and have not been pushed or deployed to AWS.

| Check | Actual result |
| --- | --- |
| Rust unit tests, strict Clippy, formatting | 27 tests passed; Clippy and formatting passed. Final registration input hardening also passed all five onboarding tests. |
| React typecheck, Node tests, production build | Passed; 7 Node tests, 54 production modules. |
| Live registration HTTP | [12 groups passed](evidence/judge-registration-http-20260929.txt): signup/login, duplicate handling, CSRF, real agent-bearer denial, isolation and authority boundaries. |
| Fresh Chrome | [9 groups passed](evidence/judge-browser-20260929.json): account creation, logout/login, private organization isolation, credential-free demo, current/stale/revoked projections, disconnection and mobile layout; no JavaScript errors. |
| Existing Go acceptance harness | [152 checks passed](evidence/judge-go-20260929.txt) against real Rust, PostgreSQL 17.11 and versioned MinIO; includes physical workflow, duplicate watch effects, revision staleness, revocation and real process restarts. `go vet` and `go test` passed first. |
| Database guards | [All existing guards plus registration passed](evidence/judge-dbguards-20260929.txt), with rollback. Public demo guards separately passed: no runtime registry privileges, foreign publication denied, reader authority drift denied, revoked content hidden, true read-only transactions, normal authenticated locking retained. |
| Startup protection | [19 checks passed](evidence/judge-startup-20260929.txt), including catalog/ledger tampering, runtime privilege escalation and restoration. Clean catalog contains 3,309 entries. |
| Public demo restart | Compared all three cases before/after an actual API process restart: Scion IDs, nodes, edges, task states, event/review IDs and watch IDs remained identical; persisted successful-check timestamps continued forward. |
| Main local instance | [5 fresh Chrome groups passed](evidence/judge-live-primary-20260929.json) at `http://127.0.0.1:5180`; no account or owner setup submitted. |

Isolated verification used PostgreSQL 55434, API 8082, Vite 5182 and MinIO 19002. The existing Go harness's local test copy changed only its hardcoded storage port to 19002; production harness behavior was unchanged. Startup tests used the equivalent isolated storage endpoint. The first attempt at migration 0046 rolled back due to missing audit context; the migration was corrected before any successful application. The first synthetic seed rejected an extra candidate field; the strict payload was corrected before publication.

The primary database was backed up to `.local/backups/judge-entry-20260929/grimoire-dev-before.dump` before applying 0045/0046. Existing private data counts were preserved exactly: 2 organizations, 9 Scions, 13 revisions and 0 Handler identities. Three synthetic cases were added to the reserved public organization. No personal account was created; zero active demo bearer credentials remain. Repeating the completed seed did not create new cases or effects. The pre-existing `scripts/storage.ps1` edit is byte-identical to its backup.

Inspect [current](evidence/judge-public-current-20260929.png), [revoked](evidence/judge-public-revoked-20260929.png) and [mobile](evidence/judge-public-mobile-20260929.png) screenshots. All proposal/task outputs are labeled synthetic protocol records. No provider, personal Codex account, Paperclip execution or human approval was created.

See [judge access instructions](judge-access.md). AWS hosting, the public submission URL, repository/video access and HTTPS/edge configuration remain deployment work; local verification does not establish those submission requirements.
