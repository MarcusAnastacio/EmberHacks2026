// VISUAL LAYER — the sidebar.
//
// This file is expected to change. It reads a view model and writes DOM; it does not
// fetch, does not hold state, and does not know what a "session" is beyond the fields it
// reads off the summary it is handed.
//
// If you redesign this, keep `renderSidebar(container, props)` and the `onSelect(id)`
// callback and nothing else in the app has to move.

const h = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    // Always textContent: titles and project names come from other tools' stores.
    else if (key === 'text') node.textContent = value;
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

const clamp = (text, max = 24) => {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
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

/** The line under the "Conversations" heading. */
export function summaryText({ catalog, capabilities }) {
  if (!catalog) return 'Scanning your disk…';
  const bits = [
    `${catalog.detectedHarnesses} of ${catalog.totalHarnesses} tools`,
    `${catalog.totalSessions} conversations`,
  ];
  if (catalog.platform?.name) bits.push(catalog.platform.name);
  if (capabilities?.requiresApiKey) bits.push('no API key');
  if (catalog.sqlite && catalog.sqlite.available === false) bits.push('no SQLite decoding');
  return bits.join(' · ');
}

/**
 * @param {HTMLElement} container
 * @param {object} props { sessions, selectedId, filter, onSelect }
 */
export function renderSidebar(container, { sessions = [], selectedId = null, filter = '', onSelect = () => {} } = {}) {
  const query = filter.trim().toLowerCase();
  const shown = query
    ? sessions.filter((s) => `${s.title} ${s.project} ${s.harnessName}`.toLowerCase().includes(query))
    : sessions;

  container.replaceChildren();

  if (shown.length === 0) {
    container.append(
      h('div', {
        class: 'placeholder',
        text: query ? 'Nothing matches that filter.' : 'No conversations found on this machine.',
      }),
    );
    return;
  }

  // Group by agent so the list reads as "what did I use", not one long stream.
  const groups = new Map();
  for (const session of shown) {
    const key = session.harnessName || session.harness;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(session);
  }

  for (const [name, items] of groups) {
    const section = h('div', { class: 'group' });
    section.append(
      h(
        'div',
        { class: 'group__head' },
        h('span', { text: name }),
        h('span', { class: 'group__count', text: String(items.length) }),
      ),
    );
    for (const session of items) {
      section.append(
        h(
          'button',
          {
            class: 'row',
            type: 'button',
            'aria-current': String(selectedId === session.id),
            title: `${session.title}\n${session.project}\n${session.messageCount} messages`,
            onclick: () => onSelect(session.id),
          },
          h('span', { class: 'row__title', text: clamp(session.title, 30) }),
          h(
            'span',
            { class: 'row__meta' },
            h('span', { text: clamp(session.project, 26) }),
            !session.quizReady && h('span', { class: 'row__dot', text: '·' }),
            !session.quizReady && h('span', { text: 'short' }),
            h('span', { class: 'row__dot', text: '·' }),
            h('span', { text: timeAgo(session.updated) }),
          ),
        ),
      );
    }
    container.append(section);
  }
}
