// End-to-end check of v6 (instance administration and customization) with Alice (instance admin), Bob, Carol, Dave and
// Eve in real browsers. Starts its own throwaway instances from server/ with client/dist and temp DATA_DIRs:
//   A on E2E_PORT (3390) with real LiveKit (LIVEKIT_API_KEY/SECRET from the environment: set -a; . ./.env; set +a),
//   B on E2E_CV_PORT (3391) with VOICE_BACKEND=cillvoice on UDP E2E_CV_UDP (3398), for the cillvoice entrance sound.
// Run: NODE_PATH=<dir with playwright> node scripts/e2e-v6.cjs   (E2E_SCREENSHOTS=1 writes docs/screenshots/v6-*.png,
// E2E_FAIL_SHOTS=<dir> saves every page when a step fails). Admin rights come from the real CLI (server/src/admin-cli.js)
// against A's DATA_DIR; TOTP codes are computed here with node:crypto. Sounds are checked with hooks on
// HTMLMediaElement.play (uploaded and soundboard sounds) and AudioContext.createOscillator (the built-in Web Audio sets).
const { chromium } = require('playwright')
const { spawn, execFileSync } = require('node:child_process')
const { createHmac } = require('node:crypto')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const zlib = require('node:zlib')

const ROOT = path.join(__dirname, '..')
const SERVER_DIR = path.join(ROOT, 'server')
const DIST = process.env.E2E_STATIC_DIR ?? path.join(ROOT, 'client', 'dist')
const PORT = Number(process.env.E2E_PORT ?? 3390)
const CV_PORT = Number(process.env.E2E_CV_PORT ?? 3391)
const CV_UDP = Number(process.env.E2E_CV_UDP ?? 3398)
const SHOTS = process.env.E2E_SCREENSHOTS ? path.join(ROOT, 'docs', 'screenshots') : null
const LIVE = { timeout: 5000 }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const SFX = Math.random().toString(36).slice(2, 7)
const NAME = { alice: `Alice_${SFX}`, bob: `Bob_${SFX}`, carol: `Carol_${SFX}`, dave: `Dave_${SFX}`, eve: `Eve_${SFX}`, x: `Xena_${SFX}`, y: `Yuri_${SFX}` }
const PASSWORD = 'correct horse battery'
const pw = { carol: PASSWORD }
const GUILD = `Squad HQ ${SFX}`
const DEN = `Den ${SFX}`
const re = (s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')

let failed = false
const errors = []
const pages = {}
const results = []
const children = []
let BASE

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
async function until(what, fn, ms = 5000) {
  for (const end = Date.now() + ms; ; await sleep(100)) {
    if (await fn().catch(() => false)) return
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`)
  }
}
const check = (ok, what) => { if (!ok) throw new Error(what) }

// RFC 6238 TOTP (SHA-1, 6 digits, 30 s) from a base32 secret, as an authenticator app computes it.
function totp(secret, at = Date.now()) {
  let bits = ''
  for (const c of secret.replace(/[\s=]/g, '').toUpperCase()) bits += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c).toString(2).padStart(5, '0')
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)))
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30000)))
  const h = createHmac('sha1', key).update(counter).digest()
  return String((h.readUInt32BE(h[19] & 15) & 0x7fffffff) % 1e6).padStart(6, '0')
}
check(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59000) === '287082', 'TOTP helper does not match the RFC 6238 test vector')
// The server accepts each time step once (replay protection) within ±1 step: hand out the next unused one, waiting if needed.
const usedStep = {}
async function freshCode(secret) {
  for (;;) {
    const t = Math.floor(Date.now() / 30000)
    const s = Math.max((usedStep[secret] ?? -1) + 1, t)
    if (s <= t + 1) return (usedStep[secret] = s), totp(secret, s * 30000)
    await sleep(1000)
  }
}

function png(w, h, rgb = [255, 80, 160]) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) raw.set([(rgb[0] * x) / w, rgb[1], (rgb[2] * y) / h], y * (w * 3 + 1) + 1 + x * 3)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const pngUri = (w, h, rgb) => `data:image/png;base64,${png(w, h, rgb).toString('base64')}`
const pngFile = (name, w, h, rgb) => ({ name, mimeType: 'image/png', buffer: png(w, h, rgb) })

// Mono 48 kHz "speech" for the fake microphone (Chromium loops it).
function speechWav(sec = 6, rate = 48000) {
  const data = Buffer.alloc(sec * rate * 2)
  for (let i = 0; i < sec * rate; i++) {
    const t = i / rate
    const ph = t % 0.55
    const env = ph < 0.45 ? Math.min(1, ph / 0.03, (0.45 - ph) / 0.03) : 0
    let v = 0
    for (let h = 1; h <= 8; h++) v += Math.sin(2 * Math.PI * 140 * h * t) / h
    data.writeInt16LE(Math.round(env * v * 0.15 * 32767), i * 2)
  }
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28)
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}
// Short Ogg/Opus sounds (soundboard, own uploads) from ffmpeg.
function soundOgg(dir, name, freq) {
  const out = path.join(dir, `${name}.ogg`)
  execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=0.6`, '-c:a', 'libopus', '-b:a', '32k', out])
  return out
}

// In every page: toasts, media played (pathname of HTMLMediaElement.play) and Web Audio oscillators started (their type).
function hooks() {
  window.__toasts = []
  window.__played = []
  window.__osc = []
  const play = HTMLMediaElement.prototype.play
  HTMLMediaElement.prototype.play = function () {
    if (this.src) window.__played.push(new URL(this.src, location.href).pathname)
    return play.call(this)
  }
  const create = AudioContext.prototype.createOscillator
  AudioContext.prototype.createOscillator = function () {
    const o = create.call(this)
    const start = o.start
    o.start = function (...a) { window.__osc.push(o.type); return start.apply(this, a) }
    return o
  }
  new MutationObserver(() => {
    for (const el of document.querySelectorAll('.toast')) if (!el.__seen) (el.__seen = true), window.__toasts.push(el.textContent)
  }).observe(document, { childList: true, subtree: true })
}
const played = (page) => page.evaluate(() => window.__played)
const oscs = (page) => page.evaluate(() => window.__osc.length)

function watch(page, name) {
  pages[name] = page
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`))
  page.on('dialog', (d) => (errors.push(`${name}: unexpected native dialog "${d.message()}"`), d.dismiss()))
}
async function newPage(browser, name, token, base) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, permissions: ['microphone', 'camera', 'clipboard-read', 'clipboard-write'], serviceWorkers: 'block' })
  await ctx.addInitScript(hooks)
  if (token) await ctx.addInitScript((t) => localStorage.getItem('token') || localStorage.setItem('token', t), token)
  const page = await ctx.newPage()
  watch(page, name)
  if (base) await page.goto(base + '/')
  return page
}
async function ready(page) {
  await page.getByRole('navigation', { name: /^(Servers|Server)$/ }).waitFor()
  await until('the gateway to connect (no "Connecting…")', async () => (await page.getByText(/Connecting…|Verbinde…/).count()) === 0, 10000)
}
async function register(page, name, code) {
  await page.goto(BASE + '/register')
  await page.getByRole('heading', { name: 'Join the roster' }).waitFor()
  await page.getByLabel('Email').fill(`${name.toLowerCase()}@example.com`)
  await page.getByLabel('Username').fill(name)
  await page.getByLabel('Password').fill(PASSWORD)
  if (code) await page.getByLabel('Registration code').fill(code)
  await page.getByLabel(/I am at least/).check() // 7.10.3 sign-up check
  await page.getByRole('button', { name: 'Continue' }).click()
}
async function loginForm(page, name, password = PASSWORD) {
  await page.goto(BASE + '/login')
  await page.getByRole('heading', { name: 'Ready up' }).waitFor()
  await page.getByLabel('Email or username').fill(name)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Log In' }).click()
}
async function login(page, name, password) {
  await loginForm(page, name, password)
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
// REST from the test itself (users without a page, instance B setup).
async function rest(base, token, method, route, body) {
  const r = await fetch(base + '/api/v9' + route, { method, headers: { ...(token && { Authorization: token }), ...(body && { 'Content-Type': 'application/json' }) }, body: body && JSON.stringify(body) })
  const out = { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }
  check(r.status < 300, `${method} ${route} answered ${r.status}: ${JSON.stringify(out.body)}`)
  return out.body
}
const fetchStatus = (page, url) => page.evaluate(async (u) => (await fetch(u)).status, url)

const rail = (page) => page.getByRole('navigation', { name: /^(Servers|Server)$/ })
const channels = (page, guild = GUILD) => page.getByRole('navigation', { name: `${guild} channels` })
const voiceRow = (page, guild) => channels(page, guild).getByRole('button', { name: /^General \(voice channel/ })
const members = (page) => page.getByRole('complementary', { name: 'Members' })
const modal = (page, name) => page.getByRole('dialog', { name })
const msg = (page, text) => page.locator('li.msg').filter({ hasText: text })
const banner = (page) => page.locator('.instance-banner')
async function openChannel(page, name, guild = ids.guild) {
  await page.goto(`${BASE}/channels/${guild}/${ids[name]}`)
  await ready(page)
}
async function userSettings(page, tab) {
  await page.getByRole('button', { name: 'User Settings' }).click()
  await page.getByRole('tab', { name: tab, exact: true }).click()
}
async function serverSettings(page, tab) {
  await openChannel(page, 'general')
  await page.getByRole('button', { name: GUILD, exact: true }).click()
  await page.getByRole('button', { name: 'Server Settings' }).click()
  await page.getByRole('tab', { name: tab, exact: true }).click()
}
const closeSettings = (page) => page.getByRole('button', { name: 'Close settings' }).click()
async function joinVoice(page, guild) {
  await voiceRow(page, guild).click()
  await page.getByRole('status').filter({ hasText: 'Voice Connected' }).waitFor({ timeout: 20000 })
}
const leaveVoice = (page) => page.getByRole('region', { name: 'Voice connection' }).getByRole('button', { name: 'Disconnect' }).click()
async function admin(page, tab) {
  await page.goto(`${BASE}/admin/${tab}`)
  await page.getByRole('heading', { level: 1 }).first().waitFor()
}
// Confirms the topmost dialog with this title by clicking `button` (ask/askText dialogs of the dashboard).
const confirmIn = (page, title, button) => modal(page, title).getByRole('button', { name: button, exact: true }).click()
const shot = async (page, name) => {
  if (!SHOTS) return
  await page.mouse.move(0, 0)
  await until('toasts to clear before the screenshot', async () => (await page.locator('.toast').count()) === 0, 10000).catch(() => {})
  await sleep(500)
  await page.screenshot({ path: path.join(SHOTS, `v6-${name}.png`) })
}

// WCAG 2.x contrast of '#rrggbb' / 'rgb(r g b / a)' colours; translucent colours are put over `under` first.
function parseColor(c) {
  c = c.trim()
  if (c.startsWith('#')) return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16), 1]
  const n = c.match(/[\d.]+/g).map(Number)
  return [n[0], n[1], n[2], n[3] ?? 1]
}
const over = (top, under) => { const [r, g, b, a] = parseColor(top); const u = parseColor(under); return [0, 1, 2].map((i) => Math.round([r, g, b][i] * a + u[i] * (1 - a))) }
const lum = ([r, g, b]) => [r, g, b].map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0)
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }

async function startServer(tmp, name, port, env) {
  const dir = fs.mkdtempSync(path.join(tmp, `${name}-data-`))
  const out = fs.openSync(path.join(tmp, `${name}.log`), 'w')
  const p = spawn(process.execPath, ['src/index.js'], { cwd: SERVER_DIR, env: { ...env, PORT: String(port), DATA_DIR: dir, STATIC_DIR: DIST }, stdio: ['ignore', out, out] })
  children.push(p)
  const base = `http://127.0.0.1:${port}`
  await until(`instance ${name} on port ${port}`, async () => (await fetch(base + '/api/v9/instance')).ok, 20000)
  return { base, dir }
}

const ids = {}

async function main() {
  if (!process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) throw new Error('LIVEKIT_API_KEY / LIVEKIT_API_SECRET missing: run `set -a; . ./.env; set +a` first')
  if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error(`no client build in ${DIST}: run npm run build in client/`)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cillcord-e2e6-'))
  const wav = path.join(tmp, 'speech.wav')
  fs.writeFileSync(wav, speechWav())
  const boop = soundOgg(tmp, 'boop', 660)
  const horn = soundOgg(tmp, 'horn', 440)
  const oggUri = (f) => `data:audio/ogg;base64,${fs.readFileSync(f).toString('base64')}`
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required'] })
  const lkEnv = { ...process.env, LIVEKIT_URL: process.env.LIVEKIT_URL ?? 'http://127.0.0.1:7880', LIVEKIT_PUBLIC_URL: process.env.LIVEKIT_PUBLIC_URL ?? 'ws://127.0.0.1:7880' }
  const cvEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('LIVEKIT_')))
  Object.assign(cvEnv, { VOICE_BACKEND: 'cillvoice', CILLVOICE_UDP_PORT: String(CV_UDP), CILLVOICE_PUBLIC_IP: '127.0.0.1' })
  try {
    const A = await startServer(tmp, 'livekit', PORT, lkEnv)
    BASE = A.base
    const alice = await newPage(browser, 'Alice')
    const bob = await newPage(browser, 'Bob')
    const carol = await newPage(browser, 'Carol')
    let aliceSecret

    await step(`0. instance A (LiveKit) on :${PORT}; Alice, Bob and Carol register (suffix ${SFX}); Alice creates ${GUILD} with a Staff role, Bob and Carol join`, async () => {
      for (const [p, n] of [[alice, NAME.alice], [bob, NAME.bob], [carol, NAME.carol]]) {
        await register(p, n)
        await p.waitForURL('**/channels/@me')
        await ready(p)
      }
      for (const [k, p] of Object.entries({ alice, bob, carol })) ids[k] = (await api(p, 'GET', '/users/@me')).body.id
      await alice.getByRole('button', { name: 'Add a server' }).click()
      const dialog = modal(alice, 'Add a server')
      await dialog.getByLabel('Server name').first().fill(GUILD)
      await dialog.getByRole('button', { name: 'Create', exact: true }).click()
      await alice.getByRole('heading', { level: 1, name: 'general' }).waitFor()
      ids.guild = new URL(alice.url()).pathname.split('/')[2]
      ids.general = new URL(alice.url()).pathname.split('/')[3]
      const chans = await ok(api(alice, 'GET', `/guilds/${ids.guild}/channels`))
      ids.voice = chans.find((c) => c.type === 2).id
      ids.staff = (await ok(api(alice, 'POST', `/guilds/${ids.guild}/roles`, { name: 'Staff', color: 0x3498db, hoist: true, permissions: '0' }))).id
      ids.invite = (await ok(api(alice, 'POST', `/channels/${ids.general}/invites`, { max_age: 0 }))).code
      for (const p of [bob, carol]) {
        await p.goto(`${BASE}/invite/${ids.invite}`)
        await p.getByRole('button', { name: 'Join' }).click()
        await ready(p)
      }
    })

    // ---------------------------------------------------------------- administration
    await step('1. the admin CLI grants Alice; the dashboard refuses her without 2FA; Bob (no admin) is refused and redirected', async () => {
      const out = execFileSync(process.execPath, ['src/admin-cli.js', 'grant', NAME.alice], { cwd: SERVER_DIR, env: { ...process.env, DATA_DIR: A.dir }, encoding: 'utf8' })
      check(re(NAME.alice).test(out), `CLI output: ${out.trim()}`)
      check(execFileSync(process.execPath, ['src/admin-cli.js', 'list'], { cwd: SERVER_DIR, env: { ...process.env, DATA_DIR: A.dir }, encoding: 'utf8' }).toLowerCase().includes(NAME.alice.toLowerCase()), 'CLI list shows Alice')
      await alice.reload()
      await ready(alice)
      await alice.getByRole('button', { name: /^Set status/ }).click()
      await alice.getByRole('menuitem', { name: 'Admin Dashboard' }).click()
      await alice.getByRole('heading', { name: 'Two-factor authentication required' }).waitFor()
      const r = await api(alice, 'GET', '/admin/overview')
      check(r.status === 403 && r.body?.code === 60003, `admin without 2FA: ${r.status} ${JSON.stringify(r.body)}`)
      const b = await api(bob, 'GET', '/admin/users')
      check(b.status === 403 && b.body?.code === 50001, `non-admin: ${b.status} ${JSON.stringify(b.body)}`)
      await bob.goto(BASE + '/admin/users')
      await bob.waitForURL('**/channels/@me')
      await bob.getByRole('button', { name: /^Set status/ }).click()
      check((await bob.getByRole('menuitem', { name: 'Admin Dashboard' }).count()) === 0, 'Bob has no Admin Dashboard entry')
      await bob.keyboard.press('Escape')
    })

    await step('2. Alice enables 2FA (TOTP computed with node:crypto); the Overview shows users, servers, messages and LiveKit health', async () => {
      await alice.getByRole('button', { name: 'Open Security Settings' }).click()
      await alice.getByRole('button', { name: 'Enable Authenticator App' }).click()
      const twofa = modal(alice, 'Enable Two-Factor Auth')
      await twofa.getByLabel('Password').fill(PASSWORD)
      await twofa.getByRole('button', { name: 'Continue' }).click()
      aliceSecret = (await twofa.getByLabel('2FA key').innerText()).replace(/\s/g, '')
      await twofa.getByLabel('6-digit code').fill(await freshCode(aliceSecret))
      await twofa.getByRole('button', { name: 'Activate' }).click()
      await twofa.getByRole('list', { name: 'Backup codes' }).getByRole('listitem').first().waitFor()
      await twofa.getByRole('button', { name: 'Done' }).click()
      await ok(api(alice, 'POST', `/channels/${ids.general}/messages`, { content: `hello admins ${SFX}` }))
      await admin(alice, 'overview')
      const tiles = alice.getByRole('list', { name: 'Instance statistics' })
      const tile = async (label) => Number((await tiles.getByRole('listitem').filter({ hasText: label }).first().locator('.admin-tile-value').innerText()).replace(/\D/g, ''))
      await tiles.waitFor()
      check((await tile('Users')) >= 3, 'users tile')
      check((await tile('Servers')) >= 1, 'servers tile')
      check((await tile('Messages')) >= 1, 'messages tile')
      await alice.getByText('LiveKit: OK').waitFor()
      await shot(alice, 'admin-overview')
    })

    await step('3. Users: search finds Bob; his detail lists the server, his session and the empty audit trail', async () => {
      await admin(alice, 'users')
      await alice.getByLabel('Search by username, display name or email').fill(NAME.bob)
      await alice.getByRole('table').getByRole('button', { name: re(NAME.bob) }).click()
      const drawer = modal(alice, /^User /)
      await drawer.getByRole('list').filter({ hasText: GUILD }).waitFor()
      check((await drawer.getByRole('table', { name: 'Sessions and devices' }).getByRole('row').count()) >= 2, 'a session row')
      await shot(alice, 'admin-users')
    })

    await step('4. disabling Bob closes his session and refuses his login; enabling lets him back in', async () => {
      const drawer = modal(alice, /^User /)
      await drawer.getByRole('button', { name: 'Disable Account' }).click()
      await confirmIn(alice, /^Disable /, 'Disable Account')
      await bob.getByRole('heading', { name: 'Ready up' }).waitFor(LIVE)
      await loginForm(bob, NAME.bob)
      await bob.getByText('This account has been disabled.').waitFor()
      await drawer.getByRole('button', { name: 'Enable Account' }).click()
      await drawer.getByRole('button', { name: 'Disable Account' }).waitFor()
      await login(bob, NAME.bob)
      await drawer.getByRole('button', { name: 'Close' }).click()
    })

    await step('5. Force Logout ends all of Carol\'s sessions', async () => {
      await alice.getByLabel('Search by username, display name or email').fill(NAME.carol)
      await alice.getByRole('table').getByRole('button', { name: re(NAME.carol) }).click()
      const drawer = modal(alice, /^User /)
      await drawer.getByRole('button', { name: 'Force Logout' }).click()
      await confirmIn(alice, 'Log out everywhere?', 'Log Out Everywhere')
      await carol.getByRole('heading', { name: 'Ready up' }).waitFor(LIVE)
    })

    await step('6. Require Password Change: Carol must choose a new password at her next login before entering', async () => {
      const drawer = modal(alice, /^User /)
      await drawer.getByRole('button', { name: 'Require Password Change' }).click()
      await confirmIn(alice, 'Require a new password?', 'Require Password Change')
      await drawer.getByText('must change password').waitFor()
      await loginForm(carol, NAME.carol)
      await carol.getByRole('heading', { name: 'Choose a new password' }).waitFor()
      pw.carol = `${PASSWORD} 2`
      await carol.getByLabel('Current Password').fill(PASSWORD)
      await carol.getByLabel('New Password', { exact: true }).fill(pw.carol)
      await carol.getByLabel('Confirm New Password').fill(pw.carol)
      await carol.getByRole('button', { name: 'Change Password' }).click()
      await carol.waitForURL('**/channels/**')
      await ready(carol)
      check((await api(carol, 'GET', `/guilds/${ids.guild}/channels`)).status === 200, 'Carol can use the API again')
      await drawer.getByRole('button', { name: 'Close' }).click()
    })

    await step('7. Reset 2FA: Bob turns on 2FA; Alice resets it with her own TOTP code after confirming', async () => {
      const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'
      await ok(api(bob, 'POST', '/users/@me/mfa/totp/enable', { password: PASSWORD, secret, code: totp(secret) }))
      await alice.getByLabel('Search by username, display name or email').fill(NAME.bob)
      await alice.getByRole('table').getByRole('button', { name: re(NAME.bob) }).click()
      const drawer = modal(alice, /^User /)
      await drawer.getByRole('button', { name: 'Reset 2FA' }).click()
      const dlg = modal(alice, 'Reset 2FA?')
      await dlg.getByLabel('Authentication or backup code').fill('000000')
      await dlg.getByRole('button', { name: 'Reset 2FA' }).click()
      await until('the wrong code to be refused', async () => (await alice.evaluate(() => window.__toasts.join(' '))).match(/code/i))
      check((await api(bob, 'GET', '/users/@me')).body.mfa_enabled === true, 'a wrong code changes nothing')
      await drawer.getByRole('button', { name: 'Reset 2FA' }).click()
      await dlg.getByLabel('Authentication or backup code').fill(await freshCode(aliceSecret))
      await dlg.getByRole('button', { name: 'Reset 2FA' }).click()
      await until('Bob\'s 2FA to be off', async () => (await api(bob, 'GET', '/users/@me')).body.mfa_enabled === false)
      await drawer.getByRole('button', { name: 'Close' }).click()
    })

    await step(`8. Servers: Carol's "${DEN}" in the list; transfer to Bob (2FA), disable invites (joining refused), delete after typing the name`, async () => {
      const den = await ok(api(carol, 'POST', '/guilds', { name: DEN }))
      ids.den = den.id
      const denGeneral = (await ok(api(carol, 'GET', `/guilds/${den.id}/channels`))).find((c) => c.type === 0)
      const inv = await ok(api(carol, 'POST', `/channels/${denGeneral.id}/invites`, { max_age: 0 }))
      await ok(api(bob, 'POST', `/invites/${inv.code}`))
      await admin(alice, 'servers')
      await alice.getByLabel('Search by server name').fill(DEN)
      await alice.getByRole('table').getByRole('button', { name: DEN }).click()
      const drawer = modal(alice, `Server ${DEN}`)
      await drawer.getByText('general').first().waitFor()
      await drawer.getByRole('button', { name: 'Transfer Ownership' }).click()
      await modal(alice, 'Transfer Ownership').getByLabel('User ID of the new owner').fill(ids.bob)
      await confirmIn(alice, 'Transfer Ownership', 'Continue')
      await modal(alice, 'Transfer Ownership').getByLabel('Authentication or backup code').fill(await freshCode(aliceSecret))
      await confirmIn(alice, 'Transfer Ownership', 'Transfer Ownership')
      await until('Bob to own the server', async () => (await api(bob, 'GET', `/guilds/${den.id}`)).body?.owner_id === ids.bob)
      await drawer.getByRole('button', { name: 'Disable Invites' }).click()
      await confirmIn(alice, 'Disable invites?', 'Disable Invites')
      await drawer.getByRole('button', { name: 'Enable Invites' }).waitFor()
      const join = await api(alice, 'POST', `/invites/${inv.code}`)
      check(join.status === 403, `joining with invites disabled: ${join.status}`)
      check((await api(carol, 'POST', `/channels/${denGeneral.id}/invites`, { max_age: 0 })).status === 403, 'creating invites refused')
      await drawer.getByRole('button', { name: 'Delete Server' }).click()
      await modal(alice, `Delete ${DEN}?`).getByLabel('Type the server name to confirm').fill(DEN)
      await confirmIn(alice, `Delete ${DEN}?`, 'Continue')
      await modal(alice, `Delete ${DEN}?`).getByLabel('Authentication or backup code').fill(await freshCode(aliceSecret))
      await confirmIn(alice, `Delete ${DEN}?`, 'Delete Server')
      await until('the server to be gone for Bob', async () => (await api(bob, 'GET', `/guilds/${den.id}`)).status === 404)
      await rail(bob).getByRole('link', { name: re(DEN) }).waitFor({ state: 'detached', ...LIVE })
    })

    await step('9. Bob reports Carol\'s message from the message menu; Alice sees it in Reports and resolves it with a timeout', async () => {
      const text = `buy cheap skins at totally-legit ${SFX}`
      ids.reported = (await ok(api(carol, 'POST', `/channels/${ids.general}/messages`, { content: text }))).id
      await openChannel(bob, 'general')
      await msg(bob, text).click({ button: 'right' })
      await bob.getByRole('menuitem', { name: 'Report Message' }).click()
      const dlg = modal(bob, 'Report Message')
      await dlg.getByRole('radio', { name: 'Spam or scam' }).check()
      await dlg.getByLabel('Note (optional)').fill('scam link')
      await dlg.getByRole('button', { name: 'Report', exact: true }).click()
      await until('the report toast', async () => (await bob.evaluate(() => window.__toasts.join(' '))).includes('The instance admins will review'))
      await admin(alice, 'reports')
      const card = alice.locator('.admin-report').filter({ hasText: text })
      await card.getByText('“scam link”').waitFor()
      await card.getByText(`Reported by ${NAME.bob.toLowerCase()}`, { exact: false }).or(card.getByText(`Reported by ${NAME.bob}`, { exact: false })).first().waitFor()
      await shot(alice, 'admin-reports')
      await card.getByRole('button', { name: 'Timeout Author' }).click()
      const t = modal(alice, /^Timeout /)
      await t.getByLabel('Minutes (1 to 40320)').fill('30')
      await t.getByRole('button', { name: 'Timeout', exact: true }).click()
      await card.waitFor({ state: 'detached' })
      const m = await ok(api(alice, 'GET', `/guilds/${ids.guild}/members/${ids.carol}`))
      check(Date.parse(m.communication_disabled_until) > Date.now() + 25 * 60e3, `Carol timed out until ${m.communication_disabled_until}`)
      await alice.getByRole('button', { name: 'Resolved' }).click()
      await alice.locator('.admin-report').filter({ hasText: text }).getByText('Author timed out').waitFor()
      await ok(api(alice, 'PATCH', `/guilds/${ids.guild}/members/${ids.carol}`, { communication_disabled_until: null }))
    })

    await step('10. registration invite-only with a code from the dashboard; the message of the day shows on the login page', async () => {
      const motd = `Scrim night on Friday ${SFX}`
      await admin(alice, 'settings')
      await alice.getByLabel('Invite-only').check()
      await alice.getByLabel('Message of the day').fill(motd)
      await alice.getByRole('button', { name: 'Save Changes' }).click()
      await alice.getByText('Saved.').waitFor()
      await alice.getByRole('button', { name: 'Create Code' }).click()
      const code = (await alice.getByRole('table', { name: 'Registration codes' }).locator('td code').first().innerText()).trim()
      check(/^[A-Z2-9]{10}$/.test(code), `code ${code}`)
      const eve = await newPage(browser, 'Eve', null, BASE)
      await eve.goto(BASE + '/login')
      await eve.getByRole('note', { name: 'Message of the day' }).getByText(motd).waitFor()
      await register(eve, NAME.eve, 'WRONGCODE2')
      await eve.locator('.field.invalid input[name=registration_code]').waitFor()
      check(eve.url().includes('/register'), 'a wrong code keeps Eve on the register page')
      await eve.getByLabel('Registration code').fill(code)
      await eve.getByRole('button', { name: 'Continue' }).click()
      await eve.waitForURL('**/channels/@me')
      await ready(eve)
      await banner(eve).getByText(motd).waitFor()
      await eve.context().close()
      delete pages.Eve
      await alice.getByLabel('Open', { exact: true }).check()
      await alice.getByLabel('Message of the day').fill('')
      await alice.getByRole('button', { name: 'Save Changes' }).click()
      await alice.getByText('Saved.').waitFor()
    })

    await step('11. an announcement from the dashboard appears as a banner for Bob and Carol', async () => {
      const text = `Maintenance tonight at 23:00 ${SFX}`
      await admin(alice, 'announcements')
      await alice.getByLabel('New announcement').fill(text)
      await alice.getByRole('button', { name: 'Send Announcement' }).click()
      await confirmIn(alice, 'Send announcement?', 'Send')
      for (const p of [bob, carol]) await banner(p).getByText(text).waitFor(LIVE)
      await banner(bob).getByRole('button', { name: 'Dismiss' }).click()
      await banner(bob).getByText(text).waitFor({ state: 'detached' })
    })

    await step('12. the admin audit log lists every action (CLI grant included) and filters by action', async () => {
      await admin(alice, 'audit-log')
      const table = alice.getByRole('table', { name: 'Admin Audit Log' })
      await table.waitFor()
      const actions = (await table.locator('tbody tr td:nth-child(3)').allInnerTexts()).map((s) => s.trim())
      for (const a of ['cli.grant', 'user.disable', 'user.enable', 'user.logout', 'user.require_password_change', 'user.reset_mfa', 'guild.transfer', 'guild.invites_disable', 'guild.delete', 'report.timeout', 'settings.update', 'registration_code.create', 'announcement.send'])
        check(actions.includes(a), `audit log has ${a} (${[...new Set(actions)].join(', ')})`)
      await alice.getByLabel('Action', { exact: true }).fill('guild.')
      await alice.getByRole('button', { name: 'Filter' }).click()
      await until('the filtered list', async () => (await table.locator('tbody tr td:nth-child(3)').allInnerTexts()).every((s) => s.startsWith('guild.')))
    })

    await step('13. no DM content is reachable for the admin: no admin answer contains it, the DM itself is refused', async () => {
      const secret = `dm secret ${SFX} do not read`
      const dm = await ok(api(bob, 'POST', '/users/@me/channels', { recipient_id: ids.carol }))
      await ok(api(bob, 'POST', `/channels/${dm.id}/messages`, { content: secret }))
      const routes = ['/admin/overview', '/admin/users?limit=200', `/admin/users/${ids.bob}`, `/admin/users/${ids.carol}`, '/admin/guilds', `/admin/guilds/${ids.guild}`,
        '/admin/reports?status=all', '/admin/audit-log?limit=500', '/admin/settings', '/admin/registration-codes']
      for (const r of routes) {
        const a = await api(alice, 'GET', r)
        check(a.status === 200, `${r}: ${a.status}`)
        check(!JSON.stringify(a.body).includes(secret), `${r} leaks the DM`)
      }
      for (const r of [`/channels/${dm.id}/messages`, `/channels/${dm.id}`]) {
        const s = (await api(alice, 'GET', r)).status
        check(s === 403 || s === 404, `${r} answered ${s} for the admin`)
      }
    })

    // ---------------------------------------------------------------- customization
    let themeCode
    await step('14. themes: Bob creates a theme in the editor (applied live), shares it; Carol imports the code and it applies at once', async () => {
      await openChannel(bob, 'general')
      await userSettings(bob, 'Appearance')
      const us = modal(bob, 'User Settings')
      await us.getByRole('button', { name: 'Create Theme' }).click()
      await us.getByLabel('Theme name').fill(`Squad ${SFX}`)
      for (const [label, hex] of [['Background', '#101820'], ['Surface', '#1a2633'], ['Accent', '#ff00aa'], ['Text', '#eef3f8']]) await us.getByRole('textbox', { name: label, exact: true }).fill(hex)
      await until('the live preview to use the accent', async () => (await bob.evaluate(() => document.documentElement.style.getPropertyValue('--accent'))) === '#ff00aa')
      await us.getByRole('switch', { name: 'Gradient background' }).check()
      await shot(bob, 'theme-editor')
      await us.getByRole('button', { name: 'Save Theme' }).click()
      await until('the theme to be saved', async () => (await api(bob, 'GET', '/users/@me/settings')).body.custom_themes?.length === 1)
      const s = (await api(bob, 'GET', '/users/@me/settings')).body
      check(s.active_theme === s.custom_themes[0].id && s.custom_themes[0].accent === '#ff00aa', `saved and active: ${JSON.stringify(s.custom_themes)}`)
      await us.getByRole('list', { name: 'Your themes' }).getByRole('button', { name: 'Share' }).click()
      await until('the code on the clipboard', async () => /^CT1\./.test((themeCode = await bob.evaluate(() => navigator.clipboard.readText()))))
      await closeSettings(bob)
      check((await bob.evaluate(() => document.documentElement.style.getPropertyValue('--accent'))) === '#ff00aa', 'Bob\'s app uses the saved theme')
      await openChannel(carol, 'general')
      await userSettings(carol, 'Appearance')
      const cs = modal(carol, 'User Settings')
      await cs.getByLabel('Theme code').fill(themeCode)
      await cs.getByRole('button', { name: 'Import' }).click()
      await until('Carol\'s app to use the imported theme', async () => (await carol.evaluate(() => document.documentElement.style.getPropertyValue('--accent'))) === '#ff00aa')
      const c = (await api(carol, 'GET', '/users/@me/settings')).body
      check(c.custom_themes.length === 1 && c.active_theme === c.custom_themes[0].id, 'imported theme stored and active')
      await cs.getByRole('radio', { name: 'Built-in theme' }).check({ force: true })
      await closeSettings(carol)
    })

    await step('15. custom CSS: sanitised (no @import or external url(), escapes in strings kept) and applied; ?safe=1 turns it off', async () => {
      await userSettings(bob, 'Appearance')
      const us = modal(bob, 'User Settings')
      await us.getByRole('switch', { name: 'Enable custom CSS' }).check()
      await us.getByLabel('Your CSS').fill('@import url(https://evil.example/x.css);\n.chat-header { outline: 3px solid rgb(255, 0, 170); }\n.chat-header h1::after { content: " \\2022"; }\n.chat { background-image: url(https://evil.example/p.png); }')
      await us.getByRole('button', { name: 'Save CSS' }).click()
      await closeSettings(bob)
      const css = await bob.locator('#cillcord-custom-css').textContent()
      check(css.includes('outline: 3px') && css.includes('" \\2022"') && !css.includes('evil.example') && !css.includes('@import'), `sanitised CSS: ${JSON.stringify(css)}`)
      check((await bob.evaluate(() => getComputedStyle(document.querySelector('.chat-header')).outlineColor)) === 'rgb(255, 0, 170)', 'CSS applied')
      check((await bob.evaluate(() => getComputedStyle(document.querySelector('.chat-header h1'), '::after').content)) === '" •"', 'the escape inside a string works')
      await bob.goto(`${BASE}/channels/${ids.guild}/${ids.general}?safe=1`)
      await ready(bob)
      check((await bob.locator('#cillcord-custom-css').count()) === 0, 'no custom CSS in safe mode')
      await openChannel(bob, 'general')
      await bob.locator('#cillcord-custom-css').waitFor({ state: 'attached' })
      await ok(api(bob, 'PATCH', '/users/@me/settings', { custom_css_enabled: false }))
      await bob.locator('#cillcord-custom-css').waitFor({ state: 'detached' })
    })

    await step('16. chat font and an uploaded chat background (PUT /users/@me/chat-background, served from the CDN)', async () => {
      await userSettings(bob, 'Appearance')
      const us = modal(bob, 'User Settings')
      await us.getByRole('radio', { name: /JetBrains Mono/ }).check({ force: true })
      await us.locator('section[aria-labelledby="chat-look"] input[type=file]').setInputFiles(pngFile('bg.png', 320, 180, [40, 120, 200]))
      await until('the background to be stored', async () => typeof (await api(bob, 'GET', '/users/@me/settings')).body.chat_background === 'string')
      await us.getByLabel(/Background visibility/).waitFor()
      await closeSettings(bob)
      const s = (await api(bob, 'GET', '/users/@me/settings')).body
      check(s.chat_font === 'jetbrains-mono', `chat_font ${s.chat_font}`)
      const url = await bob.evaluate(() => document.documentElement.style.getPropertyValue('--chat-bg-image'))
      check(url.includes(`/chat-backgrounds/${ids.bob}/${s.chat_background}`), `background url ${url}`)
      check((await fetchStatus(bob, `/chat-backgrounds/${ids.bob}/${s.chat_background}`)) === 200, 'background served')
      check(/JetBrains Mono/.test(await bob.evaluate(() => getComputedStyle(document.querySelector('.messages')).fontFamily)), 'chat font applied')
    })

    await step('17. Bob\'s display name style, avatar decoration, nameplate, profile effect, profile colours and widgets are visible to Alice', async () => {
      await userSettings(bob, 'Profiles')
      const us = modal(bob, 'User Settings')
      await us.getByRole('checkbox', { name: 'Use profile colours' }).check()
      await us.getByLabel('Font').selectOption('14')
      await us.getByLabel('Effect').selectOption('2')
      await us.getByRole('radio', { name: 'Neon Ring' }).check({ force: true })
      await us.getByRole('radio', { name: 'Confetti' }).check({ force: true })
      await us.getByRole('radio', { name: 'Neon', exact: true }).check({ force: true })
      await us.getByRole('button', { name: 'Add main game' }).click()
      await us.getByLabel('Main game').fill('VALORANT')
      await us.getByRole('button', { name: 'Add socials' }).click()
      await us.getByLabel('Social links (one per line)').fill('https://www.twitch.tv/bob_plays\nhttps://youtube.com/@bob')
      await us.getByRole('button', { name: 'Add rank' }).click()
      await us.getByLabel('Game', { exact: true }).fill('CS2')
      await us.getByLabel('Rank', { exact: true }).fill('Global Elite')
      await us.locator('.profile-preview .avatar .deco').waitFor()
      await shot(bob, 'profile-custom')
      await us.getByRole('button', { name: 'Save Changes' }).click()
      await us.getByText('Saved.').waitFor()
      await closeSettings(bob)
      const me = (await api(bob, 'GET', '/users/@me')).body
      check(me.display_name_styles?.font_id === 14 && me.display_name_styles.effect_id === 2 && me.display_name_styles.colors.length === 2, `styles ${JSON.stringify(me.display_name_styles)}`)
      check(me.avatar_decoration_data?.asset === 'cc_neon_ring' && me.collectibles?.nameplate?.asset === 'np_neon', 'decoration and nameplate stored')
      await openChannel(alice, 'general')
      await ok(api(alice, 'POST', `/channels/${ids.general}/messages`, { content: `breaker ${SFX} a` }))
      const text = `check my profile ${SFX}`
      await ok(api(bob, 'POST', `/channels/${ids.general}/messages`, { content: text }))
      const m = msg(alice, text)
      await m.waitFor(LIVE)
      check(/ns-f14 ns-x2/.test(await m.locator('.author .ns').first().getAttribute('class')), 'gradient name in Mainframe font')
      await m.locator('.avatar .deco').waitFor()
      await members(alice).locator('li.nameplate').filter({ hasText: re(NAME.bob) }).waitFor()
      await members(alice).getByRole('button', { name: re(NAME.bob) }).click({ button: 'right' })
      await alice.getByRole('menuitem', { name: 'Profile' }).click()
      const prof = modal(alice, re(NAME.bob))
      await prof.locator('.pcard.themed').waitFor()
      await prof.locator('.pfx.fx_confetti').waitFor()
      await prof.getByText('VALORANT').waitFor()
      await prof.getByText('Global Elite').waitFor()
      check((await prof.getByRole('link', { name: /Twitch/ }).getAttribute('href')) === 'https://www.twitch.tv/bob_plays', 'Twitch link')
      await alice.keyboard.press('Escape')
      // a server-uploaded decoration: Alice uploads it, Carol wears it, Bob sees it from /avatar-decoration-presets/
      const deco = await ok(api(alice, 'POST', `/guilds/${ids.guild}/avatar-decorations`, { name: 'Club Frame', image: pngUri(96, 96, [255, 200, 0]) }))
      await ok(api(carol, 'PATCH', '/users/@me', { avatar_decoration_sku_id: deco.id }))
      const img = members(bob).locator('li').filter({ hasText: re(NAME.carol) }).locator('img.deco')
      await img.waitFor(LIVE)
      check((await img.getAttribute('src')).endsWith(`/avatar-decoration-presets/${deco.asset}.png`), `decoration src ${await img.getAttribute('src')}`)
      await until('the uploaded decoration to load', () => img.evaluate((e) => e.complete && e.naturalWidth === 96))
    })

    await step('18. role icon (uploaded image) and gradient role colour from Server Settings are shown on Bob\'s name for Carol', async () => {
      await serverSettings(alice, 'Roles')
      await alice.getByRole('button', { name: /Staff/ }).first().click()
      await alice.getByRole('switch', { name: 'Gradient' }).check()
      await alice.getByLabel('Role icon image').setInputFiles(pngFile('icon.png', 64, 64, [0, 220, 255]))
      await alice.getByRole('button', { name: 'Save Changes' }).click()
      await until('the role to have an icon and a gradient', async () => {
        const r = (await api(alice, 'GET', `/guilds/${ids.guild}/roles`)).body.find((x) => x.id === ids.staff)
        return r.icon && r.colors?.secondary_color
      })
      await closeSettings(alice)
      await ok(api(alice, 'PUT', `/guilds/${ids.guild}/members/${ids.bob}/roles/${ids.staff}`))
      await openChannel(carol, 'general')
      await ok(api(alice, 'POST', `/channels/${ids.general}/messages`, { content: `breaker ${SFX} b` }))
      const text = `staff here ${SFX}`
      await ok(api(bob, 'POST', `/channels/${ids.general}/messages`, { content: text }))
      const m = msg(carol, text)
      await m.waitFor(LIVE)
      check(/ns-x2/.test(await m.locator('.author .ns').first().getAttribute('class')), 'role gradient on the name')
      const icon = m.getByRole('img', { name: 'Role icon: Staff' })
      check(/\/roles\/\d+\/icons\/[0-9a-f]{32}\.png$/.test(await icon.getAttribute('src')), `role icon src ${await icon.getAttribute('src')}`)
      await until('the role icon to load', () => icon.evaluate((e) => e.complete && e.naturalWidth === 64))
      await members(carol).getByRole('img', { name: 'Role icon: Staff' }).first().waitFor()
      await shot(carol, 'role-icons')
    })

    await step('19. server tag: Alice creates "CILL" in Customization, Bob chooses it in Profiles, Carol sees it next to his name', async () => {
      await serverSettings(alice, 'Customization')
      await alice.getByLabel('Tag', { exact: true }).fill('cill')
      await alice.getByTitle('Crown').click()
      await alice.getByRole('button', { name: 'Save Tag' }).click()
      await alice.getByText('Saved.').first().waitFor()
      await closeSettings(alice)
      await userSettings(bob, 'Profiles')
      await modal(bob, 'User Settings').getByLabel('Server tag').selectOption(ids.guild)
      await until('the tag to be chosen', async () => (await api(bob, 'GET', '/users/@me')).body.primary_guild?.tag === 'CILL')
      await closeSettings(bob)
      const text = `tag check ${SFX}`
      await ok(api(alice, 'POST', `/channels/${ids.general}/messages`, { content: `breaker ${SFX} c` }))
      await ok(api(bob, 'POST', `/channels/${ids.general}/messages`, { content: text }))
      await msg(carol, text).locator('.server-tag', { hasText: 'CILL' }).waitFor(LIVE)
      await members(carol).locator('li').filter({ hasText: re(NAME.bob) }).locator('.server-tag', { hasText: 'CILL' }).waitFor()
      await shot(carol, 'server-tag')
    })

    await step('20. channel icon and accent colour from Channel Settings show in Bob\'s sidebar and header', async () => {
      await openChannel(alice, 'general')
      await channels(alice).getByRole('button', { name: 'Edit channel general', exact: true }).click()
      const cs = modal(alice, /general/)
      await cs.getByLabel('Channel icon').fill('🎮')
      await cs.getByRole('checkbox', { name: 'Channel accent colour' }).check()
      await cs.getByRole('textbox', { name: 'Accent colour', exact: true }).fill('#00d4ff')
      await cs.getByRole('button', { name: 'Save Changes' }).click()
      await until('the channel to be saved', async () => (await api(alice, 'GET', `/channels/${ids.general}`)).body.theme_color === 0x00d4ff)
      await closeSettings(alice)
      await channels(bob).locator('.chan-emoji', { hasText: '🎮' }).waitFor(LIVE)
      await bob.locator('.chat-header.accented').waitFor()
    })

    await step('21. server accent and invite splash: the invite page shows the splash from the CDN and an accent Join button', async () => {
      await serverSettings(alice, 'Customization')
      await alice.getByLabel('Invite background').setInputFiles(pngFile('splash.png', 640, 360, [255, 60, 90]))
      await alice.getByRole('checkbox', { name: 'Server accent colour' }).check()
      await alice.getByRole('textbox', { name: 'Accent colour', exact: true }).fill('#ff2e4c')
      await alice.getByLabel('Welcome screen background').setInputFiles(pngFile('welcome.png', 640, 240, [30, 200, 120]))
      await alice.getByLabel('Greeting 1').waitFor({ state: 'detached' }).catch(() => {})
      await alice.getByRole('button', { name: 'Add greeting' }).click()
      await alice.getByLabel('Greeting 1').fill('GG {user}, welcome to the squad!')
      await alice.getByRole('button', { name: 'Save Changes' }).click()
      await alice.getByText('Saved.').first().waitFor()
      await closeSettings(alice)
      const g = await ok(api(alice, 'GET', `/guilds/${ids.guild}`))
      check(g.splash && g.brand_color_primary === '#ff2e4c' && g.greeting_templates.length === 1, `guild ${JSON.stringify({ splash: g.splash, accent: g.brand_color_primary, greetings: g.greeting_templates })}`)
      await bob.locator('.sidebar-header.accented').waitFor(LIVE)
      const guest = await newPage(browser, 'Guest')
      await guest.goto(`${BASE}/invite/${ids.invite}`)
      await guest.getByRole('heading', { name: GUILD }).waitFor()
      const style = await guest.locator('.auth-bg.splashed').getAttribute('style')
      check(style.includes(`/splashes/${ids.guild}/${g.splash}.png`), `splash style ${style}`)
      check((await fetchStatus(guest, `/splashes/${ids.guild}/${g.splash}.png`)) === 200, 'splash served')
      check((await guest.locator('.auth-card.invite').evaluate((e) => getComputedStyle(e).getPropertyValue('--guild-accent').trim())) === '#ff2e4c', 'accent on the invite card')
      await guest.context().close()
      delete pages.Guest
    })

    await step('22. Dave joins: the welcome screen shows the server\'s background, and the join message uses the greeting template', async () => {
      await ok(api(alice, 'PATCH', `/guilds/${ids.guild}/welcome-screen`, { enabled: true, description: 'Welcome to the squad server!' }))
      const dave = await newPage(browser, 'Dave')
      await register(dave, NAME.dave)
      await dave.waitForURL('**/channels/@me')
      await ready(dave)
      ids.dave = (await api(dave, 'GET', '/users/@me')).body.id
      await dave.goto(`${BASE}/invite/${ids.invite}`)
      await dave.getByRole('button', { name: 'Join' }).click()
      const welcome = modal(dave, `Welcome to ${GUILD}!`)
      const hero = welcome.locator('.welcome-hero')
      await hero.waitFor()
      let bg = ''
      await until('the welcome background', async () => (bg = await hero.evaluate((e) => e.style.backgroundImage)).includes('url('))
      const ws = await ok(api(dave, 'GET', `/guilds/${ids.guild}/welcome-screen`))
      check(ws.background && bg.includes(`/welcome-backgrounds/${ids.guild}/${ws.background}`), `welcome background ${bg}`)
      check((await fetchStatus(dave, `/welcome-backgrounds/${ids.guild}/${ws.background}.png`)) === 200, 'welcome background served')
      await welcome.getByRole('button', { name: 'Continue' }).click()
      await msg(alice, 'welcome to the squad!').filter({ hasText: re(NAME.dave) }).waitFor(LIVE)
      check(/^GG .+, welcome to the squad!$/.test((await msg(alice, 'welcome to the squad!').last().locator('span').first().innerText()).trim()), 'greeting with the name filled in')
      await ok(api(alice, 'PATCH', `/guilds/${ids.guild}/welcome-screen`, { enabled: false }))
      await dave.context().close()
      delete pages.Dave
    })

    await step('23. custom notification sounds: Bob\'s own uploaded sound plays for a DM, then the Arcade set (Web Audio square waves)', async () => {
      await userSettings(bob, 'Sounds')
      const us = modal(bob, 'User Settings')
      await us.getByLabel('Sound name').fill('horn')
      await us.getByLabel('Sound file').setInputFiles(horn)
      await us.getByRole('button', { name: 'Upload' }).click()
      await us.locator('.own-sounds li', { hasText: 'horn' }).waitFor()
      const own = (await ok(api(bob, 'GET', '/users/@me/sounds'))).find((x) => x.name === 'horn')
      await us.getByRole('combobox', { name: 'Sound for Direct message' }).selectOption({ label: 'horn' })
      await until('the DM sound to be saved', async () => (await api(bob, 'GET', '/users/@me/settings')).body.sound_settings?.events?.dm?.sound === `user:${own.id}`)
      await closeSettings(bob)
      const dm = await ok(api(carol, 'POST', '/users/@me/channels', { recipient_id: ids.bob }))
      await ok(api(carol, 'POST', `/channels/${dm.id}/messages`, { content: `ping ${SFX} 1` }))
      await until('Bob\'s own sound to play', async () => (await played(bob)).includes(`/user-sounds/${own.id}`))
      check((await fetchStatus(bob, `/user-sounds/${own.id}`)) === 200, 'own sound served')
      await userSettings(bob, 'Sounds')
      await us.getByRole('combobox', { name: 'Sound for Direct message' }).selectOption('arcade')
      await until('the Arcade sound to be saved', async () => (await api(bob, 'GET', '/users/@me/settings')).body.sound_settings?.events?.dm?.sound === 'arcade')
      await closeSettings(bob)
      const before = await bob.evaluate(() => window.__osc.length)
      await ok(api(carol, 'POST', `/channels/${dm.id}/messages`, { content: `ping ${SFX} 2` }))
      await until('square-wave oscillators', async () => (await bob.evaluate((n) => window.__osc.slice(n), before)).includes('square'))
    })

    await step('24. entrance sound with LiveKit: Bob picks Alice\'s soundboard sound; Alice hears it (not the join chime) when he joins voice', async () => {
      const sound = await ok(api(alice, 'POST', `/guilds/${ids.guild}/soundboard-sounds`, { name: 'airhorn', sound: oggUri(boop), emoji_name: '📯' }))
      await userSettings(bob, 'Sounds')
      await modal(bob, 'User Settings').getByRole('combobox', { name: 'Entrance sound' }).selectOption({ label: '📯 airhorn' })
      await until('the entrance sound to be saved', async () => (await api(bob, 'GET', '/users/@me/settings')).body.entrance_sound?.sound_id === sound.sound_id)
      await closeSettings(bob)
      await openChannel(alice, 'general')
      await joinVoice(alice)
      await sleep(1500) // Alice's own join chime
      const [oscBefore, playedBefore] = [await oscs(alice), (await played(alice)).length]
      await openChannel(bob, 'general')
      await joinVoice(bob)
      await until('Alice to play the entrance sound', async () => (await played(alice)).slice(playedBefore).includes(`/soundboard-sounds/${sound.sound_id}`), 8000)
      await until('Bob to hear his own entrance', async () => (await played(bob)).includes(`/soundboard-sounds/${sound.sound_id}`))
      await sleep(800)
      check((await oscs(alice)) === oscBefore, 'no join chime on top of the entrance sound')
      await leaveVoice(bob)
      await leaveVoice(alice)
    })

    await step(`25. entrance sound with cillvoice: instance B on :${CV_PORT} (UDP ${CV_UDP}); Xena hears Yuri's entrance sound when he joins`, async () => {
      const B = await startServer(tmp, 'cillvoice', CV_PORT, cvEnv)
      const reg = (n) => rest(B.base, null, 'POST', '/auth/register', { age_confirmed: true, email: `${n.toLowerCase()}@example.com`, username: n, password: PASSWORD }).then((r) => r.token)
      const [tx, ty] = [await reg(NAME.x), await reg(NAME.y)]
      const g = await rest(B.base, tx, 'POST', '/guilds', { name: GUILD })
      const chans = await rest(B.base, tx, 'GET', `/guilds/${g.id}/channels`)
      const general = chans.find((c) => c.type === 0)
      const inv = await rest(B.base, tx, 'POST', `/channels/${general.id}/invites`, { max_age: 0 })
      await rest(B.base, ty, 'POST', `/invites/${inv.code}`)
      const s = await rest(B.base, tx, 'POST', `/guilds/${g.id}/soundboard-sounds`, { name: 'gong', sound: oggUri(boop) })
      await rest(B.base, ty, 'PATCH', '/users/@me/settings', { entrance_sound: { sound_id: s.sound_id, guild_id: g.id } })
      const [x, y] = [await newPage(browser, 'Xena', tx), await newPage(browser, 'Yuri', ty)]
      for (const p of [x, y]) {
        await p.goto(`${B.base}/channels/${g.id}/${general.id}`)
        await ready(p)
      }
      await joinVoice(x, GUILD)
      await sleep(1500)
      const oscBefore = await oscs(x)
      await joinVoice(y, GUILD)
      await until('Xena to play the entrance sound over cillvoice', async () => (await played(x)).includes(`/soundboard-sounds/${s.sound_id}`), 8000)
      await sleep(800)
      check((await oscs(x)) === oscBefore, 'no join chime on top of the entrance sound (cillvoice)')
      await leaveVoice(y)
      await leaveVoice(x)
      await x.context().close()
      await y.context().close()
      delete pages.Xena
      delete pages.Yuri
    })

    await step('26. keybind editor: Ctrl+K for Toggle mute shows the Quick Switcher conflict, moving it is stored and survives a reload', async () => {
      await userSettings(bob, 'Keybinds')
      const us = modal(bob, 'User Settings')
      await us.getByRole('button', { name: /^Toggle mute:/ }).click()
      await bob.keyboard.press('Control+KeyK')
      await us.getByRole('alert').getByText('is already used for Quick Switcher', { exact: false }).waitFor()
      await us.getByRole('button', { name: 'Use it for Toggle mute' }).click()
      await until('the keybinds to be stored', async () => {
        const k = (await api(bob, 'GET', '/users/@me/settings')).body.keybinds
        return k['toggle-mute'] === 'Ctrl+KeyK' && k['quick-switcher'] === null
      })
      await closeSettings(bob)
      await bob.reload()
      await ready(bob)
      await userSettings(bob, 'Keybinds')
      await us.getByRole('button', { name: 'Toggle mute: Ctrl+K. Press to change.' }).waitFor()
      await us.getByRole('button', { name: 'Quick Switcher: Not set. Press to change.' }).waitFor()
      await us.getByRole('button', { name: 'Reset to defaults' }).click()
      await closeSettings(bob)
    })

    await step('27. contrast audit: all 12 presets keep text, muted text and headers at 4.5:1 on every surface in the running app', async () => {
      const src = fs.readFileSync(path.join(ROOT, 'client', 'src', 'custom', 'themes.ts'), 'utf8')
      const presets = [...src.matchAll(/p\('([\w-]+)', '([^']+)', '(#[0-9a-f]{6})', '(#[0-9a-f]{6})', '(#[0-9a-f]{6})'/g)].map((m) => ({ id: `preset:${m[1]}`, name: m[2], accent: m[5] }))
      check(presets.length === 12, `${presets.length} presets found`)
      const worst = []
      for (const p of presets) {
        await ok(api(alice, 'PATCH', '/users/@me/settings', { active_theme: p.id }))
        await until(`${p.name} applied`, async () => (await alice.evaluate(() => document.documentElement.style.getPropertyValue('--accent'))) === p.accent)
        const v = await alice.evaluate(() => Object.fromEntries(['--text', '--muted', '--header', '--interactive', '--chat', '--sidebar', '--card', '--panel', '--app-bg', '--accent', '--on-accent'].map((k) => [k, getComputedStyle(document.documentElement).getPropertyValue(k).trim()])))
        const stops = v['--app-bg'].match(/#[0-9a-f]{6}/gi) ?? [v['--app-bg']]
        const surfaces = ['--chat', '--sidebar', '--card', '--panel'].flatMap((k) => stops.map((s) => over(v[k], s)))
        let min = Infinity
        for (const fg of ['--text', '--muted', '--header', '--interactive']) for (const bg of surfaces) min = Math.min(min, ratio(over(v[fg], '#000000'), bg))
        const button = ratio(over(v['--on-accent'], '#000000'), over(v['--accent'], '#000000'))
        worst.push(`${p.name} ${min.toFixed(2)}`)
        check(min >= 4.5, `${p.name}: text contrast ${min.toFixed(2)}:1`)
        check(button >= 4.5, `${p.name}: button text on accent ${button.toFixed(2)}:1`)
      }
      console.log(`  lowest text contrast per preset: ${worst.join(', ')}`)
      await ok(api(alice, 'PATCH', '/users/@me/settings', { active_theme: null }))
    })

    await step('28. the light theme with everyone\'s customizations (Carol\'s view)', async () => {
      await ok(api(carol, 'PATCH', '/users/@me/settings', { theme: 'light', active_theme: null }))
      await until('the light theme', async () => (await carol.evaluate(() => document.documentElement.dataset.theme)) === 'light')
      await openChannel(carol, 'general')
      const name = msg(carol, `tag check ${SFX}`).locator('.author .ns').first()
      const [fg, bg] = await Promise.all([name.evaluate((e) => getComputedStyle(e).color), carol.evaluate(() => getComputedStyle(document.querySelector('.chat')).backgroundColor)])
      check(ratio(parseColor(fg), parseColor(bg)) >= 4.5, `Bob's name readable on light (${fg} on ${bg})`)
      await shot(carol, 'light')
    })

    await step('29. no uncaught page errors and no native dialogs', async () => {
      if (errors.length) throw new Error(errors.join('; '))
    })
  } catch (e) {
    if (!results.length || results.at(-1)) console.log(`not ok - setup: ${e.message}`), (failed = true)
  } finally {
    await browser.close().catch(() => {})
    for (const c of children) c.kill()
    await sleep(500)
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  console.log(`${results.filter(Boolean).length}/${results.length} steps passed`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  for (const c of children) c.kill()
  process.exit(1)
})
