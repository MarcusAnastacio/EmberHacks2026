// Main panel: the transcript of one conversation.
//
// This is the placeholder for the quiz view. When the quiz lands, it gets its own
// component in this folder and the entry script switches between them — that is
// the whole reason the panel is a function of a session rather than inline code.

import { h, mount } from '../lib/dom.js';
import { num, timeAgo } from '../lib/format.js';

/**
 * @param {HTMLElement} container
 * @param {object} session  full session from compat.session(id)
 * @param {(messageIndex: number) => void} [onMessageClick]
 */
export function renderTranscript(container, session, onMessageClick) {
  mount(container, session.messages.map((m, i) => message(m, i, session, onMessageClick)));
}

/** Header line: agent, project, working directory, counts. */
export function transcriptSubtitle(session) {
  return (
    `${session.harnessName} · ${session.project}` +
    (session.cwd ? ` · ${session.cwd}` : '') +
    ` · ${num(session.messages.length)} messages · ${session.userTurns} user turns` +
    ` · ${timeAgo(session.updated)}`
  );
}

function message(m, index, session, onMessageClick) {
  const head = h(
    'div',
    { class: 'msg__head' },
    h('span', { class: 'msg__role', text: m.role }),
    m.tools?.length &&
      h('span', {
        class: 'msg__tools',
        text: m.tools.map((t) => t.name).join(' · '),
      }),
    // The index is what a generated quiz cites in sourceRefs, so showing it here
    // makes it possible to check a question against the turn it came from.
    h('span', { class: 'msg__index', text: `#${index}` }),
  );

  // textContent, never innerHTML: this is untrusted text copied out of another
  // tool's store. h() routes `text` through textContent for the same reason.
  const body = h('div', { class: 'msg__body', text: m.text });

  const wrap = h('div', { class: `msg msg--${m.role}` }, head, body);

  if (onMessageClick) {
    wrap.style.cursor = 'pointer';
    wrap.addEventListener('click', () => onMessageClick(index));
  }
  return wrap;
}
