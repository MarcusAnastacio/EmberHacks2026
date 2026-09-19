// Official data-export readers.
//
// These are the formats you get from "Export data" in the ChatGPT and Claude
// web apps, so the quiz can cover a user's *thinking* history, not just their
// coding agents. Same normalized output as everything else.

import { contentToParts } from '../lib/text.js';
import { finalizeSession, makeMessage, toEpochMs } from '../lib/normalize.js';

/** ChatGPT: {title, create_time, mapping: {id: {parent, children, message}}} */
export function readChatgptExport(raw, ctx) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const conversations = Array.isArray(data) ? data : [data];
  const out = [];

  for (const convo of conversations) {
    if (!convo?.mapping) continue;

    // Walk the message tree from the root so branching histories read in order.
    const nodes = new Map(Object.entries(convo.mapping));
    const root = [...nodes.values()].find((n) => !n.parent);
    const messages = [];
    const seen = new Set();

    const visit = (node) => {
      if (!node || seen.has(node.id)) return;
      seen.add(node.id);

      const m = node.message;
      if (m && !m.metadata?.is_visually_hidden_from_conversation) {
        const role = m.author?.role;
        if (role === 'user' || role === 'assistant') {
          const { text, tools } = contentToParts(m.content?.parts ?? m.content?.text);
          if (text || tools?.length) {
            messages.push(makeMessage({ role, text, ts: toEpochMs(m.create_time), tools }));
          }
        }
      }
      const children = (node.children || []).map((id) => nodes.get(id)).filter(Boolean);
      // Follow the branch that leads to current_node; otherwise take the first.
      const preferred = convo.current_node ? children.find((c) => isOnPath(c, nodes, convo.current_node)) : null;
      if (children.length === 0) return;
      visit(preferred || children[0]);
      for (const c of children) if (c !== (preferred || children[0])) visit(c);
    };

    visit(root);

    const session = finalizeSession({
      ...ctx,
      nativeId: convo.id || convo.conversation_id || convo.title,
      title: convo.title,
      started: toEpochMs(convo.create_time),
      updated: toEpochMs(convo.update_time),
      messages,
      source: 'file',
    });
    if (session) out.push(session);
  }
  return out;
}

function isOnPath(node, nodes, targetId) {
  // Cheap heuristic: current_node is usually on the last child chain.
  let cur = node;
  let guard = 0;
  while (cur && guard++ < 10000) {
    if (cur.id === targetId) return true;
    const kids = (cur.children || []).map((id) => nodes.get(id)).filter(Boolean);
    if (kids.length === 0) return false;
    cur = kids[kids.length - 1];
  }
  return false;
}

/** Claude web export: one conversation per JSONL line. */
export function readClaudeWebExport(raw, ctx) {
  const out = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let convo;
    try {
      convo = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const messages = [];
    for (const m of convo.chat_messages || convo.messages || []) {
      const { text, tools } = contentToParts(m.content ?? m.text);
      const role = m.sender === 'human' ? 'user' : m.sender === 'assistant' ? 'assistant' : m.role;
      if (!text && !tools?.length) continue;
      messages.push(makeMessage({ role, text, ts: toEpochMs(m.created_at), tools }));
    }
    const session = finalizeSession({
      ...ctx,
      nativeId: convo.uuid || convo.id,
      title: convo.name,
      started: toEpochMs(convo.created_at),
      updated: toEpochMs(convo.updated_at),
      messages,
      source: 'file',
    });
    if (session) out.push(session);
  }
  return out;
}
