// VISUAL LAYER — the conversation panel: the empty state, the transcript, the payload
// view, and the generation settings.
//
// Expected to change. It renders view models and reports intent through callbacks; it
// never fetches and never decides what to generate.

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

const timeAgo = (ms) => {
  if (!ms) return '';
  const days = Math.floor((Date.now() - ms) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
};

/** The transcript, one block per turn. `onTurnClick` receives the message index. */
export function renderTranscript(container, { session, onTurnClick } = {}) {
  container.replaceChildren();
  if (!session) return;

  for (const [index, message] of session.messages.entries()) {
    const tools = (message.tools || []).map((t) => t.name).filter(Boolean);
    const block = h(
      'div',
      { class: `msg msg--${message.role}` },
      h(
        'div',
        { class: 'msg__head' },
        h('span', { class: 'msg__role', text: message.role }),
        tools.length > 0 && h('span', { class: 'msg__tools', text: tools.join(' · ') }),
        h('span', { class: 'msg__index', text: `#${index}` }),
      ),
      // textContent, never innerHTML: this text came out of another tool's store.
      h('div', { class: 'msg__body', text: message.text }),
    );
    if (onTurnClick) {
      block.style.cursor = 'pointer';
      block.addEventListener('click', () => onTurnClick(index));
    }
    container.append(block);
  }
}

/** The subtitle line for a selected conversation. */
export function sessionSubtitle(session, { readiness } = {}) {
  if (!session) return '';
  const bits = [
    session.harnessName,
    session.project,
    session.cwd,
    `${session.messages.length} messages`,
    `${session.userTurns} user turns`,
    timeAgo(session.updated),
  ].filter(Boolean);
  if (readiness && !readiness.ready && readiness.reasons?.length) {
    bits.push(`too thin to quiz: ${readiness.reasons.join('; ')}`);
  }
  return bits.join(' · ');
}

/**
 * The generation settings, built from `capabilities` so no bound or label is duplicated
 * in the UI. `onChange({ questionCount, types })` fires on every change.
 */
export function renderSettings(container, { capabilities, options, plan, readiness, busy, onChange = () => {} } = {}) {
  container.replaceChildren();
  if (!capabilities) return;

  const types = capabilities.types || [];
  const enabled = new Set(options?.types || []);
  const ceiling =
    (capabilities.topics?.maxQuestionsPerType ?? capabilities.questionCount.max) * Math.max(1, enabled.size || 1);
  const max = Math.min(capabilities.questionCount.max, Math.max(1, ceiling));

  const countInput = h('input', {
    class: 'settings__count',
    type: 'number',
    min: String(capabilities.questionCount.min),
    max: String(max),
    step: String(capabilities.questionCount.step || 1),
    value: String(Math.min(options?.questionCount ?? capabilities.questionCount.default, max)),
    disabled: busy || undefined,
    onchange: (e) => {
      const value = Math.max(
        capabilities.questionCount.min,
        Math.min(max, Number(e.target.value) || capabilities.questionCount.default),
      );
      e.target.value = String(value);
      onChange({ ...options, questionCount: value });
    },
  });

  const toggles = types.map((type) =>
    h(
      'label',
      { class: 'settings__type', title: type.description },
      h('input', {
        type: 'checkbox',
        checked: enabled.has(type.id),
        disabled: busy || undefined,
        onchange: (e) => {
          const next = new Set(enabled);
          if (e.target.checked) next.add(type.id);
          else next.delete(type.id);
          onChange({ ...options, types: [...next] });
        },
      }),
      h('span', { text: type.label }),
      type.needsGrading && h('span', { class: 'settings__flag', text: 'graded by model' }),
    ),
  );

  container.append(
    h('div', { class: 'settings' },
      h('div', { class: 'settings__row' },
        h('label', { class: 'settings__label', text: 'Questions' }),
        countInput,
        h('span', { class: 'settings__hint', text: `${capabilities.flashcards.perTopic} flashcards per topic, always` }),
      ),
      h('div', { class: 'settings__row settings__row--types' }, ...toggles),
      planRow({ plan, readiness }),
    ),
  );
}

function planRow({ plan, readiness }) {
  if (!readiness) return null;
  if (readiness.ready === false) {
    return h('p', { class: 'settings__notice settings__notice--warn', text: readiness.reasons?.join('; ') || 'This conversation is too short to quiz.' });
  }
  if (!plan?.plan) return null;
  const bits = [
    `${plan.selectedTopics.length} topic${plan.selectedTopics.length === 1 ? '' : 's'}`,
    `${plan.expectedFlashcards} flashcards`,
    `${plan.expectedQuestions} questions`,
  ];
  const shortfall = plan.shortfall > 0 ? ` · only ${plan.expectedQuestions} possible for this conversation` : '';
  return h('p', { class: 'settings__notice', text: bits.join(' · ') + shortfall });
}

/** The gap notice when a stored quiz exists but the conversation has moved on. */
export function renderStaleness(container, { staleness, sessionsAvailable = false, onExtend, onRegenerate } = {}) {
  container.replaceChildren();
  if (!staleness || staleness.state === 'new' || staleness.state === 'fresh') return;

  const copy = {
    extended: `This conversation has ${staleness.newMessages} new message${staleness.newMessages === 1 ? '' : 's'} since the last quiz.`,
    diverged: 'The part of this conversation the last quiz was built from has changed.',
    settings_changed: 'Your settings differ from the stored quiz.',
    generator_stale: 'The stored quiz was made by an older version of the generator.',
  }[staleness.state];
  if (!copy) return;

  container.append(
    h('div', { class: 'stale' },
      h('span', { text: copy }),
      staleness.state === 'extended' && onExtend
        ? h('button', { class: 'btn', type: 'button', text: 'Quiz me on the new part', onclick: onExtend })
        : null,
      (staleness.state === 'diverged' || staleness.state === 'generator_stale') && onRegenerate
        ? h('button', { class: 'btn', type: 'button', text: 'Regenerate', onclick: onRegenerate })
        : null,
    ),
  );
}

/** The raw payload view, with its redaction report. */
export function renderPayload(container, { payload } = {}) {
  container.replaceChildren();
  if (!payload) return;

  if (payload.redaction?.total > 0) {
    const kinds = Object.entries(payload.redaction.byKind).map(([k, n]) => `${k} ×${n}`).join(', ');
    container.append(
      h('div', { class: 'redaction' },
        h('strong', { text: `${payload.redaction.total} secret${payload.redaction.total === 1 ? '' : 's'} redacted before sending` }),
        h('span', { text: ` — ${kinds}` }),
      ),
    );
  }

  container.append(document.createTextNode(JSON.stringify(payload, null, 2)));
}

export function payloadSubtitle(payload) {
  if (!payload) return '';
  const size = JSON.stringify(payload).length;
  const bits = [
    `${payload.messages?.length ?? 0} of ${payload.messageCount ?? 0} messages`,
    `${size.toLocaleString('en-US')} chars`,
    payload.truncated ? 'truncated to fit the model window' : null,
    payload.redaction?.total ? `${payload.redaction.total} redacted` : 'nothing redacted',
  ];
  return bits.filter(Boolean).join(' · ');
}
