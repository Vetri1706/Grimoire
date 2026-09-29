# Google sign-in verification — 2026-09-29

Implemented locally on `feature/windows-adaptive-scion`, after base commit `b757562`, alongside the pending signup and public demo changes. No changes have been committed, pushed or deployed to AWS during this work.

The supplied public Web client ID is configured in the ignored `.env`. The primary Rust API was restarted with the tested binary after a database backup and migration 0047. No Google client secret is stored or used. Normal signup/login, separate installation ownership, and the public synthetic judge entry remain available.

| Check | Actual result |
| --- | --- |
| Rust | 38 unit tests passed, including 9 verifier tests; strict Clippy and formatting passed. Tests use ephemeral RSA keys, with no production key override. |
| Frontend | 10 Node tests passed; typecheck and production build passed (56 modules). |
| Google HTTP boundary | 4 groups passed with Google disabled; 8 with a deliberately synthetic configured client. Checked browser marker, bearer denial, cookie/nonce separation, no session from a challenge, malformed/unknown/duplicate cookie denial, invalid credentials, replacement, logout and public demo. No real Google token used. |
| Real Google public keys | [Production verifier fetched and parsed Google's fixed public JWKS](evidence/google-live-jwks-20260929.json), denied a deliberately unknown signing key and issued no session. |
| Google SQL boundary | All [database guards passed](evidence/google-dbguards-20260929.txt), including 7 Google groups and rollback. Checked private table/function grants, nonce/replay/expiry, auth-method separation, no auto-membership/ownership, disabled identity and membership handling. |
| Concurrent database calls | Two actual two-connection lock-contention tests passed: different challenges for the same subject produced one identity/two sessions; one challenge used twice produced exactly one session. Synthetic fixtures were removed. |
| Google UI protocol | 6 real Chrome groups passed with explicitly mocked GIS/API callbacks: SDK loading/retry, expiry/retry, nonce and callback behavior, duplicate callback handling, stale callback suppression and password-form coordination. No browser JavaScript errors. |
| Signup and demo regression | [9 real Chrome groups passed](evidence/google-browser-regression-20260929.json), and all 12 registration HTTP groups passed against the real isolated API/database. Covers session persistence, organization isolation, current/stale/revoked cases, hidden content, disconnection and mobile layout. |
| Missing Google configuration | [3 real browser groups passed](evidence/google-disabled-browser-20260929.json): accurate unconfigured status, passphrase entry retained, no Google requests and no JavaScript errors. |
| Existing Go acceptance | [152 checks passed](evidence/google-go-20260929.txt) in 2m13s against Rust/PostgreSQL/versioned MinIO; `go vet` and `go test` passed. Includes the physical workflow, watch idempotence, revocation, organization isolation, actual process restarts and completion without approval. |
| Windows startup | [19 checks passed](evidence/google-startup-20260929.txt), including clean/upgraded schema, migration ledger/catalog tampering, role guards and restoration. Compiled catalog contains 3,339 entries. |
| Real Google browser entry | [Fresh Chrome at localhost:5180](evidence/google-provider-entry-20260929.json) loaded the official GIS button and opened Google's account entry displaying “to continue to Grimoire.” No origin/client rejection or JavaScript error. Stopped before entering credentials or selecting an account; the API session remained unauthenticated. |

The real provider entry check establishes that the configured client/local origin can open Google's flow. It does **not** establish a completed Google authentication or production deployment. Interactive account sign-in, logout/returning sign-in and a second real Google account's isolation remain operator checks described in [setup instructions](google-sign-in.md). Automated Rust/SQL/browser checks validate those boundaries with synthetic fixtures.

The provider browser report includes an expected unauthenticated session 401, a React development StrictMode aborted config request, and a Windows GPU warning. These did not prevent the official button or popup. A separate fresh `/demo` browser context loaded the real case graph without any Google SDK or authentication requests. See [official button](evidence/google-signin-button-20260929.png) and [provider popup](evidence/google-provider-entry-20260929.png).

Verification used isolated PostgreSQL 55434, MinIO 19002, Vite 5182 and APIs 8082/8083. Only the isolated enabled API used a synthetic test client ID. The Go/startup test copies changed their hardcoded storage endpoint to 19002; production scripts were preserved. No external provider login, model run or approval was simulated in production.

Before upgrading the primary instance, the database, `.env`, existing API binary and `scripts/storage.ps1` were backed up under `.local/backups/google-signin-20260929/`. The database dump is 1,022,649 bytes. After migration and browser checks, primary data still contains 3 organizations, 12 Scions, 17 revisions, 0 Handler/Google identities, 0 installation owners, 3 published synthetic scenarios and 0 active demo bearer credentials. The existing storage script is byte-identical to its backup (SHA256 `d643ae6789619c9553c1022180211b68adb8d68b0f0f1df22a5a5c750849130e`).

Commands used from `grim` (integration target/config paths are local and ignored):

```powershell
$env:CARGO_TARGET_DIR='C:\proj\Grimoire\grim-integrate-onboarding\api\target'
cargo test --manifest-path api/Cargo.toml
cargo clippy --manifest-path api/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path api/Cargo.toml -- --check
npm.cmd --prefix web test
npm.cmd --prefix web run build
node web/tests/google-signin.mjs
node scripts/verify-google-concurrency.mjs --config C:\proj\Grimoire\grim-integrate-onboarding\.env --disposable
# GRIMOIRE_API_URL selects the isolated disabled or configured test API.
node scripts/verify-google-http.mjs --disposable
node scripts/verify-google-http.mjs --disposable --enabled
node scripts/verify-registration.mjs --disposable
# GRIMOIRE_WEB_URL selects isolated 5182; GRIMOIRE_TEST_DISPOSABLE=1.
node web/tests/judge-entry.mjs
```

Database guards ran through the isolated `scripts/dev.ps1 -Task DbGuards -Mode native`; startup used the isolated endpoint copy with `-Task Check -CleanDatabase grimoire_startup_google_v1_test`. The isolated harness launcher ran `go vet ./...`, `go test ./...` and the real API acceptance harness. Rust, frontend and concurrency command results are in the development tool transcript; the linked artifacts preserve database, Go, startup and browser output.
