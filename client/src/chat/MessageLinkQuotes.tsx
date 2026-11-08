// Message Link Quotes: detects internal message links and unfurls an inline Quote Card
// with author, source channel, timestamp, message text snippet, optional thumbnail, and a Jump button.
import { useState, useEffect } from 'react'
import { t } from '../i18n'
import { api, cdn } from '../api'
import { useStore, getState } from '../store'
import { openMessage } from '../actions'
import { Avatar, Icon, ICONS } from '../components/ui'
import { Markdown, type MdContext } from '../markdown/Markdown'
import { stamp, useAuthor } from './MessageItem'
import type { Message, Channel } from '../types'

export const MSG_LINK_RE = /(?:https?:\/\/[^\s/]+)?\/channels\/([0-9]{1,19}|@me)\/([0-9]{1,19})\/([0-9]{1,19})/g

export function extractMessageLinks(content: string): Array<{ guildId: string; channelId: string; messageId: string }> {
  if (!content || !content.includes('/channels/')) return []
  const matches: Array<{ guildId: string; channelId: string; messageId: string }> = []
  const seen = new Set<string>()
  const re = new RegExp(MSG_LINK_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    const [, guildId, channelId, messageId] = m
    const key = `${channelId}/${messageId}`
    if (!seen.has(key)) {
      seen.add(key)
      matches.push({ guildId, channelId, messageId })
      if (matches.length >= 3) break // max 3 per message
    }
  }
  return matches
}

// In-memory cache for fetched quote messages across renders
const quoteCache = new Map<string, Promise<Message | null> | Message | null>()

function fetchQuoteMessage(channelId: string, messageId: string): Promise<Message | null> {
  const cached = quoteCache.get(messageId)
  if (cached !== undefined) {
    return cached instanceof Promise ? cached : Promise.resolve(cached)
  }
  const storeMsg = getState().messages[channelId]?.find((m) => m.id === messageId)
  if (storeMsg) {
    quoteCache.set(messageId, storeMsg)
    return Promise.resolve(storeMsg)
  }
  const p = api<Message>(`/channels/${channelId}/messages/${messageId}`)
    .then((msg) => {
      quoteCache.set(messageId, msg)
      return msg
    })
    .catch(() => {
      // 403 / 404 / deleted / inaccessible: cache null so we don't spam requests
      quoteCache.set(messageId, null)
      return null
    })
  quoteCache.set(messageId, p)
  return p
}

export function MessageQuoteCard({
  guildId,
  channelId,
  messageId,
  ctx,
}: {
  guildId: string
  channelId: string
  messageId: string
  ctx: MdContext
}) {
  const [msg, setMsg] = useState<Message | null>(() => {
    const cached = quoteCache.get(messageId)
    if (cached && !(cached instanceof Promise)) return cached
    const stored = getState().messages[channelId]?.find((m) => m.id === messageId)
    return stored ?? null
  })

  useEffect(() => {
    if (msg) return
    let active = true
    void fetchQuoteMessage(channelId, messageId).then((res) => {
      if (active && res) setMsg(res)
    })
    return () => {
      active = false
    }
  }, [channelId, messageId, msg])

  const channel: Channel | undefined = useStore((s) => s.channels[channelId])
  const author = useAuthor(msg ?? ({ id: '0', author: { id: '0', username: '...' } } as unknown as Message))

  if (!msg) return null

  const channelLabel = channel
    ? channel.type === 1
      ? `@${channel.name || 'DM'}`
      : `#${channel.name}`
    : null

  const imageAtt = msg.attachments?.find((a) => a.content_type?.startsWith('image/'))
  const snippet = msg.content
    ? msg.content.length > 300
      ? msg.content.slice(0, 300) + '…'
      : msg.content
    : ''

  return (
    <div className="message-quote-card">
      <span className="quote-spine" aria-hidden="true" />
      <div className="quote-body">
        <div className="quote-header">
          <Avatar user={author.user} size={16} />
          <span className="quote-author" style={{ color: author.color }}>
            {author.name}
          </span>
          {channelLabel && <span className="quote-channel">{channelLabel}</span>}
          <span className="quote-time">• {stamp(msg.timestamp)}</span>
          <button
            type="button"
            className="quote-jump-btn"
            aria-label={t('Jump to message from {name}', { name: author.name })}
            onClick={() => void openMessage(channelId, messageId, guildId)}
          >
            <Icon d={ICONS.forward} size={12} />
            <span>{t('Jump')}</span>
          </button>
        </div>
        {snippet ? (
          <div className="quote-content">
            <Markdown content={snippet} ctx={ctx} />
          </div>
        ) : msg.attachments?.length ? (
          <p className="hint small">
            <em>{t('Click to see attachment')}</em>
          </p>
        ) : null}
        {imageAtt && (
          <img
            className="quote-thumb"
            src={imageAtt.proxy_url ? cdn(imageAtt.proxy_url) : cdn(imageAtt.url)}
            alt=""
            loading="lazy"
          />
        )}
      </div>
    </div>
  )
}

export function MessageLinkQuotes({
  content,
  ctx,
}: {
  content?: string
  ctx: MdContext
}) {
  if (!content) return null
  const links = extractMessageLinks(content)
  if (!links.length) return null

  return (
    <div className="message-link-quotes">
      {links.map((l) => (
        <MessageQuoteCard
          key={`${l.channelId}-${l.messageId}`}
          guildId={l.guildId}
          channelId={l.channelId}
          messageId={l.messageId}
          ctx={ctx}
        />
      ))}
    </div>
  )
}
