// End-to-end check of the v4 features (personal features, account security, bots) with Alice, Bob and Carol in real
// browsers against a running server that serves client/dist and has LiveKit configured, plus a bot on a real bot library (v14).
// Run: NODE_PATH=<dir with playwright> E2E_BASE_URL=http://127.0.0.1:3300 node scripts/e2e-v4.cjs
// Usernames get a random suffix, so any database works (use a throwaway instance). E2E_SCREENSHOTS=1 also writes
// docs/screenshots/v4-*.png; E2E_FAIL_SHOTS=<dir> saves every page when a step fails. E2E_BOTLIB is the
// installed package directory of the v14 bot library; the bot runs as a child process.
// The login rate-limit step sends a made-up X-Forwarded-For (trusted from loopback), so 127.0.0.1 itself is never locked out.
const { chromium } = require('playwright')
const { createHmac } = require('node:crypto')
const { spawn } = require('node:child_process')
const path = require('node:path')
const zlib = require('node:zlib')
const fs = require('node:fs')
const os = require('node:os')

const BASE = (process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3300').replace(/\/$/, '')
const SHOTS = process.env.E2E_SCREENSHOTS ? path.join(__dirname, '..', 'docs', 'screenshots') : null
const BOTLIB = process.env.E2E_BOTLIB ?? ''
const LIVE = { timeout: 5000 } // live updates must arrive within 5 s, without reload
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const SFX = Math.random().toString(36).slice(2, 7)
const NAME = { alice: `Alice_${SFX}`, bob: `Bob_${SFX}`, carol: `Carol_${SFX}` }
const PASSWORD = 'correct horse battery'
const GUILD = `Squad HQ ${SFX}`
const GUILD2 = `Scrims ${SFX}`

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
// Self-check against RFC 6238's SHA-1 test vector (secret "12345678901234567890", T = 59 s → 287082).
check(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59000) === '287082', 'TOTP helper does not match the RFC 6238 test vector')

function png(w, h) {
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
    for (let x = 0; x < w; x++) raw.set([(x * 255) / w, 80, (y * 255) / h], y * (w * 3 + 1) + 1 + x * 3)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

// Mono 48 kHz "speech": 140 Hz voiced harmonics in 450 ms syllables with 100 ms gaps. Chromium loops it.
function speechWav(sec = 6, rate = 48000) {
  const data = Buffer.alloc(sec * rate * 2)
  for (let i = 0; i < sec * rate; i++) {
    const t = i / rate
    const ph = t % 0.55
    const env = ph < 0.45 ? Math.min(1, ph / 0.03, (0.45 - ph) / 0.03) : 0
    const f = 140 + 20 * Math.sin(2 * Math.PI * 3 * t)
    let v = 0
    for (let h = 1; h <= 8; h++) v += Math.sin(2 * Math.PI * f * h * t) / h
    data.writeInt16LE(Math.round(env * v * 0.15 * 32767), i * 2)
  }
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28)
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}

// The bot: the unmodified v14 bot library pointed at Cillhub. Prints one JSON line per event for the test to follow.
const BOT = `
const { Client, GatewayIntentBits, Events, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } = require(process.env.BOTLIB)
const [api, guildId] = process.argv.slice(2)
const out = (o) => console.log(JSON.stringify(o))
const client = new Client({ intents: [GatewayIntentBits.Guilds], rest: { api } })
client.once(Events.ClientReady, async () => {
  await client.guilds.cache.get(guildId).commands.set([
    { name: 'ping', description: 'Replies with pong' },
    { name: 'secret', description: 'Answers only you' },
    { name: 'feedback', description: 'Opens a feedback form' },
  ])
  out({ ready: client.user.id })
})
client.on(Events.InteractionCreate, async (i) => {
  try {
    if (i.isChatInputCommand() && i.commandName === 'ping') {
      const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('again').setLabel('Again').setStyle(ButtonStyle.Primary))
      await i.reply({ content: 'Pong!', components: [row] })
    } else if (i.isChatInputCommand() && i.commandName === 'secret') {
      await i.reply({ content: 'Psst, only you can read this', flags: MessageFlags.Ephemeral })
    } else if (i.isChatInputCommand() && i.commandName === 'feedback') {
      const input = new TextInputBuilder().setCustomId('text').setLabel('Your feedback').setStyle(TextInputStyle.Paragraph)
      await i.showModal(new ModalBuilder().setCustomId('fb').setTitle('Feedback').addComponents(new ActionRowBuilder().addComponents(input)))
    } else if (i.isButton() && i.customId === 'again') {
      await i.update({ content: 'Clicked by ' + i.user.username, components: [] })
    } else if (i.isModalSubmit() && i.customId === 'fb') {
      await i.reply({ content: 'Thanks for the feedback: ' + i.fields.getTextInputValue('text') })
    }
    out({ handled: i.type })
  } catch (e) { out({ error: String(e && e.message) }) }
})
client.on(Events.Error, (e) => out({ error: String(e && e.message) }))
client.login(process.env.BOT_TOKEN).catch((e) => out({ error: String(e && e.message) }))
`

function watch(page, name) {
  pages[name] = page
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`))
  page.on('dialog', (d) => (errors.push(`${name}: unexpected native dialog "${d.message()}"`), d.dismiss()))
}

async function newContext(browser, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, permissions: ['microphone', 'camera'], serviceWorkers: 'block', ...opts })
  return ctx
}
async function newUser(browser, name, opts) {
  const page = await (await newContext(browser, opts)).newPage()
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
  await page.getByLabel(/I am at least/).check() // 7.10.3 sign-up check
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

const log = (page, label) => page.getByRole('log', { name: `Messages in ${label}` })
const anyMessage = (scope, text) => scope.locator('li.msg').filter({ hasText: text })
const rail = (page) => page.getByRole('navigation', { name: /^(Servers|Server)$/ })
const railGuild = (page, guild = GUILD) => rail(page).getByRole('link', { name: new RegExp(`^${guild}`) })
const composer = (scope, label) => scope.getByRole('textbox', { name: `Message ${label}` })
const dmList = (page) => page.getByRole('navigation', { name: 'Direct messages' })
const members = (page) => page.getByRole('complementary', { name: 'Members' })
const modal = (page, name) => page.getByRole('dialog', { name })
const callPanel = (page) => page.getByRole('region', { name: 'Call' })
const liveRemoteAudio = (page) =>
  page.evaluate(() => [...document.querySelectorAll('#voice-audio audio')].filter((a) => a.srcObject?.getAudioTracks().some((t) => t.readyState === 'live')).length)

async function send(scope, label, text) {
  const box = composer(scope, label)
  await box.fill(text)
  await box.press('Enter')
}
async function userSettings(page, tab) {
  await page.getByRole('button', { name: 'User Settings' }).click()
  await page.getByRole('tab', { name: tab, exact: true }).click()
}
const closeSettings = (page) => page.getByRole('button', { name: 'Close settings' }).click()
const shot = async (page, name) => {
  if (!SHOTS) return
  await page.mouse.move(0, 0)
  await until('toasts to clear before the screenshot', async () => (await page.locator('.toast').count()) === 0, 10000).catch(() => {})
  await sleep(500)
  await page.screenshot({ path: path.join(SHOTS, `v4-${name}.png`) })
}
// Runs a slash command from the composer's command picker.
async function slash(page, label, name) {
  const box = composer(page, label)
  await box.fill(`/${name}`)
  await page.getByRole('listbox', { name: 'Commands' }).getByRole('option', { name: new RegExp(`^/${name}\\b`) }).waitFor(LIVE)
  await box.press('Enter')
  const form = page.getByRole('group', { name: `Command /${name}` })
  if (await form.count()) await form.getByRole('button', { name: 'Send' }).click()
  else await box.press('Enter')
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cillcord-e2e4-'))
  const wav = path.join(tmp, 'speech.wav')
  fs.writeFileSync(wav, speechWav())
  const banner = path.join(tmp, 'banner.png')
  fs.writeFileSync(banner, png(600, 240))
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`] })
  let bot = null
  // Push needs a persistent (non-incognito) profile in full Chromium (the headless shell has no push service). It is
  // started now because a subscribe right after launch hangs while the browser registers with its push service (FCM,
  // so step 15 needs internet access).
  const pushProfile = chromium.launchPersistentContext(fs.mkdtempSync(path.join(tmp, 'push-profile-')), { channel: 'chromium', viewport: { width: 1440, height: 900 }, permissions: ['notifications'] })
  try {
    const alice = await newUser(browser, 'Alice')
    const bob = await newUser(browser, 'Bob')
    const carol = await newUser(browser, 'Carol')
    const ids = {}
    let alice2

    await step(`0. Alice, Bob and Carol register (suffix ${SFX}); Alice creates a server, Bob and Carol join; Alice is friends with both`, async () => {
      await Promise.all([register(alice, NAME.alice), register(bob, NAME.bob), register(carol, NAME.carol)])
      for (const [k, p] of Object.entries({ alice, bob, carol })) ids[k] = (await api(p, 'GET', '/users/@me')).body.id
      await alice.getByRole('button', { name: 'Add a server' }).click()
      const dialog = modal(alice, 'Add a server')
      await dialog.getByLabel('Server name').fill(GUILD)
      await dialog.getByRole('button', { name: 'Create', exact: true }).click()
      await alice.getByRole('heading', { level: 1, name: 'general' }).waitFor()
      ids.guild = new URL(alice.url()).pathname.split('/')[2]
      ids.general = new URL(alice.url()).pathname.split('/')[3]
      const invite = await ok(api(alice, 'POST', `/channels/${ids.general}/invites`, { max_age: 0 }))
      for (const p of [bob, carol]) {
        await p.goto(`${BASE}/invite/${invite.code}`)
        await p.getByRole('button', { name: 'Join' }).click()
        await ready(p)
      }
      for (const [p, who] of [[bob, 'bob'], [carol, 'carol']]) {
        await ok(api(p, 'POST', '/users/@me/relationships', { username: NAME.alice }))
        await ok(api(alice, 'PUT', `/users/@me/relationships/${ids[who]}`, {}))
      }
    })

    // ---- 1. Group DMs ----
    await step('1a. Alice creates a group DM with Bob and Carol from "Create DM"; both see it live', async () => {
      for (const p of [alice, bob, carol]) {
        await p.goto(`${BASE}/channels/@me`)
        await ready(p)
      }
      await alice.getByRole('button', { name: 'Create DM' }).click()
      const pick = modal(alice, 'Select Friends')
      await pick.getByRole('listitem').filter({ hasText: NAME.bob }).getByRole('checkbox').check()
      await pick.getByRole('listitem').filter({ hasText: NAME.carol }).getByRole('checkbox').check()
      await pick.getByRole('button', { name: 'Create Group DM' }).click()
      await alice.waitForURL(/\/channels\/@me\/\d+$/)
      ids.group = new URL(alice.url()).pathname.split('/')[3]
      await members(alice).getByText(NAME.carol).waitFor()
      for (const p of [bob, carol]) await dmList(p).getByRole('link', { name: new RegExp(`${NAME.alice}`) }).filter({ hasText: '3 Members' }).waitFor(LIVE)
    })

    await step('1b. Bob renames the group in the header; Alice and Carol see the new name live', async () => {
      await dmList(bob).getByRole('link').filter({ hasText: '3 Members' }).click()
      await bob.getByRole('button', { name: /edit group name$/ }).click()
      await bob.getByRole('textbox', { name: 'Group name' }).fill(`Squad ${SFX}`)
      await bob.getByRole('textbox', { name: 'Group name' }).press('Enter')
      await bob.getByRole('button', { name: `Squad ${SFX}, edit group name` }).waitFor()
      await alice.getByRole('button', { name: `Squad ${SFX}, edit group name` }).waitFor(LIVE)
      await dmList(carol).getByRole('link', { name: new RegExp(`Squad ${SFX}`) }).waitFor(LIVE)
    })

    await step('1c. Carol leaves the group (Leave Group); Alice adds her back with "Add Friends to DM"', async () => {
      await dmList(carol).getByRole('link', { name: new RegExp(`Squad ${SFX}`) }).click({ button: 'right' })
      await carol.getByRole('menuitem', { name: 'Leave Group' }).click()
      await modal(carol, `Leave 'Squad ${SFX}'`).getByRole('button', { name: 'Leave Group' }).click()
      await dmList(carol).getByRole('link', { name: new RegExp(`Squad ${SFX}`) }).waitFor({ state: 'detached', ...LIVE })
      await members(alice).getByText('Members — 2').waitFor(LIVE)
      await alice.getByRole('button', { name: 'Add Friends to DM' }).click()
      const pick = modal(alice, 'Select Friends')
      await pick.getByRole('listitem').filter({ hasText: NAME.carol }).getByRole('checkbox').check()
      await pick.getByRole('button', { name: 'Add', exact: true }).click()
      await members(alice).getByText('Members — 3').waitFor(LIVE)
      await dmList(carol).getByRole('link', { name: new RegExp(`Squad ${SFX}`) }).waitFor(LIVE)
      const ch = await ok(api(carol, 'GET', `/channels/${ids.group}`))
      check(ch.recipients.length === 2 && ch.owner_id === ids.alice, `group as Carol sees it: ${ch.recipients.length} other recipients, owner ${ch.owner_id}`)
    })

    // ---- 2. DM call with ringing ----
    await step('2a. Alice starts a call in her DM with Bob; Bob sees the incoming call and accepts', async () => {
      const dm = await ok(api(alice, 'POST', '/users/@me/channels', { recipients: [ids.bob] }))
      ids.dm = dm.id
      await alice.goto(`${BASE}/channels/@me/${dm.id}`)
      await ready(alice)
      await alice.getByRole('button', { name: 'Start Voice Call' }).click()
      const ring = bob.getByRole('alertdialog', { name: NAME.alice })
      await ring.getByText('Incoming Call…').waitFor({ timeout: 10000 })
      await callPanel(alice).getByText('Calling…').waitFor(LIVE)
      await ring.getByRole('button', { name: 'Accept' }).click()
      await bob.waitForURL(`**/channels/@me/${dm.id}`)
      for (const p of [alice, bob]) for (const n of [NAME.alice, NAME.bob]) await callPanel(p).getByRole('list', { name: 'Participants' }).getByText(n).waitFor({ timeout: 10000 })
      check((await ring.count()) === 0, 'the incoming call popup is still shown after Accept')
    })

    await step('2b. both have a live remote audio track from the other (real LiveKit)', async () => {
      for (const [n, p] of [['Alice', alice], ['Bob', bob]]) await until(`${n} to have a live remote <audio>`, async () => (await liveRemoteAudio(p)) >= 1, 15000)
    })

    await step("2c. Alice turns on the camera; Bob's call tile plays her video", async () => {
      await callPanel(alice).getByRole('button', { name: 'Camera', exact: true }).click()
      const tile = callPanel(bob).getByRole('list', { name: 'Participants' }).getByRole('listitem').filter({ hasText: NAME.alice })
      await until("a playing <video> in Alice's call tile for Bob", () => tile.locator('video').evaluate((v) => v.videoWidth > 0 && !v.paused), 15000)
      await shot(bob, 'call')
      await callPanel(alice).getByRole('button', { name: 'Camera', exact: true }).click()
      await until("Alice's video to leave Bob's call tile", async () => (await tile.locator('video').count()) === 0, 10000)
    })

    await step('2d. hanging up: Alice leaves, Bob sees her go; Bob leaves and the call ends for both', async () => {
      await callPanel(alice).getByRole('button', { name: 'Leave Call' }).click()
      await callPanel(bob).getByRole('list', { name: 'Participants' }).getByRole('listitem').filter({ hasText: NAME.alice }).getByRole('button', { name: 'Ring' }).waitFor(LIVE)
      await callPanel(bob).getByRole('button', { name: 'Leave Call' }).click()
      for (const p of [alice, bob]) await callPanel(p).waitFor({ state: 'detached', ...LIVE })
      await bob.getByRole('region', { name: 'Voice connection' }).waitFor({ state: 'detached', ...LIVE })
      await log(bob, `@${NAME.alice}`).getByText(new RegExp(`${NAME.alice} started a call that lasted (a minute|\\d+ minutes)\\.`)).waitFor(LIVE)
    })

    // ---- 3. Blocking ----
    await step('3a. Carol blocks Bob from his profile; his messages collapse to "Blocked message" for her', async () => {
      await carol.goto(`${BASE}/channels/${ids.guild}/${ids.general}`)
      await ready(carol)
      await members(carol).getByRole('button', { name: new RegExp(NAME.bob) }).click()
      await carol.getByRole('button', { name: 'More', exact: true }).click()
      await carol.getByRole('menuitem', { name: 'Block' }).click()
      await modal(carol, `Block ${NAME.bob}?`).getByRole('button', { name: 'Block' }).click()
      await until('the block to be stored', async () => (await api(carol, 'GET', '/users/@me/relationships')).body.some((r) => r.id === ids.bob && r.type === 2))
      const pop = carol.getByRole('dialog', { name: `${NAME.bob} profile` })
      if (await pop.count()) await carol.keyboard.press('Escape') // close the profile popout
      await pop.waitFor({ state: 'detached' })
      await bob.goto(`${BASE}/channels/${ids.guild}/${ids.general}`)
      await ready(bob)
      await send(bob, '#general', `can anyone hear me ${SFX}`)
      const l = log(carol, '#general')
      let sent
      await until("Bob's message to be stored", async () => (sent = (await api(bob, 'GET', `/channels/${ids.general}/messages?limit=1`)).body[0])?.content === `can anyone hear me ${SFX}`)
      const mine = l.locator(`#msg-${sent.id}`)
      await mine.getByText('Blocked message').waitFor(LIVE)
      check((await l.getByText(`can anyone hear me ${SFX}`).count()) === 0, "Bob's message is readable for Carol without revealing it")
      // The list may still be scrolling to the new message, so click until it opens.
      await until('"Show message" to reveal it', async () => {
        if (await mine.getByRole('button', { name: 'Show message' }).count()) await mine.getByRole('button', { name: 'Show message' }).click()
        return (await l.getByText(`can anyone hear me ${SFX}`).count()) === 1
      })
    })

    await step('3b. Bob cannot open a DM with Carol (403 50007) or ring her: his group call rings Alice only', async () => {
      const dm = await api(bob, 'POST', '/users/@me/channels', { recipients: [ids.carol] })
      check(dm.status === 403 && dm.body?.code === 50007, `opening a DM with the blocker answered ${dm.status} ${JSON.stringify(dm.body)}`)
      await members(bob).getByRole('button', { name: new RegExp(NAME.carol) }).click()
      await bob.getByRole('dialog', { name: `${NAME.carol} profile` }).getByRole('button', { name: 'Message' }).click()
      await bob.locator('.toast').first().waitFor(LIVE)
      check(!/\/channels\/@me\/\d+$/.test(bob.url()), `Bob ended up in a DM: ${bob.url()}`)
      await bob.goto(`${BASE}/channels/@me/${ids.group}`)
      await ready(bob)
      await bob.getByRole('button', { name: 'Start Voice Call' }).click()
      await alice.getByRole('alertdialog').getByText('Incoming Call…').waitFor({ timeout: 10000 })
      await sleep(1500)
      check((await carol.getByRole('alertdialog').count()) === 0, 'Carol (who blocked Bob) is rung')
      const call = await ok(api(bob, 'GET', `/channels/${ids.group}/call`))
      check(call.ringable !== undefined, `GET /call answered ${JSON.stringify(call)}`)
      await alice.getByRole('alertdialog').getByRole('button', { name: 'Decline' }).click()
      await callPanel(bob).getByRole('button', { name: 'Leave Call' }).click()
      await callPanel(bob).waitFor({ state: 'detached', ...LIVE })
    })

    // ---- 4. Profiles and notes ----
    await step('4. Bob sets pronouns, banner and About Me; Alice sees them in his profile modal and keeps a private note', async () => {
      await userSettings(bob, 'Profiles')
      await bob.getByLabel('Pronouns').fill('he/him')
      await bob.getByLabel('Change Banner').setInputFiles(banner)
      await bob.getByLabel('About Me').fill(`Entry fragger. **IGL** on Sundays ${SFX}`)
      await bob.getByRole('button', { name: 'Save Changes' }).click()
      await bob.getByRole('status').filter({ hasText: 'Saved.' }).waitFor()
      await closeSettings(bob)
      await alice.goto(`${BASE}/channels/${ids.guild}/${ids.general}`)
      await ready(alice)
      await members(alice).getByRole('button', { name: new RegExp(NAME.bob) }).click({ button: 'right' })
      await alice.getByRole('menuitem', { name: 'Profile' }).click()
      const profile = modal(alice, NAME.bob)
      await profile.getByText('he/him').waitFor()
      await profile.getByText(`on Sundays ${SFX}`).waitFor()
      await profile.locator('strong', { hasText: 'IGL' }).waitFor()
      check(/\/banners\/\d+\/\w+/.test(await profile.locator('.pcard-banner').getAttribute('style')), 'the profile banner is not the uploaded image')
      await profile.getByRole('textbox', { name: 'Note' }).fill(`Plays AWP ${SFX}`)
      await profile.getByRole('textbox', { name: 'Note' }).blur()
      await until('the note to be saved', async () => (await api(alice, 'GET', `/users/@me/notes/${ids.bob}`)).body?.note === `Plays AWP ${SFX}`)
      await shot(alice, 'profile')
      await alice.keyboard.press('Escape')
      check((await api(bob, 'GET', `/users/@me/notes/${ids.bob}`)).status === 404, "Alice's note on Bob is visible to Bob")
      await alice.reload()
      await ready(alice)
      await members(alice).getByRole('button', { name: new RegExp(NAME.bob) }).click({ button: 'right' })
      await alice.getByRole('menuitem', { name: 'Profile' }).click()
      await until('the note to be loaded after a reload', async () => await modal(alice, NAME.bob).getByRole('textbox', { name: 'Note' }).inputValue() === `Plays AWP ${SFX}`)
      await alice.keyboard.press('Escape')
    })

    // ---- 5. Custom status ----
    await step('5. Alice sets a custom status; Bob sees it under her name in the member list', async () => {
      await alice.getByRole('button', { name: /^Set status, currently/ }).click()
      await alice.getByRole('menuitem', { name: 'Set Custom Status' }).click()
      const cs = modal(alice, 'Set a custom status')
      await cs.getByRole('textbox').fill(`Scrimming tonight ${SFX}`)
      await cs.getByRole('button', { name: 'Save' }).click()
      await alice.getByRole('region', { name: 'Your account' }).getByText(`Scrimming tonight ${SFX}`).waitFor()
      await members(bob).getByRole('listitem').filter({ hasText: NAME.alice }).getByText(`Scrimming tonight ${SFX}`).waitFor(LIVE)
    })

    // ---- 6. Server mute ----
    await step('6. Bob mutes the server: a plain message shows no unread pill, a mention still badges', async () => {
      await railGuild(bob).click({ button: 'right' })
      const saved = bob.waitForResponse((r) => r.url().endsWith(`/users/@me/guilds/${ids.guild}/settings`) && r.request().method() === 'PATCH')
      await bob.getByRole('menuitem', { name: 'For 1 Hour' }).click()
      const res = await saved
      const body = await res.json()
      check(res.status() === 200 && body.muted === true && body.mute_config?.end_time, `muting answered ${res.status()} ${JSON.stringify(body).slice(0, 200)}`)
      await bob.goto(`${BASE}/channels/@me`)
      await ready(bob)
      await send(alice, '#general', `plain chatter ${SFX}`)
      await sleep(1500)
      const label = await railGuild(bob).getAttribute('aria-label')
      check(!/unread|mention/.test(label), `a plain message in the muted server shows "${label}"`)
      await send(alice, '#general', `@${NAME.bob} you are up ${SFX}`)
      await until("Bob's muted server to badge the mention", async () => /1 mention/.test(await railGuild(bob).getAttribute('aria-label')))
    })

    // ---- 7. Inbox ----
    await step('7. Inbox: Bob sees the mention under Mentions; Unreads → Mark All as Read clears the badge', async () => {
      await bob.getByRole('main', { name: 'Friends' }).getByRole('button', { name: 'Inbox' }).or(bob.getByRole('button', { name: 'Inbox' })).first().click()
      const inbox = bob.getByRole('dialog', { name: 'Inbox' })
      await inbox.getByText(`you are up ${SFX}`).waitFor(LIVE)
      await shot(bob, 'inbox')
      await inbox.getByRole('tab', { name: 'Unreads' }).click()
      await inbox.getByRole('button', { name: 'Mark All as Read' }).click()
      await until('the mention badge to clear', async () => !/mention|unread/.test(await railGuild(bob).getAttribute('aria-label')))
      await bob.keyboard.press('Escape')
    })

    // ---- 8. Settings sync ----
    await step('8a. a second Alice session: switching to the light theme in one appears in the other', async () => {
      alice2 = await newUser(browser, 'Alice2')
      await login(alice2, NAME.alice)
      await userSettings(alice, 'Appearance')
      await alice.getByRole('radio', { name: 'Light', exact: true }).check()
      await until("the light theme in Alice's other session", () => alice2.evaluate(() => document.documentElement.dataset.theme === 'light'))
      const [res] = await Promise.all([
        alice.waitForResponse((r) => r.url().endsWith('/users/@me/settings') && r.request().method() === 'PATCH'),
        alice.locator('#font-scale').fill('18'),
      ])
      check(res.status() === 200, `saving the chat font size answered ${res.status()} ${await res.text()}`)
      await until("the 18 px chat font in Alice's other session", () => alice2.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--chat-font').trim() === '18px'))
      await closeSettings(alice)
      await shot(alice2, 'light-theme')
    })

    await step('8b. switching the UI to German appears in the other session too; back to English and dark', async () => {
      await userSettings(alice, 'Language')
      await alice.getByRole('radio', { name: 'Deutsch' }).check()
      await alice.getByRole('tab', { name: 'Sprache', exact: true }).waitFor()
      await until("the German UI in Alice's other session", () => alice2.evaluate(() => document.documentElement.lang === 'de'))
      await alice2.getByRole('button', { name: 'Benutzereinstellungen' }).waitFor()
      await alice.getByRole('button', { name: 'Einstellungen schließen' }).click()
      await alice.getByRole('log').getByText(/^Heute um /).first().waitFor() // already rendered messages follow the switch
      await shot(alice, 'german')
      await alice.getByRole('button', { name: 'Benutzereinstellungen' }).click()
      await alice.getByRole('tab', { name: 'Sprache', exact: true }).click()
      await alice.getByRole('radio', { name: 'English' }).check()
      await alice.getByRole('tab', { name: 'Appearance' }).click()
      await alice.getByRole('radio', { name: 'Dark', exact: true }).check()
      await closeSettings(alice)
      await until("English and dark in Alice's other session", () => alice2.evaluate(() => document.documentElement.lang !== 'de' && document.documentElement.dataset.theme === 'dark'))
    })

    // ---- 9. Guild folders ----
    await step('9. Alice drags a second server onto the first: a folder appears and is saved in guild_folders', async () => {
      const g2 = await ok(api(alice, 'POST', '/guilds', { name: GUILD2 }))
      ids.guild2 = g2.id
      await railGuild(alice, GUILD2).waitFor(LIVE)
      await railGuild(alice, GUILD2).dragTo(railGuild(alice))
      await rail(alice).getByRole('button', { name: /^Folder / }).waitFor()
      await until('guild_folders with both servers', async () => {
        const s = (await api(alice, 'GET', '/users/@me/settings')).body
        return s.guild_folders?.some((f) => f.id !== null && f.guild_ids.includes(ids.guild) && f.guild_ids.includes(ids.guild2))
      })
      await until("the folder in Alice's other session", async () => (await rail(alice2).getByRole('button', { name: /^Folder / }).count()) === 1)
    })

    // ---- 10. Quick switcher ----
    await step('10. Ctrl+K quick switcher jumps to a channel by a fuzzy query', async () => {
      const ch = await ok(api(alice, 'POST', `/guilds/${ids.guild}/channels`, { name: `strats-${SFX}`, type: 0 }))
      await alice.goto(`${BASE}/channels/@me`)
      await ready(alice)
      await alice.keyboard.press('Control+k')
      const qs = alice.getByRole('combobox', { name: 'Where would you like to go?' })
      await qs.fill(`strts${SFX}`)
      await alice.getByRole('option', { name: new RegExp(`strats-${SFX}`) }).waitFor()
      await qs.press('Enter')
      await alice.waitForURL(`**/channels/${ids.guild}/${ch.id}`)
    })

    // ---- 11. Sessions and password change ----
    await step('11a. Devices lists the other session; "Log Out All Known Devices" logs it out', async () => {
      await userSettings(alice, 'Devices')
      const others = alice.locator('ul.sessions').nth(1).getByRole('listitem')
      await until('the other session in the list', async () => (await others.count()) >= 1)
      await alice.getByRole('button', { name: 'Log Out All Known Devices' }).click()
      await alice2.getByRole('heading', { name: 'Ready up' }).waitFor({ timeout: 10000 })
      await alice.getByText('No other devices are logged in.').waitFor()
      await closeSettings(alice)
    })

    await step('11b. password change logs out the other session; the new password works there', async () => {
      await login(alice2, NAME.alice)
      await userSettings(alice, 'My Account')
      await alice.getByRole('button', { name: 'Change Password' }).click()
      const dialog = modal(alice, 'Update your password')
      await dialog.getByLabel('Current Password').fill(PASSWORD)
      await dialog.getByLabel('New Password', { exact: true }).fill(`${PASSWORD} 2`)
      await dialog.getByLabel('Confirm New Password').fill(`${PASSWORD} 2`)
      await dialog.getByRole('button', { name: 'Done' }).click()
      await dialog.waitFor({ state: 'detached' })
      await alice2.getByRole('heading', { name: 'Ready up' }).waitFor({ timeout: 10000 })
      await closeSettings(alice)
      check((await api(alice, 'GET', '/users/@me')).status === 200, "Alice's own session no longer works after the password change")
      await loginForm(alice2, NAME.alice, PASSWORD)
      await alice2.getByText(/password/i).first().waitFor()
      await login(alice2, NAME.alice, `${PASSWORD} 2`)
    })

    // ---- 12. 2FA ----
    let backup
    await step('12a. Carol enables 2FA: the TOTP code computed from the shown key activates it; backup codes are shown', async () => {
      await userSettings(carol, 'My Account')
      await carol.getByRole('button', { name: 'Enable Authenticator App' }).click()
      const twofa = modal(carol, 'Enable Two-Factor Auth')
      await twofa.getByLabel('Password').fill(PASSWORD)
      await twofa.getByRole('button', { name: 'Continue' }).click()
      await twofa.getByRole('img', { name: 'QR code for your authenticator app' }).waitFor()
      ids.secret = (await twofa.getByLabel('2FA key').innerText()).replace(/\s/g, '')
      await twofa.getByLabel('6-digit code').fill(totp(ids.secret))
      await twofa.getByRole('button', { name: 'Activate' }).click()
      const codes = twofa.getByRole('list', { name: 'Backup codes' }).getByRole('listitem')
      await codes.first().waitFor()
      check((await codes.count()) === 10, `${await codes.count()} backup codes shown`)
      backup = (await codes.allInnerTexts()).map((c) => c.trim())
      await twofa.getByRole('button', { name: 'Done' }).click()
      await carol.getByText('Two-Factor Authentication is on').waitFor()
    })

    await step('12b. Carol logs out and back in through the MFA step with a TOTP code', async () => {
      await carol.getByRole('button', { name: 'Log Out' }).click()
      await loginForm(carol, NAME.carol)
      await carol.getByRole('heading', { name: 'Multi-Factor Authentication' }).waitFor()
      await carol.getByLabel('Authentication code').fill(totp(ids.secret, Date.now() + 30000)) // the next step: the current one was used to enable
      await carol.getByRole('button', { name: 'Log In' }).click()
      await carol.waitForURL('**/channels/**')
      await ready(carol)
    })

    await step('12c. a backup code logs in once; the same code fails the second time', async () => {
      for (const attempt of [1, 2]) {
        await carol.getByRole('button', { name: 'User Settings' }).click()
        await carol.getByRole('button', { name: 'Log Out' }).click()
        await loginForm(carol, NAME.carol)
        await carol.getByRole('heading', { name: 'Multi-Factor Authentication' }).waitFor()
        await carol.getByRole('button', { name: 'Use a backup code' }).click()
        await carol.getByLabel('Backup code').fill(backup[0])
        await carol.getByRole('button', { name: 'Log In' }).click()
        if (attempt === 1) {
          await carol.waitForURL('**/channels/**')
          await ready(carol)
        } else {
          await carol.locator('.form-error, [role="alert"]').first().waitFor(LIVE)
          check(carol.url().endsWith('/login') || (await carol.getByRole('heading', { name: 'Multi-Factor Authentication' }).count()) === 1, 'a used backup code logged Carol in')
          await carol.getByLabel('Backup code').fill(backup[1])
          await carol.getByRole('button', { name: 'Log In' }).click()
          await carol.waitForURL('**/channels/**')
          await ready(carol)
        }
      }
    })

    await step('12d. regenerating backup codes shows 10 new ones; an old unused code stops working', async () => {
      await userSettings(carol, 'My Account')
      await carol.getByRole('button', { name: 'View Backup Codes' }).click()
      const dialog = modal(carol, 'Backup Codes')
      await dialog.getByLabel('Password').fill(PASSWORD)
      await dialog.getByLabel('Authentication or backup code').fill(backup[3]) // step-up: 2FA accounts confirm with a code
      await dialog.getByRole('button', { name: 'Generate New Codes' }).click()
      const codes = dialog.getByRole('list', { name: 'Backup codes' }).getByRole('listitem')
      await codes.first().waitFor()
      const fresh = (await codes.allInnerTexts()).map((c) => c.trim())
      check(fresh.length === 10 && !fresh.includes(backup[2]), `regenerated codes: ${fresh.length}, old ones kept: ${fresh.includes(backup[2])}`)
      await dialog.getByRole('button', { name: 'Done' }).click()
      await closeSettings(carol)
      const r = await carol.evaluate(async (login) => {
        const a = await (await fetch('/api/v9/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(login) })).json()
        return (await fetch('/api/v9/auth/mfa/totp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: a.ticket, code: login.code }) })).status
      }, { login: NAME.carol, password: PASSWORD, code: backup[2].replace('-', '') })
      check(r === 400, `an old backup code after regenerating answered ${r}`)
    })

    // ---- 13. Developer portal and OAuth2 install ----
    await step('13. Alice creates an application in the Developer Portal, reveals the bot token and installs the bot via /oauth2/authorize', async () => {
      await alice.goto(`${BASE}/developers/applications`)
      await alice.getByRole('button', { name: 'New Application' }).click()
      await modal(alice, 'Create an Application').getByLabel('Name').fill(`PingBot ${SFX}`)
      await modal(alice, 'Create an Application').getByRole('button', { name: 'Create' }).click()
      await alice.getByRole('navigation', { name: 'Developer Portal' }).getByRole('link', { name: 'Bot', exact: true }).click()
      ids.botToken = (await alice.getByLabel('Bot token').innerText()).trim()
      check(/^[\w.-]{24,}$/.test(ids.botToken), 'the revealed bot token does not look like a token')
      await shot(alice, 'developer-portal')
      await alice.getByRole('navigation', { name: 'Developer Portal' }).getByRole('link', { name: 'OAuth2' }).click()
      const url = await alice.getByLabel('Generated URL').inputValue()
      ids.app = new URL(url).searchParams.get('client_id')
      await alice.goto(url.replace(/^https?:\/\/[^/]+/, BASE))
      await alice.locator('#oauth-guild').selectOption(ids.guild)
      await alice.getByRole('button', { name: 'Authorize' }).click()
      await alice.getByRole('heading', { name: 'Authorized' }).waitFor()
      const list = await ok(api(alice, 'GET', `/guilds/${ids.guild}/members?limit=100`))
      check(list.some((m) => m.user.id === ids.app && m.user.bot), 'the bot is not a member of the server after Authorize')
    })

    // ---- 14. A real bot library (v14) ----
    await step('14a. a bot on a real bot library (v14) logs in with that token and registers /ping, /secret and /feedback', async () => {
      check(BOTLIB && fs.existsSync(BOTLIB), 'bot library (v14) not found (set E2E_BOTLIB to its installed package directory)')
      const file = path.join(tmp, 'bot.cjs')
      fs.writeFileSync(file, BOT)
      bot = spawn(process.execPath, [file, `${BASE}/api`, ids.guild], { env: { ...process.env, BOTLIB, BOT_TOKEN: ids.botToken }, stdio: ['ignore', 'pipe', 'pipe'] })
      bot.lines = []
      let buf = ''
      bot.stdout.on('data', (d) => { buf += d; for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) try { bot.lines.push(JSON.parse(buf.slice(0, i))) } catch { /* not ours */ } })
      bot.stderr.on('data', (d) => bot.lines.push({ stderr: String(d) }))
      await until('the bot to log in and register its commands', async () => {
        const err = bot.lines.find((l) => l.error)
        if (err) throw new Error(`bot error: ${err.error}`)
        return bot.lines.some((l) => l.ready === ids.app)
      }, 20000)
    })

    await step('14b. Alice runs /ping from the command picker; the bot answers with a button; clicking it updates the message', async () => {
      for (const p of [alice, bob]) {
        await p.goto(`${BASE}/channels/${ids.guild}/${ids.general}`)
        await ready(p)
      }
      await slash(alice, '#general', 'ping')
      const reply = anyMessage(log(alice, '#general'), 'Pong!')
      await reply.getByRole('button', { name: 'Again' }).waitFor(LIVE)
      check((await reply.locator('.bot-tag').innerText()).trim() === 'APP', 'the bot reply is not tagged APP')
      await reply.getByText(`${NAME.alice} used /ping`).or(reply.getByText('used /ping')).first().waitFor()
      await shot(alice, 'slash-commands')
      await reply.getByRole('button', { name: 'Again' }).click()
      await anyMessage(log(alice, '#general'), `Clicked by ${NAME.alice.toLowerCase()}`).or(anyMessage(log(alice, '#general'), `Clicked by ${NAME.alice}`)).first().waitFor(LIVE)
      await anyMessage(log(bob, '#general'), 'Clicked by').waitFor(LIVE)
    })

    await step('14c. an ephemeral reply to Bob\'s /secret is visible only to Bob', async () => {
      await slash(bob, '#general', 'secret')
      const eph = anyMessage(log(bob, '#general'), 'Psst, only you can read this')
      await eph.getByText('Only you can see this').waitFor(LIVE)
      await sleep(1500)
      check((await log(alice, '#general').getByText('Psst, only you can read this').count()) === 0, 'Alice sees the ephemeral reply to Bob')
      const history = await ok(api(alice, 'GET', `/channels/${ids.general}/messages?limit=20`))
      check(!history.some((m) => m.content.includes('Psst')), 'the ephemeral reply is in the channel history')
    })

    await step('14d. /feedback opens the bot\'s modal; the submitted text comes back in the bot\'s reply', async () => {
      await slash(alice, '#general', 'feedback')
      const form = modal(alice, 'Feedback')
      await form.getByLabel('Your feedback').fill(`More maps ${SFX}`)
      await form.getByRole('button', { name: 'Submit' }).click()
      await form.waitFor({ state: 'detached' })
      await anyMessage(log(alice, '#general'), `Thanks for the feedback: More maps ${SFX}`).waitFor(LIVE)
    })

    // ---- 15. Web Push subscription ----
    await step('15. push: Bob enables push notifications in a browser profile with service workers; the server stores the subscription', async () => {
      const token = await bob.evaluate(() => localStorage.getItem('token'))
      const ctx = await pushProfile
      await ctx.addInitScript((t) => localStorage.getItem('token') || localStorage.setItem('token', t), token)
      const page = ctx.pages()[0] ?? await ctx.newPage()
      watch(page, 'Bob (push)')
      try {
        await page.goto(`${BASE}/channels/@me`)
        await ready(page)
        await until('the service worker to control the page', () => page.evaluate(() => !!navigator.serviceWorker.controller), 10000)
        await userSettings(page, 'Notifications')
        const toggle = page.getByLabel('Enable Push Notifications')
        await until('the push switch to be enabled', () => toggle.isEnabled())
        const [res] = await Promise.all([
          page.waitForResponse((r) => r.url().endsWith('/users/@me/push-subscriptions') && r.request().method() === 'POST', { timeout: 20000 })
            .catch(async (e) => { throw new Error(`no subscription was sent (${(await page.locator('.form-error').allInnerTexts()).join(' ') || e.message})`) }),
          toggle.click(),
        ])
        check(res.status() === 204, `POST /users/@me/push-subscriptions answered ${res.status()}`)
        const sent = res.request().postDataJSON()
        check(/^https:\/\//.test(sent.endpoint) && sent.keys?.p256dh && sent.keys?.auth, `the stored subscription is ${JSON.stringify(sent).slice(0, 60)}…`)
        await until('the switch to show push as on', () => toggle.isChecked())
        const [del] = await Promise.all([
          page.waitForResponse((r) => r.url().includes('/users/@me/push-subscriptions') && r.request().method() === 'DELETE', { timeout: 10000 }),
          toggle.click(),
        ])
        check(del.status() === 204, `DELETE /users/@me/push-subscriptions answered ${del.status()}`)
      } finally {
        delete pages['Bob (push)']
        await ctx.close()
      }
    })

    // ---- 16. Phone layout ----
    if (SHOTS) await step('16. phone screenshot', async () => {
      await alice.setViewportSize({ width: 390, height: 844 })
      await sleep(500)
      await alice.screenshot({ path: path.join(SHOTS, 'v4-phone.png') })
      await alice.setViewportSize({ width: 1440, height: 900 })
    })

    // ---- 17. Login rate limit ----
    await step('17. login rate limit: two wrong passwords are free, then each further failure waits longer; the form shows the countdown', async () => {
      const ip = `198.51.100.${1 + Math.floor(Math.random() * 250)}`
      const page = await newUser(browser, 'Stranger', { extraHTTPHeaders: { 'X-Forwarded-For': ip } })
      await page.goto(BASE + '/login')
      // five failures, waiting out each 429 (1 s after the 3rd, 2 s after the 4th); the next try then has to wait 4 s
      const codes = await page.evaluate(async (name) => {
        const out = []
        while (out.filter((c) => c === 401).length < 5 && out.length < 20) {
          const r = await fetch('/api/v9/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: name, password: 'wrong password' }) })
          out.push(r.status)
          if (r.status === 429) await new Promise((res) => setTimeout(res, (r.headers.get('Retry-After') ?? 1) * 1000))
        }
        return out
      }, `nobody_${SFX}`)
      check(codes.slice(0, 4).join() === '401,401,401,429', `the first three failures answer 401, the 4th try waits (429): ${codes.join(',')}`)
      check(codes.filter((c) => c === 401).length === 5, `failed logins (401 per contract v1) answered ${codes.join(',')}`)
      await loginForm(page, `nobody_${SFX}`, 'wrong password')
      await page.getByText(/Too many attempts\. Try again in \d+ seconds\./).waitFor(LIVE)
      await page.context().close()
      delete pages.Stranger
    })

    await step('18. no uncaught page errors and no native dialogs', async () => {
      if (errors.length) throw new Error(errors.join('; '))
    })
  } catch {
    // step() already reported it; later steps depend on earlier ones
  } finally {
    if (bot) bot.kill()
    await (await pushProfile.catch(() => null))?.close()
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
