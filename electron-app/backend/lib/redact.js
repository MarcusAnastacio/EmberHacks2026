// Redaction.
//
// This is the single function that stands between a developer's private agent
// transcripts and a third-party model. Transcripts are the most sensitive files
// on a machine: they contain API keys, tokens, connection strings, .env contents
// and internal hostnames, because agents read and write those files constantly
// and paste the results into their own logs.
//
// Two rules shape the design:
//
//   1. Replace the VALUE, keep the SHAPE. `DATABASE_URL=postgres://u:hunter2@db:5432/app`
//      becomes `DATABASE_URL=postgres://[redacted:password]@db:5432/app`. The
//      structure is often the quiz-worthy part ("what does the app connect to?"),
//      so destroying it would destroy the material.
//   2. Never touch something benign. A redactor that eats git SHAs, UUIDs or file
//      paths makes the transcript useless, and agent transcripts are full of all
//      three. Over-redaction is a correctness bug here, not a safe default, which
//      is why the negative test cases matter more than the positive ones.
//
// Two passes:
//   * patterns  — high confidence, matched by shape or by surrounding keyword
//   * entropy   — catches unlabelled random-looking tokens, conservative by design

/** Placeholder format. Greppable, and it keeps the kind visible for the report. */
const placeholder = (kind) => `[redacted:${kind}]`;

// ── Patterns ───────────────────────────────────────────────────────────────
//
// Ordered most specific first: an earlier match claims its range, so a private
// key block is not partially re-split by a looser pattern later. `group` selects
// which capture group to replace when the surrounding context should be kept.

const SECRET_WORDS =
  'api[_-]?key|apikey|secret|token|passwd|password|pwd|passphrase|' +
  'access[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret|' +
  'auth[_-]?token|credentials?|session[_-]?key|encryption[_-]?key|signing[_-]?key|' +
  'webhook[_-]?url|connection[_-]?string|dsn';

// `(?<![A-Za-z])` rather than `\\b`: a word boundary still matches inside
// NOPASSWD (NO|PASSWD is not a boundary), which redacted part of a sudoers rule.
const KEYWORD = `(?<![A-Za-z])(?:${SECRET_WORDS})`;

// Values that are obviously not secrets. Without this, `API_KEY=your-key-here`
// and `PASSWORD=${DB_PASS}` get eaten and the transcript loses real content.
const BENIGN_VALUE =
  /^(?:|null|none|nil|true|false|undefined|changeme|change[-_ ]?me|redacted|placeholder|dummy|example|todo|xxx+|\*+|-+|\.+|\[redacted:[^\]]*\]|<[^>]*>|\$\{[^}]*\}|\$[A-Za-z_]\w*|process\.env\.\w+|os\.environ(?:\[[^\]]*\])?|getenv\([^)]*\)|str|int|float|bool|bytes|dict|list|tuple|path|url|string|number|boolean|file|optional(?:\s*\|.*)?|\w+\s*\|\s*\w+.*)$/i;

// Words that only ever appear in a placeholder. Used with the all-segments rule
// below, so a real key that happens to contain "test" is still redacted.
const PLACEHOLDER_SEGMENTS = new Set([
  'your', 'my', 'our', 'the', 'a', 'an', 'here', 'placeholder', 'example',
  'dummy', 'redacted', 'changeme', 'foobar', 'sample', 'fake', 'todo',
  'xxx', 'abc', 'key', 'apikey', 'api', 'token', 'secret', 'password',
  // Filler that restates the key name rather than carrying a value, e.g.
  // CLIENT_SECRET=my-client-secret-value. Safe because the rule requires EVERY
  // segment to be filler — a real secret never tokenises entirely into these.
  'value', 'client', 'server', 'name', 'id', 'data', 'string', 'json',
  'config', 'env', 'local', 'dev', 'prod', 'staging', 'test', 'default',
]);

/** True when every `-_`-separated segment is a placeholder word. */
function isAllPlaceholderSegments(value) {
  const segments = value.split(/[-_.]+/).filter(Boolean);
  if (segments.length === 0) return false;
  return segments.every(
    (s) => PLACEHOLDER_SEGMENTS.has(s.toLowerCase()) || /^\d+$/.test(s),
  );
}

/**
 * Is this value a real secret literal, or just a reference to one?
 *
 * The distinction is the difference between a useful redactor and one that
 * shreds every line of code that mentions a key. `API_KEY=hunter2` must be
 * redacted; `apiKey = config.secrets.openai` and `apiKey = getApiKey()` must not.
 */
function looksLikeLiteral(value, quoted) {
  const v = String(value).trim().replace(/^[\s"'`*_]+|[\s"'`*_]+$/g, '');
  if (BENIGN_VALUE.test(v)) return false;
  if (isAllPlaceholderSegments(v)) return false;
  // Member expression: config.secrets.openai, req.headers.authorization
  if (/^[A-Za-z_$][\w$]*(\.[\w$]+)+$/.test(v)) return false;
  // Bare identifier: accept only with a signal that it is a secret rather than a
  // function or variable name — quoted, mixed letters+digits, or simply long.
  if (/^[A-Za-z_$][\w$]*$/.test(v)) {
    return quoted || (/\d/.test(v) && /[A-Za-z]/.test(v)) || v.length >= 16;
  }
  return true;
}

/**
 * Prose hits need a stronger signal than code hits, because "a password is
 * required" and "the token is expired" are ordinary sentences. Require the
 * value to look like a credential rather than English.
 */
function looksLikeProseSecret(value) {
  const v = String(value).replace(/^[\s"'`*_\[]+|[\s"'`*_\].,;:!?]+$/g, '');
  if (!looksLikeLiteral(v, false)) return false;
  if (/^[a-z]+$/.test(v)) return false;            // a single lowercase word
  return /\d/.test(v) || /[^a-z]/.test(v) || v.length >= 12;
}

const PATTERNS = [
  // --- Structured secrets -------------------------------------------------
  {
    // Multi-line, so this must run before anything line-oriented.
    kind: 'private-key',
    source: String.raw`-----BEGIN[^-]{0,40}PRIVATE KEY-----[\s\S]*?-----END[^-]{0,40}PRIVATE KEY-----`,
    flags: 'g',
  },
  {
    // header.payload.signature — three base64url segments starting with eyJ ("{").
    kind: 'jwt',
    source: String.raw`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}=*`,
    flags: 'g',
  },
  {
    kind: 'bearer-token',
    source: String.raw`(?<=\bBearer\s)[A-Za-z0-9\-._~+/]{16,}=*`,
    flags: 'gi',
  },

  // --- Provider-prefixed tokens ------------------------------------------
  // These have unambiguous shapes, so they need no context to be confident.
  { kind: 'anthropic-key', source: String.raw`\bsk-ant-[A-Za-z0-9_-]{20,}`, flags: 'g' },
  {
    // `sk-ssh-` and `sk-ecdsa-` are OpenSSH/FIDO key algorithm names, not OpenAI
    // keys. Without the negative lookahead, `sk-ssh-ed25519@openssh.com` inside an
    // ssh -v trace was redacted as an OpenAI key.
    kind: 'openai-key',
    source: String.raw`\bsk-(?!ssh-|ecdsa-)(?:proj-)?[A-Za-z0-9_-]{20,}`,
    flags: 'g',
  },
  { kind: 'github-token', source: String.raw`\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}`, flags: 'g' },
  { kind: 'github-token', source: String.raw`\bgithub_pat_[A-Za-z0-9_]{20,}`, flags: 'g' },
  { kind: 'gitlab-token', source: String.raw`\bglpat-[A-Za-z0-9_-]{18,}`, flags: 'g' },
  { kind: 'aws-access-key-id', source: String.raw`\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b`, flags: 'g' },
  { kind: 'google-api-key', source: String.raw`\bAIza[0-9A-Za-z_-]{35}\b`, flags: 'g' },
  { kind: 'google-oauth', source: String.raw`\bya29\.[0-9A-Za-z_-]{20,}`, flags: 'g' },
  { kind: 'slack-token', source: String.raw`\bxox[abprs]-[A-Za-z0-9-]{10,}`, flags: 'g' },
  { kind: 'slack-webhook', source: String.raw`https://hooks\.slack\.com/services/[A-Za-z0-9/_+-]{20,}`, flags: 'g' },
  { kind: 'discord-webhook', source: String.raw`https://(?:canary\.|ptb\.)?discord(?:app)?\.com/api/webhooks/\d+/[A-Za-z0-9_-]{20,}`, flags: 'g' },
  { kind: 'stripe-key', source: String.raw`\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}`, flags: 'g' },
  { kind: 'sendgrid-key', source: String.raw`\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}`, flags: 'g' },
  { kind: 'npm-token', source: String.raw`\bnpm_[A-Za-z0-9]{36}\b`, flags: 'g' },
  { kind: 'huggingface-token', source: String.raw`\bhf_[A-Za-z0-9]{30,}`, flags: 'g' },
  { kind: 'digitalocean-token', source: String.raw`\bdop_v1_[a-f0-9]{64}\b`, flags: 'g' },
  { kind: 'twilio-key', source: String.raw`\bSK[0-9a-f]{32}\b`, flags: 'g' },
  { kind: 'pypi-token', source: String.raw`\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{10,}`, flags: 'g' },
  { kind: 'shopify-token', source: String.raw`\bshpat_[0-9a-f]{32}\b`, flags: 'g' },
  { kind: 'vercel-token', source: String.raw`\bvercel_(?!json)[A-Za-z0-9]{20,}`, flags: 'g' },
  { kind: 'linear-key', source: String.raw`\blin_api_[A-Za-z0-9]{30,}`, flags: 'g' },
  { kind: 'grafana-token', source: String.raw`\bglsa_[A-Za-z0-9]{20,}_[0-9a-f]{8}\b`, flags: 'g' },
  { kind: 'sentry-dsn', source: String.raw`https://[0-9a-f]{32}@[A-Za-z0-9.-]+/\d+`, flags: 'g' },

  // --- Credentials embedded in a URL --------------------------------------
  // Keep scheme, user and host: "which database does this point at" is exactly
  // the kind of thing a quiz should ask about.
  {
    kind: 'password',
    source: String.raw`\b([a-z][a-z0-9+.-]*://[^/\s:@]{1,64}):([^/\s@]{1,256})@`,
    flags: 'gi',
    group: 2,
  },

  // --- Keyword-labelled values -------------------------------------------
  // The general case: a secret-ish name followed by a value. Quoted values keep
  // their quotes so the code still reads as code.
  {
    // Quoted values first: within quotes almost anything is a literal, so the
    // guard can be permissive and the capture cannot bleed into code.
    kind: 'labelled-secret',
    source: `${KEYWORD}\\s*[:=]\\s*"([^"\\n\r]{6,512})"`,
    flags: 'gi',
    group: 1,
    guard: (value) => !looksLikeLiteral(value, true),
  },
  {
    kind: 'labelled-secret',
    source: `${KEYWORD}\\s*[:=]\\s*'([^'\\n\r]{6,512})'`,
    flags: 'gi',
    group: 1,
    guard: (value) => !looksLikeLiteral(value, true),
  },
  {
    // Bare values. `=` is excluded from the class on purpose: including it let a
    // capture swallow whole runs of minified JavaScript (`token=function t(t,e,n,r){...}`)
    // and redact code as if it were a secret. `/` and `+` stay, because AWS secret
    // access keys and base64 secrets contain them.
    kind: 'labelled-secret',
    source: `${KEYWORD}\\s*[:=]\\s*([A-Za-z0-9_\\-+/]{6,512})`,
    flags: 'gi',
    group: 1,
    guard: (value) => !looksLikeLiteral(value, false),
  },
  {
    // .env line: NAME=value, where NAME alone is enough to be confident.
    kind: 'env-secret',
    source: `^[ \\t]*[A-Z][A-Z0-9_]*(${SECRET_WORDS.toUpperCase()})[A-Z0-9_]*[ \\t]*=[ \\t]*([^\\s#'"]{4,2048})`,
    flags: 'gm',
    group: 2,
    guard: (value) => !looksLikeLiteral(value, false),
  },
  {
    // Prose: "the admin password is hunter2". The value must START with an
    // alphanumeric and may only contain credential-ish characters, so a sentence
    // like "a password is **required**" cannot be captured at all — an earlier
    // `[^\s]{6,}` class swallowed the markdown and the closing punctuation with
    // it, and redacted the word "required".
    kind: 'prose-secret',
    source: String.raw`\b(?:password|passphrase|passwd|secret|token|api key|api_key)\s+(?:is|was|are)\s+([A-Za-z0-9][A-Za-z0-9._~+/=\-]{5,127})`,
    flags: 'gi',
    group: 1,
    guard: (value) => !looksLikeProseSecret(value),
  },
];

// ── Entropy pass ───────────────────────────────────────────────────────────

/** Shannon entropy in bits per character. */
function entropy(s) {
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) || 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

// Shapes that are random-looking but benign and pervasive in agent transcripts.
// Redacting any of these would visibly damage the content.
const BENIGN_SHAPES = [
  /^[a-f0-9]{7,64}$/i,                                     // git SHA, md5, sha1, sha256
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // UUID
  /^v?\d+(\.\d+){1,3}([-+][\w.]+)?$/,                       // semver
  /^(19|20)\d{2}[-_]\d{2}[-_]\d{2}/,                        // date stamp
  /^T\d{1,2}:\d{2}/,                                        // ISO time
  /^0x[0-9a-f]+$/i,                                         // hex literal
  /^\d+$/,                                                  // number
  /^[A-Za-z]:[\\/]/,                                        // Windows path
];

/**
 * Context that means the token is part of a filename, path, URL, markup or
 * anchor rather than a standalone secret. Every one of these was found by
 * running the pass over real transcripts and inspecting the output — the
 * entropy pass is easy to write and hard to make useful.
 */
function isStructuralContext(text, start, end) {
  const before = text.slice(Math.max(0, start - 80), start);
  const after = text.slice(end, end + 24);

  if (/[.\-/_@$]$/.test(before)) return true;      // foo.[token], [token].py, path/[token]
  if (/^[.\-/_@:]/.test(after)) return true;       // [token].pdf, [token]-suffix
  if (/<[^>]*$/.test(before)) return true;          // inside an HTML/XML tag
  if (/[A-Za-z0-9_-]+="[^"]*$/.test(before)) return true; // HTML attribute value
  if (/https?:\/\/[^\s]*$/.test(before)) return true;      // URL component
  if (/\]\([^)]*$/.test(before)) return true;      // markdown link target
  if (/(?:SHA1|SHA256|MD5|fingerprint):?\s*$/i.test(before)) return true; // host key fingerprint
  if (/^[A-Za-z0-9+/=]{4,}$/.test(after) && /[+/=]$/.test(before)) return true; // base64 blob
  return false;
}

/**
 * Catch random-looking tokens that no pattern recognised.
 *
 * OFF BY DEFAULT. Measured on real agent transcripts this pass produced far more
 * false positives than true positives: filenames, Next.js build IDs, PDF font
 * names, markdown anchors, host key fingerprints and fragments of the user's own
 * session identifiers. Each one corrupts the transcript that the quiz is built
 * from, so it is opt-in and the UI should say when it is on.
 */
function entropyPass(text, claim) {
  const re = /\b[A-Za-z0-9+/=_-]{32,}\b/gd;
  let found = 0;

  for (const m of text.matchAll(re)) {
    const token = m[0];
    const [start, end] = m.indices[0];

    const before = text.slice(Math.max(0, start - 80), start);
    if (/base64[,;]/i.test(before) || /data:[a-z/+.-]*$/i.test(before)) continue;
    if (isStructuralContext(text, start, end)) continue;

    if (BENIGN_SHAPES.some((rx) => rx.test(token))) continue;
    if (!/[a-z]/.test(token) || !/[A-Z]/.test(token) || !/\d/.test(token)) continue;
    // A path or URL fragment is not a secret by shape alone.
    if (token.includes('/') && (token.includes('//') || token.split('/').length > 2)) continue;
    // Identifiers and words have long runs of letters; random tokens do not.
    // This is what keeps `useStateManager2Provider` out of the redaction list.
    const longestLetterRun = Math.max(...(token.match(/[A-Za-z]+/g) || ['']).map((r) => r.length));
    if (longestLetterRun >= 14) continue;
    if (entropy(token) < 4.5) continue;

    if (claim(start, end, 'high-entropy')) found++;
  }
  return found;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Redact one string.
 *
 * @param {string} text
 * @param {{entropy?: boolean}} [options]  entropy is OFF by default; see entropyPass
 * @returns {{text: string, findings: {kind: string, start: number, end: number}[], entropyHits: number}}
 */
export function redact(text, options = {}) {
  const source = typeof text === 'string' ? text : String(text ?? '');
  const edits = [];
  const claimed = [];

  /** Ranges are claimed once, first match wins, so patterns never overlap. */
  const claim = (start, end, kind) => {
    if (end <= start) return false;
    for (const [s, e] of claimed) if (start < e && end > s) return false;
    claimed.push([start, end]);
    edits.push({ kind, start, end });
    return true;
  };

  for (const pattern of PATTERNS) {
    const re = new RegExp(pattern.source, `${pattern.flags.replace('d', '')}d`);
    for (const m of source.matchAll(re)) {
      const group = pattern.group ?? 0;
      const indices = m.indices?.[group];
      if (!indices) continue;
      const [start, end] = indices;
      const value = m[group];
      if (pattern.guard?.(value, m, source)) continue;
      claim(start, end, pattern.kind);
    }
  }

  let entropyHits = 0;
  if (options.entropy === true) entropyHits = entropyPass(source, claim);

  // Apply back-to-front so earlier indices stay valid.
  const ordered = [...edits].sort((a, b) => b.start - a.start);
  let out = source;
  for (const edit of ordered) {
    out = out.slice(0, edit.start) + placeholder(edit.kind) + out.slice(edit.end);
  }

  return { text: out, findings: edits, entropyHits };
}

/**
 * Redact every message in a Gemini payload.
 *
 * Returns a new payload; the caller's session is never mutated, so the local
 * transcript stays complete in the app while only the copy on its way out is
 * scrubbed.
 *
 * @returns {{payload: object, report: object}}
 */
export function redactPayload(payload, options = {}) {
  const byKind = Object.create(null);
  let total = 0;
  let entropyHits = 0;

  const messages = (payload.messages || []).map((m) => {
    const { text, findings, entropyHits: eh } = redact(m.text, options);
    for (const f of findings) byKind[f.kind] = (byKind[f.kind] || 0) + 1;
    total += findings.length;
    entropyHits += eh;
    return { ...m, text };
  });

  return {
    payload: {
      ...payload,
      messages,
      redaction: { total, byKind: { ...byKind } },
    },
    report: {
      total,
      byKind: { ...byKind },
      entropy: entropyHits,
      scanned: messages.length,
    },
  };
}

/** Exported for tests and for the UI's "what do you catch?" view. */
export const patternKinds = [...new Set(PATTERNS.map((p) => p.kind))];
