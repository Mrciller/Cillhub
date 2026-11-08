// Cards of the built-in Cillhub Bot (CONTRACT-v5 section 4): giveaways, scrims and LFG posts are an embed plus buttons;
// they render as one card with the roster fields as tiles and a start/end time, the buttons below.
import { dateTime } from '../appearance/format'
import { MessageComponents } from '../components-ui/MessageComponents'
import { cls } from '../components/ui'
import { t } from '../i18n'
import { Markdown, type MdContext } from '../markdown/Markdown'
import type { Component, Message } from '../types'

type Kind = 'giveaway' | 'scrim' | 'lfg' | 'other'
const ids = (cs: Component[] = []): string[] => cs.flatMap((c) => [c.custom_id ?? '', ...ids(c.components)])

/** A Cillhub Bot message with an embed and components (the bot user is named "Cillhub"; older installs keep the username "cillcord"). */
export const isBotCard = (m: Message) => !!m.author.bot && /^(cillhub|cillcord)\b/i.test(m.author.username) && m.embeds.length > 0 && !!m.components?.length

function kindOf(m: Message): Kind {
  const text = `${ids(m.components).join(' ')} ${m.embeds[0]?.title ?? ''} ${m.interaction_metadata?.name ?? m.interaction?.name ?? ''}`
  return /giveaway/i.test(text) ? 'giveaway' : /scrim/i.test(text) ? 'scrim' : /\blfg\b|looking for group/i.test(text) ? 'lfg' : 'other'
}
const LABEL: Record<Kind, string> = { giveaway: 'Giveaway', scrim: 'Scrim', lfg: 'Looking for Group', other: 'Cillhub Bot' }
const ICON: Record<Kind, string> = { giveaway: '🎉', scrim: '⚔️', lfg: '🎮', other: '🤖' }

export function BotCard({ m, ctx }: { m: Message; ctx: MdContext }) {
  const e = m.embeds[0]
  const kind = kindOf(m)
  const when = e.timestamp ? Date.parse(e.timestamp) : NaN
  const future = when > Date.now()
  return (
    <article className={cls('bot-card', `bot-card-${kind}`)} aria-label={`${t(LABEL[kind])}: ${e.title ?? ''}`}>
      <header className="bot-card-head">
        <span className="bot-card-icon" aria-hidden="true">{ICON[kind]}</span>
        <div className="bot-card-titles">
          <span className="bot-card-kind">{t(LABEL[kind])}</span>
          {e.title && <h4 className="bot-card-title">{e.title}</h4>}
        </div>
        {!Number.isNaN(when) && (
          <time className={cls('bot-card-when', future && 'future')} dateTime={e.timestamp}>
            {kind === 'giveaway' ? (future ? t('Ends {time}', { time: dateTime(when) }) : t('Ended {time}', { time: dateTime(when) }))
              : kind === 'scrim' ? t('Starts {time}', { time: dateTime(when) }) : dateTime(when)}
          </time>
        )}
      </header>
      {e.description && <div className="bot-card-desc"><Markdown content={e.description} ctx={ctx} /></div>}
      {!!e.fields?.length && (
        <dl className="bot-card-fields">
          {e.fields.map((f, i) => (
            <div key={i} className={cls('bot-card-field', !f.inline && 'wide')}>
              <dt><Markdown content={f.name} ctx={ctx} /></dt>
              <dd><Markdown content={f.value} ctx={ctx} /></dd>
            </div>
          ))}
        </dl>
      )}
      <MessageComponents m={m} />
      {e.footer?.text && <footer className="bot-card-foot hint small">{e.footer.text}</footer>}
    </article>
  )
}
