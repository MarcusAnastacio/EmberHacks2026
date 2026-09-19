// Gemini client.
//
// Deliberately SDK-free: `fetch` is global in Node 18+ and Electron's Node, so the
// whole client is one request shape plus the error handling that the API actually
// requires. The app has no runtime dependencies and this keeps it that way.
//
// Two things about the API that are load-bearing and were found by testing:
//
//   1. MODELS GO UNAVAILABLE. During development, gemini-3.5/3.6/3.7/3.8-flash all
//      returned 503 "currently experiencing high demand" while 3.1-flash-lite served
//      normally, and gemini-2.5-flash returned 404 "no longer available to new
//      users". A single hardcoded model is therefore a demo that works until it
//      doesn't. Requests walk a fallback chain, retrying transient failures and
//      moving on immediately from a 404.
//
//   2. THE KEY IS NEVER LOGGED OR COMMITTED. It comes from the environment or from
//      a gitignored .env, and never appears in an error message, a request dump, or
//      a thrown object.

import fs from 'node:fs';
import path from 'node:path';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Tried in order. Best first, most reliable last, so quality wins when the API is
 * healthy and the feature still works when it is not. Override with GEMINI_MODEL or
 * the `models` option.
 */
export const DEFAULT_MODEL_CHAIN = [
  'gemini-3.8-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
];

const DEFAULT_TIMEOUT_MS = 90_000;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/** Parse a .env file. Minimal on purpose: KEY=VALUE, # comments, optional quotes. */
function parseEnv(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/** Candidate .env locations: the working directory, then up from this file. */
function envCandidates() {
  const here = path.dirname(new URL(import.meta.url).pathname);
  return [
    path.join(process.cwd(), '.env'),
    path.join(here, '..', '..', '.env'),      // electron-app/.env
    path.join(here, '..', '..', '..', '.env'), // repository root .env
  ];
}

let envCache;

/** Forget the cached .env contents. Needed after the file changes at runtime. */
export function resetEnvCache() {
  envCache = undefined;
}

/** Read the key from the argument, then the environment, then a .env file. */
export function resolveApiKey(explicit) {
  if (explicit) return explicit;
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  // GEMINI_SKIP_ENV_FILE forces environment-only lookup. Useful to make a
  // deployment's configuration explicit, and required to test the absent-key path
  // on a machine that has a .env file.
  if (process.env.GEMINI_SKIP_ENV_FILE) return null;
  if (envCache === undefined) {
    envCache = {};
    for (const file of envCandidates()) {
      try {
        if (fs.existsSync(file)) {
          envCache = { ...parseEnv(fs.readFileSync(file, 'utf8')), ...envCache };
        }
      } catch {
        /* ignore */
      }
    }
  }
  return envCache.GEMINI_API_KEY || null;
}

/** True when a key is available, without revealing it. */
export function hasApiKey(explicit) {
  return Boolean(resolveApiKey(explicit));
}

export class GeminiError extends Error {
  constructor(message, { status, model, body, attempts, kind } = {}) {
    super(message);
    this.name = 'GeminiError';
    this.status = status;
    this.model = model;
    this.body = body;
    this.attempts = attempts;
    this.kind = kind || 'request';
  }
}

/** Extract the first JSON object from model text, tolerating fences and prose. */
export function parseJsonResponse(text) {
  const raw = String(text || '').trim();
  const candidates = [raw];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  if (fenced) candidates.push(fenced[1].trim());
  const brace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (brace !== -1 && lastBrace > brace) candidates.push(raw.slice(brace, lastBrace + 1));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      /* try the next form */
    }
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Ask for structured JSON, walking a model chain.
 *
 * @param {object} options
 * @param {string} options.prompt
 * @param {object} options.schema            Gemini responseSchema (OpenAPI subset)
 * @param {string[]} [options.models]        fallback chain, best first
 * @param {number} [options.temperature]
 * @param {string} [options.apiKey]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.retriesPerModel]
 * @param {AbortSignal} [options.signal]
 * @param {(evt: object) => void} [options.onAttempt]
 * @returns {Promise<{data: object, model: string, usage: object, attempts: object[]}>}
 */
export async function generateJson(options) {
  const {
    prompt,
    schema,
    models,
    temperature = 0.7,
    apiKey,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retriesPerModel = 1,
    signal,
    onAttempt = () => {},
  } = options;

  const key = resolveApiKey(apiKey);
  if (!key) {
    throw new GeminiError(
      'No Gemini API key. Set GEMINI_API_KEY, or put it in a .env file (gitignored).',
      { kind: 'no-key' },
    );
  }

  const chain = models?.length
    ? models
    : process.env.GEMINI_MODEL
      ? [process.env.GEMINI_MODEL, ...DEFAULT_MODEL_CHAIN]
      : DEFAULT_MODEL_CHAIN;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: schema,
      temperature,
    },
  };

  const attempts = [];
  let lastError = null;

  for (const model of chain) {
    for (let attempt = 0; attempt <= retriesPerModel; attempt++) {
      if (signal?.aborted) throw new GeminiError('Aborted', { kind: 'aborted' });
      const startedAt = Date.now();

      let response;
      try {
        response = await fetch(`${ENDPOINT}/${model}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify(body),
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
            : AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
        const record = { model, attempt, ok: false, ms: Date.now() - startedAt, error: timedOut ? 'timeout' : err?.name };
        attempts.push(record);
        onAttempt(record);
        lastError = new GeminiError(timedOut ? `Timed out after ${timeoutMs}ms` : String(err?.message || err), {
          model,
          kind: timedOut ? 'timeout' : 'network',
        });
        continue; // a network blip is worth retrying on the same model
      }

      if (!response.ok) {
        // Never echo the request; it carries the key in a header.
        let detail = '';
        try {
          detail = (await response.text()).slice(0, 600);
        } catch {
          /* ignore */
        }
        const record = { model, attempt, ok: false, status: response.status, ms: Date.now() - startedAt, detail: detail.slice(0, 200) };
        attempts.push(record);
        onAttempt(record);
        lastError = new GeminiError(`HTTP ${response.status} from ${model}`, {
          status: response.status,
          model,
          body: detail,
          attempts,
          kind: response.status === 404 ? 'model-unavailable' : 'http',
        });
        // 404 means this model is gone for this key: no point retrying it.
        if (response.status === 404) break;
        if (RETRYABLE.has(response.status) && attempt < retriesPerModel) {
          await sleep(600 * (attempt + 1));
          continue;
        }
        break; // exhausted this model, try the next in the chain
      }

      let payload;
      try {
        payload = await response.json();
      } catch (err) {
        attempts.push({ model, attempt, ok: false, ms: Date.now() - startedAt, error: 'bad-json-envelope' });
        lastError = new GeminiError('Response was not JSON', { model, kind: 'parse' });
        break;
      }

      const candidate = payload.candidates?.[0];
      const text = candidate?.content?.parts?.map((p) => p.text).filter(Boolean).join('') || '';
      const data = parseJsonResponse(text);

      if (!data) {
        attempts.push({
          model,
          attempt,
          ok: false,
          ms: Date.now() - startedAt,
          error: `unparseable (finishReason=${candidate?.finishReason || 'none'})`,
        });
        lastError = new GeminiError(
          `Model returned no usable JSON (finishReason=${candidate?.finishReason || 'none'})`,
          { model, kind: 'parse', attempts },
        );
        // A safety block or a truncation will not fix itself on retry; next model.
        break;
      }

      const record = {
        model,
        attempt,
        ok: true,
        ms: Date.now() - startedAt,
        tokens: payload.usageMetadata?.totalTokenCount,
        finishReason: candidate?.finishReason,
      };
      attempts.push(record);
      onAttempt(record);

      return { data, model, usage: payload.usageMetadata || {}, attempts };
    }
  }

  throw lastError || new GeminiError('All models in the chain failed', { attempts });
}

/** Report which models are reachable, without generating anything. */
export async function listModels({ apiKey } = {}) {
  const key = resolveApiKey(apiKey);
  if (!key) throw new GeminiError('No Gemini API key', { kind: 'no-key' });
  const response = await fetch(ENDPOINT, {
    headers: { 'x-goog-api-key': key },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new GeminiError(`HTTP ${response.status} listing models`, { status: response.status });
  const payload = await response.json();
  return (payload.models || []).map((m) => ({
    name: m.name?.split('/').pop(),
    displayName: m.displayName,
    inputTokenLimit: m.inputTokenLimit,
    methods: m.supportedGenerationMethods,
  }));
}
