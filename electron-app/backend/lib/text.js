// Message content extraction.
//
// Every agent invents its own message shape. These helpers collapse the common
// ones into plain text plus an optional tool-call list.
//
// Shapes seen in the wild:
//   "just a string"
//   [{ type: "text", text: "..." }]                        Claude / Anthropic
//   [{ type: "thinking", thinking: "..." }]                Claude
//   [{ type: "tool_use", name, input }]                    Claude
//   [{ type: "tool_result", content }]                     Claude
//   [{ type: "input_text"|"output_text", text }]           Codex / OpenAI
//   [{ type: "text", text }]                               pi
//   { parts: [{ text }] }                                  Gemini

/** Recursively pull readable text out of any node. */
function collectText(node, acc) {
  if (node == null) return acc;
  if (typeof node === 'string') {
    if (node) acc.push(node);
    return acc;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectText(item, acc);
    return acc;
  }
  if (typeof node !== 'object') return acc;

  // Ordered by likelihood; the first hit wins for a given node.
  for (const key of ['text', 'value', 'content', 'output', 'thinking', 'reasoning', 'parts', 'message']) {
    if (typeof node[key] === 'string' && node[key]) {
      acc.push(node[key]);
      return acc;
    }
  }
  if (typeof node.content === 'object' || Array.isArray(node.content)) {
    return collectText(node.content, acc);
  }
  return acc;
}

/** Flatten any content value to a single string. */
export function contentToText(content) {
  if (typeof content === 'string') return content;
  const acc = [];
  collectText(content, acc);
  return acc.join('\n').trim();
}

/**
 * Compare content-block kinds across agents.
 *
 * Every agent spells these differently — pi writes `toolCall`, Anthropic writes
 * `tool_use`, OpenAI writes `function_call`, Gemini writes `functionCall`. Exact
 * string matching silently dropped every pi tool call, which cost the tool names
 * and file paths that the digest's project context is built from. Normalising to
 * lowercase with separators removed makes the check variant-agnostic.
 */
function normKind(kind) {
  return typeof kind === 'string' ? kind.toLowerCase().replace(/[-_\s]/g, '') : '';
}

const TOOL_CALL_KINDS = new Set(['tooluse', 'toolcall', 'functioncall', 'toolinvocation']);
const TOOL_RESULT_KINDS = new Set(['toolresult', 'toolresponse', 'functioncalloutput', 'tooloutput']);
const THINKING_KINDS = new Set(['thinking', 'redactedthinking', 'reasoning', 'reasoningsummary', 'think']);
const TEXT_KINDS = new Set(['text', 'inputtext', 'outputtext', 'plaintext']);
const SKIP_KINDS = new Set(['image', 'inputimage', 'document', 'audiospeech', 'inputaudio']);

export function contentToParts(content, { includeThinking = false } = {}) {
  const text = [];
  const tools = [];
  let thinkingChars = 0;

  const walk = (node) => {
    if (node == null) return;
    if (typeof node === 'string') {
      if (node) text.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node !== 'object') return;

    const kind = normKind(node.type || node.kind);

    // Gemini marks reasoning with a flag on a part that otherwise has no `type`
    // at all (`{ text, thought: true }`). It has to be caught before the kind
    // dispatch, because an untyped node with a `text` field is otherwise treated
    // as ordinary text. Checked early for exactly the same reason as the rest of
    // the reasoning handling: nothing may bypass the exclusion.
    if (node.thought === true || node.isThought === true) {
      if (typeof node.text === 'string') {
        thinkingChars += node.text.length;
        if (includeThinking) text.push(node.text);
      }
      return;
    }

    if (TOOL_CALL_KINDS.has(kind)) {
      tools.push({
        name: node.name || node.toolName || node.tool_name || node.function?.name || 'tool',
        input: node.input ?? node.arguments ?? node.args ?? node.function?.arguments ?? null,
      });
      return;
    }
    if (TOOL_RESULT_KINDS.has(kind)) {
      // Tool output is noise for quiz generation; keep it out of the transcript.
      return;
    }
    if (THINKING_KINDS.has(kind)) {
      const t = node.thinking ?? node.text ?? node.summary ?? node.reasoning;
      let chunk = '';
      if (typeof t === 'string') chunk = t;
      else if (t !== undefined) {
        const acc = [];
        collectText(t, acc);
        chunk = acc.join('\n');
      }
      thinkingChars += chunk.length;
      if (includeThinking && chunk) text.push(chunk);
      return;
    }
    if (TEXT_KINDS.has(kind)) {
      if (typeof node.text === 'string') text.push(node.text);
      return;
    }
    if (SKIP_KINDS.has(kind)) return;

    // Un-typed object: descend into the usual containers.
    if (node.content !== undefined) walk(node.content);
    else if (node.text !== undefined) walk(node.text);
    else if (node.parts !== undefined) walk(node.parts);
    else if (node.message !== undefined) walk(node.message);
  };

  walk(content);
  return { text: text.join('\n').trim(), tools, thinkingChars };
}

/** First non-empty line, trimmed and bounded — a display title. */
export function deriveTitle(text, max = 72) {
  const firstLine = String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('```'));
  if (!firstLine) return '';
  const clean = firstLine.replace(/^[#>\-*\s]+/, '').replace(/\s+/g, ' ');
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
