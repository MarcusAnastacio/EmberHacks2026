// Harnesses that are not in the vendored deja-vu registry (MIT), or that we
// want to reach differently. Kept separate so `registry.json` stays a clean
// upstream drop-in that can be refreshed.

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
  },
  {
    // Windsurf Cascade writes protobuf blobs. We can prove the store exists and
    // how much of it there is, which is what the sidebar needs, but decoding
    // needs the .proto definition. Detected, not parsed — stated honestly.
    id: 'windsurf',
    display_name: 'Windsurf Cascade',
    format_kind: 'detect-only',
    store_paths: ['~/.codeium/windsurf/cascade/*'],
    last_verified: 'manual',
    note: 'Protobuf-encoded; detected but not decoded.',
  },
];

/**
 * Registry entries we deliberately do not walk. Cursor's IDE database is
 * covered by the `cursor` entry, and `.crush`/`.vscode-mock` fixtures are
 * test-only paths.
 */
export const IGNORED_PATHS = [
  '~/.vscode-mock/**',
];
