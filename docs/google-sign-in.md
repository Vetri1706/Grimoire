# Sign in with Google

Grimoire uses Google Identity Services directly. Rust verifies Google's ID token and creates Grimoire's own HttpOnly session. PostgreSQL owns identities and organization memberships. Firebase and a client secret are not used.

## Google Cloud setup

1. Open [Google Auth Platform](https://console.cloud.google.com/auth/overview) and select or create the project that will own Grimoire's sign-in configuration.
2. Complete **Branding** with the application name `Grimoire`, support contact, and homepage/privacy information required for your deployment. Configure **Audience** for the intended users; add your test account if the console requests test users.
3. On **Clients**, create a **Web application** OAuth client.
4. Add these **Authorized JavaScript origins** for the current local frontend:

   ```text
   http://localhost
   http://localhost:5180
   http://127.0.0.1:5180
   ```

   Add the exact HTTPS origin when deployed. Origins include scheme and port, but no `/api`, `/demo` or other path. `localhost` and `127.0.0.1` are distinct origins; registering both frontend addresses covers either local URL.
5. Keep authentication limited to standard identity/profile information. No Drive, Gmail or other Google API access is requested. This JavaScript popup callback flow needs no authorized redirect URI.
6. Copy the **client ID**, ending in `.apps.googleusercontent.com`. It is public. Do not share a client secret.

Follow [Google's setup guide](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid) and the console's project-specific publication requirements.

### Error 400: origin_mismatch

Edit the existing **Web application** client under Google Auth Platform > Clients.
Match its public client ID to `/api/session/google/config`, then add the exact
address from the browser to **Authorized JavaScript origins** using the entries
above. Save and start a fresh sign-in attempt from `http://localhost:5180`.
Allow time for Google's configuration change to propagate if the old error
persists. This popup callback flow does not need a redirect URI or client secret;
changing Rust token validation does not fix an unregistered browser origin.

## Configure Grimoire

Back up the existing gitignored `.env`, then add your actual Web application client ID:

```dotenv
GRIMOIRE_GOOGLE_CLIENT_ID=YOUR_WEB_CLIENT_ID.apps.googleusercontent.com
```

This example is a placeholder. Restart the Rust API. `scripts/dev.ps1 -Task Api` reads the setting from `.env` unless explicitly set in the process environment. The API supplies the public client ID to React; no separate `VITE_*` setting is needed.

For HTTPS, set `GRIMOIRE_COOKIE_SECURE=true`. Keep the API behind a same-origin HTTPS reverse proxy with authentication rate limits. Configure CSP/COOP for Google popups as described in [Google's setup requirements](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid). The loopback API binding is unchanged.

Without a client ID, Google sign-in displays **not configured**, and its API issues no challenge or session. Password signup/login and `/demo` remain available. A malformed configured client ID fails startup.

## Identity and session boundaries

- Only verified Google `sub` identifies an account. Email, hosted domain, display name and caller-selected organization IDs never link accounts or grant membership. First sign-in creates a non-owner Handler with no organizations. Returning Google users resume only their own authorized memberships.
- Password accounts are not automatically linked to Google accounts. Google identities have no password hash and cannot use password login. Explicit account linking is not implemented.
- Rust verifies RS256 signatures against Google's fixed HTTPS JWKS endpoint, issuer, exact audience, optional authorized party, expiry/issued-at bounds and the browser nonce. Key caching handles rotation with bounded refreshes; expired keys and verification failures grant no access. [Google verification guidance](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)
- Each attempt has a five-minute HttpOnly cookie and random nonce. PostgreSQL stores their hashes and atomically consumes the challenge when establishing a session. Duplicate callbacks cannot create repeated sessions. A CSRF marker protects the JavaScript callback API; this is not Google's automatic form-post flow.
- The official GIS library loads only after the user starts Google sign-in on the account page. No One Tap, auto-select, persisted ID tokens, access tokens or refresh tokens are used. `/demo` does not load GIS.
- Google sign-in grants no installation ownership, sourcing, engineering, commercial, agent execution or approval authority.

## Verify the real provider

Open a fresh browser at the registered origin. Complete Google's account chooser and verify that first login opens empty organization onboarding. Create a synthetic organization, sign out and sign in again; only that user's organization should return. A separate Google account must not access it. The [judge entry](judge-access.md) stays accessible at `/demo` without Google login.

Automated checks use ephemeral RSA test keys, synthetic SQL identities and explicitly mocked GIS browser callbacks. Production has no alternate key endpoint or token bypass. These checks do not establish a successful real Google login: that requires the user-owned client ID, registered origin and interactive Google account step.

See the [2026-09-29 verification record](google-sign-in-verification-2026-09-29.md) for the completed automated checks and real Google provider-entry test.
