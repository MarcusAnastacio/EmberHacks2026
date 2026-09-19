// VISUAL LAYER — the quiz: flashcards, the three question types, feedback, and results.
//
// Expected to change; the CSS in styles.css was written by the frontend branch and this
// keeps its class names so that styling still applies.
//
// What it receives is a STEP from lib/quiz-view.js, never a raw question. It branches on
// `kind` and on the `status` a result was mapped to, and nothing else.

const h = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child);
  }
  return node;
};

/** Render one step into `container`, reporting the response through `onRespond`. */
export function renderStep(container, { step, result, onRespond = () => {}, onNext, isLast } = {}) {
  container.replaceChildren();
  if (!step) return;

  if (step.kind === 'flashcard') {
    container.append(flashcard(step, { onNext, isLast }));
    return;
  }

  const card = h('section', { class: 'question-card' });

  if (step.kind === 'mcq') card.append(mcq(step, { result, onRespond, onNext, isLast }));
  else if (step.kind === 'cloze') card.append(cloze(step, { result, onRespond, onNext, isLast }));
  else card.append(open(step, { result, onRespond, onNext, isLast }));

  container.append(card);
}

// ── Flashcards ─────────────────────────────────────────────────────────────

function flashcard(step, { onNext, isLast }) {
  const card = h('section', { class: 'question-card flashcard' });
  card.append(h('h3', { text: step.front }));

  const back = h('div', { class: 'flashcard__back', hidden: true, text: step.back });
  const reveal = h('button', {
    class: 'btn btn--primary',
    type: 'button',
    text: 'Show answer',
    onclick: () => {
      back.hidden = false;
      reveal.remove();
      card.append(
        h('button', {
          class: 'btn btn--primary feedback__next',
          type: 'button',
          text: isLast ? 'See results' : 'Next',
          onclick: onNext,
        }),
      );
    },
  });

  card.append(back, reveal);
  return card;
}

// ── Multiple choice ────────────────────────────────────────────────────────

function mcq(step, { result, onRespond, onNext, isLast }) {
  const wrap = h('div');
  wrap.append(h('h3', { text: step.prompt }));

  const options = h('div', { class: 'options' });
  const answered = Boolean(result);

  for (const choice of step.choices || []) {
    const button = h(
      'button',
      {
        class: 'option',
        type: 'button',
        disabled: answered || undefined,
      },
      h('span', { class: 'option__letter', text: choice.letter }),
      h('span', { text: choice.label }),
    );
    if (answered) {
      if (choice.id === step.correctId) button.classList.add('option--correct');
      else if (choice.id === result?.given) button.classList.add('option--wrong');
    } else {
      button.addEventListener('click', () => onRespond(choice.id));
    }
    options.append(button);
  }
  wrap.append(options);

  if (result) wrap.append(feedback(result, { onNext, isLast }));
  return wrap;
}

// ── Fill in the blanks ─────────────────────────────────────────────────────

function cloze(step, { result, onRespond, onNext, isLast }) {
  const wrap = h('div');
  wrap.append(h('h3', { text: step.prompt }));

  const inputs = new Map();
  const answered = Boolean(result);

  // The code is rendered as text with an input in place of each {{blank_N}}, so the gap
  // sits inside the code rather than beside it.
  const code = h('pre', { class: 'cloze' });
  const source = String(step.code || '');
  const parts = source.split(/(\{\{blank_\d+\}\})/g);
  for (const part of parts) {
    const match = /^\{\{(blank_\d+)\}\}$/.exec(part);
    if (!match) {
      code.append(document.createTextNode(part));
      continue;
    }
    const key = match[1];
    const marked = result?.blanks?.find((b) => b.key === key);
    const field = h('input', {
      class: `cloze__blank ${marked ? (marked.correct ? 'cloze__blank--correct' : 'cloze__blank--wrong') : ''}`,
      type: 'text',
      'data-key': key,
      spellcheck: 'false',
      autocomplete: 'off',
      disabled: answered || undefined,
      value: marked?.given ?? '',
      placeholder: key,
    });
    inputs.set(key, field);
    code.append(field);
  }
  wrap.append(code);

  if (!answered) {
    wrap.append(
      h('button', {
        class: 'btn btn--primary',
        type: 'button',
        text: 'Check answer',
        onclick: () => {
          const response = {};
          for (const [key, field] of inputs) response[key] = field.value;
          onRespond(response);
        },
      }),
    );
  } else {
    if (result?.blanks) {
      const expected = result.blanks.map((b) => `${b.key} = ${b.expected}`).join(', ');
      wrap.append(h('p', { class: 'cloze__expected', text: expected }));
    }
    wrap.append(feedback(result, { onNext, isLast }));
  }
  return wrap;
}

// ── Open-ended ─────────────────────────────────────────────────────────────

function open(step, { result, onRespond, onNext, isLast }) {
  const wrap = h('div');
  wrap.append(h('h3', { text: step.prompt }));

  if (step.rubric?.length) {
    wrap.append(
      h(
        'ul',
        { class: 'rubric' },
        ...step.rubric.map((criterion) => h('li', { text: criterion.criterion })),
      ),
    );
  }

  if (!result) {
    const area = h('textarea', {
      class: 'open__answer',
      rows: 5,
      placeholder: 'Explain in your own words…',
      spellcheck: 'true',
    });
    wrap.append(
      area,
      h('button', {
        class: 'btn btn--primary',
        type: 'button',
        text: 'Submit answer',
        onclick: () => onRespond(area.value),
      }),
    );
    return wrap;
  }

  const feedbackBlock = feedback(result, { onNext, isLast });
  if (result.criteria?.length) {
    feedbackBlock.append(
      h(
        'ul',
        { class: 'criteria' },
        ...result.criteria.map((criterion) =>
          h('li', {
            text: `${criterion.awarded >= 0.85 ? 'met' : criterion.awarded > 0 ? 'partly met' : 'not met'} ${criterion.criterion}${criterion.comment ? `. ${criterion.comment}` : ''}`,
          }),
        ),
      ),
    );
  }
  if (result.missing?.length) {
    feedbackBlock.append(h('p', { class: 'criteria__missing', text: `Not mentioned: ${result.missing.join(', ')}` }));
  }
  wrap.append(feedbackBlock);
  return wrap;
}

// ── Feedback and results ───────────────────────────────────────────────────

function feedback(result, { onNext, isLast }) {
  const block = h(
    'div',
    { class: `feedback feedback--${result.status}` },
    h('strong', { text: result.headline }),
  );
  if (result.detail) block.append(h('p', { text: result.detail }));
  if (onNext) {
    block.append(
      h('button', {
        class: 'btn btn--primary feedback__next',
        type: 'button',
        text: isLast ? 'See results' : 'Next question',
        onclick: onNext,
      }),
    );
  }
  return block;
}

/** The end card. */
export function renderResults(container, { summary, attempt, onBack, onRetry, storeInfo } = {}) {
  container.replaceChildren();
  const card = h(
    'section',
    { class: 'result-card' },
    h('div', { class: 'result-card__score', text: `${summary?.score ?? 0}/${summary?.total ?? 0}` }),
    h('h3', { text: 'Nice work.' }),
    h('p', { text: summary?.line || '' }),
  );

  if (attempt?.tokens) {
    card.append(h('p', { class: 'result-card__meta', text: `${attempt.tokens.toLocaleString('en-US')} tokens used grading` }));
  }

  const row = h('div', { class: 'result-card__actions' });
  if (onRetry) row.append(h('button', { class: 'btn', type: 'button', text: 'Try again', onclick: onRetry }));
  if (onBack) row.append(h('button', { class: 'btn btn--primary', type: 'button', text: 'Back to conversation', onclick: onBack }));
  card.append(row);
  container.append(card);
}

/** The kicker above the title: "QUESTION 2 OF 5". */
export function progressLabel({ index, total }) {
  return `QUESTION ${Math.min(index + 1, total)} OF ${total}`;
}
