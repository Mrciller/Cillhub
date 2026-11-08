// Parses the web client's title: "(N) …" = N mentions, "• …" = unread without count, else 0.
// Returns a number of mentions, -1 for "unread, no count", or 0.
function parseUnread(title) {
  const m = /^\s*\((\d+\+?)\)/.exec(title || '');
  if (m) return parseInt(m[1], 10) || 0;
  return /^\s*[•●]/.test(title || '') ? -1 : 0;
}
module.exports = { parseUnread };
