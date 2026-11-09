// End-to-end check of the bot and productivity paths of v4/v5 that the other e2e scripts do not reach, with Alice, Bob, Carol,
// Dave and Erin in real browsers against a running server that serves client/dist (no voice needed):
// a bot on a real bot library (v14) (autocomplete, string/user/role/channel selects, an ATTACHMENT option answered with a file,
// user and message commands from the right-click Apps menus), an HTTP interactions bot (Ed25519 checked with node:crypto),
// the Cillhub Bot (/reminders cancel, giveaway timed end, reroll and end early, the scrim 15-minute ping), a reminder
// delivered as Web Push while idle (a local push service decrypts the RFC 8291 payload), notification levels, the Unreads
// list, keyboard shortcuts, template sync/delete, username/email change, account deletion with ownership transfer, group
// DM icon and owner transfer, server profiles, and a blocked user's join line.
// Run (fresh instance; the server must let its SSRF guard reach the two local helper ports):
//   PORT=3330 DATA_DIR=$(mktemp -d) STATIC_DIR=<copy of client/dist> CILLCORD_UNFURL_ALLOW=127.0.0.1:3338,127.0.0.1:3339 node server/src/index.js
//   NODE_PATH=/tmp/pw/node_modules E2E_BASE_URL=http://127.0.0.1:3330 node scripts/e2e-v5-apps.cjs
// E2E_PUSH_PORT (3338) and E2E_HOOK_PORT (3339) choose the helper ports; E2E_BOTLIB is the installed
// package directory of the v14 bot library (the bot runs as a child process). Usernames get a random suffix.
// E2E_SECTIONS=bots,cillbot,... runs only those sections after the setup step (for debugging).
const { chromium } = require('playwright')
const { spawn } = require('node:child_process')
const http = require('node:http')
const crypto = require('node:crypto')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const BASE = (process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3330').replace(/\/$/, '')
const PUSH_PORT = Number(process.env.E2E_PUSH_PORT ?? 3338)
const HOOK_PORT = Number(process.env.E2E_HOOK_PORT ?? 3339)
const BOTLIB = process.env.E2E_BOTLIB ?? ''
const SECTIONS = process.env.E2E_SECTIONS ? new Set(process.env.E2E_SECTIONS.split(',')) : null
const LIVE = { timeout: 5000 }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const SFX = Math.random().toString(36).slice(2, 7)
const NAME = { alice: `Alice_${SFX}`, bob: `Bob_${SFX}`, carol: `Carol_${SFX}`, dave: `Dave_${SFX}`, erin: `Erin_${SFX}` }
const PASSWORD = 'correct horse battery'
const GUILD = `Apps HQ ${SFX}`

let failed = false
const errors = []
const pages = {}
const results = []

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

// ---- the bot: the unmodified v14 bot library pointed at Cillhub; one JSON line per event on stdout ----
const BOT = `
const { Client, GatewayIntentBits, Events, ActionRowBuilder, StringSelectMenuBuilder, UserSelectMenuBuilder, RoleSelectMenuBuilder, ChannelSelectMenuBuilder, ChannelType, AttachmentBuilder } = require(process.env.BOTLIB)
const [api, guildId, base] = process.argv.slice(2)
const out = (o) => console.log(JSON.stringify(o))
const GAMES = [{ name: 'Valorant', value: 'valorant' }, { name: 'Counter-Strike 2', value: 'cs2' }, { name: 'League of Legends', value: 'lol' }]
const client = new Client({ intents: [GatewayIntentBits.Guilds], rest: { api } })
client.once(Events.ClientReady, async () => {
  await client.guilds.cache.get(guildId).commands.set([
    { name: 'pick', description: 'Pick a game', options: [{ type: 3, name: 'game', description: 'The game', required: true, autocomplete: true }] },
    { name: 'menus', description: 'Shows select menus' },
    { name: 'echo', description: 'Sends your file back', options: [{ type: 11, name: 'file', description: 'Any file', required: true }, { type: 3, name: 'note', description: 'A note' }] },
    { name: 'High Five', type: 2 },
    { name: 'Quote', type: 3 },
  ])
  out({ ready: client.user.id })
})
client.on(Events.InteractionCreate, async (i) => {
  try {
    if (i.isAutocomplete()) {
      const q = String(i.options.getFocused()).toLowerCase()
      out({ autocomplete: q })
      await i.respond(GAMES.filter((g) => g.name.toLowerCase().includes(q)))
    } else if (i.isChatInputCommand() && i.commandName === 'pick') {
      await i.reply('You picked ' + i.options.getString('game'))
    } else if (i.isChatInputCommand() && i.commandName === 'menus') {
      await i.reply({ content: 'Choose:', components: [
        new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('maps').setPlaceholder('Pick maps').setMinValues(1).setMaxValues(2)
          .addOptions({ label: 'Ancient', value: 'ancient' }, { label: 'Mirage', value: 'mirage' }, { label: 'Nuke', value: 'nuke' })),
        new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId('who').setPlaceholder('Pick a player')),
        new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('role').setPlaceholder('Pick a role')),
        new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('chan').setPlaceholder('Pick a channel').setChannelTypes(ChannelType.GuildText)),
      ] })
    } else if (i.isStringSelectMenu()) {
      await i.update({ content: 'maps: ' + i.values.join(',') })
    } else if (i.isUserSelectMenu()) {
      await i.update({ content: 'player: ' + i.users.first().username + (i.members.first() ? ' (member)' : '') })
    } else if (i.isRoleSelectMenu()) {
      await i.update({ content: 'role: ' + i.roles.first().name })
    } else if (i.isChannelSelectMenu()) {
      await i.update({ content: 'channel: #' + i.channels.first().name })
    } else if (i.isChatInputCommand() && i.commandName === 'echo') {
      const a = i.options.getAttachment('file')
      const bytes = Buffer.from(await (await fetch(base + a.url)).arrayBuffer())
      out({ echo: { name: a.name, size: a.size, type: a.contentType, sha: require('crypto').createHash('sha256').update(bytes).digest('hex'), note: i.options.getString('note') } })
      await i.reply({ content: 'echo of ' + a.name + (i.options.getString('note') ? ' (' + i.options.getString('note') + ')' : ''), files: [new AttachmentBuilder(bytes, { name: 'echo-' + a.name })] })
    } else if (i.isUserContextMenuCommand()) {
      await i.reply(i.user.username + ' high-fived ' + i.targetUser.username)
    } else if (i.isMessageContextMenuCommand()) {
      await i.reply('Quote: ' + i.targetMessage.content)
    }
    out({ handled: i.type, name: i.commandName ?? i.customId })
  } catch (e) { out({ error: String(e && e.message) }) }
})
client.on(Events.Error, (e) => out({ error: String(e && e.message) }))
client.login(process.env.BOT_TOKEN).catch((e) => out({ error: String(e && e.message) }))
`

// ---- an HTTP interactions bot: checks Ed25519 signatures with node:crypto (401 when wrong), answers inline or deferred ----
function hookBot() {
  const hook = { key: null, seen: [], bad: 0 }
  hook.server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const sig = String(req.headers['x-signature-ed25519'] ?? '')
      const ts = String(req.headers['x-signature-timestamp'] ?? '')
      const key = hook.key && crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(hook.key, 'hex')]), format: 'der', type: 'spki' })
      let valid = false
      try { valid = !!key && /^[0-9a-f]{128}$/.test(sig) && crypto.verify(null, Buffer.from(ts + body), key, Buffer.from(sig, 'hex')) } catch { /* invalid */ }
      if (!valid) { hook.bad++; res.writeHead(401); return res.end('invalid request signature') }
      const i = JSON.parse(body)
      hook.seen.push(i)
      const reply = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)) }
      if (i.type === 1) return reply({ type: 1 })
      if (i.data?.name === 'hello') return reply({ type: 4, data: { content: `Hello from HTTP, ${i.member.user.username}` } })
      if (i.data?.name === 'slow') {
        reply({ type: 5 })
        setTimeout(() => void fetch(`${BASE}/api/v10/webhooks/${i.application_id}/${i.token}/messages/@original`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'Done thinking' }) }), 1500)
        return
      }
      reply({ type: 4, data: { content: 'unknown command', flags: 64 } })
    })
  })
  return new Promise((r) => hook.server.listen(HOOK_PORT, '127.0.0.1', () => r(hook)))
}

// ---- a push service: stores each delivery, decrypts the aes128gcm payload (RFC 8291 / RFC 8188) with node:crypto ----
function pushService() {
  const svc = { got: [], subs: {} }
  svc.server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const name = req.url.split('/').pop()
      const sub = svc.subs[name]
      const body = Buffer.concat(chunks)
      try {
        svc.got.push({ name, headers: req.headers, payload: sub ? decrypt(sub, body) : null })
        res.writeHead(201)
      } catch (e) {
        svc.got.push({ name, error: e.message })
        res.writeHead(400)
      }
      res.end()
    })
  })
  // a subscription as a browser would create it: P-256 key pair and a 16-byte auth secret
  svc.subscribe = (name) => {
    const ecdh = crypto.createECDH('prime256v1')
    ecdh.generateKeys()
    const sub = { ecdh, auth: crypto.randomBytes(16) }
    svc.subs[name] = sub
    return { endpoint: `http://127.0.0.1:${PUSH_PORT}/push/${name}`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: sub.auth.toString('base64url') } }
  }
  return new Promise((r) => svc.server.listen(PUSH_PORT, '127.0.0.1', () => r(svc)))
}
function decrypt({ ecdh, auth }, body) {
  const salt = body.subarray(0, 16)
  const rs = body.readUInt32BE(16)
  const idlen = body[20]
  const asPublic = body.subarray(21, 21 + idlen)
  const records = body.subarray(21 + idlen)
  check(rs >= 18 && records.length <= rs, 'one record')
  const secret = ecdh.computeSecret(asPublic)
  const ikm = crypto.hkdfSync('sha256', secret, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic]), 32)
  const cek = crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)
  const nonce = crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12)
  const d = crypto.createDecipheriv('aes-128-gcm', Buffer.from(cek), Buffer.from(nonce))
  d.setAuthTag(records.subarray(records.length - 16))
  const plain = Buffer.concat([d.update(records.subarray(0, records.length - 16)), d.final()])
  let end = plain.length - 1
  while (end >= 0 && plain[end] === 0) end--
  check(plain[end] === 2, 'last-record padding delimiter')
  return JSON.parse(plain.subarray(0, end).toString())
}

// ---- browser helpers ----
function watch(page, name) {
  pages[name] = page
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`))
  page.on('dialog', (d) => (errors.push(`${name}: unexpected native dialog "${d.message()}"`), d.dismiss()))
}
// Desktop notifications are recorded (and the window reports no focus, so they are shown at all).
function recordNotifications() {
  window.__notes = []
  window.Notification = class { constructor(title, o) { window.__notes.push({ title, body: o && o.body, tag: o && o.tag }) } close() {} static requestPermission() { return Promise.resolve('granted') } }
  window.Notification.permission = 'granted'
  try { localStorage.setItem('notif-desktop', '1') } catch { return } // about:blank
  document.hasFocus = () => false
  window.__toasts = []
  new MutationObserver(() => {
    for (const el of document.querySelectorAll('.toast')) if (!el.__seen) (el.__seen = true), window.__toasts.push(el.textContent)
  }).observe(document, { childList: true, subtree: true })
}
async function newUser(browser, name) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' })
  await ctx.addInitScript(recordNotifications)
  const page = await ctx.newPage()
  watch(page, name)
  return page
}
async function ready(page) {
  await page.getByRole('navigation', { name: /^(Servers|Server)$/ }).waitFor()
  await until('the gateway to connect (no "Connecting…")', async () => (await page.getByText(/Connecting…|Verbinde…/).count()) === 0, 10000)
}
async function register(page, name) {
  await page.goto(BASE + '/')
  await page.getByRole('heading', { name: 'Ready up' }).waitFor()
  await page.getByRole('link', { name: 'Register' }).click()
  await page.getByLabel('Email').fill(`${name.toLowerCase()}@example.com`)
  await page.getByLabel('Username').fill(name)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.waitForURL('**/channels/@me')
  await ready(page)
}
async function loginForm(page, name, password = PASSWORD) {
  if (!page.url().startsWith(BASE)) await page.goto(BASE + '/login')
  await page.getByRole('heading', { name: 'Ready up' }).waitFor()
  await page.getByLabel('Email or username').fill(name)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Log In' }).click()
}

// REST as the page's user (same token the client uses). Returns {status, body}.
const api = (page, method, route, body) =>
  page.evaluate(async ([method, route, body]) => {
    const r = await fetch('/api/v9' + route, { method, headers: { Authorization: localStorage.getItem('token'), ...(body && { 'Content-Type': 'application/json' }) }, body: body && JSON.stringify(body) })
    return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }
  }, [method, route, body])
const ok = async (p) => { const r = await p; check(r.status < 300, `API answered ${r.status}: ${JSON.stringify(r.body)}`); return r.body }

const log = (page, label) => page.getByRole('log', { name: `Messages in ${label}` })
const message = (page, label, text) => log(page, label).locator('li.msg').filter({ hasText: text })
const composer = (page, label) => page.getByRole('textbox', { name: `Message ${label}` })
const members = (page) => page.getByRole('complementary', { name: 'Members' })
const modal = (page, name) => page.getByRole('dialog', { name })
const channels = (page, guild = GUILD) => page.getByRole('navigation', { name: `${guild} channels` })
const dmList = (page) => page.getByRole('navigation', { name: 'Direct messages' })
const notes = (page) => page.evaluate(() => window.__notes)
const toasts = (page) => page.evaluate(() => window.__toasts)
const card = (page, label, title) => log(page, label).locator('li.msg').filter({ has: page.locator('article.bot-card', { hasText: title }) })

async function send(page, label, text) {
  const box = composer(page, label)
  await box.fill(text)
  await box.press('Enter')
}
async function openChannel(page, name, guild = 'guild') {
  await page.goto(`${BASE}/channels/${ids[guild]}/${ids[name]}`)
  await ready(page)
  await page.getByRole('heading', { level: 1, name }).waitFor()
}
async function userSettings(page, tab) {
  await page.getByRole('button', { name: 'User Settings' }).click()
  await page.getByRole('tab', { name: tab, exact: true }).click()
}
async function serverSettings(page, tab, guild = GUILD) {
  await page.getByRole('button', { name: guild, exact: true }).click()
  await page.getByRole('button', { name: 'Server Settings' }).click()
  await page.getByRole('tab', { name: tab, exact: true }).click()
}
const closeSettings = (page) => page.getByRole('button', { name: 'Close settings' }).click()

// Picks a slash command in the composer's picker and returns its option form (optional options are added on demand).
async function slashForm(page, label, name) {
  const box = composer(page, label)
  await box.fill(`/${name}`)
  await page.getByRole('listbox', { name: 'Commands' }).getByRole('option', { name: new RegExp(`^/${name}\\b`) }).waitFor(LIVE)
  await box.press('Enter')
  const form = page.getByRole('group', { name: `Command /${name}` })
  await form.waitFor()
  return form
}
async function slash(page, label, name, options = {}) {
  const form = await slashForm(page, label, name)
  for (const [k, v] of Object.entries(options)) {
    const pill = form.getByRole('button', { name: `+ ${k}`, exact: true })
    if (await pill.count()) await pill.click()
    await form.getByLabel(new RegExp(`^${k}`)).fill(String(v))
  }
  await form.getByRole('button', { name: 'Send' }).click()
}
// Opens a select menu on a message and picks options by label (several for multi-selects, then Done).
async function choose(page, msg, placeholder, labels) {
  await msg.getByRole('button', { name: placeholder }).click()
  const list = page.getByRole('listbox', { name: placeholder })
  const multi = (await list.getAttribute('aria-multiselectable')) === 'true'
  for (const l of labels) await list.getByRole('option').filter({ hasText: l }).getByRole('button').click()
  if (multi) await page.getByRole('button', { name: 'Done' }).click()
}
const botLines = (bot, key) => bot.lines.filter((l) => l[key] !== undefined).map((l) => l[key])
const png = (w, h) => {
  // a real w x h PNG (RGBA, all one colour) so the browser can draw it
  const crc = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)) } return ~c >>> 0 }
  const chunk = (type, data) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 4, Buffer.from([0x58, 0x65, 0xf2, 0xff]))])
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', require('node:zlib').deflateSync(Buffer.concat(Array(h).fill(row)))), chunk('IEND', Buffer.alloc(0))])
}

const ids = {}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cillcord-e2e5apps-'))
  const browser = await chromium.launch()
  const push = await pushService()
  const hook = await hookBot()
  let bot = null
  const run = (section, fn) => (!SECTIONS || SECTIONS.has(section) ? fn() : undefined)
  try {
    const alice = await newUser(browser, 'Alice')
    const bob = await newUser(browser, 'Bob')
    const carol = await newUser(browser, 'Carol')

    await step(`0. Alice, Bob and Carol register (suffix ${SFX}); Alice creates a server with a Staff role (Bob has it) and #plans; Bob and Carol join; everyone is friends with Alice`, async () => {
      await Promise.all([register(alice, NAME.alice), register(bob, NAME.bob), register(carol, NAME.carol)])
      for (const [k, p] of Object.entries({ alice, bob, carol })) ids[k] = (await api(p, 'GET', '/users/@me')).body.id
      await alice.getByRole('button', { name: 'Add a server' }).click()
      const dialog = modal(alice, 'Add a server')
      await dialog.getByLabel('Server name').first().fill(GUILD)
      await dialog.getByRole('button', { name: 'Create', exact: true }).click()
      await alice.getByRole('heading', { level: 1, name: 'general' }).waitFor()
      ids.guild = new URL(alice.url()).pathname.split('/')[2]
      ids.general = new URL(alice.url()).pathname.split('/')[3]
      const chans = await ok(api(alice, 'GET', `/guilds/${ids.guild}/channels`))
      ids.textCategory = chans.find((c) => c.name === 'Text Channels')?.id
      ids.plans = (await ok(api(alice, 'POST', `/guilds/${ids.guild}/channels`, { name: 'plans', type: 0, parent_id: ids.textCategory }))).id
      ids.staff = (await ok(api(alice, 'POST', `/guilds/${ids.guild}/roles`, { name: 'Staff', color: 0x3498db, mentionable: true }))).id
      ids.invite = (await ok(api(alice, 'POST', `/channels/${ids.general}/invites`, { max_age: 0 }))).code
      for (const p of [bob, carol]) {
        await p.goto(`${BASE}/invite/${ids.invite}`)
        await p.getByRole('button', { name: 'Join' }).click()
        await ready(p)
      }
      await ok(api(alice, 'PATCH', `/guilds/${ids.guild}/members/${ids.bob}`, { roles: [ids.staff] }))
      for (const [k, p] of Object.entries({ bob, carol })) {
        await ok(api(alice, 'PUT', `/users/@me/relationships/${ids[k]}`, {}))
        await ok(api(p, 'PUT', `/users/@me/relationships/${ids.alice}`, {}))
      }
    })

    // ---- 1. A real bot library (v14) ----
    await run('bots', async () => {
      await step('1a. Alice creates an application, installs its bot and starts it with a real bot library (v14); it registers /pick, /menus, /echo, "High Five" and "Quote"', async () => {
        check(BOTLIB && fs.existsSync(BOTLIB), 'bot library (v14) not found (set E2E_BOTLIB to its installed package directory)')
        const app = await ok(api(alice, 'POST', '/applications', { name: `Toolbox ${SFX}` }))
        ids.app = app.id
        await ok(api(alice, 'POST', `/oauth2/authorize?client_id=${app.id}&scope=bot%20applications.commands&permissions=3072`, { authorize: true, guild_id: ids.guild, permissions: '3072' }))
        const file = path.join(tmp, 'bot.cjs')
        fs.writeFileSync(file, BOT)
        bot = spawn(process.execPath, [file, `${BASE}/api`, ids.guild, BASE], { env: { ...process.env, BOTLIB, BOT_TOKEN: app.bot.token }, stdio: ['ignore', 'pipe', 'pipe'] })
        bot.lines = []
        let buf = ''
        bot.stdout.on('data', (d) => { buf += d; for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) try { bot.lines.push(JSON.parse(buf.slice(0, i))) } catch { /* not ours */ } })
        bot.stderr.on('data', (d) => bot.lines.push({ stderr: String(d) }))
        await until('the bot to log in and register its commands', async () => {
          const err = bot.lines.find((l) => l.error)
          if (err) throw new Error(`bot error: ${err.error}`)
          return bot.lines.some((l) => l.ready === ids.app)
        }, 20000)
        for (const p of [alice, bob]) await openChannel(p, 'general')
      })

      await step('1b. autocomplete: typing in /pick\'s game option shows the bot\'s suggestions; picking one runs the command', async () => {
        const form = await slashForm(alice, '#general', 'pick')
        await form.getByLabel(/^game/).fill('val')
        const list = alice.getByRole('listbox', { name: 'Suggestions for game' })
        await list.getByRole('option', { name: 'Valorant' }).waitFor(LIVE)
        check((await list.getByRole('option').count()) === 1, 'only matching suggestions')
        check(botLines(bot, 'autocomplete').includes('val'), `the bot saw the focused value: ${JSON.stringify(botLines(bot, 'autocomplete'))}`)
        await list.getByRole('option', { name: 'Valorant' }).getByRole('button').click()
        check((await form.getByLabel(/^game/).inputValue()) === 'valorant', 'the suggestion fills the value')
        await form.getByRole('button', { name: 'Send' }).click()
        await message(alice, '#general', 'You picked valorant').waitFor(LIVE)
        await message(bob, '#general', 'You picked valorant').waitFor(LIVE)
      })

      await step('1c. select menus: a multi string select, a user, a role and a channel select each reach the bot with their values', async () => {
        await slash(alice, '#general', 'menus')
        const msg = message(alice, '#general', 'Choose:')
        await msg.getByRole('button', { name: 'Pick maps' }).waitFor(LIVE)
        const msgNow = alice.locator(`[id="${await msg.getAttribute('id')}"]`) // the text changes with every answer
        await choose(alice, msgNow, 'Pick maps', ['Ancient', 'Nuke'])
        await msgNow.getByText('maps: ancient,nuke').waitFor(LIVE)
        await choose(alice, msgNow, 'Pick a player', [NAME.bob])
        await msgNow.getByText(`player: ${NAME.bob} (member)`).waitFor(LIVE)
        await choose(alice, msgNow, 'Pick a role', ['@Staff'])
        await msgNow.getByText('role: Staff').waitFor(LIVE)
        await choose(alice, msgNow, 'Pick a channel', ['#plans'])
        await msgNow.getByText('channel: #plans').waitFor(LIVE)
        check(!bot.lines.some((l) => l.error), `bot errors: ${JSON.stringify(bot.lines.filter((l) => l.error))}`)
        await message(bob, '#general', 'channel: #plans').waitFor(LIVE)
      })

      await step('1d. an ATTACHMENT option: Alice picks a PNG for /echo in the command form; the bot reads it and answers with the file', async () => {
        const img = png(24, 16)
        const form = await slashForm(alice, '#general', 'echo')
        await form.getByLabel(/^file/).setInputFiles({ name: 'badge.png', mimeType: 'image/png', buffer: img })
        await form.getByRole('button', { name: '+ note', exact: true }).click()
        await form.getByLabel(/^note/).fill('for Bob')
        await form.getByRole('button', { name: 'Send' }).click()
        const reply = message(alice, '#general', 'echo of badge.png (for Bob)')
        await reply.waitFor(LIVE)
        const seen = botLines(bot, 'echo').at(-1)
        check(seen && seen.name === 'badge.png' && seen.size === img.length && seen.type === 'image/png' && seen.sha === crypto.createHash('sha256').update(img).digest('hex') && seen.note === 'for Bob', `the bot got ${JSON.stringify(seen)}`)
        const shown = message(bob, '#general', 'echo of badge.png').locator('img[src*="echo-badge.png"]')
        await shown.waitFor(LIVE)
        await until('the echoed image to load in Bob\'s browser', () => shown.evaluate((el) => el.complete && el.naturalWidth === 24))
      })

      await step('1e. right-click Apps: "High Five" on Bob in the member list and "Quote" on a message run the bot\'s user and message commands', async () => {
        await members(alice).getByRole('button', { name: new RegExp(NAME.bob) }).first().click({ button: 'right' })
        await alice.getByRole('menuitem', { name: 'High Five' }).click()
        await message(alice, '#general', `${NAME.alice} high-fived ${NAME.bob}`).waitFor(LIVE)
        const line = (await message(alice, '#general', `${NAME.alice} high-fived ${NAME.bob}`).locator('.interaction-line').innerText()).trim()
        check(line.endsWith(`${NAME.alice} used High Five`), `a user command is shown as "${line}"`)
        await send(bob, '#general', `quotable words ${SFX}`)
        const msg = message(alice, '#general', `quotable words ${SFX}`).last()
        await msg.waitFor(LIVE)
        await msg.click({ button: 'right' })
        await alice.getByRole('menu', { name: 'Message actions' }).getByRole('menuitem', { name: 'Quote' }).click()
        await message(alice, '#general', `Quote: quotable words ${SFX}`).waitFor(LIVE)
        await message(alice, '#general', `Quote: quotable words ${SFX}`).getByText(`${NAME.alice} used Quote`).waitFor()
      })

      await step('1f. HTTP interactions: Alice sets the endpoint in the Developer Portal (verified by signed PINGs); /hello is answered inline and /slow deferred then edited', async () => {
        const app = await ok(api(alice, 'POST', '/applications', { name: `Hook ${SFX}` }))
        ids.hookApp = app.id
        hook.key = app.verify_key
        await ok(api(alice, 'POST', `/oauth2/authorize?client_id=${app.id}&scope=bot%20applications.commands&permissions=2048`, { authorize: true, guild_id: ids.guild, permissions: '2048' }))
        for (const c of [{ name: 'hello', description: 'Says hello over HTTP' }, { name: 'slow', description: 'Thinks first' }]) {
          const r = await fetch(`${BASE}/api/v10/applications/${app.id}/guilds/${ids.guild}/commands`, { method: 'POST', headers: { Authorization: `Bot ${app.bot.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(c) })
          check(r.status === 201, `registering /${c.name} answered ${r.status}`)
        }
        await alice.goto(`${BASE}/developers/applications/${app.id}`)
        await alice.getByLabel('Interactions Endpoint URL (optional)').fill(`http://127.0.0.1:${HOOK_PORT}/interactions`)
        await alice.getByRole('button', { name: 'Save Changes' }).click()
        await alice.getByRole('status').filter({ hasText: 'Saved.' }).waitFor(LIVE)
        check(hook.seen.some((i) => i.type === 1) && hook.bad >= 1, `the server sent a signed PING (${hook.seen.length}) and a badly signed one (${hook.bad})`)
        await openChannel(alice, 'general')
        await slash(alice, '#general', 'hello')
        await message(alice, '#general', `Hello from HTTP, ${NAME.alice}`).waitFor(LIVE)
        await slash(alice, '#general', 'slow')
        await log(alice, '#general').getByText(/is thinking/).waitFor(LIVE)
        await message(alice, '#general', 'Done thinking').waitFor(LIVE)
        await message(bob, '#general', 'Done thinking').waitFor(LIVE)
        check((await log(alice, '#general').getByText(/is thinking/).count()) === 0, 'the loading line is replaced')
      })
    })

    // ---- 2. The Cillhub Bot: /reminders, giveaway timing, the scrim ping ----
    await run('cillbot', async () => {
      await step('2a. /reminders: Carol sets three reminders, cancels one and then another from the ephemeral list\'s select', async () => {
        await ok(api(alice, 'PUT', `/guilds/${ids.guild}/cillcord-bot`))
        for (const p of [alice, bob, carol]) await openChannel(p, 'general')
        for (const [when, what] of [['2h', `water plants ${SFX}`], ['3h', `stretch ${SFX}`], ['4h', `call mum ${SFX}`]]) {
          await slash(carol, '#general', 'remind', { when, what })
          await message(carol, '#general', "I'll remind you").nth(['2h', '3h', '4h'].indexOf(when)).waitFor(LIVE)
        }
        await slash(carol, '#general', 'reminders')
        const list = message(carol, '#general', `water plants ${SFX}`).filter({ hasText: 'Only you can see this' })
        await list.waitFor(LIVE)
        check((await message(alice, '#general', `water plants ${SFX}`).count()) === 0, 'Alice sees Carol\'s reminder list')
        const box = carol.locator(`[id="${await list.getAttribute('id')}"]`)
        await choose(carol, box, 'Cancel reminders…', [`water plants ${SFX}`])
        await until('the list to drop the cancelled reminder', async () => !(await box.innerText()).includes(`water plants ${SFX}`) && (await box.innerText()).includes(`stretch ${SFX}`))
        await choose(carol, box, 'Cancel reminders…', [`stretch ${SFX}`])
        await until('only "call mum" to remain', async () => { const t = await box.innerText(); return !t.includes(`stretch ${SFX}`) && t.includes(`call mum ${SFX}`) })
          .catch(async () => { throw new Error(`after the second cancel the list says: ${await box.innerText()} (toasts: ${JSON.stringify(await toasts(carol))})`) })
      })

      await step('2b. giveaway with a 12 s duration: Bob and Carol enter, it ends on its own with a winner; Alice rerolls and the other one wins', async () => {
        await slash(alice, '#general', 'giveaway', { prize: `Mousepad ${SFX}`, duration: '12s' })
        const g = (p) => card(p, '#general', `🎉 Mousepad ${SFX}`)
        for (const p of [bob, carol]) {
          await g(p).waitFor(LIVE)
          await g(p).getByRole('button', { name: 'Enter' }).click()
          await p.getByText('You entered the giveaway', { exact: false }).first().waitFor(LIVE)
        }
        const won = message(alice, '#general', `You won **Mousepad ${SFX}**`).or(message(alice, '#general', `You won Mousepad ${SFX}`))
        await won.first().waitFor({ timeout: 20000 })
        const winnerOf = async (loc) => { const t = await loc.innerText(); return t.includes(NAME.bob) ? 'bob' : t.includes(NAME.carol) ? 'carol' : null }
        const first = await winnerOf(won.first())
        check(first, `the first winner is Bob or Carol: ${await won.first().innerText()}`)
        check(await g(bob).getByRole('button', { name: 'Enter' }).isDisabled(), 'Enter is disabled after the timed end')
        await g(alice).getByRole('button', { name: 'Reroll' }).click()
        await until('a second congratulation', async () => (await won.count()) === 2, 5000)
        const second = await winnerOf(won.nth(1))
        check(second && second !== first, `the reroll picked ${second} after ${first}`)
        await until('the card to name the new winner', async () => (await g(carol).innerText()).includes(second === 'bob' ? NAME.bob : NAME.carol))
      })

      await step('2c. giveaway ended early: only the host may end it; the card says it ended now, not in an hour', async () => {
        await slash(alice, '#general', 'giveaway', { prize: `Headset ${SFX}`, duration: '1h' })
        const g = (p) => card(p, '#general', `🎉 Headset ${SFX}`)
        await g(bob).waitFor(LIVE)
        await g(bob).getByRole('button', { name: 'Enter' }).click()
        await g(bob).getByRole('button', { name: 'End now' }).click()
        await message(bob, '#general', 'Only the host or members with Manage Server can end a giveaway.').waitFor(LIVE)
        await g(alice).getByRole('button', { name: 'End now' }).click()
        await message(alice, '#general', `Congratulations`).filter({ hasText: `Headset ${SFX}` }).waitFor(LIVE)
        await until('the card to say Ended', async () => /Ended/.test(await g(carol).innerText()))
        const text = await g(carol).innerText()
        check(!/in (an hour|60 minutes|59 minutes)/.test(text) && /Ended (just now|now|\d+ seconds? ago|a few seconds ago)/i.test(text), `the ended card says: ${text}`)
      })

      await step('2d. scrim 15 minutes and a few seconds ahead: Bob joins, Carol benches; the 15-minute ping mentions both within seconds', async () => {
        const opponent = `Rivals ${SFX}`
        await slash(alice, '#general', 'scrim', { opponent, when: '15m8s', slots: 2 })
        const s = (p) => card(p, '#general', `Scrim vs ${opponent}`)
        await s(bob).waitFor(LIVE)
        await s(bob).getByRole('button', { name: 'Join' }).click()
        await s(carol).getByRole('button', { name: 'Bench' }).click()
        await until('Bob on the roster and Carol on the bench', async () => /Roster \(1\/2\)[\s\S]*Bench[\s\S]*@Carol_/.test(await s(alice).innerText()))
        const ping = message(bob, '#general', `Scrim vs ${opponent}`).filter({ hasText: '⏰' })
        await ping.waitFor({ timeout: 20000 })
        const text = await ping.innerText()
        check(text.includes(`@${NAME.bob}`) && text.includes(`@${NAME.carol}`) && /in 1[45] minutes/.test(text), `the ping says: ${text}`)
        check(await ping.evaluate((el) => el.classList.contains('mentioned')), 'the ping is highlighted as a mention of Bob')
        const events = await ok(api(bob, 'GET', `/guilds/${ids.guild}/scheduled-events`))
        check(events.some((e) => e.name === `Scrim vs ${opponent}`), 'the scrim has a scheduled event')
      })
    })

    // ---- 3. A reminder delivered as Web Push while the user is idle ----
    await run('push', async () => {
      await step('3. Remind me as Web Push: nothing is pushed while Carol is active; after 2 idle minutes (op 3 afk) the reminder arrives encrypted with VAPID', async () => {
        await ok(api(carol, 'POST', '/users/@me/push-subscriptions', push.subscribe('carol')))
        const vapid = (await ok(api(carol, 'GET', '/push/vapid-public-key'))).public_key
        const m1 = await ok(api(alice, 'POST', `/channels/${ids.general}/messages`, { content: `first reminder ${SFX}` }))
        const m2 = await ok(api(alice, 'POST', `/channels/${ids.general}/messages`, { content: `second reminder ${SFX}` }))
        // Carol's only session is a fresh tab with a controllable clock
        const token = await carol.evaluate(() => localStorage.getItem('token'))
        await carol.goto('about:blank')
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' })
        await ctx.addInitScript((t) => localStorage.setItem('token', t), token)
        const idle = await ctx.newPage()
        watch(idle, 'Carol (idle)')
        try {
          await idle.clock.install()
          await idle.goto(`${BASE}/channels/${ids.guild}/${ids.plans}`)
          await ready(idle)
          const due = (s) => new Date(Date.now() + s * 1000).toISOString()
          await ok(api(idle, 'PUT', `/users/@me/saved-messages/${ids.general}/${m1.id}`, { due_at: due(3) }))
          await sleep(6000)
          check(!push.got.some((g) => g.name === 'carol'), `pushed while active: ${JSON.stringify(push.got)}`)
          await idle.clock.fastForward('02:30') // no input for 2.5 minutes: the client sends op 3 with afk: true
          await sleep(1000)
          await ok(api(idle, 'PUT', `/users/@me/saved-messages/${ids.general}/${m2.id}`, { due_at: due(3) }))
          await until('the reminder push', async () => push.got.some((g) => g.name === 'carol'), 15000)
          const got = push.got.find((g) => g.name === 'carol')
          check(!got.error, `push decrypt: ${got.error}`)
          check(got.headers['content-encoding'] === 'aes128gcm' && Number(got.headers.ttl) > 0, `push headers: ${JSON.stringify(got.headers)}`)
          check(new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${vapid}$`).test(got.headers.authorization ?? ''), `VAPID header: ${got.headers.authorization}`)
          const want = { title: `Reminder: ${NAME.alice}`, body: `second reminder ${SFX}`, url: `/channels/${ids.guild}/${ids.general}/${m2.id}`, tag: `reminder-${m2.id}` }
          check(JSON.stringify(got.payload) === JSON.stringify(want), `push payload ${JSON.stringify(got.payload)}, wanted ${JSON.stringify(want)}`)
          check(push.got.filter((g) => g.name === 'carol').length === 1, 'exactly one push')
        } finally {
          delete pages['Carol (idle)']
          await ctx.close()
        }
        await carol.goto(`${BASE}/channels/${ids.guild}/${ids.general}`)
        await ready(carol)
      })
    })

    // ---- 4. Notification levels (desktop notifications recorded in Bob's browser) ----
    await run('levels', async () => {
      await step('4. notification levels: only @mentions, nothing, all messages; suppress @everyone and suppress role mentions', async () => {
        ids.dmAB = (await ok(api(alice, 'POST', '/users/@me/channels', { recipient_id: ids.bob }))).id
        await openChannel(bob, 'plans')
        const say = (content) => ok(api(alice, 'POST', `/channels/${ids.general}/messages`, { content }))
        let n = 0
        // sends `content` to #general, then a DM (always notifies) as a marker; true if `content` notified Bob
        const notified = async (content) => {
          const marker = `marker ${++n} ${SFX}`
          await say(content)
          await ok(api(alice, 'POST', `/channels/${ids.dmAB}/messages`, { content: marker }))
          await until(`Bob's notification for "${marker}"`, async () => (await notes(bob)).some((x) => x.body === marker))
          return (await notes(bob)).some((x) => x.body?.includes(content.replace(/<@&?\d+>/g, '').trim()))
        }
        const level = async (label, toggles = {}) => {
          await bob.getByRole('button', { name: GUILD, exact: true }).click()
          await bob.getByRole('button', { name: 'Notification Settings' }).click()
          const dlg = modal(bob, 'Notification Settings')
          const radio = dlg.getByRole('radio', { name: label })
          if (!(await radio.isChecked())) {
            const saved = bob.waitForResponse((r) => /\/users\/@me\/guilds\/\d+\/settings$/.test(r.url()) && r.request().method() === 'PATCH')
            await radio.check()
            check((await saved).status() === 200, `saving ${label}`)
          }
          for (const [name, on] of Object.entries(toggles)) {
            const sw = dlg.getByRole('switch', { name }).or(dlg.getByLabel(name)).first()
            if ((await sw.isChecked()) !== on) {
              const r = bob.waitForResponse((x) => /\/users\/@me\/guilds\/\d+\/settings$/.test(x.url()) && x.request().method() === 'PATCH')
              await sw.click()
              check((await r).status() === 200, `saving ${name}`)
            }
          }
          await dlg.getByRole('button', { name: 'Done' }).click()
        }
        await level('Only @mentions')
        check(!(await notified(`plain words ${SFX}`)), 'a plain message notified at "Only @mentions"')
        check(await notified(`<@${ids.bob}> direct ${SFX}`), 'a mention did not notify at "Only @mentions"')
        await level('Nothing')
        check(!(await notified(`<@${ids.bob}> muted mention ${SFX}`)), 'a mention notified at "Nothing"')
        await level('All Messages')
        check(await notified(`everything ${SFX}`), 'a plain message did not notify at "All Messages"')
        await level('Only @mentions', { 'Suppress @everyone and @here': true, 'Suppress All Role @mentions': true })
        check(!(await notified(`@everyone party ${SFX}`)), '@everyone notified while suppressed')
        check(!(await notified(`<@&${ids.staff}> staff meeting ${SFX}`)), 'a role mention notified while suppressed')
        check(await notified(`<@${ids.bob}> still you ${SFX}`), 'a direct mention must still notify with suppressions on')
        await level('Only @mentions', { 'Suppress @everyone and @here': false, 'Suppress All Role @mentions': false })
        check(await notified(`@everyone party two ${SFX}`), '@everyone did not notify without suppression')
        check(await notified(`<@&${ids.staff}> staff meeting two ${SFX}`), 'a role mention did not notify without suppression')
      })
    })

    // ---- 5. The Unreads list ----
    await run('unreads', async () => {
      await step('5. Inbox → Unreads lists unread channels and DMs with mention counts, not muted channels; Mark as Read and Mark All as Read empty it', async () => {
        ids.quiet = (await ok(api(alice, 'POST', `/guilds/${ids.guild}/channels`, { name: 'quiet', type: 0, parent_id: ids.textCategory }))).id
        ids.dmAB ??= (await ok(api(alice, 'POST', '/users/@me/channels', { recipient_id: ids.bob }))).id
        await bob.goto(`${BASE}/channels/@me`)
        await ready(bob)
        await channels(bob).getByRole('link', { name: /^quiet\b/ }).waitFor().catch(() => {}) // the channel list only shows at the server
        await bob.getByRole('button', { name: 'Inbox' }).click()
        let inbox = modal(bob, 'Inbox')
        await inbox.getByRole('tab', { name: 'Unreads' }).click()
        const mark = inbox.getByRole('button', { name: 'Mark All as Read' })
        if (await mark.isEnabled()) await mark.click()
        await inbox.getByText("You're all caught up!").waitFor(LIVE)
        await bob.keyboard.press('Escape')
        // Bob mutes #quiet from its context menu
        await bob.goto(`${BASE}/channels/${ids.guild}/${ids.general}`)
        await ready(bob)
        await channels(bob).getByRole('link', { name: /^quiet\b/ }).click({ button: 'right' })
        const muted = bob.waitForResponse((r) => /\/users\/@me\/guilds\/\d+\/settings$/.test(r.url()) && r.request().method() === 'PATCH')
        await bob.getByRole('menuitem', { name: /Until I turn it back on/i }).click()
        check((await muted).status() === 200, 'muting #quiet')
        await bob.goto(`${BASE}/channels/@me`)
        await ready(bob)
        await ok(api(alice, 'POST', `/channels/${ids.general}/messages`, { content: `unread plain ${SFX}` }))
        await ok(api(alice, 'POST', `/channels/${ids.plans}/messages`, { content: `<@${ids.bob}> unread mention ${SFX}` }))
        await ok(api(alice, 'POST', `/channels/${ids.quiet}/messages`, { content: `muted chatter ${SFX}` }))
        await ok(api(alice, 'POST', `/channels/${ids.dmAB}/messages`, { content: `unread dm ${SFX}` }))
        await sleep(500)
        await bob.getByRole('button', { name: 'Inbox' }).click()
        inbox = modal(bob, 'Inbox')
        await inbox.getByRole('tab', { name: 'Unreads' }).click()
        const list = inbox.getByRole('list', { name: 'Unread channels' })
        await list.getByRole('listitem').nth(2).waitFor(LIVE)
        const rows = (await list.getByRole('listitem').allInnerTexts()).map((x) => x.replace(/\s+/g, ' ').trim())
        check(rows.length === 3, `unread rows: ${JSON.stringify(rows)}`)
        check(rows[0].startsWith(NAME.alice), `newest first, the DM: ${rows[0]}`)
        check(rows.some((r) => r.startsWith(`#plans · ${GUILD} 1`)) && rows.some((r) => r.startsWith(`#general · ${GUILD}`) && !/ 1 /.test(r)), `channel rows: ${JSON.stringify(rows)}`)
        check(!rows.some((r) => r.includes('#quiet')), 'the muted channel is listed')
        await list.getByRole('listitem').filter({ hasText: '#general' }).getByRole('button', { name: 'Mark as Read' }).click()
        await until('#general to leave the list', async () => (await list.getByRole('listitem').count()) === 2)
        await inbox.getByRole('button', { name: 'Mark All as Read' }).click()
        await inbox.getByText("You're all caught up!").waitFor(LIVE)
        await bob.keyboard.press('Escape')
      })
    })

    // ---- 6. Keyboard shortcuts (CONTRACT-v4) ----
    await run('keys', async () => {
      await step('6. shortcuts: Alt+↑/↓ channels, Alt+Shift+↓ next unread, Ctrl+Alt+↑/↓ servers, Esc marks read, Ctrl+/ sheet, Ctrl+E emoji, Ctrl+Shift+U upload, Ctrl+Shift+M/D', async () => {
        await openChannel(bob, 'general')
        const where = () => new URL(bob.url()).pathname
        await bob.keyboard.press('Alt+ArrowDown')
        await until('Alt+↓ to open #plans', async () => where() === `/channels/${ids.guild}/${ids.plans}`)
        await bob.keyboard.press('Alt+ArrowUp')
        await until('Alt+↑ to go back to #general', async () => where() === `/channels/${ids.guild}/${ids.general}`)
        // an unread channel further down: Alt+Shift+↓ jumps to it
        await ok(api(alice, 'POST', `/channels/${ids.plans}/messages`, { content: `jump here ${SFX}` }))
        await channels(bob).locator('a.unread, a[class*="unread"], .channel.unread').first().waitFor({ timeout: 3000 }).catch(() => {})
        await sleep(300)
        await bob.keyboard.press('Alt+Shift+ArrowDown')
        await until('Alt+Shift+↓ to open the unread #plans', async () => where() === `/channels/${ids.guild}/${ids.plans}`)
        await openChannel(bob, 'general')
        // Esc marks the open channel read (Bob's window has no focus, so new messages stay unread until then)
        const m = await ok(api(alice, 'POST', `/channels/${ids.general}/messages`, { content: `esc me ${SFX}` }))
        await message(bob, '#general', `esc me ${SFX}`).waitFor(LIVE)
        const acked = bob.waitForRequest((r) => r.url().includes(`/channels/${ids.general}/messages/${m.id}/ack`), { timeout: 5000 })
        await bob.locator('body').click({ position: { x: 700, y: 300 } }).catch(() => {})
        await bob.keyboard.press('Escape')
        await acked.catch(async () => { throw new Error('Esc did not acknowledge the newest message') })
        // servers: Ctrl+Alt+↓ wraps from the only server to Home, then back to the server's first text channel
        await bob.keyboard.press('Control+Alt+ArrowDown')
        await until('Ctrl+Alt+↓ to go Home', async () => where().startsWith('/channels/@me'))
        await bob.keyboard.press('Control+Alt+ArrowDown')
        await until('Ctrl+Alt+↓ to come back to the server', async () => where() === `/channels/${ids.guild}/${ids.general}`)
        await bob.keyboard.press('Control+Alt+ArrowUp')
        await until('Ctrl+Alt+↑ to go Home again', async () => where().startsWith('/channels/@me'))
        await openChannel(bob, 'general')
        await bob.keyboard.press('Control+/')
        const sheet = modal(bob, 'Keyboard Shortcuts')
        await sheet.waitFor(LIVE)
        check((await sheet.innerText()).includes('Ctrl+Shift+U'), 'the sheet lists the upload shortcut')
        await bob.keyboard.press('Escape')
        await sheet.waitFor({ state: 'detached' })
        await bob.keyboard.press('Control+e')
        await bob.getByRole('searchbox', { name: 'Search emoji' }).or(bob.getByLabel('Search emoji')).first().waitFor(LIVE)
        await bob.keyboard.press('Escape')
        const [chooser] = await Promise.all([bob.waitForEvent('filechooser', { timeout: 5000 }), bob.keyboard.press('Control+Shift+U')])
        check(chooser.isMultiple(), 'the upload chooser takes several files')
        const muteBtn = bob.getByRole('button', { name: 'Mute', exact: true })
        const deafBtn = bob.getByRole('button', { name: 'Deafen', exact: true })
        check((await muteBtn.getAttribute('aria-pressed')) === 'false', 'not muted at the start')
        await bob.keyboard.press('Control+Shift+M')
        await until('Ctrl+Shift+M to mute', async () => (await muteBtn.getAttribute('aria-pressed')) === 'true')
        await bob.keyboard.press('Control+Shift+D')
        await until('Ctrl+Shift+D to deafen', async () => (await deafBtn.getAttribute('aria-pressed')) === 'true')
        await bob.keyboard.press('Control+Shift+D')
        await bob.keyboard.press('Control+Shift+M')
        await until('both toggled back', async () => (await muteBtn.getAttribute('aria-pressed')) === 'false' && (await deafBtn.getAttribute('aria-pressed')) === 'false')
      })
    })

    // ---- 7. Server template sync and delete in Server Settings ----
    await run('templates', async () => {
      await step('7. Server Template: generate, a new channel marks it unsynced, Sync carries it, Delete removes the template', async () => {
        await openChannel(alice, 'general')
        await serverSettings(alice, 'Server Template')
        await alice.getByLabel('Template Title').fill(`Squad layout ${SFX}`)
        await alice.getByRole('button', { name: 'Generate Template' }).click()
        const tcard = alice.getByRole('region', { name: `Template Squad layout ${SFX}` })
        await tcard.waitFor(LIVE)
        const code = (await alice.locator('#template-link').inputValue()).split('/').pop()
        const before = (await ok(api(bob, 'GET', `/guilds/templates/${code}`))).serialized_source_guild.channels.length
        await closeSettings(alice)
        await ok(api(alice, 'POST', `/guilds/${ids.guild}/channels`, { name: `strats-${SFX}`, type: 0 }))
        await serverSettings(alice, 'Server Template')
        await tcard.getByText('This template has unsynced changes.').waitFor(LIVE)
        await tcard.getByRole('button', { name: 'Sync Template' }).click()
        await tcard.getByText('This template has unsynced changes.').waitFor({ state: 'detached', ...LIVE })
        const synced = await ok(api(bob, 'GET', `/guilds/templates/${code}`))
        check(synced.serialized_source_guild.channels.length === before + 1 && synced.serialized_source_guild.channels.some((c) => c.name === `strats-${SFX}`), `synced template channels: ${synced.serialized_source_guild.channels.map((c) => c.name)}`)
        await tcard.getByRole('button', { name: 'Delete Template' }).click()
        await modal(alice, 'Delete Template').getByRole('button', { name: 'Delete' }).click()
        await alice.getByRole('button', { name: 'Generate Template' }).waitFor(LIVE)
        check((await api(bob, 'GET', `/guilds/templates/${code}`)).status === 404, 'the deleted template still answers')
        await closeSettings(alice)
      })
    })

    // ---- 8. Username and email change ----
    await run('account', async () => {
      await step('8. My Account: Carol changes her username (wrong password refused) and her email; others see the new name live, the new email logs in', async () => {
        await openChannel(alice, 'general')
        await userSettings(carol, 'My Account')
        await carol.getByRole('button', { name: 'Edit' }).first().click()
        let dlg = modal(carol, 'Change your username')
        const fresh = `Caro_${SFX}`
        await dlg.getByLabel('Username').fill(fresh)
        await dlg.getByLabel('Current Password').fill('wrong password')
        await dlg.getByRole('button', { name: 'Done' }).click()
        await dlg.getByText(/password/i).filter({ hasNotText: 'Current Password' }).first().waitFor(LIVE)
        await dlg.getByLabel('Current Password').fill(PASSWORD)
        await dlg.getByRole('button', { name: 'Done' }).click()
        await dlg.waitFor({ state: 'detached' })
        check((await ok(api(carol, 'GET', '/users/@me'))).username === fresh, 'the username was not saved')
        await members(alice).getByRole('button', { name: new RegExp(fresh) }).first().waitFor(LIVE)
        NAME.carol = fresh
        await carol.getByRole('button', { name: 'Edit' }).nth(1).click()
        dlg = modal(carol, 'Change your email address')
        const email = `carol.new.${SFX}@example.com`
        await dlg.getByLabel('Email').fill(email)
        await dlg.getByLabel('Current Password').fill(PASSWORD)
        await dlg.getByRole('button', { name: 'Done' }).click()
        await dlg.waitFor({ state: 'detached' })
        await carol.getByText(email).first().waitFor(LIVE)
        check((await ok(api(carol, 'GET', '/users/@me'))).email === email, 'the email was not saved')
        const login = await carol.evaluate(async (b) => (await fetch('/api/v9/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).status, { login: email, password: PASSWORD })
        check(login === 200, `login with the new email answered ${login}`)
        await closeSettings(carol)
      })

      await step('9. account deletion: Erin owns a server, so Delete Account is refused (UI and API); after Transfer Ownership to Bob she deletes her account', async () => {
        const erin = await newUser(browser, 'Erin')
        await register(erin, NAME.erin)
        ids.erin = (await ok(api(erin, 'GET', '/users/@me'))).id
        const g = await ok(api(erin, 'POST', '/guilds', { name: `Erin's place ${SFX}` }))
        ids.erinGuild = g.id
        ids.erinGeneral = g.channels.find((c) => c.name === 'general').id
        const inv = await ok(api(erin, 'POST', `/channels/${ids.erinGeneral}/invites`, { max_age: 0 }))
        await ok(api(bob, 'POST', `/invites/${inv.code}`))
        await ok(api(erin, 'POST', `/channels/${ids.erinGeneral}/messages`, { content: `bye all ${SFX}` }))
        await userSettings(erin, 'My Account')
        await erin.getByRole('note').filter({ hasText: 'You own 1 servers' }).waitFor(LIVE)
        check(await erin.getByRole('button', { name: 'Delete Account' }).isDisabled(), 'Delete Account is enabled while Erin owns a server')
        const refused = await api(erin, 'POST', '/users/@me/delete', { password: PASSWORD })
        check(refused.status === 400 && refused.body?.code === 40011, `the API answered ${refused.status} ${JSON.stringify(refused.body)}`)
        await closeSettings(erin)
        await erin.goto(`${BASE}/channels/${ids.erinGuild}/${ids.erinGeneral}`)
        await ready(erin)
        await members(erin).getByRole('button', { name: new RegExp(NAME.bob) }).first().click({ button: 'right' })
        await erin.getByRole('menuitem', { name: 'Transfer Ownership' }).click()
        await modal(erin, 'Transfer Ownership').getByRole('button', { name: 'Transfer Ownership' }).click()
        await until('Bob to own the server', async () => (await api(bob, 'GET', `/guilds/${ids.erinGuild}`)).body?.owner_id === ids.bob)
        await userSettings(erin, 'My Account')
        await until('Delete Account to be enabled', () => erin.getByRole('button', { name: 'Delete Account' }).isEnabled())
        await erin.getByRole('button', { name: 'Delete Account' }).click()
        const dlg = modal(erin, 'Delete Account')
        await dlg.getByLabel('Password').fill(PASSWORD)
        await dlg.getByRole('button', { name: 'Delete Account' }).click()
        await erin.getByRole('heading', { name: 'Ready up' }).waitFor(LIVE)
        await bob.goto(`${BASE}/channels/${ids.erinGuild}/${ids.erinGeneral}`)
        await ready(bob)
        const bye = log(bob, '#general').locator('li.msg').filter({ hasText: `bye all ${SFX}` })
        await bye.waitFor(LIVE)
        check((await bye.innerText()).includes('Deleted User'), `Erin's message is shown as: ${await bye.innerText()}`)
        const again = await erin.evaluate(async (b) => (await fetch('/api/v9/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).status, { login: NAME.erin, password: PASSWORD })
        check(again >= 400, `Erin can still log in (${again})`)
        delete pages.Erin
        await erin.context().close()
      })
    })

    // ---- 10. Group DM icon and owner transfer ----
    await run('groups', async () => {
      await step('10. group DM: Alice changes the icon from the DM list menu, makes Bob the owner; only the owner may transfer', async () => {
        const group = await ok(api(alice, 'POST', '/users/@me/channels', { recipients: [ids.bob, ids.carol] }))
        ids.group = group.id
        for (const p of [alice, bob, carol]) { await p.goto(`${BASE}/channels/@me/${group.id}`); await ready(p) }
        const row = dmList(alice).getByRole('link').filter({ hasText: NAME.bob }).filter({ hasText: NAME.carol }).first()
        await row.click({ button: 'right' })
        const [chooser] = await Promise.all([alice.waitForEvent('filechooser'), alice.getByRole('menuitem', { name: 'Change Icon' }).click()])
        await chooser.setFiles({ name: 'group.png', mimeType: 'image/png', buffer: png(32, 32) })
        await until('the icon on the channel', async () => !!(await api(bob, 'GET', `/channels/${group.id}`)).body?.icon)
        const icon = dmList(bob).locator(`img[src*="/channel-icons/${group.id}/"]`).first()
        await icon.waitFor(LIVE)
        await until('the icon to load for Bob', () => icon.evaluate((el) => el.complete && el.naturalWidth > 0))
        const groupMembers = (p) => p.getByRole('complementary', { name: 'Members' })
        await groupMembers(carol).getByRole('button', { name: new RegExp(NAME.bob) }).click({ button: 'right' })
        check((await carol.getByRole('menuitem', { name: 'Make Group Owner' }).count()) === 0, 'a member who is not the owner can transfer')
        await carol.keyboard.press('Escape')
        await groupMembers(alice).getByRole('button', { name: new RegExp(NAME.bob) }).click({ button: 'right' })
        await alice.getByRole('menuitem', { name: 'Make Group Owner' }).click()
        await groupMembers(carol).getByRole('button', { name: new RegExp(NAME.bob) }).getByRole('img', { name: 'Group Owner' }).waitFor(LIVE)
        check((await groupMembers(carol).getByRole('button', { name: new RegExp(NAME.alice) }).getByRole('img', { name: 'Group Owner' }).count()) === 0, 'Alice still has the crown')
        check((await ok(api(carol, 'GET', `/channels/${group.id}`))).owner_id === ids.bob, 'owner_id is not Bob')
      })
    })

    // ---- 11. Server profiles ----
    await run('profiles', async () => {
      await step('11. server profile: Bob sets a nickname, avatar and About Me for the server; Alice sees them there, the DM keeps his global name', async () => {
        await openChannel(bob, 'general')
        await userSettings(bob, 'Profiles')
        await bob.getByRole('tab', { name: 'Server Profiles' }).click()
        await bob.getByLabel('Choose a server').selectOption(ids.guild)
        const nick = `Bobby ${SFX}`
        await bob.getByLabel('Server Nickname').fill(nick)
        await bob.getByLabel('Change Server Avatar').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: png(64, 64) })
        await bob.getByLabel('Server About Me').fill(`Entry fragger ${SFX}`)
        await bob.getByRole('button', { name: 'Save Changes' }).click()
        await bob.getByRole('status').filter({ hasText: 'Saved.' }).waitFor(LIVE)
        await closeSettings(bob)
        await openChannel(alice, 'general')
        await members(alice).getByRole('button', { name: new RegExp(nick) }).waitFor(LIVE)
        await send(bob, '#general', `with my server face ${SFX}`)
        const msg = message(alice, '#general', `with my server face ${SFX}`)
        await msg.waitFor(LIVE)
        check((await msg.innerText()).includes(nick), 'the message author shows the server nickname')
        await msg.locator(`img[src*="/guilds/${ids.guild}/users/${ids.bob}/avatars/"]`).first().waitFor(LIVE)
        const prof = await ok(api(alice, 'GET', `/users/${ids.bob}/profile?guild_id=${ids.guild}`))
        check((prof.guild_member_profile?.bio ?? prof.guild_member?.bio) === `Entry fragger ${SFX}`, `server bio: ${JSON.stringify(prof.guild_member_profile ?? prof.guild_member)}`)
        check(!(prof.user_profile?.bio ?? '').includes('Entry fragger'), 'the global bio changed too')
        ids.dmAB ??= (await ok(api(alice, 'POST', '/users/@me/channels', { recipient_id: ids.bob }))).id
        await alice.goto(`${BASE}/channels/@me/${ids.dmAB}`)
        await ready(alice)
        await dmList(alice).getByRole('link').filter({ hasText: NAME.bob }).first().waitFor(LIVE)
        check((await dmList(alice).getByText(nick).count()) === 0, 'the DM list uses the server nickname')
      })
    })

    // ---- 12. A blocked user joins ----
    await run('blocked', async () => {
      await step('12. a blocked user\'s join line: it collapses to "Blocked message" the moment Bob blocks Dave, and a later join arrives collapsed (Alice sees the welcome)', async () => {
        const dave = await newUser(browser, 'Dave')
        await register(dave, NAME.dave)
        ids.dave = (await ok(api(dave, 'GET', '/users/@me'))).id
        for (const p of [alice, bob]) await openChannel(p, 'general')
        const joins = (p) => log(p, '#general').locator('li.msg.system, li.msg.blocked')
        const daveLines = (p) => log(p, '#general').locator('li.msg').filter({ hasText: NAME.dave })
        await ok(api(dave, 'POST', `/invites/${ids.invite}`))
        await daveLines(bob).first().waitFor(LIVE)
        const before = await joins(bob).count()
        await ok(api(bob, 'PUT', `/users/@me/relationships/${ids.dave}`, { type: 2 }))
        await until('the welcome line to collapse at once', async () => (await daveLines(bob).count()) === 0 && (await joins(bob).count()) === before, 3000)
          .catch(async () => { throw new Error(`Bob's lines: ${JSON.stringify(await log(bob, '#general').locator('li.msg').allInnerTexts())}`) })
        check(/Blocked message/.test(await joins(bob).last().innerText()), 'the join line says "Blocked message"')
        await ok(api(dave, 'DELETE', `/users/@me/guilds/${ids.guild}`))
        await ok(api(dave, 'POST', `/invites/${ids.invite}`))
        await until('Alice to see the second welcome', async () => (await daveLines(alice).count()) === 2)
        await until('Bob to get the second join collapsed', async () => (await joins(bob).count()) === before + 1 && (await daveLines(bob).count()) === 0, 3000)
          .catch(async () => { throw new Error(`Bob's lines: ${JSON.stringify(await log(bob, '#general').locator('li.msg').allInnerTexts())}`) })
        delete pages.Dave
        await dave.context().close()
      })
    })

    await step('99. no uncaught page errors and no native dialogs', async () => {
      if (errors.length) throw new Error(errors.join('; '))
    })
  } catch {
    // step() already reported it; later steps depend on earlier ones
  } finally {
    if (bot) bot.kill()
    push.server.close()
    hook.server.close()
    await browser.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  console.log(`${results.filter(Boolean).length}/${results.length} steps passed`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
