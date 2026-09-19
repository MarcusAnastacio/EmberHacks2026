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
  // --- commands -------------------------------------------------------------
  /** Sidebar catalog: detected harnesses grouped with their sessions. */
  list: (options) => ipcRenderer.invoke(CH.LIST, options),
  /** Full rescan. `{ fixtures: true }` uses the bundled sample stores. */
  refresh: (options) => ipcRenderer.invoke(CH.REFRESH, options),
  /** One full session including message bodies. */
  session: (id) => ipcRenderer.invoke(CH.SESSION, id),
  /** Trimmed, bounded payload for Gemini. */
  payload: (options) => ipcRenderer.invoke(CH.PAYLOAD, options),
  /** Flat, body-less candidate list for a search box. */
  search: (query) => ipcRenderer.invoke(CH.SEARCH, query),
  /** Every harness we know about, detected or not. */
  registry: () => ipcRenderer.invoke(CH.REGISTRY),

  // --- events ---------------------------------------------------------------
  onProgress: (cb) => subscribe(CH.PROGRESS, cb),
  onReady: (cb) => subscribe(CH.READY, cb),
});
