// WIRING — the only file that reads state, calls the API and tells the visual layer what
// to draw.
//
// Layer rules, so a future redesign stays cheap:
//
//   lib/api.js        talks to the backend. Nothing else does.
//   lib/state.js      holds state. Nothing else writes it.
//   lib/quiz-view.js  turns backend shapes into view models. Nothing else reshapes them.
//   components/*      draw view models and report intent through callbacks.
//   app.js            this file: orchestrates the four, and owns no markup.
//
// If you are restyling: work in components/ and styles.css, and expect no changes here.
// If you are adding a backend feature: add it to lib/api.js, then decide which component
// shows it.

import { createApi } from './lib/api.js';
import { createStore } from './lib/state.js';
import { toSteps, describeResult, summarize } from './lib/quiz-view.js';
import { renderSidebar, summaryText } from './components/sidebar.js';
import {
  renderTranscript, renderSettings, renderPayload, renderStaleness,
  sessionSubtitle, payloadSubtitle,
} from './components/panel.js';
import { renderStep, renderResults, progressLabel } from './components/quiz.js';

const api = createApi();
const store = createStore();

const el = {
  summary: document.getElementById('summary'),
  list: document.getElementById('list'),
  search: document.getElementById('search'),
  progress: document.getElementById('progress'),
  refresh: document.getElementById('refresh'),
  fixtures: document.getElementById('fixtures'),
  main: document.getElementById('main'),
  empty: document.getElementById('empty'),
  session: document.getElementById('session'),
  sessionTitle: document.getElementById('session-title'),
  sessionSub: document.getElementById('session-sub'),
  messages: document.getElementById('messages'),
  settings: document.getElementById('settings'),
  staleness: document.getElementById('staleness'),
  generate: document.getElementById('generate'),
  showPayload: document.getElementById('show-payload'),
  quiz: document.getElementById('quiz'),
  quizKicker: document.getElementById('quiz-progress'),
  quizTitle: document.getElementById('quiz-title'),
  quizDescription: document.getElementById('quiz-description'),
  quizBody: document.getElementById('quiz-body'),
  restart: document.getElementById('restart-quiz'),
  payloadView: document.getElementById('payload-view'),
  payloadSub: document.getElementById('payload-sub'),
  payloadJson: document.getElementById('payload-json'),
  closePayload: document.getElementById('close-payload'),
};

/** Steps and the cursor into them live here, not in the store: purely presentational. */
let steps = [];
let stepIndex = 0;
let responses = {};

// ── Render ─────────────────────────────────────────────────────────────────

function render() {
  const s = store.state;

  el.summary.textContent = summaryText({ catalog: s.catalog, capabilities: s.capabilities });
  renderSidebar(el.list, {
    sessions: s.sessions,
    selectedId: s.selectedId,
    filter: s.filter,
    onSelect: selectSession,
  });

  el.empty.hidden = Boolean(s.session) || s.stage === 'quiz';
  el.session.hidden = !s.session || s.stage === 'quiz';
  el.quiz.hidden = s.stage !== 'quiz';
  el.payloadView.hidden = true;

  if (s.session) {
    el.sessionTitle.textContent = s.session.title;
    el.sessionSub.textContent = sessionSubtitle(s.session, { readiness: s.readiness });
    renderTranscript(el.messages, { session: s.session, onTurnClick: () => {} });
    renderSettings(el.settings, {
      capabilities: s.capabilities,
      options: s.options,
      plan: s.plan,
      readiness: s.readiness,
      busy: s.busy,
      onChange: updateOptions,
    });
    renderStaleness(el.staleness, {
      staleness: s.staleness,
      onExtend: () => generate({ extend: true }),
      onRegenerate: () => generate(),
    });
    el.generate.disabled = s.busy || s.readiness?.ready === false || (s.options.types.length === 0 && false);
    el.generate.textContent = s.busy ? 'Generating…' : 'Generate quiz';
  }

  if (s.busy && s.progress) el.progress.textContent = s.progress;
  else if (!s.busy && s.progress && s.stage !== 'quiz') el.progress.textContent = s.progress;
}

// ── Actions ────────────────────────────────────────────────────────────────

async function rescan(options) {
  store.set({ busy: true, progress: 'Scanning…' });
  try {
    const catalog = await api.refresh(options);
    const sessions = (catalog.groups || []).flatMap((group) =>
      group.sessions.map((session) => ({ ...session, harnessName: group.name })),
    );
    store.set({
      catalog,
      sessions,
      busy: false,
      progress: `${sessions.length} conversations`,
      capabilities: await api.capabilities(),
      storeInfo: await api.storeInfo(),
    });
  } catch (err) {
    store.set({ busy: false, notice: { level: 'error', text: String(err?.message || err) } });
  }
}

async function selectSession(id) {
  try {
    const session = await api.session(id);
    if (!session) return;
    store.set({ selectedId: id, session, stage: 'idle', readiness: null, plan: null, staleness: null });
    render();

    // Readiness and the plan are cheap and offline, so the UI can tell the user what is
    // possible before they spend anything.
    const [readiness, plan, staleness] = await Promise.all([
      api.readiness({ id, types: store.state.options.types }),
      api.planQuiz({ id, ...store.state.options }),
      api.staleness({ id, ...store.state.options }),
    ]);
    store.set({ readiness, plan, staleness });
    render();
  } catch (err) {
    store.set({ notice: { level: 'error', text: String(err?.message || err) } });
  }
}

async function updateOptions(options) {
  store.set({ options });
  if (!store.state.selectedId) return;
  const [readiness, plan, staleness] = await Promise.all([
    api.readiness({ id: store.state.selectedId, types: options.types }),
    api.planQuiz({ id: store.state.selectedId, ...options }),
    api.staleness({ id: store.state.selectedId, ...options }),
  ]);
  store.set({ readiness, plan, staleness });
  render();
}

async function generate({ extend = false } = {}) {
  const s = store.state;
  if (!s.selectedId) return;
  store.set({ busy: true, progress: extend ? 'Adding questions for the new turns…' : 'Reading transcript and generating questions…' });
  render();

  try {
    const quiz = extend
      ? (await api.extendQuiz({ id: s.selectedId, ...s.options }))
      : (await api.generateAndSave({ id: s.selectedId, ...s.options }));

    if (!quiz || quiz.ok === false) {
      store.set({ busy: false, progress: '', notice: { level: 'warn', text: quiz?.message || 'Could not generate a quiz.' } });
      return render();
    }

    steps = toSteps(quiz.quiz || quiz);
    stepIndex = 0;
    responses = {};
    store.set({ busy: false, progress: '', quiz: quiz.quiz || quiz, stage: 'quiz', attempt: null });
    render();
    renderCurrentStep();
  } catch (err) {
    store.set({ busy: false, progress: '', notice: { level: 'error', text: String(err?.message || err) } });
    render();
  }
}

function renderCurrentStep() {
  const s = store.state;
  if (s.stage !== 'quiz') return;
  const step = steps[stepIndex];

  if (!step) {
    const summary = summarize(s.attempt, steps);
    el.quizKicker.textContent = 'QUIZ COMPLETE';
    el.quizTitle.textContent = s.quiz?.title || 'Your quiz';
    el.quizDescription.textContent = '';
    renderResults(el.quizBody, {
      summary,
      attempt: s.attempt,
      onBack: () => { store.set({ stage: 'idle' }); render(); },
      onRetry: () => { stepIndex = 0; responses = {}; store.set({ attempt: null }); renderCurrentStep(); },
    });
    return;
  }

  el.quizKicker.textContent = step.kind === 'flashcard'
    ? `FLASHCARD ${stepIndex + 1} OF ${steps.length}`
    : progressLabel({ index: questionNumber(), total: questionTotal() });
  el.quizTitle.textContent = s.quiz?.title || 'Your quiz';
  el.quizDescription.textContent = step.topicLabel || '';

  renderStep(el.quizBody, {
    step,
    result: responses[step.id]?.result || null,
    isLast: stepIndex === steps.length - 1,
    onNext: () => { stepIndex += 1; renderCurrentStep(); },
    onRespond: (answer) => respond(step, answer),
  });
}

const questionTotal = () => steps.filter((s) => s.kind !== 'flashcard').length;
const questionNumber = () => steps.slice(0, stepIndex + 1).filter((s) => s.kind !== 'flashcard').length - 1;

async function respond(step, answer) {
  responses[step.id] = { answer };
  const s = store.state;

  // Objective questions are graded by the backend with no request; open ones cost one
  // call. Either way the grading lives in one place, not in the UI.
  try {
    const result = await api.grade({ quizId: s.quiz?.stored?.id || null, answers: allAnswers(), quiz: s.quiz });
    const forThisStep = result?.perQuestion?.find((r) => r.questionId === step.id);
    responses[step.id] = { answer, result: forThisStep ? describeResult(step, forThisStep) : null, raw: forThisStep };
    if (stepIndex === steps.length - 1) store.set({ attempt: result });
    else store.set({});
  } catch (err) {
    responses[step.id] = { answer, result: { status: 'error', headline: 'Could not be graded', detail: String(err?.message || err) } };
  }
  renderCurrentStep();
}

function allAnswers() {
  const out = {};
  for (const [id, entry] of Object.entries(responses)) {
    if (entry?.answer !== undefined) out[id] = entry.answer;
  }
  return out;
}

async function showPayload() {
  const s = store.state;
  if (!s.selectedId) return;
  const payload = await api.payload({ id: s.selectedId, maxChars: 24000 });
  el.session.hidden = true;
  el.quiz.hidden = true;
  el.payloadView.hidden = false;
  el.payloadSub.textContent = payloadSubtitle(payload);
  renderPayload(el.payloadJson, { payload });
}

function showPane() {
  el.session.hidden = store.state.stage === 'quiz';
  el.payloadView.hidden = true;
}

// ── Events ─────────────────────────────────────────────────────────────────

el.refresh.addEventListener('click', () => rescan());
el.fixtures.addEventListener('click', () => rescan({ fixtures: true }));
el.generate.addEventListener('click', () => generate());
el.showPayload.addEventListener('click', showPayload);
el.closePayload.addEventListener('click', () => { store.set({ stage: 'idle' }); render(); });
el.restart.addEventListener('click', () => { store.set({ stage: 'idle' }); render(); });
el.search.addEventListener('input', (e) => { store.set({ filter: e.target.value }); render(); });

store.subscribe(render);

// ── Boot ───────────────────────────────────────────────────────────────────

if (!api.available()) {
  el.summary.textContent = 'Backend bridge missing.';
  el.list.replaceChildren(Object.assign(document.createElement('div'), {
    className: 'placeholder',
    textContent: 'window.compat is missing. Run this through Electron, not a browser.',
  }));
} else {
  api.onProgress((evt) => {
    if (evt.phase === 'harness-done' && evt.sessions > 0) store.set({ progress: `${evt.name}: ${evt.sessions}` });
  });
  api.onQuizProgress((evt) => {
    if (evt.phase === 'topic-start') store.set({ progress: `Generating ${evt.label || evt.topicId}…` });
    if (evt.phase === 'topic-done') store.set({ progress: `${evt.topicId}: ${evt.flashcards} cards, ${evt.questions} questions` });
    if (evt.phase === 'topic-failed') store.set({ progress: `${evt.topicId} failed: ${evt.error}` });
  });
  api.onReady(() => api.list().then((catalog) => {
    if (catalog?.scanned && !store.state.catalog) {
      const sessions = (catalog.groups || []).flatMap((g) => g.sessions.map((s) => ({ ...s, harnessName: g.name })));
      store.set({ catalog, sessions });
    }
  }));
  rescan();
  api.capabilities().then((capabilities) => store.set({ capabilities })).catch(() => {});
}
