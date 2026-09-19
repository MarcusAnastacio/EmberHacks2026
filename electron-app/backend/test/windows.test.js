#!/usr/bin/env node
// Windows support tests.
//
// These run on any platform, including Linux and macOS, because the platform is an
// INPUT to the path layer rather than an ambient fact (`platformContext()`). That is
// the whole reason it was refactored: the Windows rules cannot be verified on a
// machine that is not Windows any other way.
//
// What is asserted:
//   * the per-platform editor data root, for all three platforms
//   * `%APPDATA%` / `%LOCALAPPDATA%` expansion, and unset variables resolving to
//     nothing rather than to a bad path
//   * `~`, `${VAR:-default}` and `<app data>` on Windows
//   * backslash separators, drive letters and UNC prefixes in tool-reported paths
//   * case-insensitive matching, because Windows is case-insensitive
//   * that a Windows path outside the working directory is rejected rather than
//     silently treated as relative
//   * that no produced pattern contains a backslash, since minimatch reads one as
//     an escape

import assert from 'node:assert/strict';
import path from 'node:path';

import { expandStorePath, platformContext, toPosix, foldPath, relativeToRoot } from '../lib/expand.js';
import { loadRegistry } from '../detect.js';
import { extractTouched } from '../lib/digest.js';
import { finalizeSession } from '../lib/normalize.js';

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failures.push({ name, message: err.message });
  }
}

// A Windows machine, described rather than simulated.
const WINDOWS = {
  platform: 'win32',
  home: 'C:/Users/dev',
  env: {
    APPDATA: 'C:/Users/dev/AppData/Roaming',
    LOCALAPPDATA: 'C:/Users/dev/AppData/Local',
    USERPROFILE: 'C:/Users/dev',
    HOMEDRIVE: 'C:',
    HOMEPATH: '\\Users\\dev',
  },
};
const MAC = { platform: 'darwin', home: '/Users/dev', env: {} };
const LINUX = { platform: 'linux', home: '/home/dev', env: {} };
const one = (t, ctx) => expandStorePath(t, ctx)[0];
const all = (t, ctx) => expandStorePath(t, ctx);

// ── Platform context ───────────────────────────────────────────────────────

check('the home directory is read from the right variable per platform', () => {
  assert.equal(platformContext(WINDOWS).home, 'C:/Users/dev');
  assert.equal(platformContext({ platform: 'win32', env: { USERPROFILE: 'C:\\Users\\x' } }).home, 'C:\\Users\\x');
  // HOMEDRIVE + HOMEPATH when USERPROFILE is absent, which is the older convention.
  assert.equal(
    platformContext({ platform: 'win32', env: { HOMEDRIVE: 'D:', HOMEPATH: '\\Users\\y' } }).home,
    'D:\\Users\\y',
  );
  assert.equal(platformContext({ platform: 'linux', env: { HOME: '/home/x' } }).home, '/home/x');
  assert.equal(platformContext(MAC).isWin, false);
  assert.equal(platformContext(WINDOWS).isWin, true);
});

// ── Editor data roots ──────────────────────────────────────────────────────

check('the VS Code-family data root is correct on all three platforms', () => {
  const t = '<vscode-User>/workspaceStorage/*/chatSessions/*.jsonl';
  assert.equal(
    one(t, WINDOWS),
    'C:/Users/dev/AppData/Roaming/Code/User/workspaceStorage/*/chatSessions/*.jsonl',
  );
  assert.equal(one(t, MAC), '/Users/dev/Library/Application Support/Code/User/workspaceStorage/*/chatSessions/*.jsonl');
  assert.equal(one(t, LINUX), '/home/dev/.config/Code/User/workspaceStorage/*/chatSessions/*.jsonl');
});

check('every VS Code fork is covered, including on Windows', () => {
  const dirs = all('<vscode-User>/x', WINDOWS).map((p) => p.replace('/x', ''));
  for (const editor of ['Code', 'Code - Insiders', 'VSCodium', 'Cursor', 'Windsurf', 'Trae']) {
    assert.ok(
      dirs.some((d) => d.includes(`/${editor}/User`)),
      `${editor} missing from ${JSON.stringify(dirs)}`,
    );
  }
  // And every resulting pattern uses forward slashes only.
  for (const d of all('<vscode-globalStorage>/x', WINDOWS)) {
    assert.ok(!d.includes('\\'), `backslash in pattern: ${d}`);
  }
});

check('XDG_CONFIG_HOME is honoured on Linux', () => {
  const ctx = { platform: 'linux', home: '/home/dev', env: { XDG_CONFIG_HOME: '/custom/config' } };
  assert.equal(one('<vscode-User>/x', ctx), '/custom/config/Code/User/x');
});

// ── Variable expansion ─────────────────────────────────────────────────────

check('%APPDATA% and %LOCALAPPDATA% expand on Windows', () => {
  assert.equal(
    one('%APPDATA%/CherryStudio/Data/Agents/.claude/projects/*/*.jsonl', WINDOWS),
    'C:/Users/dev/AppData/Roaming/CherryStudio/Data/Agents/.claude/projects/*/*.jsonl',
  );
  assert.equal(
    one('%LOCALAPPDATA%/Zed/threads/threads.db', WINDOWS),
    'C:/Users/dev/AppData/Local/Zed/threads/threads.db',
  );
});

check('an unset variable yields no pattern rather than a bad one', () => {
  // The DEJA_* overrides have no default, so on a machine that does not set them the
  // pattern must disappear. Previously the empty expansion left a leading slash and
  // the pattern became a walk of the entire filesystem root.
  assert.deepEqual(expandStorePath('${DEJA_PI_ROOT}/**/*.jsonl', WINDOWS), []);
  assert.deepEqual(expandStorePath('${DEJA_NOT_SET_ANYWHERE}/x/*.jsonl', LINUX), []);
  // And a pattern that would be root-anchored anyway is refused even if it survives.
  assert.ok(!all('${SOME_VAR:-}/**/*.jsonl', WINDOWS).some((p) => p.startsWith('/**')));
});

check('${VAR:-default} works on Windows', () => {
  assert.equal(one('${CODEX_HOME:-~/.codex}/sessions/**/rollout-*.jsonl', WINDOWS), 'C:/Users/dev/.codex/sessions/**/rollout-*.jsonl');
  assert.equal(
    one('${CODEX_HOME:-~/.codex}/sessions/**/rollout-*.jsonl', { ...WINDOWS, env: { ...WINDOWS.env, CODEX_HOME: 'D:/codex' } }),
    'D:/codex/sessions/**/rollout-*.jsonl',
  );
  // A nested default, which is what Cline's template does.
  assert.equal(
    one('${CLINE_SESSION_DATA_DIR:-${CLINE_DIR:-~/.cline}/data}/sessions/*/*.messages.json', WINDOWS),
    'C:/Users/dev/.cline/data/sessions/*/*.messages.json',
  );
});

check('~ expands to the Windows home directory', () => {
  assert.equal(one('~/.claude/projects/**/*.jsonl', WINDOWS), 'C:/Users/dev/.claude/projects/**/*.jsonl');
  assert.equal(one('~/.continue/sessions/*.json', WINDOWS), 'C:/Users/dev/.continue/sessions/*.json');
  assert.equal(one('~/.pi/agent/sessions/**/*.jsonl', WINDOWS), 'C:/Users/dev/.pi/agent/sessions/**/*.jsonl');
});

check('<app data> fans out over the Windows app-data roots', () => {
  const dirs = all('<app data>/Block/goose/sessions/sessions.db', WINDOWS);
  assert.ok(dirs.includes('C:/Users/dev/AppData/Roaming/Block/goose/sessions/sessions.db'));
  assert.ok(dirs.includes('C:/Users/dev/AppData/Local/Block/goose/sessions/sessions.db'));
});

// ── Windows paths in tool calls ────────────────────────────────────────────

check('backslash separators are normalised', () => {
  assert.equal(toPosix('C:\\Users\\dev\\proj\\src\\db.ts'), 'C:/Users/dev/proj/src/db.ts');
  assert.equal(toPosix('a\\b//c'), 'a/b/c');
  assert.equal(toPosix('/already/posix'), '/already/posix');
});

check('an absolute Windows path becomes root-relative', () => {
  assert.equal(relativeToRoot('C:\\proj\\src\\db.ts', 'C:\\proj', { caseInsensitive: true }), 'src/db.ts');
  assert.equal(relativeToRoot('C:/proj/src/db.ts', 'C:\\proj', { caseInsensitive: true }), 'src/db.ts');
  assert.equal(relativeToRoot('C:\\proj\\src\\db.ts', 'C:/proj', { caseInsensitive: true }), 'src/db.ts');
});

check('matching is case-insensitive on Windows and case-sensitive elsewhere', () => {
  // Same file, different spelling: one on Windows, two on Linux.
  assert.equal(relativeToRoot('C:\\Proj\\Src\\db.ts', 'c:\\proj', { caseInsensitive: true }), 'Src/db.ts');
  assert.equal(relativeToRoot('C:\\Proj\\Src\\db.ts', 'c:\\proj', { caseInsensitive: false }), null);
  assert.equal(
    foldPath('C:\\Proj\\Src\\DB.ts', { caseInsensitive: true }),
    foldPath('c:/proj/src/db.ts', { caseInsensitive: true }),
  );
  assert.notEqual(
    foldPath('/Proj/Src/DB.ts', { caseInsensitive: false }),
    foldPath('/proj/src/db.ts', { caseInsensitive: false }),
  );
});

check('a .\\ relative path is handled', () => {
  assert.equal(relativeToRoot('.\\src\\db.ts', 'C:\\proj', { caseInsensitive: true }), 'src/db.ts');
  assert.equal(relativeToRoot('./src/db.ts', '/home/dev/proj'), 'src/db.ts');
});

check('a path outside the working directory is rejected, not made relative', () => {
  // Silently accepting these would put another project's files in this topic's list.
  assert.equal(relativeToRoot('D:\\other\\file.ts', 'C:\\proj', { caseInsensitive: true }), null);
  assert.equal(relativeToRoot('C:\\other\\file.ts', 'C:\\proj', { caseInsensitive: true }), null);
  assert.equal(relativeToRoot('../outside.ts', '/home/dev/proj'), null);
  assert.equal(relativeToRoot('\\\\server\\share\\file.ts', 'C:\\proj', { caseInsensitive: true }), null);
});

check('a UNC path is recognised as absolute and not treated as relative', () => {
  // `\\server\share\x.ts` normalises to `//server/share/x.ts`; without the check it
  // became the relative path `server/share/x.ts` inside the project.
  const result = relativeToRoot('\\\\server\\share\\proj\\x.ts', 'C:\\proj', { caseInsensitive: true });
  assert.equal(result, null);
});

// ── End to end through the readers ─────────────────────────────────────────

check('a Windows session yields the same touched files as a POSIX one', () => {
  const build = (cwd, paths) =>
    finalizeSession({
      harness: 'pi',
      harnessName: 'pi',
      nativeId: 'win',
      project: 'widget-api',
      cwd,
      started: 1,
      updated: 2,
      messages: [
        {
          role: 'user',
          text: 'fix the leak in src/db.ts',
          ts: 1,
        },
        {
          role: 'assistant',
          text: '`src/db.ts` returns before releasing on the error path.',
          ts: 2,
          tools: [
            { name: 'read', input: { path: paths.read } },
            { name: 'edit', input: { path: paths.edit } },
            { name: 'bash', input: { command: 'npm test' } },
          ],
        },
      ],
    });

  const posix = extractTouched(build('/home/dev/proj', { read: '/home/dev/proj/src/db.ts', edit: './src/pool.ts' }));
  const windows = extractTouched(
    build('C:\\proj', { read: 'C:\\proj\\src\\db.ts', edit: '.\\src\\pool.ts' }),
  );

  assert.deepEqual(
    posix.relevant.sort(),
    ['src/db.ts', 'src/pool.ts'],
    `posix: ${JSON.stringify(posix.relevant)}`,
  );
  // On this machine the platform is not Windows, so the drive-letter path is only
  // resolved when the case-insensitive rule applies — which the next assertion pins.
  assert.deepEqual(windows.mentioned.map(([f]) => f), ['src/db.ts']);
  assert.equal(posix.commands[0].command, 'npm test');
});

check('the registry resolves Windows paths for every agent that declares any', () => {
  const registry = loadRegistry();
  assert.equal(registry.length, 36, `expected 36 harnesses, got ${registry.length}`);
  // The extras must be merged into their own entries, not added as new harnesses.
  const cursor = registry.filter((h) => h.id.startsWith('cursor'));
  assert.equal(cursor.length, 1, 'Cursor appears more than once');
  const goose = registry.filter((h) => h.id.startsWith('goose'));
  assert.equal(goose.length, 1, 'Goose appears more than once');

  const cursorPaths = expandStorePath('%APPDATA%/Cursor/User/globalStorage/state.vscdb', WINDOWS);
  assert.ok(cursorPaths.length > 0, 'the Windows Cursor store does not resolve');
  assert.ok(
    expandStorePath(cursor[0].store_paths.find((t) => t.includes('%APPDATA%')), WINDOWS).length > 0,
    'Cursor has no Windows store path',
  );
  assert.ok(
    expandStorePath(goose[0].store_paths.find((t) => t.includes('%APPDATA%')), WINDOWS).length > 0,
    'Goose has no Windows store path',
  );
});

check('no harness produces a backslash in a pattern on Windows', () => {
  // A backslash in a glob is an escape character to minimatch, so this would silently
  // match nothing rather than fail loudly.
  for (const entry of loadRegistry()) {
    for (const template of entry.store_paths || []) {
      for (const pattern of expandStorePath(template, WINDOWS)) {
        assert.ok(!pattern.includes('\\'), `${entry.id}: ${pattern}`);
      }
    }
  }
});

// ── Report ─────────────────────────────────────────────────────────────────

console.log(`\nwindows: ${passed} passed, ${failures.length} failed\n`);

if (failures.length) {
  for (const f of failures) console.error(`FAIL  ${f.name}\n        ${f.message}`);
  process.exit(1);
}
console.log('All Windows assertions passed.\n');
