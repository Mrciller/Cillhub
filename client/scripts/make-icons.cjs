// Generates Cillhub's app icons (no dependencies): a cyan "C" on a night navy rounded square (the app palette, as the Android launcher icon).
// Run: node scripts/make-icons.cjs  -> public/icon-192.png, icon-512.png, icon-maskable-512.png, apple-touch-icon.png
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td))
  return Buffer.concat([len, td, c])
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    for (let x = 0; x < size; x++) {
      // 4x4 supersampling for smooth edges
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
        const p = pixel((x + (sx + 0.5) / 4) / size, (y + (sy + 0.5) / 4) / size)
        r += p[0] * p[3]; g += p[1] * p[3]; b += p[2] * p[3]; a += p[3]
      }
      const o = y * (size * 4 + 1) + 1 + x * 4
      raw[o] = a ? r / a : 0; raw[o + 1] = a ? g / a : 0; raw[o + 2] = a ? b / a : 0; raw[o + 3] = (a / 16) * 255
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

const BG = [0x07, 0x0a, 0x14, 1] // --rail
const GLYPH = [0x22, 0xe1, 0xff, 1] // --accent
const NONE = [0, 0, 0, 0]
/** "C" as a thick ring with an opening on the right, centred at (.5,.5) with outer radius `r` (fraction of the icon). */
function isC(x, y, r) {
  const dx = x - 0.5, dy = y - 0.5
  const d = Math.hypot(dx, dy)
  const inRing = d <= r && d >= r * 0.52
  const angle = Math.abs(Math.atan2(dy, dx)) // 0 = pointing right
  return inRing && angle > 0.62
}
function roundedSquare(x, y, inset, radius) {
  const cx = Math.min(Math.max(x, inset + radius), 1 - inset - radius)
  const cy = Math.min(Math.max(y, inset + radius), 1 - inset - radius)
  return Math.hypot(x - cx, y - cy) <= radius && x >= inset && x <= 1 - inset && y >= inset && y <= 1 - inset
}
const regular = (x, y) => (!roundedSquare(x, y, 0.02, 0.22) ? NONE : isC(x, y, 0.3) ? GLYPH : BG)
// Maskable: full bleed background, the glyph inside the 80% safe zone.
const maskable = (x, y) => (isC(x, y, 0.24) ? GLYPH : BG)
const apple = (x, y) => (isC(x, y, 0.3) ? GLYPH : BG) // iOS rounds the corners itself

const out = path.join(__dirname, '..', 'public')
fs.mkdirSync(out, { recursive: true })
fs.writeFileSync(path.join(out, 'icon-192.png'), png(192, regular))
fs.writeFileSync(path.join(out, 'icon-512.png'), png(512, regular))
fs.writeFileSync(path.join(out, 'icon-maskable-512.png'), png(512, maskable))
fs.writeFileSync(path.join(out, 'apple-touch-icon.png'), png(180, apple))
console.log('icons written to', out)
