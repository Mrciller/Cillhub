// End-to-end check of the v3 (community) features: Alice (owner), Bob and Carol in real browsers against a running
// server that serves client/dist and has LiveKit configured. Voice is real (Chromium's fake camera and a fake mic fed
// with a generated speech-like WAV), link unfurling is real (needs internet: example.com and YouTube).
// Run: NODE_PATH=<dir with playwright> E2E_BASE_URL=http://127.0.0.1:3300 node scripts/e2e-v3.cjs
// Usernames get a random suffix, so any database works. E2E_SCREENSHOTS=1 also writes docs/screenshots/v3-*.png;
// E2E_FAIL_SHOTS=<dir> saves every page when a step fails. LIVEKIT_API_KEY/LIVEKIT_API_SECRET (and LIVEKIT_URL,
// default http://127.0.0.1:7880) let the stage step ask LiveKit's RoomService what a participant publishes.
// The update-banner step (16) needs E2E_STATIC_DIR: the server's STATIC_DIR, a scratch copy of client/dist that the
// script may rewrite (it restores index.html afterwards); without it that step is skipped and reported.
const { chromium } = require('playwright')
const { createHmac } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const path = require('node:path')
const zlib = require('node:zlib')
const fs = require('node:fs')
const os = require('node:os')

const BASE = (process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3300').replace(/\/$/, '')
const SHOTS = process.env.E2E_SCREENSHOTS ? path.join(__dirname, '..', 'docs', 'screenshots') : null
const STATIC = process.env.E2E_STATIC_DIR
const LIVE = { timeout: 5000 } // live updates must arrive within 5 s, without reload
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const SFX = Math.random().toString(36).slice(2, 7)
const NAME = { alice: `Alice_${SFX}`, bob: `Bob_${SFX}`, carol: `Carol_${SFX}` }
const GUILD = `Community ${SFX}`
const GUILD2 = `Followers ${SFX}`
const VANITY = `cc-${SFX}`

let failed = false
const errors = []
const frames = { Alice: [], Bob: [], Carol: [] } // gateway payloads each page received
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

// A short sound for the soundboard: 0.6 s Ogg/Opus from ffmpeg.
function soundOgg(dir) {
  const out = path.join(dir, 'boop.ogg')
  execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=0.6', '-c:a', 'libopus', '-b:a', '32k', out])
  return out
}

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
const publishesMic = async (room, identity) =>
  (await livekitParticipants(room)).some((p) => p.identity === identity && (p.tracks ?? []).some((t) => t.source === 'MICROPHONE' && !t.muted))

async function newUser(browser, name, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, permissions: ['microphone', 'camera'], serviceWorkers: 'block', ...opts })
  // Keep every RTCPeerConnection so the voice steps can read WebRTC stats (sent audio level, screen share encodings).
  await ctx.addInitScript(() => {
    const Orig = window.RTCPeerConnection
    window.__pcs = []
    window.RTCPeerConnection = class extends Orig { constructor(...a) { super(...a); window.__pcs.push(this) } }
  })
  const page = await ctx.newPage()
  watch(page, name)
  return page
}

// Level (0..1) of the audio the page hands to WebRTC: the media-source stats of its microphone sender.
const sentAudioLevel = (page) => page.evaluate(async () => {
  for (const pc of window.__pcs ?? []) {
    if (pc.connectionState === 'closed') continue
    for (const r of (await pc.getStats()).values()) if (r.type === 'media-source' && r.kind === 'audio' && r.audioLevel !== undefined) return r.audioLevel
  }
  return null
})
// Peak of a few samples of the sent level (the WAV has 100 ms gaps between syllables).
async function peakLevel(page) {
  let peak = null
  for (let i = 0; i < 12; i++, await sleep(250)) { const l = await sentAudioLevel(page); if (l != null) peak = Math.max(peak ?? 0, l) }
  return peak
}
const setRange = (loc, v) => loc.evaluate((el, v) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, String(v))
  el.dispatchEvent(new Event('input', { bubbles: true }))
}, v)
function watch(page, name) {
  pages[name] = page
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`))
  page.on('dialog', (d) => (errors.push(`${name}: unexpected native dialog "${d.message()}"`), d.dismiss()))
  page.on('websocket', (ws) => ws.url().includes('/gateway') && ws.on('framereceived', (f) => frames[name]?.push(String(f.payload))))
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

// REST as the page's user (same token the client uses). Returns {status, body}.
const api = (page, method, route, body) =>
  page.evaluate(async ([method, route, body]) => {
    const r = await fetch('/api/v9' + route, { method, headers: { Authorization: localStorage.getItem('token'), ...(body && { 'Content-Type': 'application/json' }) }, body: body && JSON.stringify(body) })
    return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }
  }, [method, route, body])

const log = (page, label) => page.getByRole('log', { name: `Messages in ${label}` })
const message = (page, label, text) => log(page, label).getByRole('listitem').filter({ has: page.locator(':scope > .content', { hasText: text }) })
const anyMessage = (scope, text) => scope.locator('li.msg').filter({ hasText: text })
const channels = (page, guild = GUILD) => page.getByRole('navigation', { name: `${guild} channels` })
const channelLink = (page, name, guild) => channels(page, guild).getByRole('link', { name: new RegExp(`^${name}\\b`) })
const railGuild = (page, guild = GUILD) => page.getByRole('navigation', { name: 'Servers' }).getByRole('link', { name: new RegExp(`^${guild}`) })
const composer = (scope, label) => scope.getByRole('textbox', { name: `Message ${label}` })

async function send(scope, label, text) {
  const box = composer(scope, label)
  await box.fill(text)
  await box.press('Enter')
}

async function guildMenu(page, item, guild = GUILD) {
  await page.getByRole('button', { name: guild, exact: true }).click()
  await page.getByRole('button', { name: item }).click()
}
async function openServerSettings(page, tab, guild = GUILD) {
  await guildMenu(page, 'Server Settings', guild)
  await page.getByRole('tab', { name: tab, exact: true }).click()
}
const closeSettings = (page) => page.getByRole('button', { name: 'Close settings' }).click()

async function createChannel(page, name, type = 'Text', guild = GUILD) {
  await guildMenu(page, 'Create Channel', guild)
  const dialog = page.getByRole('dialog', { name: 'Create channel' })
  await dialog.getByRole('radio', { name: new RegExp(`^${type}\\b`) }).check()
  await dialog.getByLabel('Channel name').fill(name)
  await dialog.getByRole('button', { name: 'Create Channel' }).click()
  await dialog.waitFor({ state: 'detached' })
}

async function hoverAct(page, msg, action) {
  await msg.hover()
  await msg.getByRole('button', { name: action, exact: true }).click()
}
async function msgMenu(page, msg, item) {
  await hoverAct(page, msg, 'More')
  await page.getByRole('menu').getByRole('menuitem', { name: item, exact: true }).click()
}
const modal = (page, name) => page.getByRole('dialog', { name })
const shot = async (page, name) => {
  if (!SHOTS) return
  await page.mouse.move(0, 0)
  await until('toasts to clear before the screenshot', async () => (await page.locator('.toast').count()) === 0, 10000).catch(() => {})
  await sleep(500)
  await page.screenshot({ path: path.join(SHOTS, `v3-${name}.png`) })
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cillcord-e2e3-'))
  const wav = path.join(tmp, 'speech.wav')
  fs.writeFileSync(wav, speechWav())
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, '--auto-select-desktop-capture-source=Entire screen'] })
  try {
    const alice = await newUser(browser, 'Alice')
    const bob = await newUser(browser, 'Bob')
    const carol = await newUser(browser, 'Carol')
    const ids = {}
    let code

    await step(`0. Alice, Bob and Carol register (suffix ${SFX}); Alice creates a server; Bob joins by invite`, async () => {
      await Promise.all([register(alice, NAME.alice), register(bob, NAME.bob), register(carol, NAME.carol)])
      for (const [k, p] of Object.entries({ alice, bob, carol })) ids[k] = (await api(p, 'GET', '/users/@me')).body.id
      await alice.getByRole('button', { name: 'Add a server' }).click()
      const dialog = modal(alice, 'Add a server')
      await dialog.getByLabel('Server name').fill(GUILD)
      await dialog.getByRole('button', { name: 'Create', exact: true }).click()
      await alice.getByRole('heading', { level: 1, name: 'general' }).waitFor()
      ids.guild = new URL(alice.url()).pathname.split('/')[2]
      ids.general = new URL(alice.url()).pathname.split('/')[3]
      await guildMenu(alice, 'Invite People')
      const inv = modal(alice, 'Invite friends')
      const field = inv.getByLabel('Send this invite link to a friend')
      await until('an invite link in the field', async () => /\/invite\/[A-Za-z0-9]+$/.test(await field.inputValue()))
      code = (await field.inputValue()).split('/').pop()
      await inv.getByRole('button', { name: 'Done' }).click()
      await bob.goto(`${BASE}/invite/${code}`)
      await bob.getByRole('button', { name: 'Join' }).click()
      await ready(bob)
      await bob.getByRole('heading', { level: 1, name: 'general' }).waitFor()
      // A role change for the audit log later.
      await openServerSettings(alice, 'Roles')
      await alice.getByRole('button', { name: 'Create Role' }).click()
      await alice.getByLabel('Role Name').fill('Coach')
      await alice.getByRole('button', { name: 'Save Changes' }).click()
      await alice.getByRole('list', { name: 'Roles, highest first' }).getByRole('button', { name: 'Coach', exact: true }).waitFor(LIVE)
      await closeSettings(alice)
    })

    // ---- 1. Threads ----
    await step('1a. Alice starts a thread from a message and posts in it; Bob sees it in the panel and the thread list', async () => {
      await send(alice, '#general', 'who is up for a retake drill?')
      const msg = message(alice, '#general', 'who is up for a retake drill?')
      await msg.waitFor()
      await hoverAct(alice, msg, 'Create Thread')
      const dialog = modal(alice, 'Create Thread')
      await dialog.getByLabel('Thread Name').fill('retake drill')
      await dialog.getByRole('button', { name: 'Create Thread' }).click()
      const panel = alice.getByRole('complementary', { name: 'Thread retake drill' })
      await send(panel, '#retake drill', 'B site at 9, bring utility')
      await anyMessage(panel, 'B site at 9, bring utility').waitFor()
      const bmsg = message(bob, '#general', 'who is up for a retake drill?')
      await bmsg.getByRole('button', { name: /^Open thread retake drill/ }).click(LIVE)
      const bpanel = bob.getByRole('complementary', { name: 'Thread retake drill' })
      await anyMessage(bpanel, 'B site at 9, bring utility').waitFor(LIVE)
      await shot(bob, 'thread')
      await bpanel.getByRole('button', { name: 'Close thread' }).click()
      await bob.getByRole('main', { name: '#general' }).getByRole('button', { name: 'Threads', exact: true }).click()
      await modal(bob, 'Threads').getByRole('button', { name: /retake drill/ }).waitFor(LIVE)
      await bob.keyboard.press('Escape')
    })

    await step('1b. Alice archives the thread (Bob sees it under Archived) and unarchives it', async () => {
      const panel = alice.getByRole('complementary', { name: 'Thread retake drill' })
      await panel.getByRole('button', { name: 'Thread options' }).click()
      await alice.getByRole('menu', { name: 'Thread options' }).getByRole('menuitem', { name: 'Archive Thread' }).click()
      await panel.getByText('This thread is archived.').waitFor(LIVE)
      const threads = async (tab) => {
        await bob.getByRole('main', { name: '#general' }).getByRole('button', { name: 'Threads', exact: true }).click()
        const pop = modal(bob, 'Threads')
        await pop.getByRole('tab', { name: tab }).click()
        return pop
      }
      let pop = await threads('Archived')
      await pop.getByRole('button', { name: /retake drill/ }).waitFor(LIVE)
      await bob.keyboard.press('Escape')
      await panel.getByRole('button', { name: 'Thread options' }).click()
      await alice.getByRole('menu', { name: 'Thread options' }).getByRole('menuitem', { name: 'Unarchive Thread' }).click()
      await panel.getByText('This thread is archived.').waitFor({ state: 'detached', ...LIVE })
      pop = await threads('Active')
      await pop.getByRole('button', { name: /retake drill/ }).waitFor(LIVE)
      await bob.keyboard.press('Escape')
      await panel.getByRole('button', { name: 'Close thread' }).click()
    })

    await step('1c. a private thread Alice creates is invisible to Bob (list, sidebar and gateway)', async () => {
      await alice.getByRole('main', { name: '#general' }).getByRole('button', { name: 'Threads', exact: true }).click()
      await modal(alice, 'Threads').getByRole('button', { name: 'Create', exact: true }).click()
      const dialog = modal(alice, 'Create Thread')
      await dialog.getByLabel('Thread Name').fill('coach notes')
      await dialog.getByRole('switch', { name: /Private Thread/ }).check()
      await dialog.getByLabel('Starter Message (optional)').fill('bob needs to work on his crosshair placement')
      await dialog.getByRole('button', { name: 'Create Thread' }).click()
      const panel = alice.getByRole('complementary', { name: 'Thread coach notes' })
      await anyMessage(panel, 'crosshair placement').waitFor()
      await sleep(700)
      await bob.getByRole('main', { name: '#general' }).getByRole('button', { name: 'Threads', exact: true }).click()
      const pop = modal(bob, 'Threads')
      await pop.getByRole('button', { name: /retake drill/ }).waitFor()
      check((await pop.getByRole('button', { name: /coach notes/ }).count()) === 0, "Bob's thread list shows the private thread")
      await bob.keyboard.press('Escape')
      check((await channels(bob).getByText('coach notes').count()) === 0, "Bob's sidebar shows the private thread")
      check(!frames.Bob.some((f) => f.includes('crosshair placement') || f.includes('coach notes')), "Bob's gateway received the private thread")
      await panel.getByRole('button', { name: 'Close thread' }).click()
    })

    // ---- 2. Forum ----
    await step('2. forum with tags Question/Guide: Alice posts with a tag; Bob sees it, filters by tag and replies', async () => {
      await createChannel(alice, 'help', 'Forum')
      await channels(alice).getByRole('button', { name: 'Edit channel help' }).click()
      for (const [i, n] of [[1, 'Question'], [2, 'Guide']]) {
        await alice.getByRole('button', { name: 'Add Tag' }).click()
        await alice.getByLabel(`Tag ${i} name`).fill(n)
      }
      await alice.getByRole('button', { name: 'Save Changes' }).click()
      await until('the tags to be saved', async () => (await alice.getByRole('button', { name: 'Save Changes' }).isDisabled()))
      await closeSettings(alice)
      await channelLink(alice, 'help').click()
      const forum = alice.getByRole('main', { name: 'Forum help' })
      await forum.getByRole('button', { name: 'New Post' }).click()
      const form = forum.getByRole('form', { name: 'New post' })
      await form.getByLabel('Post Title').fill('Best crosshair settings?')
      await form.getByLabel('Message').fill('Share your crosshair codes here.')
      await form.getByRole('group', { name: 'Tags for this post' }).getByRole('button', { name: 'Question' }).click()
      await form.getByRole('button', { name: 'Post', exact: true }).click()
      await alice.getByRole('complementary', { name: 'Thread Best crosshair settings?' }).waitFor()
      await channelLink(bob, 'help').click(LIVE)
      const bforum = bob.getByRole('main', { name: 'Forum help' })
      const post = bforum.getByRole('list', { name: 'Posts' }).getByRole('listitem').filter({ hasText: 'Best crosshair settings?' })
      await post.locator('.forum-tag', { hasText: 'Question' }).waitFor(LIVE)
      const filter = bforum.getByRole('group', { name: 'Filter posts by tag' })
      await filter.getByRole('button', { name: 'Guide' }).click()
      await post.waitFor({ state: 'detached' })
      await filter.getByRole('button', { name: 'Guide' }).click()
      await filter.getByRole('button', { name: 'Question' }).click()
      await post.waitFor()
      await shot(bob, 'forum')
      await post.getByRole('button').first().click()
      const panel = bob.getByRole('complementary', { name: 'Thread Best crosshair settings?' })
      await anyMessage(panel, 'Share your crosshair codes here.').waitFor()
      await send(panel, '#Best crosshair settings?', 'mine is a small static cyan dot')
      await anyMessage(alice.getByRole('complementary', { name: 'Thread Best crosshair settings?' }), 'small static cyan dot').waitFor(LIVE)
      await panel.getByRole('button', { name: 'Close thread' }).click()
      await alice.getByRole('complementary', { name: 'Thread Best crosshair settings?' }).getByRole('button', { name: 'Close thread' }).click()
    })

    // ---- 3. Announcements ----
    await step('3. Alice follows #news into a second server, publishes a message; it arrives there via the follower webhook', async () => {
      await alice.getByRole('button', { name: 'Add a server' }).click()
      const dialog = modal(alice, 'Add a server')
      await dialog.getByLabel('Server name').fill(GUILD2)
      await dialog.getByRole('button', { name: 'Create', exact: true }).click()
      await channels(alice, GUILD2).waitFor()
      await railGuild(alice).click()
      await createChannel(alice, 'news', 'Announcement')
      await alice.getByRole('heading', { level: 1, name: 'news' }).waitFor()
      await alice.getByRole('main', { name: '#news' }).getByRole('button', { name: 'Follow', exact: true }).click()
      const follow = modal(alice, 'Follow #news')
      await follow.getByLabel('Server').selectOption({ label: GUILD2 })
      await follow.getByLabel('Channel').selectOption({ label: '#general' })
      await follow.getByRole('button', { name: 'Follow', exact: true }).click()
      await follow.waitFor({ state: 'detached' })
      await send(alice, '#news', 'Patch 1.3 is live: new map pool')
      const msg = message(alice, '#news', 'Patch 1.3 is live')
      await hoverAct(alice, msg, 'Publish')
      await modal(alice, 'Publish to followers?').getByRole('button', { name: 'Publish' }).click()
      await railGuild(alice, GUILD2).click()
      await channelLink(alice, 'general', GUILD2).click()
      const repost = message(alice, '#general', 'Patch 1.3 is live')
      await repost.waitFor(LIVE)
      await repost.getByText(`${GUILD} #news`).waitFor()
      await railGuild(alice).click()
      await channelLink(alice, 'general').click()
    })

    // ---- 4. Stage ----
    let stageRoom
    await step('4. stage: Alice starts it with a topic; Bob joins as audience (no mic in LiveKit), raises his hand, is invited and then publishes audio', async () => {
      await createChannel(alice, 'town-hall', 'Stage')
      const row = (p) => channels(p).getByRole('button', { name: /^town-hall \(stage channel/ })
      await row(alice).click()
      const stage = (p) => p.getByRole('main', { name: 'Stage channel town-hall' })
      await stage(alice).getByRole('button', { name: 'Start Stage' }).click()
      const dialog = modal(alice, 'Start Stage')
      await dialog.getByLabel('Topic').fill('Season kickoff Q&A')
      await dialog.getByRole('button', { name: 'Start Stage' }).click()
      await stage(alice).getByRole('list', { name: 'Speakers' }).getByRole('button', { name: new RegExp(NAME.alice) }).waitFor(LIVE)
      stageRoom = new URL(alice.url()).pathname.split('/').pop()
      await row(bob).click()
      await stage(bob).getByRole('region', { name: 'Stage topic' }).getByText('Season kickoff Q&A').waitFor(LIVE)
      await bob.getByRole('region', { name: 'Voice connection' }).getByRole('status').filter({ hasText: 'Voice Connected' }).waitFor({ timeout: 15000 })
      await stage(alice).getByRole('list', { name: 'Audience' }).getByRole('button', { name: new RegExp(NAME.bob) }).waitFor(LIVE)
      if (LK) {
        await until('LiveKit to list Bob in the stage room', async () => (await livekitParticipants(stageRoom)).some((p) => p.identity === ids.bob), 10000)
        await until('LiveKit to carry Alice\'s mic', () => publishesMic(stageRoom, ids.alice), 10000)
        await sleep(1500)
        check(!(await publishesMic(stageRoom, ids.bob)), 'LiveKit carries a mic track from Bob while he is in the audience')
      }
      await stage(bob).getByRole('button', { name: 'Raise Hand' }).click()
      const req = stage(alice).getByRole('list', { name: 'Requested to Speak' })
      await req.getByRole('button', { name: `Invite ${NAME.bob} to Speak` }).click(LIVE)
      await stage(bob).getByRole('list', { name: 'Speakers' }).getByRole('button', { name: new RegExp(NAME.bob) }).waitFor(LIVE)
      if (LK) await until('LiveKit to carry Bob\'s mic once he is a speaker', () => publishesMic(stageRoom, ids.bob), 15000)
      await shot(alice, 'stage')
      for (const p of [bob, alice]) await p.getByRole('region', { name: 'Voice connection' }).getByRole('button', { name: 'Disconnect' }).click()
    })

    // ---- 5. Text chat in a voice channel ----
    await step('5. text chat inside the "General" voice channel reaches the other user', async () => {
      const row = (p) => channels(p).getByRole('button', { name: /^General \(voice channel/ })
      for (const p of [alice, bob]) {
        await row(p).click()
        const view = p.getByRole('main', { name: 'Voice channel General' })
        if ((await view.getByRole('complementary', { name: 'Chat in General' }).count()) === 0) await view.getByRole('button', { name: 'Show Chat' }).click()
      }
      const pane = (p) => p.getByRole('complementary', { name: 'Chat in General' })
      await send(pane(alice), '#General', 'can you hear me? typing here just in case')
      await anyMessage(pane(bob), 'typing here just in case').waitFor(LIVE)
      for (const p of [bob, alice]) await p.getByRole('region', { name: 'Voice connection' }).getByRole('button', { name: 'Disconnect' }).click()
      for (const p of [alice, bob]) await channelLink(p, 'general').click()
    })

    // ---- 6. Slowmode and NSFW ----
    await step('6a. slowmode 10 s: Bob\'s second message is held with a countdown; the API answers 429 with retry_after', async () => {
      await createChannel(alice, 'slow-lane')
      await channels(alice).getByRole('button', { name: 'Edit channel slow-lane' }).click()
      await alice.getByLabel('Slowmode').selectOption({ label: '10s' })
      await alice.getByRole('button', { name: 'Save Changes' }).click()
      await until('slowmode to be saved', () => alice.getByRole('button', { name: 'Save Changes' }).isDisabled())
      await closeSettings(alice)
      await channelLink(bob, 'slow-lane').click(LIVE)
      await bob.getByText('Slowmode is enabled: one message every').waitFor(LIVE)
      await send(bob, '#slow-lane', 'first!')
      await message(bob, '#slow-lane', 'first!').and(bob.locator('li.msg:not(.pending)')).waitFor() // sent, not just shown
      await send(bob, '#slow-lane', 'second!')
      await bob.getByText(/You can send again in/).waitFor()
      check((await composer(bob, '#slow-lane').inputValue()) === 'second!', 'the blocked message left the composer')
      const r = await api(bob, 'POST', `/channels/${new URL(bob.url()).pathname.split('/')[3]}/messages`, { content: 'sneaky' })
      check(r.status === 429 && r.body?.retry_after > 0, `API send during slowmode answered ${r.status} ${JSON.stringify(r.body)}`)
    })

    await step('6b. an NSFW channel shows the age gate once', async () => {
      await createChannel(alice, 'after-dark')
      await channels(alice).getByRole('button', { name: 'Edit channel after-dark' }).click()
      await alice.getByRole('switch', { name: /Age-Restricted Channel/ }).check()
      await alice.getByRole('button', { name: 'Save Changes' }).click()
      await until('NSFW to be saved', () => alice.getByRole('button', { name: 'Save Changes' }).isDisabled())
      await closeSettings(alice)
      await channelLink(bob, 'after-dark').click(LIVE)
      const gate = bob.getByRole('alertdialog', { name: 'Age-Restricted Channel' })
      await gate.waitFor()
      await gate.getByRole('button', { name: 'Continue' }).click()
      await composer(bob, '#after-dark').waitFor()
      await channelLink(bob, 'general').click()
      await channelLink(bob, 'after-dark').click()
      await composer(bob, '#after-dark').waitFor()
      check((await gate.count()) === 0, 'the age gate showed a second time')
      for (const p of [alice, bob]) await channelLink(p, 'general').click()
    })

    // ---- 7. Link embeds ----
    await step('7a. a link to https://example.com unfurls into a card with its title for Bob; images only via /external/', async () => {
      await send(alice, '#general', 'docs are at https://example.com')
      const card = message(bob, '#general', 'docs are at').getByRole('article', { name: /^Embed: Example Domain/ })
      await card.getByRole('link', { name: 'Example Domain' }).waitFor({ timeout: 15000 })
      const srcs = await card.locator('img').evaluateAll((l) => l.map((i) => i.getAttribute('src')))
      check(srcs.every((u) => u.startsWith('/external/')), `embed images not through the proxy: ${srcs.join(', ')}`)
    })

    await step('7b. a YouTube link renders click-to-play (thumbnail via /external/, no iframe until clicked, youtube-nocookie)', async () => {
      await send(alice, '#general', 'watch this https://www.youtube.com/watch?v=dQw4w9WgXcQ')
      const msg = message(bob, '#general', 'watch this')
      const play = msg.getByRole('button', { name: /^Play video/ })
      await play.waitFor({ timeout: 15000 })
      const thumb = await play.locator('img').getAttribute('src')
      check(!!thumb && new URL(thumb, BASE).origin === BASE && new URL(thumb, BASE).pathname.startsWith('/external/'), `YouTube thumbnail src is ${thumb}`)
      await until('the proxied thumbnail to load', () => play.locator('img').evaluate((i) => i.complete && i.naturalWidth > 0), 10000)
      check((await msg.locator('iframe').count()) === 0, 'a YouTube iframe exists before the click')
      await play.click()
      const src = await msg.locator('iframe').getAttribute('src')
      check(src?.startsWith('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'), `player src is ${src}`)
    })

    // ---- 8. Polls ----
    await step('8. poll: Alice creates it, Alice and Bob vote, bars update live for both; ending shows final results', async () => {
      await alice.getByRole('button', { name: 'Upload a file or create a poll' }).click()
      await alice.getByRole('menu').getByRole('menuitem', { name: 'Create Poll' }).click()
      const dialog = modal(alice, 'Create a Poll')
      await dialog.getByLabel('Question').fill('Which map next?')
      await dialog.getByLabel('Answer 1').fill('Mirage')
      await dialog.getByLabel('Answer 2').fill('Inferno')
      await dialog.getByRole('button', { name: 'Post' }).click()
      const poll = (p) => log(p, '#general').getByRole('region', { name: 'Which map next?' })
      await poll(bob).waitFor(LIVE)
      await poll(alice).getByRole('radio', { name: 'Mirage' }).click()
      await poll(alice).getByRole('button', { name: 'Vote' }).click()
      await poll(alice).getByRole('button', { name: /^Mirage: 1 vote, 100%/ }).waitFor(LIVE)
      await poll(bob).getByRole('button', { name: 'Show results' }).click()
      await poll(bob).getByRole('button', { name: /^Mirage: 1 vote, 100%/ }).waitFor(LIVE)
      await poll(bob).getByRole('button', { name: 'Go back to vote' }).click()
      await poll(bob).getByRole('radio', { name: 'Inferno' }).click()
      await poll(bob).getByRole('button', { name: 'Vote' }).click()
      for (const p of [alice, bob]) {
        await poll(p).getByRole('button', { name: /^Mirage: 1 vote, 50%/ }).waitFor(LIVE)
        await poll(p).getByRole('button', { name: /^Inferno: 1 vote, 50%/ }).waitFor(LIVE)
      }
      const width = await poll(alice).locator('.poll-answer.mine .poll-bar').evaluate((e) => e.style.width)
      check(width === '50%', `Alice's bar is ${width}, expected 50%`)
      await shot(alice, 'poll-embeds')
      await poll(alice).getByRole('button', { name: 'End Poll' }).click()
      await modal(alice, 'End Poll Now?').getByRole('button', { name: 'End Now' }).click()
      for (const p of [alice, bob]) {
        await poll(p).getByText('Poll closed').first().waitFor(LIVE)
        await poll(p).getByRole('button', { name: /^Inferno: 1 vote, 50%/ }).waitFor()
        await log(p, '#general').locator('.poll-result', { hasText: 'has closed' }).waitFor(LIVE)
      }
    })

    await step('7c (after the poll screenshot). Alice removes the embeds from her YouTube message; they disappear for Bob', async () => {
      const msg = message(alice, '#general', 'watch this')
      await msgMenu(alice, msg, 'Remove Embeds')
      const confirm = alice.getByRole('dialog', { name: /Remove/ })
      if (await confirm.count()) await confirm.getByRole('button', { name: /Remove/ }).click()
      await message(bob, '#general', 'watch this').locator('.embeds').waitFor({ state: 'detached', ...LIVE })
    })

    // ---- 9. Forward, voice message, spoiler + alt text ----
    await step('9a. Alice forwards a message to #news; Bob sees it there marked Forwarded', async () => {
      await hoverAct(alice, message(alice, '#general', 'who is up for a retake drill?'), 'Forward')
      const dialog = modal(alice, 'Forward To')
      await dialog.getByRole('searchbox', { name: 'Search channels and conversations' }).fill('news')
      await dialog.getByRole('radio', { name: new RegExp(`news ${GUILD}`) }).check()
      await dialog.getByRole('button', { name: 'Send' }).click()
      await dialog.waitFor({ state: 'detached' })
      await channelLink(bob, 'news').click()
      const fwd = log(bob, '#news').locator('li.msg', { has: bob.locator('.forward-label') }).filter({ hasText: 'who is up for a retake drill?' })
      await fwd.waitFor(LIVE)
      await channelLink(bob, 'general').click()
    })

    await step('9b. Alice records a ~2 s voice message with the fake mic; Bob gets a playable one with duration and waveform', async () => {
      const rec = alice.getByRole('button', { name: 'Record a voice message (hold)' })
      await rec.focus()
      await alice.keyboard.down('Space')
      await sleep(2300)
      await alice.keyboard.up('Space')
      const vm = log(bob, '#general').locator('li.msg', { has: bob.locator('.voice-msg') }).last()
      const pos = vm.getByRole('slider', { name: 'Audio position' })
      await pos.waitFor({ timeout: 10000 })
      const text = await pos.getAttribute('aria-valuetext')
      check(/of 0:0[1-3]$/.test(text), `voice message length reads "${text}", expected about 2 s`)
      const bars = await pos.locator('span').evaluateAll((l) => l.map((e) => parseFloat(e.style.height)))
      check(bars.length > 10 && Math.max(...bars) > 20, `waveform looks flat: ${bars.slice(0, 12).join(',')}`)
      await vm.getByRole('button', { name: 'Play audio' }).click()
      await vm.getByRole('button', { name: 'Pause audio' }).waitFor()
      await until('the voice message to play', async () => /^0:0[1-3] of/.test(await pos.getAttribute('aria-valuetext')), 5000)
      const att = (await api(bob, 'GET', `/channels/${ids.general}/messages?limit=5`)).body.find((m) => m.flags & 8192)?.attachments[0]
      check(att && att.duration_secs > 1.5 && att.duration_secs < 3.5 && att.waveform, `voice attachment ${JSON.stringify(att && { d: att.duration_secs, w: !!att.waveform })}`)
    })

    await step('9c. a spoiler image with alt text: blurred for Bob until clicked, then shows with the alt text', async () => {
      await alice.locator('.composer input[type=file]').first().setInputFiles({ name: 'lineup.png', mimeType: 'image/png', buffer: png(320, 200) })
      await alice.getByRole('button', { name: 'Spoiler lineup.png' }).click()
      await alice.getByRole('button', { name: 'Edit lineup.png' }).click()
      const edit = modal(alice, 'lineup.png')
      await edit.getByLabel('Description (alt text)').fill('smoke lineup for B site')
      await edit.getByRole('button', { name: 'Save' }).click()
      await send(alice, '#general', 'secret lineup')
      const msg = message(bob, '#general', 'secret lineup')
      const reveal = msg.getByRole('button', { name: 'Spoiler attachment, press to reveal' })
      await reveal.waitFor(LIVE)
      const blur = await msg.locator('.att-spoiler img').evaluate((i) => getComputedStyle(i).filter + ' ' + getComputedStyle(i.parentElement.parentElement).filter)
      check(/blur/.test(blur), `spoiler image is not blurred (filter: ${blur})`)
      await reveal.click()
      const img = msg.getByRole('img', { name: 'smoke lineup for B site' })
      await until('the revealed image to load', () => img.evaluate((i) => i.complete && i.naturalWidth === 320))
    })

    // ---- 10. Search ----
    await step('10. search by word and by from:, jump to the hit, also to an old message that is not loaded', async () => {
      await createChannel(alice, 'history')
      const hid = new URL(alice.url()).pathname.split('/')[3]
      const old = await api(bob, 'POST', `/channels/${hid}/messages`, { content: 'the ancient relic of dust2' })
      check(old.status < 300, `Bob could not post the old message: ${old.status} ${JSON.stringify(old.body)}`)
      for (let i = 0; i < 120; i++) {
        // v4 rate limits messages per channel (429 with retry_after in seconds); wait it out like a bot would.
        for (let r; (r = await api(alice, 'POST', `/channels/${hid}/messages`, { content: `filler ${i}` })).status === 429;) await sleep(r.body.retry_after * 1000)
      }
      await alice.reload() // a fresh store, so #history holds only its latest page
      await ready(alice)
      await message(alice, '#history', 'filler 119').waitFor()
      check((await message(alice, '#history', 'ancient relic').count()) === 0, 'the old message is already loaded; the jump test would prove nothing')
      const box = alice.getByRole('combobox', { name: 'Search this server' })
      await box.click()
      await box.fill('relic')
      await box.press('Enter')
      const panel = alice.getByRole('complementary', { name: 'Search results' })
      await panel.getByRole('heading', { name: '1 Result' }).waitFor()
      await panel.getByText('the ancient relic of dust2').waitFor()
      await shot(alice, 'search')
      await panel.getByRole('button', { name: `Jump to message from ${NAME.bob}` }).click()
      await message(alice, '#history', 'ancient relic').waitFor()
      await box.click()
      await box.fill(`retake from:${NAME.bob.slice(0, 5)}`)
      await alice.getByRole('listbox', { name: 'Search options' }).getByRole('option', { name: new RegExp(NAME.bob) }).click()
      await box.press('Enter')
      await panel.getByRole('heading', { name: '0 Results' }).waitFor()
      await box.click()
      await box.fill(`retake from:${NAME.alice.slice(0, 7)}`)
      await alice.getByRole('listbox', { name: 'Search options' }).getByRole('option', { name: new RegExp(NAME.alice) }).click()
      await box.press('Enter')
      await panel.getByText('who is up for a retake drill?').waitFor()
      await panel.getByRole('button', { name: `Jump to message from ${NAME.alice}` }).first().click()
      await message(alice, '#general', 'who is up for a retake drill?').and(alice.locator('.flash')).waitFor()
      await panel.getByRole('button', { name: 'Close search' }).click()
    })

    const voiceRow = (p) => channels(p).getByRole('button', { name: /^General \(voice channel/ })
    const voiceUser = (p, name) => channels(p).getByRole('list', { name: 'Connected users' }).getByRole('button', { name: new RegExp(name) })
    const panel = (p) => p.getByRole('region', { name: 'Voice connection' })
    const joinGeneral = async (p) => {
      await voiceRow(p).click()
      await panel(p).getByRole('status').filter({ hasText: 'Voice Connected' }).waitFor({ timeout: 15000 })
    }
    const leave = async (p) => {
      await panel(p).getByRole('button', { name: 'Disconnect' }).click()
      await panel(p).waitFor({ state: 'detached' })
    }

    // ---- 11. Expressions ----
    await step('11a. custom emoji: Alice uploads one, uses it in a message; Bob reacts with it; both see the image', async () => {
      await openServerSettings(alice, 'Emoji')
      await alice.locator('.settings input[type=file]').setInputFiles({ name: 'gg_wp.png', mimeType: 'image/png', buffer: png(64, 64) })
      await alice.getByRole('list', { name: 'Server emoji' }).getByRole('textbox', { name: 'Name of emoji gg_wp' }).waitFor()
      await closeSettings(alice)
      await alice.getByRole('button', { name: 'Select emoji' }).click()
      await modal(alice, 'Expression picker').getByRole('button', { name: 'gg_wp', exact: true }).click()
      const box = composer(alice, '#general')
      await until('the emoji in the composer', async () => /gg_wp/.test(await box.inputValue()))
      await alice.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))) // the caret moves after the pick
      await box.press('End')
      await box.pressSequentially('nice round')
      await box.press('Enter')
      const msg = message(bob, '#general', 'nice round')
      const img = msg.locator('.content img.emoji.custom[alt=":gg_wp:"]')
      await until('the custom emoji to load in Bob\'s chat', () => img.evaluate((i) => i.complete && i.naturalWidth === 64), 8000)
      await hoverAct(bob, msg, 'Add Reaction')
      await modal(bob, 'Emoji picker').getByRole('button', { name: 'gg_wp', exact: true }).click()
      const react = message(alice, '#general', 'nice round').getByRole('button', { name: ':gg_wp:, 1 reaction' })
      await until('the custom reaction image for Alice', () => react.locator('img').evaluate((i) => i.complete && i.naturalWidth === 64), 8000)
    })

    await step('11b. sticker: Alice uploads one and sends it; Bob sees it; the GIF tab is hidden (no GIPHY key)', async () => {
      await openServerSettings(alice, 'Stickers')
      const form = alice.getByRole('form', { name: 'Upload a sticker' })
      // A too-big still image is scaled down in the browser; the related emoji comes from the picker.
      await form.locator('input[type=file]').setInputFiles({ name: 'clutch.png', mimeType: 'image/png', buffer: png(640, 480) })
      await alice.getByText('Resized from 640×480 to 320×240.').waitFor()
      await form.getByLabel('Sticker Name').fill('clutch')
      await form.getByRole('button', { name: 'Related Emoji' }).click()
      await alice.getByLabel('Search emoji').fill('fire')
      await alice.getByRole('button', { name: 'fire', exact: true }).first().click()
      await form.getByRole('button', { name: 'Related Emoji' }).filter({ hasText: '🔥' }).waitFor()
      // A server-side refusal shows its reason, not just "Invalid Form Body".
      await form.getByLabel('Description').fill('x')
      await form.getByRole('button', { name: 'Upload' }).click()
      await alice.getByText('Must be empty or 2-100 in length.').waitFor()
      await form.getByLabel('Description').fill('')
      await form.getByRole('button', { name: 'Upload' }).click()
      await alice.getByRole('list', { name: 'Server stickers' }).getByText('clutch').waitFor()
      await closeSettings(alice)
      await alice.getByRole('button', { name: 'Open GIF and sticker picker' }).click()
      const picker = modal(alice, 'Expression picker')
      await picker.getByRole('tab', { name: 'Stickers' }).waitFor()
      await sleep(500)
      check((await picker.getByRole('tab', { name: 'GIFs' }).count()) === 0, 'the GIF tab is shown without a GIPHY key')
      await picker.getByRole('button', { name: 'Send sticker clutch' }).click()
      const st = log(bob, '#general').getByRole('img', { name: 'Sticker: clutch' }).last()
      await until('the sticker to load for Bob', () => st.evaluate((i) => i.complete && i.naturalWidth === 320), 8000)
    })

    await step('11c. soundboard: Alice uploads an OGG and plays it in voice; Bob gets VOICE_CHANNEL_EFFECT_SEND and sees it', async () => {
      await openServerSettings(alice, 'Soundboard')
      const form = alice.getByRole('form', { name: 'Upload a sound' })
      await form.locator('input[type=file]').setInputFiles(soundOgg(tmp))
      await form.getByLabel('Sound Name').fill('boop')
      await form.getByLabel('Emoji').fill('🎺')
      await form.getByRole('button', { name: 'Upload' }).click()
      await alice.getByRole('list', { name: 'Soundboard sounds' }).getByText('boop').waitFor()
      await closeSettings(alice)
      await joinGeneral(alice)
      await joinGeneral(bob)
      const before = frames.Bob.length
      await panel(alice).getByRole('button', { name: 'Soundboard' }).click()
      await modal(alice, 'Soundboard').getByRole('button', { name: 'Play boop' }).click()
      await until('Bob\'s gateway to receive VOICE_CHANNEL_EFFECT_SEND', async () => frames.Bob.slice(before).some((f) => f.includes('"VOICE_CHANNEL_EFFECT_SEND"') && f.includes(ids.alice)))
      await voiceUser(bob, NAME.alice).getByRole('img', { name: 'played a sound 🎺' }).waitFor(LIVE)
      await alice.keyboard.press('Escape')
    })

    // ---- 15. Voice hotfix features (Alice and Bob are in "General") ----
    await step('15a. input volume 30/100/250 % changes the sent audio level (AGC off)', async () => {
      await alice.getByRole('button', { name: 'User Settings' }).click()
      await alice.getByRole('tab', { name: 'Voice & Video' }).click()
      await alice.getByRole('checkbox', { name: /Automatic Gain Control/ }).uncheck()
      const slider = alice.getByRole('slider', { name: /Input Volume/ })
      const levels = {}
      for (const v of [30, 100, 250]) {
        await setRange(slider, v)
        await sleep(1500)
        levels[v] = await peakLevel(alice)
      }
      await slider.dblclick()
      await closeSettings(alice)
      const txt = Object.entries(levels).map(([k, l]) => `${k}%: ${l?.toFixed(2)}`).join(', ')
      console.log(`  # sent audio level ${txt}`)
      check(levels[30] > 0.05 && levels[30] < levels[100] * 0.6 && levels[250] > levels[100] * 1.3, `levels do not follow the input volume: ${txt}`)
    })

    await step("15b. Go Live 720p15: Bob's grid plays Alice's screen; switching to 1080p30 applies live", async () => {
      await panel(alice).getByRole('button', { name: 'Share Your Screen' }).click()
      const go = modal(alice, 'Screen Share')
      await go.getByRole('radio', { name: '720p' }).check()
      await go.getByRole('radio', { name: '15 FPS' }).check()
      await go.getByRole('button', { name: 'Go Live' }).click()
      const grid = bob.getByRole('main', { name: 'Voice channel General' }).getByRole('list', { name: 'Participants' })
      await voiceRow(bob).click()
      const screenTile = grid.locator('video')
      await until("a playing screen share video in Bob's grid", () => screenTile.first().evaluate((v) => v.videoWidth > 0 && !v.paused), 15000)
      const sender = () => alice.evaluate(async () => {
        for (const pc of window.__pcs) for (const s of pc.getSenders()) {
          if (s.track?.kind !== 'video') continue
          const st = s.track.getSettings()
          const c = s.track.getConstraints()
          const max = (v) => (typeof v === 'object' ? v.max ?? v.ideal ?? v.exact : v)
          return { h: st.height, fps: st.frameRate, ch: max(c.height), cfps: max(c.frameRate), enc: s.getParameters().encodings.map((e) => e.maxFramerate) }
        }
        return null
      })
      let st = await sender()
      check(st && st.ch === 720 && st.cfps === 15 && st.h <= 720 && st.enc.every((f) => f <= 15), `720p15 share: ${JSON.stringify(st)}`)
      await panel(alice).getByRole('button', { name: 'Stream Quality' }).click()
      const q = modal(alice, 'Stream Quality')
      await q.getByRole('radio', { name: '1080p' }).check()
      await q.getByRole('radio', { name: '30 FPS' }).check()
      await q.getByRole('button', { name: 'Apply' }).click()
      await until('the share to switch to 1080p30', async () => { st = await sender(); return st.ch === 1080 && st.cfps === 30 && st.enc.some((f) => f === 30) })
      await until("Bob's grid to keep playing the share", () => screenTile.first().evaluate((v) => v.videoWidth > 0 && !v.paused))
      await panel(alice).getByRole('button', { name: 'Share Your Screen' }).click()
    })

    await step('15c. the ping button shows "Ping N ms" and its connection details', async () => {
      const ping = panel(alice).getByRole('button', { name: /^Ping \d+ ms/ })
      await ping.waitFor({ timeout: 10000 })
      await ping.click()
      const details = panel(alice).locator('.vp-stats')
      await details.getByText('Codec').waitFor()
      const text = await details.innerText()
      check(/opus/.test(text) && /\d+ ms/.test(text), `connection details: ${text.replace(/\n/g, ' | ')}`)
      await ping.click()
    })

    await step('11d. Alice and Bob leave voice', async () => {
      for (const p of [bob, alice]) await leave(p)
      for (const p of [alice, bob]) await channelLink(p, 'general').click()
    })

    // ---- 12. Scheduled events ----
    await step('12. Alice creates a voice event; Bob marks interested (count updates for both); Alice starts it: "Live now"', async () => {
      await alice.getByRole('button', { name: 'Events', exact: true }).click()
      await modal(alice, 'Events').getByRole('button', { name: 'Create Event' }).click()
      const wiz = modal(alice, 'Create Event')
      await wiz.getByRole('radio', { name: /Voice Channel/ }).check()
      await wiz.getByLabel('Select a channel').selectOption({ label: 'General' })
      await wiz.getByRole('button', { name: 'Next' }).click()
      await wiz.getByLabel('Event Topic').fill('Scrim night')
      await wiz.getByRole('button', { name: 'Next' }).click()
      await wiz.getByRole('button', { name: 'Create Event' }).click()
      await alice.keyboard.press('Escape')
      await bob.getByRole('button', { name: '1 Event', exact: true }).click(LIVE)
      const card = (p) => modal(p, 'Events').getByRole('article', { name: 'Scrim night' })
      await card(bob).getByText('0 interested').waitFor()
      await card(bob).getByRole('button', { name: 'Interested' }).click()
      await card(bob).getByText('1 interested').waitFor(LIVE)
      await alice.getByRole('button', { name: '1 Event', exact: true }).click()
      await card(alice).getByText('1 interested').waitFor(LIVE)
      await card(alice).getByRole('button', { name: 'Start' }).click()
      await alice.keyboard.press('Escape')
      await bob.keyboard.press('Escape')
      for (const p of [alice, bob]) await p.locator('.events-entry').getByRole('status').filter({ hasText: 'Live now: Scrim night' }).waitFor(LIVE)
    })

    // ---- 13. Moderation ----
    await step('13a. Alice times Bob out for 60 s: his composer is disabled and the API answers 403; removing it restores him', async () => {
      const row = (p) => p.getByRole('complementary', { name: 'Members' }).getByRole('listitem').filter({ hasText: NAME.bob })
      await row(alice).click({ button: 'right' })
      await alice.getByRole('menu').getByRole('menuitem', { name: `Timeout ${NAME.bob}` }).click()
      const dialog = modal(alice, `Timeout ${NAME.bob}`)
      await dialog.getByLabel('60 seconds').check()
      await dialog.getByRole('button', { name: 'Timeout', exact: true }).click()
      await bob.getByText("You're timed out.").waitFor(LIVE)
      check(!(await composer(bob, '#general').isVisible()) || await composer(bob, '#general').isDisabled(), "Bob's composer is usable while timed out")
      const r = await api(bob, 'POST', `/channels/${ids.general}/messages`, { content: 'let me talk' })
      check(r.status === 403, `send while timed out answered ${r.status}`)
      await row(alice).click({ button: 'right' })
      await alice.getByRole('menu').getByRole('menuitem', { name: 'Remove Timeout' }).click()
      await bob.getByText("You're timed out.").waitFor({ state: 'detached', ...LIVE })
      await send(bob, '#general', 'thanks for the unmute')
      await message(alice, '#general', 'thanks for the unmute').waitFor(LIVE)
    })

    await step('13b. the audit log lists the timeout, the role and the channel changes', async () => {
      await openServerSettings(alice, 'Audit Log')
      const entries = alice.getByRole('list', { name: 'Audit log entries' })
      await entries.getByText('created role').first().waitFor()
      await entries.getByText('updated channel').first().waitFor()
      await entries.getByText('created channel').first().waitFor()
      const upd = entries.getByRole('button', { name: new RegExp(`updated member.*${NAME.bob}`) }).first()
      await upd.click()
      await entries.getByText('communication_disabled_until').first().waitFor()
      await shot(alice, 'server-settings')
    })

    await step('13c. AutoMod keyword rule blocks Bob\'s message with the custom response', async () => {
      await alice.getByRole('tab', { name: 'AutoMod' }).click()
      await alice.getByRole('button', { name: 'Create Rule' }).click()
      const editor = modal(alice, 'Create AutoMod Rule')
      await editor.getByLabel('Keywords', { exact: true }).fill('cheat*')
      await editor.getByLabel('Custom Response').fill('No cheat talk here.')
      await editor.getByRole('button', { name: 'Create Rule' }).click()
      await editor.waitFor({ state: 'detached' })
      await alice.getByRole('list', { name: 'AutoMod rules' }).getByRole('listitem').first().waitFor()
      await send(bob, '#general', 'anyone selling cheats?')
      await bob.getByRole('alert').getByText('No cheat talk here.').waitFor(LIVE)
      await message(bob, '#general', 'anyone selling cheats?').getByText('This message could not be sent.').waitFor()
      await sleep(500)
      check((await message(alice, '#general', 'anyone selling cheats?').count()) === 0, 'the blocked message reached Alice')
    })

    await step('13d. webhook: created in Integrations, executed with username override and an embed; shows with the BOT tag', async () => {
      await alice.getByRole('tab', { name: 'Integrations' }).click()
      await alice.getByRole('button', { name: 'New Webhook' }).click()
      await alice.getByRole('list', { name: 'Webhooks' }).getByRole('listitem').first().waitFor()
      await closeSettings(alice)
      const hook = (await api(alice, 'GET', `/guilds/${ids.guild}/webhooks`)).body.find((w) => w.type === 1)
      check(hook?.token, `no incoming webhook with a token: ${JSON.stringify(hook)}`)
      const res = await fetch(`${BASE}/api/v9/webhooks/${hook.id}/${hook.token}?wait=true`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'deploy finished', username: 'CI Bot', embeds: [{ title: 'Build #7 passed', description: 'All **87** tests green', color: 0x2ecc71, fields: [{ name: 'Branch', value: 'main', inline: true }] }] }),
      })
      check(res.ok, `webhook execute answered ${res.status}`)
      const ch = (await res.json()).channel_id
      const name = (await api(alice, 'GET', `/channels/${ch}`)).body.name
      await channelLink(bob, name).click()
      const msg = message(bob, `#${name}`, 'deploy finished')
      await msg.waitFor(LIVE)
      await msg.getByText('CI Bot').first().waitFor()
      await msg.locator('.bot-tag').filter({ hasText: /BOT|APP/ }).waitFor()
      await msg.getByRole('article', { name: 'Embed: Build #7 passed' }).getByRole('term').filter({ hasText: 'Branch' }).waitFor()
      await channelLink(bob, 'general').click()
    })

    // ---- 14. Community ----
    await step('14. welcome screen, rules screening and a vanity URL: Carol joins via /invite/<vanity>, sees the welcome, accepts the rules, then talks', async () => {
      await openServerSettings(alice, 'Welcome Screen')
      await alice.getByRole('switch', { name: 'Show the welcome screen to new members' }).check()
      await alice.getByLabel(/Welcome Message/).fill('Welcome to the team server!')
      await alice.getByRole('button', { name: 'Add a Channel' }).click()
      await alice.getByLabel('Description for channel 1').fill('Say hello')
      await alice.getByRole('button', { name: 'Save Changes' }).click()
      await until('the welcome screen to be saved', async () => (await api(alice, 'GET', `/guilds/${ids.guild}/welcome-screen`)).body?.description === 'Welcome to the team server!')
      await alice.getByRole('tab', { name: 'Safety Setup' }).click()
      await alice.getByRole('switch', { name: 'Require new members to agree to the rules' }).check()
      if (await alice.getByLabel('Rule 1', { exact: true }).count() === 0) await alice.getByRole('button', { name: 'Add a rule' }).click()
      await alice.getByLabel('Rule 1', { exact: true }).fill('No cheating, no smurfing')
      await alice.getByRole('button', { name: 'Save Changes' }).click()
      await until('rules screening to be on', async () => (await api(alice, 'GET', `/guilds/${ids.guild}`)).body?.features?.includes('MEMBER_VERIFICATION_GATE_ENABLED'))
      await alice.getByRole('tab', { name: 'Vanity URL' }).click()
      await alice.getByLabel(/Invite Code/).fill(VANITY)
      await alice.getByRole('button', { name: 'Save Changes' }).click()
      await until('the vanity URL to be saved', async () => (await api(alice, 'GET', `/guilds/${ids.guild}/vanity-url`)).body?.code === VANITY)
      await closeSettings(alice)

      await carol.goto(`${BASE}/invite/${VANITY}`)
      await carol.getByRole('button', { name: 'Join' }).click()
      await ready(carol)
      const welcome = modal(carol, `Welcome to ${GUILD}!`)
      await welcome.getByText('Welcome to the team server!').waitFor()
      await welcome.getByRole('button', { name: 'Continue' }).click()
      await modal(carol, `${GUILD} Rules`).getByRole('button', { name: 'Not Now' }).click() // the rules follow the welcome
      await channelLink(carol, 'general').click()
      const complete = carol.getByRole('button', { name: 'Complete' })
      await complete.waitFor()
      const box = composer(carol, '#general')
      check((await box.count()) === 0 || (await box.isDisabled()), "Carol's composer is usable before accepting the rules")
      const r = await api(carol, 'POST', `/channels/${ids.general}/messages`, { content: 'hi before rules' })
      check(r.status === 403, `a pending member's send answered ${r.status}`)
      await complete.click()
      const rules = modal(carol, `${GUILD} Rules`)
      await rules.getByText('No cheating, no smurfing').waitFor()
      await rules.getByLabel('I have read and agree to the rules').check()
      await rules.getByRole('button', { name: 'Submit' }).click()
      await rules.waitFor({ state: 'detached' })
      await send(carol, '#general', 'hi all, rules accepted')
      await message(alice, '#general', 'hi all, rules accepted').waitFor(LIVE)
    })

    if (SHOTS) {
      await alice.setViewportSize({ width: 390, height: 844 })
      await sleep(500)
      await alice.screenshot({ path: path.join(SHOTS, 'v3-phone.png') })
      await alice.setViewportSize({ width: 1440, height: 900 })
    }

    // ---- 16. Update banner ----
    if (!STATIC) console.log('ok - 16. update banner # SKIP: set E2E_STATIC_DIR to the server\'s scratch STATIC_DIR')
    else await step('16. update banner: a new deploy (changed index.html) shows the banner, in voice with the disconnect warning; Reload loads it', async () => {
      const token = await alice.evaluate(() => localStorage.getItem('token'))
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone', 'camera'] }) // service workers allowed
      await ctx.addInitScript((t) => localStorage.getItem('token') || localStorage.setItem('token', t), token)
      const page = await ctx.newPage()
      watch(page, 'Alice (update)')
      const indexFile = path.join(STATIC, 'index.html')
      const original = fs.readFileSync(indexFile, 'utf8')
      try {
        await page.goto(`${BASE}/channels/${ids.guild}/${ids.general}`)
        await ready(page)
        await until('the service worker to control the page', () => page.evaluate(() => !!navigator.serviceWorker.controller), 10000)
        const bundle = original.match(/\/assets\/(index-[\w-]+)\.js/)[1]
        const next = `${bundle}x${SFX}`
        fs.copyFileSync(path.join(STATIC, 'assets', `${bundle}.js`), path.join(STATIC, 'assets', `${next}.js`))
        fs.writeFileSync(indexFile, original.replace(`/assets/${bundle}.js`, `/assets/${next}.js`))
        const banner = page.getByRole('status').filter({ hasText: 'A new version of Cillhub is available.' })
        check((await banner.count()) === 0, 'the banner shows before the deploy is noticed')
        await page.evaluate(() => dispatchEvent(new Event('focus')))
        await banner.waitFor(LIVE)
        await voiceRow(page).click()
        await banner.getByText('Reloading will disconnect you from voice.').waitFor({ timeout: 15000 })
        const loaded = page.waitForEvent('load')
        await banner.getByRole('button', { name: 'Reload' }).click()
        await loaded
        await ready(page)
        const src = await page.evaluate(() => document.querySelector('script[type="module"][src*="/assets/index-"]')?.getAttribute('src'))
        check(src?.includes(next), `after Reload the page runs ${src}, expected ${next}`)
        check((await banner.count()) === 0, 'the banner is still shown after reloading into the new version')
      } finally {
        fs.writeFileSync(indexFile, original)
        await ctx.close()
      }
    })

    await step('17. no uncaught page errors and no native dialogs', async () => {
      if (errors.length) throw new Error(errors.join('; '))
    })
  } catch {
    // step() already reported it; later steps depend on earlier ones
  } finally {
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
