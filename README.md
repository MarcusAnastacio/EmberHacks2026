# Agent Quiz

**Your agents already wrote down everything they did. This app quizzes you on it.**

Every AI coding assistant keeps a transcript of every session on your disk — what you asked
for, what the agent reasoned, which files it touched, which commands it ran and what failed.
Almost nobody reads them back. This project reads them, picks one conversation, and turns it
into an interactive quiz so you actually learn what the agent built and why.

The interesting part is the input: **the question material is your own history, pulled from
whatever tools you happen to use, with no setup.** You open the app and your past sessions
are already in the sidebar.

---

## The idea

An agent wrote the code. You approved it. Do you remember why?

Transcripts contain the reasoning that never makes it into the commit: the approach that was
rejected, the bug that turned out to be a config problem, the two files that had to change
together. A quiz generated from that conversation tests comprehension of work you already
signed off on — which is the gap between "the tests pass" and "I understand this system".

Three properties make it work:

1. **No new data collection.** The history already exists on disk. There is nothing to
   install, no account, no instrumentation. The app is a reader.
2. **Agent-agnostic.** History lives in ~36 different formats across ~36 tools, and almost
   none of them expose an API. Reading them from disk is the only approach that covers
   terminals, IDEs and CLIs at once.
3. **Generation, not retrieval.** The quiz is built by reasoning over the actual transcript —
   the decisions, the ordering, the mistakes — not by summarising it.

---

## Repository layout

```
.
└── electron-app/          # the application
    ├── README.md          #   setup, startup, architecture
    ├── main.js            #   Electron main process
    ├── preload.js         #   the window.compat bridge
    ├── renderer/          #   the UI
    │   └── README.md      #     frontend guide + startup commands
    └── backend/           #   the history compatibility layer
        └── README.md      #     supported agents, formats, folder structure
```

Every directory has its own README. Start with
[`electron-app/README.md`](electron-app/README.md) to get it running.

---

## Running it

```bash
cd electron-app
npm install
npm start
```

Requires Node 22.13+ (24.x recommended). No build step, no runtime dependencies.

Two things worth knowing before the first launch:

- **The backend can be run without Electron**, which is the fastest way to see what the app
  will read: `cd electron-app && npm run scan`
- **`npm run scan:fixtures`** points the scanner at 54 bundled sample stores instead of your
  own history, and finds all 36 supported agents on any machine. This is how to demonstrate
  coverage without installing 36 tools — while being honest that those are sample stores,
  not your own.

---

## What exists today

| Piece | State |
|---|---|
| History compatibility layer — discover and normalize past conversations from up to 36 agents | **Working.** Detected, parsed, normalized to one schema, read-only. |
| Electron shell — sidebar of detected conversations, transcript on selection | **Working.** |
| Gemini payload — the exact bounded JSON a quiz would be generated from | **Working**, inspectable in-app via *Show Gemini payload*. |
| Quiz generation | **Not built.** The button is disabled; the payload is the seam. |
| Quiz interface | **Not built.** The main panel shows the transcript, which is the placeholder to replace. |
| Secret redaction | **Not built.** Must be added before any transcript is sent to a model — see below. |

Details and the honest gaps per agent are in
[`electron-app/backend/README.md`](electron-app/backend/README.md).

---

## How the history reading works

The design decision that makes 36 agents tractable is **one reader per storage format family,
not per agent.** Agents fork each other constantly, so:

- 20 agents share the JSONL family (Claude Code and its forks, Codex, Gemini CLI, pi and its
  forks, Copilot CLI, DeepSeek, Grok)
- 8 are SQLite or VS Code extension storage (Cursor, opencode, Goose, Crush, Zed, Cline, Roo, Kilo)
- aider writes markdown into the project folder
- ChatGPT and Claude web exports have their own shapes

So there are six readers and one registry. Adding an agent is one entry in `registry.json`,
not a new parser.

The registry itself — 33 agents' store locations, formats, env-var overrides and
verification dates, plus the sample stores used in tests — is vendored from
**[vshulcz/deja-vu](https://github.com/vshulcz/deja-vu)** (MIT). Its per-agent format
knowledge is what makes coverage this broad possible in this amount of time. See
[`backend/README.md`](electron-app/backend/README.md#libraries-and-sources-used) for the
full attribution.

---

## Before this is demoed anywhere real

Transcripts are the most sensitive files on a developer's machine. They contain API keys,
tokens, `.env` contents and internal URLs, and this app asks to read all of them.

- It is **read-only** today — stores are opened read-only, nothing is written, renamed or
  deleted.
- It is **local-only** today — no network calls exist anywhere in the codebase.
- It is **not redacted** today. `toQuizPayload()` in `electron-app/backend/detect.js` is the
  single function where a conversation would leave the machine, which makes it the single
  place redaction has to be added.

Any real deployment needs that redaction pass first, and a clear statement to the user about
what is read and what is sent.

---

## Credits

| Project | License | Used for |
|---|---|---|
| [vshulcz/deja-vu](https://github.com/vshulcz/deja-vu) | MIT | The agent store registry and the sample stores used for testing. |
| [jhlee0409/claude-code-history-viewer](https://github.com/jhlee0409/claude-code-history-viewer) | MIT | Cross-checking store locations across 29 providers. |
| [kvsankar/agent-history](https://github.com/kvsankar/agent-history) | MIT | Reference unified session model and per-format documentation. |
| [microsoft/vscode](https://github.com/microsoft/vscode) | MIT | The chat session operation-log format is implemented against `objectMutationLog.ts` / `chatSessionOperationLog.ts`. |
