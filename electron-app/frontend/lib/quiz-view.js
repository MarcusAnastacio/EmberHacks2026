// FUNCTIONAL LAYER — turns what the backend returns into what a view needs.
//
// A quiz from the backend mixes three question types plus flashcards, each with its own
// fields. If the visual layer read that shape directly, every visual change would have to
// re-learn it and every backend change would break rendering.
//
// So this file produces a flat list of STEPS with one shape:
//
//   { index, id, kind, topicId, topicLabel, prompt, choices?, correctId?, answer?, ... }
//
// The visual layer renders a step. It never sees `correctOptionKey`, `codeWithGaps` or
// `blanks` — only `choices` and what a correct response looks like.

/** @typedef {'flashcard'|'mcq'|'cloze'|'open'} StepKind */

const LETTERS = 'ABCDEFGH';

/**
 * Build the ordered step list for a quiz: every flashcard, then every question.
 *
 * Two phases rather than interleaved per topic. The flow is learn the prerequisites,
 * then be tested, and a single phase boundary is much easier to label in the UI
 * ("Flashcard 3 of 4" then "Question 1 of 6") than a topic-by-topic alternation.
 *
 * Steps are ordered for presentation only. Grading is by question id, so nothing here
 * affects a stored attempt.
 */
export function toSteps(quiz) {
  if (!quiz) return [];

  // Flashcards, grouped by topic so a topic's cards stay together.
  const cardsByTopic = new Map();
  for (const card of quiz.flashcards || []) {
    if (!cardsByTopic.has(card.topicId)) cardsByTopic.set(card.topicId, []);
    cardsByTopic.get(card.topicId).push(card);
  }

  const orderedTopicIds = [
    ...(quiz.topicsUsed || []).map((t) => t.id),
    ...[...cardsByTopic.keys()].filter((id) => !(quiz.topicsUsed || []).some((t) => t.id === id)),
  ];

  const steps = [];
  for (const topicId of orderedTopicIds) {
    for (const [index, card] of (cardsByTopic.get(topicId) || []).entries()) {
      steps.push({
        kind: 'flashcard',
        id: `card-${topicId}-${index}`,
        topicId,
        topicLabel: card.topicLabel || topicId,
        front: card.front,
        back: card.back,
      });
    }
  }

  // Then the questions, in the order the backend produced them, which is the order the
  // topics were selected in.
  const placedIds = new Set();
  for (const question of quiz.questions || []) {
    const step = questionToStep(question);
    if (placedIds.has(step.id)) continue;
    placedIds.add(step.id);
    steps.push(step);
  }

  return steps.map((step, index) => ({ ...step, index, isLast: index === steps.length - 1 }));
}

function questionToStep(question) {
  const base = {
    id: question.id,
    kind: question.type,
    topicId: question.topicId,
    topicLabel: question.topicLabel || question.topicId,
    prompt: question.prompt,
    explanation: question.explanation,
    sourceTurns: question.sourceTurns || [],
    /** True when this kind is graded by the model rather than locally. */
    needsApi: question.type === 'open',
  };

  if (question.type === 'mcq') {
    return {
      ...base,
      choices: (question.options || []).map((option, i) => ({
        id: option.key || LETTERS[i],
        label: option.text,
        letter: option.key || LETTERS[i],
      })),
      correctId: question.correctOptionKey,
    };
  }

  if (question.type === 'cloze') {
    return {
      ...base,
      language: question.language || '',
      code: question.codeWithGaps,
      blanks: (question.blanks || []).map((blank) => ({
        key: blank.key,
        /** Present only after grading, or when the answer is revealed. */
        answer: blank.answer,
        alternatives: blank.alternatives || [],
      })),
    };
  }

  return {
    ...base,
    rubric: (question.rubric || []).map((criterion) => ({
      criterion: criterion.criterion,
      weight: criterion.weight,
      mustMention: criterion.mustMention || [],
    })),
    referenceAnswer: question.referenceAnswer || '',
  };
}

/**
 * Can this step be answered without a model?
 *
 * Read from the step rather than hardcoded so a future type declares itself.
 */
export function isLocalStep(step) {
  return step.kind === 'mcq' || step.kind === 'cloze';
}

/**
 * What the UI should show for a graded step, independent of how it is drawn.
 *
 * `status` is the only thing the visual layer needs to branch on.
 */
export function describeResult(step, result) {
  if (!result) return { status: 'unanswered', headline: 'Not answered' };
  if (result.error) {
    return { status: 'error', headline: 'Could not be graded', detail: result.error };
  }
  if (step.kind === 'open') {
    return {
      status: result.awarded >= 0.85 ? 'correct' : result.awarded > 0 ? 'partial' : 'wrong',
      headline: result.verdict === 'correct' ? 'Correct' : result.verdict === 'partial' ? 'Partly right' : 'Not quite',
      detail: result.feedback,
      criteria: (result.perCriterion || []).map((c) => ({
        criterion: c.criterion,
        awarded: c.awarded,
        weight: c.weight,
        comment: c.comment,
      })),
      missing: result.missing || [],
    };
  }
  if (step.kind === 'cloze') {
    const blanks = result.perBlank || [];
    return {
      status: result.correct ? 'correct' : result.awarded > 0 ? 'partial' : 'wrong',
      headline: result.correct ? 'Correct' : result.awarded > 0 ? 'Partly right' : 'Not quite',
      detail: step.explanation,
      blanks: blanks.map((b) => ({ key: b.key, correct: b.correct, expected: b.expected, given: b.given })),
    };
  }
  return {
    status: result.correct ? 'correct' : 'wrong',
    headline: result.correct ? 'Correct' : 'Not quite',
    detail: step.explanation,
    expected: result.expected,
    given: result.given,
  };
}

/** How many steps of each phase, for labelling without walking the list twice. */
export function phaseCounts(steps) {
  return {
    flashcards: steps.filter((s) => s.kind === 'flashcard').length,
    questions: steps.filter((s) => s.kind !== 'flashcard').length,
  };
}

/**
 * The results card's contents.
 *
 * The band and its copy come from the backend so the thresholds live in one place and
 * every screen that reports a score agrees. `band` is null when there is nothing to score.
 */
export function summarize(attempt, { band = null } = {}) {
  if (!attempt) {
    return { score: 0, total: 0, percentage: 0, band: null, line: 'Nothing to score yet.' };
  }
  const total = attempt.maxScore || 0;
  const percentage = attempt.percentage || 0;
  return {
    score: attempt.score ?? 0,
    total,
    percentage,
    band,
    mapped: attempt.perQuestion || [],
    line: total === 0 ? 'Nothing to score yet.' : band?.line || '',
  };
}
