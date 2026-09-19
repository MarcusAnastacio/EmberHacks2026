# Quiz generation — design notes

Working notes on the four open questions: the Gemini response schema, storing generated
quizzes, redaction, and how a conversation gets into the model at all.

Everything below labelled **measured** comes from running against a real history of 48
sessions from three agents on one machine. The numbers are what changed my mind about
several of these designs, so they are included rather than asserted.

| | |
|---|---|
| **Status** | §1 redaction is built and tested. §2–§4 are proposals. |
| **Code** | redaction: `backend/lib/redact.js` · payload assembly: `backend/detect.js` → `toQuizPayload()` |

---

## 1. Redaction — built

### The two rules

1. **Replace the value, keep the shape.**
   `DATABASE_URL=postgres://app:hunter2@db.internal:5432/app`
   → `DATABASE_URL=postgres://app:[redacted:password]@db.internal:5432/app`

   The topology is usually the quiz-worthy part ("what does this service connect to, and
   why was that the fix?"). Destroying it destroys the material, so credentials are
   stripped and everything around them survives. This is why the placeholder names the
   *kind* — it keeps the sentence readable and makes the report meaningful.

2. **Never touch something benign.** Agent transcripts are full of git SHAs, UUIDs, file
   paths, minified bundles and type annotations. A redactor that eats those makes the quiz
   worse, so over-redaction is treated as a bug and the negative test cases outnumber the
   positive ones. Current suite: **72 assertions, 36 of which assert byte-identical output.**

### Two passes

| Pass | Default | Catches | Notes |
|---|---|---|---|
| Shape / keyword patterns | **on** | 29 kinds: private keys, JWTs, bearer tokens, 19 provider token formats, credentials in URLs, `.env` lines, keyword-labelled values, prose | High confidence. Ordered most-specific-first; the first match claims its byte range so patterns never overlap. |
| Entropy heuristic | **off** | unlabelled random tokens ≥ 32 chars | Opt in with `{ entropy: true }`. |

**Entropy is off by default because it was measured.** Enabled, it produced more false
positives than true ones. Every one of these was observed in a real transcript and is now
pinned as a regression test:

- `sk-ssh-ed25519@openssh.com` — an SSH algorithm name, matched as an OpenAI key
- `NOPASSWD:` in a sudoers rule — matched inside `PASSWD`
- `token=function t(t,e,n,r){…}` — minified JavaScript, because the value class allowed `=`
- `api_key: 'str | httpx.URL | None' = None` — a type annotation captured as a value
- `sudo: a password is **required**` — the word "required" redacted
- `data-dpl-id="kJ8xQ2mZvB9pLrT4"` — a Next.js build ID, inside an HTML attribute
- markdown anchors, PDF font names, `SHA256:` host key fingerprints, `[redacted].py`

The fixes are specific — a negative lookahead for `sk-(?!ssh-|ecdsa-)`, `(?<![A-Za-z])`
before the keyword, excluding `=` from the value class, requiring prose values to start
alphanumeric, and an `isStructuralContext()` check that skips filenames, URL components,
markup and anchors. The entropy pass also requires a token whose longest run of letters is
under 14, which is what keeps `useStateManager2Provider` out.

With entropy off, **measured: 646 findings across 48 sessions — 105 credentials in
connection strings, 194 `.env` lines, 277 keyword-labelled values, 22 JWTs, 10 private key
blocks, 3 webhook URLs, 7 Google API keys, 8 HuggingFace tokens.** Spot-checking the
unique lines, most are unambiguous secrets. The residual false-positive rate is
concentrated in three narrow classes, all of which are safe to over-redact:

- Documentation that literally contains pattern examples (`scheme://user:pass@host`),
  including this project's own READMEs — which then appear in transcripts.
- References rather than values: `os.environ.get("GROQ_API_KEY")`, `config.secrets.openai`
- Minified JS bundles

### Where it runs

`redactPayload()` is called from `CompatibilityLayer.quizPayload()`, which is the single
function that produces the object handed to Gemini. `toQuizPayload()` trims, `redact()`
scrubs, and the UI shows the report (`1 secret redacted before sending —
huggingface-token ×1`). The caller's session is never mutated, so the app keeps a complete
local transcript while only the outgoing copy is scrubbed.

### Still to do

- **Redact at index time as well**, so the count appears in the sidebar before a quiz is
  generated and a session that is never sent still reports what it contains.
- **A per-session toggle** in the UI. `payload({ id, entropy: true })` already threads
  through; it needs a switch and a warning that it will over-redact.
- **Redact tool output too** once tool bodies are optionally included (§2).
- The kind label is deliberately coarse. `[redacted:labelled-secret]` for 277 findings
  hides useful detail; splitting into `api-key` / `password` / `token` by keyword would
  make the report more legible.

---

## 2. Getting a conversation into Gemini — the context problem

### Measured: naive truncation does not work

Current behaviour is a flat budget: cap each message at 4,000 chars, stop at 24,000 total.
Measured against the real history:

| | |
|---|---|
| Sessions | 48 |
| Median session | **286,373 chars** (~72k tokens) |
| Largest session | **7,756,258 chars** (~1.9M tokens) — **larger than Gemini's 1M-token window** |
| Assistant text as a share of characters | **98%** |
| User turns as a share of characters | **2–5%** |
| Tool calls | **32,674** |
| Payloads that fit 24k without truncation | **14 / 48** |
| Messages covered by a 24k payload in the largest session | **11 of 724 (1.5%)** |

Two conclusions:

1. **A 24k budget shows the model 1.5% of a large session.** It sees the opening prompt and
   the first couple of exchanges. Any question about how the work actually ended, or what
   went wrong in the middle, is unanswerable. Even a 1M-token window cannot hold the
   largest session.
2. **The bulk is not conversation.** Assistant *reasoning* — not user turns, not final
   answers — is ~98% of the bytes. That is the cheapest thing to compress and the least
   likely to be missed verbatim.

> Found while measuring this: pi writes tool results as `role: "toolResult"`, which
> `normalizeRole()` did not recognise, so it fell through to `assistant` and inline tool
> bodies — file dumps, directory listings, test logs — were treated as dialogue. Fixing
> that halved the median session (556,396 → 286,373 chars) and moved 32,674 tool calls
> from being inlined to being counted. Tool bodies are now excluded by default
> (`finalizeSession({ keepToolOutput })` opts back in).

### Recommendation: a three-stage pipeline, not one big call

**Stage A — build a deterministic digest. No model call.**

Because user turns are only 2–5% of the bytes, the entire narrative arc of a session fits
in a small, bounded string:

```
"[turn 12] USER: why is the connection pool exhausted?
 [turn 13] ASSISTANT (thinking, 4.1k chars omitted): ...
 [turn 14] TOOLS: Read(app/db.py), Grep(create_engine)
 [turn 15] ASSISTANT: Found it — db.py:41 opens a session per request
           but returns early on the error path without closing it.
 [turn 16] FILES: app/db.py
"
```

Rules: keep user turns **verbatim**; keep each assistant turn's first ~600 chars plus any
fenced code block; keep tool *names* with their arguments; drop tool output; collapse runs
of consecutive tool calls. This is pure code — no latency, no cost, no hallucination — and
it is ~10–20× smaller than the raw transcript while retaining the task statement, the
decisions, the errors and the outcome.

**Stage B — ask Gemini for a topic map over the digest.**

One cheap call, bounded input, structured output:

```json
{
  "topics": [
    { "label": "Diagnosing the connection leak",
      "summary": "Pool exhausted because each worker leaked sessions on the error path.",
      "messageRanges": [[12, 19], [24, 26]],
      "interestingness": 0.9,
      "hasCode": true }
  ]
}
```

`messageRanges` index into the **normalized message array**, not raw characters — the
readers already produce stable indices, which is what makes `sourceRefs` (§3) possible.

**Stage C — generate questions per topic, in parallel.**

Each topic's own slices become one bounded request: the digest lines for that topic, plus
the full text of the messages in its ranges, plus the neighbouring turns for context. Ask
for a fixed number of questions. Result: every request is small, every question is grounded
in a specific part of the transcript, and questions come from *different* topics by
construction rather than by hoping the model spreads out.

```
Stage A  digest         (no model)          ~10-20k chars
Stage B  1 call          topic map over digest   ~1 request,  bounded
Stage C  N parallel calls, one per topic    N requests, each bounded
```

### Why not a vector index

A vector DB is the obvious instinct for "exploring indexing methods", and it is the wrong
tool for a *single* conversation:

- A session has one coherent linear narrative. Retrieval destroys the ordering, and
  ordering is exactly what makes questions about "what did you try *before* that" possible.
- The digest above is already small enough to fit in one request. Retrieval is for corpora
  that do not fit; this one does.
- Embeddings cost a model call, add a dependency and a store, and give a similarity
  ordering that needs the same topic-labelling pass anyway.

**Where it does become the right tool** is cross-session mode — "quiz me on everything I
have learned about Postgres across 40 sessions". That is a corpus, retrieval is appropriate,
and the same normalized schema and `sourceRefs` carry over unchanged. Worth building as a
second mode, not as the foundation.

### Budget

| Stage | Input | Output |
|---|---|---|
| B — topic map | digest, ≤ 20k chars | ≤ 2k tokens |
| C — one topic | digest slice + full turns + neighbours, ≤ 30k chars | ≤ 4k tokens |
| Grading one open answer | question + rubric + answer, ≤ 4k chars | ≤ 500 tokens |

Reserve ~2k tokens for instructions and schema in every call. Prefer many small calls over
one large one: latency is parallelisable, and a single malformed response cannot lose the
whole quiz.

---

## 3. Structured response schema

### The constraint that shapes it

Gemini's `responseSchema` accepts an OpenAPI-subset, and **handles `oneOf`/`anyOf` poorly**.
A discriminated union of three question types is therefore fragile. Two workable options:

- **Flat object with a `type` enum** and every type-specific field optional. One call.
  Simple, but the model must be trusted to fill only the relevant fields — validate after.
- **One call per question type.** Cannot produce an invalid union, lets each prompt be
  tuned, and parallelises. Recommended: 3 parallel calls per topic, or one call per type
  across all topics.

Both are shown below; the flat schema is what I would ship first.

### The three question types

```
mcq    multiple choice            one correct option, plausible distractors
open   open-ended                 free text, graded by Gemini against a rubric
cloze  fill in the blank          code with gaps, `{{blank_1}}` markers
```

### Schema (flat, `type` as the discriminator)

```jsonc
{
  "type": "object",
  "properties": {
    "quizTitle": { "type": "string" },
    "questions": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id":        { "type": "string" },   // stable: "<topicSlug>-<type>-<n>"
          "type":      { "type": "string", "enum": ["mcq", "open", "cloze"] },
          "topic":     { "type": "string" },
          "difficulty":{ "type": "string", "enum": ["recall", "understand", "apply"] },
          "prompt":    { "type": "string" },

          // Provenance. This is the feature that makes it feel real, and it is
          // directly checkable because the payload carries message indices.
          "sourceRefs": {
            "type": "array",
            "items": { "type": "object", "properties": {
              "messageIndex": { "type": "integer" },
              "quote":        { "type": "string" }        // short, verbatim
            }, "required": ["messageIndex", "quote"] }
          },

          // mcq
          "options":         { "type": "array", "items": {
                               "type": "object",
                               "properties": { "key": {"type":"string"}, "text": {"type":"string"} },
                               "required": ["key", "text"] } },
          "correctOptionKey":{ "type": "string" },

          // open
          "rubric": { "type": "array", "items": {
                      "type": "object",
                      "properties": {
                        "criterion":   { "type": "string" },
                        "weight":      { "type": "number" },
                        "mustMention": { "type": "array", "items": { "type": "string" } }
                      },
                      "required": ["criterion", "weight"] } },
          "referenceAnswer": { "type": "string" },

          // cloze
          "language":    { "type": "string" },
          "codeWithGaps":{ "type": "string" },          // contains {{blank_1}}, {{blank_2}}
          "blanks": { "type": "array", "items": {
                      "type": "object",
                      "properties": {
                        "key":          { "type": "string" },   // "blank_1"
                        "answer":       { "type": "string" },
                        "alternatives": { "type": "array", "items": { "type": "string" } },
                        "explanation":  { "type": "string" }
                      },
                      "required": ["key", "answer"] } },

          // always
          "explanation": { "type": "string" }   // why the answer is right
        },
        "required": ["id", "type", "topic", "prompt", "explanation", "sourceRefs"]
      }
    }
  },
  "required": ["quizTitle", "questions"]
}
```

### Decisions worth arguing about

- **`sourceRefs` with a verbatim `quote`.** A question that cites "turn 41" and reproduces
  the sentence is verifiable by a human in one click. It is also the strongest possible
  evidence that Gemini reasoned over the transcript rather than pattern-matching a genre.
  Keep `quote` short (one sentence) and tolerate it not matching byte-for-byte — model
  quoting drifts; treat it as a locator hint, not a hash.
- **`correctOptionKey`, not a boolean per option.** A boolean invites two correct answers;
  a single key makes that unrepresentable.
- **`rubric` with weights, not a reference answer alone.** Grading needs to be
  reproducible. Weights plus `mustMention` let the judge produce per-criterion scores that
  add up, and let a half-right answer score half.
- **`alternatives` on cloze blanks.** `rows.Close()` vs `rows.close()` vs `defer
  rows.Close()` — a single accepted string makes the question unfair on trivia.
- **Stable `id`.** `<topicSlug>-<type>-<n>` is derived from the topic map, so regenerating
  a quiz produces the same ids for the same topics. That is what makes scores comparable
  across regenerations instead of accumulating orphans.
- **`difficulty`** answers only `recall | understand | apply`. Free-text difficulty is
  unactionable.
- **Do not ask for `hints` or `points`** in the first version. Both are easy to add later
  and neither is needed to prove the loop.

### Grading call for `open`

A separate, small call. Keep it independent of generation so a bad grader can be replaced
without regenerating quizzes.

```jsonc
// input:  { prompt, rubric[{criterion, weight, mustMention}], referenceAnswer, userAnswer }
// output:
{
  "type": "object",
  "properties": {
    "score":      { "type": "number" },   // 0..1
    "verdict":    { "type": "string", "enum": ["correct", "partial", "incorrect"] },
    "perCriterion": { "type": "array", "items": {
      "type": "object",
      "properties": {
        "criterion": { "type": "string" },
        "awarded":   { "type": "number" },   // 0..1 fraction of the weight
        "comment":   { "type": "string" }
      },
      "required": ["criterion", "awarded"] } },
    "missing":    { "type": "array", "items": { "type": "string" } },
    "feedback":   { "type": "string" }
  },
  "required": ["score", "verdict", "perCriterion", "feedback"]
}
```

Set `temperature: 0` on the grading call only. Generation wants some variety; grading wants
the same answer to score the same way twice.

---

## 4. Storage and invalidation

### Where

`app.getPath('userData')/quiz.db` — SQLite via `node:sqlite`, which the backend already
uses. Not in the repo, not in `~/`, and not alongside the transcripts.

SQLite over JSON files because the interesting query is *"which quizzes are stale"*, which
is a `WHERE` clause rather than a walk over files, and because attempts need atomic writes.

### Schema

```sql
CREATE TABLE quiz (
  id                  TEXT PRIMARY KEY,   -- deterministic, see below
  session_id          TEXT NOT NULL,      -- normalized id, e.g. "pi:01a0ba10-..."
  harness             TEXT NOT NULL,
  -- Staleness inputs. Never the transcript.
  content_fingerprint TEXT NOT NULL,      -- sha256 over role+text of the first N messages
  covered_messages    INTEGER NOT NULL,   -- how many messages this quiz was built from
  generator_version   TEXT NOT NULL,      -- bump to invalidate every quiz at once
  model               TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  topic_map           TEXT NOT NULL,      -- §2 stage B output, JSON
  questions           TEXT NOT NULL,      -- §3 output, JSON
  redaction_report    TEXT                -- what was stripped, for display
);
CREATE INDEX quiz_session ON quiz(session_id);

CREATE TABLE attempt (
  id          INTEGER PRIMARY KEY,
  quiz_id     TEXT NOT NULL REFERENCES quiz(id) ON DELETE CASCADE,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  score       REAL,
  max_score   REAL,
  answers     TEXT NOT NULL               -- { questionId: { answer, awarded, ms } }
);
CREATE INDEX attempt_quiz ON attempt(quiz_id);

-- Enables top-up generation without redoing covered topics.
CREATE TABLE topic_coverage (
  quiz_id       TEXT NOT NULL REFERENCES quiz(id) ON DELETE CASCADE,
  topic_label   TEXT NOT NULL,
  message_ranges TEXT NOT NULL,
  generated_at  INTEGER NOT NULL,
  PRIMARY KEY (quiz_id, topic_label)
);
```

**`id` is deterministic**: `sha256(session_id + content_fingerprint + generator_version +
model + questionTypes)`. The same conversation regenerated with the same settings overwrites
rather than duplicates, and scores stay attached.

**Never store the transcript.** Only the fingerprint, the index ranges and the questions.
Otherwise the quiz database becomes a second, unmanaged copy of the most sensitive files on
the machine.

### Staleness — three states, not one boolean

The naive check is a file mtime, which is wrong: agents append to their session files
constantly, so mtime changes even when nothing the quiz cared about did. Compare content
instead.

```js
fingerprint(session, n = quiz.covered_messages)
  = sha256(messages.slice(0, n).map(m => m.role + '\u0000' + m.text).join('\u0001'))
```

| State | Condition | UI |
|---|---|---|
| `fresh` | fingerprint matches, `messages.length === covered_messages` | score it |
| `extended` | fingerprint matches, `messages.length > covered_messages` | keep old score, offer **"5 more questions on the new turns"** |
| `diverged` | fingerprint differs | **regenerate**, mark old attempts as being against an older revision |
| `generator_stale` | `generator_version` differs | regenerate, offer to keep attempts |

`extended` is the case worth building. Agents are resumed constantly, so "the conversation
grew" is the common path, and throwing away a completed quiz because three turns were added
is the kind of behaviour that makes a user stop trusting the tool. Because topic coverage
is stored with message ranges, generating questions for the new turns is a bounded
incremental operation — it is the same §2 stage C call, scoped to `[covered_messages, end]`.

### Retention and privacy

- Attempts and quizzes are small (questions only, no transcripts) — no cleanup needed.
- Add "delete all quiz data" as a single button. It is a two-table drop and it is the
  answer to the obvious question a judge or user will ask.
- Deleting a quiz must delete its attempts (`ON DELETE CASCADE`).
- `redaction_report` is stored so the UI can justify what it stripped, per quiz.

---

## 5. Open questions

1. **Should thinking blocks reach the model at all?** They are ~98% of the bytes and contain
   the reasoning a quiz would love to ask about — but verbatim they are both unaffordable
   and full of dead ends. The §2 digest's ~600-char cap per assistant turn is a guess; worth
   testing whether capping harder (or running a cheap summariser over thinking only) changes
   question quality.
2. **Is `open` worth the extra call?** It is the most interesting type and the only one
   needing a second request plus a rubric. Worth measuring whether users learn more from it
   than from a well-written MCQ before building the grader UI.
3. **Cross-session quizzes** (§2) are the mode where retrieval genuinely applies and where
   the product gets more interesting. Bigger payoff than another question type, and it
   reuses everything above.
4. **Redaction is a one-way door.** A transcript that reaches a provider cannot be recalled.
   The current default (entropy off, patterns on) is tuned to avoid corrupting content; if
   this is ever used on someone else's machine, the safer default is entropy **on** with the
   false positives accepted. That is a product decision, not a technical one.
