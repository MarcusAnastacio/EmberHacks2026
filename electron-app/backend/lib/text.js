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
 * Extract text + tool calls from a content value.
 * Returns { text, tools: [{ name, input }] }.
 */
export function contentToParts(content) {
  const text = [];
  const tools = [];

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

    const kind = typeof node.type === 'string' ? node.type : '';

    if (kind === 'tool_use' || kind === 'tool_call' || kind === 'function_call') {
      tools.push({
        name: node.name || node.toolName || node.function?.name || 'tool',
        input: node.input ?? node.arguments ?? node.function?.arguments ?? null,
      });
      return;
    }
    if (kind === 'tool_result' || kind === 'tool_response' || kind === 'function_call_output') {
      // Tool output is noise for quiz generation; keep it out of the transcript.
      return;
    }
    if (kind === 'thinking' || kind === 'redacted_thinking' || kind === 'reasoning') {
      const t = node.thinking || node.text || node.summary;
      if (typeof t === 'string' && t) text.push(t);
      else walk(node.summary);
      return;
    }
    if (kind === 'text' || kind === 'input_text' || kind === 'output_text') {
      if (typeof node.text === 'string') text.push(node.text);
      return;
    }
    if (kind === 'image' || kind === 'input_image' || kind === 'document') return;

    // Un-typed object: descend into the usual containers.
    if (node.content !== undefined) walk(node.content);
    else if (node.text !== undefined) walk(node.text);
    else if (node.parts !== undefined) walk(node.parts);
    else if (node.message !== undefined) walk(node.message);
  };

  walk(content);
  return { text: text.join('\n').trim(), tools };
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
