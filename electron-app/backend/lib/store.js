// Persistent quiz storage.
//
// THE ONLY FILE IN THIS BACKEND THAT WRITES.
//
// Every reader opens other agents' stores read-only and cancels instantly if they
// cannot. This module is different: it owns a database of our own, and the rule that
// matters is that it stores QUESTIONS and never transcripts. Otherwise the app quietly
// becomes a second, unmanaged copy of the most sensitive files on the machine, which is
// exactly what the redaction and digest layers work to avoid.
//
// What is kept:
//   quiz            the questions, flashcards, the topic map, and what was redacted
//   attempt         one row per attempt, answers keyed by question id
//   topic_coverage  which topics a quiz already covers, for incremental generation
//
// What is NOT kept: message text, the digest, the prompt, the model response.
// Staleness is decided by a FINGERPRINT over the covered messages, not a copy of them.
//
// `lib/sqlite.js` in readers/ is the read side of this idea and shares nothing with
// this file on purpose: one reads other people's data, this one owns its own.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

let DatabaseSync = null;
let sqliteError = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch (err) {
  sqliteError = err.message;
}

/**
 * Bump when the prompt, the schema or the validation changes shape.
 *
 * Every stored quiz records the version that produced it, so a change here marks the
 * whole library stale rather than silently serving answers to questions the code no
 * longer asks.
 */
export const GENERATOR_VERSION = '1';

export const sqliteAvailable = () => DatabaseSync !== null;

/** Where the database lives. Override with AGENT_QUIZ_DB, or pass ':memory:' in tests. */
export function defaultStorePath() {
  if (process.env.AGENT_QUIZ_DB) return process.env.AGENT_QUIZ_DB;
  return path.join(os.homedir(), '.agent-quiz', 'quiz.db');
}

/**
 * A digest of the messages a quiz was built from.
 *
 * Covers `upTo` messages — the count the quiz actually saw — so a conversation that has
 * only been APPENDED to keeps the same fingerprint. That is what distinguishes
 * "extended" from "diverged", and it is the whole reason staleness compares content
 * instead of a file mtime: agents append to their session files constantly, so an mtime
 * changes even when nothing the quiz cared about did.
 */
export function fingerprintSession(session, { upTo } = {}) {
  const messages = session?.messages || [];
  const count = Math.min(upTo ?? messages.length, messages.length);
  const hash = crypto.createHash('sha256');
  for (let i = 0; i < count; i++) {
    const m = messages[i];
    hash.update(m.role || '');
    hash.update('\u0000');
    hash.update(m.text || '');
    hash.update('\u0001');
  }
  return hash.digest('hex');
}

/** The settings that change what a quiz contains. Two quizzes differ if this differs. */
export function settingsKey(settings = {}) {
  const relevant = {
    questionCount: settings.questionCount ?? null,
    // A different focus produces different questions, so it must invalidate a stored quiz
    // the same way a different question count does.
    focus: String(settings.focus || '').trim(),
    types: [...(settings.types || [])].sort(),
    flashcardsPerTopic: settings.flashcardsPerTopic ?? null,
    maxCharsPerTopic: settings.maxCharsPerTopic ?? null,
    maxTopics: settings.maxTopics ?? null,
  };
  return crypto.createHash('sha256').update(JSON.stringify(relevant)).digest('hex').slice(0, 16);
}

/**
 * A deterministic id, so regenerating the same conversation with the same settings
 * overwrites its own row instead of piling up duplicates, and an attempt stays attached
 * to the questions it was answered against.
 */
export function quizIdFor({ sessionId, contentFingerprint, coveredMessages, settings, generatorVersion = GENERATOR_VERSION }) {
  return crypto
    .createHash('sha256')
    .update([sessionId, contentFingerprint, coveredMessages, settingsKey(settings), generatorVersion].join('\u0000'))
    .digest('hex')
    .slice(0, 32);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS quiz (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL,
  harness             TEXT NOT NULL,
  project             TEXT,
  title               TEXT,
  content_fingerprint TEXT NOT NULL,
  covered_messages    INTEGER NOT NULL,
  generator_version   TEXT NOT NULL,
  settings_key        TEXT NOT NULL,
  settings            TEXT NOT NULL,
  model               TEXT,
  created_at          INTEGER NOT NULL,
  topics              TEXT NOT NULL,
  flashcards          TEXT NOT NULL,
  questions           TEXT NOT NULL,
  redaction_report    TEXT
);
CREATE INDEX IF NOT EXISTS quiz_session ON quiz(session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS attempt (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id     TEXT NOT NULL REFERENCES quiz(id) ON DELETE CASCADE,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  score       REAL,
  max_score   REAL,
  answers     TEXT NOT NULL,
  results     TEXT
);
CREATE INDEX IF NOT EXISTS attempt_quiz ON attempt(quiz_id, started_at DESC);

CREATE TABLE IF NOT EXISTS topic_coverage (
  quiz_id        TEXT NOT NULL REFERENCES quiz(id) ON DELETE CASCADE,
  topic_id       TEXT NOT NULL,
  label          TEXT NOT NULL,
  message_ranges TEXT NOT NULL,
  PRIMARY KEY (quiz_id, topic_id)
);
`;

export class QuizStoreError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QuizStoreError';
  }
}

export class QuizStore {
  /**
   * @param {string} [file]  path, or ':memory:'. Defaults to AGENT_QUIZ_DB or
   *                         ~/.agent-quiz/quiz.db
   */
  constructor(file = defaultStorePath()) {
    if (!DatabaseSync) {
      throw new QuizStoreError(
        `node:sqlite is unavailable in this runtime, so quizzes cannot be saved: ${sqliteError}. Node 22.13+ or Electron 44+ is required.`,
      );
    }
    this.file = file;
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  /** An in-memory store, for tests. */
  static memory() {
    return new QuizStore(':memory:');
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }

  /**
   * Save a generated quiz. Idempotent by id: regenerating the same conversation with
   * the same settings updates its row rather than creating a second one.
   *
   * @param {object} quiz     the object from lib/quiz.js
   * @param {object} session  the normalized session it came from
   * @param {object} [extra]  { settings, redaction }
   * @returns {{id: string, created: boolean}}
   */
  saveQuiz(quiz, session, extra = {}) {
    if (!quiz || !session) throw new QuizStoreError('saveQuiz needs a quiz and a session');
    if (!quiz.questions?.length && !quiz.flashcards?.length) {
      throw new QuizStoreError('refusing to save an empty quiz');
    }

    const settings = extra.settings || quiz.settings || {};
    // Cover everything up to the last turn the quiz drew on. Topics are derived from all
    // messages up to that point, so that is the honest boundary of what has been seen.
    const coveredMessages = Math.max(
      ...(quiz.topicsUsed || []).map((t) => (t.messageRanges?.[0]?.[1] ?? 0) + 1),
      0,
    );
    const contentFingerprint = fingerprintSession(session, { upTo: coveredMessages });
    const id = quizIdFor({ sessionId: session.id, contentFingerprint, coveredMessages, settings });

    const existing = this.db.prepare('SELECT id FROM quiz WHERE id = ?').get(id);

    this.db
      .prepare(
        `INSERT INTO quiz (id, session_id, harness, project, title, content_fingerprint,
                           covered_messages, generator_version, settings_key, settings, model,
                           created_at, topics, flashcards, questions, redaction_report)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           model=excluded.model, created_at=excluded.created_at,
           topics=excluded.topics, flashcards=excluded.flashcards,
           questions=excluded.questions, redaction_report=excluded.redaction_report`,
      )
      .run(
        id,
        session.id,
        session.harness || 'unknown',
        session.project || null,
        session.title || null,
        contentFingerprint,
        coveredMessages,
        GENERATOR_VERSION,
        settingsKey(settings),
        JSON.stringify(settings),
        quiz.model || null,
        Date.now(),
        JSON.stringify(quiz.topicsUsed || []),
        JSON.stringify(quiz.flashcards || []),
        JSON.stringify(quiz.questions || []),
        JSON.stringify(extra.redaction || quiz.redaction || null),
      );

    // Coverage is replaced, not appended: a regenerated quiz describes the topics it
    // actually used now.
    this.db.prepare('DELETE FROM topic_coverage WHERE quiz_id = ?').run(id);
    const insertCoverage = this.db.prepare(
      'INSERT OR REPLACE INTO topic_coverage (quiz_id, topic_id, label, message_ranges) VALUES (?,?,?,?)',
    );
    for (const topic of quiz.topicsUsed || []) {
      insertCoverage.run(id, topic.id, topic.label || '', JSON.stringify(topic.messageRanges || []));
    }

    return { id, created: !existing };
  }

  getQuiz(id) {
    const row = this.db.prepare('SELECT * FROM quiz WHERE id = ?').get(id);
    return row ? hydrate(row) : null;
  }

  /** The most recent quiz for a conversation, or null. */
  getQuizForSession(sessionId) {
    const row = this.db
      .prepare('SELECT * FROM quiz WHERE session_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(sessionId);
    return row ? hydrate(row) : null;
  }

  list({ sessionId, limit = 100 } = {}) {
    const rows = sessionId
      ? this.db.prepare('SELECT * FROM quiz WHERE session_id = ? ORDER BY created_at DESC LIMIT ?').all(sessionId, limit)
      : this.db.prepare('SELECT * FROM quiz ORDER BY created_at DESC LIMIT ?').all(limit);
    return rows.map((row) => {
      const quiz = hydrate(row);
      // The list view does not need every question; it needs enough to render a row.
      return {
        id: quiz.id,
        sessionId: quiz.sessionId,
        title: quiz.title,
        project: quiz.project,
        harness: quiz.harness,
        createdAt: quiz.createdAt,
        coveredMessages: quiz.coveredMessages,
        questionCount: quiz.questions.length,
        flashcardCount: quiz.flashcards.length,
        types: [...new Set(quiz.questions.map((q) => q.type))],
        attempts: this.attempts(quiz.id).length,
      };
    });
  }

  /**
   * Has the conversation changed since this quiz was generated, and if so how?
   *
   *   new              no quiz yet
   *   fresh            identical content, same settings, same generator
   *   extended         messages were appended; the old quiz is still valid, and
   *                    `fromMessage` is where new questions should start
   *   diverged         the messages the quiz was built from changed
   *   settings_changed same conversation, different options
   *   generator_stale  produced by an older GENERATOR_VERSION
   */
  staleness(session, settings = {}) {
    if (!session) return { state: 'new' };
    const quiz = this.getQuizForSession(session.id);
    if (!quiz) return { state: 'new', coveredMessages: 0, fromMessage: 0 };

    const fact = { quizId: quiz.id, coveredMessages: quiz.coveredMessages, createdAt: quiz.createdAt };

    if (quiz.generatorVersion !== GENERATOR_VERSION) return { state: 'generator_stale', ...fact };
    if (fingerprintSession(session, { upTo: quiz.coveredMessages }) !== quiz.contentFingerprint) {
      return { state: 'diverged', ...fact };
    }
    if (session.messages.length > quiz.coveredMessages) {
      return {
        state: 'extended',
        ...fact,
        newMessages: session.messages.length - quiz.coveredMessages,
        /** Pass this as `fromMessage` to generate only about the new turns. */
        fromMessage: quiz.coveredMessages,
      };
    }
    if (settingsKey(settings) !== quiz.settingsKey) return { state: 'settings_changed', ...fact };
    return { state: 'fresh', ...fact };
  }

  saveAttempt(quizId, { answers, score, maxScore, results, startedAt, finishedAt } = {}) {
    if (!this.getQuiz(quizId)) throw new QuizStoreError(`no quiz ${quizId}`);
    const info = this.db
      .prepare(
        `INSERT INTO attempt (quiz_id, started_at, finished_at, score, max_score, answers, results)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        quizId,
        startedAt ?? Date.now(),
        finishedAt ?? Date.now(),
        score ?? null,
        maxScore ?? null,
        JSON.stringify(answers || {}),
        JSON.stringify(results || null),
      );
    return Number(info.lastInsertRowid);
  }

  attempts(quizId) {
    return this.db
      .prepare('SELECT * FROM attempt WHERE quiz_id = ? ORDER BY started_at DESC')
      .all(quizId)
      .map((row) => ({
        id: row.id,
        quizId: row.quiz_id,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        score: row.score,
        maxScore: row.max_score,
        answers: JSON.parse(row.answers || '{}'),
        results: row.results ? JSON.parse(row.results) : null,
      }));
  }

  /** Best score across attempts, for a progress view. */
  bestScore(quizId) {
    const row = this.db
      .prepare('SELECT MAX(score) AS best, MAX(max_score) AS maxScore, COUNT(*) AS n FROM attempt WHERE quiz_id = ?')
      .get(quizId);
    return { best: row?.best ?? null, maxScore: row?.maxScore ?? null, attempts: row?.n ?? 0 };
  }

  deleteQuiz(id) {
    // topic_coverage and attempt are declared ON DELETE CASCADE, and foreign_keys is on.
    return this.db.prepare('DELETE FROM quiz WHERE id = ?').run(id).changes > 0;
  }

  /** The answer to "delete everything you have stored about me". */
  clear() {
    const before = this.db.prepare('SELECT COUNT(*) AS n FROM quiz').get().n;
    this.db.exec('DELETE FROM attempt; DELETE FROM topic_coverage; DELETE FROM quiz;');
    return { removed: before };
  }

  stats() {
    const one = (sql) => this.db.prepare(sql).get();
    return {
      file: this.file,
      quizzes: one('SELECT COUNT(*) AS n FROM quiz').n,
      attempts: one('SELECT COUNT(*) AS n FROM attempt').n,
      conversations: one('SELECT COUNT(DISTINCT session_id) AS n FROM quiz').n,
      oldest: one('SELECT MIN(created_at) AS t FROM quiz').t,
      newest: one('SELECT MAX(created_at) AS t FROM quiz').t,
      generatorVersion: GENERATOR_VERSION,
    };
  }
}

function hydrate(row) {
  return {
    id: row.id,
    sessionId: row.session_id,
    harness: row.harness,
    project: row.project,
    title: row.title,
    contentFingerprint: row.content_fingerprint,
    coveredMessages: row.covered_messages,
    generatorVersion: row.generator_version,
    settingsKey: row.settings_key,
    settings: JSON.parse(row.settings || '{}'),
    model: row.model,
    createdAt: row.created_at,
    topicsUsed: JSON.parse(row.topics || '[]'),
    flashcards: JSON.parse(row.flashcards || '[]'),
    questions: JSON.parse(row.questions || '[]'),
    redaction: row.redaction_report ? JSON.parse(row.redaction_report) : null,
  };
}
