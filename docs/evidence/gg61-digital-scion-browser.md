# GG-61 digital Scion browser evidence

Date: 2026-09-28

Implementation under test: `2a65170833143ade4a8d0af15536dbf4b148d749`

Path exercised: `#/scions/5098c470-15d1-4842-bc59-f724c3d60ae5`

This check used a synthetic digital Scion in an ephemeral native PostgreSQL
17.11 database. The real Rust API ran on `127.0.0.1:8080`, host-native Vite
served the UI on `127.0.0.1:5173`, and `agent-browser` drove Chromium against
the Scion route. Native MinIO supplied the private local source-store
configuration required by the Rust runtime. Docker was not invoked; an existing
Docker-exposed database port was detected and deliberately avoided.

## Result: PASS

- Visible tabs were exactly `Case record`, `Revision history`, and `Sources and claims`.
- `Physical scope` tabs: 0.
- `Offers` / comparison tabs: 0.
- Physical workflow links, buttons, and panels: 0.
- Stale physical next-action copy: 0.
- The UI displayed: “Digital product · intake, history, and evidence only. Physical scope and offer workflows are unavailable for this Scion.”
- The next safe action stayed digital-specific and did not direct the user into exact-scope review or vendor comparison.
- `Revision history` and `Sources and claims` were clicked in sequence; each
  selected the corresponding tab panel while the same three-tab allowlist
  remained visible.
- The browser reported meaningful body content, no Vite/framework error overlay,
  and an empty search for links or buttons whose label or target contained
  `scope` or `offer`.
- The current web application has no graph, feed, or monitoring navigation
  surface. No unavailable runtime route is presented as implemented.

![Digital Scion browser check](./gg61-digital-scion-browser.png)

This is synthetic software-behavior evidence only. It is not customer evidence and makes no claim about usefulness, demand, or willingness to pay.
