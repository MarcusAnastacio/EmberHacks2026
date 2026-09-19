// The digest — what a conversation looks like when it is compressed for a model.
//
// WHY THIS EXISTS
// A real session is far too large to send: measured, the median is ~65k characters
// and the largest is over 2M, while a useful prompt budget is tens of thousands.
// Cutting the tail off does not work either — the payload covers 1.5% of a large
// session, so nothing about how the work ended is answerable. The digest is the
// bounded, ordered representation that replaces raw truncation.
//
// THE ORDERING PRINCIPLE
// The *conversation* is primary and drives everything. Repository material is
// supporting context, and only the parts the conversation actually touched are
// included: files named in tool calls, the subtree containing them, the README,
// the manifest, and the commits made in the session's time window. A repository's
// contents are not interesting in themselves — they are interesting where they
// explain what was discussed.
//
// Everything here is deterministic. No model call, no cost, no hallucination, and
// the output is stable enough to cache and diff.
//
// What is deliberately NOT here:
//   * reasoning / thinking blocks — excluded during parsing, see lib/text.js
//   * tool output bodies — excluded during parsing; only names and arguments remain
//   * whole source files — only documentation and manifests are read, bounded
//
// See docs/quiz-design.md §2 for how this feeds topic segmentation and generation.

import path from 'node:path';
import {
  collectDocs,
  collectManifests,
  commitsInWindow,
  isDirectory,
  isGitRepo,
  lastCommitsFor,
  renderTree,
  repoRoot,
  workingTreeState,
} from './project.js';

// Per-turn budgets. A user turn is the task statement and is worth keeping; an
// assistant turn is mostly narration around a decision and is not.
const USER_TURN_CHARS = 4000;
const ASSISTANT_TURN_CHARS = 700;
const FINAL_ASSISTANT_CHARS = 3000; // the summary at the end is the most quiz-worthy
const CODE_BLOCK_CHARS = 900;
const TOOL_ARG_CHARS = 90;
const COMMAND_CHARS = 120;

// Section budgets, so one large section cannot crowd out the others.
const DEFAULT_BUDGET = {
  header: 900,
  files: 2500,
  commands: 1800,
  project: 7000,
  total: 24000,
};

// ── Extraction from tool calls ─────────────────────────────────────────────

const PATH_KEYS = ['file_path', 'filePath', 'path', 'filename', 'file', 'notebook_path', 'target_file', 'absolute_path'];
const COMMAND_KEYS = ['command', 'cmd', 'script'];
const SEARCH_KEYS = ['pattern', 'query', 'glob', 'regex'];

const WRITE_TOOLS = /write|edit|create|patch|apply|insert|replace|str_replace|notebook_edit|multi_edit/i;
const READ_TOOLS = /read|view|cat|open|show|load|fetch_file/i;
const SEARCH_TOOLS = /grep|search|find|glob|list|ls|ripgrep|semantic/i;
const SHELL_TOOLS = /bash|shell|exec|run|terminal|command|pytest|npm|make|just/i;

/** Read the first string value among candidate keys from a tool input. */
function pick(input, keys) {
  if (!input || typeof input !== 'object') return null;
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/** Normalise a path argument to something repo-relative and comparable. */
function normalizePath(value, cwd) {
  if (!value) return null;
  let p = value.replace(/^["']|["']$/g, '').trim();
  if (!p || p.length > 240 || /[\n\r]/.test(p)) return null;
  if (cwd && p.startsWith(cwd)) p = p.slice(cwd.length);
  p = p.replace(/^\.\//, '').replace(/^\/+/, '');
  // Reject things that are clearly not paths in this repo.
  if (!p || p === '.' || p.startsWith('..')) return null;
  return p;
}

/**
 * What the conversation touched, derived from tool calls.
 *
 * This is the highest-signal clue about what a project *is* in the context of the
 * conversation, which is why it drives the project section rather than a blind
 * repository scan.
 */
export function extractTouched(session) {
  const reads = new Map();
  const writes = new Map();
  const searches = [];
  const commands = [];
  const toolsByName = new Map();

  const cwd = session.cwd || null;

  for (const message of session.messages) {
    for (const tool of message.tools || []) {
      const name = String(tool?.name || 'tool');
      toolsByName.set(name, (toolsByName.get(name) || 0) + 1);
      const input = tool?.input;

      const command = pick(input, COMMAND_KEYS);
      if (command) {
        commands.push({
          tool: name,
          command: command.split('\n')[0].slice(0, COMMAND_CHARS),
        });
      }

      const rawPath = pick(input, PATH_KEYS);
      const filePath = normalizePath(rawPath, cwd);
      if (filePath) {
        const bucket = WRITE_TOOLS.test(name) ? writes : READ_TOOLS.test(name) ? reads : null;
        if (bucket) bucket.set(filePath, (bucket.get(filePath) || 0) + 1);
      }

      const query = pick(input, SEARCH_KEYS);
      if (query && SEARCH_TOOLS.test(name)) {
        searches.push({ tool: name, query: query.slice(0, 80) });
      }
    }
  }

  // Paths mentioned in prose, e.g. "the bug is in app/db.py:41". Secondary source:
  // only accepted with a file extension, and only when it looks like a path.
  const mentioned = new Map();
  const prosePath = /(?:^|[\s`'"(])([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.[A-Za-z0-9]{1,6})(?::\d+)?/g;
  for (const message of session.messages) {
    if (message.role !== 'assistant') continue;
    for (const m of message.text.matchAll(prosePath)) {
      const p = normalizePath(m[1], cwd);
      if (p && !p.startsWith('http')) mentioned.set(p, (mentioned.get(p) || 0) + 1);
    }
  }

  const sortMap = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]);
  const edited = sortMap(writes);
  const read = sortMap(reads);

  // All paths, edited first: these are what the project section focuses on.
  const relevant = [...new Set([...edited.map(([p]) => p), ...read.map(([p]) => p)])];

  return {
    edited,
    read,
    searches: searches.slice(0, 20),
    commands,
    toolsByName: [...toolsByName.entries()].sort((a, b) => b[1] - a[1]),
    mentioned: sortMap(mentioned).slice(0, 25),
    relevant,
  };
}

// ── Conversation rendering ─────────────────────────────────────────────────

/** Split out fenced code blocks, because code is what a cloze question needs. */
function extractCodeBlocks(text) {
  const blocks = [];
  for (const m of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
    const body = m[1].trim();
    if (body && body.length <= CODE_BLOCK_CHARS) blocks.push(body);
  }
  return blocks;
}

function clip(text, max) {
  const clean = text.trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max).trimEnd()}\n… (${clean.length - max} more chars)`;
}

/**
 * Render the conversation as an ordered, indexed digest.
 *
 * Turn indices are the *indices into session.messages*, not a renumbering. That
 * matters: generated questions cite `sourceRefs.messageIndex`, and the app can
 * jump from a question to the exact turn it came from.
 */
function renderConversation(session, { includeCode = true } = {}) {
  const lines = [];
  const lastAssistant = [...session.messages].map((m, i) => (m.role === 'assistant' ? i : -1)).filter((i) => i >= 0).pop();

  session.messages.forEach((message, index) => {
    const stamp = message.ts ? new Date(message.ts).toISOString().slice(11, 16) : '';
    const tools = message.tools || [];

    if (message.role === 'system') return;

    if (message.role === 'user') {
      lines.push(`[turn ${index}] USER ${stamp}`);
      lines.push(indent(clip(message.text, USER_TURN_CHARS)));
      lines.push('');
      return;
    }

    if (message.role === 'tool') return; // bodies are dropped at parse time anyway

    // Assistant
    const toolSummary = tools.length
      ? ` | tools: ${tools
          .map((t) => {
            const arg =
              pick(t?.input, PATH_KEYS) ??
              pick(t?.input, COMMAND_KEYS) ??
              pick(t?.input, SEARCH_KEYS);
            return arg ? `${t.name}(${String(arg).split('\n')[0].slice(0, TOOL_ARG_CHARS)})` : t.name;
          })
          .join(', ')}`
      : '';

    const cap = index === lastAssistant ? FINAL_ASSISTANT_CHARS : ASSISTANT_TURN_CHARS;
    const body = clip(message.text, cap);
    lines.push(`[turn ${index}] ASSISTANT ${stamp}${toolSummary}`);
    lines.push(indent(body));

    if (includeCode) {
      const blocks = extractCodeBlocks(message.text);
      const already = body.includes('```');
      if (blocks.length && !already) {
        lines.push('  code from this turn:');
        for (const block of blocks.slice(0, 2)) lines.push(indent(block, 4));
      }
    }
    lines.push('');
  });

  return lines.join('\n').trim();
}

function indent(text, spaces = 2) {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((l) => (l ? pad + l : l))
    .join('\n');
}

// ── Project context ────────────────────────────────────────────────────────

function renderProject(session, touched, budget) {
  const cwd = session.cwd;
  if (!cwd || !isDirectory(cwd)) {
    return { text: '  (no working directory on record for this session, or it no longer exists)', meta: { available: false } };
  }

  const root = (isGitRepo(cwd) ? repoRoot(cwd) : null) || cwd;
  const out = [];
  const meta = { available: true, root, git: false };

  out.push(`working directory: ${cwd}`);
  if (root !== cwd) out.push(`repository root:   ${root}`);
  out.push('');

  // Ordering is by signal density, not by category. Everything below can be cut
  // from the end when the section exceeds its budget, so the cheapest and most
  // specific facts go first and the bulkiest go last. Git sits high because a
  // commit message somebody wrote in their own words is the best one-line
  // summary of what a session achieved.

  // --- 1. What the conversation touched. The frame for everything below.
  const edited = touched.edited.slice(0, 12);
  const read = touched.read.slice(0, 12);
  if (edited.length) {
    out.push(`files the conversation MODIFIED (${touched.edited.length}):`);
    for (const [file, n] of edited) out.push(`  ${file}${n > 1 ? `  (${n} calls)` : ''}`);
    out.push('');
  }
  if (read.length) {
    out.push(`files the conversation READ (${touched.read.length}):`);
    out.push(`  ${read.map(([f]) => f).join('\n  ')}`);
    out.push('');
  }

  // --- 2. Git, scoped to the session window and to the files that were touched.
  if (isGitRepo(root)) {
    meta.git = true;

    const commits = commitsInWindow(root, { sinceMs: session.started, untilMs: session.updated, limit: 20 });
    if (commits.length) {
      out.push(`commits made during this session (${commits.length}):`);
      for (const c of commits) out.push(`  ${c.sha} ${c.time} ${c.subject}`);
      out.push('');
    }

    const perFile = lastCommitsFor(root, touched.edited.map(([f]) => f).slice(0, 6));
    if (perFile.length) {
      out.push('most recent commit touching a file the conversation modified:');
      for (const { file, commit } of perFile) out.push(`  ${file}: ${commit}`);
      out.push('');
    }

    const state = workingTreeState(root, { limit: 20 });
    if (state && state.dirty) {
      out.push(`uncommitted at last check: ${state.dirty} path(s)${state.unmerged ? `, ${state.unmerged} unmerged` : ''}`);
      for (const f of state.files.slice(0, 12)) out.push(`  ${f}`);
      out.push('');
    }
  }

  // --- 3. Manifests: names, scripts and dependencies reveal the stack in ~20 lines.
  const manifests = collectManifests(root, { limit: 4 });
  if (manifests.length) {
    out.push('project files:');
    for (const { path: p, summary } of manifests) {
      out.push(`  --- ${p} ---`);
      out.push(indent(JSON.stringify(summary), 4));
    }
    out.push('');
  }

  // --- 4. Documentation. Bounded and dense: two excerpts at 1200 chars answer
  //        "what is this project" better than any amount of directory listing.
  //        The per-excerpt allowance is derived from what is actually left in the
  //        section, so a project section that is already tight shortens the
  //        excerpts rather than having them cut mid-sentence from outside.
  const remaining = budget - out.join('\n').length;
  const docAllowance = Math.max(300, Math.min(1200, Math.floor(remaining / 2) - 120));
  const docs = collectDocs(root, { limit: 2, perFile: docAllowance });
  if (docs.length) {
    out.push('documentation (excerpts):');
    for (const doc of docs) {
      out.push(`  --- ${doc.path} ---`);
      out.push(indent(doc.text, 4));
    }
    out.push('');
  }

  // --- 5. Structure last of the substantive sections. A session that touched 176
  //        files produces a tree far too large to be worth its budget, so it is
  //        the thing that gives way when the section is tight — and it is focused
  //        on the top handful of touched paths rather than all of them.
  const focus = touched.relevant.slice(0, 20);
  const tree = renderTree(root, { relevant: focus, maxDepth: 3, maxEntries: 90 });
  if (tree.text) {
    out.push(`structure${tree.capped ? ' (truncated)' : ''}:`);
    out.push(indent(tree.text, 2));
    out.push('');
  }

  // --- 6. Loose signals.
  if (touched.mentioned.length) {
    out.push(`other paths mentioned in prose:`);
    out.push(`  ${touched.mentioned.slice(0, 12).map(([f]) => f).join('\n  ')}`);
    out.push('');
  }
  if (touched.searches.length) {
    out.push(`looked for: ${touched.searches.map((s) => `"${s.query}"`).slice(0, 8).join(', ')}`);
    out.push('');
  }

  let text = out.join('\n');
  if (text.length > budget) {
    meta.truncated = text.length - budget;
    text = `${text.slice(0, budget)}\n… (project context truncated, ${meta.truncated} chars omitted)`;
  }
  return { text, meta };
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Build the digest for one session.
 *
 * @param {object} session  normalized session from the compatibility layer
 * @param {object} [options]
 * @param {boolean} [options.project=true]   include repository context at all
 * @param {boolean} [options.includeCode=true] keep fenced code from assistant turns
 * @param {object}  [options.budget]         override section budgets
 * @returns {{text: string, sections: object, stats: object}}
 */
export function buildDigest(session, options = {}) {
  const { project = true, includeCode = true, budget: budgetOverride } = options;
  const budget = { ...DEFAULT_BUDGET, ...(budgetOverride || {}) };

  const touched = extractTouched(session);

  // --- Header: what this is, and an honest account of what was left out.
  const span = session.updated - session.started;
  const header = [
    `# Session digest`,
    ``,
    `agent:      ${session.harnessName}${session.harness !== session.harnessName ? ` (${session.harness})` : ''}`,
    `project:    ${session.project}`,
    `title:      ${session.title}`,
    `started:    ${new Date(session.started).toISOString()}`,
    `duration:   ${formatDuration(span)}`,
    `turns:      ${session.messages.length} messages (${session.userTurns} user, ${session.messages.length - session.userTurns} assistant)`,
    `tool calls: ${session.toolCalls || 0}${touched.toolsByName.length ? ` — ${touched.toolsByName.slice(0, 8).map(([n, c]) => `${n}×${c}`).join(', ')}` : ''}`,
    `omitted:    ${(session.reasoningChars || 0).toLocaleString('en-US')} chars of model reasoning, and all tool output bodies`,
  ].join('\n');

  // The project section is built FIRST and its budget is reserved, because it is
  // the last thing in the document and a naive total-budget cut would delete it
  // entirely — losing precisely the context that makes the conversation legible.
  //
  // Allocation is then in priority order under one hard ceiling: header, then
  // project (capped at half the remainder so it can never crowd out the
  // conversation), then whatever is left for the conversation. A flat floor on the
  // conversation budget would silently exceed a small total.
  const FIXED_OVERHEAD = 400; // headings and the explanatory paragraph
  const reserved = header.length + FIXED_OVERHEAD;
  const available = Math.max(400, budget.total - reserved);
  const projectCap = project ? Math.min(budget.project, Math.max(200, Math.floor(available * 0.5))) : 0;

  const projectSection = project
    ? renderProject(session, touched, projectCap)
    : { text: '', meta: { available: false, disabled: true } };

  const conversationBudget = Math.max(
    200,
    budget.total - reserved - projectSection.text.length,
  );

  const rawConversation = renderConversation(session, { includeCode });
  const conversation = clipMiddle(rawConversation, conversationBudget);

  const text = [
    clip(header, budget.header),
    '',
    '## Conversation',
    '',
    conversation,
    '',
    '## Project context',
    '',
    'The conversation above is the primary source. Everything below is supporting',
    'material, filtered to what the conversation actually touched.',
    '',
    projectSection.text,
  ].join('\n');

  const conversationOmitted = Math.max(0, rawConversation.length - conversation.length);

  return {
    text,
    sections: {
      header: header.length,
      conversation: conversation.length,
      conversationRaw: rawConversation.length,
      conversationOmitted,
      project: projectSection.text.length,
      conversationShare: +(conversation.length / Math.max(1, text.length)).toFixed(3),
    },
    stats: {
      chars: text.length,
      truncated: conversationOmitted + (projectSection.meta.truncated || 0),
      budget: budget.total,
      touchedEdited: touched.edited.length,
      touchedRead: touched.read.length,
      toolCalls: session.toolCalls || 0,
      reasoningOmitted: session.reasoningChars || 0,
      projectAvailable: projectSection.meta.available,
      git: Boolean(projectSection.meta.git),
      projectTruncated: projectSection.meta.truncated || 0,
    },
  };
}

/**
 * Keep the head and the tail, drop the middle.
 *
 * The two most quiz-worthy parts of a session are the opening (what was asked)
 * and the ending (what was concluded and changed). A tail cut loses the second;
 * a head cut loses the first. Dropping the middle keeps both and is where the
 * repetitive tool-driven churn tends to sit anyway.
 */
function clipMiddle(text, maxChars, { headShare = 0.62 } = {}) {
  if (text.length <= maxChars) return text;
  const marker = (n) => `\n\n… (${n} chars of the middle of this conversation omitted) …\n\n`;
  // Reserve a fixed allowance for the marker rather than measuring it, which
  // would be circular: the marker's length depends on the omitted count, which
  // depends on what is left after the marker. 64 chars covers counts to 7 digits,
  // well past any real session.
  const MARKER_ROOM = 64;
  const room = Math.max(0, maxChars - MARKER_ROOM);
  const head = Math.floor(room * headShare);
  const tail = room - head;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head).trimEnd()}${marker(omitted)}${text.slice(text.length - tail).trimStart()}`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'unknown';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/** Convenience: is a digest small enough to be worth sending as one request? */
export function digestFits(digest, maxChars = 30000) {
  return digest.stats.chars <= maxChars;
}
