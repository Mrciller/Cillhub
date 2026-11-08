// Builds src/whatsnew/changelog.json (the in-app "What's New" data) from ../CHANGELOG.md (English, repo root) and
// src/whatsnew/CHANGELOG.de.md (German). Both must list the same products, versions, dates, sections and bullet counts.
// Run by `npm run dev` and `npm run build`; `--check` (run by `npm run smoke`) fails instead of writing when the JSON is stale.
// Format: "## Product", "### [1.2.3] - YYYY-MM-DD" or "### [Unreleased]", "#### Section", "- bullet" (one line, plain text).
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')

const root = path.join(__dirname, '..')
const EN = path.join(root, '..', 'CHANGELOG.md')
const DE = path.join(root, 'src', 'whatsnew', 'CHANGELOG.de.md')
const OUT = path.join(root, 'src', 'whatsnew', 'changelog.json')

if (!fs.existsSync(EN) || !fs.existsSync(DE)) {
  if (fs.existsSync(OUT)) {
    process.exit(0)
  }
}

function parse(text, file) {
  const products = []
  let product, release, group
  text.split(/\r?\n/).forEach((line, i) => {
    const where = `${path.basename(file)}:${i + 1}`
    let m
    if ((m = /^## (.+)$/.exec(line))) products.push((product = { title: m[1].trim(), releases: [] }))
    else if ((m = /^### \[([^\]]+)\](?: - (\d{4}-\d{2}-\d{2}))?\s*$/.exec(line))) {
      if (!product) throw new Error(`${where}: release outside a product`)
      const [, version, date = null] = m
      if (!(version === 'Unreleased' ? !date : /^\d+\.\d+\.\d+$/.test(version) && date)) throw new Error(`${where}: want "[x.y.z] - YYYY-MM-DD" or "[Unreleased]"`)
      product.releases.push((release = { version, date, groups: [] }))
      group = undefined
    } else if ((m = /^#### (.+)$/.exec(line))) {
      if (!release) throw new Error(`${where}: section outside a release`)
      release.groups.push((group = { title: m[1].trim(), items: [] }))
    } else if ((m = /^- (.+)$/.exec(line))) {
      if (!group) throw new Error(`${where}: bullet outside a section`)
      group.items.push(m[1].trim())
    } else if (product && line.trim() && !line.startsWith('# ')) throw new Error(`${where}: unexpected line (bullets must be one line)`)
  })
  if (!products.length || products.some((p) => !p.releases.length || p.releases.some((r) => !r.groups.length || r.groups.some((g) => !g.items.length))))
    throw new Error(`${path.basename(file)}: every product needs releases, every release sections, every section bullets`)
  return products
}

/** Same releases in the same order; section titles and bullet texts differ by language. */
function sameShape(en, de) {
  const shape = (ps) => ps.map((p) => p.releases.map((r) => [r.version, r.date, r.groups.map((g) => g.items.length)]))
  assert.deepEqual(shape(de), shape(en), 'CHANGELOG.md and src/whatsnew/CHANGELOG.de.md disagree (versions, dates, sections or bullet counts)')
}

function main() {
  const check = process.argv.includes('--check')
  if (!fs.existsSync(EN)) {
    // e.g. a build context with only client/: keep the committed JSON (it was checked when it was generated).
    if (check || !fs.existsSync(OUT)) throw new Error(`${EN} not found`)
    console.warn(`changelog: ${EN} not found, using the committed ${path.relative(root, OUT)}`)
    return
  }
  const en = parse(fs.readFileSync(EN, 'utf8'), EN)
  const de = parse(fs.readFileSync(DE, 'utf8'), DE)
  sameShape(en, de)
  const json = JSON.stringify({ en, de }, null, 1) + '\n'
  const old = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : ''
  if (old === json) return
  if (check) throw new Error(`${path.relative(root, OUT)} is out of date: run "node scripts/changelog.cjs"`)
  fs.writeFileSync(OUT, json)
  console.log(`changelog: wrote ${path.relative(root, OUT)}`)
}

try {
  main()
} catch (e) {
  console.error(e.message)
  process.exit(1)
}
