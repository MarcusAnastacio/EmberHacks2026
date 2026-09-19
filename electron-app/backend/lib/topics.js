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


/** Epoch ms of a message, used when a segment has no exchange to read it from. */
function messages_ts(session, index) {
  return session.messages[index]?.ts;
}

/** Per-message features for a range, used when a segment is split below the exchange level. */
function messageFeatures(session, from, to) {
  const files = new Set();
  const tools = new Map();
  let chars = 0;
  for (let i = from; i <= to && i < session.messages.length; i++) {
    const m = session.messages[i];
    if (!m) continue;
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
  return { files: [...files], tools, chars };
}

/**
 * Split a segment that is still too large, at the finest granularity available.
 *
 * Exchange-level splitting cannot touch a single-exchange segment, and a long agent run
 * after one short prompt is exactly that: measured on a real history, the largest topics
 * that exceeded the size target were 3-9 exchanges with one large message each, plus two
 * that were a single exchange containing one 52k-character assistant message.
 *
 * So this cuts at MESSAGE boundaries, and when a single message is itself over the
 * target it cuts inside that message with a character range. Both are needed: the first
 * fixes the multi-message cases (most of them), the second is the only thing that can
 * address a message that is an essay by itself.
 *
 * The segment is a size fallback, not a semantic one, so `agentLabel` marks a topic whose
 * label had to come from the assistant rather than from the user's own words.
 */
function splitBySize(segment, session, targetChars, maxPieces = 40) {
  if (segment.chars <= targetChars) return [segment];

  const messages = session.messages;
  const firstIndex = segment.exchanges ? segment.exchanges[0].start : segment.from;
  const lastIndex = segment.exchanges ? segment.exchanges[segment.exchanges.length - 1].end : segment.to;
  const pieces = [];

  let cursor = firstIndex;
  while (cursor <= lastIndex && pieces.length < maxPieces) {
    let end = cursor;
    let chars = 0;
    // A message too large to fit on its own is subdivided by character range below.
    while (end <= lastIndex) {
      const next = messages[end]?.text.length || 0;
      if (chars > 0 && chars + next > targetChars) break;
      chars += next;
      end++;
    }
    const blockEnd = Math.max(cursor, end - 1);

    if (chars > targetChars) {
      // One message, larger than a whole topic should be: cut it into character ranges
      // at line boundaries so the pieces read as coherent text rather than mid-sentence.
      const text = messages[cursor].text;
      let offset = 0;
      while (offset < text.length && pieces.length < maxPieces) {
        let take = Math.min(targetChars, text.length - offset);
        if (offset + take < text.length) {
          const nl = text.lastIndexOf('\n', offset + take);
          const sentence = text.lastIndexOf('. ', offset + take);
          const cut = Math.max(nl, sentence);
          if (cut > offset + targetChars * 0.5) take = cut - offset + 1;
        }
        // The piece's own size, not the whole message's: passing `chars` here made
        // every piece report the full message length.
        pieces.push(makePiece(session, cursor, cursor, take, offset, offset + take));
        offset += take;
      }
    } else {
      pieces.push(makePiece(session, cursor, blockEnd, chars));
    }
    cursor = blockEnd + 1;
  }

  return pieces;
}

/** Build a segment-shaped object for a message range, optionally with a char window. */
function makePiece(session, from, to, chars, charFrom, charTo) {
  const features = messageFeatures(session, from, to);
  return {
    startExchange: from,
    endExchange: to,
    exchanges: [],
    from,
    to,
    chars,
    charFrom,
    charTo,
    files: features.files,
    tools: features.tools,
    subSplit: true,
  };
}

/** A label for a piece that has no opening user turn of its own. */
function agentLabelFrom(session, from, charFrom) {
  const raw = session.messages[from]?.text || '';
  const text = charFrom ? raw.slice(charFrom) : raw;
  const firstBlock = text.split(/\n\s*\n/).find((b) => b.trim().length > 20) || text;
  const clean = firstBlock
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*_`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return `continued (turn ${from + 1})`;

  // Strip narration addressed to nobody before taking a sentence. The assistant often
  // opens with "The user wants me to …", which says nothing about the subject, and a
  // quiz topic called that is worse than no label at all.
  const stripped = clean
    .replace(/^(?:ok(?:ay)?[,.]?\s*)?(?:the user|they|the assistant)\s+(?:wants?|asked?|is|has|says?|would like|needs?)\s+(?:me\s+)?(?:to\s+)?/i, '')
    .replace(/^(?:now|next|then|so|alright|right)[,:]?\s+/i, '')
    .trim();

  const source = stripped.length > 20 ? stripped : clean;
  const sentence = /^(.{20,110}?[.!?])(\s|$)/.exec(source);
  const label = (sentence ? sentence[1] : source).slice(0, 100).trim();
  return label || `continued (turn ${from + 1})`;
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

  // --- 3. Anything still over the target is split at message boundaries, and within
  //        a single oversized message if that is all there is. Exchange-level
  //        splitting above cannot touch a single-exchange segment, which is exactly
  //        the shape of a long agent run after one short prompt.
  const sized = [];
  for (const segment of segments) sized.push(...splitBySize(segment, session, maxSegmentChars));
  if (sized.length !== segments.length || sized.some((s) => s.subSplit)) segments = sized;

  // --- 4. Rank and select. When there are more topics than the cap allows, the
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

  // Chronological order, because the slices are read in sequence. The character offset
  // is the tiebreaker: every piece cut from one message shares that message's index, so
  // without it the pieces of a single long message came out shuffled.
  const ordered = selected.sort(
    (a, b) =>
      a.segment.startExchange - b.segment.startExchange ||
      (a.segment.charFrom ?? -1) - (b.segment.charFrom ?? -1),
  );

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
    // Folding is for tidying up fragments, so it must not undo the size split by
    // pushing the neighbour over the target.
    const wouldFit = prev && prev.chars + entry.segment.chars <= maxSegmentChars;
    if (prev && weaklySeparated && wouldFit && entry.segment.chars < minSegmentChars) {
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
    const subSplit = Boolean(segment.subSplit);
    const from = subSplit ? segment.from : segment.exchanges[0].start;
    const to = subSplit ? segment.to : segment.exchanges[segment.exchanges.length - 1].end;

    // A sub-split piece has no opening user turn of its own, so its label is taken from
    // the text it does start with and flagged, rather than inventing a user statement.
    let label;
    let agentLabel = false;
    if (subSplit) {
      // A size-split piece may still happen to begin on a user turn — the split is by
      // size, not by speaker. Use the user's own words when it does, and only fall back
      // to the assistant's text when it does not.
      const opening = session.messages[from];
      if (opening?.role === 'user' && !segment.charFrom) {
        label = labelFrom(opening.text, labelChars);
      } else {
        agentLabel = true;
        label = labelFrom(agentLabelFrom(session, from, segment.charFrom), labelChars);
      }
    } else {
      label = labelFrom(segment.exchanges[0].userText, labelChars);
    }

    const files = subSplit
      ? segment.files
      : [...new Set(segment.exchanges.flatMap((e) => [...e.files]))];
    const tools = subSplit
      ? segment.tools
      : (() => {
          const m = new Map();
          for (const e of segment.exchanges) for (const [n, c] of e.tools) m.set(n, (m.get(n) || 0) + c);
          return m;
        })();

    const first = { start: from, ts: messages_ts(session, from) };
    const last = { end: to, endedAt: messages_ts(session, to) };

    topics.push({
      id: `t${topics.length + 1}`,
      label,
      /** True when the label came from the assistant because no user turn opens it. */
      agentLabel,
      ...(segment.charFrom !== undefined ? { charFrom: segment.charFrom, charTo: segment.charTo } : {}),
      // The opening user turn, verbatim to a useful length. This is the topic
      // statement and needs no model to write. For a sub-split piece there is no such
      // turn, so the summary is the piece's own opening text.
      summary: subSplit
        ? clip(
            session.messages[from]?.role === 'user' && !segment.charFrom
              ? session.messages[from].text
              : agentLabelFrom(session, from, segment.charFrom),
            400,
          )
        : clip(segment.exchanges[0].userText, 400),
      /**
       * Message indices this topic covers. For an intra-message split the same index
       * appears in two consecutive topics — `charFrom`/`charTo` disambiguate which part
       * of that message each one owns, and `sourceRefs.messageIndex` remains valid for
       * both because it names the containing turn.
       */
      messageRanges: [[from, to]],
      from,
      to,
      exchanges: subSplit ? 1 : segment.exchanges.length,
      subSplit,
      userTurns: subSplit
        ? [session.messages[from]?.text?.trim()].filter(Boolean)
        : segment.exchanges.map((e) => e.userText.trim()).filter(Boolean),
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

  // Works off message ranges rather than exchanges, because a size-split piece has no
  // exchanges of its own. Scoring those as zero exchanges dropped every piece out of
  // the ranking, so the split never reached the output.
  const ranges = segment.subSplit
    ? [[segment.from, segment.to]]
    : segment.exchanges.map((e) => [e.start, e.end]);

  // Files edited, not merely read. Strongest signal that something happened.
  let wrote = 0;
  let edited = 0;
  const toolCounts = segment.subSplit
    ? segment.tools
    : (() => {
        const m = new Map();
        for (const e of segment.exchanges) for (const [n, c] of e.tools) m.set(n, (m.get(n) || 0) + c);
        return m;
      })();
  for (const [name, count] of toolCounts) {
    if (/write|edit|create|patch|apply|insert|replace/i.test(name)) wrote += count;
  }
  edited = (segment.files || []).length;
  score += Math.min(6, wrote) * 2;
  score += Math.min(10, edited) * 0.6;

  // Substantive back-and-forth, with diminishing returns. For a size-split piece the
  // message count stands in for the exchange count.
  const unitCount = segment.subSplit
    ? Math.max(1, segment.to - segment.from + 1)
    : segment.exchanges.length;
  score += Math.log2(1 + unitCount) * 1.2;

  const substantive = ranges.reduce((n, [from, to]) => {
    let count = 0;
    for (let i = from; i <= to && i < session.messages.length; i++) {
      if ((session.messages[i]?.text || '').trim().length > 80) count++;
    }
    return n + count;
  }, 0);
  score += Math.min(6, substantive) * 0.5;

  // Code in either direction is what fill-in-the-blank questions need; errors are what
  // "why did this fail" questions need.
  let codeBlocks = 0;
  let errorMentions = 0;
  for (const [from, to] of ranges) {
    for (let i = from; i <= to && i < session.messages.length; i++) {
      const text = session.messages[i].text;
      codeBlocks += (text.match(/```/g) || []).length / 2;
      errorMentions += (text.match(/\b(error|exception|failed|failure|traceback|stack trace|bug|doesn't work|not working)\b/gi) || []).length;
    }
  }
  score += Math.min(5, codeBlocks) * 1.1;
  score += Math.min(8, errorMentions) * 0.45;

  // Size, logarithmically: a very large topic is usually more substantial, but it must
  // not dominate the ranking on length alone.
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
 * The bounded prompt body for one topic — Stage C's input, and the only thing in the
 * pipeline that grows with the session, so it is capped here.
 *
 * Topics start on user turns, so a slice taken literally would open with an
 * assistant reply whose question is out of view. Measured on a 2.4M-character
 * session, that produced questions opening "Following the updates to X…" and
 * "Based on the evaluation of X…" — grounded, but written as continuations because
 * that is genuinely what the model was shown. So a slice is three parts:
 *
 *   [context]  the PRECEDING EXCHANGE, explicitly labelled as background:
 *              the user turn that opened it and the conclusion it reached. The
 *              pair is what makes the topic read as a continuation rather than a
 *              non-sequitur, and it is bounded far below the topic itself.
 *   [topic]    the topic's own turns, rendered as in the digest.
 *   [budget]   the context comes out of the same maxChars, so the cap holds.
 */
export function topicSlice(session, topic, options = {}) {
  const { maxChars = 12000, includeCode = true, contextChars = 1200 } = options;

  const header = `--- TOPIC: ${topic.label} (turns ${topic.from}-${topic.to}) ---\n\n`;

  // Everything shares one budget. The context is capped as a FRACTION of maxChars
  // rather than an absolute, and the marker allowance is subtracted up front, so a
  // small cap cannot be overrun by a fixed-size preamble — which is what happened
  // when the context was added outside the budget.
  const MARKER_ROOM = 80;
  const contextBudget = Math.min(contextChars, Math.max(0, Math.floor(maxChars * 0.3)));
  const context = buildPrecedingContext(session, topic, contextBudget);
  const bodyBudget = Math.max(120, maxChars - header.length - context.text.length - MARKER_ROOM);

  let body;
  if (topic.charFrom !== undefined) {
    // An intra-message piece: one message, cut to a character window. Rendering the
    // whole message and truncating would show the first part of every piece.
    const raw = session.messages[topic.from]?.text || '';
    body = raw.slice(topic.charFrom, topic.charTo).trim();
  } else {
    body = renderTurnRange(session, {
      from: topic.from,
      to: topic.to,
      includeCode,
      finalIndex: lastAssistantIndex(session, topic.from, topic.to),
    });
  }

  let bodyText = body;
  let truncated = 0;
  if (bodyText.length > bodyBudget) {
    truncated = bodyText.length - bodyBudget;
    bodyText = `${bodyText.slice(0, bodyBudget)}\n… (${truncated} chars of this topic omitted)`;
  }

  const text = `${context.text}${header}${bodyText}`;

  return {
    topicId: topic.id,
    label: topic.label,
    text,
    chars: text.length,
    contextChars: context.text.length,
    truncated,
    messageRanges: topic.messageRanges,
    files: topic.files,
    tools: topic.tools,
  };
}

/**
 * The preceding exchange, labelled as background.
 *
 * Deliberately the user turn AND the conclusion that followed it. Including only
 * one — which is what the first version did — shows the model an answer to a
 * question it cannot see, which reads as a dangling fragment.
 */
function buildPrecedingContext(session, topic, budget) {
  if (topic.from <= 0 || budget <= 0) return { text: '', turns: [] };

  const messages = session.messages;
  let prevUser = -1;
  for (let i = topic.from - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') { prevUser = i; break; }
  }
  if (prevUser === -1) return { text: '', turns: [] };

  let prevAssistant = -1;
  for (let i = topic.from - 1; i > prevUser; i--) {
    if (messages[i]?.role === 'assistant') { prevAssistant = i; break; }
  }

  const lines = [
    '--- PRECEDING CONTEXT (background from earlier in the same session; not part of this topic) ---',
    '',
  ];
  lines.push(`[turn ${prevUser}] USER (earlier)`);
  lines.push(clip(messages[prevUser].text, Math.floor(budget * 0.35)));
  lines.push('');
  if (prevAssistant !== -1) {
    lines.push(`[turn ${prevAssistant}] ASSISTANT (earlier)`);
    lines.push(clip(messages[prevAssistant].text, Math.floor(budget * 0.5)));
    lines.push('');
  }

  let text = lines.join('\n');
  if (text.length > budget) text = `${text.slice(0, budget)}\n… (earlier context truncated)\n\n`;
  return { text: `${text}\n`, turns: [prevUser, prevAssistant].filter((i) => i !== -1) };
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
