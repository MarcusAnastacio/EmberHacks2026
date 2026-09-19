// Aider's project-local transcript: `.aider.chat.history.md`
//
// The prefix scheme is counter-intuitive and easy to get backwards, so it is taken
// from aider's own writer (aider/io.py: `prefix = "####"` applied to the user's
// input) rather than guessed:
//
//   # aider chat started at 2026-07-17 09:00:00      session banner
//   #### what the user typed                          USER  (every line of a
//   #### continued multi-line input                   multi-line input is prefixed)
//   > tool / system output                            not conversation, ignored
//   raw markdown                                      ASSISTANT
//
// An earlier version treated `#### ` as assistant text, which silently discarded
// every user turn in every aider session — leaving the assistant answering questions
// that were not there.
//
// Two more details that matter:
//   * consecutive `#### ` lines are ONE user turn, because aider prefixes each line
//     of a multi-line input separately;
//   * text before the first `#### ` is the banner and is not speech, and fenced code
//     blocks may legitimately contain any of these prefixes.

import { finalizeSession, makeMessage, toEpochMs } from '../lib/normalize.js';

const SESSION_MARK = /^#\s*aider chat started at\s*(.+)$/i;

export function readMarkdown(raw, ctx) {
  const lines = String(raw).split('\n');
  const messages = [];
  let started;
  let role = null; // 'user' | 'assistant' | null
  let buf = [];
  let inFence = false;
  let sawUserTurn = false;

  const flush = () => {
    const text = buf.join('\n').trim();
    buf = [];
    // Assistant output before the first user turn is the banner, not conversation.
    if (text && (role === 'user' || (role === 'assistant' && sawUserTurn))) {
      messages.push(makeMessage({ role, text }));
    }
    role = null;
  };

  for (const line of lines) {
    // A fence toggles verbatim mode: anything that looks like a prefix inside a
    // code block is code, not structure.
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      if (role !== 'assistant') {
        flush();
        role = 'assistant';
      }
      buf.push(line);
      continue;
    }

    if (!inFence) {
      const header = SESSION_MARK.exec(line);
      if (header) {
        started = toEpochMs(header[1].trim().replace(' ', 'T'));
        continue;
      }

      if (/^####(\s|$)/.test(line)) {
        if (role !== 'user') {
          flush();
          role = 'user';
        }
        buf.push(line.replace(/^####\s?/, ''));
        sawUserTurn = true;
        continue;
      }

      // aider marks its own tool and system output with "> ". It is not speech.
      if (/^>(\s|$)/.test(line)) {
        if (role === 'assistant') flush();
        continue;
      }
    }

    if (role !== 'assistant') {
      flush();
      role = 'assistant';
    }
    buf.push(line);
  }
  flush();

  if (messages.length === 0) return null;
  return finalizeSession({ ...ctx, messages, started, source: 'file' });
}
