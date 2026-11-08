// Screen share quality as a viewer receives it, through the real app, on both voice backends.
// Starts a throwaway server per backend (serving the built client), puts two users in a voice channel; Alice shares a
// synthetic high-detail moving "screen" (a canvas with small scrolling text, a static code panel and moving shapes,
// handed to the app in place of getDisplayMedia) through the Go Live dialog; Bob watches it first as a grid tile and
// then focused. Reports per case and view: what Bob receives (size, fps, bitrate, average QP = blockiness, freezes) and
// what Alice sends per simulcast layer (size, fps, bitrate, qualityLimitationReason), the CPU her browser uses (Alice and
// Bob run in separate browsers) and, focused, a PSNR of what Bob sees: every frame carries its number as a barcode, so
// Bob's page redraws the same frame from the same code and compares (luma, whole frame, received frame scaled to the source size).
// Run: cd client && npm run build; cd ..; set -a; . ./.env; set +a
//      NODE_PATH=/tmp/pw/node_modules node scripts/stream-quality.cjs
// env: BACKENDS=livekit,cillvoice  CASES=1080-30-motion,1080-30-detail,1440-60-motion,1440-60-detail  SECONDS=15
//      HTTP_PORT=3376 UDP_PORT=3377  STATIC_DIR=client/dist  VIEWPORT=1920x1080 (Bob's window)
//      LiveKit needs LIVEKIT_API_KEY/SECRET (LIVEKIT_URL default http://127.0.0.1:7880).
//      JOIN_WAIT=10000 (ms in the call before the first share), CAMERA=1 (Alice's camera is on from the start), CODEC=vp8|h264|av1 (Screen Share Encoder), COLD_SECONDS=30 (cold start: Bob focuses the share right away; how long until Alice's full layer is allotted 80 % of
//      the share's bitrate and Bob receives the full size; 0 skips it), WARMUP=8000 (ms before the grid view); diagnostics: LOSSINFO=1 (loss, NACK, PLI columns), TIMELINE=1
//      (Alice's estimate and layers every second), PARAMS=1 (her sender encodings), SDP=1 (her SDPs), BROWSER_ARGS='--flag …' (extra Chromium flags, e.g. WebRTC logging), LOGS=<regex> (matching console lines).
// Headless Chromium encodes in software (OpenH264/libvpx/libaom); real PCs with GPU encoders hit 'cpu' limits later.
const { chromium } = require('playwright')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const HTTP_PORT = Number(process.env.HTTP_PORT ?? 3376)
const UDP_PORT = Number(process.env.UDP_PORT ?? 3377)
const BASE = `http://127.0.0.1:${HTTP_PORT}`
const SECONDS = Number(process.env.SECONDS ?? 15)
const BACKENDS = (process.env.BACKENDS ?? 'livekit,cillvoice').split(',')
const CASES = (process.env.CASES ?? '1080-30-motion,1080-30-detail,1440-60-motion,1440-60-detail').split(',').map((c) => {
  const [res, fps, mode] = c.split('-')
  return { res, fps: Number(fps), mode, name: c }
})
const [VW, VH] = (process.env.VIEWPORT ?? '1920x1080').split('x').map(Number)
const STATIC = path.resolve(process.env.STATIC_DIR ?? path.join(__dirname, '..', 'client', 'dist'))
// the dialog's bitrate for a case, as client/src/voice/settings.ts streamBitrate()
const goalBitrate = (c) => ({ 720: 2_500_000, 1080: 6_000_000, 1440: 10_000_000, source: 16_000_000 })[c.res] * (c.fps === 60 ? 1.5 : c.fps === 15 ? 0.6 : 1)
const COLD_SECONDS = Number(process.env.COLD_SECONDS ?? 30)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(method, route, token, body) {
  const r = await fetch(`${BASE}/api/v9${route}`, { method, headers: { ...(token && { Authorization: token }), ...(body && { 'Content-Type': 'application/json' }) }, body: body && JSON.stringify(body) })
  const text = await r.text()
  if (r.status >= 300) throw new Error(`${method} ${route}: HTTP ${r.status} ${text}`)
  return text ? JSON.parse(text) : null
}

// ---- in every page: keep the peer connections; in Alice's page: a canvas "screen" instead of getDisplayMedia ----
function instrument() {
  window.__pcs = []
  const Orig = window.RTCPeerConnection
  window.RTCPeerConnection = class extends Orig { constructor(...a) { super(...a); window.__pcs.push(this) } }
  const num = (v, d) => (typeof v === 'number' ? v : v?.max ?? v?.ideal ?? v?.exact ?? d)
  // the synthetic screen for frame f, the same in every page (Bob redraws it for the PSNR); one sheet per size
  const scenes = new Map()
  window.__scene = (W, H) => {
    if (scenes.has(`${W}x${H}`)) return scenes.get(`${W}x${H}`)
    // a tall sheet of small text, drawn once and scrolled (a code editor / document being scrolled)
    const sheet = Object.assign(document.createElement('canvas'), { width: W, height: H * 2 })
    const s = sheet.getContext('2d')
    s.fillStyle = '#1e1f22'; s.fillRect(0, 0, W, H * 2)
    s.font = '13px monospace'
    const words = ['const', 'return', 'await', 'function', 'stream', 'bitrate', 'encoder', '=>', '{', '}', 'layer', 'keyframe', '0x7fff', 'Math.round', 'simulcast']
    let seed = 7
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    for (let y = 16, i = 0; y < H * 2; y += 16, i++) {
      let line = `${String(i).padStart(4)}  `
      while (line.length < W / 8) line += words[Math.floor(rnd() * words.length)] + ' '
      s.fillStyle = ['#dbdee1', '#f0b232', '#5865f2', '#23a55a', '#f23f43'][i % 5]
      s.fillText(line, 4, y)
    }
    const draw = (g, f) => {
      const off = (f * 3) % H
      g.drawImage(sheet, 0, off, W, H, 0, 0, W, H) // scrolling text, full width
      g.fillStyle = '#313338'; g.fillRect(W * 0.55, H * 0.1, W * 0.4, H * 0.5) // a static panel with fine text
      g.font = '12px sans-serif'; g.fillStyle = '#f2f3f5'
      for (let y = 0; y < 20; y++) g.fillText(`Static line ${y}: The quick brown fox jumps over the lazy dog 0123456789`, W * 0.56, H * 0.12 + y * 18)
      for (let k = 0; k < 6; k++) { // moving shapes (a game / video)
        const x = (W / 2) * (1 + Math.sin(f / (20 + k * 7) + k)) * 0.9, y = (H / 2) * (1 + Math.cos(f / (25 + k * 5) + k)) * 0.9
        g.fillStyle = `hsl(${(f * 4 + k * 60) % 360} 80% 55%)`; g.beginPath(); g.arc(x, y, 40 + k * 10, 0, 7); g.fill()
      }
      g.font = 'bold 48px sans-serif'; g.fillStyle = '#fff'; g.fillText(`frame ${f}`, 20, H - 30)
      for (let i = 0; i < 16; i++) (g.fillStyle = (f >> i) & 1 ? '#fff' : '#000'), g.fillRect(W - 320 + i * 20, H - 20, 20, 20) // the frame number as a barcode
    }
    scenes.set(`${W}x${H}`, { draw })
    return { draw }
  }
  navigator.mediaDevices.getDisplayMedia = async (c = {}) => {
    const v = typeof c.video === 'object' ? c.video : {}
    const W = Math.min(num(v.width, 1920), 2560), H = Math.min(num(v.height, 1080), 1440), fps = num(v.frameRate, 30)
    const cv = Object.assign(document.createElement('canvas'), { width: W, height: H })
    const g = cv.getContext('2d')
    const scene = window.__scene(W, H)
    let f = 0
    const draw = () => {
      f++
      window.__screenSource.frames = f
      scene.draw(g, f)
    }
    window.__screenSource = { W, H, fps, frames: 0 }
    draw()
    const stream = cv.captureStream(fps)
    const timer = setInterval(() => (stream.getVideoTracks()[0].readyState === 'ended' ? clearInterval(timer) : draw()), 1000 / fps) // stop drawing once the app stops the share
    return stream
  }
}

// Bob: luma PSNR of the largest received video against the frame it shows, redrawn from its barcode (null: no video)
async function psnr([W, H]) {
  const v = [...document.querySelectorAll('.voice-view video')].filter((x) => x.videoWidth).sort((a, b) => b.videoWidth - a.videoWidth)[0]
  if (!v) return null
  const c = Object.assign(document.createElement('canvas'), { width: W, height: H })
  const g = c.getContext('2d', { willReadFrequently: true })
  g.drawImage(v, 0, 0, W, H)
  const got = g.getImageData(0, 0, W, H).data
  let f = 0
  for (let i = 0; i < 16; i++) { const o = ((H - 10) * W + W - 310 + i * 20) * 4; if (got[o] + got[o + 1] + got[o + 2] > 384) f |= 1 << i }
  window.__scene(W, H).draw(g, f)
  const ref = g.getImageData(0, 0, W, H).data
  let se = 0
  for (let o = 0; o < got.length; o += 4) {
    const d = 0.299 * (got[o] - ref[o]) + 0.587 * (got[o + 1] - ref[o + 1]) + 0.114 * (got[o + 2] - ref[o + 2])
    se += d * d
  }
  const mse = se / (W * H)
  return { f, db: mse ? 10 * Math.log10((255 * 255) / mse) : 99 }
}

// CPU seconds used so far by all processes of a browser (capture, encoding, decoding, rendering)
async function cpuTime(browser) {
  const s = await browser.newBrowserCDPSession()
  const { processInfo } = await s.send('SystemInfo.getProcessInfo')
  await s.detach()
  return processInfo.reduce((n, p) => n + p.cpuTime, 0)
}

// one sample: inbound video (Bob) or outbound video per layer (Alice), cumulative counters
async function sample() {
  const out = { in: [], out: [], t: performance.now(), src: window.__screenSource?.frames ?? 0 }
  for (const pc of window.__pcs) {
    if (pc.connectionState === 'closed') continue
    const r = await pc.getStats()
    r.forEach((s) => {
      if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded' && s.availableOutgoingBitrate) out.bwe = Math.max(out.bwe ?? 0, s.availableOutgoingBitrate)
      if (s.kind !== 'video') return
      const codec = r.get(s.codecId)?.mimeType?.split('/')[1]
      if (s.type === 'inbound-rtp' && s.framesDecoded) out.in.push({ id: s.id, codec, w: s.frameWidth, h: s.frameHeight, fps: s.framesPerSecond, bytes: s.bytesReceived, qp: s.qpSum, frames: s.framesDecoded, freezes: s.freezeCount, freezeSec: s.totalFreezesDuration, plis: s.pliCount, lost: s.packetsLost, dropped: s.framesDropped, fmtp: r.get(s.codecId)?.sdpFmtpLine })
      if (s.type === 'outbound-rtp' && s.framesEncoded) out.out.push({ id: s.id, rid: s.rid ?? '', codec, w: s.frameWidth, h: s.frameHeight, fps: s.framesPerSecond, bytes: s.bytesSent, qp: s.qpSum, frames: s.framesEncoded, limit: s.qualityLimitationReason, keys: s.keyFramesEncoded, rtt: [...r.values()].find((x) => x.type === 'remote-inbound-rtp' && x.localId === s.id)?.roundTripTime, nacks: s.nackCount, plisIn: s.pliCount, lostRemote: [...r.values()].find((x) => x.type === 'remote-inbound-rtp' && x.localId === s.id)?.packetsLost, target: s.targetBitrate, impl: s.encoderImplementation, active: s.active, fmtp: r.get(s.codecId)?.sdpFmtpLine })
    })
  }
  return out
}

function diff(a, b, key) {
  const sec = (b.t - a.t) / 1000
  return b[key].map((x) => {
    const p = a[key].find((y) => y.id === x.id)
    if (!p) return null
    const frames = x.frames - p.frames
    return { ...x, kbps: Math.round(((x.bytes - p.bytes) * 8) / sec / 1000), qpAvg: frames > 0 && x.qp != null ? (x.qp - p.qp) / frames : null, fpsAvg: frames / sec, freezes: (x.freezes ?? 0) - (p.freezes ?? 0), freezeSec: (x.freezeSec ?? 0) - (p.freezeSec ?? 0) }
  }).filter(Boolean)
}

async function measure(alice, bob, view, aliceBrowser) {
  const cpu0 = await cpuTime(aliceBrowser)
  const a0 = await alice.evaluate(sample), b0 = await bob.evaluate(sample)
  const sizes = []
  for (let i = 0; i < SECONDS; i++) {
    await sleep(1000)
    const b = await bob.evaluate(sample)
    if (process.env.TIMELINE) {
      const a = await alice.evaluate(sample)
      console.log(`t+${i}s bwe ${Math.round((a.bwe ?? 0) / 1000)} ` + a.out.filter((o) => o.w).map((o) => `${o.rid || '-'} ${o.w}x${o.h} ${f0(o.fps)}fps keys ${o.keys} pli ${o.plisIn} rtt ${o.rtt} bytes ${o.bytes}`).join(' | '))
    }
    const top = b.in.sort((x, y) => (y.w ?? 0) - (x.w ?? 0))[0]
    if (top) sizes.push(`${top.w}x${top.h}`)
  }
  const a1 = await alice.evaluate(sample), b1 = await bob.evaluate(sample)
  const cpu = (await cpuTime(aliceBrowser) - cpu0) / ((a1.t - a0.t) / 1000)
  const src = await alice.evaluate(() => [window.__screenSource.W, window.__screenSource.H])
  const psnrs = []
  if (view === 'focused') for (let i = 0; i < 5; i++) (psnrs.push(await bob.evaluate(psnr, src)), await sleep(300))
  const ok = psnrs.filter(Boolean)
  const recv = diff(b0, b1, 'in').filter((x) => x.kbps > 0 || x.fpsAvg > 0).sort((x, y) => y.kbps - x.kbps)[0]
  const sent = diff(a0, a1, 'out').filter((x) => x.kbps > 0).sort((x, y) => (x.w ?? 0) - (y.w ?? 0))
  const srcFps = (a1.src - a0.src) / ((a1.t - a0.t) / 1000)
  const bwe = Math.round((a1.bwe ?? 0) / 1000)
  const tile = await bob.evaluate(() => { const v = [...document.querySelectorAll('.voice-view video')].find((x) => x.videoWidth); return v ? `${v.clientWidth}x${v.clientHeight}` : '-' })
  // the size Bob received most of the time and how often it changed
  const counts = sizes.reduce((m, s) => m.set(s, (m.get(s) ?? 0) + 1), new Map())
  const mostly = [...counts].sort((x, y) => y[1] - x[1])[0]?.[0] ?? '-'
  return { view, tile, recv, sent, bwe, srcFps, mostly, switches: sizes.filter((s, i) => i && s !== sizes[i - 1]).length, cpu, psnr: ok.length ? ok.reduce((n, x) => n + x.db, 0) / ok.length : null }
}

// From Go Live (t0) on, with Bob focused: every 500 ms Alice's estimate and full layer, Bob's received size and bitrate.
// Done when the full layer's encoder target reaches 80 % of the goal and Bob gets the source size.
async function coldStart(alice, bob, c, t0) {
  const goal = goalBitrate(c)
  const src = await alice.evaluate(() => `${window.__screenSource.W}x${window.__screenSource.H}`)
  const r = { goal, tTarget: null, tFull: null, kbpsAt: {}, bweAt: {}, plis: 0 }
  let prevB = null
  for (;;) {
    const [a, b] = [await alice.evaluate(sample), await bob.evaluate(sample)]
    const t = (Date.now() - t0) / 1000
    const full = a.out.filter((o) => o.active !== false).sort((x, y) => (y.w ?? 0) - (x.w ?? 0))[0]
    const top = b.in.sort((x, y) => (y.w ?? 0) - (x.w ?? 0))[0]
    const p = top && prevB?.in.find((x) => x.id === top.id)
    const kbps = p ? Math.round(((top.bytes - p.bytes) * 8) / ((b.t - prevB.t) / 1000) / 1000) : 0
    prevB = b
    r.plis = a.out.reduce((n, o) => n + (o.plisIn ?? 0), 0)
    for (const at of [2, 5, 10, 20]) if (t >= at && r.kbpsAt[at] == null) (r.kbpsAt[at] = kbps), (r.bweAt[at] = Math.round((a.bwe ?? 0) / 1000))
    if (r.tTarget == null && full?.target >= 0.8 * goal) r.tTarget = t
    if (r.tFull == null && top && `${top.w}x${top.h}` === src) r.tFull = t
    if (process.env.TIMELINE) console.log(`t+${t.toFixed(1)}s bwe ${Math.round((a.bwe ?? 0) / 1000)} | ` + a.out.map((o) => `${o.rid || '-'} ${o.codec} ${o.w}x${o.h} tgt ${f0(o.target / 1000)} ${o.limit} keys ${o.keys} pli ${o.plisIn} nack ${o.nacks}${o.active === false ? ' off' : ''}`).join(' ; ') + ` | Bob ${top ? `${top.codec} ${top.w}x${top.h}` : '-'} ${kbps} kbit/s`)
    if ((r.tTarget != null && r.tFull != null && t >= 10) || t > COLD_SECONDS) return r
    await sleep(500)
  }
}

const f0 = (n) => (n == null || !Number.isFinite(n) ? '-' : Math.round(n))
const f1 = (n) => (n == null || !Number.isFinite(n) ? '-' : n.toFixed(1))

async function runBackend(backend, [aliceBrowser, bobBrowser]) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-quality-'))
  const env = { ...process.env, PORT: String(HTTP_PORT), DATA_DIR: dataDir, STATIC_DIR: STATIC, CILLCORD_RATE_LIMIT_SCALE: '100' }
  if (backend === 'cillvoice') Object.assign(env, { VOICE_BACKEND: 'cillvoice', CILLVOICE_UDP_PORT: String(UDP_PORT), CILLVOICE_PUBLIC_IP: '127.0.0.1', LIVEKIT_URL: '', LIVEKIT_PUBLIC_URL: '' })
  else {
    if (!process.env.LIVEKIT_API_KEY) throw new Error('LiveKit needs LIVEKIT_API_KEY/SECRET (set -a; . ./.env; set +a)')
    Object.assign(env, { VOICE_BACKEND: 'livekit', LIVEKIT_URL: process.env.LIVEKIT_URL || 'http://127.0.0.1:7880', LIVEKIT_PUBLIC_URL: process.env.LIVEKIT_PUBLIC_URL || 'ws://127.0.0.1:7880' })
  }
  const server = spawn(process.execPath, ['src/index.js'], { cwd: path.join(__dirname, '..', 'server'), env, stdio: ['ignore', 'ignore', 'inherit'] })
  const rows = []
  const colds = []
  const contexts = []
  try {
    for (let i = 0; ; i++) {
      if (await fetch(BASE + '/api/v9/gateway').then((r) => r.ok, () => false)) break
      if (i > 100) throw new Error('server did not start')
      await sleep(100)
    }
    const sfx = Math.random().toString(36).slice(2, 7)
    const reg = (n) => api('POST', '/auth/register', null, { email: `${n}${sfx}@example.com`, username: `${n}_${sfx}`, password: 'measure measure' }).then((r) => r.token)
    const [ta, tb] = [await reg('alice'), await reg('bob')]
    const guild = await api('POST', '/guilds', ta, { name: 'Stream Lab' })
    const voice = guild.channels.find((c) => c.type === 2)
    const invite = await api('POST', `/channels/${guild.channels.find((c) => c.type === 0).id}/invites`, ta, { max_age: 0 })
    await api('POST', `/invites/${invite.code}`, tb)
    const open = async (token, viewport, browser) => {
      const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, permissions: ['microphone', 'camera'], serviceWorkers: 'block' })
      contexts.push(ctx)
      await ctx.addInitScript(([t, codec]) => (localStorage.setItem('token', t), codec && localStorage.setItem('voice-settings', JSON.stringify({ screenCodec: codec }))), [token, process.env.CODEC])
      await ctx.addInitScript(instrument)
      const page = await ctx.newPage()
      page.on('pageerror', (e) => console.error(`page error: ${e.message}`))
      if (process.env.LOGS) page.on('console', (m) => new RegExp(process.env.LOGS, 'i').test(m.text()) && console.log(`console: ${m.text()}`))
      await page.goto(`${BASE}/channels/${guild.id}/${voice.id}`)
      await page.getByRole('button', { name: 'Join Voice' }).click()
      await page.getByRole('button', { name: 'Share Your Screen' }).first().waitFor({ timeout: 20000 })
      return page
    }
    const alice = await open(ta, { width: 1280, height: 800 }, aliceBrowser)
    const bob = await open(tb, { width: VW, height: VH }, bobBrowser)
    if (process.env.CAMERA) await alice.getByRole('button', { name: 'Camera', exact: true }).first().click() // her camera is on before she shares
    await sleep(Number(process.env.JOIN_WAIT ?? 10000)) // people talk a while before they share
    for (const c of CASES) {
      await alice.getByRole('button', { name: 'Share Your Screen' }).first().click()
      await alice.getByRole('radio', { name: c.res === 'source' ? 'Source' : `${c.res}p` }).check()
      await alice.getByRole('radio', { name: `${c.fps} FPS` }).check()
      await alice.getByRole('radio', { name: c.mode === 'detail' ? 'Clarity' : 'Motion' }).check()
      await alice.getByRole('button', { name: 'Go Live' }).click()
      const t0 = Date.now()
      const tileBtn = bob.getByRole('button', { name: /screen, click to focus/ })
      await tileBtn.waitFor({ timeout: 20000 })
      if (COLD_SECONDS > 0) {
        await tileBtn.click()
        colds.push({ backend, c, ...(await coldStart(alice, bob, c, t0)) })
        await bob.getByRole('button', { name: /screen, focused/ }).click() // back to the grid
      }
      const alert = await alice.locator('.voice-error').allTextContents()
      if (process.env.PARAMS) console.log(backend, c.name, await alice.evaluate(() => window.__pcs.map((pc) => pc.localDescription?.sdp.split('\nm=').length - 1).join('/') + ' m-lines'), JSON.stringify(await alice.evaluate(() => window.__pcs.flatMap((pc) => pc.getTransceivers().filter((x) => x.sender.track?.kind === 'video' || x.receiver.track.kind === 'video').map((x) => [x.mid, x.direction, x.currentDirection, x.sender.track?.readyState, x.sender.getParameters().encodings.map((e) => [e.rid, e.maxBitrate, e.maxFramerate, e.scaleResolutionDownBy, e.active])])))))
      if (process.env.SDP) console.log(await alice.evaluate(() => window.__pcs.map((pc, i) => ['local', 'remote'].map((k) => `pc${i} ${k}:\n` + (pc[`${k}Description`]?.sdp ?? '').split('\r\n').filter((l) => /^(m=|a=(rtcp-fb|extmap|fmtp|rtpmap|ssrc-group|simulcast|rid)|b=)/.test(l)).join('\n')).join('\n')).join('\n')))
      if (alert.length) console.error(`${backend} ${c.name}: Alice sees "${alert.join(' ')}"`)
      await sleep(Number(process.env.WARMUP ?? 8000)) // bandwidth ramp-up and layer choice
      rows.push({ backend, c, ...(await measure(alice, bob, 'grid', aliceBrowser)) })
      await tileBtn.click()
      await sleep(4000)
      rows.push({ backend, c, ...(await measure(alice, bob, 'focused', aliceBrowser)) })
      await bob.getByRole('button', { name: /screen, focused/ }).click() // back to the grid
      await alice.getByRole('button', { name: 'Share Your Screen' }).first().click() // stop
      await bob.getByRole('button', { name: /screen, click to focus/ }).waitFor({ state: 'detached', timeout: 15000 })
      await sleep(1000)
    }
  } finally {
    for (const ctx of contexts) await ctx.close().catch(() => {})
    server.kill()
    await new Promise((r) => server.once('exit', r))
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
  return { rows, colds }
}

async function main() {
  // one browser each, so Alice's CPU time is her capture and encoding only
  const launch = () => chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', ...(process.env.BROWSER_ARGS?.split(' ') ?? [])] })
  const browsers = [await launch(), await launch()]
  const all = [], colds = []
  try {
    for (const b of BACKENDS) {
      const r = await runBackend(b, browsers)
      all.push(...r.rows), colds.push(...r.colds)
    }
  } finally {
    for (const b of browsers) await b.close()
  }
  console.log(`\n# viewer window ${VW}x${VH}, ${SECONDS} s per view; QP: lower is sharper, per codec only (H.264 0-51, VP8 0-127, AV1 0-255); PSNR (focused): luma dB against the source frame, higher is closer; CPU: Alice's browser, cores`)
  console.log('| backend | setting | view | tile | received (mostly) | fps | kbit/s | avg QP | PSNR dB | freezes | layer switches | source fps | sent layers (size fps kbit/s / target, limit) | sender BWE kbit/s | sender CPU |')
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const r of all) {
    const rv = r.recv
    const sent = r.sent.map((s) => `${s.rid || '-'} ${s.w}x${s.h} ${f0(s.fpsAvg)} ${s.kbps}/${f0(s.target / 1000)} ${s.limit}${process.env.LOSSINFO ? ` nack ${s.nacks} pli ${s.plisIn} lost ${s.lostRemote}` : ''}`).join('; ')
    console.log(`| ${r.backend} | ${r.c.name} | ${r.view} | ${r.tile} | ${rv ? `${rv.codec} ${r.mostly}` : 'nothing'} | ${f1(rv?.fpsAvg)} | ${f0(rv?.kbps)} | ${f1(rv?.qpAvg)} | ${f1(r.psnr)} | ${rv ? `${rv.freezes} (${f1(rv.freezeSec)} s)${process.env.LOSSINFO ? ` lost ${rv.lost} pli ${rv.plis} dropped ${rv.dropped}` : ''}` : '-'} | ${r.switches} | ${f0(r.srcFps)} | ${sent} | ${r.bwe} | ${f1(r.cpu)} |`)
  }
  if (colds.length) {
    console.log(`\n# cold start: Bob focuses the share at once; target = Alice's full-layer encoder target >= 80 % of the share's bitrate`)
    console.log('| backend | setting | share # | target reached | full size at viewer | viewer kbit/s at 2 / 5 / 10 / 20 s | sender BWE kbit/s at 2 / 5 / 10 / 20 s | PLIs |')
    console.log('|---|---|---|---|---|---|---|---|')
    const at = (m) => [2, 5, 10, 20].map((k) => m[k] ?? '-').join(' / ')
    colds.forEach((r, i) => console.log(`| ${r.backend} | ${r.c.name} | ${colds.slice(0, i + 1).filter((x) => x.backend === r.backend).length} | ${r.tTarget == null ? `not in ${COLD_SECONDS} s` : `${r.tTarget.toFixed(1)} s`} | ${r.tFull == null ? '-' : `${r.tFull.toFixed(1)} s`} | ${at(r.kbpsAt)} | ${at(r.bweAt)} | ${r.plis} |`))
  }
  if (process.env.VERBOSE) console.log(JSON.stringify(all.map((r) => ({ b: r.backend, c: r.c.name, v: r.view, fmtpIn: r.recv?.fmtp, impl: r.sent.map((s) => `${s.impl} ${s.fmtp} target ${s.target}`) })), null, 1))
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
