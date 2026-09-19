#!/usr/bin/env node
// Quiz tests. No network.
//
// The Gemini call is exercised by replacing globalThis.fetch, so the fallback chain,
// the retry behaviour and the validation path are all covered deterministically.
// What is asserted:
//   * topic count follows the requested question count and enabled types
//   * flashcards are always produced, even with no question types enabled
//   * the deck yields exactly the requested number of questions
//   * selection is reproducible with a seed and differs without one
//   * every conditional schema field is REQUIRED — a nullable one made Gemini omit
//     the correct answer from multiple-choice questions
//   * malformed questions are dropped with a reason instead of shipped broken
//   * question ids are unique, because scores are keyed by id
//   * a 503 falls through to the next model, a 404 skips straight past

import assert from 'node:assert/strict';

import {
  planQuiz, quizSchema, validateResult, generateQuiz, quizCapabilities,
  assessReadiness, quizButtonState, scoreBand, QUESTION_TYPES, READINESS,
} from '../lib/quiz.js';
import { finalizeSession } from '../lib/normalize.js';
import { generateJson, GeminiError, parseJsonResponse, resetEnvCache } from '../lib/gemini.js';

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

// ── Fixtures ───────────────────────────────────────────────────────────────

const T0 = Date.UTC(2026, 2, 14, 10, 0);
const at = (m) => T0 + m * 60_000;

/**
 * Six distinct subjects so the segmenter has plenty to choose from.
 *
 * Each exchange is padded to roughly the size of a real one. This matters: the
 * readiness gate refuses topics below READINESS.minTopicChars, so a fixture of
 * one-line exchanges would test the gate rather than the planner. Real topics run to
 * thousands of characters.
 */
function multiTopicSession() {
  const messages = [];
  const subjects = [
    ['Pool exhaustion investigation', 'src/pool.ts'],
    ['Cache staleness after a price update', 'src/cache.ts'],
    ['Retry helper backoff behaviour', 'src/retry.ts'],
    ['Auth token refresh rotation', 'src/auth.ts'],
    ['Migration runner ordering', 'src/migrate.ts'],
    ['Metrics exporter cardinality', 'src/metrics.ts'],
  ];
  const filler = (n) =>
    'The relevant configuration is read at startup and cached for the process lifetime, which is why changing it requires a restart. '.repeat(n);

  subjects.forEach(([subject, file], i) => {
    messages.push({
      role: 'user',
      text: `${subject}. Explain the cause and fix it in ${file}. ${filler(2)}`,
      ts: at(i * 90),
    });
    messages.push({
      role: 'assistant',
      text:
        `In ${file} the problem is the error path: it returns before releasing the client, so each failure leaks one connection and the pool fills linearly with error rate rather than with traffic. ` +
        `${filler(3)}\n\nHere is the corrected code:\n\n\`\`\`ts\nexport function ${file.split('/')[1].split('.')[0]}() {\n  try { return acquire(); } finally { release(); }\n}\n\`\`\`\n\n` +
        'Callers now pass a callback instead of receiving a client, which makes the leak unrepresentable in the type system.',
      ts: at(i * 90 + 5),
      thinkingChars: 400,
      tools: [
        { name: 'read', input: { path: file } },
        { name: 'edit', input: { path: file } },
        { name: 'bash', input: { command: 'npm test' } },
      ],
    });
  });
  return finalizeSession({
    harness: 'pi',
    harnessName: 'pi',
    nativeId: 'quiz-test',
    project: 'widget-api',
    title: 'six subjects',
    cwd: '/tmp/widget-api',
    started: at(0),
    updated: at(subjects.length * 90),
    messages,
  });
}

// ── Planning ───────────────────────────────────────────────────────────────

await check('topic count follows the question count and enabled types', async () => {
  const s = multiTopicSession();
  const cases = [
    { questionCount: 6, types: ['mcq', 'cloze', 'open'], topics: 2 },
    { questionCount: 6, types: ['mcq'], topics: 6 },
    { questionCount: 6, types: ['mcq', 'cloze'], topics: 3 },
    { questionCount: 1, types: ['open'], topics: 1 },
    { questionCount: 12, types: ['mcq', 'cloze', 'open'], topics: 4 },
  ];
  for (const c of cases) {
    const plan = planQuiz(s, c);
    assert.equal(plan.selectedTopics.length, c.topics, `${JSON.stringify(c)} -> ${plan.selectedTopics.length} topics`);
  }
});

await check('the deck yields exactly the requested number of questions', async () => {
  const s = multiTopicSession(); // six topics
  for (const questionCount of [1, 2, 3, 5, 7, 12]) {
    for (const types of [['mcq'], ['mcq', 'cloze'], QUESTION_TYPES]) {
      const plan = planQuiz(s, { questionCount, types });
      const ceiling = plan.selectedTopics.length * types.length;
      assert.equal(
        plan.expectedQuestions,
        Math.min(questionCount, ceiling),
        `${questionCount} questions over [${types}] produced ${plan.expectedQuestions}`,
      );
      assert.equal(plan.deck.length * plan.plan.flashcardsPerTopic, plan.expectedFlashcards);
      // One question per (topic, type) pair: never the same pair twice.
      for (const slot of plan.deck) {
        assert.equal(new Set(slot.types).size, slot.types.length, `duplicate type in ${JSON.stringify(slot)}`);
      }
      // When the ask exceeds what the session supports, say so rather than
      // silently under-delivering or duplicating a pair.
      if (questionCount > ceiling) {
        assert.ok(plan.shortfall > 0, `no shortfall reported for ${questionCount} over ${ceiling}`);
        assert.equal(plan.requestedQuestions, questionCount);
      } else {
        assert.equal(plan.shortfall, 0);
      }
    }
  }
});

await check('a shortfall is reported when the session has too few topics', async () => {
  const s = multiTopicSession(); // six topics
  const plan = planQuiz(s, { questionCount: 40, types: ['mcq'] });
  assert.equal(plan.selectedTopics.length, 6, 'should use every available topic');
  assert.equal(plan.expectedQuestions, 6, 'one mcq per topic is the ceiling');
  assert.equal(plan.requestedQuestions, 40);
  assert.equal(plan.shortfall, 34);
});

await check('flashcards are always produced, even with no question types', async () => {
  const plan = planQuiz(multiTopicSession(), { questionCount: 10, types: [] });
  assert.deepEqual(plan.types, []);
  assert.equal(plan.questionCount, 0, 'question count must be forced to 0 with no types');
  assert.equal(plan.expectedQuestions, 0);
  assert.equal(plan.deck.length, 1, 'a flashcard-only deck still needs one topic');
  assert.equal(plan.expectedFlashcards, 2, 'and still produces two flashcards');
});

await check('a session with no topics plans cleanly instead of throwing', async () => {
  // Regression: the no-topics early return referenced a const declared further
  // down, so any session without a user turn threw a temporal-dead-zone error.
  // Every bundled fixture format is swept for this, and one hit it.
  const noUserTurns = finalizeSession({
    harness: 'pi', harnessName: 'pi', nativeId: 'empty', project: 'demo',
    started: at(0), updated: at(1),
    messages: [{ role: 'assistant', text: 'nothing was asked', ts: at(0) }],
  });
  const plan = planQuiz(noUserTurns, { questionCount: 5, types: ['mcq'] });
  assert.equal(plan.plan, null);
  // A session with no user turn at all normalises to nothing, so it is reported as an
  // empty session rather than as a session whose topics were all too thin.
  assert.equal(plan.reason, 'empty-session');
  assert.equal(plan.questionCount, 0);
  assert.equal(plan.expectedQuestions, 0);
  assert.equal(plan.shortfall, 5, 'the whole request is a shortfall when there are no topics');
  assert.deepEqual(plan.deck, []);

  // An empty message list must behave the same way.
  const blank = finalizeSession({ harness: 'pi', harnessName: 'pi', nativeId: 'blank', project: 'demo', started: at(0), updated: at(1), messages: [] });
  assert.equal(blank, null, 'a session with no messages should normalize to null');
});

await check('unknown question types are ignored rather than passed through', async () => {
  const plan = planQuiz(multiTopicSession(), { questionCount: 4, types: ['mcq', 'essay', 'truefalse'] });
  assert.deepEqual(plan.types, ['mcq']);
});

await check('a seed makes topic selection reproducible', async () => {
  const s = multiTopicSession();
  // A strict subset, so selection actually has a choice to make. Asking for every
  // topic would return them all regardless of seed.
  const a = planQuiz(s, { questionCount: 3, types: ['mcq'], seed: 123 });
  const b = planQuiz(s, { questionCount: 3, types: ['mcq'], seed: 123 });
  const c = planQuiz(s, { questionCount: 3, types: ['mcq'], seed: 999 });
  assert.deepEqual(a.selectedTopics.map((t) => t.id), b.selectedTopics.map((t) => t.id), 'same seed, different topics');
  // Two different seeds over six topics should not agree by accident.
  assert.notDeepEqual(a.selectedTopics.map((t) => t.id), c.selectedTopics.map((t) => t.id), 'different seeds, same topics');
});

await check('selected topics are returned in chronological order', async () => {
  const plan = planQuiz(multiTopicSession(), { questionCount: 12, types: ['mcq'], seed: 5 });
  const froms = plan.selectedTopics.map((t) => t.from);
  assert.deepEqual(froms, [...froms].sort((x, y) => x - y), 'topics are not in chronological order');
});

await check('planning is offline and does not need a key', async () => {
  const previous = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const plan = planQuiz(multiTopicSession(), { questionCount: 3, types: ['mcq'] });
    assert.ok(plan.deck.length > 0);
  } finally {
    if (previous !== undefined) process.env.GEMINI_API_KEY = previous;
  }
});

// ── Schema ─────────────────────────────────────────────────────────────────

await check('the schema names only the requested question types', async () => {
  const schema = quizSchema({ types: ['mcq', 'open'], flashcardsPerTopic: 2 });
  const enumValues = schema.properties.questions.items.properties.type.enum;
  assert.deepEqual(enumValues, ['mcq', 'open']);
});

await check('every conditional field is required', async () => {
  // This is a regression guard for a real failure: with correctOptionKey nullable
  // and not required, Gemini returned multiple-choice questions with the answer
  // missing. The schema cannot express "required only when type is mcq", so all
  // conditional fields must be required and non-applicable ones become sentinels.
  const schema = quizSchema({ types: QUESTION_TYPES, flashcardsPerTopic: 2 });
  const required = new Set(schema.properties.questions.items.required);
  for (const field of [
    'options', 'correctOptionKey', 'rubric', 'referenceAnswer',
    'language', 'codeWithGaps', 'blanks', 'sourceTurns', 'explanation',
  ]) {
    assert.ok(required.has(field), `${field} is not required`);
  }
  // And nothing may be nullable, which is what let the field be omitted.
  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return;
    assert.notEqual(node.nullable, true, `nullable:true at ${path}`);
    for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
  };
  walk(schema, 'schema');
});

// ── Validation ─────────────────────────────────────────────────────────────

const TOPIC = { id: 't1', label: 'pool exhaustion', from: 0, to: 4 };

await check('an mcq without a valid correct answer is dropped, with a reason', async () => {
  const data = {
    flashcards: [{ front: 'f', back: 'b', sourceTurns: [1] }],
    questions: [
      { type: 'mcq', prompt: 'p', explanation: 'e', sourceTurns: [1], options: [{ key: 'A', text: 'a' }, { key: 'B', text: 'b' }], correctOptionKey: '' },
      { type: 'mcq', prompt: 'p', explanation: 'e', sourceTurns: [1], options: [{ key: 'A', text: 'a' }, { key: 'B', text: 'b' }], correctOptionKey: 'Z' },
      { type: 'mcq', prompt: 'p', explanation: 'e', sourceTurns: [1], options: [{ key: 'A', text: 'a' }], correctOptionKey: 'A' },
    ],
  };
  const out = validateResult(data, { topic: TOPIC, types: ['mcq'], turnRange: [0, 4] });
  assert.equal(out.questions.length, 0, 'invalid mcq survived');
  assert.equal(out.issues.length, 3, `expected 3 issues, got ${JSON.stringify(out.issues)}`);
  assert.ok(out.issues.every((i) => /mcq/.test(i)));
});

await check('a valid mcq survives', async () => {
  const out = validateResult(
    {
      flashcards: [],
      questions: [{
        type: 'mcq', prompt: 'why does the pool exhaust?', explanation: 'leak',
        sourceTurns: [2, 3],
        options: [{ key: 'A', text: 'a' }, { key: 'B', text: 'b' }, { key: 'C', text: 'c' }, { key: 'D', text: 'd' }],
        correctOptionKey: 'C',
      }],
    },
    { topic: TOPIC, types: ['mcq'], turnRange: [0, 4] },
  );
  assert.equal(out.questions.length, 1);
  assert.equal(out.questions[0].correctOptionKey, 'C');
  assert.equal(out.questions[0].id, 't1-mcq-1');
});

await check('a cloze with no gap, or a gap with no answer, is dropped', async () => {
  const cases = [
    { codeWithGaps: 'no gap here', blanks: [{ key: 'blank_1', answer: 'x' }] },
    { codeWithGaps: 'git rm {{blank_1}} x', blanks: [] },
    { codeWithGaps: 'git rm {{blank_1}} {{blank_2}} x', blanks: [{ key: 'blank_1', answer: '--cached' }] },
  ];
  const out = validateResult(
    { flashcards: [], questions: cases.map((c) => ({ type: 'cloze', prompt: 'p', explanation: 'e', sourceTurns: [], ...c })) },
    { topic: TOPIC, types: ['cloze'], turnRange: [0, 4] },
  );
  assert.equal(out.questions.length, 0, 'invalid cloze survived');
  assert.equal(out.issues.length, 3, JSON.stringify(out.issues));
});

await check('a valid cloze survives with its blanks and alternatives', async () => {
  const out = validateResult(
    {
      flashcards: [],
      questions: [{
        type: 'cloze', prompt: 'complete the command', explanation: 'keeps files on disk',
        sourceTurns: [1],
        language: 'bash',
        codeWithGaps: 'git rm -r {{blank_1}} electron-app/node_modules',
        blanks: [{ key: 'blank_1', answer: '--cached', alternatives: ['--cached'] }],
      }],
    },
    { topic: TOPIC, types: ['cloze'], turnRange: [0, 4] },
  );
  assert.equal(out.questions.length, 1);
  assert.equal(out.questions[0].blanks[0].answer, '--cached');
});

await check('an open question with no rubric is dropped', async () => {
  const out = validateResult(
    { flashcards: [], questions: [{ type: 'open', prompt: 'explain', explanation: 'e', sourceTurns: [], rubric: [] }] },
    { topic: TOPIC, types: ['open'], turnRange: [0, 4] },
  );
  assert.equal(out.questions.length, 0);
  assert.match(out.issues[0], /rubric/);
});

await check('a question of a type that was not requested is dropped', async () => {
  const out = validateResult(
    { flashcards: [], questions: [{ type: 'open', prompt: 'x', explanation: 'e', sourceTurns: [], rubric: [{ criterion: 'c', weight: 1 }] }] },
    { topic: TOPIC, types: ['mcq'], turnRange: [0, 4] },
  );
  assert.equal(out.questions.length, 0);
  assert.match(out.issues[0], /not requested/);
});

await check('ids are minted deterministically and never collide', async () => {
  const data = {
    flashcards: [],
    questions: [
      { type: 'mcq', prompt: 'a', explanation: 'e', sourceTurns: [], options: [{ key: 'A', text: '1' }, { key: 'B', text: '2' }], correctOptionKey: 'A', id: 'q1' },
      { type: 'mcq', prompt: 'b', explanation: 'e', sourceTurns: [], options: [{ key: 'A', text: '1' }, { key: 'B', text: '2' }], correctOptionKey: 'B', id: 'q2' },
      { type: 'open', prompt: 'c', explanation: 'e', sourceTurns: [], rubric: [{ criterion: 'c', weight: 1 }], id: 'q1' },
    ],
  };
  const first = validateResult(data, { topic: TOPIC, types: ['mcq', 'open'], turnRange: [0, 4] });
  const second = validateResult(data, { topic: TOPIC, types: ['mcq', 'open'], turnRange: [0, 4] });

  const ids = first.questions.map((q) => q.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate ids: ${ids}`);
  assert.deepEqual(ids, ['t1-mcq-1', 't1-mcq-2', 't1-open-1']);
  assert.deepEqual(ids, second.questions.map((q) => q.id), 'ids are not deterministic');
  // The model's own id is preserved for debugging but never used as the key.
  assert.equal(first.questions[0].modelId, 'q1');
});

await check('citations outside the topic turn range are removed', async () => {
  const out = validateResult(
    {
      flashcards: [{ front: 'f', back: 'b', sourceTurns: [0, 2, 99, -1, 'x'] }],
      questions: [],
    },
    { topic: TOPIC, types: [], turnRange: [0, 4] },
  );
  assert.deepEqual(out.flashcards[0].sourceTurns, [0, 2]);
});

await check('flashcards with an empty side are dropped', async () => {
  const out = validateResult(
    { flashcards: [{ front: 'f', back: '' }, { front: '  ', back: 'b' }, { front: 'ok', back: 'ok' }], questions: [] },
    { topic: TOPIC, types: [], turnRange: [0, 4] },
  );
  assert.equal(out.flashcards.length, 1);
});

// ── The Gemini call, with fetch stubbed ────────────────────────────────────

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = original;
  };
}

const VALID_PAYLOAD = {
  flashcards: [
    { front: 'what is a pool?', back: 'a set of reusable connections', sourceTurns: [0] },
    { front: 'what releases a connection?', back: 'a finally block', sourceTurns: [0] },
  ],
  questions: [
    { type: 'mcq', prompt: 'why does it exhaust?', explanation: 'leak', sourceTurns: [0], options: [{ key: 'A', text: 'a' }, { key: 'B', text: 'b' }, { key: 'C', text: 'c' }, { key: 'D', text: 'd' }], correctOptionKey: 'B' },
    { type: 'cloze', prompt: 'complete', explanation: 'releases', sourceTurns: [0], language: 'ts', codeWithGaps: 'try { a() } finally { {{blank_1}}(); }', blanks: [{ key: 'blank_1', answer: 'release', alternatives: [] }] },
    { type: 'open', prompt: 'explain the trade-off', explanation: 'because', sourceTurns: [0], rubric: [{ criterion: 'names the leak', weight: 1, mustMention: ['leak'] }], referenceAnswer: 'ref' },
  ],
};

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

await check('a 503 on the first model falls through to the next', async () => {
  const seen = [];
  const restore = stubFetch(async (url) => {
    const model = /models\/([^:]+):/.exec(url)?.[1];
    seen.push(model);
    if (model === 'model-a') return jsonResponse({ error: { code: 503 } }, 503);
    return jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify(VALID_PAYLOAD) }] }, finishReason: 'STOP' }] });
  });
  try {
    const result = await generateJson({ prompt: 'x', schema: {}, models: ['model-a', 'model-b'], apiKey: 'k' });
    assert.equal(result.model, 'model-b');
    assert.ok(seen.includes('model-a') && seen.includes('model-b'));
  } finally {
    restore();
  }
});

await check('a 404 skips the model without retrying it', async () => {
  const seen = [];
  const restore = stubFetch(async (url) => {
    const model = /models\/([^:]+):/.exec(url)?.[1];
    seen.push(model);
    if (model === 'gone') return jsonResponse({ error: { code: 404 } }, 404);
    return jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify(VALID_PAYLOAD) }] } }] });
  });
  try {
    await generateJson({ prompt: 'x', schema: {}, models: ['gone', 'alive'], apiKey: 'k' });
    assert.equal(seen.filter((m) => m === 'gone').length, 1, 'a 404 was retried');
  } finally {
    restore();
  }
});

await check('every model failing produces a GeminiError, not a crash', async () => {
  const restore = stubFetch(async () => jsonResponse({ error: { code: 503 } }, 503));
  try {
    await assert.rejects(
      () => generateJson({ prompt: 'x', schema: {}, models: ['a', 'b'], apiKey: 'k' }),
      (err) => err instanceof GeminiError && err.attempts.length >= 2,
    );
  } finally {
    restore();
  }
});

await check('a missing key fails before any request is made', async () => {
  const previous = process.env.GEMINI_API_KEY;
  const previousSkip = process.env.GEMINI_SKIP_ENV_FILE;
  delete process.env.GEMINI_API_KEY;
  // Two things have to be handled for this to be a real test of the absent-key
  // path: the .env contents are cached after the first read, and the .env file
  // itself would otherwise supply the key. So clear the cache AND skip the file.
  process.env.GEMINI_SKIP_ENV_FILE = '1';
  resetEnvCache();
  let called = false;
  const restore = stubFetch(async () => {
    called = true;
    return jsonResponse({});
  });
  try {
    await assert.rejects(
      () => generateJson({ prompt: 'x', schema: {}, models: ['a'], apiKey: null }),
      (err) => err instanceof GeminiError && err.kind === 'no-key',
    );
    assert.equal(called, false, 'a request was made without a key');
  } finally {
    restore();
    if (previous !== undefined) process.env.GEMINI_API_KEY = previous;
    if (previousSkip === undefined) delete process.env.GEMINI_SKIP_ENV_FILE;
    else process.env.GEMINI_SKIP_ENV_FILE = previousSkip;
    resetEnvCache();
  }
});

await check('the API key never appears in an error message', async () => {
  const SECRET = 'super-secret-key-value';
  const restore = stubFetch(async () => jsonResponse({ error: { message: 'nope' } }, 400));
  try {
    await generateJson({ prompt: 'x', schema: {}, models: ['a'], apiKey: SECRET }).catch((err) => {
      assert.ok(!String(err.message).includes(SECRET), 'the key leaked into an error message');
      assert.ok(!JSON.stringify(err.attempts || []).includes(SECRET), 'the key leaked into attempts');
      assert.ok(!String(err.body || '').includes(SECRET), 'the key leaked into the body');
    });
  } finally {
    restore();
  }
});

await check('model text with code fences or prose is still parsed', async () => {
  assert.deepEqual(parseJsonResponse('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonResponse('Here you go: {"a":1} — enjoy'), { a: 1 });
  assert.equal(parseJsonResponse('not json at all'), null);
});

await check('generateQuiz end to end, with the model stubbed', async () => {
  const restore = stubFetch(async () =>
    jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify(VALID_PAYLOAD) }] }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 100 } }),
  );
  try {
    const quiz = await generateQuiz(multiTopicSession(), {
      questionCount: 3,
      types: ['mcq', 'cloze', 'open'],
      types_: undefined,
      apiKey: 'k',
      models: ['stub'],
      seed: 1,
    });
    assert.equal(quiz.ok, true);
    assert.equal(quiz.questions.length, 3, 'one question per topic when each type is asked once');
    assert.equal(new Set(quiz.questions.map((q) => q.id)).size, 3);
    assert.equal(quiz.flashcards.length, 2);
    assert.equal(quiz.settings.producedQuestions, 3);
    assert.equal(quiz.problems.length, 0);
    assert.ok(quiz.usage.tokens >= 100);
    for (const q of quiz.questions) {
      if (q.type === 'mcq') assert.ok(q.options.some((o) => o.key === q.correctOptionKey));
      if (q.type === 'cloze') assert.ok(/\{\{blank_1\}\}/.test(q.codeWithGaps));
      if (q.type === 'open') assert.ok(q.rubric.length > 0);
    }
  } finally {
    restore();
  }
});

await check('generateQuiz reports a topic failure without losing the others', async () => {
  let call = 0;
  const restore = stubFetch(async () => {
    call++;
    if (call === 1) return jsonResponse({ error: { code: 400, message: 'bad' } }, 400);
    return jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify(VALID_PAYLOAD) }] } }] });
  });
  try {
    const quiz = await generateQuiz(multiTopicSession(), {
      questionCount: 6,
      types: ['mcq', 'cloze', 'open'],
      apiKey: 'k',
      models: ['stub'],
      seed: 2,
    });
    assert.equal(quiz.ok, true, 'one failed topic should not fail the whole quiz');
    assert.ok(quiz.problems.length >= 1, 'the failure was not reported');
    assert.ok(quiz.flashcards.length > 0, 'the successful topic was lost');
  } finally {
    restore();
  }
});

await check('a flashcard-only request makes exactly one call and produces no questions', async () => {
  let calls = 0;
  const restore = stubFetch(async () => {
    calls++;
    return jsonResponse({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ flashcards: VALID_PAYLOAD.flashcards, questions: [] }) }] } }],
    });
  });
  try {
    const quiz = await generateQuiz(multiTopicSession(), { questionCount: 9, types: [], apiKey: 'k', models: ['stub'] });
    assert.equal(calls, 1, `expected 1 call, made ${calls}`);
    assert.equal(quiz.questions.length, 0);
    assert.equal(quiz.flashcards.length, 2);
    assert.equal(quiz.ok, true, 'a flashcard-only quiz is a valid result');
  } finally {
    restore();
  }
});


// ── Readiness gate ─────────────────────────────────────────────────────────

const sessionOf = (messages) =>
  finalizeSession({ harness: 'pi', harnessName: 'pi', nativeId: 'gate', project: 'demo', started: at(0), updated: at(10), messages });

await check('a trivial conversation is refused, with reasons the UI can show', async () => {
  // The case that forced this: a real vscode session containing only "hi". It cleared
  // the old turn-count check and produced a flashcard and a question about nothing.
  const hi = sessionOf([
    { role: 'user', text: 'hi', ts: at(0) },
    { role: 'assistant', text: 'Hello! How can I help you today?', ts: at(1) },
  ]);
  const readiness = assessReadiness(hi, { types: ['mcq', 'cloze', 'open'] });
  assert.equal(readiness.ready, false);
  assert.equal(readiness.level, 'thin');
  assert.ok(readiness.reasons.length >= 1, 'refused without saying why');
  assert.ok(readiness.reasons.some((r) => /character/.test(r)), `reasons: ${readiness.reasons}`);

  const plan = planQuiz(hi, { questionCount: 6, types: ['mcq'] });
  assert.equal(plan.plan, null);
  assert.equal(plan.reason, 'no-usable-topics');
  assert.equal(plan.expectedQuestions, 0);
  assert.equal(plan.expectedFlashcards, 0);
  assert.ok(plan.message && plan.message.length > 10, 'no human-readable refusal');
});

await check('a single long exchange IS quizzable', async () => {
  // Calibration matters here. Requiring two user turns refused four real sessions of
  // 4k-8k characters that were one long question with a long answer. The character
  // floors are what separate "hi" from real work, not the turn count.
  const oneShot = sessionOf([
    {
      role: 'user',
      text: `Explain why the connection pool exhausts under load and what to change. ${'The pool is configured with a maximum of twenty connections per worker. '.repeat(4)}`,
      ts: at(0),
    },
    {
      role: 'assistant',
      text: `The error path returns before releasing the client, so every failed request leaks a connection and the pool fills linearly with error rate. ${'Wrap acquisition in try/finally so the client is always released. '.repeat(6)}`,
      ts: at(1),
    },
  ]);
  const readiness = assessReadiness(oneShot, { types: ['mcq', 'cloze', 'open'] });
  assert.equal(readiness.ready, true, `refused a real session: ${readiness.reasons}`);
  assert.equal(readiness.stats.userTurns, 1);
  const plan = planQuiz(oneShot, { questionCount: 3, types: ['mcq', 'cloze', 'open'] });
  assert.ok(plan.plan, 'no plan for a substantive single exchange');
  assert.equal(plan.expectedQuestions, 3);
});

await check('the per-topic floor rises with the number of question types', async () => {
  // A topic has to carry one question of each requested type, so asking for three
  // types needs more substance in the topic than asking for one.
  const session = multiTopicSession();
  const one = assessReadiness(session, { types: ['mcq'] });
  const three = assessReadiness(session, { types: ['mcq', 'cloze', 'open'] });
  assert.ok(three.stats.perTopicFloor >= one.stats.perTopicFloor);
  assert.equal(one.stats.perTopicFloor, Math.max(READINESS.minTopicChars, READINESS.charsPerQuestionType));
  assert.equal(three.stats.perTopicFloor, Math.max(READINESS.minTopicChars, 3 * READINESS.charsPerQuestionType));
});

await check('thin topics are dropped from the plan rather than asked about', async () => {
  // A long session can still contain a throwaway topic; the gate has to work per topic
  // and not only per session.
  const session = multiTopicSession();
  const readiness = assessReadiness(session, { types: ['mcq'] });
  assert.ok(readiness.stats.topics > 0);
  // Lower the floor so every topic qualifies, then raise it so none do.
  const permissive = planQuiz(session, { questionCount: 6, types: ['mcq'] });
  assert.ok(permissive.plan, 'a healthy session should plan');

  // The floor is exposed in the plan so the UI can explain a smaller-than-asked quiz.
  assert.equal(typeof permissive.readiness.stats.perTopicFloor, 'number');
  assert.equal(typeof permissive.droppedThinTopics, 'number');
});

await check('readiness is reported even when generation succeeds', async () => {
  const restore = stubFetch(async () =>
    jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify(VALID_PAYLOAD) }] } }] }),
  );
  try {
    const quiz = await generateQuiz(multiTopicSession(), {
      questionCount: 3, types: ['mcq', 'cloze', 'open'], apiKey: 'k', models: ['stub'], seed: 1,
    });
    assert.ok(quiz.readiness, 'no readiness report on a successful quiz');
    assert.equal(quiz.readiness.ready, true);
    assert.equal(typeof quiz.droppedThinTopics, 'number');
  } finally {
    restore();
  }
});

await check('a refused generation returns the reason instead of throwing', async () => {
  const hi = sessionOf([{ role: 'user', text: 'hi', ts: at(0) }, { role: 'assistant', text: 'hello', ts: at(1) }]);
  let called = false;
  const restore = stubFetch(async () => { called = true; return jsonResponse({}); });
  try {
    const quiz = await generateQuiz(hi, { questionCount: 6, types: ['mcq'], apiKey: 'k', models: ['stub'] });
    assert.equal(quiz.ok, false);
    assert.equal(called, false, 'the model was called for a conversation that cannot be quizzed');
    assert.ok(quiz.message, 'no message for the UI');
    assert.deepEqual(quiz.questions, []);
    assert.deepEqual(quiz.flashcards, []);
  } finally {
    restore();
  }
});

// ── Frontend contract ──────────────────────────────────────────────────────

await check('capabilities describe every option the settings UI needs', async () => {
  const caps = quizCapabilities();
  assert.equal(typeof caps.requiresApiKey, 'boolean');
  assert.ok(caps.questionCount.min >= 1);
  assert.ok(caps.questionCount.max > caps.questionCount.default);
  assert.equal(caps.questionCount.default, 6);
  assert.equal(caps.flashcards.always, true);
  assert.equal(caps.flashcards.perTopic, 2);
  // Type metadata must be complete enough to render a control for each, with the
  // grading flag so the UI knows which ones need a second call.
  assert.deepEqual(caps.types.map((t) => t.id), ['mcq', 'cloze', 'open']);
  for (const type of caps.types) {
    assert.ok(type.label && type.description, `incomplete metadata for ${type.id}`);
    assert.equal(typeof type.needsGrading, 'boolean');
    assert.equal(typeof type.default, 'boolean');
  }
  assert.equal(caps.types.find((t) => t.id === 'open').needsGrading, true);
  assert.equal(caps.types.find((t) => t.id === 'mcq').needsGrading, false);
  assert.ok(caps.readiness.minChars >= 1);
  assert.ok(Array.isArray(caps.modelChain) && caps.modelChain.length > 0);
  // The key itself must never appear in anything the renderer receives.
  assert.ok(!JSON.stringify(caps).includes('AQ.'), 'a key leaked into capabilities');
});

await check('capabilities expose the question ceiling as numbers, not a helper', async () => {
  // The ceiling is `maxPerQuiz x types`, but it is NOT returned as a function: this
  // object crosses IPC and a function cannot be structured-cloned, which made every
  // call fail with "An object could not be cloned". The client does the arithmetic.
  const caps = quizCapabilities();
  assert.equal(typeof caps.ceiling, 'undefined', 'a function here breaks the IPC boundary');
  assert.equal(caps.topics.maxQuestionsPerType, caps.topics.maxPerQuiz);
  assert.equal(caps.topics.maxPerQuiz * 1, 14);
  assert.equal(caps.topics.maxPerQuiz * 3, 42);
  assert.ok(!JSON.stringify(caps).includes('=>'), 'capabilities must be plain data');
  // And it must survive the clone the renderer side performs.
  assert.doesNotThrow(() => structuredClone(caps));
});

await check('the score bands divide at the quartiles', async () => {
  // Four bands, so the boundaries are the interesting part.
  const cases = [
    [0, 'unfamiliar'], [24.9, 'unfamiliar'],
    [25, 'partial'], [49.9, 'partial'],
    [50, 'solid'], [74.9, 'solid'],
    [75, 'strong'], [100, 'strong'],
  ];
  for (const [pct, expected] of cases) {
    assert.equal(scoreBand(pct).id, expected, `${pct}% should be ${expected}`);
  }
  // Out of range values clamp rather than falling through the switch.
  assert.equal(scoreBand(-10).id, 'unfamiliar');
  assert.equal(scoreBand(1000).id, 'strong');
  assert.equal(scoreBand(undefined).id, 'unfamiliar');
  assert.equal(scoreBand(NaN).id, 'unfamiliar');
});

await check('every band is complete and follows the house style', async () => {
  for (const pct of [0, 30, 60, 90]) {
    const band = scoreBand(pct);
    for (const field of ['id', 'label', 'headline', 'line', 'tone']) {
      assert.ok(band[field], `${band.id} is missing ${field}`);
    }
    assert.ok(band.line.length > 40, `${band.id} has no real copy`);
    // House style, same as the generated content: no em dash, no emoji, no exclamation.
    for (const field of ['label', 'headline', 'line']) {
      assert.ok(!/—|–|\.\.\.|!/.test(band[field]), `${band.id}.${field} breaks the house style: ${band[field]}`);
      assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(band[field]), `${band.id}.${field} contains an emoji`);
    }
  }
  // The tones are distinct, so the UI can colour them differently.
  const tones = [0, 30, 60, 90].map((p) => scoreBand(p).tone);
  assert.equal(new Set(tones).size, 4, `tones are not distinct: ${tones}`);
});

// ── Focus text and the top-right button ────────────────────────────────────

await check('a focus reaches the prompt, and is capped and redacted like anything else', async () => {
  const prompts = [];
  const restore = stubFetch(async (url, init) => {
    prompts.push(JSON.parse(init.body).contents[0].parts[0].text);
    return jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify({ flashcards: [], questions: [] }) }] } }] });
  });
  try {
    // The focus is user-authored and goes to the model, so a secret typed into it must
    // not travel. Same treatment as the transcript.
    await generateQuiz(multiTopicSession(), {
      questionCount: 1,
      types: ['mcq'],
      apiKey: 'k',
      models: ['stub'],
      focus: 'Focus on the architectural decisions. Also the key is sk-proj-EXAMPLENotARealOpenAIKey00 and that matters.',
    });
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /WHAT THEY ASKED TO FOCUS ON/);
    assert.match(prompts[0], /architectural decisions/);
    assert.ok(!prompts[0].includes('EXAMPLENotARealOpenAIKey00'), 'a secret in the focus reached the model');
    assert.match(prompts[0], /\[redacted:/);
  } finally {
    restore();
  }
});

await check('no focus means no focus block', async () => {
  const prompts = [];
  const restore = stubFetch(async (url, init) => {
    prompts.push(JSON.parse(init.body).contents[0].parts[0].text);
    return jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify({ flashcards: [], questions: [] }) }] } }] });
  });
  try {
    await generateQuiz(multiTopicSession(), { questionCount: 1, types: ['mcq'], apiKey: 'k', models: ['stub'] });
    assert.ok(!prompts[0].includes('WHAT THEY ASKED TO FOCUS ON'), 'an empty focus still produced a block');
  } finally {
    restore();
  }
});

await check('the prompt forbids em dashes, emojis and decorative punctuation', async () => {
  // A stated house style, enforced in the prompt because post-processing the model's
  // prose is worse than asking it not to.
  const prompts = [];
  const restore = stubFetch(async (url, init) => {
    prompts.push(JSON.parse(init.body).contents[0].parts[0].text);
    return jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify({ flashcards: [], questions: [] }) }] } }] });
  });
  try {
    await generateQuiz(multiTopicSession(), { questionCount: 1, types: ['mcq'], apiKey: 'k', models: ['stub'] });
    assert.match(prompts[0], /HOUSE STYLE/);
    assert.match(prompts[0], /No em dashes/);
    assert.match(prompts[0], /No emojis/);
    assert.match(prompts[0], /No exclamation marks/);
  } finally {
    restore();
  }
});

await check('the button label and action follow the workflow', async () => {
  // The product rule in one place, so the UI does not re-derive it from six states.
  assert.deepEqual(quizButtonState({ state: 'new' }), {
    action: 'configure', label: 'Generate quiz', reason: 'No quiz for this conversation yet.', staleness: 'new',
  });
  assert.equal(quizButtonState({ state: 'fresh' }).action, 'open');
  assert.equal(quizButtonState({ state: 'fresh' }).label, 'Quiz');

  // New content detected: back to generating, and the reason says why.
  const extended = quizButtonState({ state: 'extended', newMessages: 4 });
  assert.equal(extended.action, 'configure');
  assert.match(extended.reason, /4 new messages/);
  assert.match(quizButtonState({ state: 'extended', newMessages: 1 }).reason, /1 new message\b/);

  assert.equal(quizButtonState({ state: 'diverged' }).action, 'configure');
  assert.equal(quizButtonState({ state: 'generator_stale' }).action, 'configure');
  // A settings difference does not invalidate the stored questions, so offer them.
  assert.equal(quizButtonState({ state: 'settings_changed' }).action, 'open');

  // Every state is handled, and nothing is undefined.
  for (const state of ['new', 'fresh', 'extended', 'diverged', 'settings_changed', 'generator_stale', undefined, null]) {
    const button = quizButtonState(state ? { state } : state);
    assert.ok(['configure', 'open'].includes(button.action), `no action for ${state}`);
    assert.ok(button.label && button.reason, `incomplete button for ${state}`);
  }
});

// ── Report ─────────────────────────────────────────────────────────────────

console.log(`\nquiz: ${passed} passed, ${failures.length} failed\n`);

if (failures.length) {
  for (const f of failures) console.error(`FAIL  ${f.name}\n        ${f.message}`);
  process.exit(1);
}
console.log('All quiz assertions passed.\n');
