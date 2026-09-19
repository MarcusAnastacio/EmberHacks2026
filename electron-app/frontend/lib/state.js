// FUNCTIONAL LAYER — application state.
//
// Deliberately tiny: a plain object, a subscribe list, and named setters. No framework,
// no reactivity magic, no DOM. The visual layer reads from it and renders; only app.js
// writes to it.

const initial = {
  /** The newest scan result: { groups, platform, storeInfo, ... } */
  catalog: null,
  /** Session summaries, flattened, for the sidebar. */
  sessions: [],
  /** Sidebar filter text. */
  filter: '',
  /** The selected session id, or null. */
  selectedId: null,
  /** The selected session with its messages. */
  session: null,
  /** { questionCount, types } — the settings the next generation will use. */
  options: { questionCount: 6, types: ['mcq', 'cloze', 'open'] },
  /** Bounds and labels from the backend, so nothing is hardcoded here either. */
  capabilities: null,
  /** What the backend says about the selected conversation. */
  readiness: null,
  /** The plan for the selected conversation: topics, expected counts. */
  plan: null,
  /** The quiz currently on screen, with its stored id when it came from the store. */
  quiz: null,
  /** current | results */
  stage: 'idle',
  /** Per-question results once graded. */
  attempt: null,
  /** The quartile band for the final score, from the backend. */
  band: null,
  /** The score from the last completed run, so a resumed quiz can show it. */
  lastScore: null,
  /** The label and action for the top-right button: { action, label, reason }. */
  button: null,
  /** Any message the UI should surface, with its severity. */
  notice: null,
  /** True while a generation is in flight. */
  busy: false,
  /** Live progress line while generating. */
  progress: '',
};

export function createStore(overrides = {}) {
  let state = { ...initial, ...overrides };
  const listeners = new Set();

  const emit = () => {
    for (const listener of listeners) listener(state);
  };

  return {
    get state() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    /** Merge a patch. `undefined` values are ignored so a partial update cannot null a field. */
    set(patch) {
      const next = { ...state };
      let changed = false;
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        if (next[key] !== value) changed = true;
        next[key] = value;
      }
      if (!changed) return state;
      state = next;
      emit();
      return state;
    },
    /** Acknowledge a notice so it stops rendering. */
    clearNotice() {
      return this.set({ notice: null });
    },
  };
}
