// End-to-end check of encrypted DMs with Alex and Sam (and Robin, instance admin and later a database attacker) in real browsers against a real server.
// Starts its own throwaway instance from server/ on E2E_PORT (3391) serving client/dist with a temp DATA_DIR, then reads
// that instance's SQLite file and attachment folder directly to prove the server holds no plain text.
// Run: NODE_PATH=<dir with playwright> node scripts/e2e-e2ee.cjs (E2E_FAIL_SHOTS=<dir> saves every page when a step fails)
const { chromium } = require('playwright')
const { spawn, execFileSync } = require('node:child_process')
const { createCipheriv, createECDH, createHmac, hkdfSync, randomBytes } = require('node:crypto')
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

const attackerKey = () => { const k = createECDH('prime256v1'); k.generateKeys(); return k }
// What someone with only database access can do: a wrap v2 of a channel key of their own, claiming to be `by`, with a key
// pair of their own in place of by's account key (they know only public keys).
function forgeWrap(channelKey, memberPub, channelId, epoch, userId, by, mine = attackerKey()) {
  const eph = attackerKey()
  const pub = Buffer.from(memberPub, 'base64url')
  const ikm = Buffer.concat([eph.computeSecret(pub), mine.computeSecret(pub)])
  const wk = Buffer.from(hkdfSync('sha256', ikm, Buffer.from(channelId), `cillhub-e2ee-wrap-v2|${epoch}|${userId}|${by}`, 32))
  const n = randomBytes(12), c = createCipheriv('aes-256-gcm', wk, n)
  const ct = Buffer.concat([c.update(channelKey), c.final(), c.getAuthTag()])
  return JSON.stringify({ by, eph: eph.getPublicKey().toString('base64url'), n: n.toString('base64url'), c: ct.toString('base64url') })
}

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
  // the "attacker": writes straight into the database, as a node admin could
  const write = (q, ...a) => { const db = new DatabaseSync(path.join(dataDir, 'cillcord.sqlite')); try { db.exec('PRAGMA busy_timeout = 5000'); return db.prepare(q).run(...a) } finally { db.close() } }
  const browser = await chromium.launch()
  let recovery
  try {
    await until(`the instance at ${BASE}`, async () => (await fetch(BASE + '/api/v9/instance')).ok, 20000)
    const alex = await newPage(browser, 'Alex')
    const sam = await newPage(browser, 'Sam')
    const robin = await newPage(browser, 'Robin')

    await step(`1. Alex, Sam and Robin register (suffix ${SFX}); Alex and Sam become friends; Robin is made admin by the CLI and turns on 2FA`, async () => {
      for (const [p, n] of [[alex, NAME.alex], [sam, NAME.sam], [robin, NAME.robin]]) await register(p, n)
      for (const [k, p] of Object.entries({ alex, sam, robin })) ids[k] = (await api(p, 'GET', '/users/@me')).body.id
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

    await step('9. Sam resets encryption: Alex sees the key-change warning and cannot send until Accept; then the key is wrapped for Sam\'s new key and Sam reads it', async () => {
      await sam.getByRole('button', { name: 'User Settings' }).click()
      await sam.getByRole('tab', { name: 'Encrypted Messages' }).click()
      const epochBefore = sql('SELECT e2ee_epoch AS e FROM channels WHERE id = ?', ids.dm)[0].e
      await sam.getByRole('button', { name: 'Reset encryption' }).click()
      await modal(sam, 'Reset encryption?').getByRole('button', { name: 'Reset', exact: true }).click()
      const dlg = modal(sam, 'Your recovery key')
      await dlg.getByLabel('I saved my recovery key').check()
      await dlg.getByRole('button', { name: 'Done' }).click()
      await sam.keyboard.press('Escape')
      await openDm(alex)
      const line = alex.locator('.e2ee-bar.warn').filter({ hasText: 'security key changed' })
      await line.waitFor(LIVE)
      await until('the message box to refuse', async () => (await composer(alex).isDisabled()) && /accept it before you send/.test(await composer(alex).getAttribute('placeholder')))
      await line.getByRole('button', { name: 'Accept' }).click()
      await until('the warning to go after Accept', async () => (await line.count()) === 0)
      await until('the message box to open', async () => !(await composer(alex).isDisabled()))
      await send(alex, `after the reset ${SFX}`)
      await until('the epoch to be renewed (Sam\'s old wrap is a tombstone)', async () => sql('SELECT e2ee_epoch AS e FROM channels WHERE id = ?', ids.dm)[0].e === epochBefore + 1)
      await openDm(sam)
      await msg(sam, `after the reset ${SFX}`).locator('.content').waitFor(LIVE)
      check(!(await msg(sam, `after the reset ${SFX}`).innerText()).includes('Cannot decrypt'), 'readable with the new key')
    })

    await step('10. A database attacker swaps Sam\'s public key for their own and inserts an epoch "by Sam": Alex sees the key change, refuses to send, nothing stored', async () => {
      const epoch = sql('SELECT e2ee_epoch AS e FROM channels WHERE id = ?', ids.dm)[0].e + 1
      const real = sql('SELECT public_key FROM user_e2ee_keys WHERE user_id = ?', ids.sam)[0].public_key
      const evil = randomBytes(32), mine = attackerKey()
      const pub = (id) => sql('SELECT public_key FROM user_e2ee_keys WHERE user_id = ?', id)[0].public_key
      for (const id of [ids.alex, ids.sam]) {
        write('INSERT INTO dm_keys (channel_id, epoch, user_id, wrapped) VALUES (?, ?, ?, ?)', ids.dm, epoch, id, forgeWrap(evil, pub(id), ids.dm, epoch, id, ids.sam, mine))
      }
      write('UPDATE user_e2ee_keys SET public_key = ? WHERE user_id = ?', mine.getPublicKey().toString('base64url'), ids.sam)
      write('UPDATE channels SET e2ee_epoch = ? WHERE id = ?', epoch, ids.dm)
      const before = sql('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?', ids.dm)[0].n
      await openDm(alex)
      await alex.locator('.e2ee-bar.warn').filter({ hasText: 'security key changed' }).waitFor(LIVE)
      await until('the message box to refuse', async () => (await composer(alex).isDisabled()) && /accept it before you send/.test(await composer(alex).getAttribute('placeholder')))
      await composer(alex).evaluate((el) => el.removeAttribute('disabled'))
      await composer(alex).fill(`to the swapped key ${SFX}`)
      await composer(alex).press('Enter')
      await alex.getByText(/security key changed\. Check it and accept it before you send\./).last().waitFor(LIVE)
      await sleep(500)
      check(sql('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?', ids.dm)[0].n === before, 'no message stored')
      write('UPDATE user_e2ee_keys SET public_key = ? WHERE user_id = ?', real, ids.sam) // the forged epoch stays: the next step renews over it
    })

    await step('11. A database attacker inserts a new epoch wrapped with a key of their own: Alex sees the warning, sends nothing until he makes a new key by hand; the attacker\'s key is never used', async () => {
      const epoch = sql('SELECT e2ee_epoch AS e FROM channels WHERE id = ?', ids.dm)[0].e + 1
      const evil = randomBytes(32)
      const pub = (id) => sql('SELECT public_key FROM user_e2ee_keys WHERE user_id = ?', id)[0].public_key
      for (const id of [ids.alex, ids.sam]) {
        write('INSERT INTO dm_keys (channel_id, epoch, user_id, wrapped) VALUES (?, ?, ?, ?)', ids.dm, epoch, id, forgeWrap(evil, pub(id), ids.dm, epoch, id, ids.robin))
      }
      write('UPDATE channels SET e2ee_epoch = ? WHERE id = ?', epoch, ids.dm)
      await openDm(alex)
      const warn = alex.locator('.e2ee-bar.warn').filter({ hasText: 'The key of this conversation could not be verified.' })
      await warn.waitFor(LIVE)
      const count = sql('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?', ids.dm)[0].n
      // no silent renewal: the box stays shut, and a forced send is refused
      await until('the message box to refuse', async () => await composer(alex).isDisabled())
      await composer(alex).evaluate((el) => el.removeAttribute('disabled'))
      await send(alex, `before the renewal ${SFX}`)
      await alex.getByText('The key of this conversation could not be verified. Nothing was sent.').waitFor(LIVE)
      await sleep(500)
      check(sql('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?', ids.dm)[0].n === count, 'nothing stored before the renewal')
      check(sql('SELECT e2ee_epoch AS e FROM channels WHERE id = ?', ids.dm)[0].e === epoch, 'not renewed by itself')
      await warn.getByRole('button', { name: 'Make a new key' }).click()
      await until('the warning to go once the key is renewed', async () => (await warn.count()) === 0)
      await until('the message box to open', async () => !(await composer(alex).isDisabled()))
      await send(alex, `after the attack ${SFX}`)
      await until('the message to be stored', async () => sql('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?', ids.dm)[0].n > count).catch(async (e) => {
        throw new Error(`${e.message}; on screen: ${(await alex.locator('.toast, [role=alert]').allInnerTexts()).join(' | ')}`)
      })
      const last = JSON.parse(sql('SELECT e2ee_envelope FROM messages WHERE channel_id = ? ORDER BY id DESC LIMIT 1', ids.dm)[0].e2ee_envelope)
      check(last.e === epoch + 1, `sent with a renewed key (epoch ${epoch + 1}), got epoch ${last.e}`)
      const bys = sql('SELECT wrapped FROM dm_keys WHERE channel_id = ? AND epoch = ?', ids.dm, epoch + 1).map((r) => JSON.parse(r.wrapped).by)
      check(bys.length === 2 && bys.every((b) => b === ids.alex), `the new key is wrapped by Alex: ${bys}`)
      await openDm(sam)
      await msg(sam, `after the attack ${SFX}`).locator('.content').waitFor(LIVE)
      check(!(await msg(sam, `after the attack ${SFX}`).innerText()).includes('Cannot decrypt'), 'Sam reads the message sent with the renewed key')
    })

    await step('12. The server leaves Alex\'s wrap of the current key out of its answer: Alex refuses to send and does not renew by himself; the key is renewed only by hand', async () => {
      const epoch = sql('SELECT e2ee_epoch AS e FROM channels WHERE id = ?', ids.dm)[0].e
      write('DELETE FROM dm_keys WHERE channel_id = ? AND epoch = ? AND user_id = ?', ids.dm, epoch, ids.alex)
      const count = sql('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?', ids.dm)[0].n
      await openDm(alex)
      const warn = alex.locator('.e2ee-bar.warn').filter({ hasText: 'The key of this conversation could not be verified.' })
      await warn.waitFor(LIVE)
      await until('the message box to refuse', async () => await composer(alex).isDisabled())
      await composer(alex).evaluate((el) => el.removeAttribute('disabled'))
      await send(alex, `without my wrap ${SFX}`)
      await alex.getByText('The key of this conversation could not be verified. Nothing was sent.').waitFor(LIVE)
      await sleep(500)
      check(sql('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?', ids.dm)[0].n === count, 'no message stored')
      check(sql('SELECT e2ee_epoch AS e FROM channels WHERE id = ?', ids.dm)[0].e === epoch, 'no new epoch by itself')
      await warn.getByRole('button', { name: 'Make a new key' }).click()
      await until('a new key made by hand', async () => sql('SELECT e2ee_epoch AS e FROM channels WHERE id = ?', ids.dm)[0].e === epoch + 1)
      await until('the warning to go', async () => (await warn.count()) === 0)
    })

    await step('13. The attacker sets the epoch back to 0: Alex\'s device remembers it was encrypted, warns and sends no plain text', async () => {
      const before = sql('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?', ids.dm)[0].n
      const epoch = sql('SELECT e2ee_epoch AS e FROM channels WHERE id = ?', ids.dm)[0].e
      write('UPDATE channels SET e2ee_epoch = 0 WHERE id = ?', ids.dm)
      await openDm(alex)
      await alex.locator('.e2ee-bar.warn').filter({ hasText: 'The key of this conversation could not be verified.' }).waitFor(LIVE)
      check(await composer(alex).isDisabled(), 'the message box is disabled')
      check((await composer(alex).getAttribute('placeholder')) === 'The key of this conversation could not be verified.', 'the message box says why')
      // even with the box forced open, the send path refuses
      await composer(alex).evaluate((el) => el.removeAttribute('disabled'))
      const plain = `plain after rollback ${SFX}`
      await composer(alex).fill(plain)
      await composer(alex).press('Enter')
      await alex.getByText('The key of this conversation could not be verified. Nothing was sent.').waitFor(LIVE)
      await sleep(500)
      check(sql('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?', ids.dm)[0].n === before, 'no message stored')
      check(sql("SELECT COUNT(*) AS n FROM messages WHERE content LIKE ?", `%${plain}%`)[0].n === 0, 'the text is nowhere in the database')
      write('UPDATE channels SET e2ee_epoch = ? WHERE id = ?', epoch, ids.dm) // back as it was, for the next step
    })

    await step('14. A database attacker adds Robin (with a key) as third recipient of the 1:1 DM: Alex refuses to send, Robin gets no wrap, no Accept is offered', async () => {
      await robin.goto(BASE + '/channels/@me')
      await ready(robin)
      await turnOn(robin)
      const before = sql('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?', ids.dm)[0].n
      write('INSERT INTO dm_recipients (channel_id, user_id) VALUES (?, ?)', ids.dm, ids.robin)
      await openDm(alex)
      const warn = alex.locator('.e2ee-bar.warn').filter({ hasText: 'The key of this conversation could not be verified.' })
      await warn.waitFor(LIVE)
      check(await warn.getByRole('button').count() === 0, 'neither Accept nor a new key on offer')
      await until('the message box to refuse', async () => await composer(alex).isDisabled())
      await composer(alex).evaluate((el) => el.removeAttribute('disabled'))
      await send(alex, `to the ghost ${SFX}`)
      await alex.getByText('The key of this conversation could not be verified. Nothing was sent.').waitFor(LIVE)
      await sleep(500)
      check(sql('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?', ids.dm)[0].n === before, 'no message stored')
      check(sql('SELECT COUNT(*) AS n FROM dm_keys WHERE channel_id = ? AND user_id = ?', ids.dm, ids.robin)[0].n === 0, 'no wrap for Robin')
    })

    await step('15. Group DM: Sam adds Robin; Alex sends nothing and wraps nothing for Robin until Accept; then a new key that Robin reads, the old one never wrapped for Robin', async () => {
      await ok(api(sam, 'POST', '/users/@me/relationships', { username: NAME.robin }))
      await ok(api(robin, 'PUT', `/users/@me/relationships/${ids.sam}`, {}))
      ids.group = (await ok(api(alex, 'POST', '/users/@me/channels', { recipients: [ids.alex, ids.sam] }))).id
      const open = async (page) => (await page.goto(`${BASE}/channels/@me/${ids.group}`), await ready(page))
      const epochOf = () => sql('SELECT e2ee_epoch AS e FROM channels WHERE id = ?', ids.group)[0].e
      await open(alex)
      await until('the group to be encrypted', async () => epochOf() === 1)
      await send(alex, `group hello ${SFX}`)
      await open(sam)
      await msg(sam, `group hello ${SFX}`).locator('.content').waitFor(LIVE)
      await ok(api(sam, 'PUT', `/channels/${ids.group}/recipients/${ids.robin}`))
      await open(alex)
      const line = alex.locator('.e2ee-bar.warn').filter({ hasText: 'was added to this conversation' })
      await line.waitFor(LIVE)
      await until('the message box to refuse', async () => await composer(alex).isDisabled())
      const before = sql('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?', ids.group)[0].n
      await composer(alex).evaluate((el) => el.removeAttribute('disabled'))
      await send(alex, `before accept ${SFX}`)
      await alex.getByText(/was added to this conversation\. Accept to let them read/).last().waitFor(LIVE)
      await sleep(500)
      check(sql('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?', ids.group)[0].n === before, 'nothing sent before Accept')
      check(sql('SELECT COUNT(*) AS n FROM dm_keys WHERE channel_id = ? AND user_id = ?', ids.group, ids.robin)[0].n === 0, 'no wrap for Robin before Accept')
      await line.getByRole('button', { name: 'Accept' }).click()
      await until('the line to go after Accept', async () => (await line.count()) === 0)
      await until('the message box to open', async () => !(await composer(alex).isDisabled()))
      await send(alex, `welcome Robin ${SFX}`)
      await until('a new key for the group', async () => epochOf() === 2)
      const robinWraps = sql('SELECT epoch FROM dm_keys WHERE channel_id = ? AND user_id = ? AND wrapped != \'\'', ids.group, ids.robin).map((r) => r.epoch)
      check(robinWraps.length === 1 && robinWraps[0] === 2, `Robin has a wrap only for the new key: ${robinWraps}`)
      await open(robin)
      await msg(robin, `welcome Robin ${SFX}`).locator('.content').waitFor(LIVE)
      check(!(await msg(robin, `welcome Robin ${SFX}`).innerText()).includes('Cannot decrypt'), 'Robin reads the message with the new key')
    })

    await step('16. no uncaught page errors and no native dialogs', async () => {
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
