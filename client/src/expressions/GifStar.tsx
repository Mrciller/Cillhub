// Star toggle for favourite GIFs (validated in server/src/userdata.js): on picker tiles and on GIFs in messages.
import { t } from '../i18n'
import { toggleFavoriteGif } from '../actions'
import { Icon, ICONS } from '../components/ui'
import { useStore } from '../store'
import type { FavoriteGif } from '../types'
import './expressions.css'

export function GifStar({ gif }: { gif: FavoriteGif }) {
  const on = useStore((s) => !!s.settings.favorite_gifs?.some((x) => x.url === gif.url))
  return (
    <button type="button" className="gif-star" aria-pressed={on} aria-label={t('Favorite GIF')} title={on ? t('Remove from favorites') : t('Add to favorites')}
      onClick={(e) => (e.stopPropagation(), void toggleFavoriteGif(gif))}>
      <Icon d={ICONS.star} size={18} />
    </button>
  )
}

/** A favourite as shown: a looping muted video for mp4/webm, otherwise an image. */
export const FavoriteMedia = ({ f, src }: { f: FavoriteGif; src: string }) =>
  f.format === 'mp4' || f.format === 'webm' ? <video src={src} autoPlay loop muted playsInline aria-hidden="true" /> : <img src={src} alt="" loading="lazy" />
