// Aider's project-local transcript: `.aider.chat.history.md`
//
// Shape:
//   # aider chat started at 2024-05-01 20:41:33
//   > /add foo.py
//   > fix the bug          <- consecutive "> " lines are one user turn
//   #### Here is the fix   <- everything else is assistant output
//   Tokens: 1.2k sent, 300 received.     <- dropped

import { finalizeSession, makeMessage, toEpochMs } from '../lib/normalize.js';

const NOISE = [
  /^#\s*aider chat started at\s*(.*)$/i,
  /^Tokens:.*$/i,
  /^Cost:.*$/i,
  /^aider>/i,
  /^Applied edit to .*$/i,
  /^Commit .*$/i,
];

export function readMarkdown(raw, ctx) {
  const lines = raw.split('\n');
  const messages = [];
  let started;
  let userBuf = [];
  let assistantBuf = [];

  const flushUser = () => {
    const text = userBuf.join('\n').trim();
    userBuf = [];
    if (text) messages.push(makeMessage({ role: 'user', text }));
  };
  const flushAssistant = () => {
    const text = assistantBuf.join('\n').trim();
    assistantBuf = [];
    if (text) messages.push(makeMessage({ role: 'assistant', text }));
  };

  for (const line of lines) {
    const header = /^#\s*aider chat started at\s*(.+)$/i.exec(line);
    if (header) {
      started = toEpochMs(header[1].trim().replace(' ', 'T'));
      continue;
    }
    if (NOISE.some((re) => re.test(line))) continue;

    if (line.startsWith('> ') || line === '>') {
      // A user block can only start once the previous assistant block closed.
      if (assistantBuf.length) flushAssistant();
      userBuf.push(line.slice(2));
      continue;
    }
    if (userBuf.length) flushUser();
    assistantBuf.push(line);
  }
  flushUser();
  flushAssistant();

  if (!messages.length) return null;
  return finalizeSession({ ...ctx, messages, started, source: 'file' });
}
