# Midnight Blue / Pearl verification

The user-supplied account references now drive a shared theme across login,
signup, onboarding, the workspace, native agents, case graphs and the public
judge demo. Login keeps the blue fade; work screens use a shallow top tint and
opaque panels. The canonical palette, type, borders, buttons and keyboard focus
are in `web/src/styles.css`, documented by [DESIGN.md](../DESIGN.md).

`web/src/theme.tsx` owns the shared appearance preference. **Midnight Blue**,
**Pearl** and **System** use the existing storage key and values. The preference
is resolved before first paint, follows OS changes in System mode, persists
across reloads and synchronizes across tabs. The public demo has the same picker.

## Checks

| Check | Result |
| --- | --- |
| `npm.cmd test` in `web` | 10 tests passed |
| `npm.cmd run build` in `web` | TypeScript and Vite production build passed; 57 modules |
| Real Chrome, isolated API and PostgreSQL | 46 rendered screens in both palettes at 1760px and 390px: 184 view checks; no document overflow or page JavaScript errors |
| Appearance behavior | Reload persistence, OS preference changes, cross-tab synchronization and visible 2px keyboard focus passed |
| Mobile agent navigation | Forward Tab and reverse Shift+Tab keep the full focused control and outline visible in both palettes |
| Primary installation at `http://localhost:5180` | Login and persisted judge demo checked in both palettes; no API mutations or login cookies; configured Google entry visible without starting authentication |
| Contrast | Tested normal text token pairs at least 5.44:1, input borders at least 3.16:1, focus indicators at least 6.34:1 |
| `git diff --check` | Passed |
| `designmd lint DESIGN.md` | No errors; 10 warnings for mirrored palette values not referenced by the documentation component map |

The initial sandboxed frontend test launch failed with `spawn EPERM`. Running
the same command outside that process restriction passed. No application change
was made to bypass the restriction.

The browser sweep covered account steps, dashboard and navigation lists,
digital/physical Scion views, scope and offers, native agent configuration and
skills, and current/revised/revoked/disconnected demo states. Disposable signup,
organization, Scions, agent and skill records were created only in the isolated
`grimoire_test` database. No agent task, provider authentication or model call was
started by theme verification.

The raw report lists offscreen descendants in 54 views: Scion tabs, agent local
navigation and graph content inside intentional horizontal scroll containers.
These are distinct from document overflow, which stayed at zero. Keyboard
navigation and graph focus were checked separately.

That targeted check found Chrome leaving the final mobile agent-navigation
button partly clipped on keyboard focus. A small `onFocus` handler now adjusts
only the strip's horizontal scroll when a focused button falls outside its
bounds. The actual source was rechecked with forward and reverse keyboard
navigation in both palettes, without injected styles or event handlers. All
four agent-navigation checks passed, with full outline clearance. The final
production build also passed after this correction.

At the end of the Scion tab strip, the More selector's outer outline touches
the scroll boundary; its focus border and the full control remain visible.
The graph's focused human-review node stays fully inside its scroll viewport.

The isolated test services were stopped after verification and their data was
retained. The primary installation remains running.

The digital Scion still omits physical scope and supplier offers; those screens
remain present for the physical Scion. The demo still withholds stale details
and revoked evidence, and clears live nodes when disconnected. Existing human
review and worker-disconnection labels remain accurate.

## Limits and audit findings

This change is frontend appearance, shared preference behavior and focus
visibility in the mobile agent navigation. It does not
change Rust, Go, database migrations, authorization or task execution. Earlier
backend verification is recorded separately; backend suites were not rerun for
this theme change.

The premium static UI audit reported 30 existing form conventions: 14 forms
without `noValidate` and 16 textareas without `resize-none`. Native validation
and vertical textarea resizing were deliberately preserved. These findings are
not a passing full-product UX audit and are not introduced by the theme.

The automated text-contrast sampler checks solid/alpha backgrounds, not gradient
compositing. It flags the decorative login G mark for that reason; the actual
mark was visually inspected against its primary-button gradient. The demo had
207 sampled text nodes per palette with no low-contrast findings after theme
transitions settled. This is focused verification, not a complete accessibility
certification.

## Evidence

- [Browser view and behavior results](evidence/theme-browser-20260929.json)
- [Primary installation read-only check](evidence/theme-primary-20260929.json)
- [Contrast measurements](evidence/theme-contrast-20260929.json)
- [Settled secondary-button colors](evidence/theme-secondary-buttons-20260929.json)
- [Mobile keyboard focus checks](evidence/theme-mobile-focus-20260929.json)
- [Static audit findings](evidence/theme-static-audit-20260929.json)
- [Design specification lint](evidence/theme-design-lint-20260929.txt)
- [Midnight Blue login](evidence/theme-login-midnight-20260929.png)
- [Pearl login](evidence/theme-login-pearl-20260929.png)
- [Midnight Blue workspace](evidence/theme-workspace-midnight-20260929.png)
- [Pearl workspace](evidence/theme-workspace-pearl-20260929.png)
- [Pearl mobile judge demo](evidence/theme-demo-mobile-pearl-20260929.png)
- [Pearl mobile agent navigation](evidence/theme-agent-mobile-pearl-20260929.png)
