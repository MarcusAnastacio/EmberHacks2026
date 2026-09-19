# Compatibility Layer — agent conversation history

Detects and normalizes **past conversations from 36 AI coding assistants** that already
exist on the user's disk, so the app can feed one into Gemini and turn it into a quiz.

Zero config. Zero runtime dependencies. Read-only — it never writes to another agent's
store. A scan of a real machine with a few dozen sessions takes under 2 s.

```
$ npm run scan

HARNESS               FILES  SESSIONS  QUIZ-READY  DETECTED STORES
-----------------------------------------------------------------------
pi                    47     47        43          ~/.pi/agent/sessions/--home-dev-code-myapp--/2026-08-29T18-26-45-681Z_<session-id>.jsonl
Continue              2      1         0           ~/.continue/sessions/<uuid>.json
VS Code Copilot Chat  28     0         0           ~/.config/Code/User/workspaceStorage/<hash>/chatSessions/<uuid>.jsonl
-----------------------------------------------------------------------
3/36 harnesses detected · 48 sessions · 43 quiz-ready   <- illustrative; depends on what you have installed
```

---

## Quick start

### Test it from the terminal (no Electron needed)

```bash
cd electron-app/backend

npm run scan                     # scan this machine, print the sidebar table
npm run scan:fixtures            # same table, using bundled sample stores → 33/36 detected
npm run scan:json                # full sidebar catalog as JSON

node cli.js --show <session-id>          # inspect one normalized session
node cli.js --payload <session-id>       # print the exact JSON handed to Gemini
node cli.js --only pi,codex,cursor       # restrict the scan
node cli.js --progress                   # per-harness progress lines on stderr
```

### From Electron

```js
// main.js
import { CompatibilityLayer } from './backend/index.js'
import { registerCompatibilityIpc } from './backend/ipc.js'

const layer = new CompatibilityLayer()
registerCompatibilityIpc({
  ipcMain,
  layer,
  getWindows: () => BrowserWindow.getAllWindows(),
})
```

```js
// preload.js
const { createRendererApi } = require('./backend/ipc.js')
contextBridge.exposeInMainWorld('compat', createRendererApi(ipcRenderer.invoke, ipcRenderer))
```

```js
// renderer
const catalog = await window.compat.list()              // sidebar: harness groups + sessions
const payload = await window.compat.payload({ id })     // → send this to Gemini
```

> **`backend/package.json` sets `"type": "module"` on purpose.** The backend is ESM. The
> nested file scopes that to this folder so it does not conflict with the Electron app's
> own `package.json`. Electron's bundled Node does **not** have Node 24's automatic module
> syntax detection, so without this the imports fail.

---

## Supported harnesses (36)

Every entry below is a real on-disk store that was located by reading and testing against
actual files. `Verified` is the upstream date on which that path and format were last
confirmed against a live client.

### Code agents — JSONL / JSON stores

| Agent | ID | Store location | Format | Verified |
|---|---|---|---|---|
| Claude Code | `claude` | `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/**/*.jsonl` | jsonl | 2026-09-10 |
| Codex CLI | `codex` | `${CODEX_HOME:-~/.codex}/sessions/**/rollout-*.jsonl` (+ `.zst`, archived, `history.jsonl`) | jsonl rollout | 2026-09-10 |
| Gemini CLI | `gemini` | `${GEMINI_CLI_HOME:-~}/.gemini/tmp/*/chats/**/*.{json,jsonl}` | json / jsonl | 2026-07-24 |
| pi | `pi` | `${DEJA_PI_ROOT:-~/.pi/agent/sessions}/**/*.jsonl` | jsonl | 2026-09-06 |
| omp (Oh My Pi) | `omp` | `${DEJA_OMP_ROOT:-~/.omp/agent/sessions}/**/*.jsonl` | jsonl (pi fork) | 2026-09-06 |
| prime-agent | `prime` | `${DEJA_PRIME_ROOT:-~/.prime/agent/sessions}/**/*.jsonl` | jsonl (pi fork) | 2026-08-30 |
| Senpi | `senpi` | `${SENPI_CODING_AGENT_DIR:-~/.senpi/agent}/sessions/*/*.jsonl` | jsonl (pi fork) | 2026-09-17 |
| Kimchi Coding | `kimchi` | `${KIMCHI_CODING_AGENT_DIR:-.../kimchi/harness}/sessions/--<cwd>--/*.jsonl` | jsonl | 2026-09-17 |
| Qwen Code | `qwen` | `${DEJA_QWEN_ROOT:-~/.qwen}/projects/*/chats/*.jsonl` | jsonl | 2026-09-07 |
| ZCode | `zcode` | `~/.zcode/projects/*/*.jsonl`, `~/.zcode/cli/db/db.sqlite` | jsonl + sqlite | 2026-09-17 |
| Command Code | `commandcode` | `~/.commandcode/projects/*/*.jsonl` | jsonl | 2026-09-16 |
| Cherry Studio | `cherrystudio` | `<app data>/CherryStudio/Data/Agents/.claude/projects/*/*.jsonl` | jsonl | 2026-09-17 |
| Antigravity | `antigravity` | `~/.gemini/antigravity*/brain/*/.system_generated/logs/transcript.jsonl` | jsonl | 2026-07-17 |
| DeepSeek Harness | `deepseek` | `${DSH_HOME:-~/.dsh}/sessions/*/session-*/session.jsonl[.zstd]` | jsonl (slashed events) | 2026-08-21 |
| Grok Build | `grok` | `${GROK_HOME:-~/.grok}/sessions/**/updates.jsonl` (+ `grok.db`) | ACP jsonl | 2026-08-24 |
| Kimi Code | `kimi` | `${KIMI_CODE_HOME:-~/.kimi-code}/sessions/*/*/agents/main/wire.jsonl` | jsonl | 2026-07-28 |
| Kiro | `kiro` | `~/.kiro/sessions/cli/*.jsonl`, `~/.kiro/sessions/*/sess_*/messages.jsonl` | jsonl | 2026-09-17 |
| Copilot CLI | `copilot` | `${DEJA_COPILOT_ROOT:-~/.copilot/session-state}/*/events.jsonl` | jsonl (dotted events) | 2026-08-14 |
| gajae-code | `gjc` | `${GJC_CODING_AGENT_DIR:-~/.gjc/agent}/sessions/*/*.jsonl` | jsonl | 2026-09-17 |
| Amp | `amp` | `${XDG_DATA_HOME:-~/.local/share}/amp/threads/*.json` | json thread | 2026-09-02 |

### IDE / editor agents — VS Code storage & extension stores

| Agent | ID | Store location | Format | Verified |
|---|---|---|---|---|
| VS Code Copilot Chat | `copilot-chat` | `<vscode-User>/workspaceStorage/*/chatSessions/*.{json,jsonl}` | storage op-log | 2026-09-18 |
| Cline | `cline` | `<vscode-globalStorage>/saoudrizwan.claude-dev/tasks/*/api_conversation_history.json` | json | 2026-07-28 |
| Roo Code | `roo` | `<vscode-globalStorage>/rooveterinaryinc.roo-cline/tasks/*/api_conversation_history.json` | json | 2026-09-07 |
| Kilo Code | `kilocode` | `<vscode-globalStorage>/kilocode.kilo-code/tasks/*/api_conversation_history.json` (+ `kilo.db`) | json + sqlite | 2026-09-17 |
| Cursor | `cursor` | `.../Cursor/User/{globalStorage,workspaceStorage/*}/state.vscdb`; `${CURSOR_CONFIG_DIR:-~/.cursor}/projects/**/agent-transcripts/**/*.jsonl` | sqlite KV + jsonl | 2026-07-17 |
| Continue | `continue` | `${CONTINUE_GLOBAL_DIR:-~/.continue}/sessions/*.json` | json | 2026-09-07 |
| Zed | `zed` | `.../Zed/threads/threads.db` (Zstd-compressed JSON) | sqlite | 2026-08-21 |

`<vscode-User>` fans out over **VS Code, VS Code Insiders, VSCodium, Cursor, Windsurf,
Trae and PearAI** on macOS, Linux and Windows, so one registry entry covers every
VS Code–derived editor the user has installed — including Trae, which has no registry
entry of its own because it reuses the Copilot-style `chatSessions` storage.

### CLI / TUI agents — SQLite stores

| Agent | ID | Store location | Format | Verified |
|---|---|---|---|---|
| opencode | `opencode` | `${XDG_DATA_HOME:-~/.local/share}/opencode/opencode.db` | sqlite | 2026-07-17 |
| Goose | `goose` | `${XDG_DATA_HOME}/goose/sessions/*.jsonl` and `sessions.db` | jsonl + sqlite | 2026-09-07 |
| Crush | `crush` | `<project>/.crush/crush.db` (per-project) | sqlite | 2026-09-07 |
| Hermes | `hermes` | `~/.hermes/state.db`, `~/.hermes/profiles/*/state.db` | sqlite | 2026-07-28 |
| OpenClaw | `openclaw` | `${OPENCLAW_STATE_DIR:-~/.openclaw}/agents/*/agent/openclaw-agent.sqlite` | sqlite + jsonl | 2026-09-02 |

### Other assistants

| Agent | ID | Store location | Format | Verified |
|---|---|---|---|---|
| aider | `aider` | `<project>/.aider.chat.history.md` (project-local, not a dotfile in `$HOME`) | markdown log | 2026-07-27 |
| ChatGPT | `chatgpt` | `${CHATGPT_EXPORT_DIR}/**/conversations.json` (Settings → Export data) | export json | ours |
| Claude (web) | `claude-web` | `${CLAUDE_EXPORT_DIR}/**/conversations.jsonl` (Settings → Export data) | export jsonl | ours |
| Windsurf Cascade | `windsurf` | `~/.codeium/windsurf/cascade/*` | **detect-only** | ours |

> **`windsurf` is detected but not decoded.** Cascade writes protobuf blobs and the `.proto`
> definition is not public. The store is reported in the sidebar so the user sees it was
> found; the session count is honestly zero. Everything else in the table produces parsed
> sessions.

### Environment overrides

Every template honours the tool's own env vars, so non-default installs work:
`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME`, `CONTINUE_GLOBAL_DIR`,
`CLINE_SESSION_DATA_DIR`, `OPENCLAW_STATE_DIR`, `GROK_HOME`, `KIMI_CODE_HOME`, `DSH_HOME`,
`GOOSE_PATH_ROOT`, `CURSOR_CONFIG_DIR`, `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `APPDATA`,
`LOCALAPPDATA`, `AIDER_CHAT_HISTORY_FILE`, plus our own `DEJA_*_ROOT` overrides.

---

## Libraries and sources used

**Runtime dependencies: none.** The whole layer is Node built-ins, which is why it starts
in ~1.5 s and needs no native rebuild against Electron.

| Library / built-in | Used for |
|---|---|
| `node:fs` — `globSync` | Store discovery. Brace expansion (`*.{json,jsonl}`) and `withFileTypes` to exclude directories. |
| `node:path`, `node:os` | Template expansion, home directory, platform roots. |
| `node:zlib` — `zstdDecompressSync` | Codex `rollout-*.jsonl.zst` and DeepSeek `session.jsonl.zstd`. |
| `node:sqlite` — `DatabaseSync` | Cursor, opencode, Goose, Crush, Zed, Hermes, Kiro, Kilo. Opened `readOnly`. Degrades to "detected but unparsed" if the Electron runtime lacks the builtin. |
| `node:events` — `EventEmitter` | Scan progress events forwarded to the renderer. |
| global `TextDecoder` (Node ≥ 11) | Decoding BLOB columns out of SQLite rows. |
| manual JSONL line splitting | One malformed line is counted in `partial` and skipped, instead of losing the whole transcript the way a single `JSON.parse` of the file would. |
| `node:child_process` — `execFileSync` | Git inspection in `lib/project.js`. Never a shell, always an argument array, always a 4 s timeout, so a path containing shell metacharacters cannot become a command. |
| `node:fs` — `readdirSync`, `statSync` | The directory tree and the documentation/manifest allowlist. |
| `node:assert` | The test scripts. No test framework: `npm test` runs three plain scripts that exit non-zero on failure. |

### Prior art that made this possible

| Project | License | What we took |
|---|---|---|
| [vshulcz/deja-vu](https://github.com/vshulcz/deja-vu) | MIT | **`registry.json`** (store paths, formats, per-harness verification dates) and **`fixtures/`** (54 real sample stores across 33 harnesses). This is the backbone of the layer. |
| [jhlee0409/claude-code-history-viewer](https://github.com/jhlee0409/claude-code-history-viewer) | MIT | Cross-checked store paths for 29 providers, incl. Cursor `agent-transcripts` and Antigravity `brain/`. |
| [kvsankar/agent-history](https://github.com/kvsankar/agent-history) | MIT | Reference for the unified session model and `docs/*-format.md` format specs. |
| [AI SDK / OpenAI / Anthropic message shapes](https://github.com/Aider-AI/aider) | — | The content-block variants handled in `lib/text.js`. |

`registry.json` is vendored verbatim from deja-vu and kept as a clean upstream drop-in;
our three additions live separately in `registry.extras.js` so refreshing upstream is a
single file copy. Attribution lives at the top of each file.

---

## Backend folder structure

```
electron-app/backend/
├── index.js              # CompatibilityLayer — the public API. Owns the cached catalog.
├── ipc.js                # Electron main <-> renderer contract (registerCompatibilityIpc,
│                         #   createRendererApi, channel names, progress broadcast)
├── detect.js             # The scan engine: registry -> paths -> read -> normalize.
│                         #   Also discoverStores(), toQuizPayload(), isQuizReady().
├── cli.js                # Terminal harness. Runs the layer with no Electron, prints the
│                         #   sidebar table. Doubles as the fallback demo script.
├── registry.json         # 33 harnesses: store paths, format kind, fixtures, last-verified
│                         #   date. Vendored verbatim from deja-vu (MIT).
├── registry.extras.js    # +3 harnesses we added (ChatGPT export, Claude web export,
│                         #   Windsurf detect-only) and paths we deliberately skip.
├── package.json          # "type": "module", scoped to this folder. No dependencies.
│
├── lib/                  # Pure helpers. No filesystem policy, no agent knowledge.
│   ├── expand.js         #   Path templates -> concrete paths. Balanced-brace parser for
│   │                     #     ${A:-${B:-fallback}}, %APPDATA%, ~, and multi-valued
│   │                     #     placeholders (<vscode-User>, <app data>) that fan out.
│   │                     #     globStorePaths() + walkFiles() (dotfile-aware).
│   ├── text.js           #   Message content extraction. Flattens every content-block
│   │                     #     dialect (Anthropic, OpenAI, Gemini, pi) to text + tool
│   │                     #     calls. deriveTitle() for sidebar labels.
│   ├── normalize.js      #   The unified schema. makeMessage, finalizeSession (merge
│   │                     #     consecutive same-role turns, drop tool bodies, sort,
│   │                     #     count, title), tolerant toEpochMs, projectFromEncodedDir.
│   ├── redact.js         #   Secret redaction. 29 pattern kinds + an opt-in entropy pass.
│   │                     #     Replaces values, keeps structure. See the Redaction section.
│   ├── digest.js         #   The bounded, ordered digest of one conversation plus the
│   │                     #     project context it touched. See the Digest section.
│   └── project.js        #   Deterministic, read-only repository inspection: tree, docs,
│                         #     manifests, git history. Bounded and never reads source.
│
├── readers/              # One file per STORAGE FAMILY, not per agent. 36 agents are
│   │                     #   covered by 6 readers because forks share a format.
│   ├── index.js          #   Dispatch: extension + format_kind -> reader. Handles .zst
│   │                     #     decompression, size guard, index-file skip.
│   ├── jsonl.js          #   The workhorse. Sniffs the record shape and routes:
│   │                     #     pi | claude | codex-rollout | codex-history |
│   │                     #     antigravity | gemini | copilot-cli (dotted events) |
│   │                     #     deepseek (slashed events) | grok-acp (chunked stream) |
│   │                     #     vscode-chat-log | generic
│   ├── json.js           #   Continue, Cline family, VS Code chat sessions (incl. the
│   │                     #     append-only storage op-log decoder), Gemini, Amp threads.
│   ├── sqlite.js         #   Heuristic SQLite reader: Cursor's `cursorDiskKV` bubble
│   │                     #     format + a generic message-table finder. Also runs `.sql`
│   │                     #     fixture dumps in memory.
│   ├── markdown.js       #   aider's `.aider.chat.history.md`.
│   └── exports.js        #   Official "Export data" files: ChatGPT conversations.json
│                         #     (walks the branch tree) and Claude conversations.jsonl.
│
├── test/
│   ├── redact.test.js    #   72 assertions over redact.js. 36 of them assert that benign
│   │                     #     text is NOT touched — the false positives matter more.
│   ├── digest.test.js    #   24 assertions over the digest, run against a synthetic
│   │                     #     project in a temp dir with a real git repo.
│   └── mock-vscode-chat.js  #  Generates a byte-faithful VS Code chat operation log and
│                         #     asserts the decoder. Doubles as a reference for the format.
│
└── fixtures/             # 33 dirs / 54 files / 584 KB — real sample stores from deja-vu.
    ├── aider/.aider.chat.history.md
    ├── claude-code/session.jsonl
    ├── cursor/projects/.../registry-cursor.jsonl
    ├── opencode/opencode.sql
    └── ...                 Used by `npm run scan:fixtures` and by parser tests.
```

### How a scan flows

```
registry.json (36 harnesses, path templates)
      │
      ├─ lib/expand.js ──── expand ${VARS}, ~, <vscode-User> fan-out, then glob
      │                     (files only; dotfiles handled by walkFiles)
      ▼
  concrete file list  ────► readers/index.js ──┬─► jsonl.js   (shape sniffing)
                                              ├─► json.js    (JSON dialects + VS Code op-log)
                                              ├─► sqlite.js  (readOnly, heuristic)
                                              ├─► markdown.js
                                              └─► exports.js
      │
      ▼
  lib/text.js + lib/normalize.js ──► UnifiedSession
      │
      ▼
  detect.js: dedupe, sort by recency, cap per harness, mark quizReady
      │
      ├─► index.js list()       → sidebar: harness groups + session summaries
      ├─► index.js quizPayload()→ toQuizPayload() trims to a budget
      │                           then lib/redact.js scrubs secrets
      │                           → { payload, redaction }
      ├─► index.js digest()     → lib/digest.js compresses the conversation and adds
      │                           lib/project.js context, focused on what it touched
      │                           → { text, sections, stats }
      └─► ipc.js                → renderer
```

### The unified schema

Everything downstream — the sidebar and the Gemini prompt — only ever sees this shape, so
adding an agent never touches app code.

```js
Session {
  id: "pi:01a0ba10-6cbc-73c1-accf-0141842c6579"   // "<harness>:<native-id>"
  nativeId, harness, harnessName,
  project: "home/dev/code/myapp",                  // human-readable label
  cwd?, title,
  path,                                            // source file on disk
  source: "file" | "sqlite" | "vscode",
  started, updated,                                // epoch ms
  messages: [{
    role: "user" | "assistant" | "system" | "tool",
    text,                                          // answer text only, NOT reasoning
    ts?, tools?: [{ name, input }],                // tool *results* dropped as noise
    thinkingChars?                                 // reasoning dropped from this turn
  }],
  userTurns, chars,
  toolCalls,        // invocations, from assistant turns
  toolResults,      // bodies dropped
  reasoningChars,   // total reasoning dropped from the session
  partial?          // parsed, but some turns undecodable
}
```

---

## Fixture mode

`npm run scan:fixtures` points every harness at the bundled sample stores instead of the
live ones, which gets **33/36 harnesses to produce a session in under 50 ms** on a machine
where only three agents are actually installed.

Use it to:

- **Demo coverage** without installing 33 agents. Say "we support 36, here is the evidence"
  and show the table. Be honest that these are upstream sample stores, not the judge's.
- **Test a parser** without touching your real history: drop a file into
  `fixtures/<harness-id>/` and re-run.
- **Catch regressions** when a tool changes its format — the upstream fixtures were captured
  next to a `last_verified` date per harness.

No fixture directory is read during a real scan. Fixture mode is opt-in and labelled
`fixture: true` in every report row.

---

## The digest

`lib/digest.js` answers "what does a model actually get to see". It exists because raw
truncation does not work: measured, a flat 24k budget covered **11 of 724 messages** in a
large session, so nothing about how the work ended was answerable. The digest is the bounded,
ordered replacement.

```
                 median session    largest session
raw chars              64,961          2,471,294
digest chars           23,781             23,782
ratio                     2x                104x
```

**The ordering principle: the conversation is primary and it decides what project material
is included.** Repository contents are not interesting in themselves — they are interesting
where they explain what was discussed. So the project half is filtered to what the
conversation touched: the files named in tool calls, the subtree containing them, the
README, the manifest, and the commits made during the session window.

Structure of the output:

| Section | Contents |
|---|---|
| header | agent, project, span, turn and tool counts, and an honest account of what was omitted |
| `## Conversation` | one block per turn, `[turn N]` indexed into `session.messages` so generated questions can cite `sourceRefs.messageIndex` |
| `## Project context` | touched files, git, manifests, README excerpt, structure tree, loose signals |

Per-turn budgets: user turns **verbatim** (4,000 chars — they carry the task), assistant turns
700 chars, and the **final assistant turn 3,000**, because the closing summary is the most
quiz-worthy text in a session. Fenced code blocks are kept separately so fill-in-the-blank
questions have something to work from.

Everything is **deterministic**: no model call, no cost, no hallucination, and stable enough
to cache and diff. It is also the natural cache key for a generated quiz, because the same
conversation always produces the same digest.

### What is deliberately never included

| Excluded | Where it is dropped | Why |
|---|---|---|
| reasoning / thinking blocks | `lib/text.js` → `contentToParts()` | **47% of all session bytes.** Excluded at parse time rather than in the digest so no future code path can forget. The count is reported as `reasoningChars`. |
| tool output bodies | `lib/text.js` + `lib/normalize.js` | The bulk of what remains. A quiz should not ask about a directory listing. Only tool *names* and *arguments* survive, which is where the file paths come from. |
| source file contents | `lib/project.js` | Only documentation and manifests are ever read, from a fixed allowlist. A digest must not become a way to exfiltrate a source tree. |

Together these are why sessions shrank from a 556,396-char median to 64,961.

### Budget rules

Budget is **reserved in priority order under one hard ceiling**, not handed out
first-come-first-served. This matters: the project section is emitted last, so a naive
total-budget cut deleted it entirely and the model lost all context about what the project
was. Order is header → project (capped at half the remainder) → conversation.

The conversation then loses its **middle**, keeping the head (what was asked) and the tail
(what was concluded and changed) with an explicit marker recording what was dropped.

```
node cli.js --digest <session-id>            # print the digest
node cli.js --digest <id> --no-project       # conversation only
node cli.js --digest <id> --digest-budget 8000
```

### Safety

`lib/project.js` is the only part of the app that reads files the user did not explicitly
hand over, so: git is invoked with `execFileSync` and an **argument array, never a shell**,
with a 4 s timeout, so a path containing shell metacharacters cannot become a command. Every
directory walk is bounded in depth and entry count, every read is byte-capped, and a
separate test asserts that building a digest leaves `git status` byte-identical.

## Redaction

`lib/redact.js` is the one thing standing between a private transcript and a third-party
model, and it is called from `quizPayload()` — the single function that produces the object
sent to Gemini.

Two rules: **replace the value, keep the shape** (`postgres://app:[redacted:password]@db:5432/app` —
the topology is often the quiz-worthy part), and **never touch something benign**. Agent
transcripts are full of git SHAs, UUIDs, file paths and type annotations, so over-redaction
is treated as a bug, not a safe default. 36 of the 72 test assertions assert byte-identical
output.

| Pass | Default | Catches |
|---|---|---|
| patterns | on | 29 kinds: private keys, JWTs, bearer tokens, 19 provider token formats, credentials in URLs, `.env` lines, keyword-labelled values, prose |
| entropy | **off** | unlabelled random tokens ≥ 32 chars |

Entropy is off because it was measured on real transcripts and produced more false positives
than true ones — filenames, Next.js build IDs, PDF font names, markdown anchors, host key
fingerprints and `sk-ssh-ed25519@openssh.com`. All of those are pinned as regression tests.
Opt in per call with `{ entropy: true }`.

Measured with patterns on: **646 findings across 48 sessions** — 105 credentials in
connection strings, 194 `.env` lines, 277 keyword-labelled values, 22 JWTs, 10 private key
blocks, 3 webhook URLs. Residual false positives are confined to docs that literally contain
pattern examples, `os.environ.get("X")` references, and minified JS.

See [`../docs/quiz-design.md`](../docs/quiz-design.md) §1 for the full rationale and the
list of false-positive classes.

## Known limitations

- **Windsurf Cascade is reported but not decoded.** Protobuf with no public schema.
- **Zed threads are Zstd-compressed JSON in SQLite.** Detected and opened; message
  extraction depends on the generic table finder and may be partial.
- **Cursor's format is reverse-engineered and shifts between releases.** The
  `cursorDiskKV` bubble decoder is heuristic, and a Cursor major version can break it.
- **Claude Code auto-purges history** (`cleanupPeriodDays`, default 30), so old sessions
  may simply no longer be on disk. The app should show "3 of 7 tools detected" rather than
  `0` and let the user export first.
- **Copilot Chat creates a session file when the panel opens, before any messages exist.**
  Those parse to zero sessions by design and are counted separately as `empty`, not as
  failures.
- **`node:sqlite` availability varies by Electron version.** If absent, every SQLite store
  degrades to a clearly-labelled `partial` placeholder instead of throwing.
- **Vision input is not extracted.** Images referenced in a transcript are skipped; only
  text and tool names reach the payload.
- **Tool output is excluded by default.** Measured at 98% of the bytes in a coding session,
  it is almost never what a quiz should ask about, so `finalizeSession` drops the bodies and
  keeps a `toolCalls` count. Pass `{ keepToolOutput: true }` to retain them.
- **Redaction is pattern-based, so it cannot catch everything.** A secret with no recognisable
  shape and no secret-ish keyword will get through with the entropy pass off. It raises the
  cost of an accident; it is not a guarantee.

## A note on the privacy story

This layer reads other tools' private conversation stores. Two deliberate choices:

1. **Read-only.** Stores are opened `readOnly`; nothing is written, renamed or deleted.
   SQLite is opened with `{ readOnly: true }` so a concurrent agent cannot be corrupted.
2. **Local only.** No network calls exist anywhere in this folder. `quizPayload()` is the
   single, auditable place where a conversation is trimmed, bounded **and redacted** before
   it leaves the machine — which is why both live in that one function rather than in the
   caller.
