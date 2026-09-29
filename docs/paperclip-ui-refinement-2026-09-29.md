# Paperclip reference refinement

This follow-up implements the user's saved `../paperclip/see.md` audit and
screenshots: clearer lettering, Paperclip typography, layered backdrops and
transitions, and shorter login/signup forms. It supersedes the initial theme's
muted text and flat work panels. [DESIGN.md](../DESIGN.md) records the current
shared system.

## Changes

- The bundled Inter Variable font is byte-for-byte identical to Paperclip's.
  Both files have SHA-256
  `693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3`.
  The reference uses 14px medium-weight buttons, 40px standard button height,
  and regular/medium/semibold type. Grimoire now uses those same conventions.
- Ordinary and secondary text use the same strong foreground: `#111827` in
  Pearl and `#f8fafc` in Midnight. Metadata is at least 12px; graph and inspector
  body copy is 14px. Disabled controls remain disabled with readable text.
- A noninteractive, fixed blue gradient backdrop moves slowly behind the UI.
  Shared panels use a subtle gradient, inset rim light and shadow; headers and
  the account panel use backdrop blur. Hover, selection and entry feedback use
  shared timing/easing tokens from the Paperclip source. Reduced motion stops
  all decorative animation and transitions.
- Login/signup no longer repeat a heading, account label and multiple explanatory
  blocks. Permission details are expandable; demo/setup links sit outside the
  form. The Google flow, fields, validation and submission logic are retained.
- The demo opens with a short plain-language introduction and an expandable
  explanation that still identifies the records as synthetic and read-only.
  It does not imply that selecting a case changes the database.
- Graph nodes have larger text and matching geometry. Lane headings remain
  sticky while the graph scrolls. Inspector records use nested key/value lists;
  technical references and provenance are expandable. Public actions appear as
  an informative read-only badge, without an approval simulation.

## Verification

| Check | Result |
| --- | --- |
| Frontend `npm.cmd test` | 10 passed |
| Frontend `npm.cmd run build` | TypeScript and Vite passed; 57 modules |
| Primary login/signup at 1366x768 and 1760x900 | Both forms and footer fit without vertical page scrolling |
| Stable account card height | Login 429px, signup 503px; previous stable cards approximately 768px and 863px |
| Representative real Chrome sweep | 28 desktop/mobile views; no JavaScript errors or horizontal document overflow |
| Real signup and judge-entry regression | 9 checks passed: account flows, organization isolation, current/stale/revoked states, public read-only boundary, offline clearing/reconnect and mobile fit |
| Final focused controls | 5 checks passed: invalid signup blocked without a request, permission disclosure intact, sticky graph labels, both-theme redaction and offline clearing/reconnect |
| Typography and contrast | Same Inter font; ordinary text at least 16.15:1 and input border at least 3.16:1 against tested surfaces |
| Motion | Gradient position advances; 160ms theme/control transitions observed; reduced-motion context reports zero animations |
| Design specification lint | Zero errors; 10 warnings for documentation palette mirrors not referenced by its component map |

Verification used the primary installation read-only for account presentation,
plus an isolated Rust API and PostgreSQL database for workspace and form flows.
No real provider authentication, agent execution or primary account mutation was
performed. Backend code and schemas are unchanged by this refinement.
Temporary test services were stopped after verification; their data was retained.
The primary API is healthy and the app remains available at `localhost:5180`.

The static UI audit still reports the same 30 existing form conventions: 14
forms without `noValidate` and 16 resizable textareas. Native validation and
vertical resizing were preserved. This is focused UI verification, not a claim
that a full accessibility or product audit has passed.

## Evidence

- [Before measurements](evidence/refinement-before-20260929.json)
- [Browser checks](evidence/refinement-browser-20260929.json)
- [Contrast measurements](evidence/refinement-contrast-20260929.json)
- [Account and judge-demo regression](evidence/refinement-judge-regression-20260929.json)
- [Final control checks](evidence/refinement-controls-20260929.json)
- [Midnight login](evidence/refinement-login-midnight-20260929.png)
- [Pearl signup](evidence/refinement-signup-pearl-20260929.png)
- [Midnight case graph](evidence/refinement-demo-midnight-20260929.png)
- [Pearl case graph](evidence/refinement-demo-pearl-20260929.png)
- [Pearl agent workspace](evidence/refinement-agent-pearl-20260929.png)
- [Mobile signup](evidence/refinement-signup-mobile-20260929.png)
