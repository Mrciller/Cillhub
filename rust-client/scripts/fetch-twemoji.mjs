// Fetches the Twemoji SVG (CC-BY 4.0, https://github.com/jdecked/twemoji) for each emoji in
// assets/emoji.json into assets/emoji-svg.json. egui draws no colour emoji fonts, so the picker
// and reactions draw these images. Run after gen-web-assets.mjs: node rust-client/scripts/fetch-twemoji.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const assets = path.join(path.dirname(fileURLToPath(import.meta.url)), '../assets')
const BASE = 'https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/svg/'
const name = (ch) => {
  const cps = [...ch].map((c) => c.codePointAt(0).toString(16))
  return (ch.includes('‍') ? cps : cps.filter((c) => c !== 'fe0f')).join('-')
}
const out = {}
for (const [, list] of JSON.parse(fs.readFileSync(path.join(assets, 'emoji.json'), 'utf8'))) {
  for (const e of list) {
    const ch = e.split(' ')[0]
    const r = await fetch(BASE + name(ch) + '.svg')
    if (!r.ok) { console.log('missing', ch, name(ch)); continue }
    out[ch] = (await r.text()).trim()
  }
}
fs.writeFileSync(path.join(assets, 'emoji-svg.json'), JSON.stringify(out, null, 0).replace(/","/g, '",\n"') + '\n')
console.log(Object.keys(out).length, 'emoji')
