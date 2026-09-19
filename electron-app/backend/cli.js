#!/usr/bin/env node
// Dev harness for the compatibility layer — no Electron required.
//
//   node cli.js                 scan and print the sidebar table
//   node cli.js --json          dump the catalog as JSON
//   node cli.js --only pi,codex restrict to harness ids
//   node cli.js --show <id>     print one normalized session
//   node cli.js --payload <id>  print the exact Gemini payload
//
// This doubles as the demo script if the Electron shell is not ready.

import { CompatibilityLayer } from './index.js';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(name);

const fixtures = has("--fixtures");
const only = flag('--only')?.split(',').map((s) => s.trim()).filter(Boolean);
const layer = new CompatibilityLayer();

if (has('--progress')) {
  layer.on('progress', (e) => {
    if (e.phase === 'harness-done' && e.files > 0) {
      process.stderr.write(`  ✓ ${e.name}: ${e.sessions} sessions / ${e.files} files\n`);
    }
  });
}

const t0 = Date.now();
const catalog = await layer.refresh({ only, fixtures, maxPerHarness: Number(flag('--max', 200)) });
const ms = Date.now() - t0;

if (has('--json')) {
  console.log(JSON.stringify(layer.list(), null, 2));
  process.exit(0);
}

if (flag('--show')) {
  const s = layer.getSession(flag('--show'));
  if (!s) {
    console.error('not found');
    process.exit(1);
  }
  console.log(`${s.harnessName} · ${s.project} · ${s.title}`);
  console.log(`${s.messages.length} messages, ${s.userTurns} user turns, ${s.chars} chars`);
  console.log(`source: ${s.path}\n`);
  for (const m of s.messages.slice(0, Number(flag('--n', 12)))) {
    const tools = m.tools?.length ? ` [tools: ${m.tools.map((t) => t.name).join(', ')}]` : '';
    console.log(`--- ${m.role}${tools} ---`);
    console.log(m.text.slice(0, 600));
    console.log();
  }
  process.exit(0);
}

if (flag('--digest')) {
  const d = layer.digest(flag('--digest'), {
    project: !has('--no-project'),
    budget: flag('--digest-budget') ? { total: Number(flag('--digest-budget')) } : undefined,
  });
  if (!d) {
    console.error('not found');
    process.exit(1);
  }
  console.log(d.text);
  console.error(`\n--- digest stats: ${JSON.stringify(d.stats)}\n--- sections: ${JSON.stringify(d.sections)}`);
  process.exit(0);
}

if (flag('--payload')) {
  console.log(JSON.stringify(layer.quizPayload(flag('--payload')), null, 2));
  process.exit(0);
}

// --- default: the sidebar table -------------------------------------------

const report = layer.list();
const pad = (s, n) => String(s).padEnd(n);

console.log(`\nScan finished in ${ms}ms   home=${catalog.home}`);
console.log(
  `SQLite decoding: ${catalog.sqlite.available ? 'available' : `UNAVAILABLE (${catalog.sqlite.reason})`}\n`,
);

console.log(pad('HARNESS', 22) + pad('FILES', 7) + pad('SESSIONS', 10) + pad('QUIZ-READY', 12) + 'DETECTED STORES');
console.log('-'.repeat(110));

for (const h of catalog.harnesses) {
  if (!h.detected) continue;
  const name = h.note ? `${h.name} *` : h.name;
  console.log(
    pad(name, 22) +
      pad(h.fileCount, 7) +
      pad(h.sessionCount, 10) +
      pad(h.quizReady, 12) +
      (h.stores[0] || ''),
  );
}

const absent = catalog.harnesses.filter((h) => !h.detected).map((h) => h.name);
console.log('-'.repeat(110));
console.log(
  `\n${catalog.detectedHarnesses}/${catalog.totalHarnesses} harnesses detected · ` +
    `${report.totalSessions} sessions · ${report.quizReady} quiz-ready`,
);
if (absent.length) console.log(`Not installed: ${absent.join(', ')}`);

const skipped = catalog.harnesses.filter((h) => h.skippedCount > 0);
if (skipped.length) {
  console.log('\nFiles found but not parsed:');
  for (const h of skipped) {
    console.log(`  ${h.name} (${h.skippedCount}):`);
    for (const s of h.skipped.slice(0, 3)) console.log(`    - ${s.reason} :: ${s.path}`);
  }
}

console.log('\nRun with --show <id> to inspect a session, --json for the full catalog.');
