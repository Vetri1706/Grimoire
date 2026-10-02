# Product-planning skills and local connection UX

Verified on Windows, 1 October 2026. This extends the local worker v1 slice;
it does not change the Rust task scheduler, source permissions or approval gates.

## Delivered behavior

- Compact Codex connection card shared by Runtime settings and agent creation.
  `connect.mjs --watch` continues into the existing worker only after browser
  consent and private credential persistence. Terminal lifetime controls the
  worker; no new scheduler or background service is installed.
- Server-owned presence distinguishes never-started, online, offline and revoked
  computers. Offline records include their exact resume command; details and
  revoke controls are disclosed on demand. Browser refresh creates no heartbeat.
- Installed / Discover / My Skills supports preview, organization-local install,
  authoring and existing agent assignment. The three reviewed planning skills
  preserve source commit, digest, adaptation version and MIT attribution in the
  persisted instructions. No runtime external skill download is performed.
- Edits affect future assignments. Existing tasks retain the original skill text
  and revision, including the provenance received by the Codex prompt builder.

## Verification

| Check | Result |
| --- | --- |
| `node --test byoa/connection.test.mjs byoa/bridge.test.mjs` | 30 passed |
| `npm.cmd run build` in `web` | Passed; existing bundle-size advisory remains |
| `npm.cmd test` in `web` | 12 passed, including catalog parity/provenance checks |
| `node skills/product-planning/build-catalog.mjs --check` | Passed |
| Skill creator `quick_validate.py` for all three skills | Passed |
| PowerShell launcher parser and `git diff --check` | Passed |
| `web/tests/codex-worker-pairing.mjs` | 12 browser checks passed |
| `web/tests/planning-skills.mjs` | 6 browser checks passed |

The browser tests used installed Chrome against real Rust/PostgreSQL endpoints
on the disposable `grimoire_codex_flow_test` database. They checked approval,
automatic idle heartbeat after pairing, outage hiding, stop/restart, revocation,
organization isolation, an install response lost after commit, retry idempotency,
agent assignment, UTF-8 bounds and immutable skill snapshots. A protocol fixture
claimed a synthetic task solely to inspect its pinned payload, then recorded an
explicit test failure. No model ran; no proposal or approval was fabricated.

Desktop Pearl, Midnight Blue and 390px layouts were visually inspected. Browser
screenshots wait for theme transitions to complete. A static and contract review
of the skills included missing Handler decisions, revoked evidence, unavailable
external connectors and intake attempting to request browsing/approval. That
review is not a provider model quality evaluation.

Local reports (ignored by Git):

- `.local/codex-worker-pairing/1790877121474/results.json`
- `.local/planning-skills/1790877237938/results.json`

Primary `grimoire_dev` health and frontend availability were checked afterward.
Existing applied migrations 0049/0050 retain their original hashes. The tests
did not start or revoke the user's real worker, edit their organizations or
change their Codex login. No AWS deployment occurred.
