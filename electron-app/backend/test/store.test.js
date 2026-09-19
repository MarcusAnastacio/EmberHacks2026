#!/usr/bin/env node
// Storage and grading tests.
//
// Storage is the only part of this backend that writes, so the assertions here are
// mostly about what it must NOT do: store transcripts, duplicate quizzes, or lose an
// attempt. Grading is asserted for the property that matters most — that the objective
// types are decided locally and only `open` reaches the network.

import assert from 'node:assert/strict';

import { QuizStore, fingerprintSession, settingsKey, quizIdFor, GENERATOR_VERSION } from '../lib/store.js';
import { gradeAttempt, gradeObjective, gradeMcq, gradeCloze, gradeOpen, gradeSchema, normalizeAnswer } from '../lib/grade.js';
import { finalizeSession } from '../lib/normalize.js';

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (err) {
    failures.push({ name, message: err.message });
  }
}

const T0 = Date.UTC(2026, 2, 14, 10, 0);
const at = (m) => T0 + m * 60_000;

const FILLER = 'The relevant configuration is read at startup and cached for the life of the process. ';
function session(messages, overrides = {}) {
  return finalizeSession({
    harness: 'pi',
    harnessName: 'pi',
    nativeId: 'store-test',
    project: 'demo',
    title: 'a conversation',
    started: at(0),
    updated: at(30),
    messages,
    ...overrides,
  });
}

function twoTopicSession() {
  return session([
    { role: 'user', text: `The pool is exhausting under load. Investigate src/db.ts and fix the leak. ${FILLER.repeat(3)}`, ts: at(0) },
    {
      role: 'assistant',
      text: `The error path returns before releasing the client, so each failure leaks one connection. ${FILLER.repeat(4)}`,
      ts: at(2),
      tools: [{ name: 'edit', input: { path: 'src/db.ts' } }],
    },
    { role: 'user', text: `Separately, the cache serves stale prices after an update. Where is the TTL? ${FILLER.repeat(3)}`, ts: at(90) },
    {
      role: 'assistant',
      text: `The TTL is 60 seconds. Invalidate on write instead, because reads outnumber writes. ${FILLER.repeat(4)}`,
      ts: at(95),
      tools: [{ name: 'edit', input: { path: 'src/cache.ts' } }],
    },
  ]);
}

const SETTINGS = { questionCount: 3, types: ['mcq', 'cloze', 'open'], flashcardsPerTopic: 2 };

/** A quiz shaped like the one lib/quiz.js produces. */
function fakeQuiz(s, { questions = 3 } = {}) {
  const topics = [
    { id: 't1', label: 'pool exhaustion', messageRanges: [[0, 1]], chars: 1000 },
    { id: 't2', label: 'cache staleness', messageRanges: [[2, 3]], chars: 1000 },
  ];
  return {
    ok: true,
    sessionId: s.id,
    title: s.title,
    project: s.project,
    harness: s.harnessName,
    model: 'stub',
    settings: { ...SETTINGS, producedQuestions: questions },
    topicsUsed: topics,
    flashcards: [{ front: 'f1', back: 'b1', topicId: 't1' }, { front: 'f2', back: 'b2', topicId: 't2' }],
    questions: [
      { id: 't1-mcq-1', type: 'mcq', topicId: 't1', prompt: 'why does the pool exhaust?', explanation: 'leak', sourceTurns: [0],
        options: [{ key: 'A', text: 'a' }, { key: 'B', text: 'b' }, { key: 'C', text: 'c' }, { key: 'D', text: 'd' }], correctOptionKey: 'B' },
      { id: 't1-cloze-1', type: 'cloze', topicId: 't1', prompt: 'complete', explanation: 'releases', sourceTurns: [1],
        language: 'ts', codeWithGaps: 'try { a() } finally { {{blank_1}}(); }',
        blanks: [{ key: 'blank_1', answer: 'release', alternatives: ['release()', 'Close'] }] },
      { id: 't2-open-1', type: 'open', topicId: 't2', prompt: 'explain the cache trade-off', explanation: 'because', sourceTurns: [2],
        rubric: [{ criterion: 'names the trade-off', weight: 2, mustMention: ['hit rate'] }, { criterion: 'proposes invalidation', weight: 1, mustMention: [] }],
        referenceAnswer: 'Invalidate on write.' },
    ],
  };
}

// ── Fingerprints and ids ───────────────────────────────────────────────────

await check('appending messages does not change the fingerprint of the covered prefix', () => {
  // This is what makes "extended" distinguishable from "diverged", and it is why
  // staleness compares content rather than a file mtime: agents append constantly.
  const s = twoTopicSession();
  const before = fingerprintSession(s, { upTo: 4 });
  const grown = session([...s.messages, { role: 'user', text: 'and the retry logic?', ts: at(120) }]);
  assert.equal(fingerprintSession(grown, { upTo: 4 }), before, 'appending changed the covered fingerprint');
  assert.notEqual(fingerprintSession(grown), before, 'the full fingerprint should differ');
});

await check('editing a covered message DOES change the fingerprint', () => {
  const s = twoTopicSession();
  const before = fingerprintSession(s, { upTo: 4 });
  const edited = session(s.messages.map((m, i) => (i === 1 ? { ...m, text: `${m.text} Actually it was a config problem.` } : m)));
  assert.notEqual(fingerprintSession(edited, { upTo: 4 }), before);
});

await check('quiz ids are deterministic and settings-sensitive', () => {
  const base = { sessionId: 'pi:1', contentFingerprint: 'abc', coveredMessages: 4, settings: SETTINGS };
  assert.equal(quizIdFor(base), quizIdFor({ ...base }), 'not deterministic');
  assert.notEqual(quizIdFor(base), quizIdFor({ ...base, settings: { ...SETTINGS, questionCount: 9 } }));
  assert.notEqual(quizIdFor(base), quizIdFor({ ...base, coveredMessages: 5 }));
  assert.notEqual(quizIdFor(base), quizIdFor({ ...base, generatorVersion: 'next' }));
  // Setting order must not matter.
  assert.equal(
    quizIdFor({ ...base, settings: { ...SETTINGS, types: ['open', 'mcq', 'cloze'] } }),
    quizIdFor(base),
    'type order changed the id',
  );
});

// ── Storing ────────────────────────────────────────────────────────────────

await check('a quiz round-trips through storage', () => {
  const store = QuizStore.memory();
  const s = twoTopicSession();
  const { id, created } = store.saveQuiz(fakeQuiz(s), s, { settings: SETTINGS });
  assert.equal(created, true);

  const loaded = store.getQuiz(id);
  assert.equal(loaded.questions.length, 3);
  assert.equal(loaded.flashcards.length, 2);
  assert.equal(loaded.sessionId, s.id);
  assert.equal(loaded.generatorVersion, GENERATOR_VERSION);
  assert.deepEqual(loaded.topicsUsed.map((t) => t.id), ['t1', 't2']);
  // Mcq options and cloze blanks must survive JSON, not just the summary.
  assert.equal(loaded.questions[0].correctOptionKey, 'B');
  assert.equal(loaded.questions[1].blanks[0].answer, 'release');
  assert.equal(loaded.questions[2].rubric[0].weight, 2);
  store.close();
});

await check('saving the same quiz twice updates rather than duplicating', () => {
  const store = QuizStore.memory();
  const s = twoTopicSession();
  const quiz = fakeQuiz(s);
  const first = store.saveQuiz(quiz, s, { settings: SETTINGS });
  const second = store.saveQuiz(quiz, s, { settings: SETTINGS });
  assert.equal(first.id, second.id, 'id changed between saves');
  assert.equal(second.created, false, 'the second save reported a new row');
  assert.equal(store.list().length, 1, 'the quiz was duplicated');
  store.close();
});

await check('an empty quiz is refused rather than stored', () => {
  const store = QuizStore.memory();
  const s = twoTopicSession();
  assert.throws(() => store.saveQuiz({ questions: [], flashcards: [] }, s), /empty quiz/);
  store.close();
});

await check('NO TRANSCRIPT IS STORED', () => {
  // The property that keeps this from becoming a second copy of the most sensitive
  // files on the machine. The fingerprint covers the text; the text itself is never
  // written, so the database cannot be read back as a conversation.
  const store = QuizStore.memory();
  const s = twoTopicSession();
  store.saveQuiz(fakeQuiz(s), s, { settings: SETTINGS });

  const dump = [];
  for (const table of ['quiz', 'attempt', 'topic_coverage']) {
    for (const row of store.db.prepare(`SELECT * FROM ${table}`).all()) {
      dump.push(JSON.stringify(row));
    }
  }
  const all = dump.join('\n');
  assert.ok(all.length > 100, 'nothing was stored, so this proves nothing');

  // No sentence from the conversation may appear anywhere in the database.
  for (const message of s.messages) {
    const probe = message.text.slice(0, 60);
    assert.ok(!all.includes(probe), `message text found in storage: ${probe.slice(0, 40)}…`);
  }
  // The question text IS stored, which is the whole point.
  assert.ok(all.includes('why does the pool exhaust?'), 'the question was not stored');
  store.close();
});

await check('a quiz is rejected when only one argument is given', () => {
  const store = QuizStore.memory();
  assert.throws(() => store.saveQuiz(fakeQuiz(twoTopicSession())), /needs a quiz and a session/);
  assert.throws(() => store.saveQuiz(null, twoTopicSession()), /needs a quiz and a session/);
  store.close();
});

// ── Staleness ──────────────────────────────────────────────────────────────

await check('staleness reports new, fresh, extended, diverged and settings_changed', () => {
  const store = QuizStore.memory();
  const s = twoTopicSession();
  assert.equal(store.staleness(s, SETTINGS).state, 'new');

  store.saveQuiz(fakeQuiz(s), s, { settings: SETTINGS });
  assert.equal(store.staleness(s, SETTINGS).state, 'fresh');

  // Same conversation, different options.
  assert.equal(store.staleness(s, { ...SETTINGS, questionCount: 9 }).state, 'settings_changed');

  // Appended: still usable, and it says where new work starts.
  const grown = session([...s.messages, { role: 'user', text: 'and the retry logic?', ts: at(120) }]);
  const extended = store.staleness(grown, SETTINGS);
  assert.equal(extended.state, 'extended');
  assert.equal(extended.fromMessage, 4, 'incremental generation would start in the wrong place');
  assert.equal(extended.newMessages, 1);

  // The messages the quiz was built from changed.
  const edited = session(s.messages.map((m, i) => (i === 0 ? { ...m, text: `${m.text} (corrected)` } : m)));
  assert.equal(store.staleness(edited, SETTINGS).state, 'diverged');
  store.close();
});

await check('a different focus means a different quiz', () => {
  // Typing a different focus has to invalidate the stored quiz the same way a different
  // question count does, or the button would offer a quiz built for another question.
  const a = settingsKey({ ...SETTINGS, focus: 'architectural decisions' });
  const b = settingsKey({ ...SETTINGS, focus: 'the bugs we fixed' });
  const none = settingsKey({ ...SETTINGS });
  assert.notEqual(a, b);
  assert.notEqual(a, none);
  assert.equal(a, settingsKey({ ...SETTINGS, focus: 'architectural decisions' }), 'not deterministic');
  // Whitespace only is the same as none.
  assert.equal(settingsKey({ ...SETTINGS, focus: '   ' }), none);
});

await check('a quiz from an older generator version is reported stale', () => {
  const store = QuizStore.memory();
  const s = twoTopicSession();
  const { id } = store.saveQuiz(fakeQuiz(s), s, { settings: SETTINGS });
  store.db.prepare('UPDATE quiz SET generator_version = ? WHERE id = ?').run('0', id);
  assert.equal(store.staleness(s, SETTINGS).state, 'generator_stale');
  store.close();
});

await check('coverage follows the last turn a quiz drew on', () => {
  const store = QuizStore.memory();
  const s = twoTopicSession();
  const { id } = store.saveQuiz(fakeQuiz(s), s, { settings: SETTINGS });
  // The fixture's topics cover messages 0-3, so four messages have been seen.
  assert.equal(store.getQuiz(id).coveredMessages, 4);
  store.close();
});

// ── Attempts ───────────────────────────────────────────────────────────────

await check('attempts are kept per quiz and the best score is reported', () => {
  const store = QuizStore.memory();
  const s = twoTopicSession();
  const { id } = store.saveQuiz(fakeQuiz(s), s, { settings: SETTINGS });
  store.saveAttempt(id, { answers: { a: 1 }, score: 1, maxScore: 3 });
  store.saveAttempt(id, { answers: { a: 2 }, score: 3, maxScore: 3 });
  store.saveAttempt(id, { answers: { a: 3 }, score: 2, maxScore: 3 });

  assert.equal(store.attempts(id).length, 3);
  assert.deepEqual(store.bestScore(id), { best: 3, maxScore: 3, attempts: 3 });
  // The list view carries a count so a row can show progress without loading attempts.
  assert.equal(store.list()[0].attempts, 3);
  store.close();
});

await check('an attempt against an unknown quiz is refused', () => {
  const store = QuizStore.memory();
  assert.throws(() => store.saveAttempt('nope', { answers: {} }), /no quiz/);
  store.close();
});

await check('deleting a quiz removes its attempts and coverage', () => {
  const store = QuizStore.memory();
  const s = twoTopicSession();
  const { id } = store.saveQuiz(fakeQuiz(s), s, { settings: SETTINGS });
  store.saveAttempt(id, { answers: {}, score: 1, maxScore: 3 });
  assert.equal(store.deleteQuiz(id), true);
  assert.equal(store.getQuiz(id), null);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM attempt').get().n, 0, 'attempts survived the delete');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM topic_coverage').get().n, 0, 'coverage survived');
  assert.equal(store.deleteQuiz(id), false, 'deleting twice should report no change');
  store.close();
});

await check('clear() removes everything and reports the count', () => {
  const store = QuizStore.memory();
  const s = twoTopicSession();
  store.saveQuiz(fakeQuiz(s), s, { settings: SETTINGS });
  assert.deepEqual(store.clear(), { removed: 1 });
  assert.equal(store.list().length, 0);
  assert.equal(store.stats().attempts, 0);
  store.close();
});

// ── Grading: objective, no API ─────────────────────────────────────────────

await check('answers are normalised generously', () => {
  // The failure that matters is marking a right answer wrong over punctuation.
  assert.equal(normalizeAnswer('  rows.Close()  '), 'rows.close()');
  assert.equal(normalizeAnswer('`--cached`'), '--cached');
  assert.equal(normalizeAnswer('"release";'), 'release');
  assert.equal(normalizeAnswer('a\n  b'), 'a b');
  assert.equal(normalizeAnswer(null), '');
});

await check('multiple choice is graded by key, case-insensitively', () => {
  const q = { id: 'q', type: 'mcq', correctOptionKey: 'B', options: [{ key: 'A', text: 'a' }, { key: 'B', text: 'b' }] };
  assert.equal(gradeMcq(q, 'B').correct, true);
  assert.equal(gradeMcq(q, 'b').correct, true, 'key comparison should ignore case');
  assert.equal(gradeMcq(q, 'A').correct, false);
  assert.equal(gradeMcq(q, undefined).correct, false);
  assert.equal(gradeMcq(q, undefined).needsApi, false, 'mcq must never need an API call');
});

await check('fill-in-the-blank accepts alternatives and gives partial credit', () => {
  const q = {
    id: 'q',
    type: 'cloze',
    blanks: [
      { key: 'blank_1', answer: 'release', alternatives: ['release()', 'Close'] },
      { key: 'blank_2', answer: 'finally', alternatives: [] },
    ],
  };
  assert.equal(gradeCloze(q, { blank_1: 'release', blank_2: 'finally' }).awarded, 1);
  assert.equal(gradeCloze(q, { blank_1: 'close', blank_2: 'finally' }).awarded, 1, 'alternatives were not accepted');
  const half = gradeCloze(q, { blank_1: 'release', blank_2: 'catch' });
  assert.equal(half.awarded, 0.5, 'partial credit not given');
  assert.equal(half.correct, false);
  assert.equal(half.needsApi, false);
  assert.equal(gradeCloze(q, {}).awarded, 0, 'unanswered should score zero, not throw');
});

await check('gradeObjective routes by type and refuses open', () => {
  assert.equal(gradeObjective({ type: 'mcq', correctOptionKey: 'A' }, 'A').type, 'mcq');
  assert.equal(gradeObjective({ type: 'cloze', blanks: [{ key: 'blank_1', answer: 'x' }] }, 'x').type, 'cloze');
  assert.equal(gradeObjective({ type: 'open' }, 'anything'), null, 'open must not be graded locally');
  assert.equal(gradeObjective({ type: 'unknown' }, 'x'), null);
});

await check('an unattempted attempt scores zero without any request', async () => {
  const quiz = fakeQuiz(twoTopicSession());
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; return { ok: true, status: 200, json: async () => ({}) }; };
  try {
    const result = await gradeAttempt(quiz, {});
    assert.equal(result.score, 0);
    assert.equal(result.maxScore, 3, 'every question should still be worth a mark');
    assert.equal(result.answered, 0);
  } finally {
    globalThis.fetch = original;
  }
});

await check('gradeAttempt grades objective questions without touching the network', async () => {
  const quiz = fakeQuiz(twoTopicSession());
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; return { ok: true, status: 200, json: async () => ({}) }; };
  try {
    const result = await gradeAttempt(quiz, { 't1-mcq-1': 'B', 't1-cloze-1': { blank_1: 'release' } }, { skipOpen: true });
    assert.equal(called, false, `the network was used for objective questions (${called})`);
    assert.equal(result.score, 2);
    assert.equal(result.maxScore, 2, 'the skipped open question should not be counted');
  } finally {
    globalThis.fetch = original;
  }
});

// ── Grading: open, with the model stubbed ──────────────────────────────────

await check('an empty open answer short-circuits without a request', async () => {
  const quiz = fakeQuiz(twoTopicSession());
  const open = quiz.questions.find((q) => q.type === 'open');
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; return { ok: true, status: 200, json: async () => ({}) }; };
  try {
    const result = await gradeOpen(open, '   ', {});
    assert.equal(called, false, 'a request was made for an empty answer');
    assert.equal(result.awarded, 0);
    assert.equal(result.verdict, 'incorrect');
    assert.equal(result.needsApi, false);
    assert.equal(result.perCriterion.length, open.rubric.length);
  } finally {
    globalThis.fetch = original;
  }
});

await check('an open answer is scored from the rubric weights, not the model total', async () => {
  // The model returns a 0..1 overall score; the weighted total is recomputed from the
  // criteria so a malformed overall figure cannot distort the mark.
  const quiz = fakeQuiz(twoTopicSession());
  const open = quiz.questions.find((q) => q.type === 'open');
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{
        content: { parts: [{ text: JSON.stringify({
          score: 0.99,                       // deliberately inconsistent with the criteria
          verdict: 'correct',
          perCriterion: [
            { criterion: 'names the trade-off', awarded: 1, comment: 'yes' },
            { criterion: 'proposes invalidation', awarded: 0, comment: 'no' },
          ],
          missing: ['invalidation'],
          feedback: 'You named the trade-off but did not say how to fix it.',
        }) }] },
        finishReason: 'STOP',
      }],
      usageMetadata: { totalTokenCount: 120 },
    }),
  });
  try {
    const result = await gradeOpen(open, 'reads outnumber writes so the hit rate matters more', { apiKey: 'k', models: ['stub'] });
    // Weights are 2 and 1, so 2/3 is the right mark, not 0.99.
    assert.ok(Math.abs(result.awarded - 2 / 3) < 0.001, `expected 0.667, got ${result.awarded}`);
    assert.equal(result.verdict, 'partial', 'a 0.667 answer is not "correct"');
    assert.equal(result.needsApi, true);
    assert.equal(result.usage.tokens, 120);
    assert.deepEqual(result.missing, ['invalidation']);
    assert.ok(result.feedback.includes('trade-off'));
  } finally {
    globalThis.fetch = original;
  }
});

await check('a grading failure is reported per question, not thrown', async () => {
  const quiz = fakeQuiz(twoTopicSession());
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => 'busy', json: async () => ({}) });
  try {
    const result = await gradeAttempt(quiz, { 't1-mcq-1': 'B', 't2-open-1': 'an answer' }, { apiKey: 'k', models: ['stub'] });
    const open = result.perQuestion.find((r) => r.type === 'open');
    assert.ok(open.error, 'the failure was not reported');
    // The objective questions still counted, so a grading outage does not lose the whole
    // attempt: the mcq scored 1 and the unanswered cloze scored 0 but is still graded.
    assert.equal(result.score, 1);
    assert.equal(result.maxScore, 2);
  } finally {
    globalThis.fetch = original;
  }
});

await check('the grading schema makes every field required', async () => {
  // Same correction as the generation schema: a non-required nullable field is omitted
  // by the model, and a missing score is worse than a wrong one.
  const schema = gradeSchema();
  for (const field of ['score', 'verdict', 'perCriterion', 'missing', 'feedback']) {
    assert.ok(schema.required.includes(field), `${field} is not required`);
  }
  assert.deepEqual(schema.properties.perCriterion.items.required, ['criterion', 'awarded', 'comment']);
});

// ── Report ─────────────────────────────────────────────────────────────────

console.log(`\nstore+grade: ${passed} passed, ${failures.length} failed\n`);

if (failures.length) {
  for (const f of failures) console.error(`FAIL  ${f.name}\n        ${f.message}`);
  process.exit(1);
}
console.log('All storage and grading assertions passed.\n');
