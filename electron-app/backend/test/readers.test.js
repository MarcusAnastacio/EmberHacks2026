#!/usr/bin/env node
// Reader routing and per-format parsing tests.
//
// Every case here is a bug that the compatibility sweep (`npm run compat`) found by
// running a real sample store through the full path. They are pinned because each
// one was silent: the format appeared in the list of supported agents while its
// user turns, or its assistant turns, were being discarded.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readStoreFile } from '../readers/index.js';

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

const FIXTURES = fileURLToPath(new URL('../fixtures', import.meta.url));
const read = (rel, ctx) =>
  readStoreFile(path.join(FIXTURES, rel), { harness: 'test', harnessName: 'test', ...ctx });

// ── Routing ────────────────────────────────────────────────────────────────

check('a .jsonl file is read as text even when the store declares a sqlite format', () => {
  // Cursor declares `sqlite-kv-or-jsonl` because the IDE keeps a SQLite KV store and
  // ALSO writes agent transcripts as JSONL. Keying on the declared format sent the
  // transcripts to the SQLite reader, which emitted a placeholder instead of the
  // conversation.
  const result = read('cursor/projects/registry-demo/agent-transcripts/registry-cursor.jsonl', {
    formatKind: 'sqlite-kv-or-jsonl',
  });
  const session = result.sessions[0];
  assert.ok(session, 'no session');
  assert.deepEqual(session.messages.map((m) => m.role), ['user', 'assistant']);
  assert.ok(!session.messages[0].text.startsWith('[Detected'), 'took the SQLite path');
});

check('a .db file still goes to the SQLite reader', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-'));
  const file = path.join(dir, 'store.db');
  fs.writeFileSync(file, 'not really a database');
  const result = readStoreFile(file, { harness: 'x', harnessName: 'x', formatKind: 'sqlite' });
  // Unreadable as SQLite, so it yields nothing or a placeholder — but it must not be
  // parsed as text and must not throw.
  assert.ok(Array.isArray(result.sessions));
  fs.rmSync(dir, { recursive: true, force: true });
});

check('a .sql dump goes to the script reader, not the SQLite file reader', () => {
  const result = read('opencode/opencode.sql', { formatKind: 'sqlite' });
  // The text lives in a sibling `part` table this reader does not join, so the honest
  // outcome is a placeholder rather than nothing at all.
  assert.ok(result.sessions.length >= 1, 'the store disappeared entirely');
  assert.ok(result.sessions[0].partial, 'expected a partial placeholder');
});

// ── aider ──────────────────────────────────────────────────────────────────

check('aider user turns come from "#### ", not from raw markdown', () => {
  // aider's own writer uses `prefix = "####"` for the user's input. Treating `#### `
  // as assistant text discarded every user turn in every aider session.
  const session = read('aider/.aider.chat.history.md', { formatKind: 'markdown-log' }).sessions[0];
  assert.deepEqual(
    session.messages.map((m) => m.role),
    ['user', 'assistant'],
  );
  assert.equal(session.messages[0].text, 'inspect the markdown history');
  assert.equal(session.messages[1].text, 'The history is readable.');
});

check('aider: a multi-line user input is one turn, and "> " output is not speech', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aider-'));
  const file = path.join(dir, '.aider.chat.history.md');
  fs.writeFileSync(
    file,
    [
      '# aider chat started at 2026-07-17 09:00:00',
      '',
      '#### first line of the question',
      '#### second line of the same question',
      '',
      '> uv run pytest',
      '> tests failed with exit code 1',
      '',
      'The answer follows the tool block.',
      '',
    ].join('\n'),
  );
  const session = readStoreFile(file, { harness: 'aider', harnessName: 'aider', formatKind: 'markdown-log' })
    .sessions[0];
  assert.deepEqual(session.messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(
    session.messages[0].text,
    'first line of the question\nsecond line of the same question',
    'consecutive "#### " lines are not one turn',
  );
  assert.ok(!session.messages[1].text.includes('pytest'), 'tool output leaked into the transcript');
  assert.ok(session.messages[1].text.startsWith('The answer follows'), 'assistant text lost');
  fs.rmSync(dir, { recursive: true, force: true });
});

check('aider: a prefix inside a fenced block is code, not structure', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aider-'));
  const file = path.join(dir, '.aider.chat.history.md');
  fs.writeFileSync(
    file,
    [
      '# aider chat started at 2026-07-17 09:00:00',
      '',
      '#### show me the format',
      '',
      'Here it is:',
      '',
      '```',
      '#### this is inside a fence and must not start a turn',
      '> nor is this tool output',
      '```',
      '',
    ].join('\n'),
  );
  const session = readStoreFile(file, { harness: 'aider', harnessName: 'aider', formatKind: 'markdown-log' })
    .sessions[0];
  assert.equal(session.messages.length, 2, `expected 2 messages, got ${session.messages.length}`);
  assert.ok(session.messages[1].text.includes('must not start a turn'), 'fence contents were dropped');
  assert.ok(session.messages[1].text.includes('nor is this tool output'), 'fence contents were split');
  fs.rmSync(dir, { recursive: true, force: true });
});

check('aider: the banner before the first turn is not speech', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aider-'));
  const file = path.join(dir, '.aider.chat.history.md');
  fs.writeFileSync(file, '# aider chat started at 2026-07-17 09:00:00\n\n#### hello\n\nhi\n');
  const session = readStoreFile(file, { harness: 'aider', harnessName: 'aider', formatKind: 'markdown-log' })
    .sessions[0];
  assert.equal(session.messages.length, 2);
  assert.ok(!session.messages.some((m) => m.text.includes('aider chat started')), 'banner became a message');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Antigravity ────────────────────────────────────────────────────────────

check('antigravity: the speaker is in "source", including USER_EXPLICIT', () => {
  // Only `MODEL` matched a known role, so every user turn was dropped and the
  // transcript read as the model talking to itself.
  const session = read('antigravity/brain/registry-antigravity/.system_generated/logs/transcript.jsonl', {
    formatKind: 'jsonl',
  }).sessions[0];
  assert.deepEqual(session.messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(session.userTurns, 1);
});

check('antigravity: the XML wrappers are stripped and the metadata is not speech', () => {
  const session = read('antigravity/brain/registry-antigravity/.system_generated/logs/transcript.jsonl', {
    formatKind: 'jsonl',
  }).sessions[0];
  const user = session.messages[0].text;
  assert.equal(user, 'inspect the antigravity transcript', `wrappers survived: ${JSON.stringify(user)}`);
  assert.ok(!user.includes('ADDITIONAL_METADATA'), 'metadata leaked into the text');
  // The metadata is where the working directory lives, so it is read before being dropped.
  assert.equal(session.cwd, '/workspace/registry-demo');
});

// ── Gemini CLI ─────────────────────────────────────────────────────────────

check('gemini: an assistant turn typed "gemini" is kept', () => {
  // The Gemini CLI types assistant turns as `gemini` and stores content at the top
  // level, both of which were unrecognised — so only the user's half survived.
  const session = read('gemini/session.jsonl', { formatKind: 'json-or-jsonl' }).sessions[0];
  assert.deepEqual(session.messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(session.messages[1].text, 'the session is readable');
});

// ── Kimi ───────────────────────────────────────────────────────────────────

check('kimi: the streamed answer is reassembled and think parts are not kept', () => {
  const session = read('kimi/sessions/wd_demo_0123456789ab/session_fixture01/agents/main/wire.jsonl', {
    formatKind: 'jsonl',
  }).sessions[0];
  assert.deepEqual(session.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(session.userTurns, 2, 'both user turns should survive');
  const all = session.messages.map((m) => m.text).join('\n');
  assert.ok(!all.includes('reasoning to be skipped'), 'a think part was kept as answer text');
  assert.ok(all.includes('The cache keeps serving the old kid'), 'the streamed answer was lost');
  assert.ok(session.reasoningChars > 0, 'dropped reasoning was not counted');
});

// ── Report ─────────────────────────────────────────────────────────────────

console.log(`\nreaders: ${passed} passed, ${failures.length} failed\n`);

if (failures.length) {
  for (const f of failures) console.error(`FAIL  ${f.name}\n        ${f.message}`);
  process.exit(1);
}
console.log('All reader assertions passed.\n');
