#!/usr/bin/env node
// Format compatibility sweep.
//
// Runs every bundled fixture store through the full path — reader -> normalize ->
// topics -> digest -> plan — and reports which agents produce a readable
// conversation. The fixtures are real sample stores from 33 agents, so this checks
// format-agnosticism without installing anything.
//
//   npm run compat
//
// This is the tool that found the Cursor routing bug, the aider prefix bug, the
// Antigravity role bug, the Gemini assistant-type bug and the Kimi extractor gap.
// Run it after touching anything in readers/.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRegistry } from '../detect.js';
import { readStoreFile } from '../readers/index.js';
import { buildDigest } from '../lib/digest.js';
import { deriveTopics } from '../lib/topics.js';
import { assessReadiness } from '../lib/quiz.js';
import { walkFiles } from '../lib/expand.js';

const FIXTURES = fileURLToPath(new URL('../fixtures', import.meta.url));
const ALIAS = { claude: 'claude-code', copilot_chat: 'copilot-chat' };

const isPlaceholder = (s) => (s.messages[0]?.text || '').startsWith('[Detected');

const rows = [];

for (const entry of loadRegistry()) {
  const dir = path.join(FIXTURES, ALIAS[entry.id] || entry.id);
  let files = [];
  try {
    files = walkFiles(dir);
  } catch {
    rows.push({ id: entry.id, name: entry.display_name || entry.id, sessions: 0 });
    continue;
  }

  const sessions = [];
  for (const file of files) {
    try {
      const result = readStoreFile(file, {
        harness: entry.id,
        harnessName: entry.display_name || entry.id,
        formatKind: entry.format_kind,
        nativeId: file,
      });
      if (result.sessions?.length) sessions.push(...result.sessions);
    } catch {
      /* counted as a failure to parse this file */
    }
  }

  if (sessions.length === 0) {
    rows.push({ id: entry.id, name: entry.display_name || entry.id, sessions: 0 });
    continue;
  }

  // A placeholder is honest output for a store we can open but not decode. It is
  // not a usable conversation, so it must not be the representative sample.
  const real = sessions.filter((s) => !isPlaceholder(s) && s.userTurns > 0);
  const representative = (real.length ? real : sessions).sort((a, b) => b.chars - a.chars)[0];

  const digest = buildDigest(representative, { project: false });
  const topics = deriveTopics(representative);
  const readiness = assessReadiness(representative, { types: ['mcq'] });

  rows.push({
    id: entry.id,
    name: entry.display_name || entry.id,
    sessions: sessions.length,
    placeholders: sessions.filter(isPlaceholder).length,
    msgs: representative.messages.length,
    chars: representative.chars,
    userTurns: representative.userTurns,
    digest: digest.stats.chars,
    topics: topics.stats.topics,
    readiness: readiness.level,
    usable:
      !isPlaceholder(representative) &&
      /\[turn \d+\] USER/.test(digest.text) &&
      /\[turn \d+\] ASSISTANT/.test(digest.text),
    decodeFailed: real.length === 0 && sessions.some(isPlaceholder),
  });
}

// ── Report ─────────────────────────────────────────────────────────────────

const pad = (v, n) => String(v ?? '-').padStart(n);
console.log('\nFORMAT                        SESS  PH  MSGS  CHARS  USER  TOPICS  READY  DIGEST');
console.log('-'.repeat(84));
for (const r of rows.sort((a, b) => (b.sessions || 0) - (a.sessions || 0) || a.id.localeCompare(b.id))) {
  console.log(
    String(r.name).slice(0, 28).padEnd(29) +
      pad(r.sessions, 4) + pad(r.placeholders, 4) + pad(r.msgs, 6) + pad(r.chars, 7) +
      pad(r.userTurns, 6) + pad(r.topics, 8) + String(r.readiness || '-').padStart(8) + pad(r.digest, 8),
  );
}
console.log('-'.repeat(84));

const usable = rows.filter((r) => r.usable);
const missing = rows.filter((r) => r.sessions === 0);
const undecoded = rows.filter((r) => r.decodeFailed && !r.usable);
const partial = rows.filter((r) => r.sessions > 0 && !r.usable && !r.decodeFailed);

console.log(`\nreadable conversation (user + assistant): ${usable.length}/${rows.length}`);
if (missing.length) console.log(`no fixture at all:        ${missing.map((r) => r.id).join(', ')}`);
if (undecoded.length) console.log(`detected, not decoded:    ${undecoded.map((r) => r.id).join(', ')}`);
if (partial.length) console.log(`parsed but incomplete:    ${partial.map((r) => r.id).join(', ')}`);

if (partial.length) {
  console.log('\nparsed but incomplete is a BUG unless the store genuinely holds only one side:');
  for (const r of partial) console.log(`  ${r.id}: ${r.msgs} messages, ${r.userTurns} user turns`);
  process.exitCode = 1;
}
console.log();
