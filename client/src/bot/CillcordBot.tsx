// Server Settings → Integrations → Cillhub Bot (CONTRACT-v5 section 4): the built-in bot, added by a member with Manage Server.
import { useEffect, useState } from 'react'
import { addCillcordBot, cillcordBotStatus } from '../actions'
import { FormError } from '../components/ui'
import { t } from '../i18n'
import type { Guild } from '../types'
import './bot.css'

const COMMANDS = ['/roll', '/coinflip', '/remind', '/reminders', '/giveaway', '/scrim', '/lfg']

export function CillcordBotSection({ guild }: { guild: Guild }) {
  const [added, setAdded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => void cillcordBotStatus(guild.id).then((r) => setAdded(!!r?.installed), () => {}), [guild.id])
  const add = () => {
    setBusy(true)
    setError('')
    addCillcordBot(guild.id).then(() => (setAdded(true), setBusy(false)), (e: Error) => (setError(e.message), setBusy(false)))
  }
  return (
    <section className="bot-section" aria-labelledby="cillcord-bot-title">
      <span className="bot-avatar" aria-hidden="true">🤖</span>
      <div className="grow">
        <h2 id="cillcord-bot-title" className="sub-title">{t('Cillhub Bot')} <span className="bot-tag">{t('APP')}</span></h2>
        <p className="hint">{t('Built-in commands for your server: dice, reminders, giveaways, scrim rosters and looking-for-group posts. It runs inside this Cillhub server; no token leaves it.')}</p>
        <p className="small">{COMMANDS.map((c, i) => <span key={c}>{i ? ' ' : ''}<code>{c}</code></span>)}</p>
        {added ? <p className="success" role="status">{t('Cillhub Bot is in this server. Type / in a channel to use its commands.')}</p>
          : <div><button className="primary" disabled={busy} onClick={add}>{t('Add Cillhub Bot')}</button></div>}
        <FormError error={error} />
      </div>
    </section>
  )
}
