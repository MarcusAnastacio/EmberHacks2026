// The one schema the rest of the app speaks.
//
// Every reader, no matter which agent it parsed, returns these. The quiz
// generator and the renderer only ever touch this shape, so adding an agent
// never touches app code.

import path from 'node:path';
import { deriveTitle } from './text.js';

/**
 * @typedef {Object} Message
 * @property {'user'|'assistant'|'system'|'tool'} role
 * @property {string} text
 * @property {number} [ts]            epoch ms, when the transcript stamped one
 * @property {{name:string,input:any}[]} [tools]
 *
 * @typedef {Object} Session
 * @property {string}  id             stable, unique: "<harness>:<native-id>"
 * @property {string}  nativeId
 * @property {string}  harness        registry id, e.g. "claude"
 * @property {string}  harnessName    display name, e.g. "Claude Code"
 * @property {string}  project        human-readable project/workspace label
 * @property {string}  [cwd]          absolute working directory when known
 * @property {string}  [title]
 * @property {string}  [path]         source file on disk
 * @property {'file'|'sqlite'|'vscode'} source
 * @property {number}  started        epoch ms
 * @property {number}  updated        epoch ms
 * @property {Message[]} messages
 * @property {number}  userTurns
 * @property {number}  chars
 * @property {boolean} [partial]      parsed, but some turns were undecodable
 */

export function makeMessage({ role, text, ts, tools }) {
  const clean = typeof text === 'string' ? text.trim() : '';
  return {
    role: normalizeRole(role),
    text: clean,
    ...(Number.isFinite(ts) && ts > 0 ? { ts } : {}),
    ...(tools && tools.length ? { tools } : {}),
  };
}

export function normalizeRole(role) {
  const r = String(role || '').toLowerCase();
  if (r === 'human' || r === 'user' || r === 'input') return 'user';
  if (r === 'assistant' || r === 'ai' || r === 'model' || r === 'output' || r === 'bot') return 'assistant';
  if (r === 'system' || r === 'developer') return 'system';
  if (r === 'tool' || r === 'tool_result' || r === 'function') return 'tool';
  return 'assistant';
}

/** Tolerant timestamp: seconds, millis, ISO string, or numeric string. */
export function toEpochMs(value) {
  if (value == null || value === '') return undefined;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return undefined;
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string') {
    if (/^\d+(\.\d+)?$/.test(value)) return toEpochMs(Number(value));
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

/**
 * Assemble a Session: drop empty messages, sort, derive title, count.
 * Returns null when nothing usable was parsed, so callers can skip the file.
 */
export function finalizeSession(input) {
  const messages = (input.messages || [])
    .map((m) => (m && typeof m === 'object' && 'text' in m ? m : makeMessage(m)))
    .filter((m) => m.text && m.text.length > 0);

  // Consecutive same-role turns are common after a tool call is dropped; merge
  // them so the quiz sees one coherent turn per speaker.
  const merged = [];
  for (const m of messages) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role && prev.tools?.length === m.tools?.length) {
      prev.text = `${prev.text}\n\n${m.text}`;
      prev.ts = prev.ts ?? m.ts;
      if (m.tools) prev.tools = [...(prev.tools || []), ...m.tools];
    } else {
      merged.push({ ...m });
    }
  }

  if (merged.length === 0) return null;

  const stamped = merged.filter((m) => m.ts).map((m) => m.ts);
  const fallback = input.updated || input.started || Date.now();
  const started = input.started ?? (stamped.length ? Math.min(...stamped) : fallback);
  const updated = input.updated ?? (stamped.length ? Math.max(...stamped) : started);

  const chars = merged.reduce((n, m) => n + m.text.length, 0);
  const userTurns = merged.filter((m) => m.role === 'user').length;

  const firstUser = merged.find((m) => m.role === 'user');
  const title = input.title || deriveTitle(firstUser?.text) || 'Untitled session';

  const nativeId = String(input.nativeId || input.id || path.basename(String(input.path || 'session')));

  return {
    id: `${input.harness}:${nativeId}`,
    nativeId,
    harness: input.harness,
    harnessName: input.harnessName || input.harness,
    project: input.project || 'unknown project',
    ...(input.cwd ? { cwd: input.cwd } : {}),
    title,
    ...(input.path ? { path: input.path } : {}),
    source: input.source || 'file',
    started,
    updated,
    messages: merged,
    userTurns,
    chars,
    ...(input.partial ? { partial: true } : {}),
  };
}

/**
 * Turn a filesystem path into something a person recognises as a project.
 * Claude Code encodes cwd as `--home-dev-code-myapp--`; we prefer a real cwd from
 * the transcript when the reader found one.
 */
export function projectFromEncodedDir(dirName) {
  const m = /^--(.+)--$/.exec(dirName);
  const raw = m ? m[1] : dirName;
  return raw
    .replace(/^-/, '')
    .split('-')
    .filter(Boolean)
    .slice(-3)
    .join('/') || dirName;
}

export function projectFromPath(p) {
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  // Drop the well-known store segments so we end up with the workspace name.
  const stop = new Set([
    'sessions', 'projects', 'chats', 'threads', 'tasks', 'conversations', 'logs',
    'rollout', 'history', 'workspaceStorage', 'globalStorage', 'state', 'data',
  ]);
  const interesting = parts.filter((part, i) => i > 0 && !stop.has(part) && !part.startsWith('--'));
  return interesting.slice(-2).join('/') || parts[parts.length - 2] || 'unknown';
}
