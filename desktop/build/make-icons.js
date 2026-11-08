// Generates build/icons/*.png, build/icon.ico and src/assets/{icon,badge}.png. No dependencies.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// coverage(x, y) in unit coords [0,1] -> [r,g,b,a] or null; 4x4 supersampling for antialiasing
function render(size, shade) {
  const out = Buffer.alloc(size * size * 4);
  const S = 4;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const c = shade((x + (sx + 0.5) / S) / size, (y + (sy + 0.5) / S) / size);
      if (c) { r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; a += c[3]; }
    }
    const i = (y * size + x) * 4;
    if (a) { out[i] = r / a; out[i + 1] = g / a; out[i + 2] = b / a; out[i + 3] = (a / (S * S)) * 255; }
  }
  return out;
}

const BLURPLE = [0x58, 0x65, 0xf2, 1], WHITE = [255, 255, 255, 1], RED = [0xf2, 0x3f, 0x43, 1];
function logo(u, v) {
  const m = 0.04, rad = 0.22; // margin, corner radius
  const qx = Math.max(Math.abs(u - 0.5) - (0.5 - m - rad), 0), qy = Math.max(Math.abs(v - 0.5) - (0.5 - m - rad), 0);
  if (Math.hypot(qx, qy) > rad) return null;
  const d = Math.hypot(u - 0.5, v - 0.5);
  const ang = Math.atan2(v - 0.5, u - 0.5);
  const inRing = d > 0.165 && d < 0.3;
  const inGap = Math.abs(ang) < Math.PI / 4.2; // opening of the "C" faces right
  return inRing && !inGap ? WHITE : BLURPLE;
}
const badge = (u, v) => (Math.hypot(u - 0.5, v - 0.5) < 0.48 ? RED : null);

const here = __dirname;
fs.mkdirSync(path.join(here, 'icons'), { recursive: true });
fs.mkdirSync(path.join(here, '..', 'src', 'assets'), { recursive: true });
const pngs = {};
for (const s of [16, 32, 48, 64, 128, 256, 512]) {
  pngs[s] = encodePng(s, render(s, logo));
  fs.writeFileSync(path.join(here, 'icons', `${s}x${s}.png`), pngs[s]);
}
fs.copyFileSync(path.join(here, 'icons', '512x512.png'), path.join(here, 'icon.png'));
fs.copyFileSync(path.join(here, 'icons', '64x64.png'), path.join(here, '..', 'src', 'assets', 'icon.png'));
fs.writeFileSync(path.join(here, '..', 'src', 'assets', 'badge.png'), encodePng(16, render(16, badge)));

// ICO with embedded PNG images (supported since Windows Vista)
const sizes = [16, 32, 48, 64, 128, 256];
const header = Buffer.alloc(6); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const entries = sizes.map((s) => {
  const e = Buffer.alloc(16);
  e[0] = s === 256 ? 0 : s; e[1] = s === 256 ? 0 : s;
  e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(pngs[s].length, 8); e.writeUInt32LE(offset, 12);
  offset += pngs[s].length;
  return e;
});
fs.writeFileSync(path.join(here, 'icon.ico'), Buffer.concat([header, ...entries, ...sizes.map((s) => pngs[s])]));

// self-check: PNG signature + CRC of IHDR round-trips
const p = fs.readFileSync(path.join(here, 'icons', '16x16.png'));
if (p.readUInt32BE(8) !== 13 || crc32(p.subarray(12, 29)) !== p.readUInt32BE(29)) throw new Error('bad PNG');
console.log('icons written');
