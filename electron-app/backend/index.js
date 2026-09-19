// Public API of the compatibility layer.
//
// Electron main process usage:
//
//   import { CompatibilityLayer } from './backend/index.js'
//   const layer = new CompatibilityLayer()
//   layer.on('progress', e => win.webContents.send('scan:progress', e))
//   const catalog = await layer.refresh()
//   const session = layer.getSession(id)
//   const payload = layer.quizPayload(id)   // -> hand to Gemini
//
// The layer owns no UI and no Gemini calls: it only answers "what conversations
// exist on this machine, and what is in them".

import { EventEmitter } from 'node:events';
import { scanAll, discoverStores, findSession, toQuizPayload, isQuizReady, loadRegistry, QUIZ_MIN_CHARS, QUIZ_MIN_USER_TURNS } from './detect.js';
import { redactPayload } from './lib/redact.js';
import { buildDigest } from './lib/digest.js';
import { deriveTopics, topicSlice, topicSlices } from './lib/topics.js';
import { generateQuiz, planQuiz, quizSchema, quizCapabilities, assessReadiness, QUESTION_TYPES } from './lib/quiz.js';
import { hasApiKey, listModels } from './lib/gemini.js';

export class CompatibilityLayer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    /** @type {Awaited<ReturnType<typeof scanAll>>|null} */
    this.catalog = null;
    this.scanning = null;
  }

  /** Every harness we know how to look for, detected or not. */
  registry() {
    return loadRegistry();
  }

  /** Fast: which stores exist. No parsing. */
  discover() {
    return discoverStores({ projectRoot: this.options.projectRoot });
  }

  /**
   * Full scan. Concurrent calls share one in-flight scan.
   * @returns {Promise<object>} the catalog
   */
  async refresh(options = {}) {
    if (this.scanning) return this.scanning;
    this.scanning = scanAll({
      projectRoot: this.options.projectRoot,
      ...options,
      onProgress: (evt) => {
        this.emit('progress', evt);
        options.onProgress?.(evt);
      },
    })
      .then((catalog) => {
        this.catalog = catalog;
        this.emit('ready', catalog);
        return catalog;
      })
      .finally(() => {
        this.scanning = null;
      });
    return this.scanning;
  }

  /** Sidebar data: harnesses that actually have history, with their sessions. */
  list({ quizReadyOnly = false, harness } = {}) {
    if (!this.catalog) return { scanned: false, groups: [], totalSessions: 0 };
    let sessions = this.catalog.sessions;
    if (harness) sessions = sessions.filter((s) => s.harness === harness);
    if (quizReadyOnly) sessions = sessions.filter(isQuizReady);

    const byHarness = new Map();
    for (const s of sessions) {
      if (!byHarness.has(s.harness)) {
        byHarness.set(s.harness, {
          harness: s.harness,
          name: s.harnessName,
          sessions: [],
        });
      }
      byHarness.get(s.harness).sessions.push({
        id: s.id,
        nativeId: s.nativeId,
        title: s.title,
        project: s.project,
        updated: s.updated,
        started: s.started,
        messageCount: s.messages.length,
        userTurns: s.userTurns,
        chars: s.chars,
        quizReady: isQuizReady(s),
        partial: s.partial || false,
        source: s.source,
      });
    }

    return {
      scanned: true,
      scannedAt: this.catalog.scannedAt,
      sqlite: this.catalog.sqlite,
      detectedHarnesses: this.catalog.detectedHarnesses,
      totalHarnesses: this.catalog.totalHarnesses,
      totalSessions: sessions.length,
      quizReady: sessions.filter(isQuizReady).length,
      groups: [...byHarness.values()].sort((a, b) => b.sessions.length - a.sessions.length),
      // Harnesses we looked for but found nothing for — useful for "why isn't my
      // tool here?" and for the presentation slide on coverage.
      absent: this.catalog.harnesses.filter((h) => !h.detected).map((h) => ({ id: h.id, name: h.name })),
    };
  }

  getSession(id) {
    return this.catalog ? findSession(this.catalog, id) : null;
  }

  /**
   * The exact object to hand to Gemini: the conversation trimmed to a budget AND
   * secrets removed. This is the single point where a transcript leaves the
   * machine, which is why redaction lives here and not in the caller.
   *
   * @returns {{payload: object, redaction: object}|null}
   */
  quizPayload(id, opts) {
    const session = this.getSession(id);
    if (!session) return null;
    const raw = toQuizPayload(session, opts);
    const { payload, report } = redactPayload(raw, { entropy: opts?.entropy === true });
    return { payload, redaction: report };
  }

  /**
   * The bounded, ordered digest of one conversation plus the project context it
   * touched. This is the input the topic segmentation and question generation
   * stages will consume — see docs/quiz-design.md §2.
   */
  digest(id, opts) {
    const session = this.getSession(id);
    if (!session) return null;
    return buildDigest(session, opts);
  }

  /**
   * Deterministic topic segmentation of one conversation. No model call: cuts come
   * from file-set changes, lexical overlap, pauses and transition markers, and each
   * topic is labelled with its opening user turn.
   */
  topics(id, opts) {
    const session = this.getSession(id);
    if (!session) return null;
    return deriveTopics(session, opts);
  }

  /** One bounded prompt body for a topic — Stage C's input. */
  topicSlice(id, topicId, opts) {
    const session = this.getSession(id);
    if (!session) return null;
    const { topics } = deriveTopics(session, opts);
    const topic = topics.find((t) => t.id === topicId) || topics[Number(topicId) - 1];
    if (!topic) return null;
    return topicSlice(session, topic, opts);
  }

  /** Every topic slice, each capped. The complete bounded input set for generation. */
  topicSlices(id, opts) {
    const session = this.getSession(id);
    if (!session) return null;
    return topicSlices(session, opts);
  }

  /**
   * What would be generated, without calling the model: which topics, how many
   * flashcards, and one question per (topic, enabled type).
   */
  planQuiz(id, opts) {
    const session = this.getSession(id);
    if (!session) return null;
    return planQuiz(session, opts);
  }

  /**
   * Generate flashcards and quiz questions for one conversation.
   *
   * One Gemini call per selected topic, in parallel, each bounded by
   * `maxCharsPerTopic`. Flashcards are always produced; questions only for the
   * enabled types.
   */
  async generateQuiz(id, opts) {
    const session = this.getSession(id);
    if (!session) return null;
    return generateQuiz(session, opts);
  }

  /**
   * Whether this conversation can support a quiz, with the reasons when it cannot.
   * Cheap and offline, so the UI can call it while rendering the sidebar.
   */
  assessReadiness(id, opts) {
    const session = this.getSession(id);
    if (!session) return null;
    return assessReadiness(session, opts);
  }

  /** Option bounds, type labels and key state, so the UI hardcodes none of it. */
  quizCapabilities() {
    return quizCapabilities();
  }

  /** Whether a Gemini key is available, without revealing it. */
  hasApiKey(explicit) {
    return hasApiKey(explicit);
  }

  /** Which models this key can actually reach. */
  listModels(opts) {
    return listModels(opts);
  }

  /** Redaction only, for inspecting what would be stripped. */
  redactionReport(id, opts) {
    const result = this.quizPayload(id, opts);
    return result ? result.redaction : null;
  }

  /**
   * Lightweight candidate list for the "pick a conversation to be quizzed on"
   * step: no message bodies, so it is safe to send to the renderer whole.
   */
  search(query = '') {
    const q = query.trim().toLowerCase();
    const { groups } = this.list();
    const flat = groups.flatMap((g) => g.sessions.map((s) => ({ ...s, harnessName: g.name })));
    if (!q) return flat;
    return flat.filter((s) =>
      [s.title, s.project, s.harnessName].join(' ').toLowerCase().includes(q),
    );
  }
}

export {
  scanAll,
  discoverStores,
  findSession,
  toQuizPayload,
  isQuizReady,
  loadRegistry,
  QUIZ_MIN_CHARS,
  QUIZ_MIN_USER_TURNS,
};
export { expandStorePath, globStorePaths } from './lib/expand.js';
export { readStoreFile } from './readers/index.js';
export { sqliteAvailable } from './readers/sqlite.js';
export { redact, redactPayload, patternKinds } from './lib/redact.js';
export { buildDigest, digestFits, extractTouched, renderTurnRange } from './lib/digest.js';
export { deriveTopics, topicSlice, topicSlices } from './lib/topics.js';
export { generateQuiz, planQuiz, quizSchema, validateResult, quizCapabilities, assessReadiness, QUESTION_TYPES, READINESS, DEFAULTS as QUIZ_DEFAULTS } from './lib/quiz.js';
export { generateJson, listModels, hasApiKey, resolveApiKey, GeminiError, DEFAULT_MODEL_CHAIN } from './lib/gemini.js';
export {
  renderTree, collectDocs, collectManifests, commitsInWindow, workingTreeState,
} from './lib/project.js';
