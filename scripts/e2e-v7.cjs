// End-to-end check of v7 (the hub and self-hosted nodes) with two real instances from server/ and client/dist:
//   hub  on E2E_HUB_PORT (3430): CILLCORD_ROLE=hub, real LiveKit for voice (LIVEKIT_API_KEY/SECRET from the environment:
//        set -a; . ./.env; set +a);
//   node on E2E_NODE_PORT (3431): first-run wizard with a setup code, cillvoice on UDP E2E_NODE_UDP (3438), a stand-in
//        updater sidecar on 3436 (the real updater runs in selfhost/test);
//   solo on 3432: a standalone node whose CILLCORD_HUB_URL points at the hub through a recording proxy on 3433 (the hub's
//        request log for this node), which must stay empty;
//   a fake Web Push service on 3435 for the node -> hub NOTIFY path.
// E2E_SOLO_PORT, E2E_PROXY_PORT, E2E_PUSH_PORT and E2E_UPDATER_PORT move the helper ports.
// The test-only flag CILLCORD_FEDERATION_DEV_HTTP=1 lets the instances use http://127.0.0.1:<port> URLs. The network key
// is a throwaway test key: NODE_ENV=test with CILLCORD_TEST_HUB_KEY on every instance, its private half in the hub's data dir.
// Run: NODE_PATH=<dir with playwright> node scripts/e2e-v7.cjs   (E2E_SCREENSHOTS=1 writes docs/screenshots/v7-*.png at
// deviceScaleFactor 2, E2E_FAIL_SHOTS=<dir> saves every page when a step fails).
// People: Alice (hub admin), Bob and Carol (hub users), Dana (the node's admin, created in the wizard).
const { chromium } = require('playwright')
const { spawn, execFileSync } = require('node:child_process')
const { createHmac, createECDH, randomBytes, generateKeyPairSync } = require('node:crypto')
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const ROOT = path.join(__dirname, '..')
const SERVER_DIR = path.join(ROOT, 'server')
const DIST = process.env.E2E_STATIC_DIR ?? path.join(ROOT, 'client', 'dist')
const HUB_PORT = Number(process.env.E2E_HUB_PORT ?? 3430)
const NODE_PORT = Number(process.env.E2E_NODE_PORT ?? 3431)
const SOLO_PORT = Number(process.env.E2E_SOLO_PORT ?? 3432)
const PROXY_PORT = Number(process.env.E2E_PROXY_PORT ?? 3433)
const PUSH_PORT = Number(process.env.E2E_PUSH_PORT ?? 3435)
const UPDATER_PORT = Number(process.env.E2E_UPDATER_PORT ?? 3436)
const NODE_UDP = Number(process.env.E2E_NODE_UDP ?? 3438)
const HUB = `http://127.0.0.1:${HUB_PORT}`
const NODE = `http://127.0.0.1:${NODE_PORT}`
const SOLO = `http://127.0.0.1:${SOLO_PORT}`
const SETUP_CODE = 'node-setup-7e2e'
const SHOTS = process.env.E2E_SCREENSHOTS ? path.join(ROOT, 'docs', 'screenshots') : null
const LIVE = { timeout: 8000 }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const SFX = Math.random().toString(36).slice(2, 7)
const NAME = { alice: `Alice_${SFX}`, bob: `Bob_${SFX}`, carol: `Carol_${SFX}`, dana: `Dana_${SFX}` }
const PASSWORD = 'correct horse battery'
const HUB_NAME = 'Test Hub'
const NODE_NAME = `LAN Crew ${SFX}`
const ARENA = `Node Arena ${SFX}`
const HQ = `Hub HQ ${SFX}`
const re = (s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')

let failed = false
const errors = []
const pages = {}
const results = []
const children = []
const servers = []

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
async function until(what, fn, ms = 8000) {
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

// In every page: Web Audio oscillators and media started (notification sounds).
function hooks() {
  window.__sounds = 0
  const play = HTMLMediaElement.prototype.play
  HTMLMediaElement.prototype.play = function () { window.__sounds++; return play.call(this) }
  const create = AudioContext.prototype.createOscillator
  AudioContext.prototype.createOscillator = function () { window.__sounds++; return create.call(this) }
}
function watch(page, name) {
  pages[name] = page
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`))
  page.on('dialog', (d) => (errors.push(`${name}: unexpected native dialog "${d.message()}"`), d.dismiss()))
}
async function newPage(browser, name) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, permissions: ['microphone', 'camera', 'clipboard-read', 'clipboard-write'], serviceWorkers: 'block' })
  await ctx.addInitScript(hooks)
  const page = await ctx.newPage()
  watch(page, name)
  ctx.on('page', (p) => watch(p, `${name}-popup`))
  return page
}
async function ready(page) {
  await page.getByRole('navigation', { name: /^(Servers|Server)$/ }).waitFor()
  await until('the gateway to connect (no "Connecting…")', async () => (await page.getByText(/Connecting…|Verbinde…/).count()) === 0, 10000)
}
async function register(page, base, name) {
  await page.goto(base + '/register')
  await page.getByRole('heading', { name: 'Join the roster' }).waitFor()
  await page.getByLabel('Email').fill(`${name.toLowerCase()}@example.com`)
  await page.getByLabel('Username').fill(name)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByLabel(/I am at least/).check() // 7.10.3 sign-up check
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.waitForURL('**/channels/@me')
  await ready(page)
}
async function login(page, base, name) {
  await page.goto(base + '/login')
  await page.getByRole('heading', { name: 'Ready up' }).waitFor()
  await page.getByLabel('Email or username').fill(name)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Log In' }).click()
}

// REST as the page's user on the page's own origin. Returns {status, body}.
const api = (page, method, route, body, headers = {}) =>
  page.evaluate(async ([method, route, body, headers]) => {
    const r = await fetch('/api/v9' + route, { method, headers: { Authorization: localStorage.getItem('token'), ...(body && { 'Content-Type': 'application/json' }), ...headers }, body: body && JSON.stringify(body) })
    return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }
  }, [method, route, body, headers])
const ok = async (p) => { const r = await p; check(r.status < 300, `API answered ${r.status}: ${JSON.stringify(r.body)}`); return r.body }
// a call that needs the 2FA step-up: refused without it (401 60003 with a ticket), then repeated with an elevation token
async function stepUp(page, secret, method, route, body) {
  const first = await api(page, method, route, body)
  check(first.status === 401 && first.body?.code === 60003 && first.body.mfa?.ticket, `${method} ${route} without 2FA: ${first.status} ${JSON.stringify(first.body)}`)
  const fin = await ok(api(page, 'POST', '/mfa/finish', { ticket: first.body.mfa.ticket, mfa_type: 'totp', data: await freshCode(secret) }))
  return api(page, method, route, body, { 'X-Cillhub-MFA-Authorization': fin.token })
}
// REST from the test itself.
async function rest(base, token, method, route, body) {
  const r = await fetch(base + '/api/v9' + route, { method, headers: { ...(token && { Authorization: token }), ...(body && { 'Content-Type': 'application/json' }) }, body: body && JSON.stringify(body) })
  return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }
}

const rail = (page) => page.getByRole('navigation', { name: /^(Servers|Server)$/ })
const modal = (page, name) => page.getByRole('dialog', { name })
const msg = (page, text) => page.locator('li.msg').filter({ hasText: text })
const composer = (page) => page.getByRole('textbox', { name: /^Message / })
async function send(page, text, shown = text) {
  await composer(page).fill(text)
  await composer(page).press('Enter')
  await msg(page, shown).waitFor(LIVE)
}
async function admin(page, base, tab) {
  await page.goto(`${base}/admin/${tab}`)
  await page.getByRole('heading', { level: 1 }).first().waitFor()
}
const confirmIn = (page, title, button) => modal(page, title).getByRole('button', { name: button, exact: true }).click()
async function codeIn(page, title, code, button) {
  const d = modal(page, title).last()
  await d.getByLabel('Authentication or backup code').fill(code)
  await d.getByRole('button', { name: button, exact: true }).click()
}
const shot = async (page, name) => {
  if (!SHOTS) return
  await page.mouse.move(0, 0)
  await until('toasts to clear before the screenshot', async () => (await page.locator('.toast').count()) === 0, 10000).catch(() => {})
  await sleep(500)
  await page.screenshot({ path: path.join(SHOTS, `v7-${name}.png`) })
}

// key: a private key that becomes the instance's federation key (the hub gets the test network key)
async function startServer(tmp, name, port, env, key) {
  const dir = fs.mkdtempSync(path.join(tmp, `${name}-data-`))
  if (key) fs.writeFileSync(path.join(dir, 'federation.key'), key.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  const out = fs.openSync(path.join(tmp, `${name}.log`), 'w')
  const p = spawn(process.execPath, ['--import', './test/hub-key.mjs', 'src/index.js'], { cwd: SERVER_DIR, env: { ...env, PORT: String(port), DATA_DIR: dir, STATIC_DIR: DIST, CILLCORD_FEDERATION_DEV_HTTP: '1' }, stdio: ['ignore', out, out] })
  children.push(p)
  const base = `http://127.0.0.1:${port}`
  await until(`instance ${name} on port ${port}`, async () => (await fetch(base + '/api/v9/instance')).ok, 20000)
  return { base, dir, log: path.join(tmp, `${name}.log`) }
}
const listen = (port, handler) => new Promise((resolve) => { const s = http.createServer(handler); servers.push(s); s.listen(port, '127.0.0.1', () => resolve(s)) })
const readBody = (req) => new Promise((resolve) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c))) })

const ids = {}
const pushed = []
const proxied = []
const updaterCalls = []

async function main() {
  if (!process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) throw new Error('LIVEKIT_API_KEY / LIVEKIT_API_SECRET missing: run `set -a; . ./.env; set +a` first')
  if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error(`no client build in ${DIST}: run npm run build in client/`)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cillcord-e2e7-'))
  const wav = path.join(tmp, 'speech.wav')
  fs.writeFileSync(wav, speechWav())
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required'] })
  const networkKey = generateKeyPairSync('ed25519').privateKey
  const base = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('LIVEKIT_') && !k.startsWith('CILLCORD_') && k !== 'VOICE_BACKEND')),
    NODE_ENV: 'test', CILLCORD_TEST_HUB_KEY: networkKey.export({ format: 'jwk' }).x,
  }
  const hubEnv = {
    ...base, CILLCORD_ROLE: 'hub', CILLCORD_PUBLIC_URL: HUB, CILLCORD_UNFURL_ALLOW: `127.0.0.1:${NODE_PORT},127.0.0.1:${PUSH_PORT}`,
    LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY, LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET,
    LIVEKIT_URL: process.env.LIVEKIT_URL ?? 'http://127.0.0.1:7880', LIVEKIT_PUBLIC_URL: process.env.LIVEKIT_PUBLIC_URL ?? 'ws://127.0.0.1:7880',
  }
  const nodeEnv = {
    ...base, CILLCORD_HUB_URL: HUB, CILLCORD_PUBLIC_URL: NODE, CILLCORD_SETUP_CODE: SETUP_CODE, CILLCORD_MODE: 'connected',
    VOICE_BACKEND: 'cillvoice', CILLVOICE_UDP_PORT: String(NODE_UDP), CILLVOICE_PUBLIC_IP: '127.0.0.1',
    CILLCORD_UPDATER_URL: `http://127.0.0.1:${UPDATER_PORT}`, CILLCORD_UPDATER_SECRET: 'e2e-updater-secret', CILLCORD_VERSION: '7.0.0',
  }
  try {
    // A Web Push service (the hub delivers NOTIFY through the user's subscription) and a stand-in updater sidecar.
    await listen(PUSH_PORT, async (req, res) => { await readBody(req); pushed.push(req.url); res.writeHead(201); res.end() })
    let upd = { state: 'idle', action: null, target_version: null, step: null, error: null, rolled_back: null, logs: null, previous: { image: 'sha256:6f00', version: '6.9.0' }, backup: null, current_version: '7.0.0' }
    await listen(UPDATER_PORT, async (req, res) => {
      const body = (await readBody(req)).toString()
      updaterCalls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body })
      const json = (status, j) => (res.writeHead(status, { 'Content-Type': 'application/json' }), res.end(JSON.stringify(j)))
      if (req.headers.authorization !== 'Bearer e2e-updater-secret') return json(401, { error: 'unauthorized' })
      if (req.url === '/status') return json(200, upd)
      if (req.url === '/check') return json(200, { current_version: '7.0.0', latest: { version: '7.0.1', notes: 'Directory search by language\nFaster node heartbeats', size: 98_000_000, min_upgrade_from: null }, update_available: true, can_update: true })
      if (req.url === '/update') return json(202, (upd = { ...upd, state: 'updating', action: 'update', target_version: JSON.parse(body).version, step: 'backing up the database' }))
      json(404, { error: 'not found' })
    })
    const H = await startServer(tmp, 'hub', HUB_PORT, hubEnv, networkKey)
    // The hub's request log for the standalone node: everything it sends to its configured hub passes here.
    await listen(PROXY_PORT, async (req, res) => {
      proxied.push(`${req.method} ${req.url}`)
      const body = await readBody(req)
      const r = await fetch(HUB + req.url, { method: req.method, headers: { 'content-type': req.headers['content-type'] ?? 'application/json' }, body: body.length ? body : undefined })
      res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') ?? 'application/json' })
      res.end(Buffer.from(await r.arrayBuffer()))
    })
    const alice = await newPage(browser, 'Alice')
    const bob = await newPage(browser, 'Bob')
    const carol = await newPage(browser, 'Carol')
    const dana = await newPage(browser, 'Dana')
    const aliceSecret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'
    let danaSecret
    let N

    await step(`0. hub on :${HUB_PORT} (role hub, LiveKit); Alice (hub admin via the CLI, 2FA), Bob and Carol register (suffix ${SFX}); Alice creates ${HQ}`, async () => {
      for (const [p, n] of [[alice, NAME.alice], [bob, NAME.bob], [carol, NAME.carol]]) await register(p, HUB, n)
      for (const [k, p] of Object.entries({ alice, bob, carol })) ids[k] = (await api(p, 'GET', '/users/@me')).body.id
      execFileSync(process.execPath, ['src/admin-cli.js', 'grant', NAME.alice], { cwd: SERVER_DIR, env: { ...process.env, DATA_DIR: H.dir }, encoding: 'utf8' })
      const on = await ok(api(alice, 'POST', '/users/@me/mfa/totp/enable', { password: PASSWORD, secret: aliceSecret, code: await freshCode(aliceSecret) }))
      await alice.evaluate((t) => localStorage.setItem('token', t), on.token)
      await ok(api(alice, 'PATCH', '/admin/settings', { instance_name: HUB_NAME }))
      const g = await ok(api(alice, 'POST', '/guilds', { name: HQ }))
      ids.hq = g.id
      ids.hqVoice = g.channels.find((c) => c.type === 2).id
      const inst = await ok(api(alice, 'GET', '/instance'))
      check(inst.federation?.role === 'hub' && inst.federation.mode === null && inst.setup_pending === false, `hub /instance: ${JSON.stringify(inst.federation)}`)
    })

    let linkCode
    await step('1. Alice creates a link code on the hub\'s Nodes page; Bob (no admin) cannot', async () => {
      await admin(alice, HUB, 'nodes')
      await alice.getByRole('button', { name: 'Create Link Code' }).click()
      await codeIn(alice, 'Create Link Code', await freshCode(aliceSecret), 'Create Link Code')
      linkCode = (await alice.locator('.admin-newcode code').innerText()).trim()
      check(/^CCL-[\w-]{24}$/.test(linkCode), `link code ${linkCode}`)
      await alice.getByRole('table', { name: 'Link codes' }).getByText('Valid').first().waitFor()
      check((await api(bob, 'POST', '/admin/federation/link-codes', {})).status === 403, 'Bob cannot create link codes')
      check((await api(alice, 'POST', '/admin/federation/link-codes', {})).status === 401, 'not even Alice without her 2FA code')
      check((await api(bob, 'POST', '/federation/link-codes', {})).status === 403, 'users cannot create link codes while the switch is off')
    })

    let D
    await step(`2. node on :${NODE_PORT}: the first-run wizard in the browser (setup code, instance name, admin ${NAME.dana} with mandatory 2FA, registration, connected with the link code, voice self-check on UDP ${NODE_UDP})`, async () => {
      D = await startServer(tmp, 'node', NODE_PORT, nodeEnv)
      const inst = await (await fetch(NODE + '/api/v9/instance')).json()
      check(inst.setup_pending === true && inst.federation.role === 'node' && inst.federation.mode === 'standalone', `node /instance before setup: ${JSON.stringify(inst)}`)
      check((await rest(NODE, null, 'POST', '/auth/register', { email: 'x@example.com', username: 'early', password: PASSWORD })).status === 403, 'no sign-ups before setup')
      await dana.goto(NODE + '/')
      await dana.waitForURL('**/setup')
      const main = dana.getByRole('main', { name: 'Set up Cillhub' })
      await main.getByLabel('Setup code').fill('wrong-code-1')
      await main.getByRole('button', { name: 'Continue' }).click()
      await main.getByText('Wrong setup code.').waitFor()
      await main.getByLabel('Setup code').fill(SETUP_CODE)
      await main.getByRole('button', { name: 'Continue' }).click()
      await main.getByLabel('Instance name').fill(NODE_NAME)
      await main.getByRole('button', { name: 'Continue' }).click()
      await main.getByLabel('Username').fill(NAME.dana)
      await main.getByLabel('Email').fill(`${NAME.dana.toLowerCase()}@example.com`)
      await main.getByLabel('Password', { exact: true }).fill(PASSWORD)
      await main.getByLabel('Repeat password').fill(PASSWORD)
      await main.getByRole('button', { name: 'Continue' }).click()
      danaSecret = (await main.getByLabel('2FA key').innerText()).replace(/\s/g, '')
      await main.getByLabel('6-digit code').fill(await freshCode(danaSecret))
      await main.getByRole('button', { name: 'Activate' }).click()
      await main.getByLabel('I saved my backup codes').check()
      await main.getByRole('button', { name: 'Continue' }).click()
      await main.getByLabel('Anyone (open registration)').check()
      await main.getByRole('button', { name: 'Continue' }).click()
      await main.getByLabel(/Connected to the hub/).check()
      check(await main.getByLabel('Hub address').inputValue() === HUB, 'the hub address comes from CILLCORD_HUB_URL')
      await main.getByLabel('Link code').fill(linkCode)
      await main.getByRole('button', { name: 'Continue' }).click()
      await main.locator('li.ok', { hasText: `cillvoice listens on UDP port ${NODE_UDP}` }).waitFor({ timeout: 15000 })
      await main.locator('li.ok', { hasText: `This browser reaches 127.0.0.1:${NODE_UDP} over UDP` }).waitFor({ timeout: 15000 })
      await shot(dana, 'setup')
      await main.getByRole('button', { name: 'Continue' }).click()
      await main.getByText(`Connected to ${HUB}`).waitFor()
      check(await main.getByLabel('Off: I update by hand').isChecked(), 'automatic updates are off unless chosen')
      await main.getByLabel('Security and patch releases only (recommended)').check()
      await main.getByLabel('Maintenance window').selectOption('3')
      await main.getByRole('button', { name: 'Finish setup' }).click()
      await dana.waitForURL('**/channels/@me')
      await ready(dana)
      const fed = await ok(api(dana, 'GET', '/admin/federation'))
      check(fed.mode === 'connected' && fed.hub_status === 'linked' && fed.hub_name === HUB_NAME && /^\d+$/.test(fed.node_id), `node federation: ${JSON.stringify(fed)}`)
      N = fed.node_id
      check((await rest(NODE, null, 'GET', '/setup')).body.required === false, 'setup is closed')
      check((await rest(NODE, null, 'POST', '/setup/verify', { setup_code: SETUP_CODE })).status === 404, 'the setup routes are gone')
    })

    await step('3. hub Nodes page: the node is listed online with its version and automatic updates; the link code is used; CORS on the node only for the hub', async () => {
      await alice.reload()
      await alice.getByRole('row', { name: re(NODE_NAME) }).getByText('Online').waitFor(LIVE)
      await alice.getByRole('row', { name: re(NODE_NAME) }).getByRole('cell', { name: '7.0.0', exact: true }).waitFor()
      await alice.getByRole('row', { name: re(NODE_NAME) }).getByText('Security and patch · 03:00 UTC').waitFor()
      await alice.getByRole('table', { name: 'Link codes' }).getByText('Used').first().waitFor()
      await shot(alice, 'hub-nodes')
      const pre = await fetch(`${NODE}/api/v9/users/@me`, { method: 'OPTIONS', headers: { Origin: HUB } })
      check(pre.headers.get('access-control-allow-origin') === HUB, `node CORS: ${pre.headers.get('access-control-allow-origin')}`)
      check((await rest(NODE, null, 'GET', '/gateway')).body.url === `ws://127.0.0.1:${NODE_PORT}/gateway`, 'absolute gateway URL')
    })

    await step('4. node admin pages: Federation shows the hub link and sign-in methods; Updates checks the hub\'s release and starts an update with a 2FA code', async () => {
      await admin(dana, NODE, 'federation')
      await dana.getByText('Linked', { exact: true }).waitFor()
      await dana.getByText(HUB, { exact: true }).waitFor()
      check(await dana.getByLabel('Local and hub accounts').isChecked(), 'both sign-in methods by default')
      await shot(dana, 'node-federation')
      await dana.getByRole('navigation', { name: 'Admin dashboard' }).getByRole('link', { name: 'Updates' }).click()
      await dana.getByRole('button', { name: 'Check Now' }).click()
      await dana.getByRole('button', { name: 'Update to 7.0.1' }).waitFor()
      await dana.getByText('Faster node heartbeats', { exact: false }).waitFor()
      await shot(dana, 'node-updates')
      await dana.getByRole('button', { name: 'Update to 7.0.1' }).click()
      await codeIn(dana, 'Update to 7.0.1?', await freshCode(danaSecret), 'Update Now')
      await dana.getByText('Updating… · 7.0.1 · backing up the database').waitFor()
      check(updaterCalls.some((c) => c.method === 'POST' && c.url === '/update' && c.body === '{"version":"7.0.1"}' && c.auth === 'Bearer e2e-updater-secret'), 'the server asked the updater with the shared secret')
      // the hub admin asks the node to update (signed request); the node passes it to its updater.
      // remote requests are opt-in and need automatic updates on; the heartbeat tells the hub
      await ok(api(dana, 'PATCH', '/admin/updates', { remote_update: true, auto_update: 'all' }))
      await ok(api(dana, 'POST', '/admin/federation/heartbeat'))
      await alice.reload() // the Nodes list was loaded before that heartbeat
      await alice.getByRole('button', { name: NODE_NAME, exact: true }).click()
      const drawer = alice.getByRole('dialog', { name: `Node ${NODE_NAME}` })
      await drawer.getByText('Allowed').waitFor()
      const before = updaterCalls.filter((c) => c.method === 'POST' && c.url === '/update').length
      await drawer.getByRole('button', { name: 'Request Update' }).click()
      await codeIn(alice, `Ask ${NODE_NAME} to update now?`, await freshCode(aliceSecret), 'Request Update')
      await alice.getByText('The node started the update.').waitFor()
      check(updaterCalls.filter((c) => c.method === 'POST' && c.url === '/update').length === before + 1, 'the node asked its updater after the hub request')
      await drawer.getByRole('button', { name: 'Close' }).last().click()
    })

    await step(`5. Dana creates ${ARENA} on the node and lists it in the server directory from Server Settings`, async () => {
      await dana.goto(NODE + '/channels/@me')
      await ready(dana)
      const g = await ok(api(dana, 'POST', '/guilds', { name: ARENA }))
      ids.arena = g.id
      ids.arenaGeneral = g.channels.find((c) => c.type === 0).id
      ids.arenaVoice = g.channels.find((c) => c.type === 2).id
      await ok(api(dana, 'PATCH', `/guilds/${g.id}`, { description: 'Weekly scrims and a LAN every month' }))
      await dana.goto(`${NODE}/channels/${g.id}/${ids.arenaGeneral}`)
      await ready(dana)
      await dana.getByRole('button', { name: ARENA, exact: true }).click()
      await dana.getByRole('button', { name: 'Server Settings' }).click()
      await dana.getByRole('tab', { name: 'Server Directory' }).click()
      await dana.getByLabel('List this server in the server directory').check()
      await dana.getByRole('combobox', { name: 'Category', exact: true }).selectOption({ label: 'Esports' })
      await dana.getByLabel('Tags (comma-separated, up to 5)').fill('cs2, lan')
      await dana.getByRole('button', { name: 'Save Changes' }).click()
      await dana.getByText('Saved.').first().waitFor()
      await dana.getByRole('button', { name: 'Close settings' }).click()
      const meta = await ok(api(dana, 'GET', `/guilds/${g.id}/discovery-metadata`))
      check(meta.listed && meta.primary_category_id === 1 && meta.hub_status === 'active' && !meta.sync_error, `metadata: ${JSON.stringify(meta)}`)
    })

    await step('6. Carol signs in on the node with her hub account: "Sign in with Test Hub", hub login, consent screen, back on the node', async () => {
      await carol.goto(NODE + '/login')
      await carol.getByRole('button', { name: `Sign in with ${HUB_NAME}` }).click()
      // signed out on the hub first, so the consent page sends her through the hub's login
      await carol.waitForURL(`${HUB}/oauth2/authorize**`)
      await carol.evaluate(() => localStorage.removeItem('token'))
      await carol.reload()
      await carol.waitForURL(`${HUB}/login**`)
      await carol.getByLabel('Email or username').fill(NAME.carol)
      await carol.getByLabel('Password').fill(PASSWORD)
      await carol.getByRole('button', { name: 'Log In' }).click()
      await carol.getByRole('heading', { name: `Sign in to ${NODE_NAME} with your Cillhub account` }).waitFor()
      await shot(carol, 'consent')
      await carol.getByText('Your password, email, direct messages, friends or other servers').waitFor()
      await carol.getByRole('button', { name: 'Authorize' }).click()
      await carol.waitForURL(`${NODE}/channels/@me`)
      await ready(carol)
      const me = await ok(api(carol, 'GET', '/users/@me'))
      check(me.username === NAME.carol, `node account ${me.username}`)
      ids.carolNode = me.id
      check((await rest(NODE, null, 'POST', '/auth/login', { login: NAME.carol, password: PASSWORD })).status === 401, 'the hub password never reaches the node')
      await ok(api(carol, 'PUT', `/guilds/${ids.arena}/members/@me`))
    })

    await step(`7. Bob finds ${ARENA} in the hub's directory (node badge, online) and joins: sign-in popup with the consent screen, then the server sits in his rail with a node marker`, async () => {
      await bob.goto(HUB + '/directory')
      const card = bob.locator('.dir-card').filter({ hasText: ARENA })
      await card.getByText(`on ${NODE_NAME}`).waitFor(LIVE)
      await card.getByText('Online').waitFor()
      await card.getByText('Weekly scrims and a LAN every month').waitFor()
      await shot(bob, 'directory')
      const popupP = bob.context().waitForEvent('page')
      await card.getByRole('button', { name: `Join ${ARENA}` }).click()
      const popup = await popupP
      await popup.getByRole('heading', { name: `Sign in to ${NODE_NAME} with your Cillhub account` }).waitFor({ timeout: 15000 })
      await popup.getByRole('button', { name: 'Authorize' }).click()
      await bob.waitForURL(`**/channels/${ids.arena}/**`, { timeout: 15000 })
      await until('the popup to close', async () => popup.isClosed())
      await rail(bob).getByRole('link', { name: new RegExp(`^${ARENA} on ${NODE_NAME} \\(Connected\\)`) }).waitFor(LIVE)
      check(await bob.evaluate((n) => !!localStorage.getItem(`instance-token:${n}`), N), 'node token stored per instance')
    })

    await step('8. chat both ways live: Bob (hub client) writes in the node\'s #general, Dana and Carol see it; Dana answers with a mention and Bob gets it live with a badge and a sound', async () => {
      await dana.goto(`${NODE}/channels/${ids.arena}/${ids.arenaGeneral}`)
      await ready(dana)
      await bob.getByRole('heading', { level: 1, name: 'general' }).waitFor()
      await send(bob, `hello from the hub ${SFX}`)
      await msg(dana, `hello from the hub ${SFX}`).waitFor(LIVE)
      await carol.goto(`${NODE}/channels/${ids.arena}/${ids.arenaGeneral}`)
      await msg(carol, `hello from the hub ${SFX}`).waitFor(LIVE)
      await send(dana, `welcome ${SFX}, glad you made it`)
      await msg(bob, `welcome ${SFX}`).waitFor(LIVE)
      await shot(bob, 'multi-instance')
      // a mention while Bob looks at the hub: badge on the node server and the mention sound
      await bob.goto(`${HUB}/channels/${ids.hq}`)
      await ready(bob)
      await until('Bob\'s node server to come back after the reload', async () => (await rail(bob).getByRole('link', { name: new RegExp(`^${ARENA} on ${NODE_NAME} \\(Connected\\)`) }).count()) === 1, 15000)
      const nodeBob = (await ok(api(dana, 'GET', `/guilds/${ids.arena}/members?limit=10`))).find((m) => m.user.username === NAME.bob)
      check(nodeBob, 'Bob has a linked account on the node')
      const before = await bob.evaluate(() => window.__sounds)
      await send(dana, `<@${nodeBob.user.id}> ping from the node ${SFX}`, `ping from the node ${SFX}`)
      await rail(bob).getByRole('link', { name: new RegExp(`^${ARENA} on ${NODE_NAME}.*1 mention`) }).waitFor(LIVE)
      await until('the mention sound', async () => (await bob.evaluate(() => window.__sounds)) > before)
    })

    await step('9. voice on the node server from the hub client (cillvoice through the node\'s gateway) with Dana on the node; voice on the hub server with LiveKit', async () => {
      await bob.goto(`${HUB}/channels/${ids.arena}/${ids.arenaGeneral}`)
      await ready(bob)
      const join = async (page, guild) => {
        await page.getByRole('navigation', { name: `${guild} channels` }).getByRole('button', { name: /^General \(voice channel/ }).click()
        await page.getByRole('status').filter({ hasText: 'Voice Connected' }).waitFor({ timeout: 20000 })
      }
      await join(bob, ARENA)
      await join(dana, ARENA)
      const nodeChannels = (page) => page.getByRole('navigation', { name: `${ARENA} channels` })
      await until('both in the node voice channel (seen by Dana and by Bob)', async () =>
        (await nodeChannels(dana).getByText(NAME.bob).count()) > 0 && (await nodeChannels(dana).getByText(NAME.dana).count()) > 0 && (await nodeChannels(bob).getByText(NAME.dana).count()) > 0, 15000)
      const states = (await ok(api(dana, 'GET', `/guilds/${ids.arena}`))).id && await rest(NODE, null, 'GET', '/instance')
      check(states.body.federation.mode === 'connected', 'still connected')
      await bob.getByRole('region', { name: 'Voice connection' }).getByRole('button', { name: 'Disconnect' }).click()
      await dana.getByRole('region', { name: 'Voice connection' }).getByRole('button', { name: 'Disconnect' }).click()
      // the hub server's voice goes through LiveKit
      await alice.goto(`${HUB}/channels/${ids.hq}`)
      await ready(alice)
      await ok(api(alice, 'POST', `/channels/${(await ok(api(alice, 'GET', `/guilds/${ids.hq}/channels`))).find((c) => c.type === 0).id}/invites`, { max_age: 0 })).then((inv) => ok(api(bob, 'POST', `/invites/${inv.code}`)))
      await join(alice, HQ)
      await bob.goto(`${HUB}/channels/${ids.hq}`)
      await ready(bob)
      await join(bob, HQ)
      await until('Alice and Bob in the LiveKit room', async () => (await alice.getByRole('navigation', { name: `${HQ} channels` }).getByText(NAME.bob).count()) > 0, 15000)
      await bob.getByRole('region', { name: 'Voice connection' }).getByRole('button', { name: 'Disconnect' }).click()
      await alice.getByRole('region', { name: 'Voice connection' }).getByRole('button', { name: 'Disconnect' }).click()
    })

    await step('10. a node notification reaches the hub user: Carol is offline on the hub, a mention on the node goes node → hub (signed NOTIFY) → her Web Push subscription', async () => {
      const ecdh = createECDH('prime256v1')
      ecdh.generateKeys()
      // Carol's only tab is on the node; her hub token sits in the hub origin's storage (she logged in there to consent)
      const hubTab = await carol.context().newPage()
      await hubTab.goto(HUB + '/channels/@me')
      await ready(hubTab)
      const token = await hubTab.evaluate(() => localStorage.getItem('token'))
      check((await rest(HUB, token, 'POST', '/users/@me/push-subscriptions', { endpoint: `http://127.0.0.1:${PUSH_PORT}/push/carol`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } })).status === 204, 'push subscription')
      await hubTab.close()
      await carol.goto('about:blank') // offline everywhere: the node pushes only to people who are not active there
      await dana.goto(`${NODE}/channels/${ids.arena}/${ids.arenaGeneral}`)
      await ready(dana)
      await send(dana, `<@${ids.carolNode}> scrim at 8, are you in? ${SFX}`, `scrim at 8, are you in? ${SFX}`)
      await until('the hub to deliver the node mention to Carol\'s push service', async () => pushed.includes('/push/carol'), 10000)
      await carol.goto(`${NODE}/channels/${ids.arena}/${ids.arenaGeneral}`)
      await ready(carol)
    })

    await step('11. directory moderation: Bob reports the node server; Alice sees the report, hides it with a reason (gone for users, Dana sees why), then lists it again', async () => {
      await bob.goto(HUB + '/directory')
      const card = bob.locator('.dir-card').filter({ hasText: ARENA })
      await card.getByRole('button', { name: 'Report' }).click()
      await modal(bob, `Report ${ARENA}`).getByLabel('What is wrong with this listing?').fill('posts invite spam in other servers')
      await confirmIn(bob, `Report ${ARENA}`, 'Report')
      await bob.getByText('Thanks. The hub admins will review this server.').waitFor()
      await admin(alice, HUB, 'directory')
      const entry = alice.locator('.admin-card').filter({ hasText: ARENA })
      await entry.getByText('posts invite spam in other servers').waitFor()
      await entry.getByRole('button', { name: 'Hide' }).click()
      await modal(alice, `Hide ${ARENA} from the directory?`).getByLabel('Reason').selectOption('spam') // 7.10.3: a statement of reasons
      await modal(alice, `Hide ${ARENA} from the directory?`).getByLabel('Explanation for the affected user').fill('spam reports')
      await confirmIn(alice, `Hide ${ARENA} from the directory?`, 'Hide')
      await alice.getByText('Hidden from the directory.').waitFor()
      await alice.getByRole('button', { name: 'Hidden' }).click()
      await alice.locator('.admin-card').filter({ hasText: ARENA }).getByText('Hidden because: spam reports').waitFor()
      await bob.reload()
      await bob.getByRole('heading', { name: 'Server Directory', level: 1 }).waitFor()
      await bob.getByText(/\d+ servers?/).first().waitFor()
      check((await bob.locator('.dir-card').filter({ hasText: ARENA }).count()) === 0, 'hidden for users')
      await ok(api(dana, 'POST', '/admin/federation/heartbeat'))
      const meta = await ok(api(dana, 'GET', `/guilds/${ids.arena}/discovery-metadata`))
      check(meta.hidden && meta.hidden_reason === 'spam reports', `the owner sees the hub's decision: ${JSON.stringify(meta)}`)
      await dana.goto(`${NODE}/channels/${ids.arena}/${ids.arenaGeneral}`)
      await ready(dana)
      await dana.getByRole('button', { name: ARENA, exact: true }).click()
      await dana.getByRole('button', { name: 'Server Settings' }).click()
      await dana.getByRole('tab', { name: 'Server Directory' }).click()
      await dana.getByText('The hub admins removed this server from the directory.', { exact: false }).waitFor()
      await dana.getByRole('button', { name: 'Close settings' }).click()
      check((await rest(HUB, await bob.evaluate(() => localStorage.getItem('token')), 'GET', `/discoverable-guilds?query=${encodeURIComponent(ARENA)}`)).body.total === 0, 'a heartbeat does not bring it back')
      await alice.locator('.admin-card').filter({ hasText: ARENA }).getByRole('button', { name: 'List Again' }).click()
      await alice.getByText('Listed again.').waitFor()
      await bob.reload()
      await bob.locator('.dir-card').filter({ hasText: ARENA }).waitFor(LIVE)
    })

    await step('12. Alice suspends the node: its servers disappear from Bob\'s rail and the directory, hub sign-in is refused, and the node ends the sessions of hub accounts (local ones stay)', async () => {
      await bob.goto(`${HUB}/channels/${ids.hq}`)
      await ready(bob)
      await rail(bob).getByRole('link', { name: new RegExp(`^${ARENA} on ${NODE_NAME} \\(Connected\\)`) }).waitFor(LIVE)
      await admin(alice, HUB, 'nodes')
      await alice.getByRole('button', { name: NODE_NAME }).click()
      await modal(alice, `Node ${NODE_NAME}`).getByRole('button', { name: 'Suspend' }).click()
      await modal(alice, `Suspend ${NODE_NAME}?`).getByLabel('Reason (shown in the audit log)').fill('investigating spam')
      await confirmIn(alice, `Suspend ${NODE_NAME}?`, 'Suspend')
      await codeIn(alice, `Suspend ${NODE_NAME}?`, await freshCode(aliceSecret), 'Suspend')
      await alice.getByText('Node suspended.').waitFor()
      await until('the node server to leave Bob\'s rail', async () => (await rail(bob).getByRole('link', { name: re(ARENA) }).count()) === 0, 15000)
      await carol.getByRole('heading', { name: 'Ready up' }).waitFor(LIVE) // her node session ended
      check((await rest(NODE, null, 'GET', '/auth/methods')).body.hub === false, 'hub sign-in off')
      await carol.reload()
      check((await carol.getByRole('button', { name: `Sign in with ${HUB_NAME}` }).count()) === 0, 'no hub sign-in button while suspended')
      const r = await fetch(`${NODE}/api/v9/federation/hub-login?return_to=${encodeURIComponent(`${NODE}/instances/callback`)}&state=x`, { redirect: 'manual' })
      check(new URL(r.headers.get('location')).hash.includes('error=unavailable'), `hub-login while suspended: ${r.headers.get('location')}`)
      check((await api(dana, 'GET', '/users/@me')).status === 200, 'Dana (local) keeps her session')
      check((await ok(api(dana, 'GET', '/admin/federation'))).hub_status === 'suspended', 'the node knows')
      check((await rest(HUB, await bob.evaluate(() => localStorage.getItem('token')), 'GET', '/discoverable-guilds')).body.guilds.every((g) => g.id !== ids.arena), 'gone from the directory')
      await bob.getByRole('button', { name: 'Add a server' }).click()
      await modal(bob, 'Add a server').getByText('Suspended by the hub', { exact: false }).waitFor()
      await bob.keyboard.press('Escape')
    })

    await step('13. Alice lifts the suspension; Dana unlinks from the node\'s Federation page (2FA): hub shows unlinked, hub sessions end, the node is standalone', async () => {
      await alice.getByRole('button', { name: 'Lift Suspension' }).click()
      await confirmIn(alice, `Lift the suspension of ${NODE_NAME}?`, 'Lift Suspension')
      await codeIn(alice, `Lift the suspension of ${NODE_NAME}?`, await freshCode(aliceSecret), 'Lift Suspension')
      await alice.getByText('Suspension lifted.').waitFor()
      await until('the node to be active again', async () => (await ok(api(dana, 'GET', '/admin/federation'))).hub_status === 'linked')
      // Bob signs in to the node again from the directory (his old node session was ended)
      await bob.goto(HUB + '/directory')
      const popupP = bob.context().waitForEvent('page')
      await bob.locator('.dir-card').filter({ hasText: ARENA }).getByRole('button', { name: `Join ${ARENA}` }).click()
      const popup = await popupP
      await popup.getByRole('heading', { name: `Sign in to ${NODE_NAME} with your Cillhub account` }).waitFor({ timeout: 15000 })
      await popup.getByRole('button', { name: 'Authorize' }).click()
      await bob.waitForURL(`**/channels/${ids.arena}/**`, { timeout: 15000 })
      await admin(dana, NODE, 'federation')
      await dana.getByRole('button', { name: 'Unlink from Hub' }).click()
      await codeIn(dana, 'Unlink from the hub?', await freshCode(danaSecret), 'Unlink')
      await dana.getByText('Not linked', { exact: true }).waitFor()
      check((await ok(api(alice, 'GET', `/admin/federation/nodes/${N}`))).status === 'unlinked', 'the hub has it unlinked')
      await until('Bob\'s node session to end', async () => (await rail(bob).getByRole('link', { name: re(ARENA) }).count()) === 0, 15000)
      check((await rest(NODE, null, 'GET', '/instance')).body.federation.mode === 'standalone', 'the node is standalone')
    })

    await step('14. re-link with a new code from the hub (same node id), Bob adds the server again; then Alice bans the node with her 2FA code: servers gone, sessions ended, linking refused for good', async () => {
      await admin(alice, HUB, 'nodes')
      await alice.getByRole('button', { name: 'Create Link Code' }).click()
      await codeIn(alice, 'Create Link Code', await freshCode(aliceSecret), 'Create Link Code')
      const code = (await alice.locator('.admin-newcode code').innerText()).trim()
      await dana.getByLabel('Hub address').fill(HUB)
      await dana.getByLabel('Link code').fill(code)
      await dana.getByRole('button', { name: 'Link', exact: true }).click()
      await dana.getByText('Linked', { exact: true }).waitFor(LIVE)
      check((await ok(api(dana, 'GET', '/admin/federation'))).node_id === N, 'same node id after re-linking')
      await bob.goto(HUB + '/directory')
      const popupP = bob.context().waitForEvent('page')
      await bob.locator('.dir-card').filter({ hasText: ARENA }).getByRole('button', { name: `Join ${ARENA}` }).click()
      const popup = await popupP
      await popup.getByRole('button', { name: 'Authorize' }).click()
      await bob.waitForURL(`**/channels/${ids.arena}/**`, { timeout: 15000 })
      await rail(bob).getByRole('link', { name: new RegExp(`^${ARENA} on ${NODE_NAME} \\(Connected\\)`) }).waitFor(LIVE)
      await alice.reload()
      await alice.getByRole('button', { name: NODE_NAME }).click()
      await modal(alice, `Node ${NODE_NAME}`).getByRole('button', { name: 'Ban Node' }).click()
      await modal(alice, `Ban ${NODE_NAME}?`).getByLabel('Reason (shown in the audit log)').fill('spam network')
      await confirmIn(alice, `Ban ${NODE_NAME}?`, 'Continue')
      await codeIn(alice, `Ban ${NODE_NAME}?`, await freshCode(aliceSecret), 'Ban Node')
      await alice.getByText('Node banned.').waitFor()
      await until('Bob\'s node server to vanish', async () => (await rail(bob).getByRole('link', { name: re(ARENA) }).count()) === 0, 15000)
      await dana.reload()
      await dana.getByText('Banned by the hub').waitFor(LIVE)
      const audit = (await ok(api(alice, 'GET', `/admin/federation/nodes/${N}`))).audit_log.map((e) => e.action)
      check(['node.suspend', 'node.unsuspend', 'node.ban'].every((a) => audit.includes(a)), `node audit: ${audit}`)
      // leaving does not lift a ban, and a banned node cannot link again
      await dana.getByRole('button', { name: 'Unlink from Hub' }).click()
      await codeIn(dana, 'Unlink from the hub?', await freshCode(danaSecret), 'Unlink')
      await dana.getByText('Not linked', { exact: true }).waitFor()
      const fresh = await ok(stepUp(alice, aliceSecret, 'POST', '/admin/federation/link-codes', {}))
      const refused = await api(dana, 'POST', '/admin/federation/link', { hub_url: HUB, link_code: fresh.code })
      check(refused.status === 400 && /banned/.test(refused.body.message), `re-link of a banned node: ${refused.status} ${JSON.stringify(refused.body)}`)
    })

    await step(`15. a standalone node on :${SOLO_PORT} with the hub configured never contacts it (the hub's request log stays empty)`, async () => {
      const S = await startServer(tmp, 'solo', SOLO_PORT, { ...base, CILLCORD_HUB_URL: `http://127.0.0.1:${PROXY_PORT}`, CILLCORD_PUBLIC_URL: SOLO, CILLCORD_SETUP_CODE: 'solo-setup-code-7' })
      const a = (await rest(SOLO, null, 'POST', '/setup/admin', { setup_code: 'solo-setup-code-7', email: 'solo@example.com', username: 'soloadmin', password: PASSWORD })).body
      const secret = 'KRUGS4ZANFZSAYJAONSWG4TFOQQGC3DM'
      const on = (await rest(SOLO, a.token, 'POST', '/users/@me/mfa/totp/enable', { password: PASSWORD, secret, code: await freshCode(secret) })).body
      const done = await rest(SOLO, on.token ?? a.token, 'POST', '/setup/complete', { setup_code: 'solo-setup-code-7', instance_name: 'Solo LAN', registration_mode: 'open', mode: 'standalone' })
      check(done.status === 200 && done.body.federation.mode === 'standalone', `solo setup: ${JSON.stringify(done.body)}`)
      const solo = await newPage(browser, 'Solo')
      await register(solo, SOLO, `Sam_${SFX}`)
      check((await solo.getByRole('button', { name: /^Sign in with/ }).count()) === 0, 'no hub sign-in on a standalone node')
      const g = await ok(api(solo, 'POST', '/guilds', { name: 'Private LAN' }))
      await ok(api(solo, 'POST', `/channels/${g.channels.find((c) => c.type === 0).id}/messages`, { content: 'hello' }))
      check((await api(solo, 'PATCH', `/guilds/${g.id}/discovery-metadata`, { listed: true, primary_category_id: 2 })).status === 400, 'no directory when standalone')
      await sleep(3000) // past the first heartbeat slot (2 s after start)
      check(proxied.length === 0, `the standalone node contacted the hub: ${proxied.join(', ')}`)
      check(fs.readFileSync(S.log, 'utf8').split('\n').every((l) => !/\bhub\b/i.test(l)), 'no hub errors in its log')
    })

    await step('16. no uncaught page errors and no native dialogs', async () => {
      if (errors.length) throw new Error(errors.join('; '))
    })
  } catch (e) {
    if (!results.length || results.at(-1)) console.log(`not ok - setup: ${e.stack}`), (failed = true)
  } finally {
    await browser.close().catch(() => {})
    for (const c of children) c.kill()
    for (const s of servers) s.close()
    await sleep(500)
    if (process.env.E2E_KEEP_LOGS) console.log(`logs kept in ${tmp}`)
    else fs.rmSync(tmp, { recursive: true, force: true })
  }
  console.log(`${results.filter(Boolean).length}/${results.length} steps passed`)
  process.exit(failed ? 1 : 0)
}

process.on('exit', () => { for (const c of children) c.kill() }) // also when a browser event handler throws
main().catch((e) => {
  console.error(e)
  for (const c of children) c.kill()
  process.exit(1)
})
