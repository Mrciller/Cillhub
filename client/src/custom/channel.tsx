// Channel customization (CONTRACT-v6 section 3, channel docs icon_emoji / theme_color): emoji instead of # and a header accent strip.
import type { CSSProperties } from 'react'
import type { Channel } from '../types'
import { toHex } from './color'

/** Props for a channel header: the accent strip colour (decorative, so no contrast rule applies). */
export const headerAccent = (c: Channel) => (c.theme_color != null ? { className: 'chat-header accented', style: { '--channel-accent': toHex(c.theme_color) } as CSSProperties } : {})
/** The channel's own emoji, if it has one (custom emoji ids are not offered in the editor). */
export const ChannelEmoji = ({ c, className = 'chan-emoji' }: { c: Channel; className?: string }) =>
  c.icon_emoji?.name ? <span className={className} aria-hidden="true">{c.icon_emoji.name}</span> : null
