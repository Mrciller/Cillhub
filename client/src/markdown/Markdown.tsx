// Chat Markdown rendered straight to React elements (never innerHTML), so content can't inject markup.
import { intlLocale, t } from '../i18n'
import { Fragment, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import { cdn } from '../api'
import { ask } from '../components/dialogs'
import { cls, Icon, ICONS } from '../components/ui'
import { Link } from '../router'
import { MotionImg, useEmojiMotion } from '../appearance/MotionImg'

export type MdContext = {
  user: (id: string) => string | undefined
  role: (id: string) => { name: string; color?: string } | undefined
  channel: (id: string) => { name: string; href: string } | undefined
}

type Rule = { re: RegExp; ok?: (src: string, i: number) => boolean; render: (m: RegExpExecArray, ctx: MdContext, key: number, depth: number) => ReactNode }

const safeUrl = (u: string) => {
  try {
    const url = new URL(u)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}
const link = (href: string, key: number) => {
  const url = safeUrl(href)
  return url ? <a key={key} href={url} target="_blank" rel="noopener noreferrer">{href}</a> : href
}
const wordBefore = (src: string, i: number) => i > 0 && /[\p{L}\p{N}]/u.test(src[i - 1])

/** CDN path of a custom emoji (CONTRACT-v3: /emojis/<id>.<png|gif|webp>). */
export const emojiUrl = (id: string, animated?: boolean) => cdn(`/emojis/${id}.${animated ? 'gif' : 'png'}`)
export function CustomEmoji({ id, name, animated, big }: { id: string; name: string; animated?: boolean; big?: boolean }) {
  const motion = useEmojiMotion()
  const props = { className: big ? 'emoji custom jumbo-emoji' : 'emoji custom', src: emojiUrl(id, animated), alt: `:${name}:`, title: `:${name}:`, draggable: false, loading: 'lazy' as const }
  return animated ? <MotionImg motion={motion} {...props} /> : <img {...props} />
}

/** Masked links show where they really go before leaving (a "Leaving Cillhub" dialog). */
function MaskedLink({ href, children }: { href: string; children: ReactNode }) {
  const open = (e: MouseEvent) => {
    e.preventDefault()
    void ask({
      title: t('Leaving Cillhub'),
      body: <><p>{t('This link is taking you to the following website')}</p><p className="leave-url">{href}</p><p className="hint">{t('Are you sure you want to go there?')}</p></>,
      confirm: t('Visit Site'),
    }).then((ok) => ok && window.open(href, '_blank', 'noopener,noreferrer'))
  }
  return <a href={href} target="_blank" rel="noopener noreferrer" onClick={open} title={href}>{children}</a>
}

// <t:unix:style> timestamps, all styles, through Intl.
const TS_STYLES: Record<string, Intl.DateTimeFormatOptions> = {
  t: { timeStyle: 'short' }, T: { timeStyle: 'medium' }, d: { dateStyle: 'short' }, D: { dateStyle: 'long' },
  f: { dateStyle: 'long', timeStyle: 'short' }, F: { dateStyle: 'full', timeStyle: 'short' },
}
export function relative(ms: number) {
  const diff = (ms - Date.now()) / 1000
  const units: [Intl.RelativeTimeFormatUnit, number][] = [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]]
  const [unit, size] = units.find(([, n]) => Math.abs(diff) >= n) ?? ['second', 1]
  return new Intl.RelativeTimeFormat(intlLocale(), { numeric: 'auto' }).format(Math.round(diff / size), unit)
}
export function formatTimestamp(unix: number, style = 'f') {
  const ms = unix * 1000
  return style === 'R' ? relative(ms) : new Intl.DateTimeFormat(intlLocale(), TS_STYLES[style] ?? TS_STYLES.f).format(ms)
}

function renderKatex(tex: string, displayMode: boolean, key: number): ReactNode {
  try {
    const html = katex.renderToString(tex, {
      displayMode,
      throwOnError: false,
      output: 'htmlAndMathml',
    })
    return <span key={key} className={displayMode ? 'md-katex-block' : 'md-katex-inline'} dangerouslySetInnerHTML={{ __html: html }} />
  } catch {
    return <code key={key} className="inline-code">{tex}</code>
  }
}

const RULES: Rule[] = [
  { re: /\\([^\p{L}\p{N}\s])/uy, render: (m) => m[1] },
  { re: /\$\$([\s\S]+?)\$\$/y, render: (m, _c, k) => renderKatex(m[1].trim(), true, k) },
  { re: /\$([^\$\n\r]+?)\$/y, render: (m, _c, k) => renderKatex(m[1].trim(), false, k) },
  { re: /(`+)([\s\S]*?[^`])\1(?!`)/y, render: (m, _c, k) => <code key={k} className="inline-code">{m[2].replace(/^ (.*) $/s, '$1')}</code> },
  { re: /<(https?:\/\/[^\s>]+)>/y, render: (m, _c, k) => link(m[1], k) },
  { re: /\[([^\[\]\n]+)\]\(<?(https?:\/\/[^\s)>]+)>?\)/y, render: (m, c, k, d) => {
    const url = safeUrl(m[2])
    return url ? <MaskedLink key={k} href={url}>{inline(m[1], c, d + 1)}</MaskedLink> : m[0]
  } },
  { re: /<(a?):(\w{2,32}):(\d+)>/y, render: (m, _c, k) => <CustomEmoji key={k} id={m[3]} name={m[2]} animated={!!m[1]} /> },
  { re: /<t:(-?\d{1,13})(?::([tTdDfFR]))?>/y, render: (m, _c, k) => {
    const unix = Number(m[1])
    if (!Number.isFinite(unix) || Math.abs(unix) > 8_640_000_000_000) return m[0]
    return <time key={k} className="md-time" dateTime={new Date(unix * 1000).toISOString()} title={formatTimestamp(unix, 'F')}>{formatTimestamp(unix, m[2])}</time>
  } },
  { re: /https?:\/\/[^\s<]+[^<.,:;"')\]\s]/y, ok: (s, i) => !wordBefore(s, i), render: (m, _c, k) => link(m[0], k) },
  { re: /<@!?(\d+)>/y, render: (m, c, k) => <span key={k} className="mention">@{c.user(m[1]) ?? t('unknown-user')}</span> },
  { re: /<@&(\d+)>/y, render: (m, c, k) => {
    const r = c.role(m[1])
    return <span key={k} className="mention" style={r?.color ? { color: r.color, background: r.color + '1a' } : undefined}>@{r?.name ?? t('deleted-role')}</span>
  } },
  { re: /<#(\d+)>/y, render: (m, c, k) => {
    const ch = c.channel(m[1])
    return ch ? <Link key={k} to={ch.href} className="mention">#{ch.name}</Link> : <span key={k} className="mention">#{t('unknown')}</span>
  } },
  { re: /@(everyone|here)(?![\p{L}\p{N}])/uy, ok: (s, i) => !wordBefore(s, i), render: (m, _c, k) => <span key={k} className="mention">{m[0]}</span> },
  { re: /\|\|([\s\S]+?)\|\|/y, render: (m, c, k, d) => <Spoiler key={k}>{inline(m[1], c, d + 1)}</Spoiler> },
  { re: /\*\*([\s\S]+?)\*\*(?!\*)/y, render: (m, c, k, d) => <strong key={k}>{inline(m[1], c, d + 1)}</strong> },
  { re: /__([\s\S]+?)__(?!_)/y, render: (m, c, k, d) => <u key={k}>{inline(m[1], c, d + 1)}</u> },
  { re: /\*(?=\S)([\s\S]*?\S)\*(?!\*)/y, render: (m, c, k, d) => <em key={k}>{inline(m[1], c, d + 1)}</em> },
  { re: /_([^_]+?)_(?![\p{L}\p{N}_])/uy, ok: (s, i) => !wordBefore(s, i), render: (m, c, k, d) => <em key={k}>{inline(m[1], c, d + 1)}</em> },
  { re: /~~([\s\S]+?)~~/y, render: (m, c, k, d) => <s key={k}>{inline(m[1], c, d + 1)}</s> },
]
const STARTERS = new Set('\\`<h@|*_~[$')

export function inline(src: string, ctx: MdContext, depth = 0): ReactNode[] {
  if (depth > 8) return [src]
  const out: ReactNode[] = []
  let buf = ''
  let i = 0
  scan: while (i < src.length) {
    if (STARTERS.has(src[i]))
      for (const rule of RULES) {
        rule.re.lastIndex = i
        const m = rule.re.exec(src)
        if (m && (!rule.ok || rule.ok(src, i))) {
          if (buf) out.push(buf), (buf = '')
          out.push(rule.render(m, ctx, out.length, depth))
          i += m[0].length
          continue scan
        }
      }
    buf += src[i++]
  }
  if (buf) out.push(buf)
  return out
}

type Line = { kind: 'text' | 'h1' | 'h2' | 'h3' | 'sub' | 'ul' | 'ol'; text: string; depth: number; n?: number }
/** Classifies a line: headers (#, ##, ###), subtext (-#), list items (-, *, 1.) indented by two spaces per level. */
function classify(line: string): Line {
  let m = /^(#{1,3}) (.+)$/.exec(line)
  if (m) return { kind: `h${m[1].length}` as Line['kind'], text: m[2], depth: 0 }
  if ((m = /^-# (.+)$/.exec(line))) return { kind: 'sub', text: m[1], depth: 0 }
  if ((m = /^( *)[-*] (.+)$/.exec(line))) return { kind: 'ul', text: m[2], depth: Math.min(2, m[1].length >> 1) }
  if ((m = /^( *)(\d{1,9})\. (.+)$/.exec(line))) return { kind: 'ol', text: m[3], depth: Math.min(2, m[1].length >> 1), n: +m[2] }
  return { kind: 'text', text: line, depth: 0 }
}

/** Nested lists from consecutive list lines. */
function list(items: Line[], ctx: MdContext, key: string): ReactNode {
  const out: ReactNode[] = []
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    const kids: Line[] = []
    while (items[i + 1] && items[i + 1].depth > it.depth) kids.push(items[++i])
    out.push(<li key={i}>{inline(it.text, ctx)}{kids.length > 0 && list(kids, ctx, `${key}-${i}`)}</li>)
  }
  const first = items[0]
  return first.kind === 'ol' ? <ol key={key} className="md-list" start={first.n}>{out}</ol> : <ul key={key} className="md-list">{out}</ul>
}

const TABLE_DELIM = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)+\|?\s*$/

function parseTableRow(raw: string): string[] {
  let s = raw.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  return s.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim())
}

function parseTableAlignments(raw: string): ('left' | 'center' | 'right' | undefined)[] {
  const cells = parseTableRow(raw)
  return cells.map((cell) => {
    const trimmed = cell.trim()
    const left = trimmed.startsWith(':')
    const right = trimmed.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    if (left) return 'left'
    return undefined
  })
}

function TableBlock({
  headers,
  alignments,
  rows,
  ctx,
}: {
  headers: string[]
  alignments: ('left' | 'center' | 'right' | undefined)[]
  rows: string[][]
  ctx: MdContext
}) {
  const [copied, setCopied] = useState(false)
  const copyCsv = (e: MouseEvent) => {
    e.stopPropagation()
    const escape = (val: string) => (/[",\n\r]/.test(val) ? `"${val.replace(/"/g, '""')}"` : val)
    const all = [headers, ...rows]
    const csv = all.map((row) => row.map(escape).join(',')).join('\r\n')
    void navigator.clipboard.writeText(csv).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    })
  }

  return (
    <div className="md-table-wrap">
      <button
        type="button"
        className="table-copy-btn"
        onClick={copyCsv}
        aria-label={t('Copy CSV')}
        title={copied ? t('Copied!') : t('Copy CSV')}
      >
        <Icon d={copied ? ICONS.check : ICONS.copy} size={12} />
        <span>{copied ? t('Copied!') : t('Copy CSV')}</span>
      </button>
      <table className="md-table">
        <thead>
          <tr>
            {headers.map((h, i) => (
              <th key={i} style={alignments[i] ? { textAlign: alignments[i] } : undefined}>
                {inline(h, ctx)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r}>
              {headers.map((_, c) => (
                <td key={c} style={alignments[c] ? { textAlign: alignments[c] } : undefined}>
                  {inline(row[c] ?? '', ctx)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Block quotes ("> " lines, or ">>> " for the rest of the message), headers, tables, subtext and lists around inline content. */
function blocks(src: string, ctx: MdContext, key: string, quoted = false): ReactNode[] {
  const out: ReactNode[] = []
  const lines = src.split('\n')
  let text: string[] = []
  let quote: string[] = []
  let items: Line[] = []
  const k = () => `${key}-${out.length}`
  const flushText = () => text.length && (out.push(<Fragment key={k()}>{inline(text.join('\n'), ctx)}</Fragment>), (text = []))
  const flushQuote = () => quote.length && (out.push(<blockquote key={k()}>{blocks(quote.join('\n'), ctx, k(), true)}</blockquote>), (quote = []))
  const flushList = () => items.length && (out.push(list(items, ctx, k())), (items = []))
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!quoted && line.startsWith('>>> ')) {
      flushText(), flushQuote(), flushList()
      quote = [line.slice(4), ...lines.slice(i + 1)]
      break
    }
    if (!quoted && (/^> /.test(line) || line === '>')) {
      flushText(), flushList()
      quote.push(line.slice(2))
      continue
    }
    flushQuote()
    if (!quoted && line.includes('|') && i + 1 < lines.length && TABLE_DELIM.test(lines[i + 1])) {
      flushText(), flushList()
      const headers = parseTableRow(line)
      const alignments = parseTableAlignments(lines[i + 1])
      const rows: string[][] = []
      let r = i + 2
      while (r < lines.length && lines[r].includes('|') && rows.length < 50) {
        rows.push(parseTableRow(lines[r]))
        r++
      }
      i = r - 1
      out.push(
        <TableBlock
          key={k()}
          headers={headers.slice(0, 20)}
          alignments={alignments.slice(0, 20)}
          rows={rows.map((row) => row.slice(0, 20))}
          ctx={ctx}
        />
      )
      continue
    }
    const c = classify(line)
    if (c.kind === 'ul' || c.kind === 'ol') {
      flushText()
      if (items.length && items[0].kind !== c.kind && c.depth === 0) flushList()
      items.push(c)
    } else if (c.kind === 'text') {
      flushList()
      text.push(line)
    } else {
      flushText(), flushList()
      const Tag = c.kind === 'sub' ? 'small' : c.kind
      out.push(<Tag key={k()} className={`md-${c.kind}`}>{inline(c.text, ctx)}</Tag>)
    }
  }
  flushText(), flushQuote(), flushList()
  return out
}

const FENCE = /```(?:([\w+#.-]+)\n)?\n?([\s\S]*?)```/g
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|️|‍|\s)+$/u

function CodeBlock({ lang, code }: { lang?: string; code: string }) {
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const lines = code.split('\n')
  const isDiff = lang === 'diff' || lang === 'patch'
  const isLong = lines.length > 25
  const visibleLines = isLong && !expanded ? lines.slice(0, 25) : lines

  const copy = (e: MouseEvent) => {
    e.stopPropagation()
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    }, () => {})
  }

  return (
    <pre className={cls('code-block', isLong && !expanded && 'collapsed')}>
      <span className="code-head" contentEditable={false}>
        <span className="code-lang">{lang || ''}</span>
        <span className="code-head-actions">
          {isLong && (
            <button
              type="button"
              className="code-expand-btn"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? t('Collapse') : t('Expand all ({n} lines)', { n: lines.length })}
            </button>
          )}
          <button type="button" className="code-copy" aria-label={t('Copy code')} title={copied ? t('Copied!') : t('Copy code')} onClick={copy}>
            <Icon d={copied ? ICONS.check : ICONS.copy} size={14} />
            <span>{copied ? t('Copied!') : t('Copy')}</span>
          </button>
        </span>
      </span>
      <code className="code-body">
        {visibleLines.map((line, i) => {
          let lineClass = 'code-line'
          if (isDiff) {
            if (line.startsWith('+') && !line.startsWith('+++')) lineClass += ' diff-add'
            else if (line.startsWith('-') && !line.startsWith('---')) lineClass += ' diff-del'
            else if (line.startsWith('@@')) lineClass += ' diff-hdr'
          }
          return (
            <span key={i} className={lineClass}>
              {lines.length >= 3 && <span className="code-ln" aria-hidden="true">{i + 1}</span>}
              <span className="code-content">{line || '\n'}</span>
            </span>
          )
        })}
      </code>
    </pre>
  )
}

export function Markdown({ content, ctx }: { content: string; ctx: MdContext }) {
  const out: ReactNode[] = []
  let last = 0
  for (const m of content.matchAll(FENCE)) {
    out.push(...blocks(content.slice(last, m.index), ctx, `b${out.length}`))
    out.push(<CodeBlock key={`c${out.length}`} lang={m[1]} code={m[2].replace(/\n$/, '')} />)
    last = m.index + m[0].length
    if (content[last] === '\n') last++ // the block already ends the line
  }
  out.push(...blocks(content.slice(last), ctx, `b${out.length}`))
  const plain = content.replace(/<a?:\w{2,32}:\d+>/g, '')
  const count = [...plain.matchAll(/\p{Extended_Pictographic}/gu)].length + (content.length - plain.length ? content.match(/<a?:\w{2,32}:\d+>/g)!.length : 0)
  const jumbo = (plain.trim() === '' || EMOJI_ONLY.test(plain)) && count > 0 && count <= 27
  return jumbo ? <span className="jumbo">{out}</span> : <>{out}</>
}

function Spoiler({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState(false)
  if (shown) return <span className="spoiler shown">{children}</span>
  const reveal = () => setShown(true)
  const key = (e: KeyboardEvent) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), reveal())
  return (
    <span className="spoiler" role="button" tabIndex={0} aria-label={t('Spoiler, press to reveal')} onClick={reveal} onKeyDown={key}>
      <span aria-hidden="true" inert>{children}</span>
    </span>
  )
}
