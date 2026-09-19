// Frontend entry point.
//
// Wiring only: owns state, listens to the bridge, and hands data to components.
// Anything that renders belongs in components/, anything reusable and pure in lib/.
//
//   renderer.js            <- you are here: state + wiring
//   components/*.js        <- render pieces of the UI from props, no state
//   lib/dom.js             <- h(), mount(), clear(), placeholder()
//   lib/format.js          <- clamp(), timeAgo(), num()

import { h, mount } from './lib/dom.js';
import { renderConversationList, summaryText } from './components/conversation-list.js';
import { renderTranscript, transcriptSubtitle } from './components/transcript.js';

const api = window.compat;

const el = {
  summary: document.getElementById('summary'),
  list: document.getElementById('list'),
  search: document.getElementById('search'),
  progress: document.getElementById('progress'),
  refresh: document.getElementById('refresh'),
  fixtures: document.getElementById('fixtures'),
  empty: document.getElementById('empty'),
  session: document.getElementById('session'),
  sessionTitle: document.getElementById('session-title'),
  sessionSub: document.getElementById('session-sub'),
  messages: document.getElementById('messages'),
  generate: document.getElementById('generate'),
  showPayload: document.getElementById('show-payload'),
  payloadView: document.getElementById('payload-view'),
  payloadSub: document.getElementById('payload-sub'),
  payloadJson: document.getElementById('payload-json'),
  closePayload: document.getElementById('close-payload'),
  pane: document.querySelector('.main'),
};

// ── State ──────────────────────────────────────────────────────────────────

let catalog = null;
let selected = null;
let filter = '';
let lastRedaction = null;

// ── Render ─────────────────────────────────────────────────────────────────

function renderSidebar() {
  el.summary.textContent = summaryText(catalog);
  renderConversationList(el.list, {
    catalog,
    filter,
    selectedId: selected?.id ?? null,
    onSelect: select,
  });
}

function showPane(which) {
  el.empty.hidden = which !== 'empty';
  el.session.hidden = which !== 'session';
  el.payloadView.hidden = which !== 'payload';
}

// ── Actions ────────────────────────────────────────────────────────────────

async function select(id) {
  const session = await api.session(id);
  if (!session) return;

  selected = { id, ...session };
  showPane('session');
  renderSidebar(); // move the selection highlight

  el.sessionTitle.textContent = session.title;
  el.sessionSub.textContent = transcriptSubtitle(session);
  renderTranscript(el.messages, session);
  el.pane.scrollTop = 0;
}

async function rescan(options) {
  el.progress.textContent = 'Scanning…';
  el.refresh.disabled = true;
  el.fixtures.disabled = true;
  try {
    catalog = await api.refresh(options);
    renderSidebar();
    el.progress.textContent = 'Scan complete.';
  } catch (err) {
    el.progress.textContent = `Scan failed: ${err.message}`;
  } finally {
    el.refresh.disabled = false;
    el.fixtures.disabled = false;
  }
}

async function showPayload() {
  if (!selected) return;
  const result = await api.payload({ id: selected.id, maxChars: 24000 });
  if (!result) return;

  // The redaction report travels with the payload so the UI can be honest about
  // what was stripped before anything leaves the machine.
  const { payload, redaction } = result;
  lastRedaction = redaction;

  showPane('payload');
  const size = new Blob([JSON.stringify(payload)]).size;
  el.payloadSub.textContent =
    `${payload.messages.length} of ${payload.messageCount} messages · ` +
    `${size.toLocaleString('en-US')} bytes` +
    (payload.truncated ? ' · truncated to fit the model window' : '') +
    (redaction?.total ? ` · ${redaction.total} secret${redaction.total === 1 ? '' : 's'} redacted` : ' · nothing redacted');

  mount(
    el.payloadJson,
    redaction?.total ? redactionBanner(redaction) : null,
    document.createTextNode(JSON.stringify(payload, null, 2)),
  );

  el.generate.disabled = !payload.messages.length;
}

/** Small, explicit note about what was removed. Trust is the feature. */
function redactionBanner(redaction) {
  const kinds = Object.entries(redaction.byKind)
    .map(([kind, count]) => `${kind} ×${count}`)
    .join(', ');
  return h(
    'div',
    { class: 'redaction' },
    h('strong', { text: `${redaction.total} secret${redaction.total === 1 ? '' : 's'} redacted before sending` }),
    h('span', { text: ` — ${kinds}` }),
    redaction.entropy
      ? h('span', { text: ` · ${redaction.entropy} found by the entropy pass` })
      : null,
  );
}

// ── Events ─────────────────────────────────────────────────────────────────

el.refresh.addEventListener('click', () => rescan());
el.fixtures.addEventListener('click', () => rescan({ fixtures: true }));
el.showPayload.addEventListener('click', showPayload);
el.closePayload.addEventListener('click', () => showPane('session'));
el.search.addEventListener('input', (e) => {
  filter = e.target.value;
  renderSidebar();
});
el.generate.addEventListener('click', () => {
  console.log('[quiz] not implemented yet', { id: selected?.id, redaction: lastRedaction });
});

// ── Boot ───────────────────────────────────────────────────────────────────

if (!api) {
  el.summary.textContent = 'Backend bridge missing (window.compat).';
  mount(
    el.list,
    h('div', { class: 'placeholder', text: 'Preload script did not load. Run this through Electron, not a browser.' }),
  );
} else {
  api.onProgress((evt) => {
    if (evt.phase === 'harness-done' && evt.sessions > 0) {
      el.progress.textContent = `${evt.name}: ${evt.sessions} conversations`;
    }
  });
  api.onReady(() => {
    // main.js starts a scan at launch; pick up its result if it finished first.
    api.list().then((c) => {
      if (c?.scanned && !catalog) {
        catalog = c;
        renderSidebar();
      }
    });
  });
  rescan();
}
