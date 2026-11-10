// End-to-end check of the voice paths the earlier suites leave out, with real LiveKit: self and server deafen, a
// moderator moving someone between channels, user limits (and the MOVE_MEMBERS bypass), push-to-talk, AFK auto-move,
// soundboard playback for everyone else, a three-person group DM call with screen share (sent as H.264 where the browser can encode it; AV1 when
// chosen, with the H.264 fallback for a viewer who cannot decode AV1) and the stream-quality dialog,
// and the "animate emoji / stickers" settings.
// Run: NODE_PATH=<dir with playwright> E2E_BASE_URL=http://127.0.0.1:3320 node scripts/e2e-v5-voice.cjs
// The LiveKit checks need LIVEKIT_API_KEY and LIVEKIT_API_SECRET (and LIVEKIT_URL, default http://127.0.0.1:7880) in the
// environment, e.g. `set -a; . .env; set +a`. Usernames get a random suffix; use a throwaway instance (AFK needs the
// guild's shortest timeout, 60 s, so the run takes a few minutes). E2E_SCREENSHOTS=1 writes docs/screenshots/v5-voice-*.png.
// Headless Chromium plays no received audio, so "hears nothing" is checked where the client decides it: the gain
// livekit-client sets on every remote track (window.__gains), and the media elements soundboard sounds start (__played).
const { chromium } = require('playwright')
const { createHmac } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const BASE = (process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3320').replace(/\/$/, '')
const SHOTS = process.env.E2E_SCREENSHOTS ? path.join(__dirname, '..', 'docs', 'screenshots') : null
const LIVE = { timeout: 5000 }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const SFX = Math.random().toString(36).slice(2, 7)
const NAME = { alice: `Alice_${SFX}`, bob: `Bob_${SFX}`, carol: `Carol_${SFX}` }
const PASSWORD = 'correct horse battery'
const GUILD = `Voice Lab ${SFX}`

let failed = false
const errors = []
const pages = {}
const ids = {}

async function step(name, fn) {
  try {
    await fn()
    console.log(`ok - ${name}`)
  } catch (e) {
    const lines = String(e.message).split('\n')
    console.log(`not ok - ${name}\n  ${lines[0]}${lines.find((l) => /waiting for/.test(l))?.replace(/^.*?waiting for/, '\n  waiting for') ?? ''}`)
    failed = true
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

// Mono 48 kHz "speech" (as in e2e-v2): voiced harmonics in syllables, loud enough for LiveKit's speaker detection.
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

// LiveKit's own view of a room (RoomService.ListParticipants).
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
const inRoom = async (room, identity) => (await livekitParticipants(room)).some((p) => p.identity === identity)
const publishesMic = async (room, identity) =>
  (await livekitParticipants(room)).some((p) => p.identity === identity && (p.tracks ?? []).some((t) => t.source === 'MICROPHONE' && !t.muted))
async function micIs(room, identity, on, what, ms = 10000) {
  if (LK) await until(`LiveKit: ${what}`, async () => (await publishesMic(room, identity)) === on, ms)
}

// Runs in every page: records the remote-track gains livekit-client sets, soundboard plays, and toasts.
function instrument() {
  window.__gains = []
  const set = AudioParam.prototype.setTargetAtTime
  AudioParam.prototype.setTargetAtTime = function (v, t, c) {
    let e = window.__gains.find((g) => g.p === this)
    if (!e) window.__gains.push((e = { p: this }))
    e.v = v
    return set.call(this, v, t, c)
  }
  // a track's gain node is disconnected when it goes away (unsubscribed, left): its volume no longer counts
  const disconnect = AudioNode.prototype.disconnect
  AudioNode.prototype.disconnect = function (...args) {
    if (this instanceof GainNode && !args.length) for (const g of window.__gains) if (g.p === this.gain) g.dead = true
    return disconnect.apply(this, args)
  }
  // every peer connection, so a test can read how much remote audio actually arrives (getStats inbound-rtp)
  window.__pcs = []
  const PC = window.RTCPeerConnection
  window.RTCPeerConnection = function (...args) { const pc = new PC(...args); window.__pcs.push(pc); return pc }
  window.RTCPeerConnection.prototype = PC.prototype
  Object.setPrototypeOf(window.RTCPeerConnection, PC)
  window.__played = []
  const play = HTMLMediaElement.prototype.play
  HTMLMediaElement.prototype.play = function () {
    const rec = { src: this.currentSrc || this.src, at: Date.now() }
    if (/soundboard-sounds/.test(rec.src)) {
      window.__played.push(rec)
      this.addEventListener('timeupdate', () => (rec.progressed = this.currentTime > 0), { passive: true })
      this.addEventListener('ended', () => (rec.ended = true), { once: true })
    }
    return play.call(this)
  }
}
// Volumes livekit-client last set on remote audio (one per remote track); deafened means all 0.
const gains = (page) => page.evaluate(() => window.__gains.filter((g) => !g.dead).map((g) => g.v))
// Remote audio bytes received over all open peer connections (inbound-rtp, kind audio).
const audioBytes = (page) => page.evaluate(async () => {
  let n = 0
  for (const pc of window.__pcs) {
    if (pc.connectionState === 'closed') continue
    for (const r of (await pc.getStats()).values()) if (r.type === 'inbound-rtp' && r.kind === 'audio') n += r.bytesReceived ?? 0
  }
  return n
})
// Bytes of remote audio that arrive during ms (0 when nothing is delivered; a gone track can make it negative).
async function audioIn(page, ms = 2000) {
  const a = await audioBytes(page)
  await sleep(ms)
  return (await audioBytes(page)) - a
}
const sounds = (page) => page.evaluate(() => window.__played.map(({ src, progressed, ended }) => ({ src, progressed, ended })))

function watch(page, name) {
  pages[name] = page
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`))
  page.on('dialog', (d) => (errors.push(`${name}: unexpected native dialog "${d.message()}"`), d.dismiss()))
}
async function newUser(browser, name) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, permissions: ['microphone', 'camera'], serviceWorkers: 'block' })
  await ctx.addInitScript(instrument)
  const page = await ctx.newPage()
  watch(page, name)
  return page
}
async function ready(page) {
  await page.getByRole('navigation', { name: /^(Servers|Server)$/ }).waitFor()
  await until('the gateway to connect', async () => (await page.getByText(/Connecting…|Verbinde…/).count()) === 0, 10000)
}
async function register(page, name) {
  await page.goto(BASE + '/')
  await page.getByRole('link', { name: 'Register' }).click()
  await page.getByLabel('Email').fill(`${name.toLowerCase()}@example.com`)
  await page.getByLabel('Username').fill(name)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.waitForURL('**/channels/@me')
  await ready(page)
}
const api = (page, method, route, body) =>
  page.evaluate(async ([method, route, body]) => {
    const r = await fetch('/api/v9' + route, { method, headers: { Authorization: localStorage.getItem('token'), ...(body && { 'Content-Type': 'application/json' }) }, body: body && JSON.stringify(body) })
    return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }
  }, [method, route, body])
const ok = async (p) => { const r = await p; check(r.status < 300, `API answered ${r.status}: ${JSON.stringify(r.body)}`); return r.body }

const channels = (page) => page.getByRole('navigation', { name: `${GUILD} channels` })
const voiceRow = (page, name) => channels(page).getByRole('button', { name: new RegExp(`^${name} \\((voice|stage) channel`) })
// the connected-users list right under a voice channel row
const usersUnder = (page, name) => voiceRow(page, name).locator('xpath=ancestor::div[contains(@class,"row-wrap")]/following-sibling::ul[1]')
const voiceUser = (page, channel, user) => usersUnder(page, channel).getByRole('button', { name: new RegExp(user) })
const panel = (page) => page.getByRole('region', { name: 'Voice connection' })
const callPanel = (page) => page.getByRole('region', { name: 'Call' })
/** A row of the voice panel's connection details ('' while it is not shown); opens the details first. */
async function screenDetail(page, label) {
  const ping = panel(page).getByRole('button', { name: /Show connection details/ })
  if ((await ping.count()) && (await ping.getAttribute('aria-expanded')) !== 'true') await ping.click()
  const dt = panel(page).locator('.vp-stats dt', { hasText: label })
  return (await dt.count()) ? dt.locator('xpath=following-sibling::dd[1]').innerText() : ''
}
const modal = (page, name) => page.getByRole('dialog', { name })
const log = (page, label) => page.getByRole('log', { name: `Messages in ${label}` })
const speaking = (page, channel, user) => voiceUser(page, channel, user).locator('.sr-only', { hasText: 'speaking' }).count()
async function contextMenu(page, target, item) {
  await target.click({ button: 'right' })
  const menu = page.getByRole('menu')
  await menu.getByRole('menuitem', { name: item, exact: true }).or(menu.getByRole('menuitemcheckbox', { name: item, exact: true })).click()
}
async function openChannel(page, id) {
  await page.goto(`${BASE}/channels/${ids.guild}/${id}`)
  await ready(page)
}
async function join(page, name) {
  await voiceRow(page, name).click()
  await panel(page).getByRole('status').filter({ hasText: 'Voice Connected' }).waitFor({ timeout: 15000 })
}
const shot = async (page, name) => {
  if (!SHOTS) return
  await page.mouse.move(0, 0)
  await sleep(400)
  await page.screenshot({ path: path.join(SHOTS, `v5-voice-${name}.png`) })
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cillcord-e2e5v-'))
  const wav = path.join(tmp, 'speech.wav')
  fs.writeFileSync(wav, speechWav())
  // a 0.6 s Ogg/Opus beep for the soundboard and a two-frame GIF for the animated emoji and sticker
  const ff = (...args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args])
  ff('-f', 'lavfi', '-i', 'sine=frequency=880:duration=0.6', '-c:a', 'libopus', '-b:a', '32k', path.join(tmp, 'beep.ogg'))
  ff('-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=4:duration=1', '-loop', '0', path.join(tmp, 'spin.gif'))
  const dataUri = (file, type) => `data:${type};base64,${fs.readFileSync(path.join(tmp, file)).toString('base64')}`
  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`,
      '--autoplay-policy=no-user-gesture-required', '--auto-select-desktop-capture-source=Entire screen'],
  })
  try {
    const alice = await newUser(browser, 'alice')
    const bob = await newUser(browser, 'bob')
    const carol = await newUser(browser, 'carol')

    await step(`0. Alice, Bob and Carol register (suffix ${SFX}); Alice's server gets voice channels Lounge and AFK; all are friends`, async () => {
      await Promise.all([register(alice, NAME.alice), register(bob, NAME.bob), register(carol, NAME.carol)])
      for (const [k, p] of Object.entries({ alice, bob, carol })) ids[k] = (await ok(api(p, 'GET', '/users/@me'))).id
      const g = await ok(api(alice, 'POST', '/guilds', { name: GUILD }))
      ids.guild = g.id
      ids.general = g.channels.find((c) => c.name === 'general').id
      ids.voice = g.channels.find((c) => c.type === 2).id
      const parent = g.channels.find((c) => c.type === 2).parent_id
      ids.lounge = (await ok(api(alice, 'POST', `/guilds/${ids.guild}/channels`, { name: 'Lounge', type: 2, parent_id: parent }))).id
      ids.afk = (await ok(api(alice, 'POST', `/guilds/${ids.guild}/channels`, { name: 'AFK', type: 2, parent_id: parent }))).id
      const invite = await ok(api(alice, 'POST', `/channels/${ids.general}/invites`, { max_age: 0 }))
      for (const p of [bob, carol]) await ok(api(p, 'POST', `/invites/${invite.code}`))
      for (const [p, who] of [[bob, 'bob'], [carol, 'carol']]) {
        await ok(api(p, 'POST', '/users/@me/relationships', { username: NAME.alice }))
        await ok(api(alice, 'PUT', `/users/@me/relationships/${ids[who]}`, {}))
      }
      await ok(api(bob, 'POST', '/users/@me/relationships', { username: NAME.carol }))
      await ok(api(carol, 'PUT', `/users/@me/relationships/${ids.bob}`, {}))
      for (const p of [alice, bob, carol]) await openChannel(p, ids.general)
    })

    // ---- 1. Deafen ----
    await step('1a. Alice and Bob join General; each plays the other at full volume', async () => {
      await join(alice, 'General')
      await join(bob, 'General')
      for (const [n, p] of [['Alice', alice], ['Bob', bob]]) await until(`${n} to set a remote gain of 1`, async () => (await gains(p)).some((v) => v === 1), 15000)
      await until("Alice to see Bob speaking", () => speaking(alice, 'General', NAME.bob), 15000)
      await micIs(ids.voice, ids.bob, true, 'Bob publishes his mic')
    })

    await step('1b. Bob mutes, then deafens: no remote audio for him, mic stays off, Alice sees the deafened icon; undeafening keeps him muted', async () => {
      await panel(bob).waitFor()
      const muteBtn = bob.getByRole('region', { name: 'Your account' }).getByRole('button', { name: 'Mute', exact: true })
      const deafBtn = bob.getByRole('region', { name: 'Your account' }).getByRole('button', { name: 'Deafen', exact: true })
      await muteBtn.click()
      await micIs(ids.voice, ids.bob, false, "Bob's mic muted")
      await deafBtn.click()
      await voiceUser(alice, 'General', NAME.bob).getByRole('img', { name: 'Deafened' }).waitFor(LIVE)
      await until("Bob's remote gains to drop to 0", async () => { const g = await gains(bob); return g.length > 0 && g.every((v) => v === 0) })
      check((await muteBtn.getAttribute('aria-pressed')) === 'true', 'the mute button shows muted while deafened')
      await deafBtn.click()
      await voiceUser(alice, 'General', NAME.bob).getByRole('img', { name: 'Deafened' }).waitFor({ state: 'detached', ...LIVE })
      await until("Bob's remote gains back to 1", async () => (await gains(bob)).every((v) => v === 1))
      check((await muteBtn.getAttribute('aria-pressed')) === 'true', 'still muted after undeafening (he muted before deafening)')
      await voiceUser(alice, 'General', NAME.bob).getByRole('img', { name: 'Muted' }).waitFor(LIVE)
      await micIs(ids.voice, ids.bob, false, "Bob's mic still muted", 3000)
      // deafen from unmuted: undeafen unmutes again; unmuting while deafened undeafens
      await muteBtn.click()
      await micIs(ids.voice, ids.bob, true, "Bob's mic back")
      await deafBtn.click()
      await micIs(ids.voice, ids.bob, false, 'deafening mutes the mic')
      await until('gains 0', async () => (await gains(bob)).every((v) => v === 0))
      await muteBtn.click()
      check((await deafBtn.getAttribute('aria-pressed')) === 'false', 'unmuting undeafened')
      await until('gains 1', async () => (await gains(bob)).every((v) => v === 1))
      await micIs(ids.voice, ids.bob, true, "Bob's mic back after unmuting")
      await until("Alice to see Bob speaking again", () => speaking(alice, 'General', NAME.bob), 15000)
    })

    await step('1c. Alice server-deafens Bob: his mic is off and the media server delivers him no audio, not even from Carol joining; lifting it restores both live, without a rejoin', async () => {
      await until('Bob to receive Alice\'s audio before the deafen', async () => (await audioIn(bob, 1000)) > 1000, 10000)
      await contextMenu(alice, voiceUser(alice, 'General', NAME.bob), 'Server Deafen')
      await voiceUser(bob, 'General', NAME.bob).getByRole('img', { name: 'Server deafened' }).waitFor(LIVE)
      await micIs(ids.voice, ids.bob, false, "server deafen stops Bob's mic")
      await until('Alice to lose the speaking indicator for Bob', async () => (await speaking(alice, 'General', NAME.bob)) === 0, 10000)
      // enforced on the media server: no remote audio reaches Bob at all (LiveKit: no subscription; cillvoice: nothing forwarded)
      await until('no remote audio to reach Bob while server-deafened', async () => (await audioIn(bob, 1500)) <= 0, 10000)
      await join(carol, 'General')
      await voiceUser(bob, 'General', NAME.carol).waitFor(LIVE)
      await sleep(1500)
      check((await audioIn(bob, 3000)) <= 0, 'Bob receives audio while server-deafened (Alice speaking, Carol joined)')
      await shot(alice, 'server-deafen')
      await panel(carol).getByRole('button', { name: 'Disconnect' }).click()
      const session = await bob.evaluate(() => window.__pcs.length)
      await contextMenu(alice, voiceUser(alice, 'General', NAME.bob), 'Server Deafen')
      await voiceUser(bob, 'General', NAME.bob).getByRole('img', { name: 'Server deafened' }).waitFor({ state: 'detached', ...LIVE })
      await until("Alice's audio to reach Bob again after the server undeafen", async () => (await audioIn(bob, 1000)) > 1000, 15000)
      await until("Bob's remote gains back to 1", async () => (await gains(bob)).every((v) => v === 1))
      await micIs(ids.voice, ids.bob, true, "Bob's mic back after server undeafen")
      check((await bob.evaluate(() => window.__pcs.length)) === session, 'Bob did not rejoin (no new peer connection) to get audio back')
    })

    // ---- 2. Move ----
    await step('2. Alice moves Bob to Lounge: his client joins the Lounge room and leaves General; all sidebars update', async () => {
      await contextMenu(alice, voiceUser(alice, 'General', NAME.bob), 'Move to Lounge')
      for (const p of [alice, bob, carol]) {
        await voiceUser(p, 'Lounge', NAME.bob).waitFor(LIVE)
        await voiceUser(p, 'General', NAME.bob).waitFor({ state: 'detached', ...LIVE })
      }
      await panel(bob).getByRole('status').filter({ hasText: 'Voice Connected' }).waitFor({ timeout: 15000 })
      await panel(bob).getByText(/Lounge/).waitFor(LIVE)
      if (LK) {
        await until('LiveKit: Bob in the Lounge room', () => inRoom(ids.lounge, ids.bob), 10000)
        await until('LiveKit: Bob gone from General', async () => !(await inRoom(ids.voice, ids.bob)), 10000)
      }
      await micIs(ids.lounge, ids.bob, true, 'Bob publishes in Lounge')
      check(!(await bob.getByText('Lost the voice connection.').count()), 'no "Lost the voice connection" after the move')
    })

    // ---- 3. User limit ----
    await step('3. Lounge gets a limit of 1: Carol is refused with "This channel is full."; Alice (MOVE_MEMBERS) still joins', async () => {
      await ok(api(alice, 'PATCH', `/channels/${ids.lounge}`, { user_limit: 1 }))
      await voiceRow(carol, 'Lounge').filter({ hasText: '01/01' }).waitFor(LIVE)
      await voiceRow(carol, 'Lounge').click()
      await carol.getByRole('main').getByText('This channel is full.').waitFor(LIVE)
      await sleep(1500)
      check(!(await panel(carol).count()), 'Carol is not in voice')
      check(!(await voiceUser(alice, 'Lounge', NAME.carol).count()), 'nobody sees Carol in Lounge')
      await shot(carol, 'channel-full')
      await join(alice, 'Lounge')
      for (const p of [alice, bob, carol]) await voiceUser(p, 'Lounge', NAME.alice).waitFor(LIVE)
      await voiceRow(carol, 'Lounge').filter({ hasText: '02/01' }).waitFor(LIVE)
      if (LK) await until('LiveKit: Alice in Lounge', () => inRoom(ids.lounge, ids.alice), 10000)
    })

    // ---- 4. AFK settings, then push-to-talk (AFK fires 60 s after Bob's last input, checked in 5) ----
    await step('4a. Alice sets the inactive channel AFK with the shortest timeout (1 minute) in Server Settings', async () => {
      await alice.getByRole('button', { name: GUILD, exact: true }).click()
      await alice.getByRole('button', { name: 'Server Settings' }).click()
      await alice.getByLabel('Inactive Channel').selectOption({ label: 'AFK' })
      await alice.getByLabel('Inactive Timeout').selectOption('60')
      await alice.getByRole('button', { name: 'Save Changes' }).click()
      await until('the guild to have the AFK settings', async () => {
        const g = (await api(bob, 'GET', `/guilds/${ids.guild}`)).body
        return g.afk_channel_id === ids.afk && g.afk_timeout === 60
      })
      await alice.getByRole('button', { name: 'Close settings' }).click()
    })

    let lastBobInput = 0
    await step('4b. push-to-talk: Bob switches to Push to Talk; his mic publishes only while the key is held in the focused tab', async () => {
      await bob.getByRole('button', { name: 'User Settings' }).click()
      await bob.getByRole('tab', { name: 'Voice & Video', exact: true }).click()
      await bob.getByLabel('Push to Talk').check()
      await bob.getByRole('button', { name: 'Close settings' }).click()
      await micIs(ids.lounge, ids.bob, false, 'no mic in PTT mode while the key is up')
      await until('Alice to lose the speaking indicator for Bob', async () => (await speaking(alice, 'Lounge', NAME.bob)) === 0, 10000)
      await bob.bringToFront()
      await bob.keyboard.down('Backquote')
      await micIs(ids.lounge, ids.bob, true, 'mic on while the key is held')
      await until('Alice to see Bob speaking while he holds the key', () => speaking(alice, 'Lounge', NAME.bob), 15000)
      await bob.keyboard.up('Backquote')
      await micIs(ids.lounge, ids.bob, false, 'mic off when the key is released')
      // a held key is released when the tab loses focus
      await bob.keyboard.down('Backquote')
      await micIs(ids.lounge, ids.bob, true, 'mic on again')
      await bob.evaluate(() => window.dispatchEvent(new Event('blur')))
      await micIs(ids.lounge, ids.bob, false, 'mic off after the tab lost focus')
      await bob.keyboard.up('Backquote')
      // other keys do nothing
      await bob.keyboard.press('KeyQ')
      lastBobInput = Date.now()
      await sleep(1500)
      if (LK) check(!(await publishesMic(ids.lounge, ids.bob)), 'another key does not open the mic')
    })

    // ---- 5. Soundboard (while the AFK timer runs) ----
    await step('5a. soundboard: Alice, Bob and Carol meet in General; Alice plays a sound and both Bob and Carol play it to the end', async () => {
      const s = await ok(api(alice, 'POST', `/guilds/${ids.guild}/soundboard-sounds`, { name: 'beep', sound: dataUri('beep.ogg', 'audio/ogg'), emoji_name: '🔔' }))
      ids.sound = s.sound_id
      await join(alice, 'General')
      await join(carol, 'General')
      // Bob is moved back by Alice (his input clock keeps running: a move is no input)
      await contextMenu(alice, voiceUser(alice, 'Lounge', NAME.bob), 'Move to General')
      await panel(bob).getByText(/General/).waitFor(LIVE)
      await panel(bob).getByRole('status').filter({ hasText: 'Voice Connected' }).waitFor({ timeout: 15000 })
      await panel(alice).getByRole('button', { name: 'Soundboard' }).click()
      await modal(alice, 'Soundboard').getByRole('button', { name: 'Play beep' }).click()
      await alice.keyboard.press('Escape')
      for (const [n, p] of [['Bob', bob], ['Carol', carol]]) {
        await until(`${n} to play the sound to its end`, async () => (await sounds(p)).some((x) => x.src.includes(`/soundboard-sounds/${ids.sound}`) && x.ended), 8000)
      }
      for (const p of [bob, carol]) await voiceUser(p, 'General', NAME.alice).getByRole('img', { name: 'played a sound 🔔' }).waitFor(LIVE)
    })

    await step('5b. soundboard: a deafened listener does not play it', async () => {
      await carol.getByRole('region', { name: 'Your account' }).getByRole('button', { name: 'Deafen', exact: true }).click()
      const before = (await sounds(carol)).length
      const bobBefore = (await sounds(bob)).length
      await panel(alice).getByRole('button', { name: 'Soundboard' }).click()
      await modal(alice, 'Soundboard').getByRole('button', { name: 'Play beep' }).click()
      await alice.keyboard.press('Escape')
      await until('Bob to play it again', async () => (await sounds(bob)).length > bobBefore, 8000)
      await sleep(1000)
      check((await sounds(carol)).length === before, 'deafened Carol played the sound')
      await carol.getByRole('region', { name: 'Your account' }).getByRole('button', { name: 'Deafen', exact: true }).click()
    })

    await step('5c. AFK: 60 s after his last input, silent Bob (push-to-talk, key up) is moved to AFK by his client; everyone sees it', async () => {
      const wait = Math.max(0, lastBobInput + 60e3 - Date.now())
      await sleep(Math.max(0, wait - 3000))
      check(!(await voiceUser(alice, 'AFK', NAME.bob).count()), 'not moved before the timeout')
      for (const p of [alice, carol, bob]) await voiceUser(p, 'AFK', NAME.bob).waitFor({ timeout: 15000 })
      await panel(bob).getByText(/AFK/).waitFor(LIVE)
      await panel(bob).getByRole('status').filter({ hasText: 'Voice Connected' }).waitFor({ timeout: 15000 })
      if (LK) await until('LiveKit: Bob in the AFK room', () => inRoom(ids.afk, ids.bob), 10000)
      check(await voiceUser(alice, 'General', NAME.alice).count(), 'Alice (speaking) stays in General')
      await shot(carol, 'afk')
      for (const p of [alice, bob, carol]) await panel(p).getByRole('button', { name: 'Disconnect' }).click()
      // back to voice activity for Bob
      await bob.evaluate(() => { const s = JSON.parse(localStorage.getItem('voice-settings')); s.mode = 'vad'; localStorage.setItem('voice-settings', JSON.stringify(s)) })
    })

    // ---- 6. Group DM call with screen share ----
    await step('6a. Alice starts a call in a group DM with Bob and Carol; both accept; everyone hears the other two', async () => {
      const group = await ok(api(alice, 'POST', '/users/@me/channels', { recipients: [ids.bob, ids.carol] }))
      ids.group = group.id
      await bob.reload()
      await ready(bob)
      await alice.goto(`${BASE}/channels/@me/${group.id}`)
      await ready(alice)
      await alice.getByRole('button', { name: 'Start Voice Call' }).click()
      for (const p of [bob, carol]) {
        const ring = p.getByRole('alertdialog').filter({ hasText: 'Incoming Call' })
        await ring.waitFor({ timeout: 10000 })
        await ring.getByRole('button', { name: 'Accept' }).click()
        await p.waitForURL(`**/channels/@me/${group.id}`)
      }
      for (const p of [alice, bob, carol]) for (const n of Object.values(NAME)) await callPanel(p).getByRole('list', { name: 'Participants' }).getByText(n).waitFor({ timeout: 10000 })
      for (const [n, p] of [['Alice', alice], ['Bob', bob], ['Carol', carol]]) {
        await until(`${n} to have two live remote audio tracks at full volume`, async () => {
          const live = await p.evaluate(() => [...document.querySelectorAll('#voice-audio audio')].filter((a) => a.srcObject?.getAudioTracks().some((t) => t.readyState === 'live')).length)
          const g = await gains(p)
          return live >= 2 && g.filter((v) => v === 1).length >= 2
        }, 15000)
      }
      if (LK) await until('LiveKit: three in the group call room', async () => (await livekitParticipants(ids.group)).length === 3, 10000)
    })

    const screenTrack = (page) => page.evaluate(() => {
      // the sharer sees a "You are sharing your screen" card instead of a self-view: read the captured track itself
      const own = window.__e2eScreen?.getVideoTracks()[0]
      if (own) return { ...own.getSettings(), contentHint: own.contentHint }
      for (const v of document.querySelectorAll('video')) {
        const t = v.srcObject?.getVideoTracks?.()[0]
        if (t && (t.label.includes('screen') || /screen|window|tab|desktop/i.test(t.label) || t.getSettings().displaySurface)) return { ...t.getSettings(), contentHint: t.contentHint }
      }
      return null
    })
    await step('6b. Alice shares her screen through the Go Live dialog (720p, 15 FPS, Clarity); Bob and Carol see the stream playing', async () => {
      await alice.evaluate(() => {
        const md = navigator.mediaDevices, gdm = md.getDisplayMedia.bind(md)
        md.getDisplayMedia = async (c) => (window.__e2eScreen = await gdm(c))
      })
      await callPanel(alice).getByRole('button', { name: 'Share Your Screen' }).click()
      const dialog = modal(alice, 'Screen Share')
      await dialog.getByLabel('720p').check()
      await dialog.getByLabel('15 FPS').check()
      await dialog.getByLabel('Clarity').check()
      await dialog.getByRole('button', { name: 'Go Live' }).click()
      for (const p of [bob, carol]) {
        await until('a playing screen share tile', () => callPanel(p).locator('video').evaluateAll((vs) => vs.some((v) => v.videoWidth > 0 && !v.paused)), 20000)
      }
      let cap = null
      await until("Alice's screen capture at most 1280x720, 15 FPS, detail", async () => {
        const s = (cap = await screenTrack(alice))
        return s && s.height <= 720 && s.width <= 1280 && s.frameRate <= 15 && s.contentHint === 'detail'
      }, 10000).catch((e) => { throw new Error(`${e.message}; last capture ${JSON.stringify(cap)}`) })
      await shot(bob, 'group-call-screen')
    })

    await step("6b2. the screen share goes out as H.264 when the browser can encode it: Alice's connection details show the H.264 encoder, Bob's and Carol's the H.264 decoder", async () => {
      let enc = ''
      await until("Alice's encoder line to say H.264", async () => /^H\.264/.test((enc = await screenDetail(alice, 'Screen share encoder'))), 15000)
      for (const [n, p] of [['Bob', bob], ['Carol', carol]]) {
        let dec = ''
        await until(`${n}'s decoder line to say H.264`, async () => /^H\.264/.test((dec = await screenDetail(p, 'Screen share decoder'))), 15000)
        console.log(`  ${n} decoder: ${dec}`)
      }
      console.log(`  Alice encoder: ${enc} (${await screenDetail(alice, 'Screen share sent')})`)
    })

    await step('6c. Stream Quality while live: Alice switches to 1080p / 30 FPS / Motion without restarting the share', async () => {
      const before = await screenTrack(alice)
      await callPanel(alice).getByRole('button', { name: 'Stream Quality' }).click()
      const dialog = modal(alice, 'Stream Quality')
      await dialog.getByLabel('1080p').check()
      await dialog.getByLabel('30 FPS').check()
      await dialog.getByLabel('Motion').check()
      await dialog.getByRole('button', { name: 'Apply' }).click()
      await until('the capture to follow: up to 1080p at 30 FPS, motion', async () => {
        const s = await screenTrack(alice)
        return s && s.frameRate > 15 && s.frameRate <= 30 && s.contentHint === 'motion' && s.deviceId === before.deviceId
      }, 10000)
      check(!(await alice.getByText("Couldn't change the stream quality", { exact: false }).count()), 'no stream quality error')
      for (const p of [bob, carol]) await until('the stream still plays', () => callPanel(p).locator('video').evaluateAll((vs) => vs.some((v) => v.videoWidth > 0 && !v.paused)), 10000)
      const saved = await alice.evaluate(() => JSON.parse(localStorage.getItem('voice-settings')).stream)
      check(saved.resolution === '1080' && saved.fps === 30 && saved.mode === 'motion', `saved quality ${JSON.stringify(saved)}`)
      check(/^H\.264/.test(await screenDetail(alice, 'Screen share encoder')), 'still H.264 after the quality change')
    })

    await step('6c2. AV1 chosen: Carol leaves; Alice picks AV1 as Screen Share Encoder and shares again; her encoder and Bob\'s decoder say AV1', async () => {
      await callPanel(carol).getByRole('button', { name: 'Leave Call' }).click()
      await panel(carol).waitFor({ state: 'detached', ...LIVE })
      await alice.getByRole('button', { name: 'User Settings' }).click()
      await alice.getByRole('tab', { name: 'Voice & Video' }).click()
      await alice.getByLabel('Screen Share Encoder').selectOption('av1')
      await alice.getByRole('button', { name: 'Close settings' }).click()
      await callPanel(alice).getByRole('button', { name: 'Share Your Screen' }).click() // stop
      await until('the screen tile to go', async () => !(await callPanel(bob).locator('video').evaluateAll((vs) => vs.some((v) => v.videoWidth > 0))), 10000)
      await callPanel(alice).getByRole('button', { name: 'Share Your Screen' }).click()
      await modal(alice, 'Screen Share').getByRole('button', { name: 'Go Live' }).click()
      await until('a playing screen share tile for Bob', () => callPanel(bob).locator('video').evaluateAll((vs) => vs.some((v) => v.videoWidth > 0 && !v.paused)), 20000)
      let enc = '', dec = ''
      await until("Alice's encoder line to say AV1", async () => /^AV1/.test((enc = await screenDetail(alice, 'Screen share encoder'))), 15000)
      await until("Bob's decoder line to say AV1", async () => /^AV1/.test((dec = await screenDetail(bob, 'Screen share decoder'))), 15000)
      console.log(`  Alice encoder: ${enc}; Bob decoder: ${dec}`)
    })

    await step("6c3. a viewer without AV1: Carol's browser cannot decode it and she joins again; she and Bob get the H.264 fallback and the stream plays", async () => {
      // LiveKit decides by browser: it sends no AV1 to any Safari (its client rules), so Carol gets a Safari user agent; cillvoice
      // decides by SDP: no AV1 in what she offers to receive (and none in offers she receives)
      const cdp = await carol.context().newCDPSession(carol)
      await cdp.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15' })
      await carol.reload()
      await ready(carol)
      await carol.evaluate(() => {
        const strip = (sdp) => {
          const av1 = [...sdp.matchAll(/a=rtpmap:(\d+) AV1\/90000/g)].map((m) => m[1])
          const gone = new Set([...av1, ...[...sdp.matchAll(/a=fmtp:(\d+) apt=(\d+)/g)].filter((m) => av1.includes(m[2])).map((m) => m[1])])
          return sdp.split('\r\n').filter((l) => !gone.has(/^a=(?:rtpmap|fmtp|rtcp-fb):(\d+) /.exec(l)?.[1]))
            .map((l) => (l.startsWith('m=video') ? l.split(' ').filter((x, i) => i < 3 || !gone.has(x)).join(' ') : l)).join('\r\n')
        }
        const P = RTCPeerConnection.prototype
        const srd = P.setRemoteDescription
        P.setRemoteDescription = function (d, ...r) { return srd.call(this, d?.type === 'offer' ? { type: 'offer', sdp: strip(d.sdp) } : d, ...r) }
        const add = P.addTransceiver
        P.addTransceiver = function (kind, init, ...r) {
          const t = add.call(this, kind, init, ...r)
          if (kind === 'video' && init?.direction === 'recvonly') t.setCodecPreferences(RTCRtpReceiver.getCapabilities('video').codecs.filter((c) => c.mimeType !== 'video/AV1'))
          return t
        }
      })
      await callPanel(carol).getByRole('button', { name: 'Join Call' }).click()
      await until('a playing screen share tile for Carol', () => callPanel(carol).locator('video').evaluateAll((vs) => vs.some((v) => v.videoWidth > 0 && !v.paused)), 30000)
      for (const [n, p] of [['Carol', carol], ['Bob', bob]]) {
        let dec = ''
        await until(`${n}'s decoder line to say H.264`, async () => /^H\.264/.test((dec = await screenDetail(p, 'Screen share decoder'))), 20000)
        console.log(`  ${n} decoder: ${dec}`)
      }
      for (const p of [bob, carol]) await until('the stream still plays', () => callPanel(p).locator('video').evaluateAll((vs) => vs.some((v) => v.videoWidth > 0 && !v.paused)), 10000)
      console.log(`  Alice encoder: ${await screenDetail(alice, 'Screen share encoder')}`)
    })

    await step('6d. Alice stops sharing and everyone leaves the call', async () => {
      await callPanel(alice).getByRole('button', { name: 'Share Your Screen' }).click()
      for (const p of [bob, carol]) await until('the screen tile to go', async () => !(await callPanel(p).locator('video').evaluateAll((vs) => vs.some((v) => v.videoWidth > 0))), 10000)
      for (const p of [alice, bob, carol]) await callPanel(p).getByRole('button', { name: 'Leave Call' }).click()
      for (const p of [alice, bob, carol]) await panel(p).waitFor({ state: 'detached', ...LIVE })
    })

    // ---- 7. Animated emoji and stickers follow the settings ----
    await step('7. animate settings: Alice posts an animated emoji and sticker; Bob sees them still until hover (emoji) or never (sticker)', async () => {
      const emoji = await ok(api(alice, 'POST', `/guilds/${ids.guild}/emojis`, { name: `spin${SFX}`, image: dataUri('spin.gif', 'image/gif') }))
      check(emoji.animated, 'the GIF emoji is animated')
      const sticker = await alice.evaluate(async ([guild, gif]) => {
        const f = new FormData()
        f.set('name', 'spinner'); f.set('tags', 'spin')
        f.set('file', new Blob([Uint8Array.from(atob(gif), (c) => c.charCodeAt(0))], { type: 'image/gif' }), 'spin.gif')
        const r = await fetch(`/api/v9/guilds/${guild}/stickers`, { method: 'POST', headers: { Authorization: localStorage.getItem('token') }, body: f })
        return r.json()
      }, [ids.guild, fs.readFileSync(path.join(tmp, 'spin.gif')).toString('base64')])
      check(sticker.format_type === 4, `sticker ${JSON.stringify(sticker)}`)
      await ok(api(bob, 'PATCH', '/users/@me/settings', { animate_emoji: false, animate_stickers: 2 }))
      for (const p of [alice, bob]) await openChannel(p, ids.general)
      await ok(api(alice, 'POST', `/channels/${ids.general}/messages`, { content: `party <a:spin${SFX}:${emoji.id}>`, sticker_ids: [sticker.id] }))
      const em = (p) => log(p, '#general').locator('li.msg').filter({ hasText: 'party' }).locator('img.emoji.custom')
      const st = (p) => log(p, '#general').locator('li.msg').last().locator('img.sticker')
      await em(alice).waitFor(LIVE)
      check((await em(alice).getAttribute('data-motion')) === 'playing' && /\.gif$/.test(await em(alice).getAttribute('src')), 'Alice (always) sees the emoji play')
      check((await st(alice).getAttribute('data-motion')) === 'playing', 'Alice (always) sees the sticker play')
      await until("Bob's emoji to be a still frame", async () => (await em(bob).getAttribute('data-motion')) === 'still' && (await em(bob).getAttribute('src')).startsWith('data:image/png'))
      await until("Bob's sticker to be a still frame", async () => (await st(bob).getAttribute('data-motion')) === 'still' && (await st(bob).getAttribute('src')).startsWith('data:image/png'))
      await em(bob).hover()
      await until('the emoji to play on hover', async () => (await em(bob).getAttribute('data-motion')) === 'playing' && /\.gif$/.test(await em(bob).getAttribute('src')))
      await st(bob).hover()
      await until('the emoji to stop when the pointer leaves', async () => (await em(bob).getAttribute('data-motion')) === 'still')
      check((await st(bob).getAttribute('data-motion')) === 'still', '"never" does not animate the sticker on hover')
      // the Appearance page shows the saved choices
      await bob.getByRole('button', { name: 'User Settings' }).click()
      await bob.getByRole('tab', { name: 'Accessibility', exact: true }).click()
      check(!(await bob.getByRole('switch', { name: 'Play animated emoji' }).isChecked()), 'the emoji switch is off')
      check((await bob.getByLabel('Sticker Animation').inputValue()) === '2', 'sticker select shows Never')
      await bob.getByLabel('Sticker Animation').selectOption('1')
      await bob.getByRole('button', { name: 'Close settings' }).click()
      await until('stickers now animate on hover', async () => { await st(bob).hover(); return (await st(bob).getAttribute('data-motion')) === 'playing' })
    })

    await step('8. no uncaught page errors and no native dialogs', async () => {
      check(errors.length === 0, errors.join('\n'))
    })
  } catch {
    // step() already reported it
  } finally {
    await browser.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  if (failed) process.exitCode = 1
}

main()
