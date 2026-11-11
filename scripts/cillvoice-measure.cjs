// cillvoice measurement: an N-person call (default 4) for DURATION seconds against a fresh throwaway server with
// VOICE_BACKEND=cillvoice, everyone with microphone and camera (simulcast), one person also sharing the screen.
// Each page runs a minimal client of its own (gateway ops 4/50, one RTCPeerConnection) instead of the app, so the
// numbers describe the media server, not the UI.
// Reports per receiver: audio one-way latency (the sender stamps each encoded Opus frame with its send time through
// encoded insertable streams and the receiver compares on arrival; all pages share one clock) plus the receiver's jitter
// buffer delay as a mouth-to-ear-ish proxy, packet loss and jitter from getStats, video layers/resolution; and CPU and
// memory of the server process from /proc.
// Run: NODE_PATH=/tmp/pw/node_modules node scripts/cillvoice-measure.cjs
// env: PEOPLE=4 DURATION=120 HTTP_PORT=3340 UDP_PORT=3341, LOSS=<percent of the server's RTP dropped> (tests NACK),
// CODEC=h264 (publish video as H.264 instead of VP8), CILLVOICE_DEBUG=1 (the server logs layers and bandwidth).
const { chromium } = require('playwright')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const PEOPLE = Number(process.env.PEOPLE ?? 4)
const DURATION = Number(process.env.DURATION ?? 120)
const HTTP_PORT = Number(process.env.HTTP_PORT ?? 3340)
const UDP_PORT = Number(process.env.UDP_PORT ?? 3341)
const BASE = `http://127.0.0.1:${HTTP_PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(method, route, token, body) {
  const r = await fetch(`${BASE}/api/v9${route}`, { method, headers: { ...(token && { Authorization: token }), ...(body && { 'Content-Type': 'application/json' }) }, body: body && JSON.stringify(body) })
  const text = await r.text()
  if (r.status >= 300) throw new Error(`${method} ${route}: HTTP ${r.status} ${text}`)
  return text ? JSON.parse(text) : null
}

function proc(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')
  const rss = Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))[1])
  return { cpu: (Number(stat[11]) + Number(stat[12])) / 100, rssMb: rss / 1024 } // utime + stime in seconds (CLK_TCK 100)
}

// ---- runs inside each page ----
async function pageClient({ token, guildId, channelId, camera, screen, codec }) {
  const W = window
  W.cv = { latencies: [], speaking: [], log: [], errors: [] }
  let ws
  const send = (op, d) => ws.send(JSON.stringify({ op, d }))
  const pc = new RTCPeerConnection({ bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require', encodedInsertableStreams: true })
  W.cv.pc = pc
  let cvToken = null, remote = [], busy = null, again = false, answerWait = null
  const mapped = new Map() // mid -> track id
  const stamp = (sender) => {
    const { readable, writable } = sender.createEncodedStreams()
    readable.pipeThrough(new TransformStream({
      transform(frame, c) {
        if (sender.track?.kind === 'audio') {
          const d = new Uint8Array(frame.data.byteLength + 8)
          d.set(new Uint8Array(frame.data))
          new DataView(d.buffer).setFloat64(frame.data.byteLength, performance.timeOrigin + performance.now())
          frame.data = d.buffer
        }
        c.enqueue(frame)
      },
    })).pipeTo(writable)
  }
  const unstamp = (receiver) => {
    const { readable, writable } = receiver.createEncodedStreams()
    readable.pipeThrough(new TransformStream({
      transform(frame, c) {
        if (receiver.track.kind === 'audio' && frame.data.byteLength > 8) {
          const n = frame.data.byteLength - 8
          const sent = new DataView(frame.data).getFloat64(n)
          W.cv.latencies.push(performance.timeOrigin + performance.now() - sent)
          frame.data = frame.data.slice(0, n)
        }
        c.enqueue(frame)
      },
    })).pipeTo(writable)
  }
  pc.ontrack = (e) => {
    unstamp(e.receiver)
    const el = document.createElement(e.track.kind)
    el.srcObject = new MediaStream([e.track])
    el.muted = true
    el.autoplay = true
    document.body.appendChild(el)
  }
  const media = await navigator.mediaDevices.getUserMedia({ audio: true, video: camera ? { width: 1280, height: 720 } : false })
  const publish = []
  const add = (track, source, encodings) => {
    const t = pc.addTransceiver(track, { direction: 'sendonly', ...(encodings && { sendEncodings: encodings }) })
    if (codec && track.kind === 'video') t.setCodecPreferences(RTCRtpReceiver.getCapabilities('video').codecs.sort((a, b) => (b.mimeType.toLowerCase() === `video/${codec}`) - (a.mimeType.toLowerCase() === `video/${codec}`)))
    stamp(t.sender)
    publish.push({ t, source })
  }
  add(media.getAudioTracks()[0], 'microphone')
  if (camera) add(media.getVideoTracks()[0], 'camera', [{ rid: 'q', scaleResolutionDownBy: 4, maxBitrate: 150e3 }, { rid: 'h', scaleResolutionDownBy: 2, maxBitrate: 500e3 }, { rid: 'f', maxBitrate: 1500e3 }])
  if (screen) {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: { width: 1920, height: 1080, frameRate: 30 } })
    add(s.getVideoTracks()[0], 'screen_share', [{ rid: 'h', scaleResolutionDownBy: 2, maxBitrate: 1e6 }, { rid: 'f', maxBitrate: 4e6 }])
  }
  async function negotiate() {
    if (busy) return void (again = true)
    busy = (async () => {
      do {
        again = false
        const want = new Map(remote.map((t) => [t.id, t]))
        for (const [mid, id] of mapped) if (!want.has(id)) {
          mapped.delete(mid)
          const tr = pc.getTransceivers().find((x) => x.mid === mid)
          if (tr) tr.direction = 'inactive'
        }
        const fresh = [...want.values()].filter((t) => ![...mapped.values()].includes(t.id))
        const pending = []
        for (const t of fresh) {
          const free = pc.getTransceivers().find((x) => x.mid && !mapped.has(x.mid) && x.direction === 'inactive' && x.receiver.track.kind === t.kind && !publish.some((p) => p.t === x))
          const tr = free ?? pc.addTransceiver(t.kind, { direction: 'recvonly' })
          tr.direction = 'recvonly'
          pending.push([tr, t.id])
        }
        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        for (const [tr, id] of pending) mapped.set(tr.mid, id)
        const answered = new Promise((r) => (answerWait = r))
        send(50, { token: cvToken, sdp: offer.sdp, publish: publish.map((p) => ({ mid: p.t.mid, source: p.source })), subscribe: [...mapped].map(([mid, track_id]) => ({ mid, track_id })) })
        const a = await answered
        await pc.setRemoteDescription({ type: 'answer', sdp: a.sdp })
        if (a.tracks.some((t) => ![...mapped.values()].includes(t.id))) again = true // the answer lists tracks we have not asked for yet
      } while (again)
      busy = null
    })().catch((e) => (W.cv.errors.push(String(e)), (busy = null)))
  }
  ws = new WebSocket(location.origin.replace(/^http/, 'ws') + '/gateway?v=9&encoding=json')
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    W.cv.log.push(m.t ?? m.op)
    if (m.op === 10) {
      setInterval(() => send(1, null), m.d.heartbeat_interval)
      send(2, { token, properties: { os: 'linux', browser: 'cillvoice-measure', device: '' } })
    }
    if (m.op !== 0) return
    if (m.t === 'READY') send(4, { guild_id: guildId, channel_id: channelId, self_mute: false, self_deaf: false })
    if (m.t === 'VOICE_SERVER_UPDATE') { cvToken = m.d.token; W.cv.endpoint = m.d.endpoint; negotiate() }
    if (m.t === 'CILLVOICE_ANSWER') { remote = m.d.tracks; answerWait?.(m.d) }
    if (m.t === 'CILLVOICE_TRACKS') { remote = m.d.tracks; negotiate() }
    if (m.t === 'CILLVOICE_SPEAKING') W.cv.speaking = m.d.speaking
    if (m.t === 'CILLVOICE_ERROR') W.cv.errors.push(m.d.message)
  }
}

async function pageStats() {
  const pc = window.cv.pc
  const r = await pc.getStats()
  const out = { inAudio: [], inVideo: [], rtt: null, state: pc.connectionState }
  r.forEach((s) => {
    if (s.type === 'inbound-rtp') (s.kind === 'audio' ? out.inAudio : out.inVideo).push({
      lost: s.packetsLost, received: s.packetsReceived, jitter: s.jitter, concealed: s.concealedSamples, samples: s.totalSamplesReceived, jbDelay: s.jitterBufferEmittedCount ? s.jitterBufferDelay / s.jitterBufferEmittedCount : null,
      codec: r.get(s.codecId)?.mimeType?.split('/')[1], width: s.frameWidth, fps: s.framesPerSecond, frames: s.framesDecoded, bytes: s.bytesReceived, nacks: s.nackCount, plis: s.pliCount,
    })
    if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') out.rtt = s.currentRoundTripTime
  })
  const lat = window.cv.latencies.splice(0)
  out.latency = lat
  out.errors = window.cv.errors
  out.speaking = window.cv.speaking
  return out
}

const pct = (a, p) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((a.length * p) / 100))] : NaN)
const f1 = (n) => (Number.isFinite(n) ? n.toFixed(1) : '-')

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cillvoice-measure-'))
  const server = spawn(process.execPath, ['src/index.js'], {
    cwd: path.join(__dirname, '..', 'server'),
    env: { ...process.env, PORT: String(HTTP_PORT), DATA_DIR: dataDir, VOICE_BACKEND: 'cillvoice', CILLVOICE_UDP_PORT: String(UDP_PORT), CILLVOICE_PUBLIC_IP: '127.0.0.1', CILLVOICE_DEBUG: process.env.CILLVOICE_DEBUG ?? '', CILLVOICE_TEST_DROP: String((Number(process.env.LOSS) || 0) / 100), CILLCORD_RATE_LIMIT_SCALE: '100', LIVEKIT_URL: '', LIVEKIT_PUBLIC_URL: '' },
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  let browser
  try {
    for (let i = 0; ; i++) {
      if (await fetch(BASE + '/api/v9/gateway').then((r) => r.ok, () => false)) break
      if (i > 100) throw new Error('server did not start')
      await sleep(100)
    }
    const sfx = Math.random().toString(36).slice(2, 7)
    const users = []
    for (let i = 0; i < PEOPLE; i++) users.push((await api('POST', '/auth/register', null, { age_confirmed: true, email: `m${i}${sfx}@example.com`, username: `m${i}_${sfx}`, password: 'measure measure' })).token)
    const guild = await api('POST', '/guilds', users[0], { name: 'Measure' })
    const voice = guild.channels.find((c) => c.type === 2)
    const general = guild.channels.find((c) => c.type === 0)
    const invite = await api('POST', `/channels/${general.id}/invites`, users[0], { max_age: 0 })
    for (const t of users.slice(1)) await api('POST', `/invites/${invite.code}`, t)

    browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--auto-select-desktop-capture-source=Entire screen', '--autoplay-policy=no-user-gesture-required'] })
    const pages = []
    for (let i = 0; i < PEOPLE; i++) {
      const ctx = await browser.newContext({ permissions: ['microphone', 'camera'], serviceWorkers: 'block' })
      const page = await ctx.newPage()
      page.on('pageerror', (e) => console.error(`page ${i}: ${e.message}`))
      await page.goto(BASE + '/api/v9/gateway')
      await page.evaluate(pageClient, { token: users[i], guildId: guild.id, channelId: voice.id, camera: true, screen: i === 0, codec: process.env.CODEC })
      pages.push(page)
    }
    console.log(`# ${PEOPLE} people, camera each, screen share from person 0, ${DURATION} s`)
    const start = proc(server.pid)
    const t0 = Date.now()
    const samples = { cpu: [], rss: [] }
    const lat = pages.map(() => [])
    let last = start
    await sleep(5000) // warm-up: negotiation, first keyframes, bandwidth ramp-up
    for (const p of pages) await p.evaluate(pageStats)
    if (process.env.DEBUG) for (const p of pages) console.log(await p.evaluate(() => ({ endpoint: window.cv.endpoint, ice: window.cv.pc.iceConnectionState, conn: window.cv.pc.connectionState, sig: window.cv.pc.signalingState, errors: window.cv.errors, log: window.cv.log, remote: window.cv.pc.remoteDescription?.sdp })))
    while (Date.now() - t0 < DURATION * 1000) {
      await sleep(5000)
      const now = proc(server.pid)
      samples.cpu.push(((now.cpu - last.cpu) / 5) * 100)
      samples.rss.push(now.rssMb)
      last = now
      for (const [i, p] of pages.entries()) lat[i].push(...(await p.evaluate(pageStats)).latency)
    }
    const end = proc(server.pid)
    console.log('\nreceiver  audio-lat p50/p95 ms  jb ms  ear~ ms  a-loss %  concealed %  a-jitter ms  video streams (w x fps, loss %)')
    const all = { lat: [], loss: [], jit: [] }
    for (const [i, p] of pages.entries()) {
      const s = await p.evaluate(pageStats)
      if (s.errors.length) console.log(`  page ${i} errors: ${s.errors.join('; ')}`)
      const a = s.inAudio
      const lost = a.reduce((x, y) => x + y.lost, 0), rec = a.reduce((x, y) => x + y.received, 0)
      const jb = a.map((x) => x.jbDelay * 1000).filter(Number.isFinite)
      const jbAvg = jb.reduce((x, y) => x + y, 0) / jb.length
      const jit = a.map((x) => x.jitter * 1000)
      const concealed = (100 * a.reduce((x, y) => x + (y.concealed ?? 0), 0)) / (a.reduce((x, y) => x + (y.samples ?? 0), 0) || 1)
      const vid = s.inVideo.filter((v) => v.frames).map((v) => `${v.codec} ${v.width}x${f1(v.fps)} ${f1((100 * v.lost) / (v.lost + v.received || 1))}%`).join(', ')
      all.lat.push(...lat[i]); all.loss.push((100 * lost) / (lost + rec || 1)); all.jit.push(...jit)
      console.log(`  ${i}       ${f1(pct(lat[i], 50))} / ${f1(pct(lat[i], 95))}           ${f1(jbAvg)}   ${f1(pct(lat[i], 50) + jbAvg)}    ${f1((100 * lost) / (lost + rec || 1))}      ${f1(concealed)}        ${f1(Math.max(...jit))}        ${vid}  (${a.length} audio, ${s.inVideo.length} video, rtt ${f1(s.rtt * 1000)} ms)`)
    }
    console.log(`\nall receivers: audio one-way latency p50 ${f1(pct(all.lat, 50))} ms, p95 ${f1(pct(all.lat, 95))} ms, max ${f1(Math.max(...all.lat))} ms; audio loss max ${f1(Math.max(...all.loss))} %; audio jitter max ${f1(Math.max(...all.jit))} ms`)
    console.log(`server process: CPU avg ${f1(((end.cpu - start.cpu) / ((Date.now() - t0) / 1000)) * 100)} % of one core (5 s peak ${f1(Math.max(...samples.cpu))} %), RSS ${f1(start.rssMb)} -> ${f1(end.rssMb)} MB (max ${f1(Math.max(...samples.rss))} MB)`)
  } finally {
    await browser?.close()
    server.kill()
    await new Promise((r) => server.once('exit', r))
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
