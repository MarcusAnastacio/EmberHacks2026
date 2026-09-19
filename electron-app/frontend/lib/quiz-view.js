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
 * Build the ordered step list for a quiz.
 *
 * Flashcards come first, because the workflow is to learn the prerequisites before being
 * tested. `quiz.capabilities` in the backend describes the same rule; this is its
 * client-side expression.
 */
export function toSteps(quiz) {
  if (!quiz) return [];
  const steps = [];
  const cardsByTopic = new Map();

  for (const card of quiz.flashcards || []) {
    if (!cardsByTopic.has(card.topicId)) cardsByTopic.set(card.topicId, []);
    cardsByTopic.get(card.topicId).push(card);
  }

  // One flashcard phase per topic, then that topic's questions. Keeps a topic's
  // prerequisites next to the questions they unlock.
  const topicOrder = [...(quiz.topicsUsed || []).map((t) => t.id)];
  for (const topicId of topicOrder) {
    for (const card of (cardsByTopic.get(topicId) || [])) {
      steps.push({
        kind: 'flashcard',
        id: `card-${topicId}-${steps.length}`,
        topicId,
        topicLabel: card.topicLabel || topicId,
        front: card.front,
        back: card.back,
      });
    }
    for (const q of (quiz.questions || []).filter((q) => q.topicId === topicId)) {
      steps.push(questionToStep(q));
    }
  }

  // Anything whose topic is not in topicsUsed (a stored quiz, an older shape) still has
  // to be reachable.
  const placed = new Set(steps.map((s) => s.id));
  for (const q of quiz.questions || []) {
    if (!placed.has(q.id)) steps.push(questionToStep(q));
  }
  for (const card of quiz.flashcards || []) {
    const id = `card-${card.topicId}-${cardsByTopic.get(card.topicId)?.indexOf(card)}`;
    if (!placed.has(id) && !steps.some((s) => s.kind === 'flashcard' && s.front === card.front)) {
      steps.push({
        kind: 'flashcard',
        id,
        topicId: card.topicId,
        topicLabel: card.topicLabel || card.topicId,
        front: card.front,
        back: card.back,
      });
    }
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

/** A one-line summary of an attempt, for a results card. */
export function summarize(attempt, steps) {
  if (!attempt) return { score: 0, total: 0, percentage: 0, line: '' };
  const total = attempt.maxScore || 0;
  const percentage = attempt.percentage || 0;
  return {
    score: attempt.score,
    total,
    percentage,
    mapped: attempt.perQuestion || [],
    line:
      total === 0
        ? 'Nothing to score yet.'
        : percentage >= 90
          ? 'You have a strong handle on this work.'
          : percentage >= 60
            ? 'Mostly there. Review the parts you missed and try again.'
            : 'Worth re-reading the conversation before trying again.',
  };
}
