// Server invite links in a message: `<hub origin>/invite/<code>`, the only form the app's invite dialogs copy.
// Links to any other host never match, so no request ever goes to a host named in a message.
// No imports: scripts/invite-links.test.mjs runs this file under plain node.

// generated codes are 8 letters/digits, vanity codes 2-32 of a-z, 0-9, _ and -
const CODE = '[A-Za-z0-9_-]{2,32}'
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// the link starts the text or follows a space, `<` or `(`, so a hub URL inside another URL's query is no match
const linkRe = (origin: string) => new RegExp(`(?<![^\\s<(])${esc(origin.replace(/\/+$/, ''))}/invite/(${CODE})(?![\\w/-])`, 'gi')

/** Invite codes linked in `content`, each once, at most `max`. */
export function inviteCodes(content: string, origin: string, max = 3): string[] {
  if (!content?.includes('/invite/')) return []
  const codes: string[] = []
  for (const m of content.matchAll(linkRe(origin))) {
    if (!codes.includes(m[1])) codes.push(m[1])
    if (codes.length >= max) break
  }
  return codes
}

/** True when the message is nothing but one invite link (then the card replaces the text). */
export function onlyInvite(content: string, origin: string): boolean {
  const s = content?.trim().replace(/^<(.*)>$/, '$1') ?? ''
  return inviteCodes(s, origin).length === 1 && s.replace(linkRe(origin), '') === ''
}
