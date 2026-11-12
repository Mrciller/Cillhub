// Copies what the native client takes from the web client into rust-client/assets:
// the German dictionary (client/src/i18n/de/*.ts), the SVG icon paths (ICONS in client/src/components/ui.tsx)
// the curated emoji list (client/src/emoji/data.ts) and the role permission groups (settings/permInfo.ts).
// Run after changing either: node rust-client/scripts/gen-web-assets.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const here = path.dirname(fileURLToPath(import.meta.url))
const web = path.join(here, '../../client/src')
const out = path.join(here, '../assets')
// The files are plain object literals; strip the TS so they evaluate as JS.
const evalObject = (src) => Function(`return (${src})`)()
const de = {}
const dir = path.join(web, 'i18n/de')
for (const f of fs.readdirSync(dir).sort()) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8')
  const body = src.slice(src.indexOf('{', src.indexOf('export const')), src.lastIndexOf('}') + 1)
  Object.assign(de, evalObject(body))
}
const ui = fs.readFileSync(path.join(web, 'components/ui.tsx'), 'utf8')
const start = ui.indexOf('{', ui.indexOf('export const ICONS'))
const icons = evalObject(ui.slice(start, ui.indexOf('\n}', start) + 2))
const data = fs.readFileSync(path.join(web, 'emoji/data.ts'), 'utf8')
const rawStart = data.indexOf('= [', data.indexOf('const RAW')) + 2
const raw = evalObject(data.slice(rawStart, data.indexOf('\n]', rawStart) + 2))
const emoji = raw.map(([category, s]) => [category, s.split('|')])
const pSrc = fs.readFileSync(path.join(web, 'permissions.ts'), 'utf8')
const bits = Object.fromEntries([...pSrc.matchAll(/(\w+): b\((\d+)\)/g)].map((m) => [m[1], +m[2]]))
const permSrc = fs.readFileSync(path.join(web, 'settings/permInfo.ts'), 'utf8')
const pStart = permSrc.indexOf('= [', permSrc.indexOf('PERM_GROUPS')) + 2
const perms = evalObject(permSrc.slice(pStart, permSrc.indexOf('\n]', pStart) + 2))
  .map((g) => ({ title: g.title, perms: g.perms.map(({ name, label, note }) => ({ name, bit: bits[name], label, note })) }))
const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
fs.writeFileSync(path.join(out, 'i18n-de.json'), JSON.stringify(sorted(de), null, 0).replace(/","/g, '",\n"') + '\n')
fs.writeFileSync(path.join(out, 'icons.json'), JSON.stringify(sorted(icons), null, 1) + '\n')
fs.writeFileSync(path.join(out, 'emoji.json'), JSON.stringify(emoji, null, 1) + '\n')
fs.writeFileSync(path.join(out, 'perm-groups.json'), JSON.stringify(perms, null, 1) + '\n')
console.log(Object.keys(de).length, 'German strings,', Object.keys(icons).length, 'icons')
