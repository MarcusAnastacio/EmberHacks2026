// JSON readers: Continue, Cline family, VS Code chat sessions, Gemini CLI,
// Amp threads, and a generic fallback for anything message-shaped.

import { contentToParts, contentToText } from '../lib/text.js';
import { finalizeSession, makeMessage, toEpochMs } from '../lib/normalize.js';

/** Files that are indexes rather than conversations. */
export const INDEX_FILES = new Set([
  'sessions.json', 'projects.json', 'taskHistory.json', 'sessions.jsonl',
  'storage.json', 'workspace.json', 'history_item.json', 'workspace.json',
]);

/** Read one copilot/chatSessions/*.json turn-pair list. */
function readVscodeChatSessions(data, ctx) {
  const requests = data.requests || data.turns || [];
  const messages = [];
  if (data.creationDate) ctx.started = toEpochMs(data.creationDate);

  for (const req of requests) {
    const userText =
      req?.message?.text ??
      req?.message?.value ??
      req?.request?.message ??
      (typeof req?.message === 'string' ? req.message : '');
    if (userText) {
      messages.push(makeMessage({ role: 'user', text: contentToText(userText), ts: toEpochMs(req.timestamp) }));
    }

    const response = req?.response ?? req?.responses ?? [];
    const parts = [];
    if (Array.isArray(response)) {
      for (const r of response) {
        if (typeof r === 'string') parts.push(r);
        else if (r?.value) parts.push(r.value);
        else if (r?.text) parts.push(r.text);
        else if (r?.content) parts.push(contentToText(r.content));
      }
    } else if (typeof response === 'string') {
      parts.push(response);
    }
    const answer = parts.filter(Boolean).join('\n\n').trim();
    if (answer) {
      messages.push(makeMessage({ role: 'assistant', text: answer, ts: toEpochMs(req.timestamp) }));
    }
  }

  if (data.customTitle) ctx.title = data.customTitle;
  return { messages, cwd: data.workspaceFolder?.folderUri || data.workspaceUri };
}

/** Continue.dev / PearAI session files. */
function readContinue(data, ctx) {
  const history = data.history || data.messages || [];
  const messages = [];
  for (const item of history) {
    const m = item?.message ?? item;
    if (!m) continue;
    const { text, tools, thinkingChars } = contentToParts(m.content ?? m.parts);
    if (!text && !tools?.length) continue;
    messages.push(makeMessage({ role: m.role, text, thinkingChars, tools }));
  }
  return {
    messages,
    cwd: data.workspaceDirectory || data.workspace?.workspaceLocation,
    nativeId: data.sessionId || data.id,
    title: data.title,
  };
}

/** Gemini CLI checkpoint files. */
function readGemini(data, ctx) {
  const list = data.messages || data.history || [];
  const messages = [];
  for (const m of list) {
    const role = m.type === 'gemini' ? 'assistant' : m.type === 'user' ? 'user' : m.role;
    const { text, tools, thinkingChars } = contentToParts(m.content ?? m.parts ?? m.text);
    if (!text && !tools?.length) continue;
    messages.push(makeMessage({ role, text, thinkingChars, ts: toEpochMs(m.timestamp), tools }));
  }
  return {
    messages,
    nativeId: data.sessionId || data.id,
    started: toEpochMs(data.startTime),
    updated: toEpochMs(data.lastUpdated),
  };
}

/** Amp / generic thread objects. */
function readThread(data, ctx) {
  const list = data.messages || data.thread || data.items || [];
  const messages = [];
  for (const m of list) {
    const { text, tools, thinkingChars } = contentToParts(m.content ?? m.text ?? m.message);
    const role = m.role || m.author?.role || m.type;
    if (!text && !tools?.length) continue;
    messages.push(makeMessage({ role, text, thinkingChars, ts: toEpochMs(m.timestamp || m.created), tools }));
  }
  return {
    messages,
    nativeId: data.id,
    title: data.title,
    started: toEpochMs(data.created || data.createdAt),
  };
}

/** Array-of-messages, the shape Cline/Roo/Kilo api_conversation_history.json uses. */
function readMessageArray(list) {
  const messages = [];
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const { text, tools, thinkingChars } = contentToParts(m.content ?? m.parts ?? m.text);
    if (!text && !tools?.length) continue;
    messages.push(makeMessage({ role: m.role, text, thinkingChars, ts: toEpochMs(m.timestamp || m.ts), tools }));
  }
  return { messages };
}

function looksLikeMessages(list) {
  if (!Array.isArray(list) || list.length === 0) return false;
  return list.filter((m) => m && typeof m === 'object' && (m.role || m.type)).length >= list.length * 0.6;
}

// --- VS Code chat session storage log -------------------------------------
//
// Verified against VS Code source: src/vs/workbench/contrib/chat/common/model/
// objectMutationLog.ts. VS Code does not write a message list; it appends an
// operation log over an initial snapshot:
//
//   {"kind":0,"v":{...}}                          Initial — full snapshot, first line only
//   {"kind":1,"k":["requests",0,"response",2],"v":{...}}  Set
//   {"kind":2,"k":["requests"],"v":[...],"i":0}          Push  (truncate to i, then append)
//   {"kind":3,"k":["requests",0]}                         Delete (sets the path to undefined)
//
// Two behaviours that are easy to get wrong and are load-bearing here:
//   * Push with an index TRUNCATES the array to that index first. That is how
//     VS Code re-serialises a response part while it streams, so folding in the
//     wrong order duplicates text.
//   * Delete sets the property to undefined rather than splicing, so array
//     indices stay stable.

/** Set a nested path. Intermediate containers are created from the next segment's type. */
function applySet(root, keyPath, value) {
  let node = root;
  for (let i = 0; i < keyPath.length - 1; i++) {
    const k = keyPath[i];
    if (node[k] === undefined || node[k] === null) {
      node[k] = typeof keyPath[i + 1] === 'number' ? [] : {};
    }
    node = node[k];
    if (node == null) return;
  }
  node[keyPath[keyPath.length - 1]] = value;
}

/** Push/splice semantics: truncate to startIndex when present, then append. */
function applyPush(root, keyPath, values, startIndex) {
  let node = root;
  for (let i = 0; i < keyPath.length - 1; i++) {
    node = node[keyPath[i]];
    if (node == null) return;
  }
  const key = keyPath[keyPath.length - 1];
  const arr = Array.isArray(node[key]) ? node[key] : [];
  if (typeof startIndex === 'number') arr.length = startIndex;
  if (Array.isArray(values) && values.length) arr.push(...values);
  node[key] = arr;
}

/**
 * Fold a VS Code chat storage operation log into its final object.
 * Returns null when the log has no Initial entry (i.e. it is not a chat log).
 */
export function decodeVscodeChatLog(records) {
  let base = null;
  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    if (r.kind === 0) {
      base = r.v ?? r.value ?? null;
      continue;
    }
    // A log is only valid after its Initial entry.
    if (!base) continue;
    const keyPath = r.k ?? r.key ?? r.path;
    if (!Array.isArray(keyPath)) continue;
    try {
      if (r.kind === 1) applySet(base, keyPath, r.v ?? r.value);
      else if (r.kind === 2) applyPush(base, keyPath, r.v ?? r.value, r.i);
      else if (r.kind === 3) applySet(base, keyPath, undefined);
    } catch {
      /* a malformed op must not lose the rest of the session */
    }
  }
  return base;
}

/**
 * Parse a JSON transcript into a normalized session.
 * Returns null if the file is an index or is not conversation-shaped.
 */
export function readJson(raw, ctx) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (data == null) return null;

  let extracted = null;

  if (Array.isArray(data)) {
    if (!looksLikeMessages(data)) return null;
    extracted = readMessageArray(data);
  } else if (Array.isArray(data.requests) || Array.isArray(data.turns)) {
    extracted = readVscodeChatSessions(data, ctx);
  } else if (Array.isArray(data.history)) {
    extracted = readContinue(data, ctx);
  } else if (Array.isArray(data.messages) && ctx.harness === 'gemini') {
    extracted = readGemini(data, ctx);
  } else if (Array.isArray(data.messages) || Array.isArray(data.items)) {
    extracted = readThread(data, ctx);
  } else if (data.sessionId && Array.isArray(data.messages)) {
    extracted = readGemini(data, ctx);
  } else if (typeof data.text === 'string' && data.role) {
    extracted = readMessageArray([data]);
  }

  if (!extracted || !extracted.messages?.length) return null;
  return finalizeSession({ ...ctx, ...extracted, source: 'file' });
}

/**
 * Entry point for VS Code chat sessions: decode the operation log, then read it
 * as a chat-session object. Returns { empty: true } when the session exists but
 * holds no turns, which is the common case (VS Code creates the file as soon as
 * the chat panel opens).
 */
export function readVscodeChatLog(records, ctx) {
  const data = decodeVscodeChatLog(records);
  if (!data) return { empty: true };

  const extracted = readVscodeChatSessions(data, ctx);
  if (!extracted.messages.length) return { empty: true };

  const session = finalizeSession({
    ...ctx,
    ...extracted,
    source: 'vscode',
    nativeId: data.sessionId || ctx.nativeId,
  });
  return session ? { sessions: [session] } : { empty: true };
}
