#!/usr/bin/env node
// Topic segmentation tests.
//
// The claims being tested are narrow and checkable:
//   * segmentation is DETERMINISTIC — same input, same output, always
//   * a subject change is found without any model involvement
//   * a topic label is the opening user turn, not a generated phrase
//   * message ranges are indices into session.messages (the sourceRefs contract)
//   * every slice respects maxChars — this is the bound that makes the whole
//     pipeline safe to run, so it is asserted across session sizes
//   * the same session always yields the same topics, so a cache key is stable

import assert from 'node:assert/strict';

import { deriveTopics, topicSlice, topicSlices } from '../lib/topics.js';
import { finalizeSession } from '../lib/normalize.js';

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

const T0 = Date.UTC(2026, 2, 14, 10, 0);
const at = (min) => T0 + min * 60_000;

/** A session with two unmistakable subjects, separated by files, words and time. */
function twoSubjectSession() {
  return finalizeSession({
    harness: 'pi',
    harnessName: 'pi',
    nativeId: 'topics-test',
    project: 'demo',
    title: 'pool then cache',
    cwd: '/tmp/demo',
    started: at(0),
    updated: at(120),
    messages: [
      { role: 'user', text: 'The connection pool is exhausted under load. Investigate the pool configuration and find the leak.', ts: at(0) },
      {
        role: 'assistant',
        text: 'The pool leaks because the error path never releases the client.',
        ts: at(2),
        tools: [
          { name: 'read', input: { path: 'src/db.ts' } },
          { name: 'edit', input: { path: 'src/pool.ts' } },
        ],
      },
      { role: 'user', text: 'Apply the fix and run the pool tests to confirm the connection leak is gone.', ts: at(6) },
      {
        role: 'assistant',
        text: 'Applied. Wrapping acquisition in try/finally releases the connection on every path.',
        ts: at(9),
        tools: [{ name: 'write', input: { path: 'src/db.ts' } }],
      },
      // --- different subject, different files, 60 minute gap, transition marker
      { role: 'user', text: 'Separately, the response cache is serving stale widget prices for a minute after an update.', ts: at(90) },
      {
        role: 'assistant',
        text: 'The TTL is 60 seconds. Better to invalidate on write than to shorten the timer.',
        ts: at(95),
        tools: [
          { name: 'read', input: { path: 'src/cache.ts' } },
          { name: 'edit', input: { path: 'src/cache.ts' } },
        ],
      },
    ],
  });
}

// ── Determinism ────────────────────────────────────────────────────────────

check('segmentation is deterministic', () => {
  const s = twoSubjectSession();
  const a = JSON.stringify(deriveTopics(s));
  const b = JSON.stringify(deriveTopics(s));
  assert.equal(a, b, 'two runs produced different topics');
});

check('no model or network is consulted (result contains only derived data)', () => {
  const { topics, stats } = deriveTopics(twoSubjectSession());
  for (const t of topics) {
    assert.equal(typeof t.label, 'string');
    assert.equal(typeof t.score, 'number');
    assert.deepEqual(Object.keys(t).filter((k) => /summary|generated|llm|model/i.test(k)), ['summary']);
  }
  assert.match(stats.strategy, /deterministic/);
});

// ── Finding the boundary ───────────────────────────────────────────────────

check('a subject change is found without help', () => {
  const { topics } = deriveTopics(twoSubjectSession());
  assert.ok(topics.length >= 2, `expected at least 2 topics, got ${topics.length}`);
  const labels = topics.map((t) => t.label).join(' | ');
  assert.ok(/cache/i.test(labels), `the cache topic was not separated: ${labels}`);
});

check('labels come from the opening user turn, verbatim', () => {
  const { topics } = deriveTopics(twoSubjectSession());
  for (const t of topics) {
    const firstUser = t.userTurns[0];
    assert.ok(firstUser, `topic ${t.id} has no user turn`);
    // The label is a prefix of the opening user turn, trimmed at a word boundary.
    const stem = t.label.replace(/…$/, '').trim();
    assert.ok(
      firstUser.startsWith(stem),
      `label is not the user's own words: ${JSON.stringify(t.label)} vs ${JSON.stringify(firstUser.slice(0, 60))}`,
    );
  }
});

check('a topic carries the files and tools of its own turns', () => {
  const { topics } = deriveTopics(twoSubjectSession());
  const cache = topics.find((t) => /cache/i.test(t.label));
  const pool = topics.find((t) => /pool/i.test(t.label));
  assert.ok(cache.files.some((f) => f.includes('cache.ts')), `cache topic files: ${cache.files}`);
  assert.ok(pool.files.some((f) => /db|pool/.test(f)), `pool topic files: ${pool.files}`);
});

check('message ranges are indices into session.messages (sourceRefs contract)', () => {
  const s = twoSubjectSession();
  const { topics } = deriveTopics(s);
  for (const t of topics) {
    assert.equal(t.messageRanges.length, 1);
    const [from, to] = t.messageRanges[0];
    assert.ok(from >= 0 && to < s.messages.length, `range ${from}-${to} out of bounds`);
    assert.ok(from <= to, `inverted range ${from}-${to}`);
    assert.equal(t.from, from, 'from disagrees with messageRanges');
    assert.equal(t.to, to, 'to disagrees with messageRanges');
    assert.equal(s.messages[from].role, 'user', `topic ${t.id} does not start on a user turn`);
  }
});

check('topics are returned in chronological order', () => {
  const { topics } = deriveTopics(twoSubjectSession());
  for (let i = 1; i < topics.length; i++) {
    assert.ok(topics[i].from > topics[i - 1].to, `topics ${i - 1} and ${i} overlap or are unordered`);
  }
});

check('topic turn ranges cover every message exactly once', () => {
  const s = twoSubjectSession();
  const { topics } = deriveTopics(s, { maxTopics: 50 });
  const covered = [];
  for (const t of topics) {
    const [from, to] = t.messageRanges[0];
    for (let i = from; i <= to; i++) covered.push(i);
  }
  const unique = new Set(covered);
  assert.equal(unique.size, covered.length, 'a message appears in more than one topic');
  const firstUser = s.messages.findIndex((m) => m.role === 'user');
  assert.equal(Math.min(...covered), firstUser, 'the session does not start at the first user turn');
  assert.equal(Math.max(...covered), s.messages.length - 1, 'the session does not end at the last message');
});

// ── Bounds: the property that makes the pipeline safe ──────────────────────

check('every slice respects maxChars', () => {
  for (const maxChars of [500, 1200, 4000, 12000]) {
    const { slices } = topicSlices(twoSubjectSession(), { maxChars, maxTopics: 40 });
    for (const s of slices) {
      // The truncation marker is appended after the cut, so allow a small slack.
      assert.ok(s.chars <= maxChars + 120, `slice ${s.topicId} is ${s.chars} chars, cap ${maxChars}`);
    }
  }
});

check('a slice never exceeds the cap even when the topic is enormous', () => {
  // Build one very long topic and confirm the cap is a cap, not a target.
  const big = finalizeSession({
    harness: 'pi',
    harnessName: 'pi',
    nativeId: 'big',
    project: 'demo',
    started: at(0),
    updated: at(10),
    messages: [
      { role: 'user', text: 'Investigate the pool leak in src/db.ts and fix it properly.', ts: at(0) },
      { role: 'assistant', text: 'x'.repeat(400_000), ts: at(1), tools: [{ name: 'edit', input: { path: 'src/db.ts' } }] },
    ],
  });
  const { slices, stats } = topicSlices(big, { maxChars: 2000 });
  assert.ok(slices.length >= 1);
  assert.ok(stats.largestSlice <= 2120, `largest slice ${stats.largestSlice} exceeds the cap`);
  assert.ok(slices[0].truncated > 0, 'a 400k-char turn should have been truncated');
});

check('the number of prompts is bounded by maxTopics', () => {
  const { slices, stats } = topicSlices(twoSubjectSession(), { maxTopics: 2 });
  assert.ok(slices.length <= 2, `produced ${slices.length} slices for maxTopics 2`);
  assert.equal(stats.promptCount, slices.length);
  assert.equal(stats.maxCharsPerPrompt, 12000);
});

check('a session with no user turns produces no topics and does not throw', () => {
  const empty = finalizeSession({
    harness: 'pi',
    harnessName: 'pi',
    nativeId: 'no-turns',
    project: 'demo',
    started: at(0),
    updated: at(1),
    messages: [{ role: 'assistant', text: 'nothing was asked', ts: at(0) }],
  });
  const result = deriveTopics(empty);
  assert.equal(result.topics.length, 0);
  assert.equal(result.stats.exchanges, 0);
  assert.equal(result.stats.strategy, 'empty');
});

check('a single-turn session produces exactly one topic', () => {
  const one = finalizeSession({
    harness: 'pi',
    harnessName: 'pi',
    nativeId: 'one',
    project: 'demo',
    started: at(0),
    updated: at(1),
    messages: [
      { role: 'user', text: 'explain the pool configuration in src/pool.ts', ts: at(0) },
      { role: 'assistant', text: 'It caps at 20 connections per worker.', ts: at(1) },
    ],
  });
  const { topics, stats } = deriveTopics(one);
  assert.equal(topics.length, 1);
  assert.equal(stats.coverage, 1);
});

// ── Slices ─────────────────────────────────────────────────────────────────

check('a slice contains the turns of its topic, not the whole session', () => {
  const s = twoSubjectSession();
  const { topics } = deriveTopics(s, { maxTopics: 40 });
  const cache = topics.find((t) => /cache/i.test(t.label));
  const slice = topicSlice(s, cache, { maxChars: 12000 });
  assert.ok(/cache/i.test(slice.text), 'slice does not contain its own topic text');
  assert.ok(!/connection pool is exhausted/i.test(slice.text), 'slice contains another topic\'s text');
  assert.deepEqual(slice.messageRanges, cache.messageRanges);
  assert.equal(slice.topicId, cache.id);
});

check('a slice reports what it dropped rather than hiding it', () => {
  const s = twoSubjectSession();
  const { topics } = deriveTopics(s, { maxTopics: 40 });
  const slice = topicSlice(s, topics[0], { maxChars: 300 });
  if (slice.chars > 300) {
    assert.ok(slice.truncated > 0, 'truncation not reported');
    assert.match(slice.text, /omitted/);
  }
});

// ── Report ─────────────────────────────────────────────────────────────────

console.log(`\ntopics: ${passed} passed, ${failures.length} failed\n`);

if (failures.length) {
  for (const f of failures) console.error(`FAIL  ${f.name}\n        ${f.message}`);
  process.exit(1);
}
console.log('All topic assertions passed.\n');
