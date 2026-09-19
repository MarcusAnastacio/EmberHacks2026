const api = window.compat;

const el = {
  main: document.getElementById('main'),
  summary: document.getElementById('summary'), list: document.getElementById('list'),
  search: document.getElementById('search'), progress: document.getElementById('progress'),
  refresh: document.getElementById('refresh'), fixtures: document.getElementById('fixtures'),
  empty: document.getElementById('empty'), session: document.getElementById('session'),
  sessionTitle: document.getElementById('session-title'), sessionSub: document.getElementById('session-sub'),
  messages: document.getElementById('messages'), generate: document.getElementById('generate'),
  prompt: document.getElementById('quiz-prompt'), promptCount: document.getElementById('prompt-count'),
  showPayload: document.getElementById('show-payload'), payloadView: document.getElementById('payload-view'),
  payloadSub: document.getElementById('payload-sub'), payloadJson: document.getElementById('payload-json'),
  closePayload: document.getElementById('close-payload'), quiz: document.getElementById('quiz'),
  quizTitle: document.getElementById('quiz-title'), quizDescription: document.getElementById('quiz-description'),
  quizProgress: document.getElementById('quiz-progress'), quizBody: document.getElementById('quiz-body'),
  restartQuiz: document.getElementById('restart-quiz'),
};

let catalog = null;
let selected = null;
let filter = '';
let activeQuiz = null;
let quizIndex = 0;
let score = 0;

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

function renderSummary() {
  if (!catalog) return;
  const sqlite = catalog.sqlite?.available ? '' : ' · SQLite unavailable';
  el.summary.textContent = `${catalog.detectedHarnesses} of ${catalog.totalHarnesses} tools · ${catalog.totalSessions} conversations · ${catalog.quizReady} ready${sqlite}`;
}

function renderList() {
  el.list.replaceChildren();
  if (!catalog) return el.list.append(placeholder('Scanning…'));
  const q = filter.trim().toLowerCase();
  const groups = catalog.groups.map((g) => ({ ...g, sessions: q ? g.sessions.filter((s) => `${s.title} ${s.project} ${g.name}`.toLowerCase().includes(q)) : g.sessions })).filter((g) => g.sessions.length);
  if (!groups.length) return el.list.append(placeholder(q ? 'No conversations match that filter.' : 'No conversations found on this machine.'));
  for (const group of groups) {
    const section = document.createElement('div');
    section.className = 'group';
    const head = document.createElement('div');
    head.className = 'group__head';
    const name = document.createElement('span');
    name.textContent = group.name;
    const count = document.createElement('span');
    count.className = 'group__count';
    count.textContent = group.sessions.length;
    head.append(name, count);
    section.append(head, ...group.sessions.map(row));
    el.list.append(section);
  }
}

function row(session) {
  const button = document.createElement('button');
  button.className = 'row';
  button.type = 'button';
  button.setAttribute('aria-current', String(selected?.id === session.id));
  const title = document.createElement('span');
  title.className = 'row__title';
  title.textContent = clamp(session.title);
  const meta = document.createElement('span');
  meta.className = 'row__meta';
  meta.textContent = `${clamp(session.project, 22)} · ${timeAgo(session.updated)}`;
  button.append(title, meta);
  button.addEventListener('click', () => select(session.id));
  return button;
}

function placeholder(text) {
  const div = document.createElement('div');
  div.className = 'placeholder';
  div.textContent = text;
  return div;
}

async function select(id) {
  const session = await api.session(id);
  if (!session) return;
  selected = { id, ...session };
  activeQuiz = null;
  el.empty.hidden = true;
  el.quiz.hidden = true;
  el.payloadView.hidden = true;
  el.session.hidden = false;
  renderList();
  el.sessionTitle.textContent = session.title;
  el.sessionSub.textContent = `${session.harnessName} · ${session.project} · ${session.messages.length} messages · ${session.userTurns} user turns · ${timeAgo(session.updated)}`;
  el.messages.replaceChildren(...session.messages.map(message));
  el.prompt.value = '';
  updatePromptCount();
  el.main?.scrollTo(0, 0);
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
  const body = document.createElement('div');
  body.className = 'msg__body';
  body.textContent = m.text;
  wrap.append(head, body);
  return wrap;
}

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
  try {
    const payload = await api.payload({ id: selected.id, maxChars: 24000 });
    if (!payload) return;
    el.session.hidden = true;
    el.payloadView.hidden = false;
    el.payloadSub.textContent = `${payload.messages.length} of ${payload.messageCount} messages · ${JSON.stringify(payload).length} chars${payload.truncated ? ' · truncated' : ''}`;
    el.payloadJson.textContent = JSON.stringify(payload, null, 2);
  } catch (err) {
    el.progress.textContent = err.message;
  }
}

function updatePromptCount() {
  el.promptCount.textContent = `${el.prompt.value.length} / 240`;
}

async function generate() {
  if (!selected) return;
  el.generate.disabled = true;
  el.generate.textContent = 'Generating…';
  el.progress.textContent = 'Reading transcript and generating questions…';
  try {
    activeQuiz = await api.generate({ id: selected.id, prompt: el.prompt.value.trim() });
    quizIndex = 0;
    score = 0;
    el.session.hidden = true;
    el.quiz.hidden = false;
    renderQuestion();
    el.main.scrollTo(0, 0);
  } catch (err) {
    el.progress.textContent = err.message;
  } finally {
    el.generate.disabled = false;
    el.generate.textContent = 'Generate quiz';
  }
}

function renderQuestion() {
  const question = activeQuiz?.questions[quizIndex];
  if (!question) return renderResults();
  el.quizTitle.textContent = activeQuiz.title;
  el.quizDescription.textContent = activeQuiz.description;
  el.quizProgress.textContent = `QUESTION ${quizIndex + 1} OF ${activeQuiz.questions.length}`;
  el.quizBody.replaceChildren();
  const card = document.createElement('section');
  card.className = 'question-card';
  const questionText = document.createElement('h3');
  questionText.textContent = question.question;
  card.append(questionText);
  const options = document.createElement('div');
  options.className = 'options';
  question.options.forEach((text, index) => {
    const option = document.createElement('button');
    option.className = 'option';
    option.type = 'button';
    option.innerHTML = `<span class="option__letter">${String.fromCharCode(65 + index)}</span><span></span>`;
    option.lastChild.textContent = text;
    option.addEventListener('click', () => answer(option, index, question));
    options.append(option);
  });
  card.append(options);
  el.quizBody.append(card);
}

function answer(selectedOption, index, question) {
  const options = [...el.quizBody.querySelectorAll('.option')];
  options.forEach((option, optionIndex) => {
    option.disabled = true;
    if (optionIndex === question.answer) option.classList.add('option--correct');
  });
  if (index === question.answer) {
    score += 1;
    selectedOption.classList.add('option--correct');
  } else selectedOption.classList.add('option--wrong');
  const feedback = document.createElement('div');
  feedback.className = `feedback ${index === question.answer ? 'feedback--correct' : 'feedback--wrong'}`;
  feedback.textContent = index === question.answer ? `Correct. ${question.explanation}` : `Not quite. ${question.explanation}`;
  const next = document.createElement('button');
  next.className = 'btn btn--primary feedback__next';
  next.type = 'button';
  next.textContent = quizIndex === activeQuiz.questions.length - 1 ? 'See results' : 'Next question';
  next.addEventListener('click', () => { quizIndex += 1; renderQuestion(); });
  feedback.append(next);
  el.quizBody.querySelector('.question-card').append(feedback);
}

function renderResults() {
  el.quizProgress.textContent = 'QUIZ COMPLETE';
  el.quizBody.replaceChildren();
  const result = document.createElement('section');
  result.className = 'result-card';
  result.innerHTML = '<div class="result-card__score"></div><h3>Nice work.</h3><p></p>';
  result.querySelector('.result-card__score').textContent = `${score}/${activeQuiz.questions.length}`;
  result.querySelector('p').textContent = score === activeQuiz.questions.length ? 'You have a strong handle on this work.' : 'Review the conversation and try again to close the gaps.';
  const back = document.createElement('button');
  back.className = 'btn btn--primary';
  back.textContent = 'Back to conversation';
  back.addEventListener('click', () => { el.quiz.hidden = true; el.session.hidden = false; });
  result.append(back);
  el.quizBody.append(result);
}

el.refresh.addEventListener('click', () => rescan());
el.fixtures.addEventListener('click', () => rescan({ fixtures: true }));
el.showPayload.addEventListener('click', showPayload);
el.closePayload.addEventListener('click', () => { el.payloadView.hidden = true; el.session.hidden = false; });
el.search.addEventListener('input', (event) => { filter = event.target.value; renderList(); });
el.prompt.addEventListener('input', updatePromptCount);
el.generate.addEventListener('click', generate);
el.restartQuiz.addEventListener('click', () => { el.quiz.hidden = true; el.session.hidden = false; });

if (!api) {
  el.summary.textContent = 'Backend bridge missing.';
  el.list.append(placeholder('Run this through Electron, not a browser.'));
} else {
  api.onProgress((evt) => {
    if (evt.phase === 'harness-done' && evt.sessions > 0) el.progress.textContent = `${evt.name}: ${evt.sessions} conversations`;
  });
  api.onReady(() => api.list().then((value) => {
    if (value?.scanned && !catalog) { catalog = value; renderSummary(); renderList(); }
  }));
  rescan();
}
