// Preload: the only bridge between the renderer and the main process.
//
// Deliberately self-contained CommonJS — no import of backend/ipc.js — because
// this file runs under `sandbox: true`, where only `require('electron')` is
// available. The channel names below MUST stay in sync with backend/ipc.js.

const { contextBridge, ipcRenderer } = require('electron');

const CH = {
  LIST: 'compat:list',
  REFRESH: 'compat:refresh',
  SESSION: 'compat:session',
  PAYLOAD: 'compat:payload',
  SEARCH: 'compat:search',
  REGISTRY: 'compat:registry',
  PROGRESS: 'compat:progress',
  READY: 'compat:ready',
  // quiz options, readiness, planning
  QUIZ_CAPABILITIES: 'compat:quiz-capabilities',
  READINESS: 'compat:readiness',
  PLAN_QUIZ: 'compat:plan-quiz',
  TOPICS: 'compat:topics',
  TOPIC_SLICE: 'compat:topic-slice',
  // generation
  GENERATE_QUIZ: 'compat:generate-quiz',
  GENERATE_AND_SAVE: 'compat:generate-and-save-quiz',
  QUIZ_PROGRESS: 'compat:quiz-progress',
  // storage and grading
  QUIZ_STALENESS: 'compat:quiz-staleness',
  EXTEND_QUIZ: 'compat:extend-quiz',
  GET_QUIZ: 'compat:get-quiz',
  QUIZ_FOR_SESSION: 'compat:quiz-for-session',
  LIST_QUIZZES: 'compat:list-quizzes',
  GRADE_QUIZ: 'compat:grade-quiz',
  ATTEMPTS: 'compat:attempts',
  CLEAR_QUIZZES: 'compat:clear-quizzes',
  STORE_INFO: 'compat:store-info',
  HAS_API_KEY: 'compat:has-api-key',
};

/** Keep a handle on each subscription so listeners can be removed again. */
const subscriptions = new Map();

function subscribe(channel, callback) {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  subscriptions.set(callback, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
    subscriptions.delete(callback);
  };
}

contextBridge.exposeInMainWorld('compat', {
  // catalog
  list: (o) => ipcRenderer.invoke(CH.LIST, o),
  refresh: (o) => ipcRenderer.invoke(CH.REFRESH, o),
  session: (id) => ipcRenderer.invoke(CH.SESSION, id),
  payload: (o) => ipcRenderer.invoke(CH.PAYLOAD, o),
  search: (q) => ipcRenderer.invoke(CH.SEARCH, q),
  registry: () => ipcRenderer.invoke(CH.REGISTRY),

  // options, readiness, planning
  quizCapabilities: () => ipcRenderer.invoke(CH.QUIZ_CAPABILITIES),
  readiness: (o) => ipcRenderer.invoke(CH.READINESS, o),
  planQuiz: (o) => ipcRenderer.invoke(CH.PLAN_QUIZ, o),
  topics: (o) => ipcRenderer.invoke(CH.TOPICS, o),
  topicSlice: (o) => ipcRenderer.invoke(CH.TOPIC_SLICE, o),

  // generation
  generateQuiz: (o) => ipcRenderer.invoke(CH.GENERATE_QUIZ, o),
  generateAndSave: (o) => ipcRenderer.invoke(CH.GENERATE_AND_SAVE, o),

  // storage and grading
  quizStaleness: (o) => ipcRenderer.invoke(CH.QUIZ_STALENESS, o),
  extendQuiz: (o) => ipcRenderer.invoke(CH.EXTEND_QUIZ, o),
  getQuiz: (o) => ipcRenderer.invoke(CH.GET_QUIZ, o),
  quizForSession: (o) => ipcRenderer.invoke(CH.QUIZ_FOR_SESSION, o),
  listQuizzes: (o) => ipcRenderer.invoke(CH.LIST_QUIZZES, o),
  gradeQuiz: (o) => ipcRenderer.invoke(CH.GRADE_QUIZ, o),
  attempts: (o) => ipcRenderer.invoke(CH.ATTEMPTS, o),
  clearQuizzes: () => ipcRenderer.invoke(CH.CLEAR_QUIZZES),
  storeInfo: () => ipcRenderer.invoke(CH.STORE_INFO),
  hasApiKey: () => ipcRenderer.invoke(CH.HAS_API_KEY),

  // events
  onProgress: (cb) => subscribe(CH.PROGRESS, cb),
  onReady: (cb) => subscribe(CH.READY, cb),
  onQuizProgress: (cb) => subscribe(CH.QUIZ_PROGRESS, cb),
});
