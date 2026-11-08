import { useEffect, useState } from 'react'
import { getCanvas, updateCanvas } from '../actions'
import { Icon, ICONS } from '../components/ui'
import { ResizeHandle } from '../components/ResizeHandle'
import { t } from '../i18n'
import { Markdown } from '../markdown/Markdown'
import { has, P } from '../permissions'
import { permsOf } from '../selectors'
import { displayName, setState, useStore } from '../store'
import type { Channel, ChannelCanvas } from '../types'
import { useMdContext } from '../chat/MessageList'

export function CanvasButton({ channel, perms: _perms }: { channel: Channel; perms: bigint }) {
  const open = useStore((s) => s.panel?.kind === 'canvas' && s.panel.channelId === channel.id)
  return (
    <button
      className={`icon-btn${open ? ' active' : ''}`}
      aria-label={t('Channel Canvas')}
      title={t('Channel Canvas')}
      aria-pressed={open}
      onClick={() => setState({ panel: open ? null : { kind: 'canvas', channelId: channel.id } })}
    >
      <Icon d={ICONS.canvas} />
    </button>
  )
}

export function CanvasPanel({ channelId }: { channelId: string }) {
  const channel = useStore((s) => s.channels[channelId])
  const guild = useStore((s) => (channel?.guild_id ? s.guilds[channel.guild_id] : undefined))
  const storeCanvas = useStore((s) => s.canvas[channelId])
  const perms = useStore((s) => (channel && s.me ? permsOf(s, channel.guild_id, channel) : 0n))
  const ctx = useMdContext(guild)

  const [canvas, setCanvas] = useState<ChannelCanvas | null>(storeCanvas ?? null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // Sync when store updates via CHANNEL_CANVAS_UPDATE
  useEffect(() => {
    if (storeCanvas) {
      setCanvas(storeCanvas)
      if (!editing) setDraft(storeCanvas.content)
    }
  }, [storeCanvas, editing])

  // Fetch initial
  useEffect(() => {
    getCanvas(channelId).then(
      (c) => {
        setCanvas(c)
        setDraft(c.content)
      },
      (err: Error) => setError(err.message),
    )
  }, [channelId])

  const canEdit = !channel?.guild_id || has(perms, P.SEND_MESSAGES)

  const handleSave = async () => {
    setSaving(true)
    setError('')
    try {
      const updated = await updateCanvas(channelId, draft)
      setCanvas(updated)
      setEditing(false)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const updatedByUser = useStore((s) => (canvas?.updated_by ? s.users[canvas.updated_by] : undefined))
  const authorName = updatedByUser ? displayName(updatedByUser) : canvas?.updated_by ? canvas.updated_by : null

  return (
    <aside className="side-panel canvas-panel" aria-label={t('Channel Canvas')}>
      <ResizeHandle
        id="canvas-panel-resizer"
        side="left"
        defaultValue={360}
        min={280}
        max={760}
        storageKey="cillhub:side-panel-width"
        cssVar="--side-panel-width"
        ariaLabel={t('Resize canvas panel')}
      />
      <div className="panel-header">
        <Icon d={ICONS.canvas} size={20} className="panel-icon" />
        <h2 className="panel-title ellipsis">{channel?.name ? `${channel.name} · ${t('Canvas')}` : t('Canvas')}</h2>
        <span className="spacer" />
        {canEdit && !editing && (
          <button className="secondary small-btn" onClick={() => { setDraft(canvas?.content ?? ''); setEditing(true) }}>
            <Icon d={ICONS.pencil} size={14} /> {t('Edit')}
          </button>
        )}
        <button className="icon-btn" aria-label={t('Close')} title={t('Close')} onClick={() => setState({ panel: null })}>
          <Icon d={ICONS.close} />
        </button>
      </div>

      {error && <p className="form-error" role="alert" style={{ margin: '8px 12px' }}>{error}</p>}

      <div className="canvas-body">
        {editing ? (
          <div className="canvas-editor">
            <textarea
              className="input textarea canvas-textarea"
              value={draft}
              maxLength={50000}
              placeholder={t('Write shared notes, guidelines, or resources in Markdown…')}
              onChange={(e) => setDraft(e.target.value)}
              aria-label={t('Canvas content')}
            />
            <div className="canvas-edit-footer">
              <span className="hint small">{draft.length}/50000</span>
              <div className="actions">
                <button className="secondary small-btn" disabled={saving} onClick={() => { setDraft(canvas?.content ?? ''); setEditing(false) }}>
                  {t('Cancel')}
                </button>
                <button className="primary small-btn" disabled={saving} onClick={() => void handleSave()}>
                  {saving ? t('Saving…') : t('Save')}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="canvas-view">
            {canvas?.content ? (
              <div className="markdown-body canvas-markdown">
                <Markdown content={canvas.content} ctx={ctx} />
              </div>
            ) : (
              <div className="canvas-empty">
                <Icon d={ICONS.canvas} size={48} className="empty-icon" />
                <h3>{t('No Canvas Notes Yet')}</h3>
                <p className="hint">{t('Use the canvas for persistent notes, links, task lists, and guides.')}</p>
                {canEdit && (
                  <button className="primary small-btn" onClick={() => { setDraft(''); setEditing(true) }}>
                    <Icon d={ICONS.pencil} size={14} /> {t('Create Canvas')}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {canvas && canvas.version > 0 && (
        <footer className="canvas-footer">
          <span className="hint small">
            {t('v{version}', { version: canvas.version })}
            {authorName && ` · ${t('Updated by {name}', { name: authorName })}`}
            {canvas.updated_at && ` · ${new Date(canvas.updated_at).toLocaleDateString()}`}
          </span>
        </footer>
      )}
    </aside>
  )
}
