#!/usr/bin/env node
// Digest tests.
//
// The digest is the thing that decides what a model gets to see, so the
// assertions here are about *inclusion and exclusion*, not formatting:
//   * the conversation is present, user turns verbatim
//   * reasoning and tool output are ABSENT — they are the bulk of a session and
//     the product decision is that they are never sent
//   * turn indices in the digest are indices into session.messages, because
//     generated questions cite those indices in sourceRefs
//   * the project section survives a total-budget cut (it used to be deleted,
//     being last)
//   * the digest is deterministic and writes nothing
//
// A synthetic project is built in a temp directory, including a real git repo, so
// the project half is exercised end to end without depending on this machine's
// history.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { buildDigest, extractTouched } from '../lib/digest.js';
import { finalizeSession } from '../lib/normalize.js';
import { contentToParts } from '../lib/text.js';

const require_parts = () => ({ contentToParts });

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failures.push({ name, message: err.message });
  }
}

// ── A synthetic project on disk, with real git history ─────────────────────

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-test-'));
const APP = path.join(ROOT, 'electron-app');
fs.mkdirSync(path.join(APP, 'src'), { recursive: true });
fs.mkdirSync(path.join(APP, 'node_modules', 'ignored'), { recursive: true });

fs.writeFileSync(
  path.join(ROOT, 'README.md'),
  '# Synthetic Project\n\nManages a connection pool for the widget service. Do not raise the pool size.\n',
);
fs.writeFileSync(
  path.join(APP, 'package.json'),
  JSON.stringify(
    { name: 'synthetic-app', description: 'widget service', scripts: { test: 'node --test' }, dependencies: { pg: '^8.11.0' } },
    null,
    2,
  ),
);
fs.writeFileSync(path.join(APP, 'src', 'db.ts'), 'export const open = () => pool.connect();\n');
fs.writeFileSync(path.join(APP, 'src', 'pool.ts'), 'export const pool = new Pool({ max: 20 });\n');
fs.writeFileSync(path.join(APP, 'node_modules', 'ignored', 'junk.ts'), 'should never appear\n');

const g = (...args) =>
  execFileSync('git', ['-C', ROOT, '-c', 'user.email=t@t', '-c', 'user.name=T', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });

g('init', '-q');
g('add', '-A');
g('commit', '-q', '-m', 'initial commit');

// ── A synthetic session, shaped like a real one ────────────────────────────

const STARTED = Date.now() - 30 * 60 * 1000;
const ENDED = Date.now() - 2 * 60 * 1000;

const REASONING = 'Let me think about this very carefully and enumerate every possibility in detail. '.repeat(40);
const TOOL_BODY = 'a'.repeat(50_000);

const session = finalizeSession({
  harness: 'pi',
  harnessName: 'pi',
  nativeId: 'test-session',
  project: 'synthetic-app',
  title: 'why is the pool exhausted',
  cwd: ROOT,
  started: STARTED,
  updated: ENDED,
  path: path.join(ROOT, 'session.jsonl'),
  messages: [
    // tool result bodies are dropped during normalization
    { role: 'tool', text: TOOL_BODY },
    { role: 'user', text: 'why is the connection pool exhausted in src/db.ts?', ts: STARTED + 1000 },
    {
      role: 'assistant',
      text: 'Found it. The pool fills because each worker opens a session and returns early on the error path.',
      ts: STARTED + 60_000,
      thinkingChars: REASONING.length,
      tools: [
        { name: 'read', input: { path: path.join(APP, 'src', 'db.ts') } },
        { name: 'edit', input: { path: path.join(APP, 'src', 'pool.ts'), edits: [{ oldText: 'a', newText: 'b' }] } },
        { name: 'bash', input: { command: 'npx jest src/pool.test.ts\nsecond line ignored' } },
        { name: 'grep', input: { pattern: 'createEngine' } },
      ],
    },
    { role: 'user', text: 'should we just raise the pool size?', ts: STARTED + 120_000 },
    {
      role: 'assistant',
      text: 'No — that hides the leak. Wrap the session in a context manager so it always closes.',
      ts: ENDED,
      tools: [],
    },
  ],
});

// ── Conversation half ──────────────────────────────────────────────────────

const digest = buildDigest(session);

check('digest is non-empty and bounded', () => {
  assert.ok(digest.text.length > 200, 'digest too short');
  assert.ok(digest.stats.chars <= 24000, `digest exceeds budget: ${digest.stats.chars}`);
});

check('user turns are present verbatim', () => {
  assert.ok(digest.text.includes('why is the connection pool exhausted in src/db.ts?'));
  assert.ok(digest.text.includes('should we just raise the pool size?'));
});

check('reasoning is NOT in the digest', () => {
  assert.ok(!digest.text.includes('enumerate every possibility'), 'reasoning leaked into the digest');
  assert.ok(digest.stats.reasoningOmitted > 0, 'omitted reasoning was not reported');
});

check('reasoning is excluded in every agent dialect', () => {
  // Each of these is a real encoding seen in the wild. The risk is a new dialect
  // arriving and its reasoning silently reaching the model, so every one is
  // pinned: the text must survive and the reasoning must not.
  const REASONING = 'INTERNAL_REASONING_MARKER';
  const cases = {
    'pi toolCall': [
      { type: 'thinking', thinking: REASONING },
      { type: 'text', text: 'answer' },
      { type: 'toolCall', name: 'write', arguments: { path: '/a.ts' } },
    ],
    anthropic: [
      { type: 'thinking', thinking: REASONING },
      { type: 'text', text: 'answer' },
      { type: 'tool_use', name: 'Edit', input: { file_path: '/x.ts' } },
    ],
    openai: [
      { type: 'reasoning', summary: REASONING },
      { type: 'output_text', text: 'answer' },
      { type: 'function_call', name: 'read', arguments: { path: '/y.ts' } },
    ],
    'gemini thought flag': [
      { text: REASONING, thought: true },
      { text: 'answer' },
    ],
    'gemini isThought': [
      { text: REASONING, isThought: true },
      { text: 'answer' },
    ],
    'redacted_thinking': [
      { type: 'redacted_thinking', data: REASONING },
      { type: 'text', text: 'answer' },
    ],
  };

  const { contentToParts } = require_parts();
  for (const [name, content] of Object.entries(cases)) {
    const { text, thinkingChars } = contentToParts(content);
    assert.ok(!text.includes(REASONING), `${name}: reasoning leaked into text`);
    assert.ok(text.includes('answer'), `${name}: answer text was lost`);
    if (name !== 'redacted_thinking') {
      assert.ok(thinkingChars >= REASONING.length, `${name}: reasoning size not reported`);
    }
  }
});

check('tool calls are found regardless of how the agent spells the kind', () => {
  const { contentToParts } = require_parts();
  const spellings = [
    [{ type: 'toolCall', name: 'a', arguments: { path: '/1' } }],
    [{ type: 'tool_use', name: 'b', input: { path: '/2' } }],
    [{ type: 'tool-call', name: 'c', args: { path: '/3' } }],
    [{ type: 'function_call', name: 'd', arguments: { path: '/4' } }],
    [{ kind: 'toolCall', name: 'e', arguments: { path: '/5' } }],
  ];
  for (const content of spellings) {
    const { tools } = contentToParts(content);
    assert.equal(tools.length, 1, `missed tool call spelling: ${JSON.stringify(content[0].type || content[0].kind)}`);
    assert.ok(tools[0].input, 'tool arguments not captured');
  }
});

check('tool output bodies are NOT in the digest', () => {
  assert.ok(!digest.text.includes('aaaa'), 'tool body leaked into the digest');
});

check('tool names and arguments ARE in the digest', () => {
  assert.ok(/read\(/.test(digest.text), 'tool name missing');
  assert.ok(digest.text.includes('src/db.ts'), 'tool argument missing');
  assert.ok(digest.text.includes('npx jest src/pool.test.ts'), 'command missing');
  // Only the first line of a multi-line command should be kept.
  assert.ok(!digest.text.includes('second line ignored'), 'multi-line command not truncated');
});

check('turn indices are indices into session.messages (sourceRefs contract)', () => {
  // The digest must number turns by their position in session.messages, because
  // generated questions cite `sourceRefs.messageIndex` and the frontend resolves
  // that against the same array. Note the array is post-filter: the tool-result
  // message in the fixture was dropped during normalization, so the first user
  // turn is index 0 here, not 1.
  const idx = session.messages.findIndex((m) => m.text.startsWith('why is the connection'));
  assert.equal(idx, 0, `fixture drift: user turn at ${idx}`);
  assert.ok(digest.text.includes('[turn 0] USER'), 'index 0 not rendered');
  const lastIdx = session.messages.length - 1;
  assert.ok(digest.text.includes(`[turn ${lastIdx}] ASSISTANT`), 'final turn index not rendered');
  // Every rendered index must be a valid index into the array.
  for (const m of digest.text.matchAll(/\[turn (\d+)\]/g)) {
    const i = Number(m[1]);
    assert.ok(i >= 0 && i < session.messages.length, `turn index ${i} out of range`);
  }
});

check('the final assistant turn is given more room than the middle ones', () => {
  // The closing turn holds the outcome, so it gets FINAL_ASSISTANT_CHARS (3000)
  // against ASSISTANT_TURN_CHARS (700) for the rest.
  assert.ok(digest.text.includes('Wrap the session in a context manager'));
});

// ── Project half ───────────────────────────────────────────────────────────

check('files the conversation touched are extracted and classified', () => {
  const touched = extractTouched(session);
  const edited = touched.edited.map(([f]) => f);
  const read = touched.read.map(([f]) => f);
  assert.deepEqual(edited, ['electron-app/src/pool.ts'], `unexpected edited: ${JSON.stringify(edited)}`);
  assert.deepEqual(read, ['electron-app/src/db.ts'], `unexpected read: ${JSON.stringify(read)}`);
  assert.ok(touched.commands.some((c) => c.command.startsWith('npx jest')), 'command not captured');
  assert.ok(touched.searches.some((s) => s.query === 'createEngine'), 'search not captured');
});

check('absolute paths are normalised to repo-relative', () => {
  const touched = extractTouched(session);
  for (const [f] of touched.edited) assert.ok(!f.startsWith('/'), `path not relative: ${f}`);
});

check('the project section names the touched files', () => {
  assert.ok(digest.text.includes('files the conversation MODIFIED'));
  assert.ok(digest.text.includes('src/pool.ts'));
});

check('git history is included and scoped', () => {
  assert.equal(digest.stats.git, true);
  // The commit was made now, inside the session window.
  assert.ok(digest.text.includes('commits made during this session'), 'no commit section');
  assert.ok(digest.text.includes('initial commit'), 'commit subject missing');
});

check('the manifest is found one level down, not just at the root', () => {
  assert.ok(digest.text.includes('electron-app/package.json'), 'nested manifest not found');
  assert.ok(digest.text.includes('synthetic-app'), 'manifest name missing');
});

check('README content is included', () => {
  assert.ok(digest.text.includes('Manages a connection pool'), 'README excerpt missing');
});

check('documentation is not duplicated', () => {
  // README.md is reachable both by name and by a *.md sweep; it used to appear
  // twice, duplicating the excerpt and wasting the section budget.
  const count = (digest.text.match(/--- README\.md ---/g) || []).length;
  assert.equal(count, 1, `README excerpt appears ${count} times`);
});

check('a hardMax is enforced absolutely, whatever the sections did', () => {
  for (const hardMax of [800, 2000, 6000]) {
    const d = buildDigest(session, { hardMax });
    assert.ok(d.stats.chars <= hardMax, `hardMax ${hardMax} exceeded by ${d.stats.chars - hardMax}`);
  }
  const loose = buildDigest(session);
  const capped = buildDigest(session, { hardMax: 1500 });
  assert.ok(capped.stats.chars < loose.stats.chars, 'hardMax did not reduce the output');
});

check('ignored directories are excluded from the tree', () => {
  assert.ok(!digest.text.includes('node_modules'), 'noise directory leaked into the tree');
});

check('the tree marks files the conversation touched', () => {
  assert.ok(digest.text.includes('<- touched'), 'relevant files not marked in the tree');
});

check('uncommitted state is reported correctly when the tree is dirty', () => {
  fs.writeFileSync(path.join(APP, 'src', 'pool.ts'), 'export const pool = new Pool({ max: 40 });\n');
  const after = buildDigest(session);
  assert.ok(after.text.includes('uncommitted'), 'dirty tree not reported');
  // The historical bug: trimming git stdout ate the leading space of the first
  // porcelain line, shifting every field and producing `lectron-app/...`.
  assert.ok(!/^\s+M\s\s\S/.test(after.text), 'porcelain parsing shifted a field');
  assert.ok(after.text.includes('electron-app/src/pool.ts'), 'modified path mangled');
});

// ── Budget behaviour ───────────────────────────────────────────────────────

check('the project section survives a total-budget cut', () => {
  // This is a regression: the project section is emitted last, so a naive
  // truncation of the whole document deleted it and the model lost all context
  // about what the project was.
  const small = buildDigest(session, { budget: { total: 3000, project: 1500 } });
  assert.ok(small.stats.chars <= 3000 + 200, `budget exceeded: ${small.stats.chars}`);
  assert.ok(small.text.includes('## Project context'), 'project heading lost');
  assert.ok(small.text.includes('files the conversation MODIFIED'), 'project body lost');
});

check('a middle truncation keeps both the task statement and the outcome', () => {
  const small = buildDigest(session, { budget: { total: 1200, project: 500 } });
  assert.ok(small.text.includes('why is the connection pool exhausted'), 'opening lost');
  assert.ok(small.text.includes('context manager'), 'outcome lost');
  assert.ok(small.text.includes('chars of the middle'), 'no truncation marker to explain the gap');
});

check('the digest never exceeds the configured total', () => {
  for (const total of [1500, 3000, 8000, 24000]) {
    const d = buildDigest(session, { budget: { total } });
    assert.ok(d.stats.chars <= total + 80, `budget ${total} exceeded by ${d.stats.chars - total}`);
  }
});

check('project context can be disabled entirely', () => {
  const d = buildDigest(session, { project: false });
  assert.equal(d.stats.projectAvailable, false);
  assert.ok(!d.text.includes('commits made during this session'), 'git section present despite project:false');
  assert.ok(d.text.includes('## Conversation'));
});

// ── Determinism and read-only behaviour ────────────────────────────────────

check('the digest is deterministic', () => {
  const a = buildDigest(session).text;
  const b = buildDigest(session).text;
  assert.equal(a, b, 'two runs produced different output');
});

check('building a digest writes nothing to the project', () => {
  const before = execFileSync('git', ['-C', ROOT, 'status', '--porcelain=v1', '-z', '-uall'], { encoding: 'utf8' });
  buildDigest(session);
  const after = execFileSync('git', ['-C', ROOT, 'status', '--porcelain=v1', '-z', '-uall'], { encoding: 'utf8' });
  assert.equal(before, after, 'the digest modified the working tree');
});

check('a session with no working directory degrades without throwing', () => {
  const orphan = { ...session, cwd: undefined, harness: 'claude' };
  const d = buildDigest(orphan);
  assert.ok(d.text.includes('## Project context'));
  assert.equal(d.stats.projectAvailable, false);
  assert.ok(d.text.includes('why is the connection pool exhausted'), 'conversation lost');
});

check('a session whose working directory no longer exists degrades without throwing', () => {
  const gone = { ...session, cwd: '/nonexistent/definitely/not/here' };
  const d = buildDigest(gone);
  assert.equal(d.stats.projectAvailable, false);
  assert.ok(d.text.length > 100);
});

// ── Report ─────────────────────────────────────────────────────────────────

fs.rmSync(ROOT, { recursive: true, force: true });

console.log(`\ndigest: ${passed} passed, ${failures.length} failed\n`);

if (failures.length) {
  for (const f of failures) console.error(`FAIL  ${f.name}\n        ${f.message}`);
  process.exit(1);
}
console.log('All digest assertions passed.\n');
