# Public demo and normal accounts

Grimoire supports normal Handler signup and sign-in. Signup creates a human identity with no existing organization memberships and no installation-owner authority. Creating an organization grants workspace administration; engineering, sourcing, commercial, agent execution and approval authority are separate. The one-time installation-owner setup remains a separate action.

## Public synthetic demo

Open **`/demo`** on the frontend host in a fresh browser. No login, Codex account, API key, or personal data is needed. The link is also available on the sign-in page.

The demo reads three seeded PostgreSQL cases through the real case projection:

1. **Current plan:** inspect the synthetic website Scion, internal evidence, proposal and comparison. A seeded protocol task is complete, but the Handler decision is missing and human review is required.
2. **After requirement change:** inspect the revision-1 proposal against revision 2. Watchtower records the stale state and required review.
3. **After source revocation:** the source content and dependent evidence are withheld, and dependent work is blocked.

These are distinct, persisted examples of the workflow, selected for inspection. The page does not pretend that selecting a scenario changes a requirement or revokes a source. Task outputs are explicitly synthetic protocol fixtures, not real Codex, BYOA or Paperclip executions. No external provider is checked. The server monitor persists successful checks; browser polling only refreshes the display. If the service is unavailable, the page clears the projection and reports the failure.

The public API accepts only fixed scenario slugs and returns data from the dedicated public synthetic organization. It does not grant a session or writable bearer credential. Private workspaces and ordinary account APIs still require authentication. `/demo` does not replace or clear an existing account session.

## Operator setup

Apply the migrations, rebuild the attested Rust API and start the object store/API as described in the repository's local setup. Then run from the repository root:

```powershell
node scripts/seed-judge-demo.mjs --api http://127.0.0.1:8080 --database grimoire_dev
```

The seed requires operator database credentials in the existing gitignored `.env` and a local `psql` executable. `--config` and `--psql` can select explicit paths. It uses a dedicated reserved organization, temporary credentials and ordinary API transitions. Temporary seed credentials are revoked in `finally`; they expire after 15 minutes if the process is interrupted. No raw seed tokens are written to disk. Completed seeds are preserved and repeat invocations do not create another set of cases. A partial publication fails closed for operator inspection. Before seeding, `/api/demo` reports `DEMO_NOT_CONFIGURED` instead of returning invented sample state.

The demo registry can be changed only by the database migration owner. Treat all data placed in the reserved synthetic organization as public. Never import personal source material into it.

## Public deployment

Use the deployed frontend URL followed by `/demo` as the public testing entry. For authenticated testing, use a dedicated account with synthetic data. **Never share a personal Codex login, provider key or production account.**

For an HTTPS deployment, explicitly set `GRIMOIRE_COOKIE_SECURE=true` in the API environment. The local API continues to bind to loopback; a deployment needs a same-origin HTTPS reverse proxy and appropriate access/rate controls. Complete installation-owner setup privately before exposing its entry. Verify the actual deployed URL from a fresh browser; local checks do not establish hosted behavior. See the [AWS operating guide](../deploy/aws/README.md) for the current deployment and its verification limits.

## Verification

Use a disposable local database and the seeded public demo to run:

```powershell
$env:GRIMOIRE_WEB_URL='http://127.0.0.1:5182'
$env:GRIMOIRE_TEST_DISPOSABLE='1'
node web/tests/judge-entry.mjs
```

The browser test creates synthetic normal accounts, verifies signup/login and organization isolation, opens `/demo` in a new Chrome context with no stored credentials, checks revision/revocation states, and verifies disconnection clears content. It never connects a personal provider account.
