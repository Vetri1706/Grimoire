# Isolated onboarding upgrade verification

Verified on 2026-09-29 against base commit `d2a5a662f1deb39f238d58ee2a0b55acd5890cc1` plus the pending onboarding integration.

Only PostgreSQL `127.0.0.1:55434` was targeted. The wrapper verified the port configuration and canonical data directory under `C:/proj/Grimoire/grim-integrate-onboarding/.local/pgdata` before any write. The primary cluster on port 55432 was not queried or modified.

## Upgrade result: PASS

Commands:

```powershell
.local/pwsh/pwsh.exe -NoProfile -File .local/verify-onboarding-upgrade.ps1
```

The wrapper recovered `HEAD:scripts/dev.ps1` into `.local/dev-before-onboarding.ps1`, used its original migration list to create a new isolated `grimoire_dev` through `0043`, and inserted one synthetic digital Scion through `SET LOCAL ROLE grimoire_intake_app` with an authorized seeded Handler and explicit transaction context. It then ran:

```powershell
.local/pwsh/pwsh.exe -NoProfile -File scripts/dev.ps1 -Task Migrate -Mode native
```

Migration `0044` preserved all measured preexisting state:

| State | Before | After |
|---|---:|---:|
| Organizations | 2 | 2 |
| Principals | 4 | 4 |
| Scions | 1 | 1 |
| Revisions | 1 | 1 |
| Intake audit events | 1 | 1 |
| Watches | 3 | 3 |
| Watch events | 0 | 0 |

Retained Scion: `77770000-0043-4000-8000-000000000001`.

The complete revision row had identical SHA-256 before and after: `37b8b5ef42a4a9d3cb7159110d27213f48b4fc511137f1735c24d4ba2d921bb6`.

Installation setup remained required. All 105 unrelated existing function definitions were unchanged; only the three intentionally replaced functions were excluded: `app.intake_can_write`, `grimoire.intake_guard_revision`, and `app.intake_save_managed`.

## Database guards

The first full `DbGuards` run passed the database and source suites, then stopped because the scope suite requires confirmed physical-scope fixtures from the live harness, which were not yet present. This is recorded in `onboarding-upgrade-0043-0044.log`; the full suite is not represented as passing.

The standalone onboarding suite passed:

```powershell
.local/pwsh/pwsh.exe -NoProfile -File .local/run-isolated-dbguards.ps1 -Checks onboarding
```

It verified cross-session organization retry idempotency, conflicting retry rejection, organization membership persistence, workspace versus procurement authority, native skill configuration without task-assignment authority, foreign organization denial, and revoked/expired/disabled session denial. All fixture mutations rolled back. See `onboarding-dbguards-onboarding.log`.

## Access-control review

- New identity/session tables revoke PUBLIC privileges and grant no direct runtime table access.
- New API functions revoke PUBLIC execution and grant only the unprivileged runtime role.
- Workspace administration explicitly excludes agents.
- The procurement predicate is narrowed; task binding, source processing, physical review, and approval keep their existing distinct authority checks.
- Session requests verify their live identity and canonical active organization; the organization header is a consistency precondition and never selects a tenant.
- Native profile/skill configuration uses the narrow workspace predicate; task execution and assignment remain separately guarded.

No provider calls, policy approvals, source-revocation weakening, or primary-database resets were performed.
