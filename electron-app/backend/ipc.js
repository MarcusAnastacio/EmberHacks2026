// Electron bridge: main process <-> renderer contract.
//
// Main process:
//   import { CompatibilityLayer } from './index.js'
//   import { registerCompatibilityIpc } from './ipc.js'
//
//   const layer = new CompatibilityLayer()
//   registerCompatibilityIpc({ ipcMain, layer, getWindows: () => BrowserWindow.getAllWindows() })
//
// Renderer (via the preload bridge below):
//   const catalog = await compat.list()
//   const payload = await compat.payload(sessionId)   // -> send to Gemini

import { isQuizReady } from './detect.js';

/** Channel names. Import these instead of typing strings. */
export const IPC = {
  /** renderer -> main, no args: sidebar catalog (harnesses + sessions) */
  LIST: 'compat:list',
  /** renderer -> main, { only?, fixtures? }: full rescan */
  REFRESH: 'compat:refresh',
  /** renderer -> main, sessionId: one full session with message bodies */
  SESSION: 'compat:session',
  /** renderer -> main, { id, maxChars? }: trimmed payload for Gemini */
  PAYLOAD: 'compat:payload',
  /** renderer -> main, query: flat, body-less candidate list */
  SEARCH: 'compat:search',
  /** renderer -> main, no args: every harness we know about, detected or not */
  REGISTRY: 'compat:registry',
  /** renderer -> main, { id, project?, budget? }: the bounded digest for one session */
  DIGEST: 'compat:digest',
  /** renderer -> main, { id, maxTopics? }: deterministic topic segmentation */
  TOPICS: 'compat:topics',
  /** renderer -> main, { id, maxChars? }: every topic slice, each capped */
  TOPIC_SLICES: 'compat:topic-slices',
  /** renderer -> main, { id, questionCount, types, seed? }: plan without calling the model */
  PLAN_QUIZ: 'compat:plan-quiz',
  /** renderer -> main, { id, questionCount, types, seed? }: generate a full quiz */
  GENERATE_QUIZ: 'compat:generate-quiz',
  /** renderer -> main: whether a Gemini key is configured (never the key itself) */
  HAS_API_KEY: 'compat:has-api-key',
  /** renderer -> main, { id, types? }: can this conversation be quizzed, and why not */
  READINESS: 'compat:readiness',
  /** renderer -> main: option bounds, type labels and key state for the settings UI */
  QUIZ_CAPABILITIES: 'compat:quiz-capabilities',
  /** main -> renderer: generation progress events */
  QUIZ_PROGRESS: 'compat:quiz-progress',
  /** main -> renderer: scan progress events */
  PROGRESS: 'compat:progress',
  /** main -> renderer: scan finished */
  READY: 'compat:ready',
};

/**
 * Wire the layer into ipcMain and forward progress to the renderer.
 * Returns a disposer that removes every handler it registered.
 */
export function registerCompatibilityIpc({ ipcMain, layer, getWindows = () => [] }) {
  const broadcast = (channel, payload) => {
    for (const win of getWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  };

  const onProgress = (evt) => broadcast(IPC.PROGRESS, evt);
  const onReady = (catalog) =>
    broadcast(IPC.READY, { scannedAt: catalog.scannedAt, sessions: catalog.sessions.length });

  layer.on('progress', onProgress);
  layer.on('ready', onReady);

  const handle = (channel, fn) => ipcMain.handle(channel, (_event, ...args) => fn(...args));

  const registered = [
    [IPC.LIST, (opts) => layer.list(opts)],
    [IPC.REFRESH, async (opts) => {
      await layer.refresh(opts);
      return layer.list();
    }],
    [IPC.SESSION, (id) => layer.getSession(id)],
    [IPC.DIGEST, (opts) => layer.digest(opts?.id, opts)],
    [IPC.TOPICS, (opts) => layer.topics(opts?.id, opts)],
    [IPC.TOPIC_SLICES, (opts) => layer.topicSlices(opts?.id, opts)],
    [IPC.PLAN_QUIZ, (opts) => layer.planQuiz(opts?.id, opts)],
    [IPC.HAS_API_KEY, () => layer.hasApiKey()],
    [IPC.READINESS, (opts) => layer.assessReadiness(opts?.id, opts)],
    [IPC.QUIZ_CAPABILITIES, () => layer.quizCapabilities()],
    // Long-running: progress is streamed on QUIZ_PROGRESS while this resolves.
    [IPC.GENERATE_QUIZ, (opts) =>
      layer.generateQuiz(opts?.id, {
        ...opts,
        onProgress: (evt) => broadcast(IPC.QUIZ_PROGRESS, evt),
      })],
    [IPC.PAYLOAD, (opts) => layer.quizPayload(opts?.id, opts)],
    [IPC.SEARCH, (query) => layer.search(query)],
    [IPC.REGISTRY, () => layer.registry().map((h) => ({
      id: h.id,
      name: h.display_name || h.id,
      formatKind: h.format_kind,
      storePaths: h.store_paths,
      lastVerified: h.last_verified,
    }))],
  ];

  for (const [channel, fn] of registered) handle(channel, fn);

  return () => {
    layer.off('progress', onProgress);
    layer.off('ready', onReady);
    for (const [channel] of registered) ipcMain.removeHandler(channel);
  };
}

/**
 * The preload half. Pass in `ipcRenderer.invoke` and expose the result as
 * `window.compat`.
 *
 *   // preload.js
 *   const { contextBridge, ipcRenderer } = require('electron')
 *   const { createRendererApi } = require('./backend/ipc.js')
 *   contextBridge.exposeInMainWorld('compat', createRendererApi(ipcRenderer.invoke, ipcRenderer.on))
 */
export function createRendererApi(invoke, on = null) {
  return {
    list: (opts) => invoke(IPC.LIST, opts),
    refresh: (opts) => invoke(IPC.REFRESH, opts),
    session: (id) => invoke(IPC.SESSION, id),
    payload: (opts) => invoke(IPC.PAYLOAD, opts),
    search: (query) => invoke(IPC.SEARCH, query),
    registry: () => invoke(IPC.REGISTRY),

    /** Subscribe to scan progress. Returns an unsubscribe function. */
    onProgress: (cb) => {
      if (!on) return () => {};
      const handler = (_e, evt) => cb(evt);
      on(IPC.PROGRESS, handler);
      return () => on.removeListener?.(IPC.PROGRESS, handler);
    },
    /** Subscribe to scan completion. Returns an unsubscribe function. */
    onReady: (cb) => {
      if (!on) return () => {};
      const handler = (_e, evt) => cb(evt);
      on(IPC.READY, handler);
      return () => on.removeListener?.(IPC.READY, handler);
    },
  };
}

/** Convenience for the renderer: is this session long enough to quiz? */
export function isReady(sessionSummary) {
  return sessionSummary?.quizReady ?? isQuizReady(sessionSummary ?? {});
}
