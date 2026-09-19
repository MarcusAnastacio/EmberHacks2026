#!/usr/bin/env node
// Faithful mock of a VS Code Copilot Chat session store, plus a decoder test.
//
// WHY THIS EXISTS
// ---------------
// Every `chatSessions/*.jsonl` on this machine is empty: VS Code instantiates the
// session (and writes the Initial snapshot) as soon as the chat panel is opened,
// before any message is sent, so the file holds `requests: []`. That means the
// operation-log decoder had no real non-empty input to test against.
//
// This generator emits a byte-faithful log using the exact shapes from VS Code
// source (`objectMutationLog.ts` / `chatSessionOperationLog.ts` / `chatModel.ts`),
// then asserts the reader reconstructs the conversation. It is both the fixture
// and the regression test:
//
//   node test/mock-vscode-chat.js          generate, decode, print, assert
//   node test/mock-vscode-chat.js --raw    also print the raw log lines
//
// Shapes used (verified against microsoft/vscode@main):
//   EntryKind: Initial=0, Set=1, Push=2, Delete=3
//   Push with `i` truncates the array to `i` before appending  <- how streaming
//     response parts are re-serialised; a decoder that ignores `i` duplicates text.
//   Delete sets the path to `undefined` (it does not splice).
//   A markdown response part serialises to a bare IMarkdownString, i.e. `{value}`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

import { readStoreFile } from '../readers/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Reproduce the real on-disk layout, not just the file:
//   <root>/workspaceStorage/<hash>/workspace.json          <- workspace identity
//   <root>/workspaceStorage/<hash>/chatSessions/<id>.jsonl <- the operation log
// Laying it out this way means the test also covers the workspace.json lookup that
// turns a storage hash into a readable project name in the sidebar.
const STORAGE_ROOT = path.join(HERE, 'fixtures', 'workspaceStorage');
const WORKSPACE_HASH = 'mock0hash0for0copilot0chat0fixture00';
const SESSION_ID = '2a1c694c-1bdc-4627-879c-df3688a585da';
const WORKSPACE_FOLDER = 'file:///home/dev/code/amazon-bedrock-workshop';
const EXPECTED_PROJECT = 'amazon-bedrock-workshop';

const WORKSPACE_DIR = path.join(STORAGE_ROOT, WORKSPACE_HASH);
const OUT_FILE = path.join(WORKSPACE_DIR, 'chatSessions', `${SESSION_ID}.jsonl`);
const META_FILE = path.join(WORKSPACE_DIR, 'workspace.json');

const T0 = 1779938209302; // matches the real empty session's creationDate shape
const at = (s) => T0 + s * 1000;

/** A request as `ISerializableChatRequestData` serialises it. */
function request({ id, text, response, seconds, agent = 'github.copilot.editingAgent' }) {
  return {
    requestId: id,
    message: { text, parts: [{ kind: 'text', text }] },
    variableData: { variables: [] },
    response,
    timestamp: at(seconds),
    modelId: 'copilot/auto',
    agent: { id: agent, name: 'GitHub Copilot' },
    modeInfo: { kind: 'agent', modeInstructions: '' },
  };
}

/** A completed assistant markdown part. Serialises to a bare IMarkdownString. */
const md = (value) => ({ value });

/** A tool invocation part keeps its `kind` because it is not markdownContent. */
const tool = (toolId, invocationMessage, pastTenseMessage, seconds) => ({
  kind: 'toolInvocationSerialized',
  toolCallId: `call_${seconds}`,
  toolId,
  invocationMessage: { value: invocationMessage },
  pastTenseMessage: { value: pastTenseMessage },
  isComplete: true,
  source: { type: 'internal' },
});

/**
 * Build the operation log. `streaming` reproduces how VS Code rewrites a response
 * part while the answer arrives: first a short value at index 0, then the same
 * index replaced with the full text.
 */
function buildLog() {
  const lines = [];

  // --- Initial snapshot. Identical in shape to the real empty sessions. -----
  lines.push({
    kind: 0,
    v: {
      version: 3,
      creationDate: T0,
      initialLocation: 'panel',
      responderUsername: 'GitHub Copilot',
      sessionId: 'mocksession0reg4chat5vscode6oplog7fixture8',
      hasPendingEdits: false,
      requests: [],
      pendingRequests: [],
      inputState: {
        attachments: [],
        mode: { id: 'agent', kind: 'agent' },
        selectedModel: { identifier: 'copilot/auto', metadata: { id: 'auto', vendor: 'copilot', name: 'Auto' } },
        inputText: '',
        selections: [],
        permissionLevel: 'default',
      },
    },
  });

  // --- A scalar Set: the user renamed the chat. -----------------------------
  lines.push({ kind: 1, k: ['customTitle'], v: 'Connection pool exhaustion' });

  // --- A queued message that was later processed, then removed. ------------
  // Demonstrates Delete: VS Code sets the path to undefined rather than splicing.
  lines.push({ kind: 2, k: ['pendingRequests'], v: [{ id: 'pending-1', message: { text: 'and the fix?' } }] });
  lines.push({ kind: 3, k: ['pendingRequests'] });

  // --- Request 0 ------------------------------------------------------------
  lines.push({
    kind: 2,
    k: ['requests'],
    v: [request({
      id: 'req-0',
      text: 'why is the connection pool exhausted?',
      response: [],
      seconds: 4,
    })],
  });

  // Streaming: index 0 is written short, then truncated and rewritten full.
  lines.push({ kind: 2, k: ['requests', 0, 'response'], v: [md('The pool is exhaust')] });
  lines.push({ kind: 2, k: ['requests', 0, 'response'], i: 0, v: [md('The pool is exhausted because each worker opens its own session.')] });

  // A tool call appended at index 1.
  lines.push({
    kind: 2,
    k: ['requests', 0, 'response'],
    i: 1,
    v: [tool('copilot_readFile', 'Reading app/db.py', 'Read app/db.py', 6)],
  });

  // The final answer appended at index 2, then rewritten in place.
  lines.push({ kind: 2, k: ['requests', 0, 'response'], i: 2, v: [md('Found it. `db.py:41` opens a session per request but returns early on the error path without closing it.')] });
  lines.push({
    kind: 2,
    k: ['requests', 0, 'response'],
    i: 2,
    v: [md('Found it. `db.py:41` opens a session per request but returns early on the error path without closing it. Wrap it in a context manager.')],
  });

  // --- Request 1 ------------------------------------------------------------
  lines.push({
    kind: 2,
    k: ['requests'],
    v: [request({
      id: 'req-1',
      text: 'what does the context manager change?',
      response: [],
      seconds: 40,
    })],
  });
  lines.push({ kind: 2, k: ['requests', 1, 'response'], i: 0, v: [md('It commits on success and rolls back on any exception.')] });
  lines.push({ kind: 2, k: ['requests', 1, 'response'], i: 0, v: [md('It commits on success and rolls back on any exception, then closes the session.')] });
  lines.push({ kind: 2, k: ['requests', 1, 'response'], i: 1, v: [tool('copilot_applyPatch', 'Editing app/db.py', 'Edited app/db.py', 44)] });
  lines.push({
    kind: 2,
    k: ['requests', 1, 'response'],
    i: 2,
    v: [md('With a pool size of 20 that stops the leak from ever reaching the ceiling.')],
  });

  // --- Request 2: a follow-up that the user cancelled. ----------------------
  lines.push({
    kind: 2,
    k: ['requests'],
    v: [request({
      id: 'req-2',
      text: 'can you also add a metric for in-use connections?',
      response: [],
      seconds: 90,
    })],
  });
  lines.push({ kind: 2, k: ['requests', 2, 'response'], v: [md('Yes - add a gauge next to the existing pool metrics:')] });
  lines.push({ kind: 1, k: ['requests', 2, 'modelState'], v: { value: 3, completedAt: at(96) } });
  lines.push({
    kind: 2,
    k: ['requests', 2, 'response'],
    i: 1,
    v: [md('```python\npool_in_use.labels(shard=shard).set(pool.checkedout())\n```\nEmit it from the same poller that already reports pool size.')],
  });

  // --- Request 3: assistant explained a decision, no tool use. -------------
  lines.push({
    kind: 2,
    k: ['requests'],
    v: [request({
      id: 'req-3',
      text: 'why not just raise the pool size?',
      response: [],
      seconds: 140,
    })],
  });
  lines.push({ kind: 2, k: ['requests', 3, 'response'], v: [md('Raising the ceiling hides the leak instead of fixing it.')] });
  lines.push({
    kind: 2,
    k: ['requests', 3, 'response'],
    i: 0,
    v: [md('Raising the ceiling hides the leak instead of fixing it, and each connection costs a backend slot. The leak is bounded per worker, so the pool fills linearly with traffic rather than plateauing.')],
  });

  // --- A response part the user hid, then unhid via Delete. ----------------
  lines.push({ kind: 1, k: ['requests', 3, 'hiddenFromTranscript'], v: true });
  lines.push({ kind: 3, k: ['requests', 3, 'hiddenFromTranscript'] });

  // --- Later mutation of the input draft state. ----------------------------
  lines.push({ kind: 1, k: ['inputState', 'inputText'], v: 'thanks, that fixed it' });
  lines.push({ kind: 2, k: ['requests', 0, 'editedFileEvents'], v: [{ uri: 'file:///app/db.py', outcome: 'success' }] });

  return lines;
}

function writeFixture() {
  const lines = buildLog();
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8');
  // The sibling metadata file VS Code writes next to every workspace's storage.
  fs.writeFileSync(META_FILE, JSON.stringify({ folder: WORKSPACE_FOLDER }, null, 2), 'utf8');
  return lines;
}

/** Assert the decoder rebuilt exactly the conversation the log describes. */
function verify(session) {
  assert.ok(session, 'decoder returned no session');
  assert.equal(session.harness, 'copilot-chat');
  assert.equal(session.source, 'vscode');
  assert.equal(session.title, 'Connection pool exhaustion', 'customTitle Set was not applied');
  assert.equal(
    session.project,
    EXPECTED_PROJECT,
    `workspace.json lookup failed: project is ${JSON.stringify(session.project)}`,
  );
  assert.equal(session.cwd, WORKSPACE_FOLDER.replace('file://', ''), 'cwd was not resolved from workspace.json');
  assert.equal(session.messages.length, 8, `expected 8 messages, got ${session.messages.length}`);
  assert.equal(session.userTurns, 4, `expected 4 user turns, got ${session.userTurns}`);

  const roles = session.messages.map((m) => m.role);
  assert.deepEqual(roles, ['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant']);

  // The streaming rewrite must leave the FULL text, not the partial prefix, and
  // must not duplicate it.
  const first = session.messages[1].text;
  assert.match(first, /Wrap it in a context manager/, 'streaming rewrite lost the final text');
  assert.ok(!first.includes('The pool is exhaust\n'), 'partial streaming value leaked into the result');
  assert.equal(first.match(/The pool is exhausted/g)?.length, 1, 'streaming rewrite duplicated text');

  // Tool results are dropped, tool names survive.
  assert.ok(!/app\/db\.py'|Read app\/db\.py/.test(first), 'tool plumbing leaked into the text');

  // Delete must clear the path; the pendingRequest must not become a message.
  assert.equal(session.messages.filter((m) => m.text.includes('and the fix?')).length, 0, 'deleted pendingRequest became a message');

  // Assistant turns land at 2*requestIndex + 1.
  const second = session.messages[3]; // request 1's assistant: two markdown parts + a tool between them
  assert.match(second.text, /then closes the session/, 'in-place rewrite in request 1 failed');
  assert.match(second.text, /stops the leak from ever reaching the ceiling/, 'part after the tool call was lost');
  assert.ok(
    !second.text.includes('It commits on success and rolls back on any exception.\n'),
    'partial streaming value leaked into request 1',
  );

  const fourth = session.messages[7]; // request 3's assistant: closed by an in-place rewrite
  assert.match(fourth.text, /plateauing/, 'in-place rewrite of request 3 failed');
  assert.equal(session.messages.filter((m) => m.text.includes('draft')).length, 0);

  // The rewritten draft input must not leak in as a turn.
  assert.equal(session.messages.filter((m) => m.text.includes('thanks, that fixed it')).length, 0);
}

// --- run ---------------------------------------------------------------------

const showRaw = process.argv.includes('--raw');
const lines = writeFixture();

const { sessions, skipped } = readStoreFile(OUT_FILE, {
  harness: 'copilot-chat',
  harnessName: 'VS Code Copilot Chat',
  formatKind: 'json-or-jsonl',
});
assert.equal(skipped, undefined, `reader skipped the file: ${skipped}`);
const session = sessions[0];
verify(session);

console.log(`\nGenerated ${lines.length} log lines -> test/fixtures/workspaceStorage/${WORKSPACE_HASH}/chatSessions/`);
console.log(`(${fs.statSync(OUT_FILE).size} bytes, plus the sibling workspace.json)\n`);

if (showRaw) {
  console.log('--- raw operation log (first 50 lines) ---');
  fs.readFileSync(OUT_FILE, 'utf8')
    .split('\n')
    .slice(0, 50)
    .forEach((l, i) => {
      const truncated = l.length > 150 ? `${l.slice(0, 150)}…` : l;
      console.log(`${String(i + 1).padStart(2)}  ${truncated}`);
    });
  console.log();
}

console.log('--- decoded by readers/json.js + normalize.js ---');
console.log(`harness : ${session.harnessName}   project: ${session.project}   source: ${session.source}`);
console.log(`title   : ${session.title}`);
console.log(`counts  : ${session.messages.length} messages, ${session.userTurns} user turns, ${session.chars} chars\n`);
for (const m of session.messages) {
  const tools = m.tools?.length ? `  [tools: ${m.tools.map((t) => t.name).join(', ')}]` : '';
  console.log(`  ${m.role.padEnd(9)}${tools}`);
  for (const line of m.text.split('\n')) console.log(`            ${line}`);
  console.log();
}

console.log('All assertions passed.');
