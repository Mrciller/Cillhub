// End-to-end check of encrypted DMs with Alex and Sam (and Robin, instance admin) in real browsers against a real server.
// Starts its own throwaway instance from server/ on E2E_PORT (3391) serving client/dist with a temp DATA_DIR, then reads
// that instance's SQLite file and attachment folder directly to prove the server holds no plain text.
// Run: NODE_PATH=<dir with playwright> node scripts/e2e-e2ee.cjs (E2E_FAIL_SHOTS=<dir> saves every page when a step fails)
const { chromium } = require('playwright')
const { spawn, execFileSync } = require('node:child_process')
const { createHmac, randomBytes } = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const ROOT = path.join(__dirname, '..')
const SERVER_DIR = path.join(ROOT, 'server')
const DIST = process.env.E2E_STATIC_DIR ?? path.join(ROOT, 'client', 'dist')
const PORT = Number(process.env.E2E_PORT ?? 3391)
const BASE = `http://127.0.0.1:${PORT}`
const LIVE = { timeout: 10000 }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const SFX = Math.random().toString(36).slice(2, 7)
const NAME = { alex: `Alex_${SFX}`, sam: `Sam_${SFX}`, robin: `Robin_${SFX}` }
const PASSWORD = 'correct horse battery'
const PLACEHOLDER = 'Encrypted message. Update the app to read it.'
const SECRET = `the meeting point is the old mill ${SFX}`
const PICTURE = `here is the map ${SFX}`
// a 2x2 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64')

let failed = false
const errors = []
const pages = {}
const results = []
const children = []

async function step(name, fn) {
  try {
    await fn()
    console.log(`ok - ${name}`)
    results.push(true)
  } catch (e) {
    const lines = String(e.message).split('\n')
    console.log(`not ok - ${name}\n  ${lines[0]}${lines.find((l) => /waiting for/.test(l))?.replace(/^.*?waiting for/, '\n  waiting for') ?? ''}`)
    failed = true
    results.push(false)
    if (process.env.E2E_FAIL_SHOTS) for (const [n, p] of Object.entries(pages)) await p.screenshot({ path: path.join(process.env.E2E_FAIL_SHOTS, `fail-${n}.png`) }).catch(() => {})
    throw e
  }
}
async function until(what, fn, ms = 10000) {
  for (const end = Date.now() + ms; ; await sleep(100)) {
    if (await fn().catch(() => false)) return
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`)
  }
}
const check = (ok, what) => { if (!ok) throw new Error(what) }

// RFC 6238 TOTP (SHA-1, 6 digits, 30 s) from a base32 secret, as an authenticator app computes it.
function totp(secret, at = Date.now()) {
  let bits = ''
  for (const c of secret) bits += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c).toString(2).padStart(5, '0')
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)))
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30000)))
  const h = createHmac('sha1', key).update(counter).digest()
  return String((h.readUInt32BE(h[19] & 15) & 0x7fffffff) % 1e6).padStart(6, '0')
}
check(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59000) === '287082', 'TOTP helper does not match the RFC 6238 test vector')

function watch(page, name) {
  pages[name] = page
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`))
  if (process.env.E2E_CONSOLE) page.on('console', (m) => console.log(`[${name}] ${m.text()}`))
  page.on('dialog', (d) => (errors.push(`${name}: unexpected native dialog "${d.message()}"`), d.dismiss()))
}
async function newPage(browser, name) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' })
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE })
  const page = await ctx.newPage()
  watch(page, name)
  return page
}
async function ready(page) {
  await page.getByRole('navigation', { name: /^(Servers|Server)$/ }).waitFor()
  await until('the gateway to connect (no "Connecting…")', async () => (await page.getByText(/Connecting…|Verbinde…/).count()) === 0)
}
async function register(page, name) {
  await page.goto(BASE + '/register')
  await page.getByRole('heading', { name: 'Join the roster' }).waitFor()
  await page.getByLabel('Email').fill(`${name.toLowerCase()}@example.com`)
  await page.getByLabel('Username').fill(name)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByLabel(/I am at least/).check()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.waitForURL('**/channels/@me')
  await ready(page)
}
async function login(page, name) {
  await page.goto(BASE + '/login')
  await page.getByRole('heading', { name: 'Ready up' }).waitFor()
  await page.getByLabel('Email or username').fill(name)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Log In' }).click()
  await page.waitForURL('**/channels/**')
  await ready(page)
}
// REST as the page's user (same token the client uses). Returns {status, body}.
const api = (page, method, route, body) =>
  page.evaluate(async ([method, route, body]) => {
    const r = await fetch('/api/v9' + route, { method, headers: { Authorization: localStorage.getItem('token'), ...(body && { 'Content-Type': 'application/json' }) }, body: body && JSON.stringify(body) })
    return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }
  }, [method, route, body])
const ok = async (p) => { const r = await p; check(r.status < 300, `API answered ${r.status}: ${JSON.stringify(r.body)}`); return r.body }

const modal = (page, name) => page.getByRole('dialog', { name })
const msg = (page, text) => page.locator('li.msg').filter({ hasText: text })
const composer = (page) => page.locator('.composer textarea')
const ids = {}

// Settings › Encrypted Messages › Turn on; returns the recovery key shown once
async function turnOn(page) {
  await page.getByRole('button', { name: 'User Settings' }).click()
  await page.getByRole('tab', { name: 'Encrypted Messages' }).click()
  await page.getByRole('button', { name: 'Turn on encrypted messages' }).click()
  const dlg = modal(page, 'Your recovery key')
  const key = (await dlg.getByTestId('recovery-key').innerText()).trim()
  check(/^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/.test(key), `recovery key format: ${key}`)
  check(await dlg.getByRole('button', { name: 'Done' }).isDisabled(), 'Done waits for the saved tick')
  await dlg.getByLabel('I saved my recovery key').check()
  await dlg.getByRole('button', { name: 'Done' }).click()
  await page.getByText('Encrypted messages are on for this device.').waitFor()
  await page.keyboard.press('Escape')
  return key
}
async function openDm(page) {
  await page.goto(`${BASE}/channels/@me/${ids.dm}`)
  await ready(page)
}
async function send(page, text) {
  await composer(page).fill(text)
  await composer(page).press('Enter')
}

async function main() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error(`no client build in ${DIST}: run npm run build in client/`)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cillhub-e2e-e2ee-'))
  const dataDir = fs.mkdtempSync(path.join(tmp, 'data-'))
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('LIVEKIT_') && !k.startsWith('CILLCORD_')))
  const out = fs.openSync(path.join(tmp, 'server.log'), 'w')
  children.push(spawn(process.execPath, ['src/index.js'], { cwd: SERVER_DIR, env: { ...env, PORT: String(PORT), DATA_DIR: dataDir, STATIC_DIR: DIST }, stdio: ['ignore', out, out] }))
  const grant = (name) => execFileSync(process.execPath, ['src/admin-cli.js', 'grant', name], { cwd: SERVER_DIR, env: { ...env, DATA_DIR: dataDir }, encoding: 'utf8' })
  const sql = (q, ...a) => { const db = new DatabaseSync(path.join(dataDir, 'cillcord.sqlite'), { readOnly: true }); try { return db.prepare(q).all(...a) } finally { db.close() } }
  const browser = await chromium.launch()
  let recovery
  try {
    await until(`the instance at ${BASE}`, async () => (await fetch(BASE + '/api/v9/instance')).ok, 20000)
    const alex = await newPage(browser, 'Alex')
    const sam = await newPage(browser, 'Sam')
    const robin = await newPage(browser, 'Robin')

    await step(`1. Alex, Sam and Robin register (suffix ${SFX}); Alex and Sam become friends; Robin is made admin by the CLI and turns on 2FA`, async () => {
      for (const [p, n] of [[alex, NAME.alex], [sam, NAME.sam], [robin, NAME.robin]]) await register(p, n)
      for (const [k, p] of Object.entries({ alex, sam })) ids[k] = (await api(p, 'GET', '/users/@me')).body.id
      await ok(api(alex, 'POST', '/users/@me/relationships', { username: NAME.sam }))
      await ok(api(sam, 'PUT', `/users/@me/relationships/${ids.alex}`, {}))
      ids.dm = (await ok(api(alex, 'POST', '/users/@me/channels', { recipient_id: ids.sam }))).id
      check(/granted|admin/i.test(grant(NAME.robin)), 'the CLI granted Robin')
      const secret = Array.from(randomBytes(32), (b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[b & 31]).join('')
      await ok(api(robin, 'POST', '/users/@me/mfa/totp/enable', { password: PASSWORD, secret, code: totp(secret) }))
    })

    await step('2. Before setup the DM says why it is not encrypted; Alex and Sam turn on encrypted messages and get a recovery key once', async () => {
      await openDm(alex)
      await alex.getByText('Not encrypted yet: turn on encrypted messages in Settings.').waitFor(LIVE)
      recovery = await turnOn(alex)
      await openDm(alex)
      await alex.getByText(/Not encrypted yet: .* has not set up encrypted messages\./).waitFor(LIVE)
      await turnOn(sam)
    })

    await step('3. Opening the DM encrypts it (epoch 1); the header lock says so; text goes both ways and is readable', async () => {
      await openDm(sam)
      await sam.getByRole('button', { name: 'End-to-end encrypted', exact: true }).waitFor(LIVE)
      await openDm(alex)
      await alex.getByRole('button', { name: 'End-to-end encrypted', exact: true }).waitFor(LIVE)
      await send(alex, SECRET)
      await msg(alex, SECRET).locator('.content').waitFor(LIVE)
      await msg(sam, SECRET).waitFor(LIVE)
      await send(sam, `got it ${SFX}`)
      await msg(alex, `got it ${SFX}`).waitFor(LIVE)
      // the verify dialog shows the same 60 digits on both sides
      const code = async (page) => {
        await page.getByRole('button', { name: 'End-to-end encrypted', exact: true }).click()
        await page.getByRole('button', { name: /^Verify security code with/ }).click()
        const c = (await page.getByTestId('security-code').innerText()).trim()
        await page.keyboard.press('Escape')
        await page.keyboard.press('Escape')
        return c
      }
      const [a, b] = [await code(alex), await code(sam)]
      check(/^(\d{5} ){11}\d{5}$/.test(a) && a === b, `security codes ${a} / ${b}`)
    })

    await step('4. An attachment: Alex sends a PNG, Sam sees it decrypted from a blob URL with the original bytes', async () => {
      await composer(alex).fill(PICTURE)
      await alex.locator('.composer input[type=file]').setInputFiles({ name: 'map.png', mimeType: 'image/png', buffer: PNG })
      await composer(alex).press('Enter')
      const img = msg(sam, PICTURE).locator('.attachments img')
      await img.waitFor(LIVE)
      const src = await img.getAttribute('src')
      check(src.startsWith('blob:'), `shown from a blob URL: ${src}`)
      const bytes = await sam.evaluate(async (u) => Array.from(new Uint8Array(await (await fetch(u)).arrayBuffer())), src)
      check(Buffer.from(bytes).equals(PNG), 'decrypted bytes equal the original file')
      await msg(alex, PICTURE).locator('.attachments img').waitFor(LIVE)
    })

    await step('5. The database holds only the placeholder; the stored attachment is neither the file nor named like it', async () => {
      const rows = sql('SELECT content, e2ee_envelope FROM messages WHERE channel_id = ? AND type IN (0, 19)', ids.dm)
      check(rows.length === 3, `3 messages stored, got ${rows.length}`)
      for (const r of rows) {
        check(r.content === PLACEHOLDER, `content is the placeholder: ${r.content}`)
        check(r.e2ee_envelope && !r.e2ee_envelope.includes(SFX), 'envelope present and opaque')
      }
      const files = sql('SELECT id, filename, content_type FROM attachments WHERE channel_id = ?', ids.dm)
      check(files.length === 1 && files[0].filename === 'file.bin' && files[0].content_type === 'application/octet-stream', `stored as file.bin: ${JSON.stringify(files)}`)
      const stored = fs.readFileSync(path.join(dataDir, 'attachments', ids.dm, files[0].id))
      check(!stored.equals(PNG) && !stored.includes(PNG.subarray(8, 24)), 'stored bytes are not the PNG')
      check(sql("SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH ?", `"${SFX}"`)[0].n === 0, 'nothing of the text in the search index')
    })

    await step('6. Alex on a fresh browser: the DM asks for the recovery key; after it the history reads again', async () => {
      const fresh = await newPage(browser, 'Alex-2')
      await login(fresh, NAME.alex)
      await openDm(fresh)
      await fresh.getByText('Enter your recovery key to read this conversation.').waitFor(LIVE)
      check(await msg(fresh, SECRET).count() === 0, 'nothing readable before the key')
      await fresh.locator('.e2ee-bar').getByRole('button', { name: 'Enter recovery key' }).click()
      const dlg = modal(fresh, 'Enter your recovery key')
      await dlg.getByLabel('Recovery key').fill(recovery.toLowerCase().replace(/-/g, ' '))
      await dlg.getByRole('button', { name: 'Unlock' }).click()
      await msg(fresh, SECRET).waitFor(LIVE)
      await msg(fresh, PICTURE).locator('.attachments img').waitFor(LIVE)
      await fresh.reload()
      await ready(fresh)
      await msg(fresh, SECRET).waitFor(LIVE) // the key stays on this device (IndexedDB)
      await fresh.context().close()
    })

    await step('7. Sam reports the picture message with the messages before it; the server stores the revealed text', async () => {
      await openDm(sam)
      const m = msg(sam, PICTURE)
      await m.click({ button: 'right' })
      await sam.getByRole('menuitem', { name: 'Report Message' }).click()
      const dlg = modal(sam, 'Report Message')
      await dlg.getByLabel('Harassment or bullying').check()
      await dlg.getByLabel('Include up to 10 messages before it').check()
      await dlg.getByRole('button', { name: 'Report' }).click()
      await sam.getByText('Thanks. The instance admins will review this message.').waitFor(LIVE)
      const snap = JSON.parse(sql('SELECT snapshot FROM reports ORDER BY created_at DESC LIMIT 1')[0].snapshot)
      check(snap.content === PICTURE && snap.revealed && snap.context.some((c) => c.content === SECRET), `snapshot ${JSON.stringify(snap).slice(0, 300)}`)
    })

    await step('8. Robin (admin) sees the revealed text and decrypts the reported file in the browser', async () => {
      await robin.goto(`${BASE}/admin/reports`)
      const card = robin.locator('.admin-report').filter({ hasText: PICTURE })
      await card.waitFor(LIVE)
      await card.getByText('Encrypted message, decrypted from the report').waitFor()
      await card.getByText(SECRET).waitFor()
      await card.getByRole('button', { name: 'Decrypt and show' }).click()
      await card.locator('img[alt="map.png"]').waitFor(LIVE)
    })

    await step('9. Sam resets encryption: Alex sees the key-change warning, wraps the key for Sam\'s new key on send, Sam reads it', async () => {
      await sam.getByRole('button', { name: 'User Settings' }).click()
      await sam.getByRole('tab', { name: 'Encrypted Messages' }).click()
      await sam.getByRole('button', { name: 'Reset encryption' }).click()
      await modal(sam, 'Reset encryption?').getByRole('button', { name: 'Reset', exact: true }).click()
      const dlg = modal(sam, 'Your recovery key')
      await dlg.getByLabel('I saved my recovery key').check()
      await dlg.getByRole('button', { name: 'Done' }).click()
      await sam.keyboard.press('Escape')
      await openDm(alex)
      await alex.locator('.e2ee-bar.warn').filter({ hasText: "security key changed" }).waitFor(LIVE)
      await send(alex, `after the reset ${SFX}`)
      await openDm(sam)
      await msg(sam, `after the reset ${SFX}`).locator('.content').waitFor(LIVE)
      check(!(await msg(sam, `after the reset ${SFX}`).innerText()).includes('Cannot decrypt'), 'readable with the new key')
    })

    await step('10. no uncaught page errors and no native dialogs', async () => {
      if (errors.length) throw new Error(errors.join('; '))
    })
  } catch (e) {
    if (!results.length || results.at(-1)) console.log(`not ok - setup: ${e.message}`), (failed = true)
  } finally {
    await browser.close().catch(() => {})
    for (const c of children) c.kill()
    await sleep(500)
    if (process.env.E2E_KEEP_LOGS) console.log(`kept ${tmp}`)
    else fs.rmSync(tmp, { recursive: true, force: true })
  }
  console.log(`${results.filter(Boolean).length}/${results.length} steps passed`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  for (const c of children) c.kill()
  process.exit(1)
})
