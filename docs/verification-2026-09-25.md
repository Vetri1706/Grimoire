# Layer 1 execution evidence

Executed locally on 25 September 2026. These are software checks on local/synthetic records; they are not customer validation, qualification, human sourcing approval or production certification.

## Database and supplied bytes

Native PostgreSQL **17.11**, Windows x64, port **55432**. Development database `grimoire_dev`; disposable acceptance database `grimoire_test`. Both use non-login non-superuser `grimoire_migrator` ownership. Runtime login is `grimoire_intake_app`, without ownership, superuser, RLS bypass, database CREATE/TEMP or schema CREATE. Development and test are separate databases in one local cluster; the test database is not product authority.

Unchanged migrations applied in order **0022 → 0023**, followed by new additive **0024 → 0025** in each database. The supplied fixture executed only in `grimoire_test` and completed successfully. The latest read-only database-ledger comparison, rerun at **23:09 IST**, is saved in [migration evidence](evidence/layer-1-migrations-latest.txt); all four applied hashes equal disk in both databases. The supplied 0022, 0023, and fixture bytes also match SHA-256 values computed directly from the original ZIP entries and its manifest. Development still contains no governed cases, offers, or supplied fixture; test contains one fixture case and two offers. No migrations, database resets, or database writes were performed by this comparison.

| Supplied file | Verified SHA-256 |
| --- | --- |
| `0022_grimoire_contract.sql` | `5af2c09b31f1be6b537fba05b7af7c561e4b7e959849532bbed43a8d8de4205b` |
| `0023_grimoire_review_corrections.sql` | `9f7012c8ea6f9e0a32395fa9e569b6f83bff8bbbb7b36862e2a80523b4e82df9` |
| `fixture_one_case_two_event.sql` | `1372d06269030dd33e95adce9e19d0f6d9591523fc4bc641f4d29cabbff6f698` |

New intake tables and tests are not claimed as part of the prior GG-40 verification. The historical GG-42/GG-43 R/AR matrices were not rerun in their entirety.

| New additive migration | Applied SHA-256 in development and test |
| --- | --- |
| `0024_intake.sql` | `e472417bbcf1009b611c4e38ebd0efbd1c6084f7bb28bad9ee2778a06f10b2b9` |
| `0025_intake_history_authors.sql` | `8b5639092f7d5d2e0e6d734fc5936a1ea94a94acf18f9ecae7ab85be60ed4a22` |

## Live Go HTTP harness: 21 of 21 passed

Latest command: `pwsh -NoProfile -File scripts/dev.ps1 -Task Harness`, rerun on **25 September 2026 at 23:08 IST**, rebuilding the Rust binary first. The separate Go harness ran a real compiled Rust child against PostgreSQL 17.11 on `grimoire_test`. Runtime role `grimoire_intake_app` was verified through `/api/health`. The harness selected loopback port **62778**. Rust process PID **25752** was terminated and a distinct process PID **15076** was started; records were reopened after that restart. All 21 checks passed in **433 ms**, with exit code **0**. PostgreSQL stayed running during this harness run; this is a real API process restart. [Exact numbered stdout/stderr](evidence/layer-1-harness-latest.txt) is retained, alongside the earlier dated run. This rerun did not reset either database or restart the development API.

1. PostgreSQL 17 identity and disposable-database guard.
2. Independent authenticated organizations.
3. Missing and invalid authentication denial.
4. Incomplete Scion creation with null unknowns preserved.
5. Reopen and initial history with authenticated Handler display names.
6. Exact idempotent create response/ETag replay.
7. Changed create payload with same key returns 409.
8. Missing `If-Match` returns 428.
9. Revision 2 preserves revision 1.
10. Stale `If-Match` returns 412 without changing history.
11. Concurrent revision-2 edits yield one revision 3 and one 412.
12. Old idempotent responses replay exactly after later revisions.
13. Changed revision payload cannot reuse an idempotency key.
14. Cross-organization list hides the Scion.
15. Cross-organization latest/history/individual revision/write hides existence.
16. History and individual revisions require authentication.
17. Forged organization header cannot grant access.
18. Idempotency keys are isolated by organization.
19. Reopen after actual Rust termination/restart.
20. Idempotency persistence after restart.
21. Digital draft explicitly discloses unavailable vendor comparison.

Every history read also asserts that author names match authenticated `/api/me` metadata, cover exactly the principals referenced in that Scion, and remain outside immutable revision JSON. Foreign and unauthenticated history responses expose neither author metadata nor known Handler names. No mocked HTTP server, database replacement, or direct database queries were used by the Go harness. The separate migration-ledger evidence queries were read-only administrative checks.

## Presentation follow-up and author scope

- The list, case, and form now say, for example, **5 fields entered · 1 unresolved question**. A not-yet-assessed question field is distinguished from an explicitly empty list. Whitespace-only text is not counted as an entered field. No completion bar implies evidence readiness.
- Case open items and **Evidence readiness: not assessed** are separate from field-entry counts. Complete entry never implies verification, qualification, or approval.
- History opens its current snapshot immediately and selects the newest saved revision returned by the history request. Handler names appear in the timeline and snapshot; the principal ID and change summary are available in expandable revision details.
- Live browser verified the exact wording on the existing development case, revision 4 selected automatically, `Local Handler A` displayed, the preserved principal ID in details, and manual selection of the unchanged revision-1 snapshot. These checks did not save a new revision.
- `0025` adds a fixed-scope directory lookup. It does not rewrite 0022–0024, revision data, or retry receipts. Names are current directory labels, not a claim about a historical display-name snapshot.
- Rollback-only SQL tests passed for the new helper: own author names allowed; foreign/nonexistent Scions, mismatched organization/principal, and missing authenticated context return no authors. Direct runtime principal-table access remains denied. Existing SQL immutability and privilege checks also passed.
- Changed implementation: `web/src/App.tsx`, `web/src/api.ts`, `web/src/styles.css`, `api/src/main.rs`, new `db/intake/0025_intake_history_authors.sql`, `api/tests/database_guards.sql`, `harness/main.go`, and the migration list in `scripts/dev.ps1`. API/harness/architecture/startup documentation and raw evidence were updated with the change.

Reproduce this gate from the project root (the reset affects only the disposable test database):

```powershell
pwsh -NoProfile -File scripts/dev.ps1 -Task Migrate
pwsh -NoProfile -File scripts/dev.ps1 -Task ResetTest
pwsh -NoProfile -File scripts/dev.ps1 -Task Harness
pwsh -NoProfile -File scripts/dev.ps1 -Task DbGuards
npm.cmd run build --prefix web
```

## Other completed checks

- Rust: 8 tests passed; formatting, Clippy with warnings denied, and locked build passed.
- Go: formatting, `go vet ./...`, build and CLI help passed.
- UI: TypeScript check and production build passed; npm installation audit reported zero vulnerabilities at execution time.
- Supplemental rollback-only PostgreSQL test passed: UPDATE/DELETE immutability, sequential revision guard, atomic current pointer/audit event, forbidden governed/credential/history privileges, disabled-principal authentication denial, database/schema CREATE/TEMP denial, and an actual attempted runtime temporary-table creation rejected with 42501.
- Browser on the actual development API: connect, create incomplete draft, append revision 2, reload/reopen, and inspect unchanged revision 1 passed. A separate HTTP update created revision 3 while the browser edited revision 2: save rejected with a conflict, unsaved fields remained visible, latest revision loaded separately, and explicit manual reconciliation saved revision 4. The surviving record is clearly named `UI smoke test — enclosure intake` and contains no actual product or supplier evidence.
- A narrow-screen check showed no horizontal overflow; an unlabeled collapsed navigation icon found during inspection was given an explicit accessible name. This was a bounded visual check, not an exhaustive accessibility audit.
- During the follow-up migration, 0022–0024 were skipped unchanged before applying 0025. Fresh ledger queries confirmed all four hashes. Development had zero governed sourcing cases/offers and no supplied fixture; test had one supplied governed fixture case and two offers. `docker compose config --quiet` passed configuration validation during initial setup.
- Native `DbDown` followed by `DbUp` completed successfully. The existing Rust API reconnected and the browser reopened persisted revision 4 after the PostgreSQL server restart.

## Limits and remaining work

- Docker Compose files are supplied, but Compose startup was **not executed successfully** because Docker Desktop failed while initializing `dockerInference`; native PostgreSQL supplied the real database used for all tests. No Docker repair/reset was performed.
- Local development authentication is not production SSO/OIDC. This app binds to loopback and has no production deployment.
- No Paperclip connector, governed draft-promotion endpoint, digital vendor comparison, sourcing approvals, supplier integration, MCP server, worker or S3 workflow is implemented by Layer 1.
- Browser smoke testing is not a complete accessibility or target-role usability study.
- No customer validation, external contact, AWS spend, or deployment occurred.
