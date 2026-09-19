// Path template expansion + globbing.
//
// Turns registry `store_paths` templates into a list of concrete absolute
// filesystem paths. Templates look like:
//
//   ~/.claude/projects/**/*.jsonl
//   ${CODEX_HOME:-~/.codex}/sessions/**/rollout-*.jsonl
//   ${CLINE_SESSION_DATA_DIR:-${CLINE_DATA_DIR:-${CLINE_DIR:-~/.cline}/data}/sessions}/*/*.messages.json
//   <vscode-User>/workspaceStorage/*/chatSessions/*.{json,jsonl}
//   %APPDATA%/CherryStudio/Data/Agents/.claude/projects/*/*.jsonl
//
// Nested `${A:-${B:-fallback}}` defaults are supported via a real brace parser
// rather than a regex, because regexes cannot balance braces.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = os.homedir();
export const PLATFORM = process.platform; // darwin | linux | win32
export const PLATFORM_NAME = PLATFORM === 'win32'
  ? 'windows'
  : PLATFORM === 'darwin'
    ? 'macos'
    : PLATFORM === 'linux'
      ? 'linux'
      : PLATFORM;

const isWin = PLATFORM === 'win32';

/** Concrete roots used by agent applications on the current operating system. */
export function platformRoots() {
  if (isWin) {
    return {
      home: HOME,
      appData: process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'),
      localAppData: process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'),
      config: process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'),
      data: process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'),
    };
  }
  if (PLATFORM === 'darwin') {
    return {
      home: HOME,
      appData: path.join(HOME, 'Library', 'Application Support'),
      localAppData: path.join(HOME, 'Library', 'Caches'),
      config: path.join(HOME, 'Library', 'Preferences'),
      data: path.join(HOME, 'Library', 'Application Support'),
    };
  }
  return {
    home: HOME,
    appData: process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share'),
    localAppData: path.join(HOME, '.cache'),
    config: process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'),
    data: process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share'),
  };
}

/** Join a Dirent's parent path and name without depending on Dirent internals. */
function join(parent, name) {
  return parent ? path.join(parent, name) : name;
}

function parentOf(p) {
  return p || '';
}

/**
 * Sentinel returned when a template references an unset variable with no
 * default. Those templates are optional overrides (`${DEJA_PI_ROOT}/...`), so
 * the correct behaviour is to drop the pattern entirely. Without this, the
 * leading slash from a root-anchored glob turns into a walk of the whole disk.
 */
const MISSING = '\u0000unset\u0000';
export const isMissing = (p) => typeof p === 'string' && p.includes(MISSING);

/**
 * Resolve one `${NAME}` / `${NAME:-default}` / `%NAME%` token.
 * `raw` is the inside of the braces, e.g. "CODEX_HOME:-~/.codex".
 */
function resolveVar(raw) {
  const sep = raw.indexOf(':-');
  const name = (sep === -1 ? raw : raw.slice(0, sep)).trim();
  const fallback = sep === -1 ? '' : raw.slice(sep + 2);
  const value = process.env[name];
  if (value !== undefined && value !== '') return value;
  // The fallback may itself contain templates, so recurse.
  if (fallback) {
    const resolved = expandTemplate(fallback);
    return isMissing(resolved) ? MISSING : resolved;
  }
  return MISSING;
}

/** Replace every ${...} and %VAR% in a string (single-valued). */
export function expandTemplate(str) {
  let out = '';
  let i = 0;
  while (i < str.length) {
    // ${ ... } with balanced braces
    if (str[i] === '$' && str[i + 1] === '{') {
      let depth = 1;
      let j = i + 2;
      while (j < str.length && depth > 0) {
        if (str[j] === '{') depth++;
        else if (str[j] === '}') depth--;
        if (depth === 0) break;
        j++;
      }
      out += resolveVar(str.slice(i + 2, j));
      i = j + 1;
      continue;
    }
    // %VAR%
    if (str[i] === '%') {
      const j = str.indexOf('%', i + 1);
      if (j > i + 1) {
        const name = str.slice(i + 1, j);
        if (process.env[name] !== undefined) {
          out += process.env[name];
          i = j + 1;
          continue;
        }
      }
    }
    out += str[i++];
  }
  return out;
}

/** All VS Code-family "User" directories that can hold workspaceStorage. */
export function vscodeUserDirs() {
  const appData = isWin
    ? process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming')
    : PLATFORM === 'darwin'
      ? path.join(HOME, 'Library', 'Application Support')
      : process.env.XDG_CONFIG_HOME || path.join(HOME, '.config');

  const editors = [
    'Code',            // VS Code
    'Code - Insiders',
    'VSCodium',
    'Cursor',          // Cursor keeps a VS Code layout too
    'Windsurf',
    'Trae',
    'PearAI',
  ];
  return editors.map((e) => path.join(appData, e, 'User'));
}

/** VS Code's sibling data directory contains agent sessions and global storage. */
export function vscodeDataDirs() {
  return vscodeUserDirs().map((userDir) => path.dirname(userDir));
}

/** OS-native application-data roots (for `<app data>` templates). */
function appDataDirs() {
  if (isWin) return [process.env.APPDATA, process.env.LOCALAPPDATA].filter(Boolean);
  if (PLATFORM === 'darwin') {
    return [
      path.join(HOME, 'Library', 'Application Support'),
      path.join(HOME, 'Library', 'Preferences'),
    ];
  }
  return [
    process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share'),
    process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'),
  ];
}

/**
 * Placeholders that stand for *several* candidate directories. Each template is
 * expanded once per candidate, so the scanner probes all of them and keeps the
 * ones that exist.
 */
const PLACEHOLDERS = {
  '<vscode-User>': vscodeUserDirs,
  '<vscode-data>': vscodeDataDirs,
  '<vscode-globalStorage>': () => vscodeUserDirs().map((u) => path.join(u, 'globalStorage')),
  '<app data>': appDataDirs,
  '<appData>': appDataDirs,
};

/**
 * Expand a registry template into concrete absolute path patterns.
 * Multi-valued placeholders fan out; everything else is a string substitution.
 */
export function expandStorePath(template, { projectRoot } = {}) {
  // Registry entries include valid paths for multiple operating systems. Do
  // not turn a foreign default into a real-looking path under the current
  // user's home directory (for example C:\Users\name\Library on Windows).
  if (PLATFORM !== 'darwin' && /(?:^|[/\\])Library[/\\]/.test(template)) return [];
  if (
    PLATFORM === 'win32' &&
    /(?:^|[/\\])\.config[/\\]|(?:^|[/\\])\.local[/\\]/.test(template) &&
    process.env.XDG_CONFIG_HOME === undefined &&
    process.env.XDG_DATA_HOME === undefined
  ) return [];
  if (PLATFORM !== 'win32' && /%(?:APPDATA|LOCALAPPDATA)%/.test(template) && process.env.APPDATA === undefined && process.env.LOCALAPPDATA === undefined) return [];

  let patterns = [template];

  for (const [token, fn] of Object.entries(PLACEHOLDERS)) {
    if (!patterns.some((p) => p.includes(token))) continue;
    const values = fn();
    patterns = patterns.flatMap((p) => values.map((v) => p.split(token).join(v)));
  }

  // `<project>` is only meaningful when the caller named a project root.
  if (patterns.some((p) => p.includes('<project>'))) {
    if (!projectRoot) return [];
    patterns = patterns.map((p) => p.replaceAll('<project>', projectRoot));
  }

  return patterns
    .map((p) => expandTemplate(p))
    .filter((p) => !isMissing(p))
    .map((p) => (p.startsWith('~') ? path.join(HOME, p.slice(1)) : p))
    // node:fs glob patterns use POSIX separators even on Windows. Keep the
    // drive prefix intact while converting native separators for globbing.
    .map((p) => PLATFORM === 'win32' ? p.replace(/\\/g, '/') : path.normalize(p))
    .filter(Boolean)
    // Never glob from the filesystem root: a pattern whose only fixed prefix is
    // `/` would walk the whole disk.
    .filter((p) => {
      const wildcard = p.search(/[*?{[]/);
      if (wildcard === -1) return true;
      const fixedPrefix = p.slice(0, wildcard).replace(/\/$/, '');
      return fixedPrefix !== '' && fixedPrefix !== '';
    });
}

/**
 * Does this template contain a glob metacharacter? Used to decide whether a
 * literal path is a candidate file (stat it directly) or needs globbing.
 */
export function isGlob(pattern) {
  return /[*?{[]/.test(pattern);
}

/**
 * Recursive directory walk returning every regular file, dotfiles included.
 * Globs deliberately skip dotted names, which is exactly wrong for agent stores:
 * `.aider.chat.history.md` and `.system_generated/` are the interesting files.
 * The walk is bounded so a symlink loop cannot hang a scan.
 */
export function walkFiles(root, { maxDepth = 12, limit = 20000, maxEntries = 200000 } = {}) {
  const out = [];
  let entriesSeen = 0;
  const queue = [{ dir: root, depth: 0 }];

  while (queue.length && out.length < limit && entriesSeen < maxEntries) {
    const { dir, depth } = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      entriesSeen++;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) queue.push({ dir: full, depth: depth + 1 });
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}

/**
 * Probe a list of patterns and return the concrete existing files, de-duplicated.
 * Yields { file, pattern } so callers can report which template matched.
 * Never throws: an unreadable directory is simply not a match.
 */
export function globStorePaths(patterns, { limit = 20000 } = {}) {
  const seen = new Set();
  const out = [];

  for (const pattern of patterns) {
    let matches = [];
    try {
      if (isGlob(pattern)) {
        // withFileTypes lets us drop directories: a `**/*` pattern matches both,
        // and reading a directory as a transcript produces EISDIR noise.
        const dirents = fs.globSync(pattern, { withFileTypes: true });
        matches = dirents
          .filter((d) => d.isFile())
          .map((d) => (typeof d === 'string' ? d : join(parentOf(d.parentPath || d.path), d.name)));
      } else if (fs.existsSync(pattern) && fs.statSync(pattern).isFile()) {
        matches = [pattern];
      }
    } catch {
      matches = [];
    }
    for (const m of matches) {
      if (typeof m !== 'string') continue;
      if (seen.has(m)) continue;
      seen.add(m);
      out.push({ file: m, pattern });
      if (out.length >= limit) return out;
    }
  }
  return out;
}
