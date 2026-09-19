# Frontend

The UI. Plain HTML, CSS and **ES modules** — no framework, no bundler, no build step. Edit
a file, reload the window.

For app setup and architecture see [`../README.md`](../README.md). For what the sidebar's
data actually is see [`../backend/README.md`](../backend/README.md). For the quiz schema
this UI will eventually render see [`../docs/quiz-design.md`](../docs/quiz-design.md).

---

## Run it

```bash
cd electron-app
npm install      # once
npm start
```

A save is not hot-reloaded — press **Ctrl/Cmd + R** in the window, or relaunch. To keep
DevTools open while you iterate:

```bash
COMPAT_DEVTOOLS=1 npm start
```

To see a populated sidebar without installing any AI agents:

```bash
npm run start:fixtures
# or click "Demo data" in the running app
```

To check the UI without a display (renders the window to a PNG and exits):

```bash
COMPAT_SCREENSHOT=/tmp/app.png npm start
COMPAT_SCREENSHOT=/tmp/app.png COMPAT_SCREENSHOT_DELAY=6000 npm start
```

There is no lint or test command for the frontend. `npm test` at the app root covers the
backend.

---

## ⚠️ Modules only work because the page is served from `app://`

This is the one thing that will silently waste an hour if you do not know it.

The window loads `app://bundle/index.html`, registered as a privileged scheme in
`../main.js`. It is **not** `file://`. That matters because:

- A `file://` page has a **null origin**, so the CSP directive `script-src 'self'` matches
  nothing.
- `<script type="module">` is therefore **refused**, and the failure is silent: no console
  error you would notice, no red screen, the script simply never runs and the sidebar stays
  empty while the HTML renders perfectly.

Changing `loadURL` back to `loadFile` would break every `import` in this folder. If
components stop loading for no visible reason, check the scheme first.

Consequences that follow from this:

- `type="module"` is required on the entry script and on nothing else.
- Imports must be **relative and include the extension**: `import { h } from './lib/dom.js'`
  — no bare specifiers, since there is no resolver.
- The CSP in `index.html` stays strict: `default-src 'none'; script-src 'self'; style-src
  'self'`. No inline scripts, no inline styles, no remote anything.

---

## Files

```
frontend/
├── index.html              structure + CSP. Two panes: .sidebar and .main
├── styles.css              all styling. Design tokens are CSS custom properties in :root
├── renderer.js             entry: owns state, wires events, calls components
├── components/             render a piece of UI from props. No state, no fetching
│   ├── conversation-list.js   sidebar list, grouped by agent
│   └── transcript.js          message list for one session
└── lib/                    pure helpers, no DOM policy
    ├── dom.js                 h(), mount(), clear(), placeholder()
    └── format.js              clamp(), timeAgo(), num()
```

### Where new code goes

| Adding… | Put it in |
|---|---|
| A new UI piece (quiz view, score card, timer) | `components/<name>.js`, exporting one `render<Name>(container, props)` |
| A reusable pure function (formatting, scoring maths) | `lib/<name>.js`, no DOM access |
| State, event wiring, orchestration | `renderer.js` — keep it thin; it should mostly be `on`/`await`/`render` |
| A new bridge call | `../backend/ipc.js` **and** `../preload.js`, together (see below) |

### Component conventions

- A component is a **function of props**, not an object with state. It renders into a
  container and reports interactions through callbacks: `onSelect`, `onMessageClick`.
- Rebuild by replacing children (`mount(container, …)`), not by mutating. There is no
  virtual DOM and no diffing.
- Never fetch. Only `renderer.js` talks to `window.compat`.
- Always build DOM with `h()` from `lib/dom.js`, which routes text through `textContent`.

---

## The only API the UI has

`window.compat` is injected by `../preload.js`. Nothing else is available — no `require`,
no `fs`, no file paths.

```js
// Commands (all return promises)
compat.list(options?)             // sidebar catalog: agents grouped with session summaries
compat.refresh(options?)          // rescan. { fixtures: true } uses bundled sample stores
compat.session(id)                // one conversation, WITH message bodies
compat.payload({ id, maxChars, entropy })   // { payload, redaction } — the Gemini-ready object
compat.search(query)              // flat, body-less list for a search box
compat.registry()                 // every agent we know about, detected or not

// Events (return an unsubscribe function)
compat.onProgress(evt => {})      // { phase, harness, name, sessions?, files? }
compat.onReady(evt => {})         // { scannedAt, sessions }
```

`list()` vs `session(id)` is the important distinction: `list()` returns **summaries only**
so it is cheap enough to hold in memory and send whole. Message bodies arrive only when you
ask for one conversation.

`payload()` is the one call with a side effect worth knowing about: it applies secret
redaction. It returns `{ payload, redaction }`, not a bare payload.

### Shapes

```js
// list() -> catalog.groups[].sessions[]
{
  id: "claude:9f31c0a9-...",   // pass this to session() and payload()
  nativeId, title, project, harnessName,
  updated, started,            // epoch ms
  messageCount, userTurns, chars,
  quizReady: true,             // >= 2 user turns and >= 400 chars
  partial: false,              // parsed, but some turns were undecodable
  source: "file" | "sqlite" | "vscode"
}

// session(id)
{
  ...the above, plus:
  cwd, toolCalls,              // toolCalls is a count; tool bodies are not inlined
  messages: [
    { role: "user" | "assistant" | "system" | "tool",
      text: "...",
      ts: 1779938213302,               // may be absent
      tools: [{ name: "Bash", input: {...} }] }   // may be absent
  ]
}

// payload() -> redaction
{ total: 1, byKind: { "huggingface-token": 1 }, entropy: 0, scanned: 11 }

// progress events during a scan
{ phase: "harness-start" | "harness-done", harness: "claude", name: "Claude Code",
  sessions: 47, files: 47 }
```

`catalog.absent` lists agents that were searched for and **not** found.

---

## Current UI, and what it is meant to become

```
┌── sidebar (320px, --sidebar-w) ────────────────┬── .main ─────────────────────┐
│ "Conversations"                                │  #empty       nothing selected │
│ summary: "3 of 36 tools · 48 conversations"    │  #session     transcript       │
│ search box                                     │  #payload-view  Gemini payload │
│ ── group: Claude Code (12) ──                  │                               │
│    ┌ .row ───────────────────┐                 │                               │
│    │ title, project, age     │                 │                               │
│    └─────────────────────────┘                 │                               │
│ Rescan · Demo data · progress line             │                               │
└────────────────────────────────────────────────┴───────────────────────────────┘
```

**Sidebar** — one `.row` button per conversation, grouped by agent. Titles come from the
backend, which derives them from the first user message; `clamp(text, 20)` shortens them and
CSS adds an ellipsis. Rows too short to make a good quiz are marked `short` but stay
selectable.

**`.main`** — three states, `#empty`, `#session`, `#payload-view`, toggled through
`showPane()` with the `hidden` attribute.

**The quiz view plugs in at `#session`.** Add `components/quiz.js`, add a
`#quiz-view` article with its own state in `showPane()`, and call it from the (currently
disabled) `Generate quiz` button using `compat.payload({ id })` as input. The
`sourceRefs` in the generated questions index into `session.messages`, so the transcript
view stays useful: it is how you jump from "your answer was wrong" to the turn that proves
it. `.msg__index` badges are already rendered for exactly that.

---

## Styling

Design tokens are CSS custom properties in `:root` at the top of `styles.css` — `--bg`,
`--bg-raised`, `--text`, `--accent`, `--user`, `--assistant`, `--sidebar-w`. Restyle from
there rather than adding literal colours.

Classes are flat and BEM-ish: `.row`, `.row__title`, `.row__meta`, `.msg--user`,
`.msg__body`, `.btn--primary`, `.group__head`, `.redaction`.

---

## Notes

- `renderer.js` degrades gracefully if `window.compat` is missing: it says so instead of
  throwing. That is what you see if you open `index.html` directly in a browser.
- `onProgress` fires per agent and drives the progress line in the sidebar footer. A scan of
  a few dozen sessions takes about 2 s.
- Renderer logs go to the DevTools console, not the terminal that started Electron.
- **`textContent`, never `innerHTML`, for anything from a transcript.** Transcripts are
  untrusted text copied out of other tools' stores, and titles, project labels and tool names
  are equally untrusted. `h()` in `lib/dom.js` exists partly to make this the easy path.
