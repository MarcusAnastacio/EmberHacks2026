// Quiz generation.
//
// THE WORKFLOW THIS IMPLEMENTS
//   1. the conversation is split into topics deterministically          (lib/topics.js)
//   2. a random subset of those topics is chosen for the requested size
//   3. every chosen topic yields 2 flashcards and 1 question per enabled type
//   4. one Gemini call per topic, walking a model fallback chain        (lib/gemini.js)
//
// Flashcards are not optional in the product: the user learns the prerequisite
// knowledge first, then answers. So every selected topic always produces two, even
// when no question types are enabled and the quiz is a pure flashcard deck.
//
// WHY ONE CALL PER TOPIC AND NOT ONE FOR EVERYTHING
// A single call over the whole session is the thing this design exists to avoid: it
// would be unbounded. Per topic it is bounded by topicSlice's cap, the topics are
// generated in parallel, and one malformed response costs one topic instead of the
// whole quiz.

import { deriveTopics, topicSlice } from './topics.js';
import { generateJson } from './gemini.js';

export const QUESTION_TYPES = ['mcq', 'cloze', 'open'];

export const DEFAULTS = {
  /** How many questions the user asked for. Flashcards are additional. */
  questionCount: 6,
  /** Any combination of QUESTION_TYPES, including none (flashcards only). */
  types: ['mcq', 'cloze', 'open'],
  /** Flashcards per topic. The product fixes this at 2. */
  flashcardsPerTopic: 2,
  /** Chars of conversation sent per topic. */
  maxCharsPerTopic: 12000,
  /** Upper bound on topics considered, independent of the question count. */
  maxTopics: 14,
  temperature: 0.75,
  /** Optional. Given, topic selection is reproducible; omitted, it is random. */
  seed: null,
};

// ── Planning (deterministic, no API) ───────────────────────────────────────

/** Small deterministic PRNG so an optional seed makes selection reproducible. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(items, seed) {
  const out = [...items];
  const rand = seed === null || seed === undefined ? Math.random : mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Decide which topics to use and what to ask each one for. Pure: no API, no disk.
 *
 * Topic count is derived from the request rather than fixed, so the user's "number
 * of questions" is what drives the work:
 *
 *   topics = ceil(questionCount / enabledTypes)      (at least 1)
 *
 * With 6 questions and all three types, that is 2 topics: two flashcards and three
 * questions each, which is 6. With 6 questions and mcq only, it is 6 topics. With no
 * types enabled the question count is 0 and a single topic still yields the deck.
 *
 * @returns {object} plan
 */
export function planQuiz(session, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const types = [...new Set((opts.types || []).filter((t) => QUESTION_TYPES.includes(t)))];

  const requested = types.length === 0 ? 0 : Math.max(0, Math.floor(opts.questionCount));
  const topicsNeeded = types.length === 0 ? 1 : Math.max(1, Math.ceil(requested / types.length));

  const { topics, stats: topicStats } = deriveTopics(session, { maxTopics: opts.maxTopics });
  if (topics.length === 0) {
    // No topics means no questions, and `questionCount` is not in scope yet — it is
    // capped against the deck further down. Referring to it here crashed with a
    // temporal-dead-zone error on any session with no user turns, which is what a
    // sweep across every bundled fixture format turned up.
    return {
      plan: null,
      types,
      questionCount: 0,
      requestedQuestions: requested,
      shortfall: requested,
      requestedTopics: topicsNeeded,
      selectedTopics: [],
      deck: [],
      expectedQuestions: 0,
      expectedFlashcards: 0,
      topicStats,
      reason: 'no-topics',
    };
  }

  // Random subset, unless a seed was given. "Random" is deliberate: regenerating a
  // quiz from the same long session should give a different set of questions rather
  // than the same first three topics every time.
  const ordered = shuffle(topics, opts.seed);
  const selected = ordered.slice(0, Math.min(topicsNeeded, topics.length));
  // Back to chronological order so the deck reads in the order things happened.
  selected.sort((a, b) => a.from - b.from);

  // Assign one question per (topic, type) pair, cycling types across topics so the
  // question mix is even. A pair is never requested twice: asking a topic for two
  // multiple-choice questions contradicts "one main question per topic", and the
  // earlier loop could produce exactly that on a session with few topics.
  const deck = selected.map((topic) => ({ topicId: topic.id, label: topic.label, types: [] }));
  const maxQuestions = types.length === 0 ? 0 : deck.length * types.length;
  const questionCount = Math.min(requested, maxQuestions);

  for (let i = 0; i < questionCount; i++) {
    // Interleave by topic so the deck alternates subjects rather than blocking them.
    const topicIndex = i % deck.length;
    const typeIndex = Math.floor(i / deck.length) % types.length;
    deck[topicIndex].types.push(types[typeIndex]);
  }

  return {
    plan: {
      questionCount,
      types,
      flashcardsPerTopic: opts.flashcardsPerTopic,
      maxCharsPerTopic: opts.maxCharsPerTopic,
    },
    types,
    questionCount,
    requestedTopics: topicsNeeded,
    selectedTopics: selected.map((t) => ({
      id: t.id,
      label: t.label,
      messageRanges: t.messageRanges,
      files: t.files,
      score: t.score,
      chars: t.chars,
    })),
    deck,
    topicStats,
    /** How many questions the plan will actually produce, after rounding. */
    expectedQuestions: deck.reduce((n, d) => n + d.types.length, 0),
    expectedFlashcards: deck.length * opts.flashcardsPerTopic,
    /** The user's ask before it was capped by the available topics. */
    requestedQuestions: requested,
    /**
     * Questions the session cannot support. Non-zero when the conversation has
     * fewer topics than the requested count needs: with one question per topic per
     * type, N topics over T types is a hard ceiling of N x T.
     */
    shortfall: Math.max(0, requested - questionCount),
    reason: null,
  };
}

// ── Gemini schema ──────────────────────────────────────────────────────────

/**
 * The response schema for one topic.
 *
 * EVERY TYPE-SPECIFIC FIELD IS REQUIRED, with empty sentinels for the ones that do
 * not apply. This is not tidiness — it is a correction. With `correctOptionKey`
 * nullable and non-required, the model returned multiple-choice questions with the
 * *answer missing*. Gemini's responseSchema has no way to express "required only
 * when type is mcq", so the choice is between separate calls per type and one flat
 * object where every field is present. Flat with sentinels keeps it to one call per
 * topic, and `validateQuestion` enforces what the schema cannot.
 */
export function quizSchema({ types, flashcardsPerTopic }) {
  const questionTypes = types.length ? types : QUESTION_TYPES;
  return {
    type: 'object',
    properties: {
      flashcards: {
        type: 'array',
        description: `Exactly ${flashcardsPerTopic} flashcards teaching the prerequisite knowledge needed to answer the questions.`,
        items: {
          type: 'object',
          properties: {
            front: { type: 'string', description: 'A single term, concept or question.' },
            back: { type: 'string', description: 'A concise answer, two sentences at most.' },
            sourceTurns: { type: 'array', items: { type: 'integer' }, description: 'Turn numbers this came from.' },
          },
          required: ['front', 'back', 'sourceTurns'],
        },
      },
      questions: {
        type: 'array',
        description: 'One question for each requested type, in the order requested.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            type: { type: 'string', enum: questionTypes },
            prompt: { type: 'string', description: 'The question, self-contained and answerable from the excerpt.' },
            explanation: { type: 'string', description: 'Why the answer is correct.' },
            sourceTurns: { type: 'array', items: { type: 'integer' } },
            // mcq
            options: {
              type: 'array',
              description: 'For mcq only: exactly four options. Empty for other types.',
              items: {
                type: 'object',
                properties: { key: { type: 'string' }, text: { type: 'string' } },
                required: ['key', 'text'],
              },
            },
            correctOptionKey: { type: 'string', description: 'For mcq only: the key of the single correct option. Empty string otherwise.' },
            // open
            rubric: {
              type: 'array',
              description: 'For open only: grading criteria. Empty for other types.',
              items: {
                type: 'object',
                properties: {
                  criterion: { type: 'string' },
                  weight: { type: 'number' },
                  mustMention: { type: 'array', items: { type: 'string' } },
                },
                required: ['criterion', 'weight', 'mustMention'],
              },
            },
            referenceAnswer: { type: 'string', description: 'For open only. Empty string otherwise.' },
            // cloze
            language: { type: 'string', description: 'For cloze only: the code fence language. Empty string otherwise.' },
            codeWithGaps: { type: 'string', description: 'For cloze only: real code with each gap written as {{blank_1}}.' },
            blanks: {
              type: 'array',
              description: 'For cloze only: one entry per gap. Empty for other types.',
              items: {
                type: 'object',
                properties: {
                  key: { type: 'string' },
                  answer: { type: 'string' },
                  alternatives: { type: 'array', items: { type: 'string' } },
                },
                required: ['key', 'answer', 'alternatives'],
              },
            },
          },
          required: [
            'id', 'type', 'prompt', 'explanation', 'sourceTurns',
            'options', 'correctOptionKey', 'rubric', 'referenceAnswer',
            'language', 'codeWithGaps', 'blanks',
          ],
        },
      },
    },
    required: ['flashcards', 'questions'],
  };
}

// ── Prompt ─────────────────────────────────────────────────────────────────

function buildPrompt({ slice, topic, types, flashcardsPerTopic, session }) {
  const typeList = types.length ? types.join(', ') : 'none';
  const questionSpec = types.length
    ? `Produce exactly ${types.length} question${types.length === 1 ? '' : 's'}, one of each of these types: ${typeList}.`
    : 'Produce no questions this time — flashcards only.';

  const byType = {
    mcq: '- mcq: exactly four options keyed A-D, exactly one correct. Distractors must be plausible to someone who half-remembers the conversation, not obviously wrong.',
    cloze: '- cloze: real code taken from the excerpt, with the important expression replaced by {{blank_1}} (then {{blank_2}} if needed). The blank must be something the answer could not be guessed without understanding. Provide alternatives for any answer that has more than one correct spelling.',
    open: '- open: a free-text question that requires explaining a decision, a cause or a trade-off rather than recalling a fact. Provide a rubric of 2-4 weighted criteria and a reference answer.',
  };

  return `You are writing study material for the developer who had the conversation below.
They already did the work; this is to test whether they still understand it.

They chose the working directory: ${session.project}
Topic: ${topic.label}

WHAT TO PRODUCE
- Exactly ${flashcardsPerTopic} flashcards teaching the PREREQUISITE knowledge needed to answer the questions. They come first and must stand alone: define the concept, do not just restate what happened.
${questionSpec}
${types.map((t) => byType[t]).filter(Boolean).join('\n')}

THE EXCERPT
It has up to two labelled parts. PRECEDING CONTEXT is background from earlier in
the same session — read it to understand how the topic was reached, but do not ask
about it. Everything to ask about is under the TOPIC heading.

READABILITY
Write for someone skimming on a phone, not for a design review. The material is a
memory aid, so plain language beats precise jargon every time.
- Prefer short sentences. One idea each.
- Never stack nouns into a phrase. "a host-agnostic normalizer core" is precise and
  unreadable; write "the shared layer that reads every tool's history".
- A term you cannot avoid: define it in the same sentence, in plain words, the first
  time it appears. Then use it.
- Replace invented or specialised vocabulary with what it does. Not "the extraction
  layer performs span normalisation" but "the extractor rewrites the matched text".
- Keep real identifiers (file names, flags, function names) exactly as written, in
  backticks. They are the one place precision matters.
- Flashcards: the front is one short question, the back is one or two short sentences.
- Question prompts: under about 30 words. Put anything needed as context in an
  options list or the rubric, not in a long stem.

RULES
- Every question must be understandable on its own, by someone who has not read the
  excerpt. Do not open with "Following the updates to…", "Based on the evaluation
  of…", "As discussed…", or any other continuation phrasing, and do not refer to
  "the above", "earlier", or "the previous step". Name the subject explicitly:
  write "the regex extractor's handling of negation", not "its negation handling".
- Ground everything in the excerpt. Do not invent files, flags, APIs or numbers that do not appear in it.
- Quote real identifiers, file names and code exactly as written.
- sourceTurns must contain the turn numbers the material is drawn from. Only use turn numbers that appear in the excerpt.
- For a field that does not apply to a question's type, use an empty string or an empty array.
- Write in the register of documentation about a system, not a retelling of an event.
  Never write "the assistant", "the AI", "the model", "the conversation", "the
  transcript", "this session", or "the user". Address the reader directly: "you
  configured…", "the pool leaks because…", "why does the retry helper…".
- Ask about the system and the reasoning, not about who said what when.
- If the excerpt does not contain enough to write a question of a requested type, write the closest question it does support rather than inventing detail.

CONVERSATION EXCERPT
${slice.text}`;
}

// ── Validation ────────────────────────────────────────────────────────────

/**
 * Enforce what the response schema cannot.
 *
 * The schema guarantees the shape; it cannot guarantee that an mcq has a correct
 * answer, that a cloze has a gap, or that a citation points at a real turn. Anything
 * that fails is dropped with a reason rather than shipped as a broken question.
 */
export function validateResult(data, { topic, types, turnRange, idPrefix }) {
  const issues = [];
  const [minTurn, maxTurn] = turnRange;
  const inRange = (n) => Number.isInteger(n) && n >= minTurn && n <= maxTurn;
  // Ids are minted here, not taken from the model. The model numbers its own
  // questions per topic, so every topic produced a "q1" and the ids collided across
  // the quiz — which would make an attempt keyed by question id overwrite another
  // question's answer. Deterministic ids also keep scores comparable across
  // regenerations of the same topic.
  const perTypeCount = new Map();
  const mintId = (type) => {
    const n = (perTypeCount.get(type) || 0) + 1;
    perTypeCount.set(type, n);
    return `${idPrefix || topic.id}-${type}-${n}`;
  };

  const flashcards = (Array.isArray(data?.flashcards) ? data.flashcards : [])
    .filter((c) => c && typeof c.front === 'string' && typeof c.back === 'string' && c.front.trim() && c.back.trim())
    .map((c) => ({
      front: c.front.trim(),
      back: c.back.trim(),
      sourceTurns: (c.sourceTurns || []).filter(inRange),
      topicId: topic.id,
      topicLabel: topic.label,
    }));

  const questions = [];
  for (const raw of Array.isArray(data?.questions) ? data.questions : []) {
    const type = raw?.type;
    if (!types.includes(type)) {
      issues.push(`dropped question of type ${JSON.stringify(type)}: not requested`);
      continue;
    }
    const base = {
      id: mintId(type),
      modelId: raw.id ? String(raw.id) : undefined,
      type,
      topicId: topic.id,
      topicLabel: topic.label,
      prompt: String(raw.prompt || '').trim(),
      explanation: String(raw.explanation || '').trim(),
      sourceTurns: (raw.sourceTurns || []).filter(inRange),
    };
    if (!base.prompt) {
      issues.push(`dropped ${type}: empty prompt`);
      continue;
    }

    if (type === 'mcq') {
      const options = (raw.options || [])
        .filter((o) => o && typeof o.text === 'string' && o.text.trim())
        .map((o, i) => ({ key: String(o.key || 'ABCD'[i] || i + 1).trim(), text: o.text.trim() }));
      const correct = String(raw.correctOptionKey || '').trim();
      if (options.length < 2) {
        issues.push(`dropped mcq: only ${options.length} usable options`);
        continue;
      }
      if (!options.some((o) => o.key === correct)) {
        issues.push(`dropped mcq: correctOptionKey ${JSON.stringify(correct)} matches no option`);
        continue;
      }
      questions.push({ ...base, options, correctOptionKey: correct });
      continue;
    }

    if (type === 'cloze') {
      const code = String(raw.codeWithGaps || '');
      const blanks = (raw.blanks || [])
        .filter((b) => b && typeof b.answer === 'string' && b.answer.trim())
        .map((b, i) => ({
          key: String(b.key || `blank_${i + 1}`).trim(),
          answer: b.answer.trim(),
          alternatives: (b.alternatives || []).map(String).filter(Boolean),
        }));
      if (!/\{\{blank_\d+\}\}/.test(code)) {
        issues.push('dropped cloze: no {{blank_N}} marker in the code');
        continue;
      }
      if (blanks.length === 0) {
        issues.push('dropped cloze: no blanks');
        continue;
      }
      // A blank marker with no matching answer would render an unanswerable gap.
      const missing = [...code.matchAll(/\{\{(blank_\d+)\}\}/g)]
        .map((m) => m[1])
        .filter((k) => !blanks.some((b) => b.key === k));
      if (missing.length) {
        issues.push(`dropped cloze: no answer for ${missing.join(', ')}`);
        continue;
      }
      questions.push({ ...base, language: String(raw.language || '').trim(), codeWithGaps: code, blanks });
      continue;
    }

    if (type === 'open') {
      const rubric = (raw.rubric || [])
        .filter((r) => r && typeof r.criterion === 'string' && r.criterion.trim())
        .map((r) => ({
          criterion: r.criterion.trim(),
          weight: Number.isFinite(r.weight) && r.weight > 0 ? Number(r.weight) : 1,
          mustMention: (r.mustMention || []).map(String).filter(Boolean),
        }));
      if (rubric.length === 0) {
        issues.push('dropped open: no rubric, so it could not be graded');
        continue;
      }
      questions.push({ ...base, rubric, referenceAnswer: String(raw.referenceAnswer || '').trim() });
      continue;
    }
  }

  return { flashcards, questions, issues };
}

// ── Generation ─────────────────────────────────────────────────────────────

/**
 * Generate a full quiz.
 *
 * @param {object} session
 * @param {object} [options]  see DEFAULTS, plus apiKey/models/temperature/onProgress
 * @returns {Promise<object>} a complete quiz object
 */
export async function generateQuiz(session, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const plan = planQuiz(session, opts);

  if (!plan.plan) {
    return {
      ok: false,
      reason: plan.reason,
      message: 'This conversation is too short to split into topics.',
      topicStats: plan.topicStats,
    };
  }
  if (plan.deck.length === 0) {
    return { ok: false, reason: 'no-types-and-no-topics', message: 'Nothing to generate.' };
  }

  const schema = quizSchema({ types: plan.types, flashcardsPerTopic: opts.flashcardsPerTopic });
  const topicsById = new Map(deriveTopics(session, { maxTopics: opts.maxTopics }).topics.map((t) => [t.id, t]));

  const startedAt = Date.now();
  const perTopic = await Promise.all(
    plan.deck.map(async (slot, index) => {
      const topic = topicsById.get(slot.topicId);
      if (!topic) return { slot, error: 'topic disappeared', flashcards: [], questions: [], attempts: [] };

      const slice = topicSlice(session, topic, { maxChars: opts.maxCharsPerTopic });
      const prompt = buildPrompt({
        slice,
        topic,
        types: slot.types,
        flashcardsPerTopic: opts.flashcardsPerTopic,
        session,
      });

      opts.onProgress?.({ phase: 'topic-start', index, topicId: topic.id, label: topic.label, sliceChars: slice.chars });
      try {
        const { data, model, usage, attempts } = await generateJson({
          prompt,
          schema,
          models: opts.models,
          apiKey: opts.apiKey,
          temperature: opts.temperature,
          signal: opts.signal,
          onAttempt: (a) => opts.onProgress?.({ phase: 'attempt', ...a, topicId: topic.id }),
        });
        const validated = validateResult(data, { topic, types: slot.types, turnRange: [topic.from, topic.to] });
        opts.onProgress?.({
          phase: 'topic-done',
          index,
          topicId: topic.id,
          model,
          flashcards: validated.flashcards.length,
          questions: validated.questions.length,
          issues: validated.issues,
        });
        return { slot, topic, model, usage, attempts, ...validated };
      } catch (err) {
        opts.onProgress?.({ phase: 'topic-failed', index, topicId: topic.id, error: String(err?.message || err) });
        return { slot, topic, error: String(err?.message || err), flashcards: [], questions: [], attempts: err?.attempts || [] };
      }
    }),
  );

  // Assemble in the plan's order so the deck reads chronologically.
  const flashcards = [];
  const questions = [];
  const failures = [];
  for (const result of perTopic) {
    if (result.error) {
      failures.push({ topicId: result.slot.topicId, error: result.error });
      continue;
    }
    flashcards.push(...result.flashcards);
    questions.push(...result.questions);
    if (result.issues?.length) failures.push({ topicId: result.slot.topicId, issues: result.issues });
  }

  const attempts = perTopic.flatMap((r) => r.attempts || []);
  const modelsUsed = [...new Set(perTopic.map((r) => r.model).filter(Boolean))];

  return {
    ok: questions.length > 0 || flashcards.length > 0,
    sessionId: session.id,
    title: session.title,
    project: session.project,
    harness: session.harnessName,
    generatedAt: Date.now(),
    elapsedMs: Date.now() - startedAt,
    model: modelsUsed.join(', ') || null,
    settings: {
      questionCount: plan.questionCount,
      expectedQuestions: plan.expectedQuestions,
      producedQuestions: questions.length,
      types: plan.types,
      flashcardsPerTopic: plan.plan.flashcardsPerTopic,
    },
    topicsUsed: plan.selectedTopics,
    topicStats: plan.topicStats,
    flashcards,
    questions,
    problems: failures,
    usage: {
      calls: attempts.filter((a) => a.ok).length,
      attempts: attempts.length,
      tokens: perTopic.reduce((n, r) => n + (r.usage?.totalTokenCount || 0), 0),
    },
    plan: plan.deck,
  };
}
