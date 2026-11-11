// End-to-end check of v8 (modules) with Alice (instance admin), Bob, Carol and Dave in real browsers against a real server.
// Starts its own throwaway instance from server/ on E2E_PORT (3380) serving client/dist with a temp DATA_DIR, and a local
// smart-HTTP Git server (`git http-backend`) on E2E_GIT_PORT (3381) holding a bare repository of examples/modules/scrim-board;
// the instance gets CILLCORD_UNFURL_ALLOW=127.0.0.1:<git port> (test-only hatch) so its SSRF guard lets the clone through.
// No internet access is needed. Run: NODE_PATH=<dir with playwright> node scripts/e2e-v8.cjs
// E2E_SCREENSHOTS=1 writes docs/screenshots/v8-*.png, E2E_FAIL_SHOTS=<dir> saves every page when a step fails.
// External instance: E2E_BASE_URL=http://127.0.0.1:<port> E2E_ADMIN_CLI="docker exec <container> node src/admin-cli.js"
// (the instance must have CILLCORD_UNFURL_ALLOW=127.0.0.1:<git port> and reach the Git server on 127.0.0.1).
// Admin rights come from the real CLI (server/src/admin-cli.js); TOTP codes are computed here with node:crypto.
const { chromium } = require('playwright')
const { spawn, execFileSync } = require('node:child_process')
const { createHmac, randomBytes, randomUUID } = require('node:crypto')
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const ROOT = path.join(__dirname, '..')
const SERVER_DIR = path.join(ROOT, 'server')
const EXAMPLES = path.join(ROOT, 'examples', 'modules')
const DIST = process.env.E2E_STATIC_DIR ?? path.join(ROOT, 'client', 'dist')
const PORT = Number(process.env.E2E_PORT ?? 3380)
const GIT_PORT = Number(process.env.E2E_GIT_PORT ?? 3381)
const EXTERNAL = process.env.E2E_BASE_URL
const SHOTS = process.env.E2E_SCREENSHOTS ? path.join(ROOT, 'docs', 'screenshots') : null
const LIVE = { timeout: 8000 }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const SFX = Math.random().toString(36).slice(2, 7)
const NAME = { alice: `Alice_${SFX}`, bob: `Bob_${SFX}`, carol: `Carol_${SFX}`, dave: `Dave_${SFX}` }
const PASSWORD = 'correct horse battery'
const GUILD = `Scrim Lab ${SFX}`
const TWITCH_SECRET = `eventsub-${randomBytes(8).toString('hex')}`
const re = (s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')

let failed = false
const errors = []
const pages = {}
const results = []
const children = []
const closers = []
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
const usedStep = {}
async function freshCode(secret) {
  for (;;) {
    const t = Math.floor(Date.now() / 30000)
    const s = Math.max((usedStep[secret] ?? -1) + 1, t)
    if (s <= t + 1) return (usedStep[secret] = s), totp(secret, s * 30000)
    await sleep(1000)
  }
}

// Every page and frame: records the messages a module panel frame receives (to check that no token is ever among them).
function hooks() {
  if (!location.pathname.startsWith('/modules/')) return
  window.__msgs = []
  addEventListener('message', (e) => { try { window.__msgs.push(JSON.stringify(e.data)) } catch { window.__msgs.push(String(e.data)) } })
}
function watch(page, name) {
  pages[name] = page
  page.on('pageerror', (e) => {
    // Expected inside the opaque-origin panel frames (Playwright's service-worker block touches navigator.serviceWorker there).
    if (!/sandboxed and lacks the 'allow-same-origin' flag/.test(e.message)) errors.push(`${name}: ${e.message}`)
  })
  page.on('dialog', (d) => (errors.push(`${name}: unexpected native dialog "${d.message()}"`), d.dismiss()))
}
async function newPage(browser, name) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1, serviceWorkers: 'block' })
  await ctx.addInitScript(hooks)
  const page = await ctx.newPage()
  watch(page, name)
  return page
}
async function ready(page) {
  await page.getByRole('navigation', { name: /^(Servers|Server)$/ }).waitFor()
  await until('the gateway to connect (no "Connecting…")', async () => (await page.getByText(/Connecting…|Verbinde…/).count()) === 0, 10000)
}
async function register(page, name) {
  await page.goto(BASE + '/register')
  await page.getByRole('heading', { name: 'Join the roster' }).waitFor()
  await page.getByLabel('Email').fill(`${name.toLowerCase()}@example.com`)
  await page.getByLabel('Username').fill(name)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByLabel(/I am at least/).check() // 7.10.3 sign-up check
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.waitForURL('**/channels/@me')
  await ready(page)
}

// REST as the page's user (same token the client uses). Returns {status, body}.
const api = (page, method, route, body) =>
  page.evaluate(async ([method, route, body]) => {
    const r = await fetch('/api/v9' + route, { method, headers: { Authorization: localStorage.getItem('token'), ...(body && { 'Content-Type': 'application/json' }) }, body: body && JSON.stringify(body) })
    return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }
  }, [method, route, body])
const ok = async (p) => { const r = await p; check(r.status < 300, `API answered ${r.status}: ${JSON.stringify(r.body)}`); return r.body }
async function rest(token, method, route, body) {
  const r = await fetch(BASE + '/api/v9' + route, { method, headers: { ...(token && { Authorization: token }), ...(body && { 'Content-Type': 'application/json' }) }, body: body && JSON.stringify(body) })
  const out = r.status === 204 ? null : await r.json().catch(() => null)
  check(r.status < 300, `${method} ${route} answered ${r.status}: ${JSON.stringify(out)}`)
  return out
}

const modal = (page, name) => page.getByRole('dialog', { name })
const confirmIn = (page, title, button) => modal(page, title).getByRole('button', { name: button, exact: true }).click()
const log = (page) => page.getByRole('log').first()
const msg = (page, text) => page.locator('li.msg').filter({ hasText: text })
const members = (page) => page.getByRole('complementary', { name: 'Members' })
const composer = (page, channel) => page.getByRole('textbox', { name: `Message #${channel}` })
async function openChannel(page, channel) {
  await page.goto(`${BASE}/channels/${ids.guild}/${ids[channel]}`)
  await ready(page)
}
async function slash(page, channel, name) {
  const box = composer(page, channel)
  await box.fill(`/${name}`)
  await page.getByRole('listbox', { name: 'Commands' }).getByRole('option', { name: new RegExp(`^/${name}\\b`) }).waitFor(LIVE)
  await box.press('Enter')
  const form = page.getByRole('group', { name: `Command /${name}` })
  if (await form.count()) await form.getByRole('button', { name: 'Send' }).click()
  else await box.press('Enter')
}
const shot = async (page, name) => {
  if (!SHOTS) return
  await page.mouse.move(0, 0)
  await until('toasts to clear before the screenshot', async () => (await page.locator('.toast').count()) === 0, 10000).catch(() => {})
  await sleep(500)
  await page.screenshot({ path: path.join(SHOTS, `v8-${name}.png`) })
}

// --- Admin › Modules helpers ---
async function modulesPage(page) {
  await page.goto(`${BASE}/admin/modules`)
  await page.getByRole('button', { name: 'Install Module' }).waitFor()
}
async function openModule(page, name) {
  await modulesPage(page)
  await page.getByRole('table').getByRole('button', { name, exact: true }).click()
  await page.getByRole('group', { name: 'Module sections' }).waitFor()
}
const tab = (page, name) => page.getByRole('group', { name: 'Module sections' }).getByRole('button', { name, exact: true }).click()
// The 2FA prompt of install, update and remove: answered with a TOTP code or a backup code.
let codes = []
async function answerMfa(page, title, button, code) {
  const dlg = modal(page, title)
  await dlg.getByLabel('Authentication or backup code').fill(code)
  await confirmIn(page, title, button)
}
// The review screen: every permission explained, the lists approved, the 2FA code asked for.
async function reviewAndInstall(page, name, permissions, code) {
  await page.getByRole('heading', { name: `Review ${name} before installing` }).waitFor({ timeout: 30000 })
  const items = page.locator('ul.module-perms > li')
  check((await items.count()) === permissions.length, `${name}: ${await items.count()} permissions listed, expected ${permissions.length}`)
  for (const p of permissions) {
    const li = items.filter({ has: page.locator('code', { hasText: new RegExp(`^${p.replace('.', '\\.')}$`) }) })
    check((await li.count()) === 1, `${name}: permission ${p} listed`)
    const text = (await li.locator('p').first().innerText()).trim()
    check(text.length > 20 && !/Unknown permission/.test(text), `${name}: ${p} explained ("${text}")`)
  }
  await page.getByRole('button', { name: 'Approve and Install' }).click()
  await answerMfa(page, `Install ${name}?`, 'Install', code)
  await page.getByRole('heading', { name: re(`${name} 1.0.0`) }).waitFor(LIVE)
}
async function installFile(page, name, file, permissions, code) {
  await modulesPage(page)
  await page.getByRole('button', { name: 'Install Module' }).click()
  await page.getByLabel('Package (.zip or .tgz, at most 5 MB)').setInputFiles(file)
  await page.getByRole('button', { name: 'Upload and Review' }).click()
  await reviewAndInstall(page, name, permissions, code)
}
async function enableAndScope(page) {
  await tab(page, 'Overview')
  await flip(page.getByRole('switch', { name: 'Enabled' }), true)
  await tab(page, 'Servers')
  await page.getByLabel('Only the servers I choose').check()
  await pickServer(page, 'Add a server')
  await page.getByRole('list', { name: 'Chosen servers' }).getByText(GUILD).waitFor()
  await page.getByRole('button', { name: 'Save Servers' }).click()
  await page.getByText('Saved.').first().waitFor(LIVE)
}
// The enabled switches follow the server's answer (no optimistic flip), so click and wait instead of check().
async function flip(sw, on) {
  if ((await sw.isChecked()) !== on) await sw.click()
  await until(`the switch to be ${on ? 'on' : 'off'}`, async () => (await sw.isChecked()) === on)
}
// A GuildPick search (several can be on screen: the per-server picker and the channel/role pickers' server choice).
async function pickServer(page, label) {
  const box = page.locator('.module-guild-search').filter({ has: page.getByRole('searchbox', { name: label, exact: true }) })
  await box.getByRole('searchbox').fill(GUILD)
  await box.getByRole('list', { name: 'Servers found' }).getByRole('button', { name: GUILD }).click()
}
const modApi = (id) => api(pages.Alice, 'GET', `/admin/modules/${id}`)
const running = (id) => until(`${id} to run`, async () => (await modApi(id)).body?.status === 'running', 15000)

// --- a local smart-HTTP Git server (git http-backend as CGI) ---
const gitEnv = (home) => ({ PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' })
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=E2E', '-c', 'user.email=e2e@example.com', ...args], { cwd, env: gitEnv(cwd), encoding: 'utf8' }).trim()
function gitServer(root, port) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    const env = {
      ...gitEnv(root), GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: u.pathname, QUERY_STRING: u.search.slice(1), REQUEST_METHOD: req.method,
      CONTENT_TYPE: req.headers['content-type'] ?? '', REMOTE_ADDR: '127.0.0.1', ...(req.headers['content-encoding'] && { HTTP_CONTENT_ENCODING: req.headers['content-encoding'] }),
      ...(req.headers['git-protocol'] && { GIT_PROTOCOL: req.headers['git-protocol'] }),
    }
    const p = spawn('git', ['http-backend'], { env })
    req.pipe(p.stdin)
    let head = Buffer.alloc(0)
    let started = false
    p.stdout.on('data', (chunk) => {
      if (started) return res.write(chunk)
      head = Buffer.concat([head, chunk])
      const i = head.indexOf('\r\n\r\n')
      if (i < 0) return
      started = true
      let status = 200
      const h = {}
      for (const line of head.subarray(0, i).toString().split('\r\n')) {
        const c = line.indexOf(':')
        if (line.slice(0, c).toLowerCase() === 'status') status = parseInt(line.slice(c + 1))
        else h[line.slice(0, c)] = line.slice(c + 1).trim()
      }
      res.writeHead(status, h)
      res.write(head.subarray(i + 4))
    })
    p.stdout.on('end', () => (started ? res.end() : res.writeHead(500).end()))
  })
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(() => new Promise((r) => server.close(r))))
  })
}

// A Twitch EventSub request signed with `secret` (HMAC-SHA256 over id + timestamp + body).
function twitch(type, body, secret = TWITCH_SECRET) {
  const id = randomUUID()
  const ts = new Date().toISOString()
  const raw = JSON.stringify(body)
  return fetch(`${BASE}/modules/twitch-live/http/twitch`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'twitch-eventsub-message-id': id, 'twitch-eventsub-message-timestamp': ts, 'twitch-eventsub-message-type': type,
      'twitch-eventsub-message-signature': 'sha256=' + createHmac('sha256', secret).update(id + ts + raw).digest('hex'),
    },
    body: raw,
  })
}
const online = (login) => ({ subscription: { id: 'sub-1', type: 'stream.online', version: '1', status: 'enabled' }, event: { id: '9001', broadcaster_user_id: '1337', broadcaster_user_login: login, broadcaster_user_name: login, type: 'live', started_at: new Date().toISOString() } })

const ids = {}

async function main() {
  if (!EXTERNAL && !fs.existsSync(path.join(DIST, 'index.html'))) throw new Error(`no client build in ${DIST}: run npm run build in client/`)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cillhub-e2e8-'))
  const browser = await chromium.launch()
  let dataDir
  try {
    // packages: two .tgz files and a bare Git repository of scrim-board
    const pack = (id) => { const f = path.join(tmp, `${id}-1.0.0.tgz`); execFileSync('tar', ['czf', f, '-C', path.join(EXAMPLES, id), '.']); return f }
    const files = { welcome: pack('welcome-roles'), twitch: pack('twitch-live') }
    const gitRoot = path.join(tmp, 'git')
    const work = path.join(tmp, 'scrim-work')
    fs.mkdirSync(gitRoot)
    fs.cpSync(path.join(EXAMPLES, 'scrim-board'), work, { recursive: true })
    git(gitRoot, 'init', '-q', '--bare', '-b', 'main', path.join(gitRoot, 'scrim-board.git'))
    git(work, 'init', '-q', '-b', 'main')
    const commit = (m) => { git(work, 'add', '-A'); git(work, 'commit', '-q', '-m', m); git(work, 'push', '-q', path.join(gitRoot, 'scrim-board.git'), 'main'); return git(work, 'rev-parse', 'HEAD') }
    const firstCommit = commit('Scrim Board 1.0.0')
    closers.push(await gitServer(gitRoot, GIT_PORT))
    const GIT_URL = `http://127.0.0.1:${GIT_PORT}/scrim-board.git`

    let grant
    if (EXTERNAL) {
      BASE = EXTERNAL.replace(/\/$/, '')
      const cli = (process.env.E2E_ADMIN_CLI ?? '').split(' ').filter(Boolean)
      if (!cli.length) throw new Error('E2E_BASE_URL needs E2E_ADMIN_CLI (e.g. "docker exec cillhub-mod-e2e node src/admin-cli.js")')
      grant = (name) => execFileSync(cli[0], [...cli.slice(1), 'grant', name], { encoding: 'utf8' })
    } else {
      dataDir = fs.mkdtempSync(path.join(tmp, 'data-'))
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('LIVEKIT_') && !k.startsWith('CILLCORD_')))
      const out = fs.openSync(path.join(tmp, 'server.log'), 'w')
      const p = spawn(process.execPath, ['src/index.js'], { cwd: SERVER_DIR, env: { ...env, PORT: String(PORT), DATA_DIR: dataDir, STATIC_DIR: DIST, CILLCORD_UNFURL_ALLOW: `127.0.0.1:${GIT_PORT}` }, stdio: ['ignore', out, out] })
      children.push(p)
      BASE = `http://127.0.0.1:${PORT}`
      grant = (name) => execFileSync(process.execPath, ['src/admin-cli.js', 'grant', name], { cwd: SERVER_DIR, env: { ...process.env, DATA_DIR: dataDir }, encoding: 'utf8' })
    }
    await until(`the instance at ${BASE}`, async () => (await fetch(BASE + '/api/v9/instance')).ok, 20000)

    const alice = await newPage(browser, 'Alice')
    const bob = await newPage(browser, 'Bob')
    const carol = await newPage(browser, 'Carol')
    const secret = Array.from(randomBytes(32), (b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[b & 31]).join('')
    let aliceToken

    await step(`1. Alice and Bob register (suffix ${SFX}); the admin CLI grants Alice; she turns on 2FA (TOTP computed here), creates ${GUILD}; Bob joins by invite`, async () => {
      for (const [p, n] of [[alice, NAME.alice], [bob, NAME.bob]]) await register(p, n)
      for (const [k, p] of Object.entries({ alice, bob })) ids[k] = (await api(p, 'GET', '/users/@me')).body.id
      check(re(NAME.alice).test(grant(NAME.alice)), 'the CLI granted Alice')
      const r = await ok(api(alice, 'POST', '/users/@me/mfa/totp/enable', { password: PASSWORD, secret, code: await freshCode(secret) }))
      codes = r.backup_codes.filter((c) => !c.consumed).map((c) => c.code)
      check(codes.length >= 4, 'backup codes returned')
      aliceToken = await alice.evaluate(() => localStorage.getItem('token'))
      await alice.getByRole('button', { name: 'Add a server' }).click()
      const dialog = modal(alice, 'Add a server')
      await dialog.getByLabel('Server name').first().fill(GUILD)
      await dialog.getByRole('button', { name: 'Create', exact: true }).click()
      await alice.getByRole('heading', { level: 1, name: 'general' }).waitFor()
      ids.guild = new URL(alice.url()).pathname.split('/')[2]
      ids.general = new URL(alice.url()).pathname.split('/')[3]
      ids.welcome = (await ok(api(alice, 'POST', `/guilds/${ids.guild}/channels`, { name: 'welcome', type: 0 }))).id
      ids.live = (await ok(api(alice, 'POST', `/guilds/${ids.guild}/channels`, { name: 'live', type: 0 }))).id
      ids.invite = (await ok(api(alice, 'POST', `/channels/${ids.general}/invites`, { max_age: 0 }))).code
      await bob.goto(`${BASE}/invite/${ids.invite}`)
      await bob.getByRole('button', { name: 'Join' }).click()
      await ready(bob)
    })

    await step('2a. Admin › Modules: welcome-roles from a .tgz file; the review explains every permission; Install asks for the 2FA code (TOTP)', async () => {
      await installFile(alice, 'Welcome Roles', files.welcome, ['members.read', 'messages.send', 'roles.manage'], await freshCode(secret))
      const m = (await modApi('welcome-roles')).body
      check(m.enabled === false && m.status === 'disabled' && m.source.type === 'file' && m.source.filename === 'welcome-roles-1.0.0.tgz', `installed disabled from the file: ${JSON.stringify(m.source)} ${m.status}`)
    })

    await step('2b. scrim-board from the Git URL (smart HTTP on 127.0.0.1, allowed by the test hatch); the commit is recorded', async () => {
      await modulesPage(alice)
      await alice.getByRole('button', { name: 'Install Module' }).click()
      await alice.getByLabel('Git URL (https://)').fill(GIT_URL)
      await alice.getByLabel('Branch or tag (optional)').fill('main')
      await alice.getByRole('button', { name: 'Fetch and Review' }).click()
      await alice.getByRole('heading', { name: 'Review Scrim Board before installing' }).waitFor({ timeout: 30000 })
      await alice.getByText(firstCommit.slice(0, 12)).waitFor()
      await alice.getByRole('listitem').filter({ hasText: 'Side panel in channels' }).waitFor()
      await alice.locator('code', { hasText: '/scrims' }).first().waitFor()
      await shot(alice, 'review')
      await reviewAndInstall(alice, 'Scrim Board', ['commands', 'storage', 'ui'], codes.shift())
      const m = (await modApi('scrim-board')).body
      check(m.source.type === 'git' && m.source.commit === firstCommit && m.source.git_ref === 'main', `git source ${JSON.stringify(m.source)}`)
    })

    await step('2c. twitch-live from a .tgz file (http.routes shows its web address in the review)', async () => {
      await modulesPage(alice)
      await alice.getByRole('button', { name: 'Install Module' }).click()
      await alice.getByLabel('Package (.zip or .tgz, at most 5 MB)').setInputFiles(files.twitch)
      await alice.getByRole('button', { name: 'Upload and Review' }).click()
      await alice.getByRole('heading', { name: 'Review Twitch Live before installing' }).waitFor({ timeout: 30000 })
      check(await alice.locator('ul.module-perms').getByText('/modules/twitch-live/http/').count() === 1, 'the web address under http.routes')
      await reviewAndInstall(alice, 'Twitch Live', ['http.routes', 'messages.send', 'storage'], codes.shift())
    })

    await step('2d. all three enabled for her server only (scope "guilds"); the bots join with their managed roles', async () => {
      for (const [id, name] of [['welcome-roles', 'Welcome Roles'], ['scrim-board', 'Scrim Board'], ['twitch-live', 'Twitch Live']]) {
        await openModule(alice, name)
        await enableAndScope(alice)
        await running(id)
        const m = (await modApi(id)).body
        check(m.enabled && m.scope === 'guilds' && m.guild_ids.join() === ids.guild, `${id}: ${m.scope} ${m.guild_ids}`)
        ids[id] = m.application_id
      }
      const list = await ok(api(alice, 'GET', `/guilds/${ids.guild}/members?limit=100`))
      for (const id of ['welcome-roles', 'scrim-board', 'twitch-live']) {
        const bot = list.find((x) => x.user.id === ids[id])
        check(bot && bot.user.bot && bot.user.module === true, `${id}'s bot is a member with module: true`)
      }
      // A role for newcomers, created after the module role so it sits below it (role hierarchy).
      ids.newcomer = (await ok(api(alice, 'POST', `/guilds/${ids.guild}/roles`, { name: 'Newcomer', color: 0x2ecc71, permissions: '0' }))).id
    })

    await step('2e. welcome-roles settings through the generated form: per-server values (channel, role, message) for her server', async () => {
      await openModule(alice, 'Welcome Roles')
      await tab(alice, 'Settings')
      await flip(alice.getByLabel('Allow different values per server'), true)
      await alice.getByText('Saved.').first().waitFor(LIVE)
      await pickServer(alice, 'Edit values for server')
      await alice.getByRole('heading', { name: `Values for ${GUILD}` }).waitFor()
      await alice.getByLabel('Welcome channel').selectOption({ label: '#welcome' })
      await alice.getByLabel('Role for new members').selectOption({ label: '@Newcomer' })
      await alice.getByLabel('Welcome message').fill(`Hello {user}, welcome to {server}! ${SFX}`)
      await alice.getByRole('button', { name: 'Save Settings' }).click()
      await alice.getByText('Saved.').first().waitFor(LIVE)
      const g = await ok(api(alice, 'GET', `/admin/modules/welcome-roles/guilds/${ids.guild}/settings`))
      check(g.values.channel === ids.welcome && g.values.role === ids.newcomer && g.values.message.includes(SFX), `server values ${JSON.stringify(g.values)}`)
      await shot(alice, 'settings')
    })

    await step('2f. twitch-live: secret and announcement channel set in the form; the secret is shown as set and never echoed', async () => {
      await openModule(alice, 'Twitch Live')
      await tab(alice, 'Settings')
      await alice.getByLabel('EventSub secret').fill(TWITCH_SECRET)
      await pickServer(alice, 'Server')
      await alice.getByLabel('Announcement channel').selectOption({ label: '#live' })
      await alice.getByRole('button', { name: 'Save Settings' }).click()
      await alice.getByText('Saved.').first().waitFor(LIVE)
      await alice.getByText('A value is set').waitFor()
      check(await alice.getByLabel('EventSub secret').inputValue() === '', 'the secret field is empty after saving')
      const m = (await modApi('twitch-live')).body
      check(JSON.stringify(m.settings.secret) === '{"set":true}' && m.settings.channel === ids.live, `settings ${JSON.stringify(m.settings)}`)
      check(!JSON.stringify(m).includes(TWITCH_SECRET), 'the module object never carries the secret')
      check(!(await alice.content()).includes(TWITCH_SECRET), 'the page never shows the secret')
      const audit = await ok(api(alice, 'GET', '/admin/audit-log?action=module.settings&limit=100'))
      check(audit.length >= 1 && !JSON.stringify(audit).includes(TWITCH_SECRET), 'the audit log has module.settings without the secret')
    })

    await step('3. Bob runs /scrims: the module answers with a Refresh button and the MODULE badge; after a scrim is added, Refresh updates the message', async () => {
      await openChannel(bob, 'general')
      await slash(bob, 'general', 'scrims')
      const reply = msg(bob, 'No upcoming scrims')
      await reply.getByRole('button', { name: 'Refresh' }).waitFor(LIVE)
      check((await reply.locator('.bot-tag').innerText()).trim() === 'MODULE', 'the module bot is tagged MODULE')
      // Alice adds one through the UI request endpoint (the panel's path, without a panel)
      const at = Date.now() + 2 * 86400000
      const r = await ok(api(alice, 'POST', '/modules/scrim-board/ui', { panel_id: 'board', guild_id: ids.guild, channel_id: ids.general, data: { action: 'add', opponent: `Team Rocket ${SFX}`, at, slots: 5 } }))
      check(r.data?.scrims?.length === 1, `UI request answer ${JSON.stringify(r)}`)
      await reply.getByRole('button', { name: 'Refresh' }).click()
      await msg(bob, `Team Rocket ${SFX}`).getByText('0/5 players').waitFor(LIVE)
      await members(bob).getByText('Scrim Board').first().waitFor()
      check((await members(bob).locator('li, [role=listitem]').filter({ hasText: 'Scrim Board' }).first().locator('.bot-tag').innerText()).trim() === 'MODULE', 'MODULE badge in the member list')
      await shot(bob, 'command')
    })

    await step('4. Carol joins by invite: welcome-roles greets her in #welcome and gives her the Newcomer role', async () => {
      await register(carol, NAME.carol)
      ids.carol = (await api(carol, 'GET', '/users/@me')).body.id
      await openChannel(alice, 'welcome')
      await carol.goto(`${BASE}/invite/${ids.invite}`)
      await carol.getByRole('button', { name: 'Join' }).click()
      await ready(carol)
      const welcome = msg(alice, `welcome to ${GUILD}! ${SFX}`)
      await welcome.waitFor(LIVE)
      check(re(`Hello @${NAME.carol}`).test(await welcome.innerText()) || (await welcome.locator('.mention').count()) === 1, 'Carol is mentioned')
      check((await welcome.locator('.bot-tag').innerText()).trim() === 'MODULE', 'MODULE badge')
      await until('Carol to have the Newcomer role', async () => (await api(alice, 'GET', `/guilds/${ids.guild}/members/${ids.carol}`)).body.roles.includes(ids.newcomer))
    })

    let bobFrame
    let aliceFrame
    const panelFrame = async (page) => {
      let f
      await until('the panel frame to load', async () => (f = page.frames().find((x) => x.url().includes('/modules/scrim-board/ui/'))) && (await f.locator('#list li').count()) > 0, 15000)
      return f
    }
    await step('5. the Scrims channel panel: a sandboxed iframe (sandbox exactly "allow-scripts"); Bob adds a scrim and joins it; Alice\'s open panel refreshes through ui.publish', async () => {
      await openChannel(alice, 'general')
      await alice.getByRole('button', { name: 'Scrims', exact: true }).click()
      await openChannel(bob, 'general')
      await bob.getByRole('button', { name: 'Scrims', exact: true }).click()
      const iframe = bob.getByRole('complementary', { name: 'Scrims' }).locator('iframe')
      check(await iframe.getAttribute('sandbox') === 'allow-scripts', `sandbox="${await iframe.getAttribute('sandbox')}"`)
      check(await iframe.getAttribute('title') === 'Scrims' && (await iframe.getAttribute('referrerpolicy')) === 'no-referrer', 'title and referrerpolicy')
      const res = await fetch(BASE + (await iframe.getAttribute('src')).replace(/^https?:\/\/[^/]+/, ''))
      const csp = res.headers.get('content-security-policy') ?? ''
      check(/^sandbox allow-scripts;/.test(csp) && csp.includes("connect-src 'none'") && res.headers.get('x-content-type-options') === 'nosniff', `panel headers: ${csp}`)
      bobFrame = await panelFrame(bob)
      aliceFrame = await panelFrame(alice)
      const day = new Date(Date.now() + 3 * 86400000)
      const local = new Date(day.getTime() - day.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
      await bobFrame.getByLabel('Opponent').fill(`Team Aqua ${SFX}`)
      await bobFrame.getByLabel('Date and time').fill(local)
      await bobFrame.getByLabel('Player slots').fill('3')
      await bobFrame.getByRole('button', { name: 'Add scrim' }).click()
      await bobFrame.getByText('Scrim added.').waitFor(LIVE)
      await aliceFrame.getByText(`vs Team Aqua ${SFX}`).waitFor(LIVE)
      await bobFrame.getByRole('button', { name: `Join scrim vs Team Aqua ${SFX}` }).click()
      await bobFrame.getByRole('button', { name: `Leave scrim vs Team Aqua ${SFX}` }).waitFor(LIVE)
      const aliceItem = aliceFrame.locator('#list li').filter({ hasText: `Team Aqua ${SFX}` })
      await aliceItem.getByText('1/3 players').waitFor(LIVE)
      await aliceItem.getByText(NAME.bob).waitFor()
      await shot(bob, 'panel')
    })

    await step('6. escapes from the panel: no storage or cookies, no top navigation, no API fetch (CSP), foreign claims ignored, no token in any message', async () => {
      const urlBefore = bob.url()
      const uiCalls = []
      const onReq = (r) => { if (r.url().includes('/api/v9/modules/')) uiCalls.push(new URL(r.url()).pathname) }
      bob.on('request', onReq)
      const out = await bobFrame.evaluate(async (base) => {
        const r = {}
        const t = (f) => { try { const v = f(); return v === undefined || v === null || v === '' ? 'empty' : `read: ${String(v).slice(0, 40)}` } catch (e) { return 'threw' } }
        r.localStorage = t(() => localStorage.getItem('token'))
        r.sessionStorage = t(() => sessionStorage.length)
        r.cookie = t(() => document.cookie)
        r.parentStorage = t(() => parent.localStorage.getItem('token'))
        r.parentDocument = t(() => parent.document.title)
        r.topNav = t(() => { top.location = 'https://example.com/' })
        r.fetchRel = await fetch('/api/v9/users/@me').then((x) => `loaded ${x.status}`, () => 'blocked')
        r.fetchAbs = await fetch(base + '/api/v9/users/@me').then((x) => `loaded ${x.status}`, () => 'blocked')
        r.xhr = await new Promise((res) => { try { const x = new XMLHttpRequest(); x.open('GET', base + '/api/v9/users/@me'); x.onload = () => res('loaded'); x.onerror = () => res('blocked'); x.send() } catch { res('blocked') } })
        r.windowOpen = t(() => window.open('https://example.com/'))
        const send = (m) => new Promise((res) => {
          const h = (e) => { if (e.source === parent && e.data?.id === m.id) (removeEventListener('message', h), res(e.data)) }
          addEventListener('message', h)
          parent.postMessage(m, '*')
          setTimeout(() => res(null), 3000)
        })
        r.unknown = await send({ cillhub: 1, type: 'request', id: 'x1', action: 'get_token' })
        r.foreign = await send({ cillhub: 1, type: 'request', id: 'x2', action: 'request', module_id: 'twitch-live', panel_id: 'other', guild_id: '1', data: { action: 'list' } })
        r.notRequest = await send({ cillhub: 1, type: 'response', id: 'x3', ok: true, data: null })
        r.huge = await send({ cillhub: 1, type: 'request', id: 'x4', action: 'ready', data: 'x'.repeat(70000) })
        return r
      }, BASE)
      bob.off('request', onReq)
      for (const k of ['localStorage', 'sessionStorage', 'cookie', 'parentStorage', 'parentDocument']) check(out[k] === 'threw' || out[k] === 'empty', `${k}: ${out[k]}`)
      check(out.fetchRel === 'blocked' && out.fetchAbs === 'blocked' && out.xhr === 'blocked', `network from the panel: ${out.fetchRel}, ${out.fetchAbs}, ${out.xhr}`)
      check(out.windowOpen === 'empty' || out.windowOpen === 'threw', `window.open: ${out.windowOpen}`)
      await sleep(1000)
      check(bob.url() === urlBefore, `the app navigated to ${bob.url()}`)
      check(bob.context().pages().length === 1, 'no popup opened')
      check(out.unknown?.ok === false && out.unknown.error.code === 'UNKNOWN_ACTION', `unknown action: ${JSON.stringify(out.unknown)}`)
      check(out.foreign?.ok === true && Array.isArray(out.foreign.data?.scrims), `a request claiming another module is answered by scrim-board itself: ${JSON.stringify(out.foreign).slice(0, 200)}`)
      check(uiCalls.length >= 1 && uiCalls.every((p) => p === '/api/v9/modules/scrim-board/ui'), `UI requests went to ${uiCalls.join(', ')}`)
      check(out.notRequest === null && out.huge === null, `non-requests and oversized messages get no answer: ${JSON.stringify([out.notRequest, out.huge])}`)
      const bobToken = await bob.evaluate(() => localStorage.getItem('token'))
      for (const [page, frame] of [[bob, bobFrame], [alice, aliceFrame]]) {
        const msgs = await frame.evaluate(() => window.__msgs ?? null)
        check(Array.isArray(msgs) && msgs.some((m) => m.includes('"context"')) && msgs.some((m) => m.includes('"event"')), `the frame's message log (${msgs?.length})`)
        const token = page === bob ? bobToken : aliceToken
        check(!msgs.some((m) => m.includes(token)), 'a token reached the panel')
      }
    })

    await step('7. the HTTP endpoint: signed verification answers the challenge (text/plain), a signed stream.online is announced, a badly signed one is refused; CSP sandbox + nosniff', async () => {
      await openChannel(alice, 'live')
      const v = await twitch('webhook_callback_verification', { challenge: `challenge-${SFX}`, subscription: { id: 'sub-1', type: 'stream.online', version: '1', status: 'webhook_callback_verification_pending' } })
      check(v.status === 200 && (await v.text()) === `challenge-${SFX}` && /^text\/plain/.test(v.headers.get('content-type')), `verification: ${v.status} ${v.headers.get('content-type')}`)
      check(v.headers.get('content-security-policy') === "default-src 'none'; sandbox" && v.headers.get('x-content-type-options') === 'nosniff', `headers: ${v.headers.get('content-security-policy')} / ${v.headers.get('x-content-type-options')}`)
      const n = await twitch('notification', online(`streamer_${SFX}`))
      check(n.status === 204, `notification: ${n.status}`)
      check(n.headers.get('content-security-policy') === "default-src 'none'; sandbox" && n.headers.get('x-content-type-options') === 'nosniff', 'headers on 204')
      const post = msg(alice, `streamer_${SFX} is live: https://twitch.tv/streamer_${SFX}`)
      await post.waitFor(LIVE)
      check((await post.locator('.bot-tag').innerText()).trim() === 'MODULE', 'MODULE badge on the announcement')
      const bad = await twitch('notification', online(`forged_${SFX}`), 'not-the-secret')
      check(bad.status === 403 && bad.headers.get('content-security-policy') === "default-src 'none'; sandbox", `forged: ${bad.status}`)
      await sleep(1500)
      const recent = await ok(api(alice, 'GET', `/channels/${ids.live}/messages?limit=20`))
      check(!recent.some((m) => m.content.includes(`forged_${SFX}`)), 'the forged notification posted nothing')
      check((await msg(alice, `forged_${SFX}`).count()) === 0, 'nothing forged in the channel')
      await shot(alice, 'webhook')
    })

    await step('8a. the module log shows the handled webhooks and the refused one', async () => {
      await openModule(alice, 'Twitch Live')
      await tab(alice, 'Logs')
      const lines = alice.getByRole('list', { name: 'Log, newest first' }).getByRole('listitem')
      await lines.filter({ hasText: 'verified' }).first().waitFor(LIVE)
      await lines.filter({ hasText: 'bad signature' }).first().waitFor()
      await alice.getByLabel('Level').selectOption('warn')
      check((await lines.count()) >= 1 && (await lines.filter({ hasText: 'verified' }).count()) === 0, 'the level filter')
      await shot(alice, 'logs')
    })

    await step('8b. welcome-roles disabled: Dave joining gets no welcome and no role; scrim-board disabled: its command and panel vanish; re-enabled and restarted', async () => {
      await modulesPage(alice)
      await flip(alice.getByRole('switch', { name: 'Enable Welcome Roles' }), false)
      await flip(alice.getByRole('switch', { name: 'Enable Scrim Board' }), false)
      await until('both disabled', async () => (await modApi('welcome-roles')).body.status === 'disabled' && (await modApi('scrim-board')).body.status === 'disabled')
      const list = await ok(api(alice, 'GET', `/guilds/${ids.guild}/members?limit=100`))
      check(list.some((x) => x.user.id === ids['welcome-roles']), 'a disabled module keeps its bot in the server')
      await bob.getByRole('button', { name: 'Scrims', exact: true }).waitFor({ state: 'detached', ...LIVE })
      await composer(bob, 'general').fill('/scrims')
      await sleep(1000)
      check((await bob.getByRole('listbox', { name: 'Commands' }).getByRole('option', { name: /^\/scrims\b/ }).count()) === 0, '/scrims still offered')
      await composer(bob, 'general').fill('')
      const dave = await rest(null, 'POST', '/auth/register', { age_confirmed: true, email: `${NAME.dave.toLowerCase()}@example.com`, username: NAME.dave, password: PASSWORD })
      const daveId = (await rest(dave.token, 'GET', '/users/@me')).id
      await rest(dave.token, 'POST', `/invites/${ids.invite}`)
      await sleep(3000)
      const welcome = await ok(api(alice, 'GET', `/channels/${ids.welcome}/messages?limit=20`))
      check(!welcome.some((m) => m.content.includes(daveId)), 'Dave got a welcome from a disabled module')
      check(!(await ok(api(alice, 'GET', `/guilds/${ids.guild}/members/${daveId}`))).roles.includes(ids.newcomer), 'Dave got the role')
      await flip(alice.getByRole('switch', { name: 'Enable Scrim Board' }), true)
      await running('scrim-board')
      await bob.getByRole('button', { name: 'Scrims', exact: true }).waitFor(LIVE)
      await openModule(alice, 'Scrim Board')
      const before = (await modApi('scrim-board')).body.stats.restarts
      await alice.getByRole('button', { name: 'Restart' }).click()
      await alice.getByText('Restarted.').first().waitFor(LIVE)
      await running('scrim-board')
      check((await modApi('scrim-board')).body.stats.started_at, `restarted (restarts ${before})`)
      const r = await ok(api(bob, 'POST', '/modules/scrim-board/ui', { panel_id: 'board', guild_id: ids.guild, channel_id: ids.general, data: { action: 'list' } }))
      check(r.data.scrims.length === 2, 'storage survived disable and restart')
    })

    await step('8c. scrim-board updated from its Git source after a new commit: the review shows 1.0.0 → 1.0.1, the module runs 1.0.1', async () => {
      const manifestPath = path.join(work, 'cillhub-module.json')
      fs.writeFileSync(manifestPath, fs.readFileSync(manifestPath, 'utf8').replace('"version": "1.0.0"', '"version": "1.0.1"'))
      const second = commit('Scrim Board 1.0.1')
      await tab(alice, 'Update')
      await alice.getByRole('button', { name: 'Check for Update' }).click()
      await alice.getByRole('heading', { name: 'Review the update of Scrim Board' }).waitFor({ timeout: 30000 })
      await alice.getByText('1.0.0 → 1.0.1').waitFor()
      await alice.getByText(second.slice(0, 12)).waitFor()
      await alice.getByRole('button', { name: 'Approve and Update' }).click()
      await answerMfa(alice, 'Update Scrim Board?', 'Update', codes.shift())
      await alice.getByRole('heading', { name: 'Scrim Board 1.0.1' }).waitFor(LIVE)
      await running('scrim-board')
      const m = (await modApi('scrim-board')).body
      check(m.version === '1.0.1' && m.source.commit === second, `updated: ${m.version} ${m.source.commit}`)
    })

    await step('8d. twitch-live removed without keeping data (type the id, 2FA): its bot leaves the member list; the audit log has the module.* entries', async () => {
      await openChannel(alice, 'live')
      await members(alice).getByText('Twitch Live').first().waitFor()
      await openModule(alice, 'Twitch Live')
      await tab(alice, 'Remove')
      await alice.getByLabel('Delete them').check()
      await alice.getByLabel('Type the module ID (twitch-live) to confirm').fill('twitch-live')
      await alice.getByRole('button', { name: 'Remove Module' }).click()
      await confirmIn(alice, 'Remove Twitch Live?', 'Remove Module')
      await answerMfa(alice, 'Remove Twitch Live?', 'Remove Module', codes.shift())
      await alice.getByRole('button', { name: 'Install Module' }).waitFor(LIVE)
      check((await modApi('twitch-live')).status === 404, 'the module is gone')
      const list = await ok(api(alice, 'GET', `/guilds/${ids.guild}/members?limit=100`))
      check(!list.some((x) => x.user.id === ids['twitch-live']), 'the bot left the server')
      await openChannel(alice, 'live')
      await members(alice).getByText('Scrim Board').first().waitFor()
      check((await members(alice).getByText('Twitch Live').count()) === 0, 'Twitch Live still in the member list')
      const gone = await fetch(`${BASE}/modules/twitch-live/http/twitch`, { method: 'POST', body: '{}' })
      check(gone.status === 404, `the endpoint answers ${gone.status}`)
      await alice.goto(`${BASE}/admin/audit-log`)
      const table = alice.getByRole('table', { name: 'Admin Audit Log' })
      await table.waitFor()
      const actions = (await table.locator('tbody tr td:nth-child(3)').allInnerTexts()).map((s) => s.trim())
      for (const a of ['module.package', 'module.install', 'module.enable', 'module.disable', 'module.update_config', 'module.settings', 'module.guild_settings', 'module.restart', 'module.upgrade', 'module.remove'])
        check(actions.includes(a), `audit log has ${a} (${[...new Set(actions)].join(', ')})`)
    })

    await step('9. no uncaught page errors and no native dialogs', async () => {
      if (errors.length) throw new Error(errors.join('; '))
    })
  } catch (e) {
    if (!results.length || results.at(-1)) console.log(`not ok - setup: ${e.message}`), (failed = true)
  } finally {
    await browser.close().catch(() => {})
    for (const c of children) c.kill()
    for (const close of closers) await close().catch(() => {})
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
