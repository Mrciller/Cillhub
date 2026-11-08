// Forum tags: chips, the toggle picker used by "New Post", and the "Edit Tags" dialog for a post.
import { t } from '../i18n'
import { useState } from 'react'
import { toastError } from '../components/dialogs'
import { cls, Modal } from '../components/ui'
import { CustomEmoji } from '../markdown/Markdown'
import type { Channel, ForumTag } from '../types'
import './forum.css'

export function TagEmoji({ tag }: { tag: Pick<ForumTag, 'emoji_id' | 'emoji_name'> }) {
  if (tag.emoji_id) return <CustomEmoji id={tag.emoji_id} name={tag.emoji_name ?? 'emoji'} />
  return tag.emoji_name ? <span className="tag-emoji" aria-hidden="true">{tag.emoji_name}</span> : null
}

export const TagChip = ({ tag }: { tag: ForumTag }) => (
  <span className="forum-tag"><TagEmoji tag={tag} />{tag.name}</span>
)

/** Toggle buttons for a forum's tags; moderated tags need MANAGE_THREADS. Max 5 per post (docs). */
export function TagPicker({ tags, selected, onChange, canModerate, label }: { tags: ForumTag[]; selected: string[]; onChange: (ids: string[]) => void; canModerate: boolean; label: string }) {
  return (
    <div className="tag-picker" role="group" aria-label={label}>
      {tags.map((t) => {
        const on = selected.includes(t.id)
        return (
          <button key={t.id} type="button" className={cls('forum-tag toggle', on && 'on')} aria-pressed={on}
            disabled={(t.moderated && !canModerate) || (!on && selected.length >= 5)}
            onClick={() => onChange(on ? selected.filter((x) => x !== t.id) : [...selected, t.id])}>
            <TagEmoji tag={t} />{t.name}
          </button>
        )
      })}
    </div>
  )
}

export function TagPickerModal({ forum, selected, canModerate, onSave, onClose }: { forum: Channel; selected: string[]; canModerate: boolean; onSave: (ids: string[]) => Promise<unknown>; onClose: () => void }) {
  const [ids, setIds] = useState(selected)
  const required = !!((forum.flags ?? 0) & (1 << 4))
  return (
    <Modal title={t('Edit Tags')} onClose={onClose}>
      <TagPicker tags={forum.available_tags ?? []} selected={ids} onChange={setIds} canModerate={canModerate} label={t('Post tags')} />
      {required && !ids.length && <p className="hint small">{t('This forum requires at least one tag.')}</p>}
      <div className="modal-actions">
        <button className="secondary" onClick={onClose}>{t('Cancel')}</button>
        <button className="primary" disabled={required && !ids.length} onClick={() => onSave(ids).then(onClose, toastError)}>{t('Save')}</button>
      </div>
    </Modal>
  )
}
