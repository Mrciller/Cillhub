// End-to-end check of the v2 features: three browsers (Alice, Bob, Carol) against a running server that serves
// client/dist and has LiveKit configured. Voice is real: Chromium's fake camera, and its fake mic fed with a generated
// speech-like WAV (the built-in beep is on ~10 % of the time, below LiveKit's 40 % active-speaker threshold).
// Run: NODE_PATH=<dir with playwright> E2E_BASE_URL=http://127.0.0.1:3300 node scripts/e2e-v2.cjs
// Usernames get a random suffix, so any database works. E2E_SCREENSHOTS=1 also writes docs/screenshots/v2-*.png.
// With LIVEKIT_API_KEY and LIVEKIT_API_SECRET set (and LIVEKIT_URL, default http://127.0.0.1:7880), the server-mute
// step also asks LiveKit's RoomService which tracks Bob publishes.
const { chromium } = require('playwright')
const { createHmac } = require('node:crypto')
const path = require('node:path')
const zlib = require('node:zlib')
const fs = require('node:fs')
const os = require('node:os')

const BASE = (process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3300').replace(/\/$/, '')
const SHOTS = process.env.E2E_SCREENSHOTS ? path.join(__dirname, '..', 'docs', 'screenshots') : null
const LIVE = { timeout: 5000 } // live updates must arrive within 5 s, without reload
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const SFX = Math.random().toString(36).slice(2, 7)
const NAME = { alice: `Alice_${SFX}`, bob: `Bob_${SFX}`, carol: `Carol_${SFX}` }
const GUILD = `Nightfall ${SFX}`
const STAFF_COLOR = 'rgb(233, 30, 99)' // swatch 0xe91e63

let failed = false
const errors = []
const frames = { Alice: [], Bob: [], Carol: [] } // gateway payloads each page received
const pages = {}

async function step(name, fn) {
  try {
    await fn()
    console.log(`ok - ${name}`)
  } catch (e) {
    console.log(`not ok - ${name}\n  ${String(e.message).split('\n')[0]}`)
    failed = true
    // E2E_FAIL_SHOTS=<dir> keeps a screenshot of every page at the failure.
    if (process.env.E2E_FAIL_SHOTS) for (const [n, p] of Object.entries(pages)) await p.screenshot({ path: path.join(process.env.E2E_FAIL_SHOTS, `fail-${n}.png`) }).catch(() => {})
    throw e
  }
}

// Polls until fn() is truthy; the message says what was expected.
async function until(what, fn, ms = 5000) {
  for (const end = Date.now() + ms; ; await sleep(100)) {
    if (await fn().catch(() => false)) return
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`)
  }
}
const check = (ok, what) => { if (!ok) throw new Error(what) }

// A w x h RGB PNG with a diagonal gradient, written by hand so the test needs no image library.
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
    for (let x = 0; x < w; x++) raw.set([(x * 255) / w, (y * 255) / h, 160], y * (w * 3 + 1) + 1 + x * 3)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

// 6 s of mono 48 kHz "speech": 140 Hz voiced harmonics in 450 ms syllables with 100 ms gaps. Chromium loops it.
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

// Optional: LiveKit's own view of a room (RoomService.ListParticipants), to prove what a participant publishes.
const LK = process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET ? (process.env.LIVEKIT_URL ?? 'http://127.0.0.1:7880') : null
async function livekitParticipants(room) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const unsigned = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: process.env.LIVEKIT_API_KEY, nbf: now, exp: now + 60, video: { roomAdmin: true, room } })}`
  const token = `${unsigned}.${createHmac('sha256', process.env.LIVEKIT_API_SECRET).update(unsigned).digest('base64url')}`
  const res = await fetch(`${LK}/twirp/livekit.RoomService/ListParticipants`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ room }),
  })
  if (!res.ok) throw new Error(`LiveKit ListParticipants answered HTTP ${res.status}`)
  return (await res.json()).participants ?? []
}
// True if LiveKit has an unmuted microphone track from this identity in the room.
const publishesMic = async (room, identity) =>
  (await livekitParticipants(room)).some((p) => p.identity === identity && (p.tracks ?? []).some((t) => t.source === 'MICROPHONE' && !t.muted))

async function newUser(browser, name) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, permissions: ['microphone', 'camera'] })
  const page = await ctx.newPage()
  pages[name] = page
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`))
  page.on('dialog', (d) => (errors.push(`${name}: unexpected native dialog "${d.message()}"`), d.dismiss())) // v3: all confirmations are in-app modals
  page.on('websocket', (ws) => ws.url().includes('/gateway') && ws.on('framereceived', (f) => frames[name].push(String(f.payload))))
  return page
}

async function ready(page) {
  await page.getByRole('navigation', { name: 'Servers' }).waitFor()
  await until('the gateway to connect (no "Connecting…")', async () => (await page.getByText('Connecting…').count()) === 0, 10000)
}

async function register(page, name) {
  await page.goto(BASE + '/')
  await page.getByRole('heading', { name: 'Ready up' }).waitFor()
  await page.getByRole('link', { name: 'Register' }).click()
  await page.getByLabel('Email').fill(`${name.toLowerCase()}@example.com`)
  await page.getByLabel('Username').fill(name)
  await page.getByLabel('Password').fill('correct horse battery')
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.waitForURL('**/channels/@me')
  await ready(page)
}

const log = (page, label) => page.getByRole('log', { name: `Messages in ${label}` })
// A message by its own text (a reply's preview of another message does not count).
const message = (page, label, text) => log(page, label).getByRole('listitem').filter({ has: page.locator(':scope > .content', { hasText: text }) })
const members = (page) => page.getByRole('complementary', { name: 'Members' })
const memberRow = (page, name) => members(page).getByRole('listitem').filter({ hasText: name })
const channels = (page) => page.getByRole('navigation', { name: `${GUILD} channels` })
const channelLink = (page, name) => channels(page).getByRole('link', { name: new RegExp(`^${name}\\b`) })
const voiceRow = (page) => channels(page).getByRole('button', { name: /^General \(voice channel/ })
const voiceUser = (page, name) => channels(page).getByRole('list', { name: 'Connected users' }).getByRole('button', { name: new RegExp(name) })
const railGuild = (page) => page.getByRole('navigation', { name: 'Servers' }).getByRole('link', { name: new RegExp(`^${GUILD}`) })
const unreadMark = (page, name) => channelLink(page, name).locator('.sr-only', { hasText: 'unread' })

async function send(page, label, text) {
  const box = page.getByRole('textbox', { name: `Message ${label}` })
  await box.fill(text)
  await box.press('Enter')
}

async function guildMenu(page, item) {
  await page.getByRole('button', { name: GUILD, exact: true }).click()
  await page.getByRole('button', { name: item }).click()
}

async function openServerSettings(page, tab) {
  await guildMenu(page, 'Server Settings')
  await page.getByRole('tab', { name: tab }).click()
}
const closeSettings = (page) => page.getByRole('button', { name: 'Close settings' }).click()

async function contextMenu(page, target, item) {
  await target.click({ button: 'right' })
  const menu = page.getByRole('menu')
  await menu.getByRole('menuitem', { name: item, exact: true }).or(menu.getByRole('menuitemcheckbox', { name: item, exact: true })).click()
}

// Remote audio the voice engine attached, with a live MediaStreamTrack.
const liveRemoteAudio = (page) =>
  page.evaluate(() => [...document.querySelectorAll('#voice-audio audio')].filter((a) => a.srcObject?.getAudioTracks().some((t) => t.readyState === 'live')).length)

async function hoverAct(page, msg, action) {
  await msg.hover()
  await msg.getByRole('button', { name: action }).click()
}

async function main() {
  const wav = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cillcord-e2e-')), 'speech.wav')
  fs.writeFileSync(wav, speechWav())
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`] })
  try {
    const alice = await newUser(browser, 'Alice')
    const bob = await newUser(browser, 'Bob')
    const carol = await newUser(browser, 'Carol')
    let code
    const ids = {}

    await step(`Alice, Bob and Carol register (suffix ${SFX})`, async () => {
      await Promise.all([register(alice, NAME.alice), register(bob, NAME.bob), register(carol, NAME.carol)])
      for (const [k, p] of Object.entries({ alice, bob, carol }))
        ids[k] = await p.evaluate(() => fetch('/api/v9/users/@me', { headers: { Authorization: localStorage.getItem('token') } }).then((r) => r.json()).then((u) => u.id))
    })

    await step('1. Alice creates a server: "Text Channels" with #general and "Voice Channels" with "General"', async () => {
      await alice.getByRole('button', { name: 'Add a server' }).click()
      const dialog = alice.getByRole('dialog', { name: 'Add a server' })
      await dialog.getByLabel('Server name').fill(GUILD)
      await dialog.getByRole('button', { name: 'Create', exact: true }).click()
      await alice.getByRole('heading', { level: 1, name: 'general' }).waitFor()
      for (const cat of ['Text Channels', 'Voice Channels']) await channels(alice).getByRole('heading', { level: 2, name: cat }).waitFor()
      const text = channels(alice).locator('section', { has: alice.getByRole('heading', { name: 'Text Channels' }) })
      await text.getByRole('link', { name: /^general/ }).waitFor()
      const voice = channels(alice).locator('section', { has: alice.getByRole('heading', { name: 'Voice Channels' }) })
      await voice.getByRole('button', { name: /^General \(voice channel/ }).waitFor()
    })

    await step('2. Bob joins via invite; Alice sees the join message in #general', async () => {
      await guildMenu(alice, 'Invite People')
      const dialog = alice.getByRole('dialog', { name: 'Invite friends' })
      const field = dialog.getByLabel('Send this invite link to a friend')
      await until('an invite link in the field', async () => /\/invite\/[A-Za-z0-9]+$/.test(await field.inputValue()))
      code = (await field.inputValue()).split('/').pop()
      await dialog.getByRole('button', { name: 'Done' }).click()
      await bob.goto(`${BASE}/invite/${code}`)
      await bob.getByRole('button', { name: 'Join' }).click()
      await ready(bob)
      await bob.getByRole('heading', { level: 1, name: 'general' }).waitFor()
      await log(alice, '#general').locator('li.msg.system', { hasText: NAME.bob }).waitFor(LIVE)
    })

    // ---- 3. Voice ----
    let room
    await step('3a. Alice and Bob join "General" voice; both sidebars list both users', async () => {
      await voiceRow(alice).click()
      await alice.getByRole('status').filter({ hasText: 'Voice Connected' }).waitFor({ timeout: 15000 })
      await voiceRow(bob).click()
      await bob.getByRole('status').filter({ hasText: 'Voice Connected' }).waitFor({ timeout: 15000 })
      for (const p of [alice, bob]) for (const n of [NAME.alice, NAME.bob]) await voiceUser(p, n).waitFor(LIVE)
      room = new URL(alice.url()).pathname.split('/').pop()
    })

    await step('3b. each client has a live remote audio track from the other', async () => {
      for (const [n, p] of [['Alice', alice], ['Bob', bob]]) await until(`${n} to have a live remote <audio>`, async () => (await liveRemoteAudio(p)) >= 1, 15000)
    })

    await step('3c. the speaking indicator lights up for the other user within 10 s', async () => {
      await until("Alice's sidebar to show Bob speaking", () => voiceUser(alice, NAME.bob).locator('.sr-only', { hasText: 'speaking' }).count(), 10000)
      await until("Bob's sidebar to show Alice speaking", () => voiceUser(bob, NAME.alice).locator('.sr-only', { hasText: 'speaking' }).count(), 10000)
    })

    await step('3d. Alice self-mutes; Bob sees the mute icon', async () => {
      await alice.getByRole('button', { name: 'Mute', exact: true }).first().click()
      await voiceUser(bob, NAME.alice).getByRole('img', { name: 'Muted' }).waitFor(LIVE)
      await alice.getByRole('button', { name: 'Mute', exact: true }).first().click()
      await voiceUser(bob, NAME.alice).getByRole('img', { name: 'Muted' }).waitFor({ state: 'detached', ...LIVE })
    })

    await step("3e. Alice turns on the camera; Bob's grid plays her video (videoWidth > 0); off, on and off again", async () => {
      await alice.getByRole('main').getByRole('button', { name: 'Camera' }).click()
      const tile = bob.getByRole('list', { name: 'Participants' }).getByRole('listitem').filter({ hasText: NAME.alice })
      await until("a playing <video> in Alice's tile for Bob", () => tile.locator('video').evaluate((v) => v.videoWidth > 0 && !v.paused), 15000)
      if (SHOTS) {
        await bob.mouse.move(0, 0)
        await sleep(500)
        await bob.screenshot({ path: path.join(SHOTS, 'v2-voice.png') })
      }
      await alice.getByRole('main').getByRole('button', { name: 'Camera' }).click()
      await until("Alice's video to leave Bob's grid", async () => (await tile.locator('video').count()) === 0, 10000)
      // on again (cillvoice adds a fresh transceiver; see client/README.md) and off again
      await alice.getByRole('main').getByRole('button', { name: 'Camera' }).click()
      await until("Alice's video back in Bob's grid", () => tile.locator('video').evaluate((v) => v.videoWidth > 0 && !v.paused), 15000)
      await alice.getByRole('main').getByRole('button', { name: 'Camera' }).click()
      await until("Alice's video to leave Bob's grid again", async () => (await tile.locator('video').count()) === 0, 10000)
    })

    await step("3f. Alice server-mutes Bob: Bob sees the icon and his mic stops; unmuting restores it", async () => {
      await contextMenu(alice, voiceUser(alice, NAME.bob), 'Server Mute')
      await voiceUser(bob, NAME.bob).getByRole('img', { name: 'Server muted' }).waitFor(LIVE)
      if (LK) await until('LiveKit to stop carrying an unmuted mic track from Bob', async () => !(await publishesMic(room, ids.bob)), 10000)
      await until('Alice to lose the speaking indicator for Bob', async () => (await voiceUser(alice, NAME.bob).locator('.sr-only', { hasText: 'speaking' }).count()) === 0, 10000)
      await contextMenu(alice, voiceUser(alice, NAME.bob), 'Server Mute')
      await voiceUser(bob, NAME.bob).getByRole('img', { name: 'Server muted' }).waitFor({ state: 'detached', ...LIVE })
      if (LK) await until('LiveKit to carry Bob\'s mic again', () => publishesMic(room, ids.bob), 10000)
      await until("Alice to see Bob speaking again", () => voiceUser(alice, NAME.bob).locator('.sr-only', { hasText: 'speaking' }).count(), 15000)
    })

    await step('3g. Alice disconnects Bob; he leaves the channel for both', async () => {
      await contextMenu(alice, voiceUser(alice, NAME.bob), 'Disconnect')
      for (const p of [alice, bob]) await voiceUser(p, NAME.bob).waitFor({ state: 'detached', ...LIVE })
      await bob.getByRole('region', { name: 'Voice connection' }).waitFor({ state: 'detached', ...LIVE })
    })

    await step('3h. Alice leaves voice; she disappears from both sidebars', async () => {
      await alice.getByRole('region', { name: 'Voice connection' }).getByRole('button', { name: 'Disconnect' }).click()
      for (const p of [alice, bob]) await voiceUser(p, NAME.alice).waitFor({ state: 'detached', ...LIVE })
      for (const p of [alice, bob]) await channelLink(p, 'general').click()
    })

    // ---- 4. Roles ----
    await step('4. Alice creates hoisted, colored role "Staff" and gives it to Bob; both see a Staff group in that color', async () => {
      await openServerSettings(alice, 'Roles')
      await alice.getByRole('button', { name: 'Create Role' }).click()
      await alice.getByLabel('Role Name').fill('Staff')
      await alice.getByRole('button', { name: 'Color #e91e63' }).click()
      await alice.getByRole('switch', { name: 'Display role members separately from online members' }).check()
      await alice.getByRole('button', { name: 'Save Changes' }).click()
      await alice.getByRole('list', { name: 'Roles, highest first' }).getByRole('button', { name: 'Staff', exact: true }).waitFor(LIVE)
      if (SHOTS) {
        await alice.getByRole('heading', { level: 1, name: 'Roles' }).evaluate((h) => h.scrollIntoView())
        await sleep(300)
        await alice.screenshot({ path: path.join(SHOTS, 'v2-server-settings-roles.png') })
      }
      await alice.getByRole('tab', { name: 'Members' }).click()
      await alice.getByRole('combobox', { name: `Add a role to ${NAME.bob}` }).selectOption({ label: 'Staff' })
      await alice.getByRole('list', { name: `Roles of ${NAME.bob}` }).getByText('Staff').waitFor(LIVE)
      await closeSettings(alice)
      for (const p of [alice, bob]) {
        const group = members(p).locator('section', { has: p.getByRole('heading', { name: 'Staff — 1' }) })
        await group.getByRole('listitem').filter({ hasText: NAME.bob }).waitFor(LIVE)
        // v6: role colours are drawn on the name span and lifted to 4.5:1 on the theme, so #e91e63 stays red but lighter
        const color = await group.getByRole('listitem').filter({ hasText: NAME.bob }).locator('.ellipsis .ns').evaluate((e) => getComputedStyle(e).color)
        const [r, g, b] = color.match(/\d+/g).map(Number)
        check(color === STAFF_COLOR || (r > g + 60 && r > b && b > g), `Bob's name in the Staff group is ${color}, expected ${STAFF_COLOR} or a lighter red`)
      }
    })

    // ---- 5. Private channel ----
    await step('5a. Carol joins; Alice makes #staff-only (@everyone deny View, Staff allow); Bob sees it, Carol does not', async () => {
      await carol.goto(`${BASE}/invite/${code}`)
      await carol.getByRole('button', { name: 'Join' }).click()
      await ready(carol)
      await carol.getByRole('heading', { level: 1, name: 'general' }).waitFor()
      await guildMenu(alice, 'Create Channel')
      const dialog = alice.getByRole('dialog', { name: 'Create channel' })
      await dialog.getByLabel('Channel name').fill('staff-only')
      await dialog.getByRole('button', { name: 'Create Channel' }).click()
      await alice.getByRole('heading', { level: 1, name: 'staff-only' }).waitFor()
      await channelLink(carol, 'staff-only').waitFor(LIVE) // public until the overwrite lands
      await channels(alice).getByRole('button', { name: 'Edit channel staff-only' }).click()
      await alice.getByRole('tab', { name: 'Permissions' }).click()
      const view = alice.getByRole('radiogroup', { name: 'View Channels' })
      await view.getByTitle('Deny').click()
      await alice.getByRole('button', { name: 'Save Changes' }).click()
      await channelLink(carol, 'staff-only').waitFor({ state: 'detached', ...LIVE })
      await alice.getByRole('combobox', { name: 'Add a role or member' }).selectOption({ label: 'Staff' })
      await view.getByTitle('Allow').click()
      await alice.getByRole('button', { name: 'Save Changes' }).click()
      await closeSettings(alice)
      await channelLink(bob, 'staff-only').waitFor(LIVE)
      check((await channelLink(carol, 'staff-only').count()) === 0, 'Carol sees #staff-only')
    })

    await step('5b. a message in #staff-only reaches Bob but not Carol (not even over the gateway)', async () => {
      await channelLink(bob, 'staff-only').click()
      await send(alice, '#staff-only', 'staff meeting at 8')
      await message(bob, '#staff-only', 'staff meeting at 8').waitFor(LIVE)
      await sleep(500)
      check(!frames.Carol.some((f) => f.includes('staff meeting at 8')), "Carol's gateway received the #staff-only message")
    })

    await step('5c. removing Staff from Bob hides #staff-only for him live', async () => {
      await openServerSettings(alice, 'Members')
      await alice.getByRole('button', { name: `Remove role Staff from ${NAME.bob}` }).click()
      await channelLink(bob, 'staff-only').waitFor({ state: 'detached', ...LIVE })
      // Give it back for the rest of the run (role colors in chat and the screenshots).
      await alice.getByRole('combobox', { name: `Add a role to ${NAME.bob}` }).selectOption({ label: 'Staff' })
      await channelLink(bob, 'staff-only').waitFor(LIVE)
      await closeSettings(alice)
      await channelLink(bob, 'general').click()
      await channelLink(alice, 'general').click()
    })

    // ---- 6. Uploads ----
    let imageUrl, textUrl
    await step('6. Bob sends a PNG and a .txt; Alice sees an inline image and a file card; the CDN headers are right', async () => {
      await bob.locator('.composer input[type=file]').setInputFiles([
        { name: 'map.png', mimeType: 'image/png', buffer: png(320, 200) },
        { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('smokes: A main, CT\n') },
      ])
      await send(bob, '#general', 'strat for tonight')
      const msg = message(alice, '#general', 'strat for tonight')
      const img = msg.getByRole('img', { name: 'map.png' })
      await until('the image to load for Alice', () => img.evaluate((i) => i.complete && i.naturalWidth === 320), 10000)
      await msg.locator('.file-card').getByRole('link', { name: 'notes.txt', exact: true }).waitFor()
      imageUrl = await img.getAttribute('src')
      textUrl = await msg.locator('.file-card').getByRole('link', { name: 'notes.txt', exact: true }).getAttribute('href')
      const get = (u) => fetch(new URL(u, BASE))
      const ri = await get(imageUrl)
      check(ri.ok && /^inline/.test(ri.headers.get('content-disposition') ?? ''), `image served with Content-Disposition "${ri.headers.get('content-disposition')}"`)
      check(ri.headers.get('content-type') === 'image/png', `image served as ${ri.headers.get('content-type')}`)
      const rt = await get(textUrl)
      check(rt.ok && /^attachment/.test(rt.headers.get('content-disposition') ?? ''), `txt served with Content-Disposition "${rt.headers.get('content-disposition')}"`)
      check(rt.headers.get('x-content-type-options') === 'nosniff', 'txt is missing X-Content-Type-Options: nosniff')
    })

    // ---- 7. Reactions, replies, pins, mentions ----
    await step('7a. reactions toggle with counts for both', async () => {
      const amsg = message(alice, '#general', 'strat for tonight')
      await hoverAct(alice, amsg, 'Add Reaction')
      await alice.getByRole('dialog', { name: 'Emoji picker' }).getByRole('button', { name: 'thumbsup', exact: true }).click()
      const r = (p) => message(p, '#general', 'strat for tonight').getByRole('button', { name: /^👍, \d+ reactions?$/ })
      await r(bob).filter({ hasText: '1' }).waitFor(LIVE)
      await r(bob).click()
      for (const p of [alice, bob]) await message(p, '#general', 'strat for tonight').getByRole('button', { name: '👍, 2 reactions' }).waitFor(LIVE)
      await r(bob).click()
      for (const p of [alice, bob]) await message(p, '#general', 'strat for tonight').getByRole('button', { name: '👍, 1 reaction' }).waitFor(LIVE)
      check(await r(alice).getAttribute('aria-pressed') === 'true', "Alice's own reaction is not marked as hers")
      check(await r(bob).getAttribute('aria-pressed') === 'false', "Bob's removed reaction still shows as his")
    })

    await step('7b. Alice replies; both see the reply preview', async () => {
      await hoverAct(alice, message(alice, '#general', 'strat for tonight'), 'Reply')
      await alice.getByText(`Replying to ${NAME.bob}`).waitFor()
      await send(alice, '#general', 'looks good, ship it')
      for (const p of [alice, bob]) {
        const preview = message(p, '#general', 'looks good, ship it').locator('.reply-preview')
        await preview.filter({ hasText: `@${NAME.bob}` }).filter({ hasText: 'strat for tonight' }).waitFor(LIVE)
      }
    })

    await step('7c. Alice pins the message; it shows in the pins popover for both', async () => {
      await hoverAct(alice, message(alice, '#general', 'strat for tonight'), 'More')
      await alice.getByRole('menu', { name: 'Message actions' }).getByRole('menuitem', { name: 'Pin Message' }).click()
      for (const p of [alice, bob]) {
        await p.getByRole('button', { name: 'Pinned Messages' }).click()
        const pop = p.getByRole('dialog', { name: 'Pinned Messages' })
        await pop.getByRole('listitem').filter({ hasText: 'strat for tonight' }).waitFor(LIVE)
        await p.keyboard.press('Escape')
      }
    })

    await step('7d. @everyone from Bob (no MENTION_EVERYONE) does not badge Alice; @Alice does (channel and server icon)', async () => {
      await guildMenu(alice, 'Create Channel')
      const dialog = alice.getByRole('dialog', { name: 'Create channel' })
      await dialog.getByLabel('Channel name').fill('scrims')
      await dialog.getByRole('button', { name: 'Create Channel' }).click()
      await alice.getByRole('heading', { level: 1, name: 'scrims' }).waitFor()
      await send(bob, '#general', '@everyone scrim in 5')
      await unreadMark(alice, 'general').waitFor(LIVE)
      await sleep(500)
      check((await channelLink(alice, 'general').locator('.badge').count()) === 0, '#general shows a mention badge for an uncounted @everyone')
      check(!/mention/.test(await railGuild(alice).getAttribute('aria-label')), 'the server icon shows a mention for an uncounted @everyone')
      const box = bob.getByRole('textbox', { name: 'Message #general' })
      await box.fill(`@${NAME.alice}`)
      await bob.getByRole('listbox', { name: 'Suggestions' }).getByRole('option', { name: new RegExp(NAME.alice) }).waitFor()
      await box.press('Enter') // picks the suggestion
      await until('the composer to hold the picked mention', async () => (await box.inputValue()) === `@${NAME.alice} `)
      await bob.evaluate(() => new Promise((r) => requestAnimationFrame(() => r()))) // the caret moves after the pick
      await box.pressSequentially('bring the lineups')
      await box.press('Enter')
      await channelLink(alice, 'general').getByLabel('1 mention').waitFor(LIVE)
      await until('the server icon to say 1 mention', async () => /, 1 mention$/.test(await railGuild(alice).getAttribute('aria-label')))
      await alice.getByRole('navigation', { name: 'Servers' }).locator('.rail-badge', { hasText: '1' }).waitFor()
    })

    await step('8. unread: the channel shows unread for Alice in another channel; opening it clears it (and the mention)', async () => {
      await channelLink(alice, 'general').click()
      await message(alice, '#general', 'bring the lineups').waitFor()
      await until('#general to stop being unread', async () => (await unreadMark(alice, 'general').count()) === 0 && (await channelLink(alice, 'general').locator('.badge').count()) === 0)
      await channelLink(alice, 'scrims').click()
      await send(bob, '#general', 'anyone up?')
      await unreadMark(alice, 'general').waitFor(LIVE)
      await until('the server icon to say unread', async () => /, unread$/.test(await railGuild(alice).getAttribute('aria-label')))
      await channelLink(alice, 'general').click()
      await message(alice, '#general', 'anyone up?').waitFor()
      await channelLink(alice, 'scrims').click()
      await until('#general to stay read after leaving it', async () => (await unreadMark(alice, 'general').count()) === 0 && !/unread|mention/.test(await railGuild(alice).getAttribute('aria-label')))
      await channelLink(alice, 'general').click()
    })

    // ---- 9. Profile ----
    await step('9. Bob uploads an avatar; Alice sees it in chat and the member list', async () => {
      await bob.getByRole('button', { name: 'User Settings' }).click()
      await bob.locator('.settings input[type=file]').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: png(128, 128) })
      await bob.getByRole('img', { name: 'Your avatar' }).waitFor()
      await bob.getByRole('button', { name: 'Save Changes' }).click()
      await bob.getByRole('status').filter({ hasText: 'Saved.' }).waitFor()
      await closeSettings(bob)
      const loaded = (loc) => loc.locator(`img[src*="/avatars/${ids.bob}/"]`).first().evaluate((i) => i.complete && i.naturalWidth === 128)
      await until("Bob's avatar in Alice's member list", () => loaded(memberRow(alice, NAME.bob)), 5000)
      await until("Bob's avatar next to his message in Alice's chat", () => loaded(message(alice, '#general', 'strat for tonight')), 5000)
    })

    if (SHOTS) {
      await alice.mouse.move(0, 0)
      await message(alice, '#general', 'strat for tonight').scrollIntoViewIfNeeded()
      await sleep(500)
      await alice.screenshot({ path: path.join(SHOTS, 'v2-chat.png') })
      await alice.setViewportSize({ width: 390, height: 844 })
      await sleep(500)
      await alice.screenshot({ path: path.join(SHOTS, 'v2-phone.png') })
      await alice.setViewportSize({ width: 1440, height: 900 })
    }

    // ---- 10. Moderation: kick ----
    await step("10a. Alice kicks Carol; Carol's client drops the server", async () => {
      await contextMenu(alice, memberRow(alice, NAME.carol), `Kick ${NAME.carol}`)
      await alice.getByRole('dialog', { name: `Kick ${NAME.carol}` }).getByRole('button', { name: 'Kick', exact: true }).click()
      await railGuild(carol).waitFor({ state: 'detached', ...LIVE })
      await memberRow(alice, NAME.carol).waitFor({ state: 'detached', ...LIVE })
    })

    // ---- 11. Friends (Carol shares no server with Alice any more, so only the friendship allows the DM) ----
    await step('11. Carol sends Alice a friend request; Alice accepts in Friends; both list each other; Carol DMs Alice', async () => {
      await carol.getByRole('link', { name: 'Direct Messages' }).click()
      await carol.getByRole('main', { name: 'Friends' }).getByRole('tab', { name: 'Add Friend' }).click()
      await carol.getByRole('textbox', { name: 'Username' }).fill(NAME.alice)
      await carol.getByRole('button', { name: 'Send Friend Request' }).click()
      await carol.getByText(`Your friend request to ${NAME.alice} was sent.`).waitFor()
      await alice.getByRole('link', { name: 'Direct Messages' }).click()
      const friends = (p) => p.getByRole('main', { name: 'Friends' })
      await friends(alice).getByRole('tab', { name: /Pending/ }).click()
      await friends(alice).getByRole('button', { name: `Accept ${NAME.carol}` }).click(LIVE)
      for (const [p, other] of [[alice, NAME.carol], [carol, NAME.alice]]) {
        await friends(p).getByRole('tab', { name: 'All' }).click()
        await friends(p).getByRole('listitem').filter({ hasText: other }).getByRole('button', { name: `Message ${other}` }).waitFor(LIVE)
      }
      await friends(carol).getByRole('button', { name: `Message ${NAME.alice}` }).click()
      await carol.getByRole('heading', { level: 1, name: NAME.alice }).waitFor()
      await send(carol, `@${NAME.alice}`, 'gg, add me for scrims')
      await message(carol, `@${NAME.alice}`, 'gg, add me for scrims').filter({ hasNot: carol.locator('.send-error') }).waitFor()
      await alice.getByRole('navigation', { name: 'Direct messages' }).getByRole('link', { name: new RegExp(NAME.carol) }).click(LIVE)
      await message(alice, `@${NAME.carol}`, 'gg, add me for scrims').waitFor(LIVE)
    })

    // ---- 12. Moderation: ban ----
    await step("12. Alice bans Bob deleting the last hour; his messages vanish for Alice; he can't rejoin and sees why", async () => {
      await railGuild(alice).click()
      await channelLink(alice, 'general').click()
      await message(alice, '#general', 'anyone up?').waitFor()
      await contextMenu(alice, memberRow(alice, NAME.bob), `Ban ${NAME.bob}`)
      const dialog = alice.getByRole('dialog', { name: `Ban ${NAME.bob}` })
      await dialog.getByLabel('Delete Message History').selectOption({ label: 'Previous Hour' })
      await dialog.getByRole('button', { name: 'Ban', exact: true }).click()
      await railGuild(bob).waitFor({ state: 'detached', ...LIVE })
      for (const t of ['anyone up?', 'strat for tonight']) await message(alice, '#general', t).waitFor({ state: 'detached', ...LIVE })
      await message(alice, '#general', 'looks good, ship it').waitFor() // Alice's own reply stays
      await bob.goto(`${BASE}/invite/${code}`)
      await bob.getByRole('button', { name: 'Join' }).click()
      await bob.getByRole('alert').filter({ hasText: /banned/i }).waitFor()
      await bob.goto(`${BASE}/channels/@me`)
      await ready(bob)
      check((await railGuild(bob).count()) === 0, 'Bob is back in the server after a banned rejoin')
    })

    await step('13. no uncaught errors in any page', async () => {
      if (errors.length) throw new Error(errors.join('; '))
    })
  } catch {
    // step() already reported it; later steps depend on earlier ones
  } finally {
    await browser.close()
    fs.rmSync(path.dirname(wav), { recursive: true, force: true })
  }
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
