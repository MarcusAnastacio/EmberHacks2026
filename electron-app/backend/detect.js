// The scan engine.
//
// Walks the registry, expands each harness's store templates, reads whatever is
// on disk, and returns normalized sessions plus an honest per-harness report of
// what was found and what could not be read.

import fs from 'node:fs';
import path from 'node:path';

import { expandStorePath, globStorePaths, walkFiles, HOME, PLATFORM, PLATFORM_NAME, platformRoots } from './lib/expand.js';
import { readStoreFile } from './readers/index.js';
import { sqliteAvailable, sqliteUnavailableReason } from './readers/sqlite.js';
import { EXTRA_HARNESSES } from './registry.extras.js';

const REGISTRY_URL = new URL('./registry.json', import.meta.url);
export const FIXTURE_ROOT = new URL('./fixtures', import.meta.url).pathname;

/**
 * Fixture mode: point every harness at the vendored sample stores instead of
 * the live ones. Used for testing parsers and for demos on a machine that has
 * only two or three agents installed — the registry knowledge is real even when
 * the local installs are not.
 *
 * Fixture directories follow the upstream names, which differ from a few
 * registry ids, so alias where they diverge.
 */
const FIXTURE_DIR_ALIASES = {
  claude: 'claude-code',
  copilot_chat: 'copilot-chat',
};

function fixtureDirFor(id) {
  const dir = FIXTURE_DIR_ALIASES[id] || id;
  return path.join(FIXTURE_ROOT, dir);
}

/** Every file under a harness's fixture directory, dotfiles included. */
function fixtureFilesFor(id) {
  return walkFiles(fixtureDirFor(id));
}

export function loadRegistry() {
  const data = JSON.parse(fs.readFileSync(REGISTRY_URL, 'utf8'));
  const seen = new Set(data.harnesses.map((h) => h.id));
  return [...data.harnesses, ...EXTRA_HARNESSES.filter((h) => !seen.has(h.id))];
}

/** How many user turns / characters a session needs before a quiz is worth it. */
export const QUIZ_MIN_USER_TURNS = 2;
export const QUIZ_MIN_CHARS = 400;

export function isQuizReady(session) {
  return session.userTurns >= QUIZ_MIN_USER_TURNS && session.chars >= QUIZ_MIN_CHARS;
}

/**
 * Enumerate the stores that exist on this machine, without parsing them.
 * Cheap enough to run on app start for a "what did we find" summary.
 */
/**
 * Enumerate the stores that exist on this machine, without parsing them.
 * Cheap enough to run on app start for a "what did we find" summary.
 */
export function discoverStores({ projectRoot, registry = loadRegistry(), fixtures = false } = {}) {
  const harnesses = [];

  for (const entry of registry) {
    const found = fixtures
      ? fixtureFilesFor(entry.id).map((file) => ({ file, pattern: `${FIXTURE_ROOT}/${entry.id}/**` }))
      : globStorePaths(
          (entry.store_paths || []).flatMap((t) => expandStorePath(t, { projectRoot })),
        );

    const stores = found.map(({ file, pattern }) => {
      let size = 0;
      try {
        size = fs.statSync(file).size;
      } catch {
        /* ignore */
      }
      return { path: file, pattern, size };
    });

    harnesses.push({
      id: entry.id,
      name: entry.display_name || entry.id,
      formatKind: entry.format_kind || 'unknown',
      detected: stores.length > 0,
      storeCount: stores.length,
      totalBytes: stores.reduce((n, s) => n + s.size, 0),
      stores,
      note: entry.note,
      lastVerified: entry.last_verified,
    });
  }

  return harnesses;
}

/** Guard against reading the same content twice when two templates overlap. */
function dedupeByPath(sessions) {
  const seen = new Set();
  return sessions.filter((s) => {
    const key = s.path || s.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Full scan: discover stores, parse them, return normalized sessions.
 *
 * @param {object} [opts]
 * @param {string} [opts.projectRoot]   fills `<project>` templates
 * @param {string[]} [opts.only]        restrict to these harness ids
 * @param {number} [opts.maxPerHarness] session cap per agent (default 200)
 * @param {number} [opts.maxFiles]      file cap per agent (default 400)
 * @param {(evt:object)=>void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 */
export async function scanAll(opts = {}) {
  const {
    projectRoot,
    only,
    fixtures = false,
    maxPerHarness = 200,
    maxFiles = 400,
    onProgress = () => {},
    signal,
  } = opts;

  const registry = loadRegistry();
  const entries = only ? registry.filter((h) => only.includes(h.id)) : registry;

  const report = [];
  const sessions = [];
  const errors = [];

  for (const entry of entries) {
    if (signal?.aborted) break;

    const name = entry.display_name || entry.id;
    onProgress({ phase: 'harness-start', harness: entry.id, name });

    let found;
    if (fixtures) {
      found = fixtureFilesFor(entry.id).map((file) => ({ file, pattern: 'fixture' }));
    } else {
      try {
        const patterns = (entry.store_paths || []).flatMap((t) => expandStorePath(t, { projectRoot }));
        found = globStorePaths(patterns, { limit: maxFiles });
      } catch (err) {
        errors.push({ harness: entry.id, message: `path expansion failed: ${err.message}` });
        continue;
      }
    }

    const harnessSessions = [];
    const skipped = [];
    let detectedOnly = 0;
    let empty = 0;

    for (const { file } of found) {
      if (signal?.aborted) break;
      if (harnessSessions.length >= maxPerHarness) break;

      let result;
      try {
        result = readStoreFile(file, {
          harness: entry.id,
          harnessName: name,
          formatKind: entry.format_kind,
          nativeId: file,
        });
      } catch (err) {
        skipped.push({ path: file, reason: err.message });
        continue;
      }

      if (result.detectedOnly) detectedOnly++;
      else if (result.empty) empty++;
      else if (result.skipped) skipped.push({ path: file, reason: result.skipped });
      else harnessSessions.push(...result.sessions);
    }

    const unique = dedupeByPath(harnessSessions);
    sessions.push(...unique);

    report.push({
      id: entry.id,
      name,
      formatKind: entry.format_kind || 'unknown',
      note: entry.note,
      detected: found.length > 0,
      fileCount: found.length,
      sessionCount: unique.length,
      detectedOnly,
      empty,
      fixture: fixtures,
      quizReady: unique.filter(isQuizReady).length,
      totalBytes: unique.reduce((n, s) => n + (s.chars || 0), 0),
      skipped: skipped.slice(0, 12),
      skippedCount: skipped.length,
      stores: found.slice(0, 40).map(({ file }) => file),
    });

    onProgress({
      phase: 'harness-done',
      harness: entry.id,
      name,
      sessions: unique.length,
      files: found.length,
    });
  }

  sessions.sort((a, b) => b.updated - a.updated);

  return {
    scannedAt: Date.now(),
    platform: {
      id: PLATFORM,
      name: PLATFORM_NAME,
      roots: platformRoots(),
    },
    home: HOME,
    sqlite: { available: sqliteAvailable(), reason: sqliteAvailable() ? undefined : sqliteUnavailableReason() },
    harnesses: report,
    detectedHarnesses: report.filter((h) => h.detected).length,
    totalHarnesses: report.length,
    sessions,
    quizReadyCount: sessions.filter(isQuizReady).length,
    errors,
  };
}

/** Look up one session by its normalized id from a previous scan. */
export function findSession(scan, id) {
  return scan.sessions.find((s) => s.id === id) || null;
}

/**
 * The trimmed payload handed to Gemini. Keeps the shape the quiz generator
 * needs and nothing else, so prompt size stays predictable.
 */
export function toQuizPayload(session, { maxChars = 24000, maxMessages = 120 } = {}) {
  const messages = [];
  let used = 0;

  // A flat per-message cap starves the payload when the budget is small: one long
  // turn can consume everything and the quiz sees a single message. Scale the cap
  // to the budget so a few turns always fit.
  const perMessage = Math.max(600, Math.min(4000, Math.floor(maxChars / 6)));

  // Newest turns matter most for "what did the agent actually build", but the
  // opening turns carry the task statement, so keep both ends and drop the middle.
  const source = session.messages.length <= maxMessages
    ? session.messages
    : [...session.messages.slice(0, Math.floor(maxMessages / 3)),
       ...session.messages.slice(-Math.ceil((maxMessages * 2) / 3))];

  for (const m of source) {
    const text = m.text.length > perMessage ? `${m.text.slice(0, perMessage)}…` : m.text;
    if (used + text.length > maxChars && messages.length > 0) break;
    used += text.length;
    messages.push({
      role: m.role,
      text,
      ...(m.tools?.length ? { tools: m.tools.map((t) => t.name) } : {}),
    });
  }

  return {
    id: session.id,
    harness: session.harness,
    harnessName: session.harnessName,
    project: session.project,
    cwd: session.cwd,
    title: session.title,
    startedAt: new Date(session.started).toISOString(),
    userTurns: session.userTurns,
    messageCount: session.messages.length,
    truncated: messages.length < session.messages.length,
    messages,
  };
}
