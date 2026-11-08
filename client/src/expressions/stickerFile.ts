// Prepares a sticker image for upload: stickers are at most 320x320 and 512 KiB (server rule, per the API reference).
// Static images are scaled down to fit and re-encoded; animated ones can't be resized here without losing frames.
const SIDE = 320
const MAX_BYTES = 512 * 1024
const ascii = (b: Uint8Array) => new TextDecoder('latin1').decode(b)

/** GIF with more than one frame, APNG (acTL chunk) or animated WebP (ANIM chunk). */
export function isAnimated(type: string, head: Uint8Array) {
  const s = ascii(head)
  if (type === 'image/gif') return s.includes('NETSCAPE2.0') || (s.match(/\x21\xF9\x04/g)?.length ?? 0) > 1
  if (type === 'image/png' || type === 'image/apng') {
    const actl = s.indexOf('acTL')
    return actl !== -1 && (s.indexOf('IDAT') === -1 || actl < s.indexOf('IDAT'))
  }
  if (type === 'image/webp') return s.includes('ANIM')
  return false
}

const toBlob = (c: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob>((ok, fail) => c.toBlob((b) => (b ? ok(b) : fail(new Error(t("Couldn't convert the image.")))), type, quality))

/** Returns the file to upload (the original when it already fits) plus a note about what was changed. */
export async function prepareSticker(file: File): Promise<{ file: File; note: string }> {
  if (!/^image\/(png|apng|gif|webp|jpeg)$/.test(file.type)) throw new Error(t('Use a PNG, APNG, GIF, WebP or JPEG image.'))
  const head = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer())
  const bmp = await createImageBitmap(file).catch(() => null)
  if (!bmp) throw new Error(t("Couldn't read that image."))
  const { width, height } = bmp
  const fits = width <= SIDE && height <= SIDE
  if (isAnimated(file.type, head)) {
    bmp.close()
    if (!fits) throw new Error(t('Animated stickers must be at most 320×320 (this one is {w}×{h}). Resize it in an image editor first.', { w: width, h: height }))
    if (file.size > MAX_BYTES) throw new Error(t('Animated stickers must be 512 KB or smaller.'))
    return { file, note: '' }
  }
  if (fits && file.size <= MAX_BYTES && file.type !== 'image/jpeg') return bmp.close(), { file, note: '' }
  const scale = Math.min(1, SIDE / Math.max(width, height))
  const canvas = Object.assign(document.createElement('canvas'), { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) })
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height)
  bmp.close()
  let blob = await toBlob(canvas, 'image/png')
  for (const q of [0.92, 0.8, 0.65]) if (blob.size > MAX_BYTES) blob = await toBlob(canvas, 'image/webp', q)
  if (blob.size > MAX_BYTES) throw new Error(t('This image is still over 512 KB after resizing. Try a simpler image.'))
  const ext = blob.type === 'image/webp' ? 'webp' : 'png'
  const vars = { w: width, h: height, w2: canvas.width, h2: canvas.height }
  const note = fits ? (ext === 'webp' ? t('Converted and compressed.') : t('Converted.'))
    : ext === 'webp' ? t('Resized from {w}×{h} to {w2}×{h2} and compressed.', vars) : t('Resized from {w}×{h} to {w2}×{h2}.', vars)
  return { file: new File([blob], `${file.name.replace(/\.[^.]+$/, '')}.${ext}`, { type: blob.type }), note }
}

if (import.meta.env.DEV) {
  const enc = (s: string) => new TextEncoder().encode(s)
  console.assert(isAnimated('image/gif', enc('GIF89a....NETSCAPE2.0')) && !isAnimated('image/gif', enc('GIF89a\x21\xF9\x04')), 'gif animation detection')
  console.assert(isAnimated('image/png', enc('\x89PNG....acTL....IDAT')) && !isAnimated('image/png', enc('\x89PNG....IDAT')), 'apng detection')
}import { t } from '../i18n'

