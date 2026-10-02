---
version: alpha
name: Grimoire Midnight Blue and Pearl
description: A blue-lit account entry and a quiet, legible workspace for evidence-bound Scion proposals.
colors:
  primary: "#1d2f4f"
  midnightBackground: "#10151f"
  midnightForeground: "#f8fafc"
  midnightCard: "#151d2b"
  midnightPrimary: "#d8e5fa"
  midnightFocus: "#91b8f8"
  pearlBackground: "#f7f8fb"
  pearlForeground: "#111827"
  pearlCard: "#ffffff"
  pearlPrimary: "#1d2f4f"
  pearlFocus: "#335ea8"
typography:
  sans:
    fontFamily: "InterVariable, Inter, system-ui, sans-serif"
    fontSize: "1rem"
    lineHeight: "1.5"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
rounded:
  DEFAULT: "8px"
  control: "6.4px"
spacing:
  workPageInline: "28px"
  cardInset: "20px"
  accountCardInset: "24px"
components:
  button:
    rounded: "6.4px"
  card:
    rounded: "8px"
---

# Grimoire visual system

## Overview

The user-supplied Midnight Blue and Pearl account-screen references are the
approved visual direction. Grimoire helps people inspect Scion requirements,
evidence, agent proposals and the human decisions still required. Its UI must
keep stale, blocked, revoked and disconnected states legible.

The user's follow-up audit in `../paperclip/see.md` refines this direction:
clear near-black/near-white lettering, Paperclip typography and control density,
layered surfaces, backdrop transitions, and compact login/signup. Account entry
uses a stronger blue atmosphere; work screens use a solid canvas with
quiet blue borders and selections. The account backdrop moves independently of text. It
never indicates task activity or changes the meaning of a recorded status.

The current UI is English, used on desktop with responsive mobile access. No
new locale or market-specific workflow is implied by this visual change.

**Runtime ownership:** `web/src/styles.css` is the hand-authored source of truth
for semantic colors, fonts, type scale, radii, shadows and focus. This document
mirrors accepted values and intent; it does not generate CSS. Component styles
consume these variables and own geometry only. `workbench.css` defines work
density without overriding global color or type tokens. `theme.tsx` owns the
shared appearance selector and preference. `index.html` resolves the existing
stored preference before first paint; its two browser-chrome fallback colors
match `--background`, and React reads that token for subsequent updates.

## Colors

Midnight Blue uses an ink base, navy cards, pale cool text and an icy primary
button. Pearl uses a cool near-white base, white cards and navy actions.
`--surface-raised` and `--surface-inset` separate controls and nested records.
`--muted-foreground` deliberately aliases `--foreground`: hierarchy comes from
size, weight and spacing instead of washed-out gray text. `--border` draws quiet
structure; `--input` is stronger so fields and outlined
buttons remain recognizable. `--ring` provides a 2px visible keyboard outline.

`--info`, `--info-surface` and `--info-border` own blue selections and neutral
guidance. Amber is caution or stale state, green is a recorded positive state,
and rose/red is an error or revocation. Labels and icons still carry meaning;
color does not establish approval or provider availability. Graph edges and
selected nodes use the same semantic colors as lists and forms.

The fixed, noninteractive `#root::before` layer uses `--auth-aura` only on
account pages. A brief, finite opacity/transform entrance introduces the blue
atmosphere; work screens use a solid `--card` canvas without a gradient.
Reduced motion removes that entrance. `--glass-surface`, `--panel-background`,
`--panel-rim` and `--panel-shadow` provide shared depth; panel surfaces remain
88% opaque in Pearl and 92% in Midnight. Graph content uses a solid inset canvas.

## Typography

Bundled Inter Variable is the exact same font binary used by the local Paperclip
checkout and serves every screen without external font requests. Use weights
400, 500 and 600 for ordinary content, controls and headings. Use the OS
monospace stack for technical identifiers. Timestamps and natural-language labels use
Inter. Global type tokens are 12px code, 14px small/metadata, 16px body, 18px section,
22px heading, 28px page and 44px account hero at the default 16px root size.
Graph titles and explanatory copy use 14px; graph metadata never drops below
12px. Other explicit UI type sizes below 12px have been raised to that minimum.
Do not set independent root type scales in component stylesheets.

Body line-height is 1.5; explanatory paragraphs are 1.6–1.7. Existing heading
weights and restrained negative tracking remain. Exact values, provenance and
long names must wrap or remain inspectable, rather than disappear for neatness.

## Layout

Login retains its compact two-column layout. Workspace framing follows the live
Paperclip reference at the visible scale in the user's supplied screenshots:
a 270px navigation rail, 68px header, 28px content inset and full-width record
lists. The reference screenshots are approximately 1.125 times the local
Paperclip defaults (240px rail / 60px header); use explicit layout and type
tokens instead of browser zoom. The header and navigation
stay fixed while the main workspace scrolls independently. Navigation labels
use 16px/400 text; record titles use 16px. Narrow screens use labeled navigation
and a drawer, with keyboard focus contained while the drawer is open.
The solid header contains only the page title or record breadcrumb, including
on mobile. Organization switching and creation live in the sidebar brand menu.
The account menu links to appearance, Settings and the judge demo; runtime
health remains available in Settings and Watchtower. Settings and profile routes
replace the work shell with their own 270px navigation rail, 68px header and
Back to workspace action. Dashboard contains work, attention and Scions rather
than runtime configuration or health panels.
Long graphs scroll inside their labeled viewport without widening the page.

Organization, Scion and agent creation use a centered 540px form with a prominent
question heading, short steps, Back/Continue navigation and a final save action.
Optional details stay available without dominating the first step. Editing a
saved Scion retains the complete revision form, including physical workflows.
Creating an agent saves configuration; it never claims provider authentication
or starts execution. Skills use responsive cards; agent lists have real-state
filters and search.

Login/signup use a 400px card with 24px padding and 40px controls. Secondary
permission explanations sit in a disclosure; demo and installation links sit
outside the form. Both forms fit a 1366x768 desktop viewport with Google entry
visible. Mobile controls retain a 44px target and 16px input text.

Keep status meaning and permission gates across form flows and routes.
Appearance changes are local preferences and never trigger account, evidence
or task mutations. Native select menus remain platform-owned, with shared
styling for the closed control and standard keyboard behavior.

## Elevation & Depth

Thin blue-gray borders, inset rim light and tonal surfaces establish hierarchy.
Shared `--shadow-sm` is for controls; `--panel-shadow` gives cards quiet depth.
Headers and selected panels use 12px backdrop blur over the decorative layer.
Record text stays fully opaque. Never use transparency to indicate hidden or
revoked content.

## Shapes

Cards use 8px radii and controls 6.4px. Status pills retain their existing rounded
shape. Existing stroke icons remain; letter avatars use the shared typeface.

## Components

- Buttons share primary, secondary and text treatments. Primary buttons have a
  restrained sheen and clear hover/pressed state. Disabled controls retain
  readable lettering on a muted surface and remain natively disabled.
- Forms share surface, border, placeholder and focus variables. Password masking,
  validation, autocomplete and submission behavior are unchanged.
- Active navigation has a blue tinted surface; tabs use an underline and explicit selected state.
- The bottom account menu opens Settings, profile viewing/editing, the built-in
  guide, appearance switching and sign-out. Settings covers real identity,
  organization membership, browser appearance and server-reported runtime health.
  Profile updates change only the authenticated Handler's display label.
- Focus uses an outline, so component shadows cannot erase keyboard visibility.
- The agent navigation scroll strip reveals the full focused control, including
  its outline, when moving through the mobile navigation with the keyboard.
- Appearance offers **Midnight Blue**, **Pearl**, and **System** on account,
  workspace and public-demo screens. Values remain `dark`, `light`, `system`
  under the existing `grimoire.theme-preference` key. Reload, OS changes and
  cross-tab changes use the same owner; unavailable storage does not block use.
- Paperclip motion primitives inform the shared 160ms hover, 240ms surface and
  360ms entry timings, with standard and exponential easing. The 24s decorative
  backdrop drift is independent of monitoring or agent state. Reduced motion
  removes all transitions and animations.
- Graph lane headings stay pinned during vertical scrolling. Inspector values
  use nested key/value lists; provenance and technical references are collapsed.
  Public actions use an informative read-only badge instead of a disabled CTA.

## Do's and Don'ts

Use the supplied account references as the visual anchor. Keep dense records
readable in both modes. Reuse semantic tokens across all routes. Preserve the
physical workflow, source-redaction behavior, public-demo boundary and human
review requirements. Do not invent agent connections, activity, approvals or
provider checks to populate themed screens.

Initial theme verification is recorded in `docs/theme-verification-2026-09-29.md`.
The follow-up is recorded in `docs/paperclip-ui-refinement-2026-09-29.md`.
