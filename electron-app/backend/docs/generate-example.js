#!/usr/bin/env node
// Generates docs/example-digest.md.
//
// The example is built from a synthetic project and a synthetic session rather
// than a real one, for two reasons: real transcripts contain credentials and
// machine paths that must not end up in the repository, and a generated example
// can be regenerated and verified rather than going stale.
//
// The project is small but exercises every part of the pipeline: tool calls with
// file paths, a README, a nested manifest, a real git repo with a commit made
// during the session, a session long enough to need a budget cut, and a topic
// boundary the segmenter has to find on its own.
//
//   node docs/generate-example.js

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { buildDigest, extractTouched } from '../lib/digest.js';
import { finalizeSession } from '../lib/normalize.js';
import { deriveTopics, topicSlices } from '../lib/topics.js';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'example-digest.md');

// The project is built in a temp directory because that is what a test fixture
// should do, but a real path from a real run must not end up in the repository.
// The digest is computed against the real directory; only the rendered text is
// rewritten to a stable, obviously illustrative path.
const DISPLAY_ROOT = '/home/dev/projects/widget-api';
const sanitize = (text) => String(text).split(ROOT).join(DISPLAY_ROOT);

// ── A synthetic project, with real git history ─────────────────────────────

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-doc-'));
const APP = path.join(ROOT, 'services', 'pool');
fs.mkdirSync(path.join(APP, 'src'), { recursive: true });
fs.mkdirSync(path.join(APP, 'node_modules', 'pg'), { recursive: true });

fs.writeFileSync(
  path.join(ROOT, 'README.md'),
  [
    '# Widget API',
    '',
    'Routes widget requests to shard backends. Each shard has a Postgres pool.',
    '',
    '## Operating notes',
    '',
    '- Pool size is deliberately capped at 20 per worker.',
    '- Do **not** raise the cap to work around saturation. It moves the failure',
    '  from the pool to the database.',
    '',
  ].join('\n'),
);
fs.writeFileSync(
  path.join(APP, 'package.json'),
  JSON.stringify(
    {
      name: '@widget/pool',
      description: 'connection pooling for shard backends',
      scripts: { test: 'node --test', lint: 'eslint src' },
      dependencies: { pg: '^8.11.0', pino: '^9.0.0' },
      devDependencies: { typescript: '^5.4.0' },
    },
    null,
    2,
  ),
);
fs.writeFileSync(
  path.join(APP, 'src', 'db.ts'),
  ['export function session() {', '  const client = pool.connect();', '  return client;', '}', ''].join('\n'),
);
fs.writeFileSync(
  path.join(APP, 'src', 'pool.ts'),
  ['export const pool = new Pool({ max: 20 });', ''].join('\n'),
);
fs.writeFileSync(
  path.join(APP, 'src', 'cache.ts'),
  ['export const cache = new Map();', 'export const ttlSeconds = 60;', ''].join('\n'),
);
fs.writeFileSync(path.join(APP, 'node_modules', 'pg', 'index.js'), '// vendored noise\n');

const g = (...args) =>
  execFileSync('git', ['-C', ROOT, '-c', 'user.email=doc@example.com', '-c', 'user.name=Doc', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
g('init', '-q');
g('add', '-A');
g('commit', '-q', '-m', 'initial widget API');

// ── A synthetic session ────────────────────────────────────────────────────
//
// Topic 1: diagnose the leak. Topic 2: an unrelated question about the cache,
// which the segmenter must find on its own with no help.

const T = (min) => new Date(Date.UTC(2026, 2, 14, 10, min)).getTime();
const REASONING = (n) => `Weighing options for step ${n}: `.repeat(30);

const long = (s, n) => s.repeat(n);

const session = finalizeSession({
  harness: 'pi',
  harnessName: 'pi',
  nativeId: 'doc-example-01',
  project: 'widget-api',
  title: 'why is the pool exhausted',
  cwd: ROOT,
  started: T(0),
  updated: T(78),
  path: path.join(ROOT, '.pi', 'session.jsonl'),
  messages: [
    {
      role: 'user',
      text: 'We are seeing "connection pool exhausted" on the widget API under load. Find out why and fix it. Start in services/pool/src/db.ts.',
      ts: T(0),
    },
    {
      role: 'assistant',
      text: 'Reading the session helper and the pool configuration to see how connections are acquired.',
      ts: T(1),
      thinkingChars: REASONING(1).length,
      tools: [
        { name: 'read', input: { path: path.join(APP, 'src', 'db.ts') } },
        { name: 'read', input: { path: path.join(APP, 'src', 'pool.ts') } },
        { name: 'grep', input: { pattern: 'pool.connect' } },
      ],
    },
    // Tool results were dropped during normalization, so this body never reaches
    // the digest; it exists here to make the point in the numbers.
    { role: 'tool', text: long('file listing output\n', 900) },
    {
      role: 'assistant',
      text: '`db.ts` acquires a client and returns it, but the caller in the error path returns before releasing. Every failed request leaks one connection, so the pool fills linearly with error rate rather than with traffic.',
      ts: T(4),
      thinkingChars: REASONING(2).length,
      tools: [{ name: 'edit', input: { path: path.join(APP, 'src', 'db.ts'), edits: [{ oldText: 'const client = pool.connect();', newText: 'const client = await pool.connect();' }] } }],
    },
    { role: 'user', text: 'give me the fixed version of the whole file please', ts: T(9) },
    {
      role: 'assistant',
      text: 'Here is the corrected file. The change wraps acquisition in try/finally so the client is always released:\n\n```ts\nexport async function session<T>(fn: (c: Client) => Promise<T>) {\n  const client = await pool.connect();\n  try {\n    return await fn(client);\n  } finally {\n    client.release();\n  }\n}\n```\n\nCallers pass a callback instead of receiving a client, which makes the leak unrepresentable.',
      ts: T(11),
      thinkingChars: REASONING(3).length,
      tools: [{ name: 'write', input: { path: path.join(APP, 'src', 'db.ts'), content: 'export async function session() {}\n' } }],
    },
    { role: 'user', text: 'run the tests to confirm', ts: T(16) },
    {
      role: 'assistant',
      text: 'All 14 tests pass. The pool now holds a steady 3 connections under the same error-heavy load that previously saturated it.',
      ts: T(19),
      thinkingChars: REASONING(4).length,
      tools: [{ name: 'bash', input: { command: 'npm test --workspace services/pool\n(second line of the command is dropped)' } }],
    },

    // --- An unrelated question, 40 minutes later. The segmenter should cut here.
    {
      role: 'user',
      text: 'Separately — the response cache is returning stale widget prices for about a minute after a price update. Where is the TTL configured and should we lower it?',
      ts: T(59),
    },
    {
      role: 'assistant',
      text: 'The TTL is set to 60s in the cache adapter. Lowering it trades hit rate for freshness; a better fix is to invalidate on write, since price updates are rare compared with reads.',
      ts: T(63),
      thinkingChars: REASONING(5).length,
      tools: [
        { name: 'read', input: { path: path.join(APP, 'src', 'cache.ts') } },
        { name: 'grep', input: { pattern: 'ttl' } },
      ],
    },
    {
      role: 'assistant',
      text: 'Implemented write-through invalidation. The cache is now evicted on price update rather than expiring on a timer, so reads stay fresh without losing the hit rate.',
      ts: T(78),
      thinkingChars: REASONING(6).length,
      tools: [{ name: 'edit', input: { path: path.join(APP, 'src', 'cache.ts'), edits: [{ oldText: 'ttl: 60', newText: 'invalidateOnWrite: true' }] } }],
    },
  ],
});

// Apply the changes the session describes, so the second commit has real content.
// A commit inside the session window is what makes the git section meaningful, and
// it is also what ties "the conversation edited src/db.ts" to a commit message.
fs.writeFileSync(
  path.join(APP, 'src', 'db.ts'),
  [
    'export async function session<T>(fn: (c: Client) => Promise<T>) {',
    '  const client = await pool.connect();',
    '  try {',
    '    return await fn(client);',
    '  } finally {',
    '    client.release();',
    '  }',
    '}',
    '',
  ].join('\n'),
);
fs.writeFileSync(
  path.join(APP, 'src', 'cache.ts'),
  ['export const cache = new Map();', 'export const invalidateOnWrite = true;', ''].join('\n'),
);
g('add', '-A');
g('commit', '-q', '-m', 'pool: release clients in finally, fix leak on error path');

// ── Build the artefacts ────────────────────────────────────────────────────

const digest = buildDigest(session);
const touched = extractTouched(session);
const topicsResult = deriveTopics(session, { maxTopics: 8 });
const slices = topicSlices(session, { maxChars: 12000, maxTopics: 8 });

const reasoning = session.reasoningChars || 0;
const toolBodies = session.messages
  .filter((m) => m.role === 'tool')
  .reduce((n, m) => n + m.text.length, 0);
const rawChars = session.chars + reasoning + toolBodies;

// A tighter budget than the default, to show the budget logic doing something.
const tight = buildDigest(session, { budget: { total: 4000, project: 1500 } });

const md = `# Example digest

A worked example of how one conversation becomes a bounded prompt, and the exact
process that produced it. Regenerate with \`node docs/generate-example.js\`.

Everything here is synthetic: a small project and a short session created by that
script, so nothing private and no machine paths appear in the repository. The
project is built to exercise every part of the pipeline — tool calls with file
paths, a README, a nested manifest, a real git repo with a commit made during the
session, and a topic boundary the segmenter has to find on its own.

---

## 0. The input

\`\`\`
project    widget-api        ${DISPLAY_ROOT}
agent      pi
turns      ${session.messages.length} messages, ${session.userTurns} user
tool calls ${session.toolCalls}
\`\`\`

The session has two separate topics, and nothing marks the boundary between them
except the word "Separately", a 40-minute gap, and a completely different set of
files being touched:

| topic | turns | what happened |
|---|---|---|
${topicsResult.topics
  .map((t) => `| ${t.id} | ${t.from}–${t.to} | ${t.label.replace(/\|/g, '\\|').slice(0, 62)} |`)
  .join('\n')}

---

## 1. Normalization — what is removed before the digest is even built

The digest never sees these; they are dropped by \`lib/text.js\` and
\`lib/normalize.js\` during parsing, so no later code path can forget to filter them.

| Component | Size | Verdict |
|---|---|---|
| Answer text | ${session.chars.toLocaleString('en-US')} chars | **kept** |
| Model reasoning | ${reasoning.toLocaleString('en-US')} chars | **dropped** — ${((reasoning / rawChars) * 100).toFixed(0)}% of the raw bytes, and the decision is that it is never sent |
| Tool output bodies | ${toolBodies.toLocaleString('en-US')} chars | **dropped** — only tool *names* and *arguments* survive |
| **raw total** | **${rawChars.toLocaleString('en-US')} chars** | = ${(rawChars / session.chars).toFixed(1)}× what the digest works from |

Tool calls are kept as names plus a short argument, which is where the file paths
come from:

\`\`\`
${touched.toolsByName.map(([name, count]) => `${name} ×${count}`).join(',  ')}
\`\`\`

---

## 2. Conversation rendering

Each turn becomes an indexed block. The index is its position in
\`session.messages\`, which is the contract that lets a generated question cite
\`sourceRefs.messageIndex\` and the app jump to the turn that proves the answer.

| Rule | Value | Why |
|---|---|---|
| user turn | verbatim, ${4000} chars | it carries the task statement |
| assistant turn | ${700} chars | mostly narration around a decision |
| **final** assistant turn | ${3000} chars | the closing summary is the most quiz-worthy text in a session |
| fenced code blocks | kept separately, ${900} chars | fill-in-the-blank questions need real code |
| tool call | \`name(first argument)\`, ${90} chars | reveals what was touched without the output |
| command | first line only, ${120} chars | agents log multi-line heredocs |

---

## 3. Project context — selected by the conversation, not by scanning

The project half is \`${digest.sections.project.toLocaleString('en-US')}\` chars, and
what goes in it is chosen by the files the conversation touched
(\`${touched.relevant.length}\` of them), not by walking the repository:

- \`touchedEdited\` = ${digest.stats.touchedEdited}, \`touchedRead\` = ${digest.stats.touchedRead}
- the tree is walked deep only into subtrees containing those paths, and marks them
- \`git log\` is scoped to the session time window, so it returns the work the session produced
- only documentation and manifests are ever **read**; source files are never opened

---

## 4. Budget allocation

Sections are funded in priority order under one ceiling, because the project
section is emitted last and a naive total-budget cut deletes it entirely:

\`\`\`
total ${digest.stats.budget}
  − header          ${digest.sections.header}
  − fixed overhead  400
  = available
      → project, capped at half of that
      → conversation gets the remainder
\`\`\`

The conversation then loses its **middle**, keeping the head (what was asked) and
the tail (what was concluded), with a marker recording the gap.

---

## 5. The digest

${digest.stats.chars.toLocaleString('en-US')} chars, from
${rawChars.toLocaleString('en-US')} raw. Note that the conversation is ${
  (digest.sections.conversationShare * 100).toFixed(0)
}% of the output — it is the primary source, and the project section is supporting
material.

\`\`\`markdown
${sanitize(digest.text)}
\`\`\`

---

## 6. Deterministic topics

No model is called. Cuts come from four signals, scored between consecutive
exchanges: a change in the set of files being touched (weight 3), a drop in word
overlap between consecutive user turns (weight 2), a pause longer than 30 or 120
minutes (1.5 / 3), and explicit transition markers such as "separately" or "now"
(1). Every candidate is then ranked by a deterministic quiz-value score, because a
long session produces more topics than a quiz wants:

\`\`\`
${topicsResult.stats.candidates} candidate topics → ${topicsResult.stats.topics} selected, ${topicsResult.stats.droppedTopics} dropped
coverage ${(topicsResult.stats.coverage * 100).toFixed(0)}% of session characters
median topic ${topicsResult.stats.medianTopic.toLocaleString('en-US')} chars, largest ${topicsResult.stats.largestTopic.toLocaleString('en-US')}
\`\`\`

| id | score | exch | chars | files | label (the opening user turn) |
|---|---|---|---|---|---|
${topicsResult.topics
  .map(
    (t) =>
      `| ${t.id} | ${t.score} | ${t.exchanges} | ${t.chars.toLocaleString('en-US')} | ${t.files.length} | ${t.label.replace(/\|/g, '\\|').slice(0, 70)} |`,
  )
  .join('\n')}

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
requests, and \`coverage\` exists so the caller can see the trade and raise
\`maxTopics\` if the session is worth more questions.

The \`largest slice\` column is the one that matters for safety, and it never moves:
1.2 × 10⁴ regardless of session size, because it is capped rather than derived.

## 7. The bounds that make this safe to run

| Stage | Bound | Actual here |
|---|---|---|
| digest | \`budget.total\` (default 24,000) plus a \`hardMax\` backstop | ${digest.stats.chars.toLocaleString('en-US')} |
| topic count | \`maxTopics\` | ${topicsResult.stats.topics} |
| **each generation prompt** | \`topicSlice({ maxChars })\` | largest ${slices.stats.largestSlice.toLocaleString('en-US')} chars |
| total prompt material | \`maxTopics × maxChars\` | ${slices.stats.sliceChars.toLocaleString('en-US')} chars over ${slices.stats.promptCount} calls |

The last row is the point. This session is only
${rawChars.toLocaleString('en-US')} raw characters, so it fits comfortably — but the
bounds do not depend on that. Every prompt in the pipeline is capped by
\`maxChars\` and the number of them is capped by \`maxTopics\`, so a session a
thousand times larger produces the same ceiling rather than a larger prompt. The
\`largest slice\` row in section 6b shows that cap holding flat as sessions grow
from 500k to 2.4M characters.

---

## 8. A tighter budget, to show what happens at the ceiling

The same session with \`{ budget: { total: 4000, project: 1500 } }\` →
${tight.stats.chars} chars. The project section survives
(\`projectTruncated: ${tight.stats.projectTruncated}\`), the conversation is cut in
the middle, and nothing throws:

\`\`\`markdown
${sanitize(tight.text)}
\`\`\`
`;

fs.writeFileSync(OUT, md, 'utf8');
fs.rmSync(ROOT, { recursive: true, force: true });

console.log(`wrote ${OUT}`);
console.log(`  digest ${digest.stats.chars} chars, ${topicsResult.stats.topics} topics, largest slice ${slices.stats.largestSlice}`);
