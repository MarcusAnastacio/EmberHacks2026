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
npm run docs:example             # regenerate docs/example-digest.md
npm run models                   # which Gemini models this key can reach

# requires GEMINI_API_KEY (see Setup)
npm run quiz -- <session-id> --questions 6 --types mcq,cloze,open
npm run quiz -- <id> --plan --questions 6      # plan only, no API call
npm run compat                   # sweep every bundled fixture format, no installs

node cli.js --show <session-id>          # inspect one normalized session
node cli.js --digest <session-id>        # the bounded conversation + project digest
node cli.js --topics <session-id>        # deterministic topic table
node cli.js --topics <id> --slice 2      # one bounded topic slice
node cli.js --payload <session-id>       # the redacted JSON handed to Gemini
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
│   ├── topics.js         #   Deterministic topic segmentation and bounded per-topic
│   │                     #     slices. No model call. See the Topics section.
│   ├── quiz.js           #   Quiz planning, the Gemini response schema, validation of
│   │                     #     what comes back, and generation. See Quiz generation.
│   └── gemini.js         #   The API client: model fallback chain, retries, timeouts,
│                         #     key resolution. No SDK, no dependencies.
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
├── docs/
│   ├── example-digest.md    #  A worked digest with the process that derived it,
│   │                        #    regenerable via `npm run docs:example`.
│   └── generate-example.js  #  Builds a synthetic project + session and writes it.
│
├── test/
│   ├── windows.test.js   #   18 assertions covering the Windows path rules, runnable on
│   │                     #     any platform because the platform is an input.
│   ├── readers.test.js   #   11 assertions over format routing and the per-format quirks
│   │                     #     that the sweep found. See Format compatibility.
│   ├── compat-sweep.js   #   `npm run compat`: every fixture format through the full
│   │                     #     path. The tool that found five silent parser bugs.
│   ├── redact.test.js    #   72 assertions over redact.js. 36 of them assert that benign
│   │                     #     text is NOT touched — the false positives matter more.
│   ├── topics.test.js    #   15 assertions over topic segmentation and slice bounds.
│   ├── quiz.test.js      #   28 assertions over planning, schema and validation, plus
│   │                     #     the API client with globalThis.fetch stubbed.
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
      ├─► index.js topics()     → lib/topics.js segments deterministically and caps
      │                           each slice → { topics, slices, stats }
      └─► index.js generateQuiz()→ lib/quiz.js plans, then one bounded call per topic
                                  via lib/gemini.js → { flashcards, questions }
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

## Format compatibility

You do not need the tools installed to test them. `fixtures/` holds real sample stores
from 33 agents, so the whole path — reader → normalize → topics → digest → plan — can be
run against every format:

```bash
npm run compat
```

```
FORMAT                        SESS  PH  MSGS  CHARS  USER  TOPICS  PLAN  DIGEST
Claude Code                      1   0     2     64     1       1     1     603
Codex CLI                        1   0     2     42     1       1     1     598
Cursor                           1   0     2    197     1       1     1     490
aider                            1   0     2     59     1       1     1     552
...
readable conversation (user + assistant): 30/36
no fixture at all:        chatgpt, claude-web, windsurf
detected, not decoded:    crush, opencode, zed
```

**30 of 36 formats produce a readable conversation.** The other six are honest rather than
broken: three have no fixture at all (they are export files or a protobuf store we
documented as detect-only), and three keep message text in a sibling table
(`part`, `blocks`) that the generic SQLite reader does not join — those report as
detected-but-not-decoded rather than pretending to work.

### Five silent bugs the sweep found

Each of these had the format listed as supported while half its conversation was being
discarded. None of them would have shown up as an error.

| Bug | Effect |
|---|---|
| Cursor's `format_kind` is `sqlite-kv-or-jsonl`, and a kind starting with `sqlite` routed its `.jsonl` agent transcripts to the SQLite reader | Cursor produced a placeholder instead of a conversation. Routing now prefers the file extension over the declared kind. |
| aider marks the **user's** input with `#### ` (from its own writer: `prefix = "####"`), and the reader treated that as assistant prose | **Every user turn in every aider session was discarded** — the assistant appeared to answer questions that were not there. |
| Antigravity puts the speaker in `source` with values `USER_EXPLICIT` / `MODEL`; only `MODEL` matched a known role | Every Antigravity user turn dropped. Also strips the `<USER_REQUEST>` / `<ADDITIONAL_METADATA>` wrappers and reads `cwd` out of the metadata. |
| The Gemini CLI types assistant turns as `"type": "gemini"` with top-level `content`, and shape detection fell through to the generic extractor | Only the user's half of every Gemini session survived. |
| Kimi streams the answer as `context.append_loop_event` → `event.part`, which nothing handled | An entire Kimi session read as the user talking to themselves. `part.type` of `think` is now counted as dropped reasoning, not kept as answer text. |

The last is worth emphasising: `think` is Kimi's spelling of a reasoning part, and it was
not in the list of reasoning kinds — so it would have been sent to the model. That is the
exact failure the reasoning exclusion exists to prevent, and it took a format sweep to
find it.

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

## Topics

`lib/topics.js` divides a conversation into topics and produces one **bounded** prompt
body per topic. It calls no model, so the whole pipeline is deterministic and the last
unbounded prompt is removed.

**A user turn is a topic statement.** Nothing a model writes is a better label for
"why is the connection pool exhausted" than the user's own words, so labels are the
opening user turn of each segment, trimmed at a word boundary. `summary` keeps 400
characters of it verbatim.

Boundaries are scored between consecutive exchanges — one user turn plus everything up
to the next:

| Signal | Weight | Reasoning |
|---|---|---|
| file-set change | 3 | the strongest available evidence that the subject moved |
| word overlap drop between consecutive user turns | 2 | the user stopped talking about the same thing |
| pause > 30 min / > 120 min | 1.5 / 3 | a deliberate gap usually means a new intent |
| transition marker (`separately`, `now`, `next`, …) | 1 | and some are explicit |
| a follow-up under 24 characters | −2 | "ok", "yes" do not start topics |

Those cuts are semantic, and on a long session they are not enough on their own: a
session that needs sixty topics to stay small will not fit fourteen, and merging the
weakest boundaries produces one 736k-character topic against a 130k median which is
then truncated anyway. So after semantic cutting, oversized segments are **split** at
their strongest internal boundary, and every candidate is **ranked** by a deterministic
quiz-value score — files edited, code blocks, error mentions, substance of the
back-and-forth, size on a log scale. The top `maxTopics` are kept, in chronological
order, and anything too small is folded into its neighbour **unless a strong cut
precedes it** (a short topic the user explicitly moved to is still a topic).

```bash
npm run topics -- <session-id>                  # the topic table
npm run topics -- <id> --slices --slice-chars 8000
npm run topics -- <id> --slice 2                # print one bounded slice
```

### What a slice contains, and why

Topics start on **user turns**, so a slice taken literally would open with an assistant
reply whose question is out of view. Measured on a 2.4M-character session, that produced
questions phrased as continuations — five of nine opened *"Based on the evaluation of…"* or
*"Following the updates to…"*: grounded and answerable given the excerpt, but written as
continuations because that is genuinely what the model was shown.

A slice is therefore three parts, and the context shares the same `maxChars` budget rather
than sitting outside it:

```
--- PRECEDING CONTEXT (background from earlier in the same session; not part of this topic) ---
[turn 165] USER (earlier)        <- the question
[turn 167] ASSISTANT (earlier)   <- and the answer it got
--- TOPIC: <label> (turns 184-201) ---
[turn 184] USER ...
```

Both halves of the prior exchange matter: with only the assistant turn the model sees an
answer to a question it cannot see, which reads as a dangling fragment. The prompt also
tells the model which section is which and requires every question to be understandable on
its own — no "as discussed", no "the above", no unnamed "it". That took continuation
phrasing from 5 of 9 to 1 of 9.

### Measured size distribution

376 topics derived from 49 real sessions. Everything is inside its bound, and the bounds
are enforced rather than hoped for:

```
           n      p25      p50      p75      p90      p99      max
TOPIC    376     7283    13944    22061    27504    29868    29988   target 30000
SLICE    376     6688    10803    11957    11958    11958    11958   cap    12000
PROMPT   376     9988    14103    15257    15258    15258    15258   = slice + ~3300
```

**Prompt: 15,258 characters maximum (~3,800 tokens).** That is the number that matters, and
it is a cap rather than a distribution tail — p75 upward is flat against it, because the
prompt is `min(slice, 12,000) + fixed instructions`.

The topic column is the interesting one. Topics are *targeted* at 30,000 and were **not**
bounded before: the maximum was 57,885, and 8 topics (2.1%) exceeded the target — meaning
their slices showed the model only 20% of what they contained.

### Splitting below the exchange level

The 8 oversized topics were not blocked by the user/assistant distinction. They were blocked
because splitting only considered *exchange* boundaries:

| topic | exchanges | messages | largest message |
|---|---|---|---|
| 57,885 | 1 | 2 | **52,745** ← one message |
| 41,861 | 6 | 16 | 8,116 |
| 36,801 | 4 | 11 | 21,589 |
| 32,758 | 3 | 8 | 13,025 |

A segment with one exchange has no internal exchange boundary, so a long autonomous agent
run after a single short prompt — one user turn and fifty agent turns — was **unsplittable
however large it grew**. That is precisely the shape of the work this project is about.

Splitting now happens at three levels, in order:

1. **exchange boundaries** — semantic, scored (file change, word overlap, pause, markers)
2. **message boundaries** — a size fallback, for segments with no internal exchange boundary
3. **character ranges within one message** — for a message that is itself over the target,
   cut at a line or sentence boundary so the pieces read as prose

Pieces from levels 2 and 3 are marked `subSplit: true`, and a piece that does not open on a
user turn sets `agentLabel: true` so the UI knows the label came from the assistant rather
than from the user's own words. `messageRanges` may repeat a message index for two adjacent
pieces of one message; `charFrom`/`charTo` say which part each owns, and
`sourceRefs.messageIndex` stays valid because it names the containing turn.

Result: **0 topics over target, max 29,988** (was 57,885), with 10 sub-split topics selected
of which 4 are intra-message.

Two bugs the split introduced and the tests caught: every piece of one message shares that
message's index, so sorting by index alone shuffled them (the character offset is now the
tiebreaker), and folding a small fragment into its neighbour could push the neighbour back
over the target, undoing the split.

### The bounds

| Stage | Bound | Default |
|---|---|---|
| digest | `budget.total`, plus a `hardMax` backstop | 24,000 chars |
| topic count | `maxTopics` | 14 |
| **each generation prompt** | `topicSlice({ maxChars })` | 12,000 chars |
| total prompt material | `maxTopics × maxChars` | 168,000 chars over ≤14 calls |

That last row is the point this design exists to make. Session size no longer reaches
the model: a 2.4M-character session and a 500k-character session both produce ceilings
of 12,000 per request. Measured across 48 real sessions:

| session chars | candidates | selected | dropped | coverage | median topic | largest slice |
|---|---|---|---|---|---|---|
| 2,471,294 | 168 | 14 | 154 | 16% | 29k | 12,037 |
| 1,845,992 | 164 | 14 | 150 | 17% | 20k | 12,038 |
| 854,640 | 96 | 14 | 82 | 31% | 19k | 12,038 |
| 543,839 | 63 | 14 | 49 | 49% | 23k | 12,038 |
| 539,962 | 48 | 14 | 34 | 53% | 18k | 12,038 |

Read the coverage column honestly: a 2.4M-character session **cannot** be represented
by fourteen bounded prompts, so 84% of it is never asked about. That is a real
limitation, not a tuning problem — the cap trades coverage for a bounded number of
requests. `stats.coverage`, `droppedTopics` and `droppedChars` exist so the caller can
see the trade and raise `maxTopics` when a session is worth more questions.

For a worked example of the whole pipeline with the process spelled out, see
[`docs/example-digest.md`](docs/example-digest.md). It is generated by
`npm run docs:example` from a synthetic project and session, so it contains nothing
private and cannot go stale.

## Windows

Supported, and **testable from Linux or macOS**: the platform is an input to the path
layer rather than an ambient fact, so every Windows rule is reachable from a test.

```js
platformContext({ platform: 'win32', home: 'C:/Users/dev', env: { APPDATA: '...' } })
```

That refactor is the point. Code reading `process.platform` directly cannot be verified
without a Windows machine, and none of the Windows rules below would have been checked.

### What differs, per platform

| | Windows | macOS | Linux |
|---|---|---|---|
| editor data root | `%APPDATA%` | `~/Library/Application Support` | `$XDG_CONFIG_HOME` or `~/.config` |
| home | `%USERPROFILE%`, or `%HOMEDRIVE%%HOMEPATH%` | `$HOME` | `$HOME` |
| separators | both accepted; all output normalised to `/` | `/` | `/` |
| case | **insensitive** | sensitive | sensitive |

`<vscode-User>` therefore resolves to the right place on all three, and fans out over
VS Code, Insiders, VSCodium, Cursor, Windsurf, Trae and PearAI on each.

### The bugs this fixed

| Bug | Effect |
|---|---|
| `new URL(import.meta.url).pathname` yields `/C:/Users/...` on Windows | Any filesystem call using it failed. Six call sites, including `FIXTURE_ROOT` and the `.env` lookup. Now `fileURLToPath`. |
| Tool-reported paths were compared with `p.startsWith(cwd)` and exact string equality | Windows tool calls arrive as `C:\proj\src\db.ts`, so **no file was ever recognised as touched** — an empty "files modified" list and a project section with nothing to focus on. |
| Windows is case-insensitive and matching was not | `C:\Proj\Src\db.ts` and `c:\proj\src\db.ts` are one file; exact matching treated them as two. |
| UNC paths (`\\server\share\x.ts`) had their leading slashes stripped before the absolute check | `\\server\share\proj\x.ts` became the *relative* path `server/share/proj/x.ts` inside the project. |
| Cursor and Goose declared macOS and Linux stores only | On Windows both live under `%APPDATA%` and neither was found. Added via `EXTRA_STORE_PATHS`, **merged into the existing entry** so the sidebar does not show two rows with the same name. |

### Paths are normalised to forward slashes everywhere

Including on Windows. Windows accepts `/` in every filesystem call, whereas a glob
pattern containing a backslash is ambiguous — minimatch reads it as an escape — so a
mixed-separator pattern is the risky form. A test asserts that no harness produces a
backslash in any pattern on Windows.

### Testing it

```bash
npm test          # includes test/windows.test.js — 18 assertions, runs anywhere
```

The suite covers the per-platform data roots, `%APPDATA%` and `%LOCALAPPDATA%`,
`${VAR:-default}` including the nested form Cline uses, `~`, `<app data>`, backslash and
drive-letter paths, case-insensitive matching, UNC rejection, and that an absolute path
outside the working directory is refused rather than silently made relative.

## Quiz generation

The product workflow: the conversation is split into topics **deterministically**
(`lib/topics.js`), a random subset of those topics is chosen for the requested size, and
every chosen topic yields **2 flashcards** and **1 question per enabled type**. Flashcards
are not optional — the user learns the prerequisite knowledge first — so they are produced
even when no question types are selected and the result is a pure flashcard deck.

```
questions = 6, types = [mcq, cloze, open]
    → topics = ceil(6 / 3) = 2
    → 2 topics × 2 flashcards               = 4 flashcards
    → 2 topics × 1 question per type        = 6 questions
```

Topic count is derived from the request, so the user's "number of questions" drives the
work rather than a fixed topic count. With `types = [mcq]`, six questions means six topics.

```bash
npm run quiz -- <session-id> --questions 6 --types mcq,cloze,open
npm run quiz -- <session-id> --plan --questions 6      # offline, no API call
npm run quiz -- <session-id> --questions 4 --types mcq --seed 42   # reproducible
npm run quiz -- <session-id> --questions 6 --out quiz.json
```

### The readiness gate

A real session containing only "hi" passed the old turn-count check and produced a
flashcard and a question about nothing. A conversation is now assessed before anything is
generated, at two levels — the session, and each topic inside it:

| Floor | Value | Why |
|---|---|---|
| user turns | 1 | a session with no human turn is not a conversation |
| session characters | 400 | cheap early guard |
| topic characters | 700 | two flashcards and a question need something to work from |
| topic characters, per type | +250 each | a topic must carry one question of each requested type |

Calibration is the interesting part. Requiring **two** user turns refused four real
sessions of 4k–8k characters that happened to be a single long question with a long answer
— perfectly quizzable work. On the real history of 49 sessions, the rule above refuses
**3**: "hi" at 56 characters, and two sessions of 508 and 702 characters that genuinely
cannot support two flashcards and three questions. 46 pass.

`assessReadiness()` returns **reasons**, not a boolean, so the UI can say *"only 1 user
turn, need 2; only 34 characters, need 400"* rather than greying something out silently.
`generateQuiz` refuses without calling the model, and thin topics are dropped from the plan
and counted in `droppedThinTopics`.

### Frontend contract

`quizCapabilities()` returns everything the settings UI needs, so no option label, bound
or type name is hardcoded in two places:

```js
{
  requiresApiKey: false,                       // never the key itself
  questionCount: { min: 1, max: 42, default: 6, step: 1 },
  types: [
    { id: 'mcq',   label: 'Multiple choice',     needsGrading: false, default: true },
    { id: 'cloze', label: 'Fill in the blanks',  needsGrading: false, default: true },
    { id: 'open',  label: 'Open-ended',          needsGrading: true,  default: true },
  ],
  flashcards: { always: true, perTopic: 2 },
  ceiling: (types) => 14 * max(1, types.length) // topics x types is the hard ceiling
}
```

`ceiling(types)` exists because one question per topic per type makes `topics × types` a
hard limit, so the question-count control should clamp against the selected types rather
than let the user ask for 40 and silently receive 6.

### Prompt size

Measured, the prompt is **~3,300 characters of fixed instruction plus the slice**, and the
slice is capped at `maxCharsPerTopic` (12,000):

| session chars | slice chars (median) | prompt chars (median) |
|---|---|---|
| 2,471,294 | 11,957 | 15,280 |
| 1,845,992 | 11,957 | 15,295 |
| 854,640 | 11,957 | 15,290 |
| 508 | 1,127 | 4,451 |

So a prompt is ~15,000 characters (~3,800 tokens) and near-constant: it tracks the **cap**,
not the session. That is the property that makes the cost predictable.

### Setup

`GEMINI_API_KEY` is read from the environment, then from a gitignored `.env` at the
repository root or in `electron-app/`. `.env.example` has the shape. The key is never
logged, never written to a generated file, and never included in an error message — there
is a test asserting exactly that.

### The Gemini request

**One call per selected topic, in parallel, each bounded by `maxCharsPerTopic`.** Not one
call over the session, which is the unbounded prompt this whole design exists to avoid.
One malformed response costs one topic instead of the entire quiz, and the topics generate
concurrently so latency does not scale with topic count.

### Response schema: every conditional field is required

The schema is flat with a `type` enum rather than a `oneOf` union, because Gemini's
`responseSchema` handles `oneOf` poorly. The non-obvious part, and the reason this section
exists:

> **`correctOptionKey` must be `required`, not `nullable`.** With it optional, Gemini
> returned multiple-choice questions **with the answer missing** — the schema happily
> omits a non-required nullable field. There is no way to express "required only when
> `type` is mcq", so every conditional field is required and non-applicable ones are
> filled with empty sentinels (an empty string, an empty array).

`validateResult()` then enforces what the schema cannot: an mcq whose `correctOptionKey`
matches no option is **dropped with a reason** rather than shipped broken, as is a cloze
with no `{{blank_N}}`, a cloze whose gap has no answer, and an open question with no
rubric. `quiz.problems` reports every drop.

**Question ids are minted by the code, not taken from the model.** The model numbers its
own questions per topic, so the first real run produced `q1` twice and a score keyed by
question id would have overwritten the wrong answer. Ids are now
`<topicId>-<type>-<n>` — unique, and stable across regenerations of the same topic.

### Model fallback

A single hardcoded model is a demo that works until it doesn't. Measured while building
this: `gemini-3.5/3.6/3.7/3.8-flash` all returned **503 "high demand"**, and
`gemini-2.5-flash` returned **404 "no longer available to new users"**. So requests walk a
chain — `gemini-3.8-flash → 3.6 → 3.5 → 3.1-flash-lite` — retrying 429/5xx with backoff and
skipping straight past a 404, which will never succeed on retry. Override with
`GEMINI_MODEL` or `--model`. `quiz.model` reports which models actually served the request,
and `quiz.usage.attempts` counts every try.

### Measured on a real session

```
questions = 6, types = [mcq, cloze, open], 2 topics
  → 4 flashcards, 6 questions (2 mcq, 2 cloze, 2 open)
  → 31.5 s, 10,735 tokens, 2 calls, 0 validation problems
  → served by gemini-3.6-flash
```

An earlier run during the 503 window took 17 attempts across 3 topics and still returned a
complete, valid quiz by falling through to `gemini-3.1-flash-lite`.

### The hard ceiling on questions

With one question per topic per type, `topics × types` is a hard ceiling. A session with
6 topics and `types = [mcq]` cannot produce more than 6 questions however many are asked
for. Rather than duplicating a (topic, type) pair — which contradicts "one main question
per topic" — the count is capped and `plan.shortfall` reports the difference so the UI can
say so.

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
- **Windows is not verified on real hardware.** The path rules are unit-tested with an
  injected platform context, which covers expansion and matching, but nothing has run
  against an actual Windows filesystem or a real Windows agent store.
- **Three formats are detected but not decoded** (`opencode`, `crush`, `zed`): their
  message text lives in a sibling SQLite table the generic reader does not join. The store
  is reported in the sidebar rather than hidden, but no conversation comes out of it.
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
