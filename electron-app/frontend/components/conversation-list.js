// Sidebar: the list of detected conversations, grouped by agent.
//
// Stateless on purpose — it renders whatever it is handed and reports clicks
// through onSelect. The entry script owns the state.

import { h, placeholder, mount } from '../lib/dom.js';
import { clamp, timeAgo } from '../lib/format.js';

/**
 * @param {HTMLElement} container
 * @param {object} opts
 * @param {object|null} opts.catalog   result of compat.list()
 * @param {string} [opts.filter]       lowercase search string
 * @param {string|null} [opts.selectedId]
 * @param {(id: string) => void} opts.onSelect
 */
export function renderConversationList(container, { catalog, filter = '', selectedId = null, onSelect }) {
  if (!catalog) {
    mount(container, placeholder('Scanning…'));
    return;
  }

  const q = filter.trim().toLowerCase();

  // Filter within groups, then drop groups that end up empty.
  const groups = catalog.groups
    .map((group) => ({
      ...group,
      sessions: q
        ? group.sessions.filter((s) =>
            `${s.title} ${s.project} ${group.name}`.toLowerCase().includes(q),
          )
        : group.sessions,
    }))
    .filter((group) => group.sessions.length > 0);

  if (groups.length === 0) {
    mount(
      container,
      placeholder(q ? 'No conversations match that filter.' : 'No conversations found on this machine.'),
    );
    return;
  }

  mount(
    container,
    groups.map((group) =>
      h(
        'div',
        { class: 'group' },
        h(
          'div',
          { class: 'group__head' },
          h('span', { text: group.name }),
          h('span', { class: 'group__count', text: String(group.sessions.length) }),
        ),
        group.sessions.map((s) => row(s, selectedId, onSelect)),
      ),
    ),
  );
}

/** One "rectangle" in the list. */
function row(session, selectedId, onSelect) {
  const meta = h(
    'span',
    { class: 'row__meta' },
    h('span', { text: clamp(session.project, 28) }),
    // Dim the ones too short to make a decent quiz, but keep them selectable.
    !session.quizReady &&
      h('span', { class: 'row__dot', text: '·' }),
    !session.quizReady && h('span', { text: 'short' }),
  );

  return h(
    'button',
    {
      class: 'row',
      type: 'button',
      'aria-current': String(selectedId === session.id),
      title: `${session.title}\n${session.project}\n${session.messageCount} messages · ${timeAgo(session.updated)}`,
      onclick: () => onSelect(session.id),
    },
    h('span', { class: 'row__title', text: clamp(session.title) }),
    meta,
  );
}

/** The one-line summary under the sidebar heading. */
export function summaryText(catalog) {
  if (!catalog) return 'Scanning your disk…';
  const sqlite = catalog.sqlite?.available ? '' : ' · SQLite decoding unavailable';
  return (
    `${catalog.detectedHarnesses} of ${catalog.totalHarnesses} tools detected · ` +
    `${catalog.totalSessions} conversations · ${catalog.quizReady} ready to quiz${sqlite}`
  );
}
