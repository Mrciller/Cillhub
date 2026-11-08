import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { openMessage, removeReminder } from '../actions'
import { dateTime } from '../appearance/format'
import { toastError } from '../components/dialogs'
import { Avatar, cls, FormError, Icon, ICONS, Modal } from '../components/ui'
import { t } from '../i18n'
import { setState, useStore } from '../store'
import type { SavedMessageFolder } from '../types'
import { reminderText } from '../scheduling/reminders'
import './saved-messages.css'

export function SavedMessages({ close }: { close?: () => void }) {
  const bookmarksMap = useStore((s) => s.bookmarks)
  const channels = useStore((s) => s.channels)
  const [folders, setFolders] = useState<SavedMessageFolder[]>([])
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null) // null = all
  const [selectedTag, setSelectedTag] = useState<string | null>(null)
  const [showCreateFolder, setShowCreateFolder] = useState(false)
  const [editingMsgTags, setEditingMsgTags] = useState<{ channelId: string; messageId: string; tags: string[] } | null>(null)

  const loadFolders = () => {
    api<SavedMessageFolder[]>('/users/@me/saved-folders')
      .then((res) => setFolders(Array.isArray(res) ? res : []))
      .catch(() => setFolders([]))
  }

  useEffect(() => {
    loadFolders()
  }, [])

  const bookmarksList = useMemo(() => {
    return Object.values(bookmarksMap).sort(
      (a, b) => Date.parse(b.save_data.saved_at) - Date.parse(a.save_data.saved_at),
    )
  }, [bookmarksMap])

  // Collect all available tags
  const allTags = useMemo(() => {
    const tags = new Set<string>()
    for (const b of bookmarksList) {
      const msgTags = b.save_data.tags ?? b.tags ?? []
      for (const t of msgTags) if (t) tags.add(t)
    }
    return Array.from(tags).sort()
  }, [bookmarksList])

  // Filter bookmarks by active folder and selected tag
  const filteredBookmarks = useMemo(() => {
    return bookmarksList.filter((b) => {
      const folderId = b.save_data.folder_id ?? b.folder_id ?? null
      if (activeFolderId !== null && folderId !== activeFolderId) {
        return false
      }
      if (selectedTag !== null) {
        const msgTags = b.save_data.tags ?? b.tags ?? []
        if (!msgTags.includes(selectedTag)) {
          return false
        }
      }
      return true
    })
  }, [bookmarksList, activeFolderId, selectedTag])

  const deleteFolder = (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    api(`/users/@me/saved-folders/${id}`, { method: 'DELETE' })
      .then(() => {
        if (activeFolderId === id) setActiveFolderId(null)
        setFolders((prev) => prev.filter((f) => f.id !== id))
      })
      .catch(toastError)
  }

  const changeMsgFolder = (msgId: string, folderId: string | null) => {
    api(`/users/@me/saved-messages/${msgId}`, {
      method: 'PATCH',
      body: { folder_id: folderId },
    })
      .then(() => {
        // Optimistically update store
        const k = Object.keys(bookmarksMap).find((key) => key.endsWith(`-${msgId}`))
        if (k && bookmarksMap[k]) {
          const updated = {
            ...bookmarksMap[k],
            folder_id: folderId,
            save_data: { ...bookmarksMap[k].save_data, folder_id: folderId },
          }
          setState((s) => ({
            bookmarks: { ...s.bookmarks, [k]: updated },
          }))
        }
      })
      .catch(toastError)
  }

  const saveTags = (msgId: string, tags: string[]) => {
    api(`/users/@me/saved-messages/${msgId}`, {
      method: 'PATCH',
      body: { tags },
    })
      .then(() => {
        const k = Object.keys(bookmarksMap).find((key) => key.endsWith(`-${msgId}`))
        if (k && bookmarksMap[k]) {
          const updated = {
            ...bookmarksMap[k],
            tags,
            save_data: { ...bookmarksMap[k].save_data, tags },
          }
          setState((s) => ({
            bookmarks: { ...s.bookmarks, [k]: updated },
          }))
        }
        setEditingMsgTags(null)
      })
      .catch(toastError)
  }

  return (
    <div className="saved-messages-container">
      <div className="saved-folders-sidebar">
        <div className="folders-sidebar-header">
          <span className="folders-sidebar-title">{t('Folders')}</span>
          <button
            className="icon-btn tiny"
            aria-label={t('Create Folder')}
            title={t('Create Folder')}
            onClick={() => setShowCreateFolder(true)}
          >
            <Icon d={ICONS.plus} size={16} />
          </button>
        </div>

        <ul className="folders-list">
          <li>
            <button
              className={cls('folder-item', activeFolderId === null && 'active')}
              onClick={() => setActiveFolderId(null)}
            >
              <Icon d={ICONS.bookmark} size={16} />
              <span className="folder-name ellipsis">{t('All Bookmarks')}</span>
              <span className="folder-count">{bookmarksList.length}</span>
            </button>
          </li>
          {folders.map((f) => {
            const count = bookmarksList.filter(
              (b) => (b.save_data.folder_id ?? b.folder_id) === f.id,
            ).length
            return (
              <li key={f.id}>
                <button
                  className={cls('folder-item', activeFolderId === f.id && 'active')}
                  onClick={() => setActiveFolderId(f.id)}
                >
                  <span
                    className="folder-color-dot"
                    style={{ background: f.color || 'var(--accent, #5865f2)' }}
                    aria-hidden="true"
                  />
                  <span className="folder-name ellipsis">{f.name}</span>
                  <span className="folder-count">{count}</span>
                  <button
                    className="icon-btn tiny folder-del-btn"
                    aria-label={t('Delete Folder')}
                    title={t('Delete Folder')}
                    onClick={(e) => deleteFolder(f.id, e)}
                  >
                    <Icon d={ICONS.trash} size={12} />
                  </button>
                </button>
              </li>
            )
          })}
        </ul>
      </div>

      <div className="saved-messages-main">
        {allTags.length > 0 && (
          <div className="tags-filter-bar">
            <span className="hint small tag-filter-label">{t('Tags:')}</span>
            <button
              className={cls('tag-pill', selectedTag === null && 'active')}
              onClick={() => setSelectedTag(null)}
            >
              {t('All')}
            </button>
            {allTags.map((tag) => (
              <button
                key={tag}
                className={cls('tag-pill', selectedTag === tag && 'active')}
                onClick={() => setSelectedTag(selectedTag === tag ? null : tag)}
              >
                #{tag}
              </button>
            ))}
          </div>
        )}

        {filteredBookmarks.length === 0 ? (
          <p className="hint inbox-empty">
            {bookmarksList.length === 0
              ? t('No bookmarks yet. Click the bookmark icon on any message to save it here.')
              : t('No bookmarks match the selected folder or tag.')}
          </p>
        ) : (
          <ul className="inbox-list" aria-label={t('Bookmarks')}>
            {filteredBookmarks.map((r) => {
              const { channel_id, message_id, guild_id } = r.save_data
              const channel = channels[channel_id]
              const currentFolderId = r.save_data.folder_id ?? r.folder_id ?? ''
              const currentTags = r.save_data.tags ?? r.tags ?? []

              return (
                <li key={`${channel_id}-${message_id}`} className="inbox-item saved-message-item">
                  <div className="inbox-where hint small">
                    {channel?.guild_id ? (channel.name ? `#${channel.name}` : '') : t('Direct Message')}
                  </div>
                  <div className="inbox-msg">
                    {r.message ? (
                      <Avatar user={r.message.author} size={32} />
                    ) : (
                      <Icon d={ICONS.bookmark} size={20} />
                    )}
                    <div className="inbox-text">
                      <div className="saved-msg-meta">
                        <span className="small">
                          <strong>{r.save_data.author_summary || r.message?.author?.username || ''}</strong>
                          <span className="hint small date-sep"> · {dateTime(r.save_data.saved_at)}</span>
                        </span>
                        {currentFolderId && (
                          <span className="saved-folder-badge">
                            {folders.find((f) => f.id === currentFolderId)?.name ?? t('Folder')}
                          </span>
                        )}
                      </div>
                      <p className="schedule-text">
                        {reminderText(r)}
                      </p>

                      <div className="saved-tags-row">
                        {currentTags.map((t) => (
                          <span key={t} className="msg-tag-chip">#{t}</span>
                        ))}
                        <button
                          className="msg-tag-add-btn"
                          title={t('Edit Tags')}
                          onClick={() =>
                            setEditingMsgTags({
                              channelId: channel_id,
                              messageId: message_id,
                              tags: [...currentTags],
                            })
                          }
                        >
                          <Icon d={ICONS.tag} size={12} />
                          <span>{currentTags.length > 0 ? t('Edit Tags') : t('+ Tag')}</span>
                        </button>
                      </div>
                    </div>

                    <div className="inbox-actions">
                      <select
                        className="folder-select"
                        value={currentFolderId}
                        aria-label={t('Assign to Folder')}
                        title={t('Folder')}
                        onChange={(e) => changeMsgFolder(message_id, e.target.value || null)}
                      >
                        <option value="">{t('No Folder')}</option>
                        {folders.map((f) => (
                          <option key={f.id} value={f.id}>{f.name}</option>
                        ))}
                      </select>

                      <button
                        className="secondary small-btn"
                        onClick={() => {
                          close?.()
                          void openMessage(channel_id, message_id, guild_id ?? r.message?.guild_id)
                        }}
                      >
                        {t('Jump')}
                      </button>
                      <button
                        className="icon-btn"
                        aria-label={t('Remove Bookmark')}
                        title={t('Remove Bookmark')}
                        onClick={() => void removeReminder(channel_id, message_id).catch(toastError)}
                      >
                        <Icon d={ICONS.close} size={16} />
                      </button>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {showCreateFolder && (
        <CreateFolderModal
          onClose={() => setShowCreateFolder(false)}
          onCreated={(newFolder) => {
            setFolders((prev) => [...prev, newFolder])
            setShowCreateFolder(false)
          }}
        />
      )}

      {editingMsgTags && (
        <EditTagsModal
          currentTags={editingMsgTags.tags}
          onClose={() => setEditingMsgTags(null)}
          onSave={(tags) => saveTags(editingMsgTags.messageId, tags)}
        />
      )}
    </div>
  )
}

function CreateFolderModal({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (folder: SavedMessageFolder) => void
}) {
  const [name, setName] = useState('')
  const [color, setColor] = useState('#5865f2')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const PRESET_COLORS = ['#5865f2', '#57f287', '#fee75c', '#eb459e', '#ed4245', '#00b0f4', '#f47b67']

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) {
      setError(t('Folder name is required'))
      return
    }
    setSaving(true)
    setError('')
    api<SavedMessageFolder>('/users/@me/saved-folders', {
      method: 'POST',
      body: { name: name.trim(), color },
    })
      .then((created) => {
        onCreated(created)
      })
      .catch((err: Error) => {
        setError(err.message)
        setSaving(false)
      })
  }

  return (
    <Modal title={t('Create Bookmark Folder')} onClose={onClose}>
      <form onSubmit={submit} className="folder-create-form">
        {error && <FormError error={error} />}
        <label className="field-label" htmlFor="folder-name-input">
          {t('Folder Name')}
        </label>
        <input
          id="folder-name-input"
          className="folder-name-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('e.g. Work, Memes, Important')}
          maxLength={64}
          autoFocus
        />

        <label className="field-label">{t('Folder Color')}</label>
        <div className="folder-colors-row">
          {PRESET_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={cls('folder-color-pick', color === c && 'selected')}
              style={{ background: c }}
              onClick={() => setColor(c)}
              aria-label={c}
            />
          ))}
        </div>

        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="submit" className="primary" disabled={saving || !name.trim()}>
            {t('Create Folder')}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function EditTagsModal({
  currentTags,
  onClose,
  onSave,
}: {
  currentTags: string[]
  onClose: () => void
  onSave: (tags: string[]) => void
}) {
  const [tagInput, setTagInput] = useState('')
  const [tags, setTags] = useState<string[]>(currentTags)

  const addTag = () => {
    const clean = tagInput.trim().replace(/^#/, '').toLowerCase()
    if (clean && !tags.includes(clean)) {
      setTags([...tags, clean])
      setTagInput('')
    }
  }

  const removeTag = (tToRemove: string) => {
    setTags(tags.filter((t) => t !== tToRemove))
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      addTag()
    }
  }

  return (
    <Modal title={t('Edit Bookmark Tags')} onClose={onClose}>
      <div className="edit-tags-form">
        <label className="field-label" htmlFor="tag-input">
          {t('Tags (press Enter to add)')}
        </label>
        <div className="tag-input-row">
          <input
            id="tag-input"
            className="tag-input"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('Add a tag…')}
            maxLength={32}
            autoFocus
          />
          <button type="button" className="secondary small-btn" onClick={addTag}>
            {t('Add')}
          </button>
        </div>

        <div className="tags-chips-container">
          {tags.map((tag) => (
            <span key={tag} className="tag-chip-editable">
              #{tag}
              <button
                type="button"
                className="tag-chip-remove"
                aria-label={t('Remove tag {tag}', { tag })}
                onClick={() => removeTag(tag)}
              >
                ×
              </button>
            </span>
          ))}
        </div>

        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="button" className="primary" onClick={() => onSave(tags)}>
            {t('Save Tags')}
          </button>
        </div>
      </div>
    </Modal>
  )
}
