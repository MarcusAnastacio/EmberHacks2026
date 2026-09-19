# Example digest

A worked example of how one conversation becomes a bounded prompt, and the exact
process that produced it. Regenerate with `node docs/generate-example.js`.

Everything here is synthetic: a small project and a short session created by that
script, so nothing private and no machine paths appear in the repository. The
project is built to exercise every part of the pipeline — tool calls with file
paths, a README, a nested manifest, a real git repo with a commit made during the
session, and a topic boundary the segmenter has to find on its own.

---

## 0. The input

```
project    widget-api        /home/dev/projects/widget-api
agent      pi
turns      8 messages, 4 user
tool calls 9
```

The session has two separate topics, and nothing marks the boundary between them
except the word "Separately", a 40-minute gap, and a completely different set of
files being touched:

| topic | turns | what happened |
|---|---|---|
| t1 | 0–1 | We are seeing "connection pool exhausted" on the widget API un |
| t2 | 2–5 | give me the fixed version of the whole file please |
| t3 | 6–7 | Separately — the response cache is returning stale widget pric |

---

## 1. Normalization — what is removed before the digest is even built

The digest never sees these; they are dropped by `lib/text.js` and
`lib/normalize.js` during parsing, so no later code path can forget to filter them.

| Component | Size | Verdict |
|---|---|---|
| Answer text | 1,521 chars | **kept** |
| Model reasoning | 3,480 chars | **dropped** — 70% of the raw bytes, and the decision is that it is never sent |
| Tool output bodies | 0 chars | **dropped** — only tool *names* and *arguments* survive |
| **raw total** | **5,001 chars** | = 3.3× what the digest works from |

Tool calls are kept as names plus a short argument, which is where the file paths
come from:

```
read ×3,  grep ×2,  edit ×2,  write ×1,  bash ×1
```

---

## 2. Conversation rendering

Each turn becomes an indexed block. The index is its position in
`session.messages`, which is the contract that lets a generated question cite
`sourceRefs.messageIndex` and the app jump to the turn that proves the answer.

| Rule | Value | Why |
|---|---|---|
| user turn | verbatim, 4000 chars | it carries the task statement |
| assistant turn | 700 chars | mostly narration around a decision |
| **final** assistant turn | 3000 chars | the closing summary is the most quiz-worthy text in a session |
| fenced code blocks | kept separately, 900 chars | fill-in-the-blank questions need real code |
| tool call | `name(first argument)`, 90 chars | reveals what was touched without the output |
| command | first line only, 120 chars | agents log multi-line heredocs |

---

## 3. Project context — selected by the conversation, not by scanning

The project half is `1,052` chars, and
what goes in it is chosen by the files the conversation touched
(`3` of them), not by walking the repository:

- `touchedEdited` = 2, `touchedRead` = 3
- the tree is walked deep only into subtrees containing those paths, and marks them
- `git log` is scoped to the session time window, so it returns the work the session produced
- only documentation and manifests are ever **read**; source files are never opened

---

## 4. Budget allocation

Sections are funded in priority order under one ceiling, because the project
section is emitted last and a naive total-budget cut deletes it entirely:

```
total 24000
  − header          321
  − fixed overhead  400
  = available
      → project, capped at half of that
      → conversation gets the remainder
```

The conversation then loses its **middle**, keeping the head (what was asked) and
the tail (what was concluded), with a marker recording the gap.

---

## 5. The digest

3,749 chars, from
5,001 raw. Note that the conversation is 59% of the output — it is the primary source, and the project section is supporting
material.

```markdown
# Session digest

agent:      pi
project:    widget-api
title:      why is the pool exhausted
started:    2026-03-14T10:00:00.000Z
duration:   1h 18m
turns:      8 messages (4 user, 4 assistant)
tool calls: 9 — read×3, grep×2, edit×2, write×1, bash×1
omitted:    3,480 chars of model reasoning, and all tool output bodies

## Conversation

[turn 0] USER 10:00
  We are seeing "connection pool exhausted" on the widget API under load. Find out why and fix it. Start in services/pool/src/db.ts.

[turn 1] ASSISTANT 10:01 | tools: read(/home/dev/projects/widget-api/services/pool/src/db.ts), read(/home/dev/projects/widget-api/services/pool/src/pool.ts), grep(pool.connect), edit(/home/dev/projects/widget-api/services/pool/src/db.ts)
  Reading the session helper and the pool configuration to see how connections are acquired.

  `db.ts` acquires a client and returns it, but the caller in the error path returns before releasing. Every failed request leaks one connection, so the pool fills linearly with error rate rather than with traffic.

[turn 2] USER 10:09
  give me the fixed version of the whole file please

[turn 3] ASSISTANT 10:11 | tools: write(/home/dev/projects/widget-api/services/pool/src/db.ts)
  Here is the corrected file. The change wraps acquisition in try/finally so the client is always released:

  ```ts
  export async function session<T>(fn: (c: Client) => Promise<T>) {
    const client = await pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }
  ```

  Callers pass a callback instead of receiving a client, which makes the leak unrepresentable.

[turn 4] USER 10:16
  run the tests to confirm

[turn 5] ASSISTANT 10:19 | tools: bash(npm test --workspace services/pool)
  All 14 tests pass. The pool now holds a steady 3 connections under the same error-heavy load that previously saturated it.

[turn 6] USER 10:59
  Separately — the response cache is returning stale widget prices for about a minute after a price update. Where is the TTL configured and should we lower it?

[turn 7] ASSISTANT 11:03 | tools: read(/home/dev/projects/widget-api/services/pool/src/cache.ts), grep(ttl), edit(/home/dev/projects/widget-api/services/pool/src/cache.ts)
  The TTL is set to 60s in the cache adapter. Lowering it trades hit rate for freshness; a better fix is to invalidate on write, since price updates are rare compared with reads.

  Implemented write-through invalidation. The cache is now evicted on price update rather than expiring on a timer, so reads stay fresh without losing the hit rate.

## Project context

The conversation above is the primary source. Everything below is supporting
material, filtered to what the conversation actually touched.

working directory: /home/dev/projects/widget-api

files the conversation MODIFIED (2):
  services/pool/src/db.ts  (2 calls)
  services/pool/src/cache.ts

files the conversation READ (3):
  services/pool/src/db.ts
  services/pool/src/pool.ts
  services/pool/src/cache.ts

most recent commit touching a file the conversation modified:
  services/pool/src/db.ts: 64dbece pool: release clients in finally, fix leak on error path
  services/pool/src/cache.ts: 64dbece pool: release clients in finally, fix leak on error path

documentation (excerpts):
  --- README.md ---
    # Widget API

    Routes widget requests to shard backends. Each shard has a Postgres pool.

    ## Operating notes

    - Pool size is deliberately capped at 20 per worker.
    - Do **not** raise the cap to work around saturation. It moves the failure
      from the pool to the database.


structure:
  services/
    pool/
      src/
        cache.ts   <- touched
        db.ts   <- touched
        pool.ts   <- touched
      package.json
  README.md

looked for: "pool.connect", "ttl"

```

---

## 6. Deterministic topics

No model is called. Cuts come from four signals, scored between consecutive
exchanges: a change in the set of files being touched (weight 3), a drop in word
overlap between consecutive user turns (weight 2), a pause longer than 30 or 120
minutes (1.5 / 3), and explicit transition markers such as "separately" or "now"
(1). Every candidate is then ranked by a deterministic quiz-value score, because a
long session produces more topics than a quiz wants:

```
3 candidate topics → 3 selected, 0 dropped
coverage 100% of session characters
median topic 497 chars, largest 590
```

| id | score | exch | chars | files | label (the opening user turn) |
|---|---|---|---|---|---|
| t1 | 6.67 | 1 | 434 | 2 | We are seeing "connection pool exhausted" on the widget API under load |
| t2 | 6.59 | 2 | 590 | 1 | give me the fixed version of the whole file please |
| t3 | 4.77 | 1 | 497 | 1 | Separately — the response cache is returning stale widget prices for a |

The label is the opening user turn, trimmed at a word boundary. A user turn is
already the best description of what the topic is, and it is in the user's own
words.

---

## 6b. The same machinery at real scale

The synthetic session is deliberately small so the process is followable, which
means it never exercises size-splitting or ranking-with-drops. Those only appear on
long sessions. Measured across 48 real sessions from three agents on one machine:

| session chars | candidates | selected | dropped | coverage | median topic | largest | largest slice |
|---|---|---|---|---|---|---|---|
| 2,471,294 | 168 | 14 | 154 | 16% | 29k | 42k | 12,037 |
| 1,845,992 | 164 | 14 | 150 | 17% | 20k | 58k | 12,038 |
| 1,661,590 | 154 | 14 | 140 | 19% | 20k | 58k | 12,038 |
| 854,640 | 96 | 14 | 82 | 31% | 19k | 30k | 12,038 |
| 543,839 | 63 | 14 | 49 | 49% | 23k | 28k | 12,038 |
| 539,962 | 48 | 14 | 34 | 53% | 18k | 30k | 12,038 |

Read the coverage column honestly. A 2.4M-character session cannot be represented
by fourteen bounded prompts, so 84% of it is never asked about. That is a real
limitation, not a tuning problem: the cap trades coverage for a bounded number of
requests, and `coverage` exists so the caller can see the trade and raise
`maxTopics` if the session is worth more questions.

The `largest slice` column is the one that matters for safety, and it never moves:
1.2 × 10⁴ regardless of session size, because it is capped rather than derived.

## 7. The bounds that make this safe to run

| Stage | Bound | Actual here |
|---|---|---|
| digest | `budget.total` (default 24,000) plus a `hardMax` backstop | 3,749 |
| topic count | `maxTopics` | 3 |
| **each generation prompt** | `topicSlice({ maxChars })` | largest 1,356 chars |
| total prompt material | `maxTopics × maxChars` | 2,919 chars over 3 calls |

The last row is the point. This session is only
5,001 raw characters, so it fits comfortably — but the
bounds do not depend on that. Every prompt in the pipeline is capped by
`maxChars` and the number of them is capped by `maxTopics`, so a session a
thousand times larger produces the same ceiling rather than a larger prompt. The
`largest slice` row in section 6b shows that cap holding flat as sessions grow
from 500k to 2.4M characters.

---

## 8. A tighter budget, to show what happens at the ceiling

The same session with `{ budget: { total: 4000, project: 1500 } }` →
3749 chars. The project section survives
(`projectTruncated: 0`), the conversation is cut in
the middle, and nothing throws:

```markdown
# Session digest

agent:      pi
project:    widget-api
title:      why is the pool exhausted
started:    2026-03-14T10:00:00.000Z
duration:   1h 18m
turns:      8 messages (4 user, 4 assistant)
tool calls: 9 — read×3, grep×2, edit×2, write×1, bash×1
omitted:    3,480 chars of model reasoning, and all tool output bodies

## Conversation

[turn 0] USER 10:00
  We are seeing "connection pool exhausted" on the widget API under load. Find out why and fix it. Start in services/pool/src/db.ts.

[turn 1] ASSISTANT 10:01 | tools: read(/home/dev/projects/widget-api/services/pool/src/db.ts), read(/home/dev/projects/widget-api/services/pool/src/pool.ts), grep(pool.connect), edit(/home/dev/projects/widget-api/services/pool/src/db.ts)
  Reading the session helper and the pool configuration to see how connections are acquired.

  `db.ts` acquires a client and returns it, but the caller in the error path returns before releasing. Every failed request leaks one connection, so the pool fills linearly with error rate rather than with traffic.

[turn 2] USER 10:09
  give me the fixed version of the whole file please

[turn 3] ASSISTANT 10:11 | tools: write(/home/dev/projects/widget-api/services/pool/src/db.ts)
  Here is the corrected file. The change wraps acquisition in try/finally so the client is always released:

  ```ts
  export async function session<T>(fn: (c: Client) => Promise<T>) {
    const client = await pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }
  ```

  Callers pass a callback instead of receiving a client, which makes the leak unrepresentable.

[turn 4] USER 10:16
  run the tests to confirm

[turn 5] ASSISTANT 10:19 | tools: bash(npm test --workspace services/pool)
  All 14 tests pass. The pool now holds a steady 3 connections under the same error-heavy load that previously saturated it.

[turn 6] USER 10:59
  Separately — the response cache is returning stale widget prices for about a minute after a price update. Where is the TTL configured and should we lower it?

[turn 7] ASSISTANT 11:03 | tools: read(/home/dev/projects/widget-api/services/pool/src/cache.ts), grep(ttl), edit(/home/dev/projects/widget-api/services/pool/src/cache.ts)
  The TTL is set to 60s in the cache adapter. Lowering it trades hit rate for freshness; a better fix is to invalidate on write, since price updates are rare compared with reads.

  Implemented write-through invalidation. The cache is now evicted on price update rather than expiring on a timer, so reads stay fresh without losing the hit rate.

## Project context

The conversation above is the primary source. Everything below is supporting
material, filtered to what the conversation actually touched.

working directory: /home/dev/projects/widget-api

files the conversation MODIFIED (2):
  services/pool/src/db.ts  (2 calls)
  services/pool/src/cache.ts

files the conversation READ (3):
  services/pool/src/db.ts
  services/pool/src/pool.ts
  services/pool/src/cache.ts

most recent commit touching a file the conversation modified:
  services/pool/src/db.ts: 64dbece pool: release clients in finally, fix leak on error path
  services/pool/src/cache.ts: 64dbece pool: release clients in finally, fix leak on error path

documentation (excerpts):
  --- README.md ---
    # Widget API

    Routes widget requests to shard backends. Each shard has a Postgres pool.

    ## Operating notes

    - Pool size is deliberately capped at 20 per worker.
    - Do **not** raise the cap to work around saturation. It moves the failure
      from the pool to the database.


structure:
  services/
    pool/
      src/
        cache.ts   <- touched
        db.ts   <- touched
        pool.ts   <- touched
      package.json
  README.md

looked for: "pool.connect", "ttl"

```
