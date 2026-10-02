# UI appearance

The current global theme is **Midnight Blue / Pearl**, based on the user's supplied
account-screen references. [DESIGN.md](../DESIGN.md) owns the accepted visual
intent and documents the canonical runtime tokens in `web/src/styles.css`.
The follow-up in `../paperclip/see.md` adds clear foreground lettering, minimum
12px metadata, shared layered surfaces, backdrop transitions, and compact account
forms. The exact Paperclip Inter font binary is bundled locally. Account entry
retains the stronger blue fade; work screens use legible, nearly opaque surfaces.
`web/src/theme.tsx` shares appearance controls across account, workspace and demo.

The workspace alignment follow-up uses live Paperclip measurements: 240px rail,
60px fixed header, 24px content inset, 13px navigation and 14px record titles.
Lists use the available width. Creation uses focused steps in a centered 540px
frame; full Scion revision editing remains available. Native Settings and the
account menu expose profile, organizations, appearance, runtime health and a
built-in guide. Display-name changes use authenticated self-service session
authority; source visibility, task authority and review gates stay unchanged.

The sections below retain historical design and verification notes. Older neutral
palette and typography values are superseded by DESIGN.md. Paperclip remains a
historical layout/font reference and is not a runtime or UI package dependency.

## Current canonical UI owners

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
| --- | --- | --- | --- | --- |
| Select/Listbox | Native select, shared ThemePicker for appearance | DESIGN.md and styles.css | Theme and existing data selectors; OS-owned popup | Keyboard and narrow-screen browser checks |
| Form | Existing domain forms, shared field/button CSS | Existing API contracts; appearance from DESIGN.md | Account, Scion, source, agent, skill | Existing form and session browser checks |
| Scrollbar | styles.css global rule | DESIGN.md | Graph viewport keeps horizontal scrolling | Computed style and responsive checks |
| CRUD | Existing React routes and Rust API | Onboarding, native-agent and Scion contracts | Existing create/edit/read behavior | Existing browser and API verification |

Native browser field validation and server validation remain in force. Textareas
remain vertically resizable. These are deliberate existing domain conventions,
including in the short creation flows. Future behavior changes
must be reviewed under their owning domain contract rather than inferred from a
theme choice.

## Reference files

All paths below are relative to the read-only `../paperclip` clone:

- `ui/src/index.css`: Inter font stack, neutral light/dark colors, radii, text
  scale, and the actual `.primary-sidebar-surface` background.
- `ui/public/fonts/InterVariable.woff2`, `InterVariable-Italic.woff2`, and
  `NOTICE.md`: unchanged Inter v4.1 font assets, copied into `web/public/fonts`.
  The full upstream SIL Open Font License is included alongside them.
- `ui/src/components/ui/button.tsx`, `input.tsx`, `card.tsx`, and `badge.tsx`:
  control sizing, border treatments, card padding, and badge shapes.
- `ui/src/components/SidebarNavItem.tsx` and `primary-sidebar-styles.ts`:
  compact navigation, icon sizing, and selected/hover treatment.
- `ui/src/components/BreadcrumbBar.tsx`: header sizing and typography.
- `ui/index.html` and `ui/src/context/ThemeContext.tsx`: reference theme
  initialization and preference handling. Grimoire resolves its own System,
  Light or Dark preference and retains its own palette and stored setting.
- `DESIGN.md`: semantic tokens, compact operational hierarchy, and restrained
  decoration.

Grimoire defaults to **System**, following the browser/operating system's
`prefers-color-scheme` preference, including changes while the page is open.
The Appearance selector in the workspace topbar and connection header offers
System, Light and Dark. Explicit choices are saved per browser under
`grimoire.theme-preference`, restored before the first paint, and synchronized
between tabs. System does not persist a resolved light/dark value. Storage being
unavailable still allows system appearance and changes for the current visit.

The old `grimoire.theme` key is ignored because the previous implementation wrote
it automatically on every visit, so it cannot distinguish a chosen preference
from its forced dark default. Existing users start in System and can choose an
override again. Grimoire does not read Paperclip's separate stored preference.

Inter is served locally; there are no external font requests. Missing information
remains amber and errors remain red. Cards have neutral borders, with 8px corner
radii.

## Desktop readability

Grimoire keeps Paperclip's font and neutral palette, with a larger type scale for
reading case records on a desktop. The shared rem tokens resolve at the default
browser size to 18px for body text, form labels, and buttons; 16px for navigation
and metadata; and at least 14px for small annotations. Section headings use 24px,
larger headings 28px, page titles 32px, and the connection hero 44px.

The sidebar is 280px wide, and the breadcrumb bar is at least 72px high. Inputs
and buttons are at least 48px high; control text uses a 1.5 line height. Source
metadata labels have a 170px column, form pairs can shrink within their tracks,
and section headings can wrap without squeezing provenance labels or badges.
These adjustments give the larger text room throughout intake, history, and
sources and claims.

Desktop readability is the priority for this iteration. Existing narrow-screen
reflow remains, but responsive rules no longer shrink the type scale. No new
mobile design or mobile verification is claimed. Cancel and Save still share a
row, with Cancel on the left and Save on the right.

The TypeScript and Vite production build passed after this typography change.

### Desktop typography verification

- The running app was checked at a 1728 × 1080 desktop viewport: case record,
  current revision history, sources and claims, new-intake form, and Scion list.
  Screenshots showed the larger text without horizontal clipping.
- Computed styles confirmed 18px body and fact text, 32px page titles, 24px
  section headings, 16px metadata, and a 280px sidebar. Form labels and inputs
  were 18px, with the inspected input measuring 48.6px high.
- Document `scrollWidth` was 1718px within the 1728px viewport.
- No form was saved and no case data was changed during these checks.
- The temporary viewport was reset afterward, and the existing case was reopened.
  The Paperclip clone's Git status remained empty.
- The final TypeScript and Vite production build passed again after removing
  empty CSS rules. This iteration checked desktop only; mobile was not tested.

The appearance checks below describe earlier iterations.

## Prior appearance verification

- `npm.cmd run build --prefix web`: TypeScript and production build passed.
- Live browser: case record, list, new-intake form, and revision-1 snapshot opened
  successfully. The existing case stayed at revision 4; no data was saved during
  the appearance check.
- Computed styles confirmed Inter for body and headings, Paperclip's dark
  background `oklch(.205 0 0)`, and sidebar `oklch(.269 0 0)`.
- Desktop and narrow layouts checked; form and case/list had no horizontal
  overflow. The browser reported a 1200px desktop CSS viewport and 325px narrow
  CSS viewport under the host's zoom. The temporary override was reset.
- Both font-file SHA-256 hashes matched the source clone. The full license is
  included. `git -C ../paperclip status --short` remained empty.

These checks preceded the default-dark and saved-toggle change. The form and
narrow layout checks above were not repeated for the theme change.

## Default-dark and saved-toggle verification

- `npm.cmd run build --prefix web`: TypeScript and Vite production build passed.
- Reloading the running app in the in-app browser showed the default dark theme,
  with computed body background `oklch(0.205 0 0)` and InterVariable typography.
- Selecting **Switch to light theme** and reloading preserved `data-theme="light"`
  and the body background `oklch(1 0 0)`.
- Selecting **Switch to dark theme** and reloading preserved the dark toggle
  state; a screenshot confirmed the dark appearance. The app was left in dark
  mode.
- The existing Scion remained at revision 4. No record was saved during these
  checks.

External Chrome was not directly automated. Backend and database checks were not
rerun for this theme change. See [test commands](testing.md) for current checks.

## Source access and storage display

The Sources and claims view revalidates permission through an authenticated,
`no-store` Rust API request every two seconds while visible. A successful check
grants a display lease of at most five seconds, measured from request start;
read requests are aborted after two seconds. This lease controls the browser
view only. The API must still authorize every read and write.

Revocation, a missing source, access denial, a failed or timed-out permission
check, an offline event, or a hidden tab clears source text, claim statements,
locator quotes, and unsaved source/claim forms. Pending reads and form writes
are aborted. Request generations prevent late responses or an old form's save
callback from restoring cleared content. Visibility, focus, reconnect, and
back-forward cache restoration trigger fresh access checks; content is not
restored from browser storage. Previously viewed or copied content cannot be
retracted.

The storage panel says the private object version's hash was checked only when
the API supplies `storage_backend: "s3"`, an object key, an object version ID,
and `content_hash_verified: true`. Storage details expose the version ID, never
an object URL. Without that explicit response, storage integrity is shown as
unconfirmed. Hash integrity does not make a source, manual claim, or sourcing
decision verified or approved. Existing desktop typography remains in use.

The TypeScript and Vite production build passed for these frontend changes.

### Layer 2B live browser verification

The desktop browser used the running React interface, Rust HTTP API, PostgreSQL
17.11, and native private MinIO. The original accepted Scion reopened with its
144-byte source revision, unverified claim, and exact locator `[51, 82)` intact.
The UI displayed the private versioned-storage and API hash-check status while
keeping claim verification separate.

A separate synthetic probe displayed a 105-byte source, its Handler-entered
claim, and quotation at `[82, 104)`. Permission was then revoked through a
separate authenticated API request while the Sources and claims tab remained
visible and open. Without a browser click, reload, or navigation, the next DOM
inspection found the source marker, claim marker, and quote absent, with zero
`.source-text` nodes. The URL was unchanged; the screenshot showed audit metadata
and the revocation reason in place of content. The accepted demo was neither
edited nor revoked.

The first post-revocation observation was about 5.3 seconds after the API
receipt. This is an observation interval, not a measured detection-latency
guarantee; the implementation's two-second polling and five-second lease are
separate bounds. Hidden/offline clearing, suspended JavaScript timers,
back-forward cache restoration, and in-flight races were reviewed in code but
not separately simulated in this browser check. Mobile was not checked.

These observations describe that historical browser run, not a current test pass.

## Physical scope and local Codex CLI queue

The Physical scope case tab keeps the shared Inter font, dark default, 18px body
and form text, and 16px metadata. Exact proposed configuration, component,
occurrence and requirement values precede the optional agent queue. Each identity
shows its pinned source revision, Handler claim ID, SHA-256 and exact UTF-8 byte
locator. Governed revision IDs appear only when the API returns a separate
synthetic confirmation record; unsaved or unconfirmed values are labeled proposed.

The proposal form starts with blank physical values. It requires an explicit
synthetic attestation, identity assessment, structured specifications and
requirements, four evidence assignments, and recorded gaps or an explicit
no-gaps assertion. The Handler can inspect a permitted source claim and assign
its exact locator to each use; this does not assert that the claim supports every
assignment. The independent Engineering Reviewer must judge that support.

Review is a separate form with an explicit rationale and attestation. The API's
per-proposal confirmation capability and reviewer-conflict result control the
form. Work the current identity prepared or queued requires a different enrolled
synthetic Engineering Reviewer. Source-dependent proposals are revalidated with
bounded reads and a five-second display lease; redacted API inputs, lost access,
hidden tabs, and offline status clear the corresponding content and forms.

The optional Codex CLI action submits the same explicit candidate through the
Rust task queue using the current Scion revision and an idempotency key. The UI
reads actual queued, running, completed, or failed states and links a completed
task to its proposal. The queue API has no bridge-connection status endpoint, so
the UI explicitly says that connection is not reported. A queued task is not
shown as a connected Codex session; completion is labeled proposal preparation
requiring human review. No Codex credential or object URL is sent to the browser.

TypeScript and the Vite production build passed. These frontend checks do not
establish that an adapter job or human confirmation ran. No mobile checks were
added for this iteration.

## Synthetic offers, comparison and task control

The Physical scope tab now uses a neutral stacked-layers glyph rather than a
checkmark. A blocked physical binding is never represented by an approval icon.
The Offers and comparison tab uses neutral side-by-side rectangles. Both retain
the shared desktop type scale and the selected appearance.

Synthetic offer entry requires an explicit supplier identity, confirmed physical
scope, offer reference and exact quotation claim locator. Commercial inputs
start empty; unknown values become null and are shown as missing staging fields.
Revisions preserve the supplier identity and display immutable submission UUIDs,
the pinned physical chain and source hash/byte locator. The UI has no RFQ or
supplier-contact action and generates no quotation values.

Comparison entry selects two immutable offer revisions and an explicit common
quantity, UOM, currency, destination, incoterm, payment terms and validity basis.
The UI displays API-produced decimal strings verbatim; it performs no price
arithmetic, FX conversion, alternative total or winner selection. Each alternative
shows exclusions and its recorded unit/extended price or an explicit missing
value. Current binding blockers take precedence over an earlier comparable state
or retained normalization review. Human review remains a separate, role-gated
action with an independence check and explicit rationale.

Offer and comparison views use authenticated no-store polling with bounded reads
and a five-second display lease. API redaction clears derived fields and prices;
hidden/offline tabs and failed access checks clear unsaved forms. Historical
offer content also revalidates, and a newly redacted current offer immediately
suppresses cached history content. These controls do not erase previously copied
or downloaded bytes.

The task panel is shared by physical scope and offer normalization. New tasks
remain queued until a Handler dispatches them. Runtime limits are recorded per
task (30–300 seconds), and the API enforces organization concurrency of one
running task. A running cancellation is displayed as **Cancellation requested**
until worker acknowledgement; the slot remains occupied. A terminal cancelled
state is shown only when returned by the API. Timing, provider run ID, output
hash and content-free immutable events are inspectable. Bridge connectivity is
still explicitly unreported; only the Codex CLI adapter is represented and no
Paperclip connection is claimed.

TypeScript and Vite production build checks passed for this slice. This frontend
build does not establish live offer ingestion, comparison confirmation, dispatch
or cancellation; those paths require separate integration checks.

## System appearance verification

The production build passed after adding System, Light and Dark preferences.
Browser checks on the connection screen confirmed System initially resolved to
dark, both manual overrides survived reload, switching back to System restored
the system palette, and an already open second tab synchronized the preference.
The existing Inter font and 18px body text were preserved in computed styles.
Native form color-scheme and the theme-color metadata matched each palette.
An actual operating-system theme change during an open session was not exercised;
the media-query change listener was reviewed in code. No API or database changes
were needed for this appearance update.
