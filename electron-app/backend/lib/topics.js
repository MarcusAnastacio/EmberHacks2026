// Deterministic topic segmentation.
//
// WHY DETERMINISTIC
// The obvious design gives the digest to a model and asks it to divide the session
// into topics. That works, but it costs a call, it is not reproducible, and it
// makes the segmentation step — the one that decides what every later prompt
// contains — unverifiable. Everything needed is already in the session:
//
//   * a user turn IS a topic statement, in the user's own words. Nothing a model
//     writes will be a better label for "why is the connection pool exhausted".
//   * a change in the set of files being touched is a topic change.
//   * a drop in word overlap between one user turn and the next is a topic change.
//   * a long pause is usually a topic change. So is "now let's…".
//
// So segmentation and labelling are both computed here, and the only model call in
// the pipeline is question generation, which is already scoped to one topic slice.
// That is what removes the last unbounded prompt: each generation prompt is
// `topicSlice()` output, capped, and the number of prompts is bounded by the
// number of topics.
//
// Nothing in this file consults a model, the network, or any file on disk.

import { renderTurnRange, lastAssistantIndex } from './digest.js';

// Words that carry no topic signal.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'you', 'can', 'not', 'but', 'this', 'that', 'with', 'have',
  'from', 'what', 'when', 'how', 'why', 'does', 'did', 'was', 'were', 'are', 'is',
  'its', 'it', 'a', 'an', 'in', 'on', 'of', 'to', 'be', 'do', 'so', 'if', 'my',
  'me', 'we', 'us', 'i', 'please', 'thanks', 'thank', 'also', 'just', 'now',
  'then', 'there', 'here', 'get', 'got', 'let', 'make', 'made', 'need', 'want',
  'like', 'would', 'should', 'could', 'will', 'about', 'into', 'out', 'up', 'down',
  'all', 'some', 'any', 'one', 'two', 'more', 'most', 'very', 'really', 'still',
]);

/** Opening phrases that usually mean the user has moved on. */
const TRANSITION_RE = /\b(now|next|then|another|different|instead|separately|unrelated|moving on|second|third|also|on top of that|while you're at it|one more)\b/i;

/** Token set for lexical-overlap comparison. */
function tokenize(text) {
  const out = new Set();
  for (const raw of String(text || '').toLowerCase().split(/[^a-z0-9_.-]+/)) {
    const t = raw.replace(/^[._-]+|[._-]+$/g, '');
    if (t.length < 3 || STOPWORDS.has(t)) continue;
    out.add(t);
  }
  return out;
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const v of a) if (b.has(v)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Split a session into turns, each exchange being one user turn plus everything up
 * to the next user turn. Agent transcripts are naturally structured this way, and a
 * boundary can only fall on a user turn — an assistant turn mid-flow never starts
 * a new topic.
 */
function toExchanges(session) {
  const messages = session.messages;
  const userIndices = [];
  messages.forEach((m, i) => {
    if (m.role === 'user') userIndices.push(i);
  });

  return userIndices.map((start, n) => {
    const next = userIndices[n + 1];
    const end = next === undefined ? messages.length - 1 : next - 1;
    const slice = messages.slice(start, end + 1);

    const files = new Set();
    const tools = new Map();
    let chars = 0;
    for (const m of slice) {
      chars += m.text.length;
      for (const t of m.tools || []) {
        const name = String(t?.name || 'tool');
        tools.set(name, (tools.get(name) || 0) + 1);
        for (const key of ['file_path', 'filePath', 'path', 'filename', 'file', 'notebook_path', 'target_file']) {
          const v = t?.input?.[key];
          if (typeof v === 'string' && v) files.add(v.replace(/^\.\//, ''));
        }
      }
    }

    const userText = messages[start].text;
    return {
      start,
      end,
      userText,
      tokens: tokenize(userText),
      files,
      tools,
      chars,
      ts: messages[start].ts,
      endedAt: messages[end]?.ts,
    };
  });
}

/** Boundary score between two consecutive exchanges. Higher means more likely a cut. */
function boundaryScore(prev, next) {
  let score = 0;

  // A change in the files being worked on is the strongest signal available.
  if (prev.files.size && next.files.size) {
    score += (1 - jaccard(prev.files, next.files)) * 3;
  }

  // A drop in word overlap means the user moved on to a different subject.
  score += (1 - jaccard(prev.tokens, next.tokens)) * 2;

  // Pauses. A deliberate gap is usually a new intent, not a continuation.
  const gapMin = prev.endedAt && next.ts ? (next.ts - prev.endedAt) / 60000 : 0;
  if (gapMin > 120) score += 3;
  else if (gapMin > 30) score += 1.5;

  // Explicit "now let's…" style markers.
  if (TRANSITION_RE.test(next.userText.slice(0, 120))) score += 1;

  // Very short turns that are pure follow-ups ("ok", "yes") do not start topics.
  if (next.userText.trim().length < 24) score -= 2;

  return score;
}

/**
 * Derive topics for a session.
 *
 * Two things matter, and they pull in different directions:
 *   * cut where the conversation actually changes subject (semantic)
 *   * make every topic fit one generation prompt (structural)
 *
 * A purely semantic segmentation of a long session produces a few enormous topics
 * and several tiny ones, and an enormous topic is no better than no segmentation:
 * its slice gets truncated and 98% of it is never seen. So semantic cuts are made
 * first, then oversized segments are split at their best internal boundary, then
 * the result is merged down if it exceeded the topic cap.
 *
 * @param {object} session
 * @param {object} [options]
 * @param {number} [options.threshold=3.2]      boundary score needed to cut
 * @param {number} [options.maxTopics=14]        hard cap on topics
 * @param {number} [options.maxSegmentChars=45000] target ceiling per topic
 * @param {number} [options.minSegmentChars=600]   figures below this get merged away,
 *                                                  unless a strong cut precedes them
 * @param {string} [options.labelChars=90]
 */
export function deriveTopics(session, options = {}) {
  const {
    threshold = 3.2,
    maxTopics = 14,
    maxSegmentChars = 30000,
    minSegmentChars = 600,
    labelChars = 90,
  } = options;

  const exchanges = toExchanges(session);
  if (exchanges.length === 0) {
    return { topics: [], boundaries: [], stats: { exchanges: 0, topics: 0, strategy: 'empty' } };
  }

  // Score every candidate boundary. `scoreAfter[i]` is the score of the boundary
  // that follows exchange i, i.e. between exchange i and i+1.
  const scoreAfter = new Array(exchanges.length - 1);
  for (let i = 0; i < exchanges.length - 1; i++) {
    scoreAfter[i] = boundaryScore(exchanges[i], exchanges[i + 1]);
  }

  const buildSegments = (cutSet) => {
    const segments = [];
    let start = 0;
    for (let i = 0; i < exchanges.length; i++) {
      const isLast = i === exchanges.length - 1;
      if (isLast || cutSet.has(i)) {
        const group = exchanges.slice(start, i + 1);
        segments.push({
          startExchange: start,
          endExchange: i,
          exchanges: group,
          chars: group.reduce((n, e) => n + e.chars, 0),
        });
        start = i + 1;
      }
    }
    return segments;
  };

  // --- 1. Semantic cuts. ---
  const cuts = new Set();
  for (let i = 0; i < scoreAfter.length; i++) {
    if (scoreAfter[i] >= threshold) cuts.add(i);
  }

  // --- 2. Split oversized segments at their strongest internal boundary, up to a
  //        candidate pool a few times larger than the topic cap. Splitting first
  //        means the ranking below chooses among reasonably sized topics rather
  //        than among a few giants that would each be truncated. The pool is much
  //        larger than the cap because a bigger pool gives the ranking more to
  //        choose from; only maxTopics are ever returned.
  const candidateLimit = Math.max(maxTopics, maxTopics * 12);
  let segments = buildSegments(cuts);
  let splitIterations = 0;
  while (segments.length < candidateLimit && splitIterations++ < candidateLimit * 4) {
    const oversized = segments
      .filter((s) => s.exchanges.length > 1 && s.chars > maxSegmentChars)
      .sort((a, b) => b.chars - a.chars)[0];
    if (!oversized) break;

    let best = null;
    for (let i = oversized.startExchange; i < oversized.endExchange; i++) {
      const score = scoreAfter[i] ?? 0;
      if (!best || score > best.score) best = { at: i, score };
    }
    if (!best) break;
    cuts.add(best.at);
    segments = buildSegments(cuts);
  }

  // --- 3. Rank and select. When there are more topics than the cap allows, the
  //        ones to keep are the ones a quiz would get the most out of — not an
  //        arbitrary merge of adjacent segments, which produced topics of 736k
  //        against a 130k median and then truncated most of what it kept.
  //
  //        Coverage is reported rather than pretended: a 2.4M-character session
  //        genuinely cannot be fully represented by fourteen bounded prompts, so
  //        the caller can see what was left out and raise the cap if it wants.
  const ranked = segments.map((segment) => ({ segment, score: interestingness(segment, session) }));
  const selected = [...ranked].sort((a, b) => b.score - a.score).slice(0, maxTopics);
  const dropped = ranked.filter((r) => !selected.includes(r));

  // Chronological order, because the slices are read in sequence.
  const ordered = selected.sort((a, b) => a.segment.startExchange - b.segment.startExchange);

  // --- 4. Absorb segments too small to be worth a prompt of their own — but only
  //        when the boundary in front of them was weak. A short segment that
  //        follows a STRONG cut is a genuinely separate subject the user changed
  //        to ("separately, the cache is stale…"), and folding it away because it
  //        happens to be brief loses exactly the kind of distinct topic that
  //        makes a quiz interesting.
  const merged = [];
  for (const entry of ordered) {
    const prev = merged[merged.length - 1];
    const boundaryBefore = scoreAfter[entry.segment.startExchange - 1] ?? 0;
    const weaklySeparated = boundaryBefore < threshold;
    if (prev && weaklySeparated && entry.segment.chars < minSegmentChars) {
      prev.exchanges = [...prev.exchanges, ...entry.segment.exchanges];
      prev.chars += entry.segment.chars;
      prev.endExchange = entry.segment.endExchange;
      prev.folded = [...(prev.folded || []), entry.segment];
      continue;
    }
    merged.push({ ...entry.segment });
  }

  // --- 5. Label each topic from its opening user turn.
  const topics = [];
  for (const segment of merged) {
    const first = segment.exchanges[0];
    const last = segment.exchanges[segment.exchanges.length - 1];
    const files = [...new Set(segment.exchanges.flatMap((e) => [...e.files]))];
    const tools = new Map();
    for (const e of segment.exchanges) for (const [n, c] of e.tools) tools.set(n, (tools.get(n) || 0) + c);

    topics.push({
      id: `t${topics.length + 1}`,
      label: labelFrom(first.userText, labelChars),
      // The opening user turn, verbatim to a useful length. This is the topic
      // statement and needs no model to write.
      summary: clip(first.userText, 400),
      messageRanges: [[first.start, last.end]],
      from: first.start,
      to: last.end,
      exchanges: segment.exchanges.length,
      userTurns: segment.exchanges.map((e) => e.userText.trim()).filter(Boolean),
      files,
      tools: [...tools.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
      chars: segment.chars,
      score: +(ranked.find((r) => r.segment === segment)?.score ?? interestingness(segment, session)).toFixed(2),
      foldedCount: segment.folded?.length || 0,
      startedAt: first.ts,
      endedAt: last.endedAt,
    });
  }

  const sizes = topics.map((t) => t.chars).sort((a, b) => a - b);
  const median = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0;
  const covered = topics.reduce((n, t) => n + t.chars, 0);

  return {
    topics,
    boundaries: scoreAfter.map((score, i) => ({
      afterExchange: i,
      score: +score.toFixed(2),
      cut: cuts.has(i),
    })),
    stats: {
      exchanges: exchanges.length,
      topics: topics.length,
      candidates: ranked.length,
      strategy: 'deterministic: file-change + lexical-overlap + pause + transition markers; size-split; ranked by quiz value',
      threshold,
      largestTopic: sizes.length ? sizes[sizes.length - 1] : 0,
      medianTopic: median,
      smallestTopic: sizes.length ? sizes[0] : 0,
      // How much of the session the selected topics account for. Honest reporting
      // rather than pretending everything fits.
      coverage: +(covered / Math.max(1, session.chars)).toFixed(3),
      droppedTopics: dropped.length,
      droppedChars: dropped.reduce((n, r) => n + r.segment.chars, 0),
    },
  };
}

/**
 * Deterministic "how much would a quiz get out of this topic" score.
 *
 * Everything here is derivable from the session, so ranking is reproducible and
 * no model is consulted. The weights encode one judgement: a topic where files
 * were actually changed and code was written is more worth asking about than a
 * topic that is mostly conversation about plans.
 */
function interestingness(segment, session) {
  let score = 0;

  // Files edited, not merely read. Strongest signal that something happened.
  const edited = new Set();
  let wrote = 0;
  for (const e of segment.exchanges) for (const [name, count] of e.tools) {
    for (const file of e.files) edited.add(file);
    if (/write|edit|create|patch|apply|insert|replace/i.test(name)) wrote += count;
  }
  score += Math.min(6, wrote) * 2;
  score += Math.min(10, edited.size) * 0.6;

  // Substantive back-and-forth, with diminishing returns: one long exchange is
  // not worth three times a topic with three exchanges.
  score += Math.log2(1 + segment.exchanges.length) * 1.2;
  score += Math.min(6, segment.exchanges.filter((e) => e.userText.trim().length > 80).length) * 0.5;

  // Code in either direction is what fill-in-the-blank questions need.
  let codeBlocks = 0;
  let errorMentions = 0;
  for (const e of segment.exchanges) {
    for (let i = e.start; i <= e.end && i < session.messages.length; i++) {
      const text = session.messages[i].text;
      codeBlocks += (text.match(/```/g) || []).length / 2;
      errorMentions += (text.match(/\b(error|exception|failed|failure|traceback|stack trace|bug|doesn't work|not working)\b/gi) || []).length;
    }
  }
  score += Math.min(5, codeBlocks) * 1.1;
  score += Math.min(8, errorMentions) * 0.45;

  // Size, logarithmically: a very large topic is usually more substantial, but it
  // must not dominate the ranking on length alone.
  score += Math.log2(1 + segment.chars / 1000) * 0.8;

  return score;
}

/**
 * A topic label taken from the opening user turn, trimmed at a word boundary.
 * A user turn is the best available description of what the topic is.
 */
function labelFrom(text, max) {
  const clean = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return 'untitled topic';
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.5 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function clip(text, max) {
  const clean = String(text || '').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max).trimEnd()}…`;
}

/**
 * The bounded prompt body for one topic — this is Stage C's input, and it is the
 * only thing in the pipeline that grows with the session, so it is capped here.
 *
 * Includes the topic's own turns in full-ish, plus the preceding topic's last
 * assistant turn as context ("this follows on from…").
 */
export function topicSlice(session, topic, options = {}) {
  const { maxChars = 12000, includeCode = true, contextTurns = 1 } = options;

  const from = Math.max(0, topic.from - (topic.from > 0 ? 1 : 0));
  const body = renderTurnRange(session, {
    from,
    to: topic.to,
    includeCode,
    finalIndex: lastAssistantIndex(session, topic.from, topic.to),
  });

  let text = body;
  let truncated = 0;
  if (text.length > maxChars) {
    truncated = text.length - maxChars;
    text = `${text.slice(0, maxChars)}\n… (${truncated} chars of this topic omitted)`;
  }

  return {
    topicId: topic.id,
    label: topic.label,
    text,
    chars: text.length,
    truncated,
    messageRanges: topic.messageRanges,
    files: topic.files,
    tools: topic.tools,
  };
}

/** All topic slices for a session, each capped. Stage C's full input set. */
export function topicSlices(session, options = {}) {
  const { maxChars = 12000 } = options;
  const { topics, stats } = deriveTopics(session, options);
  const slices = topics.map((t) => topicSlice(session, t, { ...options, maxChars }));
  return {
    topics,
    slices,
    stats: {
      ...stats,
      sliceChars: slices.reduce((n, s) => n + s.chars, 0),
      largestSlice: slices.reduce((n, s) => Math.max(n, s.chars), 0),
      // The bound that matters: no single prompt can exceed maxChars, and the
      // total is topics × maxChars rather than the size of the session.
      maxCharsPerPrompt: maxChars,
      promptCount: slices.length,
    },
  };
}
