// The web side of the Android voice tests: a small HTTP control server that puts headless Chromium participants (the
// real web client, served by the throwaway test server) into voice channels and reports what flows. The instrumented
// test on the emulator drives it over http://10.0.2.2:<port>. Test data only; started and stopped by emulator-test.sh.
// Run: NODE_PATH=/tmp/pw/node_modules node android/scripts/web-peer.cjs [port]   (Playwright with Chromium installed)
//
// POST /join   {base, token, guild, guildName, channel}  -> {ok}   joins through the channel list like a user
// POST /call   {base, token, channel}  -> {ok}   starts a call in a DM, which rings the other person
// POST /camera {on} · POST /screen {on} · POST /leave · POST /reset
// GET  /stats  -> {audioIn, audioInLevel, audioOut, sendLevel, videoIn: [{frames, width, height, codec}], videoOut: [...], videos: [{w, h}]}
// GET  /shot?path=/abs.png  -> screenshot of the page
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { chromium } = require('playwright')

const PORT = Number(process.argv[2] ?? 3370)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cillhub-webpeer-'))
let browser = null
let page = null

// Mono 48 kHz "speech" (as in e2e-v2): voiced harmonics in syllables, loud enough for speaker detection.
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

// in every page: keep each RTCPeerConnection, so /stats can read them
function instrument() {
  window.__pcs = []
  const Orig = window.RTCPeerConnection
  window.RTCPeerConnection = function (...a) { const pc = new Orig(...a); window.__pcs.push(pc); return pc }
  window.RTCPeerConnection.prototype = Orig.prototype
  Object.assign(window.RTCPeerConnection, Orig)
}

async function stats() {
  return page.evaluate(async () => {
    const out = { audioIn: 0, audioInLevel: 0, audioOut: 0, sendLevel: 0, videoIn: [], videoOut: [], videos: [] }
    for (const pc of window.__pcs.filter((p) => p.connectionState !== 'closed')) {
      const r = await pc.getStats()
      const codec = (id) => (id && r.get(id)?.mimeType?.split('/')[1]) || ''
      r.forEach((s) => {
        if (s.type === 'inbound-rtp' && s.kind === 'audio') { out.audioIn += s.packetsReceived ?? 0; out.audioInLevel = Math.max(out.audioInLevel, s.audioLevel ?? 0) }
        if (s.type === 'outbound-rtp' && s.kind === 'audio') out.audioOut += s.packetsSent ?? 0
        if (s.type === 'media-source' && s.kind === 'audio') out.sendLevel = Math.max(out.sendLevel, s.audioLevel ?? 0)
        if (s.type === 'inbound-rtp' && s.kind === 'video') out.videoIn.push({ frames: s.framesDecoded ?? 0, width: s.frameWidth ?? 0, height: s.frameHeight ?? 0, codec: codec(s.codecId) })
        if (s.type === 'outbound-rtp' && s.kind === 'video') out.videoOut.push({ frames: s.framesEncoded ?? 0, width: s.frameWidth ?? 0, height: s.frameHeight ?? 0, codec: codec(s.codecId) })
      })
    }
    out.videos = [...document.querySelectorAll('video')].filter((v) => v.videoWidth > 0).map((v) => ({ w: v.videoWidth, h: v.videoHeight }))
    return out
  })
}

const panel = () => page.getByRole('region', { name: 'Voice connection' })

async function open(base, token, route) {
  await reset()
  browser ??= await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${path.join(tmp, 'speech.wav')}`,
      '--auto-select-desktop-capture-source=Entire screen', '--autoplay-policy=no-user-gesture-required'],
  })
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['microphone', 'camera'], serviceWorkers: 'block', locale: 'en-US' })
  await ctx.addInitScript((t) => localStorage.setItem('token', t), token)
  await ctx.addInitScript(instrument)
  page = await ctx.newPage()
  page.on('pageerror', (e) => console.log(`page error: ${e.message}`))
  await page.goto(base + route)
}

async function join({ base, token, guild, guildName, channel }) {
  await open(base, token, `/channels/${guild}`)
  await page.getByRole('navigation', { name: `${guildName} channels` }).getByRole('button', { name: new RegExp(`^${channel} \\((voice|stage) channel`) }).click({ timeout: 20000 })
  await panel().getByRole('status').filter({ hasText: 'Voice Connected' }).waitFor({ timeout: 20000 })
}

/** Starts a call in a DM (it rings the other person). */
async function call({ base, token, channel }) {
  await open(base, token, `/channels/@me/${channel}`)
  await page.getByRole('button', { name: 'Start Voice Call' }).click({ timeout: 20000 })
  await page.getByRole('region', { name: 'Call' }).waitFor({ timeout: 20000 })
}

async function camera(on) {
  const b = panel().getByRole('button', { name: 'Camera', exact: true })
  if ((await b.getAttribute('aria-pressed')) !== String(on)) await b.click()
}

async function screen(on) {
  const b = panel().getByRole('button', { name: 'Share Your Screen', exact: true })
  if ((await b.getAttribute('aria-pressed')) === String(on)) return
  await b.click()
  if (on) await page.getByRole('dialog', { name: 'Screen Share' }).getByRole('button', { name: 'Go Live' }).click()
}

async function reset() {
  if (page) await page.context().close().catch(() => {})
  page = null
}

fs.writeFileSync(path.join(tmp, 'speech.wav'), speechWav())
const routes = {
  'POST /join': join,
  'POST /call': call,
  'POST /camera': (b) => camera(!!b.on),
  'POST /screen': (b) => screen(!!b.on),
  'POST /leave': () => panel().getByRole('button', { name: 'Disconnect' }).click(),
  'POST /reset': reset,
  'GET /stats': stats,
  // names the web client marks as speaking (the hidden "speaking" text in the voice user list)
  'GET /speaking': () => page.evaluate(() => [...document.querySelectorAll('.sr-only')].filter((e) => /speaking/.test(e.textContent)).map((e) => e.closest('[role=button],button')?.getAttribute('aria-label') ?? e.parentElement?.textContent ?? '')).then((names) => ({ names })),
  'GET /shot': (_, q) => page.screenshot({ path: q.get('path') }).then(() => ({ path: q.get('path') })),
}
http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', async () => {
    const u = new URL(req.url, 'http://x')
    const fn = routes[`${req.method} ${u.pathname}`]
    try {
      if (!fn) throw new Error('no such route')
      const out = (await fn(body ? JSON.parse(body) : {}, u.searchParams)) ?? { ok: true }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out))
    } catch (e) {
      console.log(`${req.method} ${u.pathname}: ${e.message}`)
      res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: e.message }))
    }
  })
}).listen(PORT, '127.0.0.1', () => console.log(`web peer on http://127.0.0.1:${PORT}`))

const stop = async () => { await browser?.close().catch(() => {}); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(0) }
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
