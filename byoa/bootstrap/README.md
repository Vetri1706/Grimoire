# Windows connector bootstrap

The connector release ZIP contains the JavaScript runtime at its root, this
`bootstrap` directory, and `Connect Grimoire.cmd` copied from `launch.cmd`.
Extract the whole ZIP, run the launcher, and paste the website origin shown in
**Connect Codex**. A terminal invocation can pass the origin explicitly:

```powershell
& '.\Connect Grimoire.cmd' -Api 'https://your-grimoire-host.example'
```

The launcher executes only the adjacent `cli.mjs --api ORIGIN --watch`; it does
not retrieve or execute connector code from the website. The command launcher
uses an execution-policy override for its one PowerShell process only. It does
not change the user's PowerShell policy, system Node version, or global PATH.

An existing Node 22.16+ (22.x), 24.x, or 26.3+ (26.x) is reused. If none is found, the user
must type `INSTALL` before the bootstrap downloads the pinned official Node.js
ZIP and installs it under `%LOCALAPPDATA%\Grimoire\Connector\runtime`. Runtime
files inherit a private, current-user-only directory ACL. An existing private
`node.exe` is checked against the pinned executable hash before reuse.

Node **24.21.0**, Krypton LTS, was verified against the official
[release index](https://nodejs.org/dist/index.json) and
[SHA-256 manifest](https://nodejs.org/dist/v24.21.0/SHASUMS256.txt) on 2026-10-02.
`node-runtime.json` pins both the x64 and ARM64 archive and executable hashes.
Downloads use only `https://nodejs.org`, reject redirects, enforce limits, and
verify SHA-256 before extraction or execution. Updating the pin is a reviewed
release change: never fetch an unpinned "latest" hash during installation.

Interrupted transfers retry at most three times using fresh partial files. A
failed checksum is a hard failure, and no unverified executable is launched.
Extraction rejects paths outside the expected Node archive root and symbolic
links. Unsupported architectures fail with a clear message. Installing Node
does **not** install or authenticate Codex; the connector checks Codex separately
and retains its credentials in the existing local Codex account store.

Closing the terminal stops the connector. Neither this launcher nor `npx`
creates a background service.

Tests use isolated workspace directories and synthetic archives; the optional
live check downloads the official ZIP into that same disposable test directory:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File byoa/bootstrap/windows.test.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File byoa/bootstrap/windows.test.ps1 -LiveDownload
```

No npm publication, hosted download availability, or deployment is implied by
these source files or local tests.
