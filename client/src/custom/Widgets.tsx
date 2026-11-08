// Profile widgets (CONTRACT-v6 section 2, Cillhub extra): Main game, Socials, Rank; shown in the full profile.
import { t } from '../i18n'
import type { ProfileWidget, SocialPlatform } from '../types'

/** Socials allowed on profiles (as the server checks them): https, no credentials or port, the platform's host with optional www./m. */
const SOCIAL_HOSTS: [string, SocialPlatform, string][] = [
  ['twitch.tv', 'twitch', 'Twitch'], ['youtube.com', 'youtube', 'YouTube'], ['youtu.be', 'youtube', 'YouTube'], ['x.com', 'x', 'X'], ['twitter.com', 'x', 'X'],
  ['instagram.com', 'instagram', 'Instagram'], ['tiktok.com', 'tiktok', 'TikTok'], ['steamcommunity.com', 'steam', 'Steam'], ['store.steampowered.com', 'steam', 'Steam'], ['faceit.com', 'faceit', 'FACEIT'],
]
const hostOf = (link: string) => {
  let u: URL
  try { u = new URL(link) } catch { return null }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null
  const host = u.hostname.toLowerCase().replace(/^(www|m)\./, '')
  return SOCIAL_HOSTS.find(([h]) => host === h) ?? null
}
/** The platform id of an allowed link, or null. */
export const platformOf = (link: string) => hostOf(link)?.[1] ?? null
/** The network name of an allowed link, or null. */
export const socialOf = (link: string) => hostOf(link)?.[2] ?? null
export const MAX_WIDGETS = 3

export function Widgets({ list }: { list?: ProfileWidget[] }) {
  if (!list?.length) return null
  return (
    <section className="pcard-section widgets" aria-label={t('Profile widgets')}>
      {list.slice(0, MAX_WIDGETS).map((w, i) => (
        <div key={i} className="widget">
          {w.type === 'main_game' && <><h3 className="list-heading">{t('Main game')}</h3><p className="widget-big">{w.game}</p></>}
          {w.type === 'rank' && <><h3 className="list-heading">{t('Rank')}</h3><p className="widget-big">{w.rank}</p><p className="hint small">{w.game}</p></>}
          {w.type === 'socials' && (
            <>
              <h3 className="list-heading">{t('Socials')}</h3>
              <ul className="widget-links">
                {w.links.filter((l) => socialOf(l.url)).map((l) => <li key={l.url}><a href={l.url} target="_blank" rel="noopener noreferrer nofollow">{socialOf(l.url)}<span className="sr-only"> ({l.url})</span></a></li>)}
              </ul>
            </>
          )}
        </div>
      ))}
    </section>
  )
}

if (import.meta.env.DEV) {
  console.assert(socialOf('https://www.twitch.tv/example') === 'Twitch' && platformOf('https://m.youtube.com/x') === 'youtube' && socialOf('http://twitch.tv/x') === null && socialOf('https://twitch.tv.evil.com/') === null && socialOf('https://evil.twitch.tv/') === null && socialOf('javascript:alert(1)') === null, 'social link validation')
}
