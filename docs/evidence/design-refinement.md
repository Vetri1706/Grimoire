# Design refinement, 2 October 2026

The user authorized applying three design skills to the existing Paperclip-inspired
Grimoire interface. The existing `DESIGN.md`, Midnight Blue/Pearl palette, bundled
Inter, legible secondary text and native task authority remain the product contract.

## References used

Project-local, ignored copies were installed with the Codex skill installer:

- [UI/UX Pro Max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill), commit
  `09170eec67eefd46a7ae85de61b40c194020f997`: `.claude/skills/ui-ux-pro-max`.
- [Taste Skill](https://github.com/leonxlnx/taste-skill), commit
  `ce26fc25c0e5e8cab638f883de62d9a86ee5e45b`: `skills/taste-skill`.
- [Design Motion Principles](https://github.com/kylezantos/design-motion-principles),
  commit `4a9ca879f24a361f4dca4174fe2da0f67b5ddee3`:
  `skills/design-motion-principles`.

UI/UX Pro Max was queried for task-management dashboard design, keyboard focus
and React form state. Its compact, high-contrast direction fits; its generated
teal/orange palette, Jakarta type and marketing-video layout do not fit the
approved product and were not applied. Taste explicitly targets marketing rather
than data tables or multistep product UI: its brand-preservation, concise copy,
theme consistency and redesign audit guidance applies here. It does not justify
replacing real records with decorative examples or changing the user's font.

Motion uses the skill's Emil-first, Jakub-second productivity guidance: immediate
frequent work updates, brief occasional transitions, no looping attention cues,
and reduced-motion support. Existing interactions and server authorization remain
authoritative. No animation library or runtime dependency was added.

Agent droplets are original inline vector artwork inspired by the user's supplied
character direction. Their stable color indicates identity only; they do not claim
the agent is connected, working, approved or capable of unsupported adapters.

## Implemented

- One decorative droplet identity component and one semantic status glyph component.
- Compact task rows, next-action ordering, search, status/group/sort controls, and
  organization-scoped view preferences. No task content or search query is persisted
  by those controls.
- Focused task detail with the current action, Handler questions, result and evidence;
  supporting activity and technical provenance use disclosures.
- Name, Adapter, Instructions agent wizard with optional fields disclosed gradually,
  preserved drafts, Codex-only configuration and real worker health.
- Actual latest agent assignments and recent dashboard task cards. A recorded running
  state is qualified when the worker is disconnected; no model execution is inferred.
- Labeled mobile navigation and a modal navigation drawer with focus containment,
  Escape, focus restoration, inert background, safe-area spacing and reduced motion.
- Persisted watch check timestamps, readable labels, shared blue themes, and a finite
  account-background entrance instead of an infinite repainting backdrop.

## Follow-up: reference scale and separate settings

The user requested a closer match to the visible Paperclip screenshots. A fresh
GET-only Chrome comparison at 1920×1000 found the local Paperclip defaults at
240px sidebar / 60px header / 14px agent name, while the supplied screenshots
show approximately 1.125 times those dimensions. Grimoire now uses explicit
270px sidebar / 68px header / 16px working text / 14px supporting text, with
12px reserved for technical identifiers. It does not use CSS or browser zoom.

Work pages have a solid canvas; the blue account-entry atmosphere and the
Midnight Blue/Pearl palettes remain. Tasks and Agents begin with their toolbars
rather than duplicate page titles. Skill descriptions use compact three-line
previews, with full descriptions available in their detail views. Dashboard
focuses on recorded work, attention and Scions; runtime health remains in Settings
and Watchtower.

Settings and profile routes render an independent shell. Global work navigation
is unmounted, and Back to workspace restores the preceding work route. Existing
profile saves, authentication, organization switching and unsaved-change guards
remain in use. Its content reset explicitly overrides the shared `#main-content`
styles to prevent doubled padding.

Final follow-up validation:

- Production TypeScript/Vite build passed (the existing >500kB bundle warning remains).
- Frontend tests: 18 passed.
- Real Chrome design regression: 8 grouped checks passed, including computed
  desktop scale, separate settings navigation, cancelled navigation retaining a
  profile draft, saving that draft through the API, returning to the previous
  page, both themes, mobile focus handling and organization isolation.
- Responsive checks include 375, 768, 960, 1024, 1440 and 1920px widths. The task
  layout stacks below 1000px to avoid its former 951–973px grid overflow.
- `git diff --check` passed. No backend/service restart or model invocation.

Final local screenshots and results:
`.local/design-refinement/1790908118514/`. Reference measurements:
`.local/paperclip-audit/scale-comparison/`. These are disposable synthetic test
records on port 5182, not changes to the user's organization.

## Earlier verification in this increment

| Check | Result |
| --- | --- |
| `npm.cmd run build` in `web` | Passed TypeScript and Vite production build |
| `npm.cmd test` in `web` | 18 passed |
| `node web/tests/design-refinement.mjs` | 6 grouped checks passed in real Chrome |
| `node web/tests/planning-skills.mjs` | 6 checks passed against real Rust/PostgreSQL |
| `node web/tests/task-recovery.mjs` | First 5 passed; source test passed on focused rerun after restoring its stopped test object store |
| Primary site, port 5180 | Login and published synthetic demo opened in Chrome; no uncaught errors |
| `git diff --check` | Passed |

The new design browser test verifies loaded dashboard cards, compact signup,
agent draft retention, task view persistence, distinct organization views, 375/768/
1024/1440px layout checks, both palettes, drawer keyboard focus and reduced motion.
The existing skill journey verifies install-response retry, immutable assigned skill
revisions, authoring, mobile access and foreign-organization rejection. Recovery
checks exercise rejected assignments, lost create/dispatch responses, failed answers,
competing revisions, and hiding revoked evidence while a task remains open.

These runs used the existing `grimoire_codex_flow_test` database via port 5182.
They created synthetic test records and invoked no model. The source test initially
returned `SOURCE_STORAGE_UNAVAILABLE`: the isolated object store on port 19002 was
stopped. Its existing startup script restored it; both API processes and the primary
object store were left running unchanged. The focused revocation rerun then passed.

Local screenshots and JSON results:

- `.local/design-refinement/1790906985577/`
- `.local/planning-skills/1790906779899/`
- `.local/task-recovery/1790906848250/` (five passes plus interrupted source setup)
- `.local/task-recovery/1790907088190/` (source revocation pass)
- `.local/design-refinement/initial.json` (primary site console check)

No backend, migration, provider policy or approval-authority code was changed in this
design increment. Earlier Go/Rust acceptance results remain documented in
`task-first-workspace.md`; this increment did not rerun those suites or the paid/live
Codex journey. Vite still reports the existing large-chunk advisory (604 kB JS before
gzip); production build succeeds. This work is local and has not been deployed.

## Follow-up: per-task inspector and distinct agent characters

Every focused native task now has a shared right-hand inspector with Properties,
Artifacts and Tasks tabs. Capability planning retains its current question/result
workflow. Physical-scope and offer-normalization tasks use a focused detail view
with their existing dispatch, cancellation, event and canonical proposal screens.
All three task kinds select Tasks in navigation. A compact toolbar replaces the
repeated Scion headings in focused task views.

Properties show recorded status, assigned agent, revisions, runtime, dependencies
and timestamps. Artifacts open the actual result, subject to its current access
checks. Related tasks navigate to exact records in the same Scion. Native records
do not yet provide parent/subtask/delegated-run fields, so Ancestors and Subtasks
show that no relationship is recorded. Reporting lines are never presented as
execution relationships. No chat API, upload, provider or hierarchy is simulated.

The inspector supports arrow/Home/End keyboard navigation, close/reopen focus
restoration and a compact 320px maximum height on narrow screens. Handler answer
drafts remain intact across inspector actions. Review drafts and their retry keys
belong to individual task/result revisions, survive task navigation and browser
Back, and are discarded when the corresponding result becomes stale, blocked or
unavailable. The inspector does not fetch or cache source content independently.

Saved agent IDs now deterministically select from 24 palettes, eight original
blob silhouettes, facial variants and visible markings. The same ID retains its
character through a rename and across directory, task, profile and dashboard
views. Traits identify the agent; task/connection status uses separate semantic
indicators. Placeholder characters are used only for unsaved or unassigned work.

Validation for this follow-up:

- Frontend unit tests: 22 passed, including stable identities and 250 distinct
  same-name agent fixtures.
- Real Chrome design regression: 10 groups passed, including all three inspector
  tabs, keyboard/focus behavior, actual peer navigation, avatar consistency,
  Handler drafts, both themes and responsive layouts.
- Physical/offer real-stack regression: seven groups passed, including canonical
  artifacts, absent and foreign IDs without fallback, source revocation, stale
  cancellation and clearing displayed details when the connection is lost.
- Task recovery: six checks passed, covering rejected assignment, lost create/dispatch responses, interrupted
  answer saves, competing revisions and open-task source revocation exercised on
  the disposable Rust/PostgreSQL/source-store stack. The revocation case also
  checks review-draft retention across tasks and browser Back, then removal on
  revocation and disabling the affected artifact link.
- Production build passes. Vite's existing large-chunk advisory remains (about
  627 kB of JavaScript before gzip). No new runtime dependency was added.

Local browser evidence:

- `.local/design-refinement/1790909141273/`
- `.local/task-run-inspector/1790909275049/`
- `.local/task-recovery/1790909252450/` (focused review-draft/revocation check)
- `.local/task-recovery/1790909371823/` (final full recovery suite, six passes)
- `.local/avatar-identity/` (32 actual component identities in Pearl, Midnight
  and forced-color rendering)

Browser writes were restricted to `grimoire_codex_flow_test` through port 5182.
Physical/offer fixtures used test-only native role bootstrap and temporary
credentials revoked on completion. Their accepted outputs are explicitly
synthetic protocol fixtures, not model execution. Primary API processes and the
user's organization were not changed or restarted; this remains local work.
