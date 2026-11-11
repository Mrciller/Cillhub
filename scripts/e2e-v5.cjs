// End-to-end check of the v5 features with Alice, Bob, Carol and Dave in real browsers against a
// running server that serves client/dist and has LiveKit configured.
// Run: NODE_PATH=<dir with playwright> E2E_BASE_URL=http://127.0.0.1:3300 node scripts/e2e-v5.cjs
// Usernames get a random suffix, so any database works (use a throwaway instance). E2E_SCREENSHOTS=1 also writes
// docs/screenshots/v5-*.png; E2E_FAIL_SHOTS=<dir> saves every page when a step fails.
// Watch Together: YouTube refuses playback from this server's network ("confirm you're not a bot", embed error 150), so
// the IFrame API script is replaced by a clock-driven stand-in with the same player methods (window.__players); the
// session state, its sync math and every control go through the real server. E2E_REAL_YOUTUBE=1 keeps the real API.
// Game activity: Dave's page gets a fake desktop bridge (window.cillcordDesktop) that reports "Counter-Strike 2".
const { chromium } = require('playwright')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const BASE = (process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3300').replace(/\/$/, '')
const SHOTS = process.env.E2E_SCREENSHOTS ? path.join(__dirname, '..', 'docs', 'screenshots') : null
const LIVE = { timeout: 5000 } // live updates must arrive within 5 s, without reload
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const SFX = Math.random().toString(36).slice(2, 7)
const NAME = { alice: `Alice_${SFX}`, bob: `Bob_${SFX}`, carol: `Carol_${SFX}`, dave: `Dave_${SFX}` }
const PASSWORD = 'correct horse battery'
const GUILD = `Squad HQ ${SFX}`
const VIDEO1 = 'https://www.youtube.com/watch?v=M7lc1UVf-VE'
const VIDEO2 = 'https://youtu.be/aqz-KE-bpKQ'

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

// Stand-in for https://www.youtube.com/iframe_api: the IFrame Player methods the client uses, playing on the wall clock.
const FAKE_YT = `(() => {
  const all = (window.__players = [])
  window.YT = { Player: class {
    constructor(el, o) {
      this.o = o; this.vid = o.videoId; this.base = (o.playerVars && o.playerVars.start) || 0; this.since = Date.now(); this.st = -1; this.rate = 1; this.el = el
      el.style.cssText = 'width:100%;height:100%;display:grid;place-items:center;background:linear-gradient(135deg,#1f2a44,#3b1f44);color:#fff;font:600 22px system-ui'
      all.push(this); this._draw()
      this.timer = setInterval(() => this._draw(), 250)
      setTimeout(() => { o.events.onReady && o.events.onReady({ target: this }); if (o.playerVars && o.playerVars.autoplay) this.playVideo() }, 50)
    }
    _draw() { const s = Math.floor(this._t()); this.el.textContent = '\\u25B6 ' + this.vid + '  ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') + (this.st === 2 ? '  (paused)' : '') }
    _t() { return this.st === 1 ? this.base + ((Date.now() - this.since) / 1000) * this.rate : this.base }
    _state(st) { this.base = this._t(); this.since = Date.now(); this.st = st; this.o.events.onStateChange && this.o.events.onStateChange({ data: st }) }
    loadVideoById(x) { this.vid = x.videoId; this.base = x.startSeconds || 0; this.since = Date.now(); this.st = -1; this._state(1) }
    playVideo() { if (this.st !== 1) this._state(1) }
    pauseVideo() { if (this.st === 1) this._state(2) }
    seekTo(s) { this.base = s; this.since = Date.now() }
    getCurrentTime() { return this._t() } getDuration() { return 600 } getPlayerState() { return this.st }
    getPlaybackRate() { return this.rate } setPlaybackRate(r) { this.base = this._t(); this.since = Date.now(); this.rate = r }
    setVolume(v) { this.volume = v } mute() { this.muted = true } unMute() { this.muted = false }
    destroy() { clearInterval(this.timer); const i = all.indexOf(this); if (i >= 0) all.splice(i, 1) }
  } }
  window.onYouTubeIframeAPIReady && window.onYouTubeIframeAPIReady()
})()`

// Every toast text ever shown, so short-lived toasts can be checked later; and the AudioWorklet processors created.
function recordToasts() {
  if (typeof AudioWorkletNode === 'function') {
    const Base = AudioWorkletNode
    window.__worklets = []
    window.AudioWorkletNode = class extends Base { constructor(c, name, o) { super(c, name, o); window.__worklets.push(name) } }
  }
  window.__toasts = []
  new MutationObserver(() => {
    for (const el of document.querySelectorAll('.toast')) if (!el.__seen) (el.__seen = true), window.__toasts.push(el.textContent)
  }).observe(document, { childList: true, subtree: true })
}

function watch(page, name) {
  pages[name] = page
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`))
  page.on('dialog', (d) => (errors.push(`${name}: unexpected native dialog "${d.message()}"`), d.dismiss()))
}

async function newUser(browser, name) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, permissions: ['microphone', 'camera'], serviceWorkers: 'block', acceptDownloads: true })
  if (!process.env.E2E_REAL_YOUTUBE) await ctx.route('https://www.youtube.com/iframe_api', (r) => r.fulfill({ contentType: 'text/javascript', body: FAKE_YT }))
  await ctx.addInitScript(recordToasts)
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

const log = (page, label) => page.getByRole('log', { name: `Messages in ${label}` })
const message = (page, label, text) => log(page, label).locator('li.msg').filter({ hasText: text })
const rail = (page) => page.getByRole('navigation', { name: /^(Servers|Server)$/ })
const railGuild = (page, guild = GUILD) => rail(page).getByRole('link', { name: new RegExp(`^${guild}`) })
const channels = (page, guild = GUILD) => page.getByRole('navigation', { name: `${guild} channels` })
const channelLink = (page, name) => channels(page).getByRole('link', { name: new RegExp(`^${name}\\b`) })
const voiceRow = (page) => channels(page).getByRole('button', { name: /^General \(voice channel/ })
const voiceItem = (page) => channels(page) // the Watching and status lines sit under the voice channel row
const voiceUser = (page, name) => channels(page).getByRole('list', { name: 'Connected users' }).getByRole('button', { name: new RegExp(name) })
const composer = (page, label) => page.getByRole('textbox', { name: `Message ${label}` })
const members = (page) => page.getByRole('complementary', { name: 'Members' })
const modal = (page, name) => page.getByRole('dialog', { name })
const dmList = (page) => page.getByRole('navigation', { name: 'Direct messages' })
const watchPanel = (page) => page.getByRole('region', { name: 'Watch Together' })
const toasts = (page) => page.evaluate(() => window.__toasts)
const player = (page) => page.evaluate(() => { const p = window.__players?.[0]; return p ? { vid: p.vid, t: p._t(), st: p.st } : null })
const players = async (a, b) => { const [x, y] = await Promise.all([player(a), player(b)]); return [x, y] }
const liveRemoteAudio = (page) =>
  page.evaluate(() => [...document.querySelectorAll('#voice-audio audio')].filter((a) => a.srcObject?.getAudioTracks().some((t) => t.readyState === 'live')).length)

async function send(page, label, text) {
  const box = composer(page, label)
  await box.fill(text)
  await box.press('Enter')
}
async function openChannel(page, name) {
  await page.goto(`${BASE}/channels/${ids.guild}/${ids[name]}`)
  await ready(page)
  await page.getByRole('heading', { level: 1, name }).waitFor()
}
async function serverSettings(page, tab) {
  if (!page.url().includes(`/channels/${ids.guild}/`)) await openChannel(page, 'general')
  await page.getByRole('button', { name: GUILD, exact: true }).click()
  await page.getByRole('button', { name: 'Server Settings' }).click()
  await page.getByRole('tab', { name: tab, exact: true }).click()
}
const closeSettings = (page) => page.getByRole('button', { name: 'Close settings' }).click()
async function joinVoice(page) {
  await voiceRow(page).click()
  await page.getByRole('status').filter({ hasText: 'Voice Connected' }).waitFor({ timeout: 15000 })
}
const leaveVoice = (page) => page.getByRole('region', { name: 'Voice connection' }).getByRole('button', { name: 'Disconnect' }).click()
const shot = async (page, name) => {
  if (!SHOTS) return
  await page.mouse.move(0, 0)
  await until('toasts to clear before the screenshot', async () => (await page.locator('.toast').count()) === 0, 10000).catch(() => {})
  await sleep(500)
  await page.screenshot({ path: path.join(SHOTS, `v5-${name}.png`) })
}
// Runs a slash command from the composer's command picker, filling options by name (optional ones are added first).
async function slash(page, label, name, options = {}) {
  const box = composer(page, label)
  await box.fill(`/${name}`)
  await page.getByRole('listbox', { name: 'Commands' }).getByRole('option', { name: new RegExp(`^/${name}\\b`) }).waitFor(LIVE)
  await box.press('Enter')
  const form = page.getByRole('group', { name: `Command /${name}` })
  await form.waitFor()
  for (const [k, v] of Object.entries(options)) {
    const pill = form.getByRole('button', { name: `+ ${k}`, exact: true })
    if (await pill.count()) await pill.click()
    await form.getByLabel(new RegExp(`^${k}`)).fill(String(v))
  }
  await form.getByRole('button', { name: 'Send' }).click()
}
const card = (page, label, title) => log(page, label).locator('li.msg').filter({ has: page.locator('article.bot-card', { hasText: title }) })
// Fills a datetime-local input (minute precision) with a local time.
const localInput = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 16)

const ids = {}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cillcord-e2e5-'))
  const wav = path.join(tmp, 'speech.wav')
  fs.writeFileSync(wav, speechWav())
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required'] })
  try {
    const alice = await newUser(browser, 'Alice')
    const bob = await newUser(browser, 'Bob')
    const carol = await newUser(browser, 'Carol')
    let T1 // when the scheduled messages and the reminder fall due

    await step(`0. Alice, Bob and Carol register (suffix ${SFX}); Alice creates a server with a Staff role and #plans, Bob and Carol join`, async () => {
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
      ids.voice = chans.find((c) => c.type === 2).id
      ids.staff = (await ok(api(alice, 'POST', `/guilds/${ids.guild}/roles`, { name: 'Staff', color: 0x3498db, hoist: true, permissions: '268435456' }))).id
      const plans = await ok(api(alice, 'POST', `/guilds/${ids.guild}/channels`, { name: 'plans', type: 0, parent_id: chans.find((c) => c.name === 'Text Channels')?.id }))
      ids.plans = plans.id
      await ok(api(alice, 'PUT', `/channels/${ids.plans}/permissions/${ids.staff}`, { type: 0, allow: '8192', deny: '0' }))
      const invite = await ok(api(alice, 'POST', `/channels/${ids.general}/invites`, { max_age: 0 }))
      for (const p of [bob, carol]) {
        await p.goto(`${BASE}/invite/${invite.code}`)
        await p.getByRole('button', { name: 'Join' }).click()
        await ready(p)
      }
    })

    // ---- 1. Send later and Remind me (set up now, checked when due in step 6) ----
    await step('1a. Send later: Alice schedules two messages in #plans and Bob one; Alice edits one (text and time) and cancels another', async () => {
      T1 = new Date(Math.ceil((Date.now() + 80e3) / 60e3) * 60e3)
      for (const p of [alice, bob]) await openChannel(p, 'plans')
      const schedule = async (page, text) => {
        await composer(page, '#plans').fill(text)
        await page.getByRole('button', { name: 'Send later' }).click()
        const later = modal(page, 'Send Later')
        await later.getByLabel('Date and time').fill(localInput(T1))
        await later.getByRole('button', { name: 'Schedule Message' }).click()
        await later.waitFor({ state: 'detached' })
        check((await composer(page, '#plans').inputValue()) === '', 'the composer is cleared after scheduling')
      }
      await schedule(alice, `scrim plan ${SFX}`)
      await schedule(alice, `typo ${SFX}`)
      await schedule(alice, `never sent ${SFX}`)
      await schedule(bob, `bob later ${SFX}`)
      await alice.getByRole('button', { name: 'Inbox' }).click()
      const inbox = modal(alice, 'Inbox')
      await inbox.getByRole('tab', { name: 'Scheduled' }).click()
      const list = inbox.getByRole('list', { name: 'Scheduled messages' })
      await list.getByRole('listitem').nth(2).waitFor()
      const typo = list.getByRole('listitem').filter({ hasText: `typo ${SFX}` })
      await typo.getByRole('button', { name: 'Edit' }).click()
      const form = inbox.getByRole('form', { name: 'Edit Scheduled Message' })
      await form.getByLabel('Message').fill(`fixed text ${SFX}`)
      await form.getByLabel('Date and time').fill(localInput(T1))
      await form.getByRole('button', { name: 'Save' }).click()
      await list.getByRole('listitem').filter({ hasText: `fixed text ${SFX}` }).waitFor()
      const never = list.getByRole('listitem').filter({ hasText: `never sent ${SFX}` })
      await never.getByRole('button', { name: 'Cancel scheduled message' }).click()
      await never.getByRole('button', { name: 'Cancel Message' }).click()
      await never.waitFor({ state: 'detached' })
      const mine = await ok(api(alice, 'GET', '/users/@me/scheduled-messages'))
      check(mine.length === 2 && mine.every((m) => m.channel_id === ids.plans && Date.parse(m.send_at) === T1.getTime()), `Alice's scheduled list: ${JSON.stringify(mine)}`)
      check(mine.some((m) => m.content === `fixed text ${SFX}`), 'the edit was saved')
      await shot(alice, 'scheduled')
      await alice.keyboard.press('Escape')
    })

    await step('1b. Bob loses SEND_MESSAGES in #plans before his scheduled message is due', async () => {
      await ok(api(alice, 'PUT', `/channels/${ids.plans}/permissions/${ids.bob}`, { type: 1, allow: '0', deny: '2048' }))
      await composer(bob, '#plans').waitFor({ state: 'detached', ...LIVE }).catch(() => {}) // the composer goes read-only
    })

    await step('1c. Remind me: Carol sets a custom reminder on a message in #general; it is listed in her inbox', async () => {
      await openChannel(alice, 'general')
      await send(alice, '#general', `remember the scrim ${SFX}`)
      await openChannel(carol, 'general')
      const msg = message(carol, '#general', `remember the scrim ${SFX}`)
      await msg.waitFor(LIVE)
      await msg.click({ button: 'right' })
      await carol.getByRole('menu', { name: 'Message actions' }).getByRole('menuitem', { name: 'Remind Me' }).click()
      await carol.getByRole('menu', { name: 'Remind Me' }).getByRole('menuitem', { name: 'Custom…' }).click()
      const dialog = modal(carol, 'Remind Me')
      await dialog.getByLabel('Date and time').fill(localInput(T1))
      await dialog.getByRole('button', { name: 'Set Reminder' }).click()
      await dialog.waitFor({ state: 'detached' })
      const saved = await ok(api(carol, 'GET', '/users/@me/saved-messages'))
      check(saved.results.length === 1 && Date.parse(saved.results[0].save_data.due_at) === T1.getTime() && saved.results[0].message?.content === `remember the scrim ${SFX}`, `saved messages: ${JSON.stringify(saved.results.map((r) => r.save_data))}`)
      await carol.getByRole('button', { name: 'Inbox' }).click()
      const inbox = modal(carol, 'Inbox')
      await inbox.getByRole('tab', { name: 'Reminders' }).click()
      await inbox.getByRole('list', { name: 'Reminders' }).getByRole('listitem').filter({ hasText: `remember the scrim ${SFX}` }).waitFor()
      check((await inbox.locator('.reminder-badge').count()) === 0, 'not due yet')
      await carol.keyboard.press('Escape')
    })

    // ---- 2. Voice: enhanced noise suppression, Watch Together, voice status ----
    await step('2a. Enhanced noise suppression: Alice picks "Enhanced (RNNoise)" and joins voice; RNNoise loads, Bob receives her audio and sees her speaking', async () => {
      await alice.getByRole('button', { name: 'User Settings' }).click()
      await alice.getByRole('tab', { name: 'Voice & Video', exact: true }).click()
      await alice.getByLabel('Noise Suppression').selectOption('enhanced')
      await closeSettings(alice)
      const wasm = alice.waitForRequest((r) => /rnnoise.*\.wasm/.test(r.url()), { timeout: 15000 })
      await joinVoice(alice)
      await wasm
      await until('an RNNoise AudioWorkletNode in the mic chain', async () => (await alice.evaluate(() => window.__worklets)).some((n) => /rnnoise/i.test(n)), 10000)
      await joinVoice(bob)
      await until('Bob to have a live remote <audio> from Alice', async () => (await liveRemoteAudio(bob)) >= 1, 15000)
      await until("Bob's sidebar to show Alice speaking (her audio passes RNNoise)", () => voiceUser(bob, NAME.alice).locator('.sr-only', { hasText: 'speaking' }).count(), 15000)
      check((await alice.getByText('Enhanced noise suppression is unavailable', { exact: false }).count()) === 0, 'no fallback note')
      const mode = await alice.evaluate(() => JSON.parse(localStorage.getItem('voice-settings')).noiseSuppression)
      check(mode === 'enhanced', `stored mode ${mode}`)
    })

    let title1 = ''
    await step('2b. Watch Together: Alice starts a video from the voice view; Bob gets the same player and Carol (not connected) sees "Watching:" under the channel', async () => {
      await alice.getByRole('button', { name: 'Watch Together' }).click()
      await watchPanel(alice).getByLabel('YouTube link').fill(VIDEO1)
      await watchPanel(alice).getByRole('button', { name: 'Start Watching' }).click()
      await until('both players to load M7lc1UVf-VE and play', async () => {
        const [a, b] = await players(alice, bob)
        return a?.vid === 'M7lc1UVf-VE' && b?.vid === 'M7lc1UVf-VE' && a.st === 1 && b.st === 1
      }, 10000)
      const s = await ok(api(carol, 'GET', `/channels/${ids.voice}/watch`))
      check(s.host_id === ids.alice && s.current.video_id === 'M7lc1UVf-VE' && s.control === 'host', `session: ${JSON.stringify(s)}`)
      await until('the oEmbed title to arrive (or the id to show)', async () => {
        const cur = (await api(carol, 'GET', `/channels/${ids.voice}/watch`)).body.current
        title1 = cur.title ?? ''
        return !!cur.title
      }, 8000).catch(() => {})
      await voiceItem(carol).getByText(/^Watching: /).waitFor(LIVE)
      if (title1) await voiceItem(carol).getByText(`Watching: ${title1}`).waitFor(LIVE)
      await watchPanel(bob).getByRole('status').filter({ hasText: 'In sync' }).waitFor({ timeout: 8000 })
    })

    await step('2c. Watch Together: Alice seeks to 2:00; both players are within 1.5 s of each other and of the target', async () => {
      const seek = watchPanel(alice).getByRole('slider', { name: 'Seek' })
      await seek.fill('120')
      await sleep(100)
      await seek.dispatchEvent('pointerup')
      await until('both players near 2:00 and within 1.5 s of each other', async () => {
        const [a, b] = await players(alice, bob)
        return Math.abs(a.t - b.t) <= 1.5 && a.t >= 119 && a.t < 128 && b.t >= 119 && b.t < 128
      }, 5000)
      await sleep(2500)
      const [a, b] = await players(alice, bob)
      check(Math.abs(a.t - b.t) <= 1.5, `after 2.5 s more: Alice ${a.t.toFixed(2)} s, Bob ${b.t.toFixed(2)} s`)
      await shot(alice, 'watch-together')
    })

    await step('2d. Watch Together: pause and play from the host reach Bob; Bob (not host, control "host") cannot control', async () => {
      await watchPanel(alice).getByRole('button', { name: 'Pause' }).click()
      await until('both players paused at the same position', async () => {
        const [a, b] = await players(alice, bob)
        return a.st === 2 && b.st === 2 && Math.abs(a.t - b.t) <= 1.5
      }, 5000)
      check(await watchPanel(bob).getByRole('button', { name: 'Play' }).isDisabled(), "Bob's play button is disabled while only the host controls")
      check((await api(bob, 'PATCH', `/channels/${ids.voice}/watch`, { action: 'play' })).status === 403, 'Bob may not play')
      check((await api(bob, 'PATCH', `/channels/${ids.voice}/watch`, { control: 'everyone' })).status === 403, 'Bob (no MOVE_MEMBERS) may not switch control')
      check((await watchPanel(bob).getByRole('switch', { name: 'Control: everyone' }).count()) === 0, 'no control switch for Bob')
      await watchPanel(alice).getByRole('button', { name: 'Play' }).click()
      await until('both players playing again', async () => {
        const [a, b] = await players(alice, bob)
        return a.st === 1 && b.st === 1 && Math.abs(a.t - b.t) <= 1.5
      }, 5000)
    })

    await step('2e. Watch Together: Alice switches control to everyone; Bob pauses and Alice follows', async () => {
      // the switch shows the server's state, so it flips when the answer arrives (check() would expect it at once)
      const sw = watchPanel(alice).getByRole('switch', { name: 'Control: everyone' })
      await sw.click()
      await until('the switch to show everyone', () => sw.isChecked(), 5000)
      await until("Bob's controls to unlock", () => watchPanel(bob).getByRole('button', { name: 'Pause' }).isEnabled(), 5000)
      await watchPanel(bob).getByRole('button', { name: 'Pause' }).click()
      await until("Alice's player paused by Bob", async () => (await player(alice)).st === 2, 5000)
      await watchPanel(bob).getByRole('button', { name: 'Play' }).click()
      await until("Alice's player playing again", async () => (await player(alice)).st === 1, 5000)
      await sw.click()
      await until('the switch to show host', async () => !(await sw.isChecked()), 5000)
      await until("Bob's controls to lock again", () => watchPanel(bob).getByRole('button', { name: 'Pause' }).isDisabled(), 5000)
    })

    await step('2f. Watch Together: Alice queues a second video (Bob sees it in the queue) and skips to it with "Next video"', async () => {
      await watchPanel(alice).getByLabel('YouTube link').fill(VIDEO2)
      await watchPanel(alice).getByRole('button', { name: 'Add to Queue' }).click()
      await watchPanel(bob).getByRole('list', { name: 'Queue' }).getByRole('listitem').first().waitFor(LIVE)
      await watchPanel(alice).getByRole('button', { name: 'Next video' }).click()
      await until('both players on aqz-KE-bpKQ near the start', async () => {
        const [a, b] = await players(alice, bob)
        return a.vid === 'aqz-KE-bpKQ' && b.vid === 'aqz-KE-bpKQ' && a.t < 10 && Math.abs(a.t - b.t) <= 1.5
      }, 5000)
      await until('the queue to be empty for Bob', async () => (await watchPanel(bob).getByRole('list', { name: 'Queue' }).count()) === 0, 5000)
    })

    await step('2g. voice channel status: Alice sets "Scrim vs Team X"; Bob and Carol see it under the channel, Bob in the voice header too', async () => {
      await voiceRow(alice).click({ button: 'right' })
      await alice.getByRole('menuitem', { name: 'Set Channel Status' }).click()
      const dialog = modal(alice, 'Set Channel Status')
      await dialog.getByLabel('Status').fill(`Scrim vs Team X ${SFX}`)
      await dialog.getByRole('button', { name: 'Save' }).click()
      for (const p of [bob, carol]) await voiceItem(p).getByText(`Scrim vs Team X ${SFX}`).waitFor(LIVE)
      await bob.locator('.voice-status-head').getByText(`Scrim vs Team X ${SFX}`).waitFor(LIVE)
      const ch = await ok(api(carol, 'GET', `/channels/${ids.voice}`))
      check(ch.status === `Scrim vs Team X ${SFX}`, `channel.status = ${ch.status}`)
      await shot(carol, 'voice-status')
    })

    await step('2h. Watch Together: Carol joins late and gets the running session at the same position', async () => {
      await joinVoice(carol)
      await until("Carol's player on aqz-KE-bpKQ within 1.5 s of Alice's", async () => {
        const [a, c] = await players(alice, carol)
        return c?.vid === 'aqz-KE-bpKQ' && c.st === 1 && Math.abs(a.t - c.t) <= 1.5
      }, 10000)
    })

    await step('2i. when the channel empties the session ends and the status is cleared', async () => {
      for (const p of [bob, carol, alice]) await leaveVoice(p)
      for (const p of [alice, bob, carol]) await until('the "Watching:" line and the status to disappear', async () =>
        (await voiceItem(p).getByText(/^Watching: /).count()) === 0 && (await voiceItem(p).getByText(`Scrim vs Team X ${SFX}`).count()) === 0, 5000)
      check((await api(alice, 'GET', `/channels/${ids.voice}/watch`)).status === 404, 'no session after the channel emptied')
      check((await ok(api(alice, 'GET', `/channels/${ids.voice}`))).status === null, 'status cleared')
    })

    await step('2j. the Enhanced setting persists across a reload', async () => {
      await alice.reload()
      await ready(alice)
      await alice.getByRole('button', { name: 'User Settings' }).click()
      await alice.getByRole('tab', { name: 'Voice & Video', exact: true }).click()
      check((await alice.getByLabel('Noise Suppression').inputValue()) === 'enhanced', 'the select shows Enhanced after a reload')
      await closeSettings(alice)
    })

    // ---- 3. Cillhub Bot ----
    await step('3a. Alice adds the Cillhub Bot from Server Settings → Integrations; the bot joins the member list', async () => {
      await openChannel(alice, 'general')
      await serverSettings(alice, 'Integrations')
      await alice.getByRole('button', { name: 'Add Cillhub Bot' }).click()
      await alice.getByText('Cillhub Bot is in this server.', { exact: false }).waitFor()
      await closeSettings(alice)
      const st = await ok(api(bob, 'GET', `/guilds/${ids.guild}/cillcord-bot`))
      check(st.installed === true, `install state ${JSON.stringify(st)}`)
      await openChannel(bob, 'general')
      await members(bob).getByText('Cillhub', { exact: true }).first().waitFor(LIVE)
    })

    await step('3b. /roll 2d6 and /coinflip answer publicly', async () => {
      await slash(alice, '#general', 'roll', { dice: '2d6' })
      await message(bob, '#general', /🎲 2d6: \d \+ \d = \d+/).waitFor(LIVE)
      await slash(alice, '#general', 'coinflip')
      await message(bob, '#general', /🪙 (Heads|Tails)/).waitFor(LIVE)
    })

    await step('3c. /remind 20s: Bob gets an ephemeral confirmation, then a DM from Cillhub', async () => {
      await slash(bob, '#general', 'remind', { when: '20s', what: `stretch ${SFX}` })
      await bob.getByText('Only you can see this', { exact: false }).first().waitFor(LIVE)
      await message(bob, '#general', "I'll remind you").waitFor(LIVE)
      await bob.getByRole('link', { name: 'Direct Messages' }).first().click()
      await dmList(bob).getByRole('link').filter({ hasText: 'Cillhub' }).waitFor({ timeout: 40000 })
      await dmList(bob).getByRole('link').filter({ hasText: 'Cillhub' }).click()
      await bob.locator('li.msg').filter({ hasText: `⏰ Reminder` }).filter({ hasText: `stretch ${SFX}` }).waitFor(LIVE)
      await openChannel(bob, 'general')
    })

    await step('3d. /giveaway: Bob and Carol enter (entries update live), Alice ends it, a winner is shown', async () => {
      await openChannel(carol, 'general')
      await slash(alice, '#general', 'giveaway', { prize: `Mousepad ${SFX}`, duration: '1h', winners: 1 })
      const g = (p) => card(p, '#general', `🎉 Mousepad ${SFX}`)
      for (const p of [bob, carol]) {
        await g(p).waitFor(LIVE)
        await g(p).getByRole('button', { name: 'Enter' }).click()
        await p.getByText('You entered the giveaway', { exact: false }).waitFor(LIVE)
      }
      await until('Entries 2 on the card for Alice', async () => /Entries\s*2/.test(await g(alice).innerText()), 5000)
      await g(alice).getByRole('button', { name: 'End now' }).click()
      await until('the card to name a winner for Carol', async () => new RegExp(`Winner: @(${NAME.bob}|${NAME.carol})`).test(await g(carol).innerText()), 5000)
      await message(bob, '#general', `Congratulations`).filter({ hasText: `Mousepad ${SFX}` }).waitFor(LIVE)
      check(await g(bob).getByRole('button', { name: 'Enter' }).isDisabled(), 'Enter is disabled after the end')
    })

    await step('3e. /scrim: Join, Bench and Leave update the roster live for everyone; a scheduled event is created', async () => {
      await slash(alice, '#general', 'scrim', { opponent: `Team X ${SFX}`, when: '3h', slots: 5 })
      const s = (p) => card(p, '#general', `Scrim vs Team X ${SFX}`)
      await s(bob).waitFor(LIVE)
      await s(bob).getByRole('button', { name: 'Join' }).click()
      await until('Roster (1/5) with Bob on Carol\'s card', async () => /Roster \(1\/5\)[\s\S]*@Bob_/.test(await s(carol).innerText()), 5000)
      await s(carol).getByRole('button', { name: 'Bench' }).click()
      await until('Carol on the bench on Bob\'s card', async () => /Bench[\s\S]*@Carol_/.test(await s(bob).innerText()), 5000)
      await s(bob).getByRole('button', { name: 'Leave' }).click()
      await until('Roster (0/5) on Alice\'s card', async () => /Roster \(0\/5\)/.test(await s(alice).innerText()), 5000)
      const events = await ok(api(bob, 'GET', `/guilds/${ids.guild}/scheduled-events`))
      check(events.some((e) => e.name === `Scrim vs Team X ${SFX}` && e.entity_type === 3), `events: ${JSON.stringify(events.map((e) => e.name))}`)
      await shot(alice, 'cillcord-bot')
    })

    await step('3f. /lfg players:3: Bob and Carol join; when full a group DM opens for all three', async () => {
      await slash(alice, '#general', 'lfg', { game: `CS2 ${SFX}`, players: 3, note: 'ranked' })
      const l = (p) => card(p, '#general', `LFG: CS2 ${SFX}`)
      for (const p of [bob, carol]) {
        await l(p).waitFor(LIVE)
        await l(p).getByRole('button', { name: 'Join' }).click()
      }
      await until('the card to say Full', () => l(alice).getByRole('button', { name: 'Full' }).isDisabled(), 5000)
      for (const p of [alice, bob, carol]) {
        await p.getByRole('link', { name: 'Direct Messages' }).first().click()
        await dmList(p).getByRole('link').filter({ hasText: `CS2 ${SFX} LFG` }).waitFor(LIVE)
      }
      const group = (await ok(api(bob, 'GET', '/users/@me/channels'))).find((c) => c.name === `CS2 ${SFX} LFG`)
      check(group?.type === 3 && group.recipients.length === 2 && group.owner_id === ids.alice, `group DM: ${JSON.stringify(group)}`)
    })

    // ---- 4. Due: scheduled messages and the reminder ----
    await step('4a. at the time: Alice\'s two scheduled messages appear in #plans (not before); Bob\'s is refused and reported to him', async () => {
      await openChannel(carol, 'plans')
      const before = (await ok(api(carol, 'GET', `/channels/${ids.plans}/messages?limit=20`))).filter((m) => m.content.includes(SFX))
      check(Date.now() >= T1.getTime() || before.length === 0, `nothing before ${T1.toISOString()}: ${before.map((m) => m.content)}`)
      await message(carol, '#plans', `scrim plan ${SFX}`).waitFor({ timeout: Math.max(5000, T1.getTime() - Date.now() + 10000) })
      await message(carol, '#plans', `fixed text ${SFX}`).waitFor(LIVE)
      const msgs = (await ok(api(carol, 'GET', `/channels/${ids.plans}/messages?limit=20`))).filter((m) => m.content.includes(SFX))
      check(msgs.length === 2 && msgs.every((m) => m.author.id === ids.alice && Date.parse(m.timestamp) >= T1.getTime() - 1000), `sent: ${JSON.stringify(msgs.map((m) => [m.content, m.timestamp]))}`)
      await until("Bob's refusal toast", async () => (await toasts(bob)).some((t) => t.includes('A scheduled message to #plans could not be sent.')), 10000)
      check((await ok(api(bob, 'GET', '/users/@me/scheduled-messages'))).length === 0, 'the refused one is gone from Bob\'s list')
      check((await ok(api(alice, 'GET', '/users/@me/scheduled-messages'))).length === 0, 'Alice\'s list is empty after sending')
      await ok(api(alice, 'DELETE', `/channels/${ids.plans}/permissions/${ids.bob}`))
    })

    await step('4b. the reminder falls due: Carol gets the notification toast and the inbox marks it Due', async () => {
      await until("Carol's reminder toast", async () => (await toasts(carol)).some((t) => t.includes('Reminder:') && t.includes(`remember the scrim ${SFX}`)), 15000)
      await carol.getByRole('button', { name: 'Inbox' }).click()
      const inbox = modal(carol, 'Inbox')
      await inbox.getByRole('tab', { name: 'Reminders' }).click()
      const item = inbox.getByRole('list', { name: 'Reminders' }).getByRole('listitem').filter({ hasText: `remember the scrim ${SFX}` })
      await item.locator('.reminder-badge', { hasText: 'Due' }).waitFor()
      await item.getByRole('button', { name: 'Mark reminder done' }).click()
      await item.waitFor({ state: 'detached' })
      check((await ok(api(carol, 'GET', '/users/@me/saved-messages'))).results.length === 0, 'done removes the saved message')
      await carol.keyboard.press('Escape')
    })

    // ---- 5. Server templates and export/import ----
    let code
    await step('5a. Alice creates a server template; Carol opens the link and creates a server from it with the same channels and roles', async () => {
      await serverSettings(alice, 'Server Template')
      await alice.getByLabel('Template Title').fill(`Org setup ${SFX}`)
      await alice.getByRole('button', { name: 'Generate Template' }).click()
      const link = await alice.getByLabel('Template Link').inputValue()
      check(new RegExp(`^${BASE}/template/[\\w-]{12}$`).test(link), `template link ${link}`)
      code = link.split('/').pop()
      await shot(alice, 'templates')
      await carol.goto(link)
      await ready(carol)
      const add = modal(carol, 'Add a server')
      // a template link previews on its own
      await add.getByText(`Org setup ${SFX}`).waitFor()
      await add.getByText('2 roles, 5 channels').waitFor()
      await add.getByLabel('Server name').last().fill(`From template ${SFX}`)
      await add.getByRole('button', { name: 'Create Server' }).click()
      await railGuild(carol, `From template ${SFX}`).waitFor(LIVE)
      for (const n of ['general', 'plans']) await channels(carol, `From template ${SFX}`).getByRole('link', { name: new RegExp(`^${n}\\b`) }).waitFor()
      const g = (await ok(api(carol, 'GET', '/users/@me/guilds'))).find((x) => x.name === `From template ${SFX}`)
      const full = await ok(api(carol, 'GET', `/guilds/${g.id}`))
      check(full.roles.some((r) => r.name === 'Staff' && r.permissions === '268435456' && r.hoist), `roles: ${full.roles.map((r) => r.name)}`)
      const t = await ok(api(alice, 'GET', `/guilds/${ids.guild}/templates`))
      check(t[0].usage_count === 1, `usage_count ${t[0].usage_count}`)
    })

    const shape = async (page, guildId) => {
      const g = await ok(api(page, 'GET', `/guilds/${guildId}`))
      const chans = await ok(api(page, 'GET', `/guilds/${guildId}/channels`))
      const byId = Object.fromEntries(chans.map((c) => [c.id, c]))
      const roleName = Object.fromEntries(g.roles.map((r) => [r.id, r.name]))
      return {
        roles: g.roles.filter((r) => !r.managed).map((r) => `${r.name}:${r.permissions}:${r.color}:${r.hoist}`).sort(),
        channels: chans.map((c) => `${c.type}:${c.name}:${byId[c.parent_id]?.name ?? '-'}:${(c.permission_overwrites ?? []).filter((o) => o.type === 0).map((o) => `${roleName[o.id]}=${o.allow}/${o.deny}`).sort().join(',')}`).sort(),
      }
    }

    await step('5b. Alice exports the server as JSON; Bob imports the file ("Create from file") and gets the same channels, roles and overwrites', async () => {
      const [download] = await Promise.all([alice.waitForEvent('download'), alice.getByRole('button', { name: 'Export Server' }).click()])
      const file = path.join(tmp, 'export.cillcord.json')
      await download.saveAs(file)
      const exported = JSON.parse(fs.readFileSync(file, 'utf8'))
      check(exported.format === 'cillcord-guild' && exported.serialized_source_guild.name === GUILD, `export header ${exported.format} ${exported.serialized_source_guild?.name}`)
      await closeSettings(alice)
      await bob.getByRole('button', { name: 'Add a server' }).click()
      const add = modal(bob, 'Add a server')
      await add.getByLabel('Server export (.json)').setInputFiles(file)
      await add.getByText(/\d+ roles, \d+ channels/).last().waitFor()
      await add.getByLabel('Server name').last().fill(`Imported ${SFX}`)
      await add.getByRole('button', { name: 'Import Server' }).click()
      await railGuild(bob, `Imported ${SFX}`).waitFor(LIVE)
      const g = (await ok(api(bob, 'GET', '/users/@me/guilds'))).find((x) => x.name === `Imported ${SFX}`)
      const [src, dst] = [await shape(alice, ids.guild), await shape(bob, g.id)]
      check(JSON.stringify(src) === JSON.stringify(dst), `round trip differs:\n  source ${JSON.stringify(src)}\n  import ${JSON.stringify(dst)}`)
    })

    // ---- 6. Spacebar discovery ----
    await step('6. Spacebar discovery endpoints answer per the contract', async () => {
      const get = async (p) => { const r = await fetch(BASE + p); check(r.ok, `${p} answered ${r.status}`); return r.json() }
      const wk = await get('/.well-known/spacebar')
      check(wk.api === `${BASE}/api/v9`, `/.well-known/spacebar: ${JSON.stringify(wk)}`)
      const client = await get('/.well-known/spacebar/client')
      check(client.api.baseUrl === BASE && client.api.apiVersions.default === '9' && client.gateway.baseUrl === BASE.replace(/^http/, 'ws') && client.cdn.baseUrl === BASE, `client: ${JSON.stringify(client)}`)
      const domains = await get('/api/policies/instance/domains')
      check(domains.defaultApiVersion === '9' && domains.apiEndpoint === `${BASE}/api` && domains.cdn === BASE && /^ws/.test(domains.gateway), `domains: ${JSON.stringify(domains)}`)
      const inst = await get('/api/policies/instance')
      check(inst.instanceName === 'Cillhub', `instance: ${JSON.stringify(inst)}`)
      const gw = await get('/api/v9/gateway')
      check(domains.gateway.replace(/\/$/, '') === gw.url.replace(/\/$/, '').replace(/\/gateway$/, '') || domains.gateway === gw.url, `domains.gateway ${domains.gateway} vs /gateway ${gw.url}`)
    })

    // ---- 7. Game activity from the desktop bridge ----
    await step(`7. game activity: Dave's desktop bridge reports "Counter-Strike 2"; Alice sees "Playing Counter-Strike 2" in the member list`, async () => {
      const r = await fetch(`${BASE}/api/v9/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ age_confirmed: true, email: `${NAME.dave.toLowerCase()}@example.com`, username: NAME.dave, password: PASSWORD }) })
      const { token } = await r.json()
      check(token, `register Dave: ${r.status}`)
      const invite = await ok(api(alice, 'POST', `/channels/${ids.general}/invites`, { max_age: 0 }))
      await fetch(`${BASE}/api/v9/invites/${invite.code}`, { method: 'POST', headers: { Authorization: token } })
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' })
      await ctx.addInitScript((t) => {
        localStorage.setItem('token', t)
        let cb = null
        window.cillcordDesktop = Object.freeze({ platform: 'linux', version: '1.1.0', onUpdateStatus: () => () => {}, onHotkey: () => () => {}, onGameActivity: (f) => ((cb = f), () => {}) })
        setTimeout(() => cb?.({ name: 'Counter-Strike 2', start: Date.now() }), 3000)
      }, token)
      const dave = await ctx.newPage()
      watch(dave, 'Dave')
      await dave.goto(`${BASE}/channels/${ids.guild}/${ids.general}`)
      await ready(dave)
      await openChannel(alice, 'general')
      const row = members(alice).getByRole('listitem').filter({ hasText: NAME.dave })
      await row.getByText('Playing Counter-Strike 2').waitFor({ timeout: 40000 })
      await shot(alice, 'playing')
    })

    await step('8. no uncaught page errors and no native dialogs', async () => {
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
