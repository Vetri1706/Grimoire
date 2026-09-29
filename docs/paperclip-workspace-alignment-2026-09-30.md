# Paperclip workspace alignment

Grimoire now uses the layout scale measured from the running Paperclip UI at
`localhost:3100`: a 240px sidebar, 60px fixed header, 24px workspace inset,
13px navigation and 14px record titles. The existing bundled Inter Variable
font is the same binary as Paperclip's. The desktop content viewport fills the
available width and scrolls independently. A legacy `#main-content` width and
padding rule had overridden the workspace layout; its scoped override now
removes the excessive margins on wide displays.

The reference was inspected read-only on Tasks, Agents, Skills, Connectors,
Activity, the account menu and Settings at 1440 and 1920px. No Paperclip records
were changed. Grimoire retains its Midnight Blue/Pearl palette, strong foreground
text, quieter animated work backdrop and reduced-motion support.

## Working surfaces

- The account menu provides Settings, View profile, Edit profile, a built-in
  guide, appearance switching and sign-out. It supports keyboard focus, Escape,
  outside dismissal and narrow viewports.
- Settings shows actual account and organization membership, browser-persisted
  appearance, authenticated API health and the server-reported worker state.
  Profile edits persist through a cookie-authenticated, CSRF-checked endpoint.
  Migration 0048 limits the operation to the caller's display name and their
  corresponding directory labels; it preserves credentials, roles, memberships,
  and immutable work records. The directory audit context comes from the checked
  session, and unchanged retries produce no duplicate directory audit effects.
- Organization creation is centered. Scion creation separates identity, optional
  brief and final review; unknown lists remain null while explicitly empty lists
  remain empty. Lost-response retries reuse the same idempotency key.
- Agent creation separates identity, actual supported runtime and instructions.
  Saving creates configuration only. It does not connect a provider, start a run,
  or grant execution/approval authority. Pending responses cannot redirect a
  user who has left the form.
- Agents have searchable status filters and compact rows. Skills have searchable
  cards with persisted revisions and real assignment counts. Connectors display
  actual internal sources and clearly unavailable external access.
- Full Scion revision editing and the physical scope/offer workflow remain.
  Digital Scions expose capability and evidence workflows without physical actions.

## Header follow-up

The workspace header now contains only the page title or record breadcrumb on
a solid theme surface, matching Paperclip's framing. It remains 60px tall on
desktop and mobile. Organization switching, creation and organization settings
are in the sidebar brand menu. Appearance and the judge demo are available in
the account menu; runtime health remains in Settings and the work surfaces.
Mobile breadcrumbs retain their final label and truncate long names safely.

The production build and all 10 frontend boundary tests pass. A focused real
Chrome pass covers 36 views across 1440, 1920 and 390px in both palettes, with
no horizontal overflow or JavaScript errors. Keyboard focus, Escape, outside
dismissal, real organization switching/isolation, creation cancellation,
appearance persistence, runtime status and the public demo link pass. A dirty
Scion switch cancellation preserves the draft and current organization; an
accepted switch uses the existing session flow. These checks use the isolated
test database, without modifying the primary workspace. See the focused
[header browser evidence](evidence/workspace-header-browser-20260930.json).

## Validation

Validation uses disposable `grimoire_test` on PostgreSQL 17, an actual Rust API,
the versioned object store and Chrome. Synthetic browser fixtures are separate
from the user's primary organization and records.

| Check | Result |
| --- | --- |
| Frontend TypeScript/Vite production build | Passed, 63 modules |
| Frontend session/demo/Google tests | 10 passed |
| Rust tests | 41 passed |
| Clean/upgrade schema startup attestation | 19 passed |
| Profile database guards and live HTTP tests | Passed: own identity only, unchanged authority, correct audit, no-op retries, revoked/expired/disabled denial, browser CSRF and bearer rejection |
| Go acceptance harness | 152 passed against real Rust, PostgreSQL and object storage, including actual process restart |
| New browser flows | 8 passed: creation, Back, dirty navigation, lost-response retry, null/empty semantics, disconnected runtime, searches, profile persistence and organization switching |
| Judge entry regression | 9 passed, including isolation, current/stale/revoked cases and offline clearing |
| Onboarding regression | 6 passed using a newly created ordinary synthetic account |
| Late profile response after organization switch | Passed; the old response cannot replace the new session state |
| Desktop/mobile geometry and appearance | 109 views across 1440, 1920 and 390px in both palettes; no document/main horizontal overflow or JavaScript errors |
| Creation appearance | 26 additional Scion/agent wizard and final-width captures across desktop/mobile and both palettes; no horizontal overflow or JavaScript errors |
| Account menu and theme controls | Keyboard Enter, Escape/focus return, outside dismissal and links passed; all theme controls share persistence and System follows device changes |
| Mobile final action | Actual Tab navigation reaches Create agent in both palettes with a contrasting inset outline fully visible at the viewport edge |
| Primary post-upgrade browser smoke | 7 read-only login/signup/demo views passed with no API writes or JavaScript errors |

The Go harness verifies source revocation and stale plans, idempotent watch
effects, foreign-organization exclusion, persisted watches without a browser
timer, native agent revisions and restart recovery. Agent completion remains
a result to review and grants no approval.

Design specification lint reports zero errors and ten existing documentation
palette-reference warnings. The static UI audit has zero unresolved ownership
findings; its 39 convention findings concern retained native form validation
and vertically resizable textareas. These conventions are documented in
`ui-style.md`; browser and server validation remain enabled.

Working reference captures and synthetic verification artifacts are under
`.local/paperclip-alignment-20260929/`. Session/cookie fixtures and database
backups remain ignored and are not publication artifacts.

## Local installation

The primary `grimoire_dev` installation was backed up, migrated additively to
0048, and restarted with the validated API. Health checks report `ok`; the
existing Google client remains enabled. The first launch rejected an empty
cookie-security environment value; the local HTTP launcher now supplies the
explicit `false` default and the successful retry is recorded in
[primary upgrade evidence](evidence/profile-primary-upgrade-20260930.json).
The database dump and previous binary are retained under the ignored
`.local/profile-upgrade-20260929T183807935Z/` directory.

Temporary test services on 5182/8082/55434/19002 were stopped after verification;
their data is retained. The primary app, API, database, object store and Paperclip
remain running.

Published verification records:

- [Browser checks](evidence/workspace-alignment-browser-20260930.json)
- [Startup checks](evidence/profile-startup-checks-20260930.json)
- [Go acceptance harness](evidence/profile-go-harness-20260930.txt)
- [Pearl workspace](evidence/workspace-scions-pearl-20260930.png)
- [Midnight workspace](evidence/workspace-scions-midnight-20260930.png)
- [Account menu](evidence/workspace-account-menu-20260930.png)
