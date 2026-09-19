// FUNCTIONAL LAYER — the only place in the frontend that talks to the backend.
//
// Nothing here renders. Nothing in components/ calls the bridge. That seam is the
// point: the visual layer can be redesigned without touching a single message shape,
// and a backend change lands in exactly one file.
//
// Every method is a thin wrapper, and the wrappers exist so that:
//   * the channel names live in preload.js only, not scattered through the UI
//   * shapes are normalised once, here, instead of at each call site
//   * a missing channel degrades to a clear error rather than an undefined crash

/** Thrown when the renderer is opened without the preload bridge (e.g. in a browser). */
export class BridgeMissingError extends Error {
  constructor() {
    super('window.compat is missing. Run this through Electron, not a browser.');
    this.name = 'BridgeMissingError';
  }
}

export function createApi(bridge = globalThis.compat) {
  const call = (name) => (...args) => {
    if (!bridge || typeof bridge[name] !== 'function') {
      throw new BridgeMissingError();
    }
    return bridge[name](...args);
  };

  return {
    available: () => Boolean(bridge),

    // ── Catalog ────────────────────────────────────────────────────────────
    list: call('list'),
    refresh: call('refresh'),
    search: call('search'),
    registry: call('registry'),
    /** { id } -> Session with messages */
    session: call('session'),

    /**
     * { id, maxChars } -> the payload that would be sent, with its redaction report
     * flattened onto it (`payload.redaction`), so a caller can show both without
     * knowing they arrive together.
     */
    payload: async (options) => {
      const result = await call('payload')(options);
      if (!result) return null;
      if (result.payload) return { ...result.payload, redaction: result.redaction };
      return result;
    },

    // ── Quiz options, readiness, planning ──────────────────────────────────
    /** Option bounds, type labels and key state. The UI hardcodes none of it. */
    capabilities: call('quizCapabilities'),

    /**
     * The most questions the selected types can produce.
     *
     * With one question per topic per type the ceiling is `maxPerQuiz x types`. Computed
     * here rather than sent, because the capabilities object crosses IPC and a function
     * cannot be structured-cloned.
     */
    ceiling(capabilities, types = []) {
      const perType = capabilities?.topics?.maxQuestionsPerType ?? 14;
      return perType * Math.max(1, types.length || 1);
    },
    /** { id, types } -> whether this conversation can be quizzed, and why not */
    readiness: call('readiness'),
    /** { id, questionCount, types } -> what would be generated, with no model call */
    planQuiz: call('planQuiz'),
    /** { id } -> deterministic topic segmentation */
    topics: call('topics'),
    /** { id, topicId } -> one bounded topic slice */
    topicSlice: call('topicSlice'),

    // ── Generation ─────────────────────────────────────────────────────────
    /** { id, questionCount, types, seed? } -> a quiz; does not persist */
    generateQuiz: call('generateQuiz'),
    /** Same, and writes it to the store. Returns the quiz with `stored`. */
    generateAndSave: call('generateAndSave'),

    // ── Storage and staleness ──────────────────────────────────────────────
    /** { id, questionCount, types } -> new | fresh | extended | diverged | settings_changed | generator_stale */
    staleness: call('quizStaleness'),
    /** Only the turns added since the stored quiz. */
    extendQuiz: call('extendQuiz'),
    /** { quizId } -> a stored quiz with its questions */
    quiz: call('getQuiz'),
    /** { id } -> the newest stored quiz for a conversation */
    quizForSession: call('quizForSession'),
    /** Stored quizzes, newest first, as summaries. */
    quizzes: call('listQuizzes'),
    /** { quizId, answers, save? } -> per-question results and a total */
    grade: call('gradeQuiz'),
    /** { quizId } -> attempt history and best score */
    attempts: call('attempts'),
    /** Delete every stored quiz and attempt. */
    clearQuizzes: call('clearQuizzes'),
    /** Where the store lives, and whether it is usable. */
    storeInfo: call('storeInfo'),

    // ── Events ─────────────────────────────────────────────────────────────
    onProgress: call('onProgress'),
    onReady: call('onReady'),
    onQuizProgress: call('onQuizProgress'),
  };
}
