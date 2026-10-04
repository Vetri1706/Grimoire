# Grimoire local connector

Grimoire authorizes a local worker for one organization. The local Codex login supplies model access and stays in Codex's existing account store. The connector never asks you to paste provider credentials into Grimoire.

This package is **not published to npm**. The website distributes its own npm tarball and Windows ZIP. Use the complete command displayed in **Connect Codex**, not a guessed npm registry package name. No repository checkout is needed by users.

## Users with Node

Supported runtimes: Node.js 22.16 or later within 22.x, Node.js 24.x, or Node.js 26.3 or later within 26.x. The Windows installer still offers Node.js 24 LTS when a compatible runtime is missing. Copy the website's versioned `npx --package="https://YOUR-SITE/downloads/grimoire-connector.tgz?v=0.1.2" grimoire-connector --api "https://YOUR-SITE" --watch` command. The actual website fills in its own address and release version after checking that its download is available. The version query avoids reusing a cached older connector after an update.

The connector checks the installed native Codex CLI and local login, opens a pairing page, and waits for an authenticated Grimoire Handler to choose the organization and approve the displayed permissions. Compare the code and device before approving. Only the human pairing code is in the browser link; the possession secret remains in memory. A heartbeat, not the approval response, makes the website show Connected.

Keep the terminal open. This is not a background service. Ctrl+C stops the managed Codex process and worker. Repeating the startup command reuses saved enrollment; if several organizations are paired, select one explicitly. `--pair` requests a fresh enrollment. `--no-browser` prints the link without opening it. `--list` lists public connection IDs and organizations; `--connection UUID --watch` selects one. Use the same website command prefix or extracted launcher to invoke these options; npx does not install a globally available command.

## Windows without Node

Download and extract the whole Windows ZIP. Open **Connect Grimoire.cmd**, then paste the website origin shown in Connect Codex. The launcher finds a compatible system Node or offers a pinned official Node.js LTS download. Type `INSTALL` to consent. It verifies the archive and executable hashes and installs privately under `%LOCALAPPDATA%\Grimoire\Connector\runtime`; it never changes global PATH or the system Node version. The PowerShell execution-policy override applies only to that launcher process. An organization's device policy may prohibit scripts; no machine policy is changed to bypass it.

Node installation does **not** install or authenticate Codex. Follow [OpenAI's Codex CLI setup](https://developers.openai.com/codex/cli/), run `codex login` on your computer, and rerun the launcher. The bridge checks isolated-exec flags available in Codex CLI 0.157.1, including `--ignore-user-config` and `--ignore-rules`; incompatible versions fail before pairing or task claiming. A nonstandard installation can set `GRIMOIRE_CODEX_BIN` to an absolute native `codex.exe`/`codex` path. Never set it to a script received from a task.

## Optional SerpApi research

Connector 0.1.2 supports **SerpApi (Google search)** as an explicit public-research provider. Keep `SERPAPI_API_KEY` in a private local environment file, never in `VITE_*`, a browser, a prompt, source control or a task brief. It is needed only by the local connector, not the API server. From a checkout, start with:

```powershell
node --env-file=.local/serpapi.env byoa/cli.mjs --api http://127.0.0.1:5187 --watch
```

Replace the example origin with your Grimoire site. For the packaged connector, supply the same environment variable to its launcher. A connected worker advertises SerpApi capability only while its key is configured. This indicates configuration, not a verified balance or valid key.

Choose SerpApi in public research, select that computer and approve the provider-specific consent. Codex plans at most three queries and a one-to-eight-page retrieval budget from the public brief; the connector calls SerpApi directly, the API captures public source pages within that budget, and a second tool-free Codex pass synthesizes the captured excerpts. The planner is instructed to honor a lower page limit in the brief. Each query retains its SerpApi search ID and timestamp. There is no silent fallback to Codex web search, and provider failures do not produce a successful report. Searches use `no_cache=true`, consume SerpApi credits, and are not automatically retried. Codex usage is separate. Python and an MCP server are not required for this native Node integration.

The key is excluded from Codex's child-process environment. Public-search receipts still come from the trusted enrolled worker; they are not independent provider attestations. Reports remain unverified and require separate human review.

## State and authority

Credentials use current-user-only ACLs on Windows and mode 600/700 on Unix. State is independent of extracted folders and npm caches: `%LOCALAPPDATA%\Grimoire\Connector\state` on Windows and `$XDG_STATE_HOME/grimoire` (default `~/.local/state/grimoire`) elsewhere. `GRIMOIRE_CONNECTOR_HOME` may explicitly select an absolute private state directory. Existing checkout enrollments are not copied silently: to keep using them, explicitly set that variable to the checkout's `.local/byoa` directory or revoke the old connection and pair again. Never upload this directory.

Disconnect/revoke the computer in Grimoire Settings to invalidate the organization-scoped credential. Revoked credentials stop the worker; a saved file is not evidence of live access. Losing the one-time approval response requires revoking that unused connection and pairing anew: the server cannot retrieve the hashed credential.

The connector executes only native, explicitly dispatched tasks under the existing protocol and pinned revision bindings. It never executes server-provided shell commands. Codex runs in a temporary workspace with the bridge's existing tool restrictions, proposal-only authority and 30–300-second task limits. Public research requires its separate existing consent. Human review and approval remain separate.

On network/control loss, active generation stops. Reads and idempotent submissions retry boundedly; an ambiguous claim is never repeated. Running tasks cannot be claimed again and eventually expire server-side. A restart never automatically redispatches an interrupted task. Inspect it in Grimoire and explicitly dispatch new work if appropriate. A private durable outbox replays only the exact result receipt after a lost acknowledgement or process restart; it cannot regenerate output, claim work or create another proposal. Status metadata and pending receipts are stored privately; raw provider stderr, credentials and transcripts are not logged.

## Maintainers: local build and verification

From `web`, `npm run build` first runs `scripts/build-connector.mjs`, which uses `npm pack --ignore-scripts`, checks an explicit file allowlist, and creates `web/public/downloads/{grimoire-connector.tgz,grimoire-connector-windows.zip,connector-release.json}`. The normal frontend build includes these downloads. This performs no publication or deployment.

Run `node --test byoa/*.test.mjs`, `powershell -NoProfile -File byoa/bootstrap/windows.test.ps1`, and the guarded disposable-stack scripts in `scripts/verify-worker-*.mjs`. The Windows test's `-LiveDownload` option verifies the actual pinned official download in a temporary directory. Test `npm exec --offline --package=<absolute-tarball> grimoire-connector --help` outside the checkout before release.

Only allowlisted runtime modules, bootstrap assets, package metadata, license and this README are distributed. Tests, credentials, `.env`, `.local`, source databases and server code are excluded. Release metadata explicitly says `npm.published:false`; registry publication requires a separate authorized release and confirmed namespace ownership.
