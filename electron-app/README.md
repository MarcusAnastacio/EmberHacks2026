# Agent Quiz — Electron app

Reads the conversation history that AI agents have already written to disk, picks one,
and turns it into an interactive quiz. This README covers **setup and startup** plus how
the three processes fit together.

The history-reading engine has its own document: [`backend/README.md`](backend/README.md).
The UI has its own: [`frontend/README.md`](frontend/README.md).

---

## Requirements

| | |
|---|---|
| Node.js | **22.13 or newer** (24.x recommended) |
| OS | macOS, Linux or Windows |
| Disk | ~350 MB for the Electron binary |

The backend uses `node:sqlite` and `zlib.zstdDecompressSync`, both of which need a recent
Node. **Electron 44 or newer bundles Node 24**, which is why the dependency floor is where
it is — an older Electron silently degrades every SQLite-based agent (Cursor, opencode,
Goose, Crush, Zed) to "detected but unparsed".

Verify what your shell and your Electron actually give you:

```bash
node -e "console.log(process.version, typeof require('node:zlib').zstdDecompressSync, !!require('node:sqlite'))"
npx --no-install electron --version   # after install, see below
```

---

## Setup

```bash
cd electron-app
npm install
```

That is the whole setup. There is no build step, no bundler, no transpiler, and **no
runtime dependencies** — Electron is the only package, and it is a dev dependency. Plain
ES modules and plain browser JS throughout, so a file save is a reload.

To run the history scanner on its own, without Electron (useful for debugging what the app
will see):

```bash
npm run scan              # scan this machine, print the table
npm run scan:fixtures     # scan the bundled sample stores instead
npm test                  # backend parser and storage tests
npm test --prefix frontend  # the frontend/backend contract test
```

---

## Startup

```bash
# from electron-app/
npm start
```

The window opens, the scan starts automatically, and the sidebar fills with whatever
conversations were found. Progress streams in from the main process as each agent is read.

Other ways to launch:

```bash
npm run start:fixtures          # launch against the bundled sample stores
COMPAT_DEVTOOLS=1 npm start     # open DevTools on launch
COMPAT_FIXTURES=1 npm start     # same as start:fixtures, via env var

# render the window to a PNG and exit — useful for checking the UI headlessly
COMPAT_SCREENSHOT=/tmp/app.png npm start
COMPAT_SCREENSHOT=/tmp/app.png COMPAT_SCREENSHOT_DELAY=6000 npm start
```

> The inline `VAR=value` scripts use POSIX shell syntax. On Windows, set the variable
> first (`$env:COMPAT_DEVTOOLS=1` in PowerShell, or `set COMPAT_DEVTOOLS=1` in `cmd`) and
> then run `npx electron .`.

In-app: **Rescan** re-reads your real history, **Demo data** re-reads the bundled sample
stores. The latter is how to demonstrate full coverage on a machine that only has two or
three agents installed.

Running on Linux with no display, or in a container:

```bash
xvfb-run -a npx electron --no-sandbox .
```

---

## Layout

```
electron-app/
├── package.json          # electron devDependency + the scripts above
├── main.js               # MAIN process: window, IPC registration, starts the scan
├── preload.js            # the contextBridge: window.compat
├── renderer/             # RENDERER: the UI. See renderer/README.md
│   ├── index.html
│   ├── styles.css
│   └── renderer.js
└── backend/              # the history compatibility layer. See backend/README.md
    ├── index.js          #   CompatibilityLayer: the public API
    ├── ipc.js            #   the main <-> renderer contract
    ├── detect.js         #   the scan engine
    ├── readers/          #   one reader per storage format family
    ├── lib/              #   path expansion, content extraction, the unified schema
    ├── registry.json     #   36 agents: where their history lives
    ├── fixtures/         #   sample stores for all 36
    └── cli.js            #   run the layer from a terminal, no Electron
```

### The three processes, and one rule

| Process | File | May do | May **not** do |
|---|---|---|---|
| Main | `main.js` | Read the filesystem, own the catalog, register IPC | Touch the DOM |
| Preload | `preload.js` | Expose a fixed set of channels on `window.compat` | Read the filesystem, hold state |
| Frontend | `frontend/*` | Render, listen, ask | Read the filesystem, `require()` anything |

**The rule:** the frontend never touches a file path and never learns an agent's storage
layout. It asks for a list and asks for a conversation. All knowledge of where history
lives stays in `backend/`.

```js
// in the frontend
const catalog = await window.compat.list()            // sidebar: agents + conversations
const session = await window.compat.session(id)       // one conversation, with messages
const payload = await window.compat.payload({ id })   // bounded, trimmed, ready for Gemini
```

The channel list lives in two places that must stay in sync: `backend/ipc.js` (main side)
and `preload.js` (frontend side). `preload.js` is intentionally *not* importing
`backend/ipc.js`, because it runs under `sandbox: true` where only `require('electron')`
is available.

### Startup order in `main.js`

This order is deliberate — changing it produces "no handler registered" errors:

1. `await import('./backend/index.js')` — the backend is ESM; this file is CommonJS, so a
   dynamic `import()` is used rather than `require()`, which is not reliable for ESM inside
   Electron.
2. `registerCompatibilityIpc(...)` — **before** any window exists, so the frontend can
   never invoke an unwired channel.
3. `new BrowserWindow(...)` and `loadFile(...)`.
4. `layer.refresh()` on `did-finish-load`, with progress broadcast to the frontend.

The frontend also calls `refresh()` on mount. The layer de-duplicates concurrent scans, so
step 4 and the frontend's own call collapse into one scan.

### Why the page is served from `app://` and not `file://`

Step 3 loads `app://bundle/index.html` from a custom scheme registered with
`protocol.registerSchemesAsPrivileged({ standard: true, secure: true })`, and a
`protocol.handle('app', …)` handler serves files out of `frontend/`, refusing anything that
resolves outside that directory.

This is load-bearing, not cosmetic. A `file://` page has a **null origin**, so the CSP
directive `script-src 'self'` matches nothing — which means `<script type="module">` is
refused, **silently**. The HTML renders, the module never runs, the sidebar stays empty, and
there is no error to search for. Registering a real origin makes `'self'` meaningful, so ES
modules work while the CSP stays strict (`default-src 'none'`).

If you ever change `loadURL` back to `loadFile`, every `import` in `frontend/` breaks.

---

## Security posture

`webPreferences` is locked down, and the history being read is sensitive:

```js
contextIsolation: true     // frontend JS cannot reach the preload's scope
nodeIntegration: false     // no require() in the frontend
sandbox: true              // preload is limited to require('electron')
```

Plus a strict CSP in `index.html` (`default-src 'none'`) and no remote content. Message
bodies are inserted with `textContent`, never `innerHTML` — transcripts are untrusted text
copied from other tools, and `textContent` is what stops a transcript from injecting markup
into the app.

Nothing in this app makes a network call yet. When Gemini is wired up, `npm run scan` and
the **Show Gemini payload** button are how to inspect exactly what would leave the machine.

---

## What works today, and what does not

**Works**

- Discovery and parsing of past conversations from up to 36 agents
  (`backend/README.md` has the full table and the honest gaps).
- Sidebar grouped by agent, filterable, with a live scan-progress line.
- Selecting a conversation renders the full transcript, with tool calls labelled per turn.
- **Secret redaction** on the way out — 29 pattern kinds (private keys, JWTs, bearer
  tokens, provider tokens, credentials in connection strings, `.env` lines, prose). The
  payload view reports what was stripped, per kind.
- **Show Gemini payload** — the exact bounded JSON the quiz generator will be given, with
  its byte count, truncation flag and redaction report.
- `npm run scan:fixtures` → 33 of 36 agents producing parsed sessions on any machine.

**Not built yet**

- Quiz generation. `Generate quiz` is disabled, and the payload is the seam it will use.
- Quiz rendering. The main panel currently shows the transcript; that view is the
  placeholder to replace.

Proposed design for all of the above — the Gemini response schema for MCQ / open-ended /
fill-in-the-blank, quiz storage and how to tell when a transcript has changed under a
generated quiz, and how to fit a 7 MB conversation into a bounded prompt — is in
[`docs/quiz-design.md`](docs/quiz-design.md).
---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `window.compat` is undefined | The page was opened in a browser instead of through Electron, so `preload.js` never ran. Launch with `npm start`. |
| `SyntaxError: Unexpected token 'export'` | The backend lost its `"type": "module"`. `backend/package.json` must exist; it is what scopes ESM to that folder. |
| Sidebar shows agents but no conversations | Correct behaviour, not a bug. It means those agents are installed, but the specific stores hold no messages. VS Code Copilot Chat is the usual culprit: it writes a session file the moment the chat panel opens, so empty sessions are common. See `backend/README.md`. |
| Every SQLite agent says "detected but unparsed" | The Electron/Node version is too old for `node:sqlite`. The app reports this in the sidebar summary line. Upgrade Electron. |
| Blank window | Check the terminal for a thrown error, or launch with `COMPAT_DEVTOOLS=1 npm start`. |
| HTML renders but nothing is interactive and no error appears | The modules were refused. The page is not being served from `app://` — see "Why the page is served from app://" above. |
| `Cannot use import statement outside a module` | `frontend/index.html` lost `type="module"` on the `renderer.js` script tag. |
| `ELECTRON_DISABLE_SANDBOX` / sandbox errors on Linux | Run `npx electron --no-sandbox .`, or use `xvfb-run -a` when there is no display. |
