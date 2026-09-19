// Renderer. Plain script, no bundler, no framework.
//
// Its only job right now: prove the pipeline end to end.
//   list detected conversations -> click one -> show its transcript
//
// The transcript pane is the placeholder for the quiz UI. Everything above it
// (the catalog, the selection, the payload the quiz will be generated from) is
// already wired to the real backend.

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
};

/** @type {object|null} */
let catalog = null;
/** @type {object|null} */
let selected = null;
let filter = '';

// Titles come from the backend, which derives them from the first user message.
// The sidebar clamps them to a couple of words so rows stay uniform.
const clamp = (text, max = 20) => {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
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

// ── Sidebar ────────────────────────────────────────────────────────────────

function renderSummary() {
  if (!catalog) {
    el.summary.textContent = 'Scanning your disk…';
    return;
  }
  const sqlite = catalog.sqlite?.available ? '' : ' · SQLite decoding unavailable';
  el.summary.textContent =
    `${catalog.detectedHarnesses} of ${catalog.totalHarnesses} tools detected · ` +
    `${catalog.totalSessions} conversations · ${catalog.quizReady} ready to quiz${sqlite}`;
}

function renderList() {
  const q = filter.trim().toLowerCase();
  el.list.replaceChildren();

  if (!catalog) {
    el.list.append(placeholder('Scanning…'));
    return;
  }

  const groups = catalog.groups
    .map((g) => ({
      ...g,
      sessions: q
        ? g.sessions.filter((s) =>
            `${s.title} ${s.project} ${g.name}`.toLowerCase().includes(q),
          )
        : g.sessions,
    }))
    .filter((g) => g.sessions.length > 0);

  if (groups.length === 0) {
    el.list.append(
      placeholder(q ? 'No conversations match that filter.' : 'No conversations found on this machine.'),
    );
    return;
  }

  for (const group of groups) {
    const section = document.createElement('div');
    section.className = 'group';

    const head = document.createElement('div');
    head.className = 'group__head';
    head.innerHTML = '<span></span><span class="group__count"></span>';
    head.firstChild.textContent = group.name;
    head.lastChild.textContent = `${group.sessions.length}`;
    section.append(head);

    for (const s of group.sessions) {
      section.append(row(s));
    }
    el.list.append(section);
  }
}

/** One "rectangle" in the sidebar list. */
function row(s) {
  const button = document.createElement('button');
  button.className = 'row';
  button.type = 'button';
  button.setAttribute('aria-current', String(selected?.id === s.id));
  button.title = `${s.title}\n${s.project}\n${s.messageCount} messages · ${timeAgo(s.updated)}`;

  const title = document.createElement('span');
  title.className = 'row__title';
  title.textContent = clamp(s.title);
  button.append(title);

  const meta = document.createElement('span');
  meta.className = 'row__meta';

  const project = document.createElement('span');
  project.textContent = clamp(s.project, 28);
  meta.append(project);

  // Dim the ones too short to make a decent quiz, but keep them selectable.
  if (!s.quizReady) {
    const dot = document.createElement('span');
    dot.className = 'row__dot';
    dot.textContent = '·';
    const short = document.createElement('span');
    short.textContent = 'short';
    meta.append(dot, short);
  }
  button.append(meta);

  button.addEventListener('click', () => select(s.id));
  return button;
}

function placeholder(text) {
  const div = document.createElement('div');
  div.className = 'placeholder';
  div.textContent = text;
  return div;
}

// ── Main panel ─────────────────────────────────────────────────────────────

async function select(id) {
  const session = await api.session(id);
  if (!session) return;

  selected = { id, ...session };
  el.empty.hidden = true;
  el.payloadView.hidden = true;
  el.session.hidden = false;
  renderList(); // to move the selection highlight

  el.sessionTitle.textContent = session.title;
  el.sessionSub.textContent =
    `${session.harnessName} · ${session.project}` +
    (session.cwd ? ` · ${session.cwd}` : '') +
    ` · ${session.messages.length} messages · ${session.userTurns} user turns` +
    ` · ${timeAgo(session.updated)}`;

  el.messages.replaceChildren();
  for (const m of session.messages) {
    el.messages.append(message(m));
  }
  document.querySelector('.main').scrollTop = 0;
}

function message(m) {
  const wrap = document.createElement('div');
  wrap.className = `msg msg--${m.role}`;

  const head = document.createElement('div');
  head.className = 'msg__head';

  const role = document.createElement('span');
  role.className = 'msg__role';
  role.textContent = m.role;
  head.append(role);

  if (m.tools?.length) {
    const tools = document.createElement('span');
    tools.className = 'msg__tools';
    tools.textContent = m.tools.map((t) => t.name).join(' · ');
    head.append(tools);
  }
  wrap.append(head);

  // textContent, not innerHTML: this is untrusted text from other tools' stores.
  const body = document.createElement('div');
  body.className = 'msg__body';
  body.textContent = m.text;
  wrap.append(body);

  return wrap;
}

// ── Actions ────────────────────────────────────────────────────────────────

async function rescan(options) {
  el.progress.textContent = 'Scanning…';
  el.refresh.disabled = true;
  el.fixtures.disabled = true;
  try {
    catalog = await api.refresh(options);
    renderSummary();
    renderList();
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
  const payload = await api.payload({ id: selected.id, maxChars: 24000 });
  if (!payload) return;

  el.session.hidden = true;
  el.payloadView.hidden = false;
  el.payloadSub.textContent =
    `${payload.messages.length} of ${payload.messageCount} messages · ` +
    `${JSON.stringify(payload).length} chars` +
    (payload.truncated ? ' · truncated to fit the model window' : '');
  el.payloadJson.textContent = JSON.stringify(payload, null, 2);
}

el.refresh.addEventListener('click', () => rescan());
el.fixtures.addEventListener('click', () => rescan({ fixtures: true }));
el.showPayload.addEventListener('click', showPayload);
el.closePayload.addEventListener('click', () => {
  el.payloadView.hidden = true;
  el.session.hidden = false;
});
el.search.addEventListener('input', (e) => {
  filter = e.target.value;
  renderList();
});
el.generate.addEventListener('click', () => {
  console.log('[quiz] not implemented yet. Payload for', selected?.id, 'is ready via compat.payload()');
});

// ── Boot ───────────────────────────────────────────────────────────────────

if (!api) {
  el.summary.textContent = 'Backend bridge missing (window.compat).';
  el.list.replaceChildren(
    placeholder('Preload script did not load. Run this through Electron, not a browser.'),
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
        renderSummary();
        renderList();
      }
    });
  });
  rescan();
}
