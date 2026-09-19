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

check('a slice labels its preceding context as background', () => {
  // Topics start on user turns, so a literal slice opens with an assistant reply
  // whose question is out of view. Measured on a 2.4M-character session that
  // produced questions phrased as continuations ("Based on the evaluation of…").
  // The slice now carries the prior exchange, explicitly marked as background.
  const s = twoSubjectSession();
  const { topics } = deriveTopics(s, { maxTopics: 40 });
  const later = topics.find((t) => t.from > 0);
  assert.ok(later, 'expected a topic that is not the first');
  const slice = topicSlice(s, later, { maxChars: 12000 });

  assert.match(slice.text, /--- PRECEDING CONTEXT/, 'no context label');
  assert.match(slice.text, /not part of this topic/, 'context is not marked as background');
  assert.match(slice.text, /--- TOPIC: /, 'no topic label');
  // Both halves of the prior exchange matter: the user turn is the question, and
  // the assistant turn is the answer. Only one of them reads as a dangling fragment.
  assert.match(slice.text, /USER \(earlier\)/, 'prior user turn missing');
  assert.match(slice.text, /ASSISTANT \(earlier\)/, 'prior assistant turn missing');
  assert.ok(slice.contextChars > 0, 'contextChars not reported');
  // The context must come before the topic body.
  assert.ok(slice.text.indexOf('PRECEDING CONTEXT') < slice.text.indexOf('--- TOPIC:'), 'context is not first');
});

check('the first topic has no preceding context to add', () => {
  const s = twoSubjectSession();
  const { topics } = deriveTopics(s, { maxTopics: 40 });
  const first = topics[0];
  assert.equal(first.from, s.messages.findIndex((m) => m.role === 'user'), 'fixture drift');
  const slice = topicSlice(s, first, { maxChars: 12000 });
  assert.equal(slice.contextChars, 0);
  assert.ok(!slice.text.includes('PRECEDING CONTEXT'), 'the first topic invented context');
});

check('the context shares the slice budget rather than sitting outside it', () => {
  const s = twoSubjectSession();
  const { topics } = deriveTopics(s, { maxTopics: 40 });
  const later = topics.find((t) => t.from > 0);
  // A small cap must not be overrun by a fixed-size preamble.
  for (const maxChars of [300, 600, 1200, 5000]) {
    const slice = topicSlice(s, later, { maxChars, contextChars: 1200 });
    assert.ok(slice.chars <= maxChars + 140, `cap ${maxChars} exceeded: ${slice.chars}`);
    // And the context must shrink with the cap, not stay at its default.
    if (maxChars <= 1200) {
      assert.ok(slice.contextChars <= Math.floor(maxChars * 0.3) + 60, `context ${slice.contextChars} too large for cap ${maxChars}`);
    }
  }
});

check('a slice names its topic so the prompt is self-framing', () => {
  const s = twoSubjectSession();
  const { topics } = deriveTopics(s, { maxTopics: 40 });
  const slice = topicSlice(s, topics[0], { maxChars: 12000 });
  assert.ok(slice.text.includes(topics[0].label.slice(0, 30)), 'topic label not in the slice');
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

// ── Splitting below the exchange level ─────────────────────────────────────

/** A session shaped like a long autonomous agent run: one prompt, many agent turns. */
function agentRunSession({ userChars = 200, assistantMessages = 6, assistantChars = 9000 } = {}) {
  const messages = [{ role: 'user', text: `Investigate the failure and fix it. ${'x'.repeat(userChars)}`, ts: at(0) }];
  for (let i = 0; i < assistantMessages; i++) {
    messages.push({
      role: 'assistant',
      text: `Step ${i + 1}. ${'Working through the details of the failure mode. '.repeat(Math.ceil(assistantChars / 47))}`,
      ts: at(i + 1),
      tools: [{ name: 'bash', input: { command: `step ${i + 1}` } }],
    });
  }
  return finalizeSession({
    harness: 'pi', harnessName: 'pi', nativeId: 'run', project: 'demo',
    started: at(0), updated: at(assistantMessages + 1), messages,
  });
}

check('a single-exchange agent run is split at message boundaries', () => {
  // The case exchange-level splitting cannot reach: one user turn followed by a long
  // autonomous run. Every boundary candidate was between exchanges, and there is only
  // one exchange, so a segment like this was previously unsplittable however large.
  const session = agentRunSession({ assistantMessages: 6, assistantChars: 9000 });
  const { topics } = deriveTopics(session, { maxTopics: 40, maxSegmentChars: 12000 });
  assert.ok(topics.length > 1, `expected the run to be split, got ${topics.length} topic(s)`);
  for (const t of topics) {
    assert.ok(t.chars <= 12000 + 200, `topic ${t.id} is ${t.chars} chars, over the target`);
    assert.ok(t.subSplit, `topic ${t.id} should be marked as a size split`);
  }
  // Consecutive pieces must tile the session: either the next one starts on the message
  // after the previous one ended, or — when a single message was cut by character range —
  // it continues where the previous piece's text stopped.
  const sorted = [...topics].sort(
    (a, b) => a.from - b.from || (a.charFrom ?? -1) - (b.charFrom ?? -1),
  );
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const next = sorted[i];
    // Starting on the next message continues the previous piece regardless of whether
    // that next message is itself cut into sub-ranges.
    const continuesMessage = next.from === prev.to + 1;
    const continuesText = next.from === prev.to && next.charFrom === prev.charTo;
    assert.ok(
      continuesMessage || continuesText,
      `piece ${i} (msg ${next.from}, char ${next.charFrom}) does not continue piece ${i - 1} (msg ${prev.to}, char ${prev.charTo})`,
    );
  }
});

check('a single oversized message is split by character range', () => {
  // No message boundary exists inside one message, so the only way to make its whole
  // content reachable across prompts is to cut inside it.
  const session = agentRunSession({ assistantMessages: 1, assistantChars: 40000 });
  const { topics } = deriveTopics(session, { maxTopics: 40, maxSegmentChars: 10000 });
  const intra = topics.filter((t) => t.charFrom !== undefined);
  assert.ok(intra.length > 1, `expected an intra-message split, got ${intra.length}`);
  for (const t of intra) {
    assert.equal(t.from, t.to, 'an intra-message piece should cover one message');
    assert.ok(t.charTo > t.charFrom);
    assert.ok(t.chars <= 10000 + 200, `piece is ${t.chars} chars`);
  }
  // The pieces must together cover the message, not just its beginning.
  const total = intra.reduce((n, t) => n + (t.charTo - t.charFrom), 0);
  const message = session.messages.find((m) => m.text.length > 30000);
  assert.ok(total >= message.text.length * 0.9, `pieces cover ${total} of ${message.text.length}`);
});

check('an intra-message split yields a usable slice, not the whole message', () => {
  const session = agentRunSession({ assistantMessages: 1, assistantChars: 30000 });
  const { topics } = deriveTopics(session, { maxTopics: 40, maxSegmentChars: 8000 });
  const intra = topics.filter((t) => t.charFrom !== undefined);
  assert.ok(intra.length > 0);
  const slice = topicSlice(session, intra[0], { maxChars: 4000 });
  assert.ok(slice.chars <= 4100, `slice is ${slice.chars} chars`);
  assert.ok(slice.text.length > 100, 'slice came back empty');
});

check('a size split is labelled honestly', () => {
  const session = agentRunSession({ assistantMessages: 1, assistantChars: 30000 });
  const { topics } = deriveTopics(session, { maxTopics: 40, maxSegmentChars: 8000 });
  const first = topics[0];
  // The first piece begins at the user turn, so it can use the user's words.
  assert.equal(first.agentLabel, false, 'the opening piece should use the user turn');
  // Anything after it begins inside the assistant's output, which must be declared.
  const later = topics.find((t) => t.from > first.from || t.charFrom !== undefined);
  if (later) {
    assert.equal(later.agentLabel, true, 'a piece not opening on a user turn must be flagged');
    assert.ok(!/^the user wants me/i.test(later.label), `narration leaked into the label: ${later.label}`);
  }
});

check('splitting never makes a topic larger than the target', () => {
  for (const [messages, chars] of [[8, 6000], [4, 15000], [1, 50000], [20, 2000]]) {
    const session = agentRunSession({ assistantMessages: messages, assistantChars: chars });
    const { topics } = deriveTopics(session, { maxTopics: 60, maxSegmentChars: 10000 });
    for (const t of topics) {
      assert.ok(t.chars <= 10000 + 250, `${messages}x${chars}: topic ${t.id} is ${t.chars} chars`);
    }
  }
});

check('every message stays reachable after splitting', () => {
  const session = agentRunSession({ assistantMessages: 5, assistantChars: 7000 });
  const { topics } = deriveTopics(session, { maxTopics: 40, maxSegmentChars: 11000 });
  const firstUser = session.messages.findIndex((m) => m.role === 'user');
  assert.equal(Math.min(...topics.map((t) => t.from)), firstUser);
  assert.equal(Math.max(...topics.map((t) => t.to)), session.messages.length - 1);
});

// ── Report ─────────────────────────────────────────────────────────────────

console.log(`\ntopics: ${passed} passed, ${failures.length} failed\n`);

if (failures.length) {
  for (const f of failures) console.error(`FAIL  ${f.name}\n        ${f.message}`);
  process.exit(1);
}
console.log('All topic assertions passed.\n');
