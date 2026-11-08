// Server directory page (/directory, hub only, CONTRACT-v7 §5): search, category and language filters, node badge and
// status, join (hub servers directly; node servers through the node sign-in, instances/nodes.ts) and report.
import { useEffect, useState } from 'react'
import { enterGuild } from '../actions'
import { cdn } from '../api'
import { askText, DialogHost, toast, toastError } from '../components/dialogs'
import { cls, FormError, initials } from '../components/ui'
import { intlLocale, t } from '../i18n'
import { joinOnNode, nodeInfo } from '../instances/nodes'
import { Link, navigate } from '../router'
import { useStore } from '../store'
import { categories, FALLBACK_CATEGORIES, joinListed, LANGUAGES, report, search, type Category, type Listing } from './api'
import './directory.css'

export function Directory() {
  const [cats, setCats] = useState<Category[]>(FALLBACK_CATEGORIES)
  const [text, setText] = useState('')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<number | undefined>()
  const [locale, setLocale] = useState('')
  const [list, setList] = useState<Listing[] | null>(null)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState('')
  useEffect(() => { document.title = `${t('Server Directory')} · Cillhub`; void categories().then(setCats) }, [])
  useEffect(() => {
    const id = setTimeout(() => setQuery(text.trim()), 300)
    return () => clearTimeout(id)
  }, [text])
  const load = (offset = 0) => {
    setError('')
    return search({ query, category_id: category, locale, offset }).then((r) => (setList((l) => (offset ? [...(l ?? []), ...r.guilds] : r.guilds)), setTotal(r.total)), (e: Error) => setError(e.message))
  }
  useEffect(() => void load(), [query, category, locale]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="directory">
      <header className="directory-head">
        <Link to="/channels/@me" className="secondary link-btn">{t('Back to Cillhub')}</Link>
        <h1>{t('Server Directory')}</h1>
        <p className="hint">{t('Public servers on this hub and on instances linked to it.')}</p>
        <div className="directory-filters" role="search">
          <label className="sr-only" htmlFor="dir-q">{t('Search servers')}</label>
          <input id="dir-q" className="input" type="search" placeholder={t('Search servers')} value={text} onChange={(e) => setText(e.target.value)} maxLength={100} />
          <label className="sr-only" htmlFor="dir-lang">{t('Language')}</label>
          <select id="dir-lang" className="input" value={locale} onChange={(e) => setLocale(e.target.value)}>
            <option value="">{t('All languages')}</option>
            {LANGUAGES.map(([v, n]) => <option key={v} value={v}>{n}</option>)}
          </select>
        </div>
        <div className="directory-cats" role="group" aria-label={t('Categories')}>
          <button className={cls('chip', category === undefined && 'on')} aria-pressed={category === undefined} onClick={() => setCategory(undefined)}>{t('All')}</button>
          {cats.map((c) => <button key={c.id} className={cls('chip', category === c.id && 'on')} aria-pressed={category === c.id} onClick={() => setCategory(c.id)}>{t(c.name)}</button>)}
        </div>
      </header>
      <main className="directory-main" aria-labelledby="dir-results" aria-busy={list === null}>
        <h2 id="dir-results" className="sr-only">{t('Results')}</h2>
        <FormError error={error} />
        {list && <p className="hint small" role="status">{total === 1 ? t('1 server') : t('{n} servers', { n: total.toLocaleString(intlLocale()) })}</p>}
        <ul className="directory-grid">
          {list?.map((g) => <Card key={g.id} g={g} cats={cats} />)}
        </ul>
        {list && list.length < total && <button className="secondary" onClick={() => void load(list.length)}>{t('Load more')}</button>}
        {list?.length === 0 && <p className="hint">{t('No servers match. Try another search or category.')}</p>}
      </main>
      <DialogHost />
    </div>
  )
}

const NODE_STATE: Record<string, string> = { active: 'Online', suspended: 'Suspended' }

function Card({ g, cats }: { g: Listing; cats: Category[] }) {
  const joined = useStore((s) => !!s.guilds[g.id])
  const [busy, setBusy] = useState(false)
  const icon = g.icon_url ? cdn(g.icon_url) : g.icon && !g.node ? cdn(`/icons/${g.id}/${g.icon}`) : null
  const banner = g.banner_url ? cdn(g.banner_url) : null
  const usable = !g.node || (g.node.status === 'active' && g.node.online)
  const nodeState = g.node ? (g.node.status !== 'active' ? t(NODE_STATE[g.node.status] ?? 'Suspended') : g.node.online ? t('Online') : t('Offline')) : ''
  const join = () => {
    if (joined) return navigate(`/channels/${g.id}`)
    setBusy(true)
    const done = g.node
      ? joinOnNode(nodeInfo(g.node), { guild: g.id })
      : joinListed(g.id).then((r) => (r?.channels ? enterGuild(r, undefined, true) : navigate(`/channels/${g.id}`)))
    done.catch(toastError).finally(() => setBusy(false))
  }
  const flag = () => void askText({ title: t('Report {name}', { name: g.name }), label: t('What is wrong with this listing?'), confirm: t('Report') })
    .then((reason) => void (reason?.trim() && report(g.id, reason.trim()).then(() => toast(t('Thanks. The hub admins will review this server.')), toastError)))
  const cat = cats.find((c) => c.id === g.primary_category_id)
  return (
    <li className="dir-card">
      <div className="dir-banner" style={banner ? { backgroundImage: `url("${banner}")` } : undefined} />
      <div className="dir-icon" aria-hidden="true">{icon ? <img src={icon} alt="" /> : initials(g.name, 3)}</div>
      <h3>{g.name}</h3>
      {g.node && (
        <p className={cls('dir-node', usable ? 'up' : 'down')}>
          <span className="node-chip" title={g.node.url}>{t('on {instance}', { instance: g.node.name })}</span> <span>· {nodeState}</span>
        </p>
      )}
      {g.description && <p className="dir-desc">{g.description}</p>}
      <ul className="dir-tags" aria-label={t('Tags')}>
        {cat && <li className="dir-cat">{t(cat.name)}</li>}
        {(g.keywords ?? []).slice(0, 5).map((k) => <li key={k}>{k}</li>)}
      </ul>
      <p className="hint small">
        {t(g.approximate_member_count === 1 ? '{n} Member' : '{n} Members', { n: g.approximate_member_count.toLocaleString(intlLocale()) })}
        {g.approximate_presence_count != null && <> · {t('{n} Online', { n: g.approximate_presence_count.toLocaleString(intlLocale()) })}</>}
        {' · '}{LANGUAGES.find(([v]) => v === g.preferred_locale)?.[1] ?? g.preferred_locale}
      </p>
      <div className="dir-actions">
        <button className="primary" disabled={busy || (!joined && !usable)} onClick={join} aria-label={joined ? t('Open {name}', { name: g.name }) : t('Join {name}', { name: g.name })}>
          {joined ? t('Open') : busy ? t('Joining…') : usable ? t('Join') : t('Unavailable')}
        </button>
        <button className="link" onClick={flag}>{t('Report')}</button>
      </div>
    </li>
  )
}
