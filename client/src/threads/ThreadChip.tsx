import { t } from '../i18n'
import { Icon, ICONS } from '../components/ui'
import { relative } from '../markdown/Markdown'
import { useStore } from '../store'
import type { Message } from '../types'
import { openThread, snowflakeTime } from './util'
import './threads.css'

/** Under a message that started a thread: the thread's name, message count and last activity; opens the thread panel. */
export function ThreadChip({ message }: { message: Message }) {
  const th = useStore((s) => (message.thread ? s.channels[message.thread.id] : undefined)) ?? message.thread
  if (!th) return null
  const count = th.message_count ?? 0
  return (
    <button className="thread-chip" onClick={() => openThread(th)} aria-label={t(count === 1 ? 'Open thread {name}, {n} message' : 'Open thread {name}, {n} messages', { name: th.name ?? '', n: count })}>
      <Icon d={ICONS.thread} size={16} />
      <span className="thread-chip-name ellipsis">{th.name}</span>
      <span className="thread-chip-count">{t(count === 1 ? '{n} Message' : '{n} Messages', { n: count })} ›</span>
      {th.last_message_id && <span className="hint small">{relative(snowflakeTime(th.last_message_id))}</span>}
    </button>
  )
}
