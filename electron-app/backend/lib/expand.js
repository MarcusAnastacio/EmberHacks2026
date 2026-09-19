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

/**
 * The platform is an INPUT, not an ambient fact.
 *
 * Every Windows-specific rule here is reachable from a test by passing
 * `{ platform: 'win32', env: {...} }`, which is the only way to verify this code
 * without a Windows machine. Anything that reads `process.platform` directly is
 * untestable, so nothing below does.
 */
export function platformContext(overrides = {}) {
  const platform = overrides.platform || process.platform;
  const env = overrides.env || process.env;
  const isWin = platform === 'win32';
  const home =
    overrides.home ||
    (isWin
      ? env.USERPROFILE || (env.HOMEDRIVE && env.HOMEPATH ? `${env.HOMEDRIVE}${env.HOMEPATH}` : null)
      : env.HOME) ||
    os.homedir();
  return { platform, env, isWin, home, darwin: platform === 'darwin' };
}

/**
 * Normalise separators to forward slashes.
 *
 * Every path this module produces is normalised, including on Windows. Windows
 * accepts `/` in every filesystem call, whereas a glob pattern containing a
 * backslash is ambiguous — minimatch treats it as an escape — so a
 * mixed-separator glob pattern is the risky form, not a forward-slash one.
 */
export function toPosix(p) {
  return String(p).replace(/\\/g, '/').replace(/\/+/g, '/');
}

/**
 * Fold a path for comparison.
 *
 * Separators are normalised always, and the result is lowercased on Windows because
 * its filesystem is case-insensitive: a tool that reports `C:\Proj\Src\db.ts`
 * refers to the same file as a transcript that recorded `c:\proj\src\db.ts`, and
 * exact matching treated them as different files.
 */
export function foldPath(value, { caseInsensitive = process.platform === 'win32' } = {}) {
  const posix = toPosix(value);
  return caseInsensitive ? posix.toLowerCase() : posix;
}

/**
 * Make a tool-reported path relative to the session's working directory.
 *
 * Handles the forms an agent actually emits: an absolute POSIX path, a Windows path
 * with a drive letter or a UNC prefix, a `./` or `.\` relative path, and a bare
 * relative path. Returns null when the value does not look like a path in this repo
 * at all.
 */
export function relativeToRoot(value, root, options = {}) {
  if (typeof value !== 'string') return null;
  let p = value.trim().replace(/^["']|["']$/g, '');
  if (!p || p.length > 400 || /[\n\r]/.test(p)) return null;

  const folded = foldPath(p, options);
  const foldedRoot = root ? foldPath(toPosix(root).replace(/\/+$/, ''), options) : null;

  if (foldedRoot && folded.startsWith(`${foldedRoot}/`)) {
    // Drop the root and the separator that joined it to the remainder, so what is
    // left is relative rather than a path starting with `/`.
    p = p.slice(root.replace(/[\\/]+$/, '').length).replace(/^[\\/]+/, '');
  } else if (foldedRoot && folded === foldedRoot) {
    return null;
  }

  // Absolute-ness is checked BEFORE leading separators are stripped. Otherwise a UNC
  // path (`\\\\server\\share\\file.ts`, which normalises to `//server/share/file.ts`)
  // lost its leading slashes and became the relative path `server/share/file.ts`
  // inside the project.
  if (/^[\\/]/.test(p) || /^[A-Za-z]:[\\/]/.test(p)) return null;

  p = p.replace(/^[.][\\/]/, '');
  if (!p || p === '.' || p.startsWith('..')) return null;
  return toPosix(p);
}

/**
 * Concrete per-OS roots, surfaced through the catalog so the UI can say where it is
 * looking. Kept from the frontend branch, but taking a context so it is testable:
 * the ambient version could only be exercised on the platform it was written for.
 */
export function platformRoots(overrides = {}) {
  const ctx = platformContext(overrides);
  if (ctx.isWin) {
    return {
      home: ctx.home,
      appData: ctx.env.APPDATA || path.join(ctx.home, 'AppData', 'Roaming'),
      localAppData: ctx.env.LOCALAPPDATA || path.join(ctx.home, 'AppData', 'Local'),
      config: ctx.env.APPDATA || path.join(ctx.home, 'AppData', 'Roaming'),
      data: ctx.env.LOCALAPPDATA || path.join(ctx.home, 'AppData', 'Local'),
    };
  }
  if (ctx.darwin) {
    return {
      home: ctx.home,
      appData: path.join(ctx.home, 'Library', 'Application Support'),
      localAppData: path.join(ctx.home, 'Library', 'Caches'),
      config: path.join(ctx.home, 'Library', 'Preferences'),
      data: path.join(ctx.home, 'Library', 'Application Support'),
    };
  }
  return {
    home: ctx.home,
    appData: ctx.env.XDG_DATA_HOME || path.join(ctx.home, '.local', 'share'),
    localAppData: path.join(ctx.home, '.cache'),
    config: ctx.env.XDG_CONFIG_HOME || path.join(ctx.home, '.config'),
    data: ctx.env.XDG_DATA_HOME || path.join(ctx.home, '.local', 'share'),
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
function resolveVar(raw, ctx) {
  const sep = raw.indexOf(':-');
  const name = (sep === -1 ? raw : raw.slice(0, sep)).trim();
  const fallback = sep === -1 ? '' : raw.slice(sep + 2);
  const value = ctx.env[name];
  if (value !== undefined && value !== '') return value;
  // The fallback may itself contain templates, so recurse.
  if (fallback) {
    const resolved = expandTemplate(fallback, ctx);
    return isMissing(resolved) ? MISSING : resolved;
  }
  return MISSING;
}

/** Replace every ${...} and %VAR% in a string (single-valued). */
export function expandTemplate(str, ctx = platformContext()) {
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
      out += resolveVar(str.slice(i + 2, j), ctx);
      i = j + 1;
      continue;
    }
    // %VAR%
    if (str[i] === '%') {
      const j = str.indexOf('%', i + 1);
      if (j > i + 1) {
        const name = str.slice(i + 1, j);
        if (ctx.env[name] !== undefined) {
          out += ctx.env[name];
          i = j + 1;
          continue;
        }
      }
    }
    out += str[i++];
  }
  return out;
}

/**
 * Where VS Code and its forks keep their per-editor data, per platform.
 *
 *   Windows   %APPDATA%                      (C:\Users\me\AppData\Roaming)
 *   macOS     ~/Library/Application Support
 *   Linux     $XDG_CONFIG_HOME or ~/.config
 */
function editorDataRoot(ctx) {
  if (ctx.isWin) return ctx.env.APPDATA || path.join(ctx.home, 'AppData', 'Roaming');
  if (ctx.darwin) return path.join(ctx.home, 'Library', 'Application Support');
  return ctx.env.XDG_CONFIG_HOME || path.join(ctx.home, '.config');
}

/** All VS Code-family "User" directories that can hold workspaceStorage. */
export function vscodeUserDirs(overrides = {}) {
  const ctx = platformContext(overrides);
  const appData = editorDataRoot(ctx);

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
export function vscodeDataDirs(overrides = {}) {
  return vscodeUserDirs(overrides).map((userDir) => path.dirname(userDir));
}

/**
 * Where a native app keeps its data, per platform. `<app data>` templates expand to
 * every candidate, and the ones that do not exist are simply not matched.
 */
function appDataDirs(ctx) {
  if (ctx.isWin) {
    return [ctx.env.APPDATA, ctx.env.LOCALAPPDATA].filter(Boolean);
  }
  if (ctx.darwin) {
    return [
      path.join(ctx.home, 'Library', 'Application Support'),
      path.join(ctx.home, 'Library', 'Preferences'),
    ];
  }
  return [
    ctx.env.XDG_DATA_HOME || path.join(ctx.home, '.local', 'share'),
    ctx.env.XDG_CONFIG_HOME || path.join(ctx.home, '.config'),
  ];
}

const PLACEHOLDERS = {
  '<vscode-User>': (ctx) => vscodeUserDirs(ctx),
  // From the frontend branch: the sibling of `User` on disk, which holds
  // `agentSessionData` and some extensions' session stores.
  '<vscode-data>': (ctx) => vscodeDataDirs(ctx),
  '<vscode-globalStorage>': (ctx) => vscodeUserDirs(ctx).map((u) => path.join(u, 'globalStorage')),
  '<app data>': (ctx) => appDataDirs(ctx),
  '<appData>': (ctx) => appDataDirs(ctx),
};

/**
 * Expand a registry template into concrete absolute path patterns.
 * Multi-valued placeholders fan out; everything else is a string substitution.
 */
export function expandStorePath(template, { projectRoot, ...overrides } = {}) {
  const ctx = platformContext(overrides);

  // A registry entry lists valid paths for several operating systems, so a template
  // that belongs to another one must not be turned into a plausible-looking path under
  // the wrong home directory — `C:\Users\me\Library` on Windows. Skipping it early
  // also saves a glob that could only ever return nothing.
  //
  // Kept from the frontend branch, but driven by `ctx` rather than the ambient
  // platform and environment so the Windows rules stay testable off Windows.
  if (!ctx.darwin && /(?:^|[/\\])Library[/\\]/.test(template)) return [];
  if (
    ctx.isWin &&
    /(?:^|[/\\])\.config[/\\]|(?:^|[/\\])\.local[/\\]/.test(template) &&
    ctx.env.XDG_CONFIG_HOME === undefined &&
    ctx.env.XDG_DATA_HOME === undefined
  ) {
    return [];
  }
  if (
    !ctx.isWin &&
    /%(?:APPDATA|LOCALAPPDATA)%/.test(template) &&
    ctx.env.APPDATA === undefined &&
    ctx.env.LOCALAPPDATA === undefined
  ) {
    return [];
  }

  let patterns = [template];

  for (const [token, fn] of Object.entries(PLACEHOLDERS)) {
    if (!patterns.some((p) => p.includes(token))) continue;
    const values = fn(ctx);
    patterns = patterns.flatMap((p) => values.map((v) => p.split(token).join(v)));
  }

  // `<project>` is only meaningful when the caller named a project root.
  if (patterns.some((p) => p.includes('<project>'))) {
    if (!projectRoot) return [];
    patterns = patterns.map((p) => p.replaceAll('<project>', projectRoot));
  }

  return patterns
    .map((p) => expandTemplate(p, ctx))
    .filter((p) => !isMissing(p))
    .map((p) => (p.startsWith('~') ? path.join(ctx.home, p.slice(1)) : p))
    // Glob patterns use POSIX separators even on Windows, and a backslash in a glob is
    // an escape character to minimatch, so every pattern is normalised.
    .map(toPosix)
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
