// Pure formatting helpers. No DOM, no state — safe to unit test.

/** Shorten for display. The backend derives real titles; this clamps them for rows. */
export function clamp(text, max = 20) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Relative time from an epoch-ms timestamp. */
export function timeAgo(ms) {
  if (!ms) return '';
  const days = Math.floor((Date.now() - ms) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/** Thousands-separated integer, for character counts. */
export function num(n) {
  return Number(n || 0).toLocaleString('en-US');
}
