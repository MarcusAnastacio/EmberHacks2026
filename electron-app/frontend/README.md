# Renderer (frontend)

The UI. Plain HTML, CSS and browser JavaScript — **no framework, no bundler, no build
step**. Edit a file, reload the window.

This README is about running the UI and where the quiz view plugs in. For the app shell and
setup, see [`../README.md`](../README.md). For what the sidebar's data actually is, see
[`../backend/README.md`](../backend/README.md).

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

To see a populated sidebar without installing any AI agents, launch against the bundled
sample stores:

```bash
npm run start:fixtures
# or click "Demo data" in the running app
```

To check the UI without a display (renders the window to a PNG and exits):

```bash
COMPAT_SCREENSHOT=/tmp/app.png npm start
COMPAT_SCREENSHOT=/tmp/app.png COMPAT_SCREENSHOT_DELAY=6000 npm start   # wait longer
```

There is no lint or test command for the renderer. `npm test` at the app root runs the
backend parser tests.

---

## Files

| File | Responsibility |
|---|---|
| `index.html` | Structure and the CSP. Two panes: `.sidebar` and `.main`. |
| `styles.css` | All styling. Design tokens are CSS custom properties in `:root` at the top. |
| `renderer.js` | All logic. Fetches the catalog, renders the list, handles selection. |

Everything is one flat script with no modules, so `renderer.js` runs in the page scope and
talks to the main process only through `window.compat`. It is split into four commented
sections: **Sidebar**, **Main panel**, **Actions**, **Boot**.

---

## The only API the UI has

`window.compat` is injected by `../preload.js`. Nothing else is available — no `require`,
no `fs`, no file paths.

```js
// Commands (all return promises)
compat.list(options?)             // sidebar catalog: detected agents grouped with sessions
compat.refresh(options?)          // rescan. { fixtures: true } uses bundled sample stores
compat.session(id)                // one conversation, WITH message bodies
compat.payload({ id, maxChars })  // bounded, trimmed JSON for Gemini
compat.generate({ id, prompt })    // generate a validated quiz in the main process
compat.search(query)              // flat, body-less list for a search box
compat.registry()                 // every agent we know about, detected or not

// Events (return an unsubscribe function)
compat.onProgress(evt => {})      // { phase, harness, name, sessions?, files? }
compat.onReady(evt => {})         // { scannedAt, sessions }
```

`list()` vs `session(id)` is the important distinction: `list()` returns **summaries only**
(title, project, counts, timestamps) so it is cheap enough to hold in memory and send
whole. Message bodies arrive only when you ask for one conversation.

### Shapes

```js
// from list() -> catalog.groups[].sessions[]
{
  id: "claude:9f31c0a9-...",   // pass this to session() and payload()
  nativeId, title, project,
  updated, started,            // epoch ms
  messageCount, userTurns, chars,
  quizReady: true,             // >= 2 user turns and >= 400 chars
  partial: false,              // parsed, but some turns were undecodable
  source: "file" | "sqlite" | "vscode"
}

// from session(id)
{
  ...the above, plus:
  messages: [
    { role: "user" | "assistant" | "system" | "tool",
      text: "...",
      ts: 1779938213302,               // may be absent
      tools: [{ name: "Bash", input: {...} }] }   // may be absent
  ]
}

// progress events during a scan
{ phase: "harness-start" | "harness-done", harness: "claude", name: "Claude Code",
  sessions: 47, files: 47 }
```

`catalog.absent` lists the agents that were searched for and **not** found — useful for a
"why isn't my tool here?" affordance.

---

## Current UI

The window is a two-pane split. Everything left of the seam is real; the right pane is a
placeholder for the quiz.

```
┌── sidebar (320px, resizable via --sidebar-w) ──┬── .main ─────────────────────┐
│ "Conversations"                                │  #empty      nothing selected │
│ summary line: "3 of 36 tools · 48 …"           │  #session    transcript       │
│ search box                                     │  #payload-view  raw JSON      │
│ ── group: Claude Code (12) ──                  │                               │
│    ┌ .row ───────────────────┐  ← rectangles   │                               │
│    │ title, project, age     │                 │                               │
│    └─────────────────────────┘                 │                               │
│ Rescan · Demo data · progress line             │                               │
└────────────────────────────────────────────────┴───────────────────────────────┘
```

**Sidebar** — one `.row` button per conversation, grouped by agent. Titles come from the
backend, which derives them from the first user message; `clamp(text, 20)` in
`renderer.js` shortens them for display and CSS adds an ellipsis. Rows that are too short
to make a good quiz are marked `short` but stay selectable.

**`.main`** — the states are `#empty`, `#session`, `#quiz`, and `#payload-view`, toggled
with the `hidden` attribute. `select(id)` renders the transcript and focus prompt;
`compat.generate({ id, prompt })` asks the main process to generate and validate the quiz;
`#quiz` renders the interactive questions and score. The Gemini request runs in the main
process, keeping the API key and filesystem access out of the renderer.

---

## Conventions

- **`textContent`, never `innerHTML`, for anything from a transcript.** Transcripts are
  untrusted text copied out of other tools' stores. Tool names, titles and project labels
  are also untrusted. This is the app's main XSS boundary.
- **Design tokens live in `:root`** in `styles.css` (`--bg`, `--text`, `--accent`,
  `--sidebar-w`, …). Restyle from there rather than adding literal colours.
- **Classes are BEM-ish and flat**: `.row`, `.row__title`, `.msg--user`, `.btn--primary`.
- **No inline scripts or styles** — the CSP in `index.html` is `default-src 'none'` and
  will block them.
- Keep DOM lookups in the `el` object at the top of `renderer.js` rather than scattering
  `getElementById` calls.
- Rebuild lists by replacing children (`replaceChildren()`), not by mutating. There is no
  virtual DOM and no diffing.

---

## Notes

- `renderer.js` degrades gracefully if `window.compat` is missing: it says so instead of
  throwing, which is what you will see if you open `index.html` directly in a browser.
- `onProgress` fires per agent during a scan and is what drives the progress line in the
  sidebar footer. A scan of a few dozen sessions finishes in about 2 s.
- Renderer logs go to the DevTools console, not the terminal that started Electron.
