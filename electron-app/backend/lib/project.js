// Project inspection — the repository half of the digest.
//
// Everything here is deterministic and read-only: no model calls, no writes, no
// network. The output is cheap to produce and cache, and it is the only place in
// the app that touches files the user did not explicitly hand over, so two rules
// apply throughout:
//
//   1. NEVER read file bodies except from a small allowlist of documentation and
//      manifest files. A digest must not become a way to exfiltrate a source tree.
//   2. Bound everything. Depth, entry count, bytes per file, total bytes, and a
//      timeout on every git call.
//
// The conversation decides what matters here (see digest.js): `relevant` is the
// set of paths the conversation actually touched, and it is used to focus the
// tree and to attach commit messages to the right files rather than dumping a
// repository's history wholesale.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** Directories that are never interesting and often enormous. */
const NOISE_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target',
  '.venv', 'venv', 'env', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  '.next', '.nuxt', '.svelte-kit', '.parcel-cache', '.turbo', '.cache', '.gradle',
  'vendor', 'coverage', '.nyc_output', '.tox', '.idea', '.vscode', '.terraform',
  'Pods', 'DerivedData', '.dart_tool', 'bower_components', '.DS_Store',
]);

const DOC_NAMES = [
  'README.md', 'README.rst', 'README.txt', 'README',
  'ARCHITECTURE.md', 'DESIGN.md', 'CONTRIBUTING.md', 'SPEC.md', 'NOTES.md',
];

const MANIFEST_NAMES = new Set([
  'package.json', 'pyproject.toml', 'requirements.txt', 'setup.py', 'Cargo.toml',
  'go.mod', 'Gemfile', 'pom.xml', 'build.gradle', 'composer.json', 'mix.exs',
  'pubspec.yaml', 'deno.json', 'tsconfig.json', 'Makefile', 'justfile',
  'docker-compose.yml', 'compose.yaml', 'Dockerfile', '.env.example',
]);

const MAX_FILE_BYTES = 64 * 1024;
const GIT_TIMEOUT_MS = 4000;

/** Read a UTF-8 file, bounded, returning null on any failure. */
export function readBounded(file, maxBytes = MAX_FILE_BYTES) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Run a git command without a shell, with a hard timeout. Never throws. */
function git(root, args, { maxBuffer = 1024 * 1024, raw = false } = {}) {
  try {
    const out = execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // `raw` matters for porcelain output, whose first character is significant:
    // trimming strips the leading space of the first line and silently shifts
    // every field by one, which is how a path becomes `lectron-app/...`.
    return raw ? out : out.trim();
  } catch {
    return null;
  }
}

export function isGitRepo(root) {
  return git(root, ['rev-parse', '--is-inside-work-tree']) === 'true';
}

export function repoRoot(root) {
  return git(root, ['rev-parse', '--show-toplevel']);
}

/**
 * Commits made during the session window. This is the highest-signal git signal
 * available: it is the work the conversation actually produced, and it comes with
 * a message somebody wrote in their own words.
 */
export function commitsInWindow(root, { sinceMs, untilMs, limit = 25 } = {}) {
  if (!Number.isFinite(sinceMs)) return [];
  const args = ['log', '--no-merges', `--pretty=format:%h%x09%ad%x09%s`, '--date=format:%H:%M'];
  if (sinceMs) args.push(`--since=${new Date(sinceMs - 3600_000).toISOString()}`);
  if (Number.isFinite(untilMs) && untilMs) args.push(`--until=${new Date(untilMs + 3600_000).toISOString()}`);
  else args.push('--until=now');
  args.push(`-n${limit}`);
  const out = git(root, args);
  if (!out) return [];
  return out
    .split('\n')
    .map((line) => {
      const [sha, time, ...rest] = line.split('\t');
      return sha ? { sha, time, subject: rest.join('\t') } : null;
    })
    .filter(Boolean);
}

/** Uncommitted work in the tree, as a bounded summary. */
export function workingTreeState(root, { limit = 40 } = {}) {
  // -z gives NUL-separated records: immune to the leading-whitespace problem and
  // to filenames containing spaces or quotes, which the default format escapes.
  const porcelain = git(root, ['status', '--porcelain=v1', '-z', '-uall'], { raw: true });
  if (porcelain == null) return null;

  const tokens = porcelain.split('\0').filter((t) => t.length > 2);
  const entries = [];
  let unmerged = 0;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const status = token.slice(0, 2);
    let file = token.slice(3);
    // Rename/copy records carry the source path in the next NUL-separated field.
    if (status[0] === 'R' || status[0] === 'C') {
      const from = tokens[++i];
      if (from) file = `${from} -> ${file}`;
    }
    if (status === 'UU' || status === 'AA' || status === 'DD') unmerged++;
    entries.push(`${status} ${file}`);
  }

  return {
    dirty: entries.length,
    unmerged,
    files: entries.slice(0, limit),
    truncated: Math.max(0, entries.length - limit),
  };
}

/**
 * The last commit message for each of a few specific files. This is what ties
 * "the conversation edited app/db.py" to "commit abc123: fix pool leak".
 */
export function lastCommitsFor(root, files, { limit = 8 } = {}) {
  const out = [];
  for (const file of files.slice(0, limit)) {
    const line = git(root, ['log', '-1', '--pretty=format:%h %s', '--', file]);
    if (line) out.push({ file, commit: line });
  }
  return out;
}

/**
 * A compact directory tree, focused on the files the conversation touched.
 *
 * `relevant` is a set of paths relative to the repo root. Subtrees containing a
 * relevant file are walked deeper; everything else is shown one level deep so the
 * shape of the project is visible without listing a whole source tree.
 */
export function renderTree(root, { relevant = [], maxDepth = 4, maxEntries = 220 } = {}) {
  // Windows is case-insensitive, so `Src/db.ts` and `src/db.ts` are one file. Folding
  // for the membership test keeps a touched file marked in the tree; the original
  // spelling is what gets displayed.
  const caseFold = process.platform === 'win32' ? (s) => s.toLowerCase() : (s) => s;
  const relevantSet = new Set(relevant.map((p) => caseFold(p.replace(/^\.\//, ''))));
  const marked = new Set();
  // Ancestors of relevant files get walked to full depth so their contents show.
  const deepPrefixes = new Set();
  for (const rel of relevantSet) {
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) deepPrefixes.add(parts.slice(0, i).join('/'));
  }

  const lines = [];
  let entries = 0;
  let capped = false;

  const walk = (dir, prefix, depth) => {
    if (entries >= maxEntries) {
      capped = true;
      return;
    }
    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    items = items
      .filter((e) => !NOISE_DIRS.has(e.name) && !e.name.startsWith('.'))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    const shown = items.slice(0, Math.max(0, maxEntries - entries));
    if (shown.length < items.length) capped = true;

    for (const item of shown) {
      entries++;
      const rel = prefix ? `${prefix}/${item.name}` : item.name;
      const isRelevant = relevantSet.has(caseFold(rel));
      if (isRelevant) marked.add(rel);
      lines.push(`${'  '.repeat(depth)}${item.name}${item.isDirectory() ? '/' : ''}${isRelevant ? '   <- touched' : ''}`);
      // Descend when this directory can contain something relevant, or when we
      // are still shallow enough to be showing general project shape.
      if (item.isDirectory()) {
        const canContainRelevant = deepPrefixes.has(rel) || [...deepPrefixes].some((p) => p.startsWith(`${rel}/`));
        if (canContainRelevant ? depth < maxDepth + 3 : depth < 1) {
          walk(path.join(dir, item.name), rel, depth + 1);
        }
      }
    }
  };

  walk(root, '', 0);
  return { text: lines.join('\n'), entries, capped, markedRelevant: [...marked] };
}

/**
 * Documentation, preferring the top level. README first because it is the single
 * best statement of what the project is.
 */
export function collectDocs(root, { limit = 3, perFile = 3000 } = {}) {
  const found = [];
  const seen = new Set();
  const push = (relPath) => {
    if (found.length >= limit) return;
    // README.md is reached twice — once by name from DOC_NAMES and once by the
    // .md sweep below — which duplicated the whole excerpt in every digest.
    if (seen.has(relPath)) return;
    seen.add(relPath);
    const abs = path.join(root, relPath);
    const text = readBounded(abs);
    if (!text) return;
    found.push({
      path: relPath,
      chars: text.length,
      text: text.length > perFile ? `${text.slice(0, perFile)}\n… (${text.length - perFile} more chars)` : text,
    });
  };

  for (const name of DOC_NAMES) push(name);

  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isFile() && /\.(md|mdx|rst)$/i.test(entry.name)) push(entry.name);
    }
  } catch {
    /* ignore */
  }

  // A docs/ directory, but only shallowly: enough for an overview, not a manual.
  try {
    const docsDir = path.join(root, 'docs');
    if (isDirectory(docsDir) && found.length < limit) {
      const files = fs
        .readdirSync(docsDir, { withFileTypes: true })
        .filter((e) => e.isFile() && /\.(md|mdx|rst)$/i.test(e.name))
        .map((e) => `docs/${e.name}`)
        .sort();
      for (const rel of files) push(rel);
    }
  } catch {
    /* ignore */
  }

  return found;
}

/** A short, structured summary of a manifest rather than its whole body. */
function summarizeManifest(name, text) {
  if (!text) return null;
  try {
    if (name === 'package.json') {
      const pkg = JSON.parse(text);
      const deps = Object.keys(pkg.dependencies || {});
      const dev = Object.keys(pkg.devDependencies || {});
      return {
        name: pkg.name,
        description: pkg.description,
        scripts: Object.keys(pkg.scripts || {}),
        dependencies: deps.slice(0, 24),
        devDependencies: dev.slice(0, 12),
        dependencyCount: deps.length + dev.length,
      };
    }
    if (name === 'pyproject.toml' || name === 'Cargo.toml') {
      // No TOML parser in the standard library; the dependency section is what
      // matters and it is line-oriented in practice.
      const deps = [...text.matchAll(/^\s*"?([A-Za-z0-9_.-]+)"?\s*[>=~^]/gm)].map((m) => m[1]);
      return { dependencies: [...new Set(deps)].slice(0, 30) };
    }
    if (name === 'requirements.txt') {
      const deps = text
        .split('\n')
        .map((l) => l.split(/[=<>~!\[]/)[0].trim())
        .filter((l) => l && !l.startsWith('#'));
      return { dependencies: deps.slice(0, 30), dependencyCount: deps.length };
    }
    if (name === 'go.mod') {
      const mod = /^module\s+(\S+)/m.exec(text)?.[1];
      const deps = [...text.matchAll(/^\s+([\w./-]+)\s+v/gm)].map((m) => m[1]);
      return { module: mod, dependencies: deps.slice(0, 20) };
    }
    return { excerpt: text.slice(0, 400) };
  } catch {
    return { excerpt: text.slice(0, 400) };
  }
}

/**
 * Manifests, from the working directory and from one level below it.
 *
 * Checking the root only is not enough in practice: most repositories keep the
 * manifest in a subdirectory, at which point the digest would report the stack as
 * unknown and the model has to guess what kind of project this is.
 */
export function collectManifests(root, { limit = 4, depth = 2 } = {}) {
  const out = [];
  const seen = new Set();

  const consider = (dir, prefix) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) return;
      if (!entry.isFile() || !MANIFEST_NAMES.has(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (seen.has(rel)) continue;
      seen.add(rel);
      const summary = summarizeManifest(entry.name, readBounded(path.join(dir, entry.name)));
      if (summary) out.push({ path: rel, summary });
    }
  };

  consider(root, '');

  if (out.length < limit && depth > 1) {
    let subdirs = [];
    try {
      subdirs = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !NOISE_DIRS.has(e.name) && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort();
    } catch {
      subdirs = [];
    }
    for (const name of subdirs) {
      if (out.length >= limit) break;
      consider(path.join(root, name), name);
    }
  }

  return out;
}
