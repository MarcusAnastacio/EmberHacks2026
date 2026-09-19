// Harnesses that are not in the vendored deja-vu registry (MIT), or that we want to
// reach differently. Kept separate so `registry.json` stays a clean upstream
// drop-in that can be refreshed with a single file copy.

/**
 * Extra store paths for agents the registry already lists, keyed by harness id.
 *
 * These are MERGED into the existing entry rather than added as separate harnesses.
 * Two entries for Cursor would render as two rows in the sidebar with the same name,
 * which reads as a bug even when the paths are correct.
 *
 * The registry carries macOS and Linux locations for these agents; on Windows both
 * live under %APPDATA%, which nothing covered. A template that cannot match on the
 * current platform costs one glob that returns nothing, so listing a Windows path
 * while running on Linux is harmless.
 */
export const EXTRA_STORE_PATHS = {
  cursor: ['%APPDATA%/Cursor/User/{globalStorage,workspaceStorage/*}/state.vscdb'],
  goose: [
    '%APPDATA%/Block/goose/sessions/sessions.db',
    '%APPDATA%/Block/goose/sessions/*.jsonl',
    '%LOCALAPPDATA%/Block/goose/sessions/sessions.db',
    '%APPDATA%/goose/sessions/sessions.db',
  ],
  // Windsurf's Cursor-derived layout on Windows, in addition to ~/.codeium.
  windsurf: ['%APPDATA%/Windsurf/User/globalStorage/state.vscdb'],
};

export const EXTRA_HARNESSES = [
  {
    id: 'chatgpt',
    display_name: 'ChatGPT',
    format_kind: 'chatgpt-export',
    store_paths: [
      '${CHATGPT_EXPORT_DIR}/**/conversations.json',
      '${DEJA_CHATGPT_ROOT}/**/conversations.json',
    ],
    last_verified: 'manual',
    note: 'Reads the official "Export data" file; there is no local store.',
  },
  {
    id: 'claude-web',
    display_name: 'Claude (web export)',
    format_kind: 'claude-web-export',
    store_paths: [
      '${CLAUDE_EXPORT_DIR}/**/conversations.jsonl',
      '${DEJA_CLAUDE_WEB_ROOT}/**/conversations.jsonl',
    ],
    last_verified: 'manual',
    note: 'Reads the official "Export data" file; there is no local store.',
  },
  {
    // Windsurf Cascade writes protobuf blobs. We can prove the store exists and how
    // much of it there is, which is what the sidebar needs, but decoding needs the
    // .proto definition. Detected, not parsed — stated honestly.
    id: 'windsurf',
    display_name: 'Windsurf Cascade',
    format_kind: 'detect-only',
    store_paths: ['~/.codeium/windsurf/cascade/*'],
    last_verified: 'manual',
    note: 'Protobuf-encoded; detected but not decoded.',
  },
];
