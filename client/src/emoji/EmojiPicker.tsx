import type { EmojiRef } from '../actions'
import type { Anchor } from '../components/menu'
import { ExpressionPicker } from '../expressions/ExpressionPicker'
import { P } from '../permissions'

/**
 * Emoji-only picker (reactions, forum tags, welcome screen). Custom emoji are offered when `guildId` is given;
 * `onPick` gets the text form (Unicode char or `<:name:id>`) and the emoji reference.
 */
export function EmojiPicker({ at, onPick, onClose, guildId, perms = P.USE_EXTERNAL_EMOJIS }: { at: Anchor; onPick: (emoji: string, ref: EmojiRef) => void; onClose: () => void; guildId?: string; perms?: bigint }) {
  return <ExpressionPicker at={at} onClose={onClose} guildId={guildId} perms={guildId ? perms : 0n} onEmoji={onPick} />
}
