// Shared fake API + gateway for the v3 smoke suites (no server needed). Each suite opens its own page with `open()`
// and may handle extra routes with `routes(r, { pathname, method, body, url })` returning true when it answered.
const path = require('node:path')

const PORT = Number(process.env.SMOKE_PORT || 4179)
const ORIGIN = `http://localhost:${PORT}`
const root = path.join(__dirname, '..')
const shot = (name) => path.join(root, `smoke-v3-${name}.png`)

const P = (...bits) => String(bits.reduce((a, b) => a | (1n << BigInt(b)), 0n))
const user = (id, username, extra = {}) => ({ id, username, discriminator: '0', global_name: null, avatar: null, bot: false, ...extra })
const me = { ...user('100', 'ciller'), email: 'c@example.com' }
const bob = user('101', 'bob')
const carol = user('102', 'carol')
const G = '200' // Nightfall Gaming: owned by ciller (all permissions)
const G2 = '250' // Rules Lounge: ciller is a pending plain member (rules screening, slowmode)
const iso = (ms = 0) => new Date(Date.now() + ms).toISOString()
const member = (u, roles = [], extra = {}) => ({ user: u, nick: null, roles, joined_at: '2026-01-01T00:00:00.000Z', mute: false, deaf: false, ...extra })
const EVERYONE_V3 = P(0, 6, 9, 10, 11, 14, 15, 16, 18, 20, 21, 26, 31, 32, 35, 36, 37, 38, 42, 45, 46, 49)

const roles = [
  { id: G, name: '@everyone', color: 0, hoist: false, position: 0, permissions: EVERYONE_V3, mentionable: false, managed: false },
  { id: '500', name: 'Staff', color: 0xe67e22, hoist: true, position: 1, permissions: P(13, 22, 24, 34, 40), mentionable: true, managed: false },
]
const tags = [
  { id: '801', name: 'Question', moderated: false, emoji_id: null, emoji_name: '❓' },
  { id: '802', name: 'Guide', moderated: false, emoji_id: null, emoji_name: '📌' },
]
const channels = [
  { id: '600', type: 4, guild_id: G, name: 'Text Channels', position: 0, parent_id: null, permission_overwrites: [] },
  { id: '300', type: 0, guild_id: G, name: 'general', position: 0, parent_id: '600', topic: 'Say hi', last_message_id: '420', permission_overwrites: [], rate_limit_per_user: 0 },
  { id: '303', type: 5, guild_id: G, name: 'news', position: 1, parent_id: '600', topic: null, last_message_id: '430', permission_overwrites: [] },
  { id: '304', type: 15, guild_id: G, name: 'help-forum', position: 2, parent_id: '600', topic: 'Ask anything', last_message_id: '711', permission_overwrites: [],
    available_tags: tags, default_sort_order: 0, default_forum_layout: 1, flags: 0, default_reaction_emoji: { emoji_id: null, emoji_name: '👍' } },
  { id: '601', type: 4, guild_id: G, name: 'Voice Channels', position: 1, parent_id: null, permission_overwrites: [] },
  { id: '302', type: 2, guild_id: G, name: 'Lounge', position: 0, parent_id: '601', user_limit: 0, last_message_id: null, permission_overwrites: [] },
  { id: '305', type: 13, guild_id: G, name: 'Town Hall', position: 1, parent_id: '601', user_limit: 0, last_message_id: null, permission_overwrites: [] },
]
const thread = (id, parent, name, extra = {}) => ({
  id, type: 11, guild_id: G, parent_id: parent, owner_id: '101', name, last_message_id: id, message_count: 3, member_count: 2, total_message_sent: 3, rate_limit_per_user: 0, flags: 0,
  thread_metadata: { archived: false, auto_archive_duration: 1440, archive_timestamp: iso(-3600e3), locked: false, create_timestamp: iso(-3600e3) }, ...extra,
})
const threads = [
  thread('700', '300', 'patch notes talk', { member: { join_timestamp: iso(-60e3), flags: 0 } }),
  thread('710', '304', 'How do I set up push to talk?', { applied_tags: ['801'], message_count: 5 }),
  thread('711', '304', 'Voice settings guide', { applied_tags: ['802'], owner_id: '100', message_count: 1 }),
]
const emojis = [{ id: '900', name: 'pog', animated: false, roles: [], available: true, require_colons: true, user: bob }]
const stickers = [{ id: '950', name: 'wave', description: 'Hello!', tags: 'wave', format_type: 1, guild_id: G, available: true }]
const voiceState = (u, channel, extra = {}) => ({ guild_id: G, channel_id: channel, user_id: u.id, session_id: 'x' + u.id, self_mute: false, self_deaf: false, self_video: false, self_stream: false, mute: false, deaf: false, member: member(u), suppress: false, request_to_speak_timestamp: null, ...extra })
const events = [{
  id: '980', guild_id: G, channel_id: '305', creator_id: '100', creator: me, name: 'Patch Party', description: 'We read the patch notes together.',
  scheduled_start_time: iso(2 * 86400e3), scheduled_end_time: null, privacy_level: 2, status: 1, entity_type: 1, entity_metadata: null, user_count: 4, image: null,
}]
const sounds = [{ sound_id: '990', name: 'airhorn', volume: 1, emoji_id: null, emoji_name: '📯', guild_id: G, available: true, user: bob }]

const base = (channel = '300', guild = G) => ({ channel_id: channel, guild_id: guild, edited_timestamp: null, mentions: [], attachments: [], embeds: [], pinned: false, timestamp: iso(-60e3), flags: 0 })
const png = '/attachments/300/1/pixel.png'
const history = {
  '300': [
    { ...base(), id: '420', type: 0, author: bob, content: 'pog <:pog:900>', reactions: [{ emoji: { id: '900', name: 'pog' }, count: 2, me: false }] },
    { ...base(), id: '419', type: 0, author: bob, content: '', sticker_items: [{ id: '950', name: 'wave', format_type: 1 }] },
    { ...base(), id: '418', type: 0, author: bob, content: 'Best lineup? Vote!',
      poll: { question: { text: 'Which map next?' }, answers: [{ answer_id: 1, poll_media: { text: 'Mirage' } }, { answer_id: 2, poll_media: { text: 'Inferno', emoji: { id: null, name: '🔥' } } }],
        expiry: iso(86400e3), allow_multiselect: false, layout_type: 1, results: { is_finalized: false, answer_counts: [{ id: 1, count: 3, me_voted: false }, { id: 2, count: 1, me_voted: false }] } } },
    { ...base(), id: '417', type: 0, author: bob, content: 'Watch this https://www.youtube.com/watch?v=dQw4w9WgXcQ and read https://example.com/post',
      embeds: [
        { type: 'video', title: 'Never Gonna Give You Up', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', color: 0xff0000, provider: { name: 'YouTube', url: 'https://www.youtube.com' },
          author: { name: 'Rick Astley', url: 'https://www.youtube.com/@RickAstleyYT' }, thumbnail: { url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg', proxy_url: png, width: 480, height: 360 },
          video: { url: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', width: 1280, height: 720 } },
        { type: 'article', title: 'Example Post', url: 'https://example.com/post', description: 'An **example** article for the link card.', provider: { name: 'Example' }, thumbnail: { url: 'https://example.com/t.png', proxy_url: png, width: 80, height: 80 } },
      ] },
    { ...base(), id: '416', type: 0, author: user('960', 'Captain Hook', { bot: true }), webhook_id: '960', content: '',
      embeds: [{ type: 'rich', title: 'Build #42 passed', description: 'All **17** checks are green.', color: 0x57f287, author: { name: 'CI' }, fields: [{ name: 'Branch', value: 'main', inline: true }, { name: 'Time', value: '3m 12s', inline: true }], footer: { text: 'cillhub-ci' }, timestamp: iso(-120e3) }] },
    { ...base(), id: '415', type: 0, author: bob, content: 'thread starter', thread: threads[0] },
    { ...base(), id: '414', type: 19, author: bob, content: 'replying to something old', message_reference: { message_id: '401', channel_id: '300', guild_id: G },
      referenced_message: { ...base(), id: '401', type: 0, author: bob, content: 'an old message far up' } },
  ],
  '303': [{ ...base('303'), id: '430', type: 0, author: me, content: 'Patch 1.2 is live!' }],
  '700': [{ ...base('700'), id: '701', type: 0, author: bob, content: 'what do we think about the patch?' }],
  '710': [{ ...base('710'), id: '710', type: 0, author: bob, content: 'I cannot find the push to talk setting.' }],
  '711': [{ ...base('711'), id: '711', type: 0, author: me, content: 'Open User Settings, then Voice & Video.' }],
  '310': [{ ...base('310', G2), id: '440', type: 0, author: carol, content: 'Read the rules first.' }],
}
// An old message found by search and loaded with `around=`.
const old = { ...base(), id: '401', type: 0, author: bob, content: 'an old message far up', timestamp: iso(-86400e3) }

function readyGuilds() {
  return [
    { id: G, name: 'Nightfall Gaming', icon: null, owner_id: '100', member_count: 3, system_channel_id: '300', roles, channels, threads, emojis, stickers,
      features: ['COMMUNITY', 'WELCOME_SCREEN_ENABLED'], afk_channel_id: null, afk_timeout: 300, verification_level: 0, rules_channel_id: null, description: 'Gaming org',
      members: [member(me), member(bob, ['500']), member(carol)],
      voice_states: [voiceState(bob, '305'), voiceState(carol, '305', { suppress: true, request_to_speak_timestamp: iso(-30e3) })],
      stage_instances: [{ id: '970', guild_id: G, channel_id: '305', topic: 'Season kickoff Q&A', privacy_level: 2 }],
      guild_scheduled_events: events, soundboard_sounds: sounds },
    { id: G2, name: 'Rules Lounge', icon: null, owner_id: '102', member_count: 2, system_channel_id: '310', features: ['COMMUNITY', 'MEMBER_VERIFICATION_GATE_ENABLED'],
      roles: [{ id: G2, name: '@everyone', color: 0, hoist: false, position: 0, permissions: EVERYONE_V3, mentionable: false, managed: false }],
      channels: [{ id: '310', type: 0, guild_id: G2, name: 'rules-chat', position: 0, parent_id: null, topic: null, last_message_id: '440', permission_overwrites: [], rate_limit_per_user: 30 }],
      rules_channel_id: '310', verification_level: 0, emojis: [], stickers: [],
      members: [member(me, [], { pending: true, joined_at: iso(-3600e3) }), member(carol)], voice_states: [] },
  ]
}

/**
 * Opens a page logged in as ciller against the fake API. Returns helpers:
 * page, ctx, ops (client gateway frames), posted (POST/PATCH/PUT bodies with paths), dispatch(t, d) to send a gateway event.
 */
// A stand-in for the lazily loaded livekit-client chunk (same export names), so voice reaches "connected" without a
// LiveKit server. It records what the app asks for on window.__lk (screen share options, constraints, sender params, processor).
const FAKE_LIVEKIT = `
const lk = (window.__lk = { screen: null, constraints: null, params: null, gain: null, mic: false })
export const RoomEvent = new Proxy({}, { get: (_, k) => String(k) })
const stats = () => new Map([
  ['o', { id: 'o', type: 'outbound-rtp', kind: 'audio', bytesSent: (lk.bytes = (lk.bytes ?? 0) + 8000), timestamp: performance.now(), codecId: 'c' }],
  ['c', { id: 'c', type: 'codec', mimeType: 'audio/opus' }],
  ['r', { id: 'r', type: 'remote-inbound-rtp', kind: 'audio', fractionLost: 0.01, jitter: 0.003, roundTripTime: 0.04 }],
  ['t', { id: 't', type: 'transport', selectedCandidatePairId: 'p' }],
  ['p', { id: 'p', type: 'candidate-pair', currentRoundTripTime: 0.042, localCandidateId: 'l' }],
  ['l', { id: 'l', type: 'local-candidate', candidateType: 'host', protocol: 'udp' }],
])
const mic = { proc: undefined, getProcessor() { return this.proc }, async setProcessor(p) { this.proc = p; lk.gain = p.gain }, async stopProcessor() { this.proc = undefined; lk.gain = 1 },
  async restartTrack(c) { lk.restart = c; if (window.__fakeMics) this.mediaStreamTrack = (await navigator.mediaDevices.getUserMedia({ audio: c })).getAudioTracks()[0] }, getRTCStatsReport: async () => stats(), sender: { getParameters: () => ({ encodings: [{ maxBitrate: 64000 }] }), setParameters: async (p) => (lk.micParams = p) } }
// faked encoder/decoder stats: the top simulcast layer on a GPU encoder, the received share on a software decoder
// (lk.encoder = { mime, impl, hw } swaps the codec and encoder)
const videoStats = (dir) => new Map([
  ['v', dir === 'send'
    ? { id: 'v', type: 'outbound-rtp', kind: 'video', codecId: 'vc', frameWidth: 1920, frameHeight: 1080, framesPerSecond: 30, encoderImplementation: lk.encoder?.impl ?? 'MediaFoundationVideoEncodeAccelerator', powerEfficientEncoder: lk.encoder?.hw ?? true }
    : { id: 'v', type: 'inbound-rtp', kind: 'video', codecId: 'vc', frameWidth: 1280, frameHeight: 720, framesPerSecond: 15, decoderImplementation: 'FFmpeg', powerEfficientDecoder: false }],
  ['l', { id: 'l', type: 'outbound-rtp', kind: 'video', codecId: 'vc', frameWidth: 960, frameHeight: 540, framesPerSecond: 30, encoderImplementation: 'OpenH264', powerEfficientEncoder: false }],
  ['vc', { id: 'vc', type: 'codec', mimeType: lk.encoder?.mime ?? 'video/H264' }],
].filter(([, s]) => dir === 'send' || s.type !== 'outbound-rtp'))
const screen = { getRTCStatsReport: async () => videoStats('send'), mediaStreamTrack: { contentHint: '', applyConstraints: async (c) => (lk.constraints = c) },
  sender: { getParameters: () => ({ encodings: [{ maxBitrate: 4000000, maxFramerate: 30 }, { maxBitrate: 1000000, maxFramerate: 30 }] }), setParameters: async (p) => (lk.params = p) } }
export const getBrowser = () => ({ name: 'Chrome' })
class Local {
  pubs = new Map(); videoTrackPublications = new Map(); identity = '100'
  async setAttributes(a) { lk.attributes = a }
  getTrackPublication(s) { return this.pubs.get(s) }
  async setMicrophoneEnabled(on, c) {
    // with faked devices (window.__fakeMics) a new capture goes through getUserMedia like the real one
    if (on && !this.pubs.has('microphone') && window.__fakeMics) mic.mediaStreamTrack = (await navigator.mediaDevices.getUserMedia({ audio: c })).getAudioTracks()[0]
    lk.mic = on; on ? this.pubs.set('microphone', { track: mic }) : this.pubs.delete('microphone') }
  async setCameraEnabled() {}
  async setScreenShareEnabled(on, capture, publish) { lk.screen = on ? { capture, publish } : null; on ? this.pubs.set('screen_share', { track: screen }) : this.pubs.delete('screen_share') }
  async unpublishTrack() {}
}
export class Room {
  constructor(opts) {
    lk.room = opts; this.localParticipant = new Local(); this.activeSpeakers = []
    // bob shares his screen (only its stats are used)
    const bobScreen = { track: { getRTCStatsReport: async () => videoStats('recv') } }
    // lk.bobAttributes: bob's LiveKit participant attributes (av1: '0' = his browser gets no AV1)
    this.remoteParticipants = new Map([['101', { identity: '101', attributes: (lk.bobAttributes = {}), setVolume() {}, audioTrackPublications: new Map(), videoTrackPublications: new Map(), getTrackPublication: (s) => (s === 'screen_share' ? bobScreen : undefined) }]])
  }
  on() { return this }
  async connect(url) { lk.url = url }
  async disconnect() {}
  async switchActiveDevice() {}
}
`

async function open(browser, { routes, viewport = { width: 1440, height: 900 }, url = `/channels/${G}/300`, errors = [], livekit = false, ready = (d) => d, init, context } = {}) {
  // The production build registers a service worker; block it so route interception sees every request.
  const ctx = await browser.newContext({ viewport, serviceWorkers: 'block', ...context })
  await ctx.addInitScript(() => localStorage.setItem('token', 'smoke-token'))
  if (init) await ctx.addInitScript(init)
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('dialog', (d) => (errors.push(`native dialog: ${d.message()}`), d.dismiss()))
  let sock
  let seq = 10
  let voiceChannel = null
  const ops = []
  const posted = []
  const dispatch = (t, d) => sock.send(JSON.stringify({ op: 0, s: ++seq, t, d }))
  await page.routeWebSocket(`ws://localhost:${PORT}/gateway`, (ws) => {
    sock = ws
    ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 41250 }, s: null, t: null }))
    ws.onMessage((raw) => {
      const f = JSON.parse(raw)
      ops.push(f)
      if (f.op === 2)
        ws.send(JSON.stringify({ op: 0, s: 1, t: 'READY', d: ready({
          v: 9, session_id: 's3', user: me, users: [bob, carol], private_channels: [], relationships: [],
          read_state: [{ id: '300', last_message_id: '420', mention_count: 0 }], user_settings: { status: 'online' },
          presences: [{ user: { id: '101' }, status: 'online' }, { user: { id: '102' }, status: 'online' }], guilds: readyGuilds(),
        }) }))
      if (f.op === 4 && !f.d.channel_id) voiceChannel = null
      if (f.op === 4 && f.d.channel_id) {
        dispatch('VOICE_STATE_UPDATE', { ...voiceState(me, f.d.channel_id), ...f.d, user_id: me.id, session_id: 's3', suppress: f.d.channel_id === '305' })
        // Like the server: a fresh VOICE_SERVER_UPDATE only when joining or moving, not for flag changes (mute, stream).
        if (f.d.channel_id !== voiceChannel) dispatch('VOICE_SERVER_UPDATE', { guild_id: f.d.guild_id, channel_id: f.d.channel_id, token: livekit ? 'fake-token' : null, endpoint: livekit ? 'ws://fake-livekit.invalid' : null })
        voiceChannel = f.d.channel_id
      }
    })
  })
  if (livekit) await page.route(/\/assets\/livekit-client[^/]*\.js$/, (r) => r.fulfill({ contentType: 'text/javascript', body: FAKE_LIVEKIT }))
  await page.route('**/{api/v9,attachments,emojis,stickers,soundboard-sounds,external}/**', async (r) => {
    const url = new URL(r.request().url())
    const { pathname } = url
    const method = r.request().method()
    let body
    try { body = r.request().postDataJSON() } catch { body = r.request().postData() }
    if (method !== 'GET') posted.push({ method, pathname, body })
    if (routes && (await routes(r, { pathname, method, body, url }))) return
    if (/^\/(attachments|emojis|stickers|external)\//.test(pathname))
      return r.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64') })
    if (pathname.endsWith('/gateway')) return r.fulfill({ json: { url: `ws://localhost:${PORT}/gateway` } })
    if (pathname.endsWith(`/guilds/${G}/members`)) return r.fulfill({ json: [member(me), member(bob, ['500']), member(carol)] })
    if (pathname.endsWith(`/guilds/${G2}/members`)) return r.fulfill({ json: [member(me, [], { pending: true }), member(carol)] })
    const msgs = pathname.match(/\/channels\/(\d+)\/messages$/)
    if (msgs && method === 'GET') {
      if (url.searchParams.get('around')) return r.fulfill({ json: [...(history[msgs[1]] ?? []), old] })
      const after = url.searchParams.get('after')
      if (after) return r.fulfill({ json: (history[msgs[1]] ?? []).filter((m) => BigInt(m.id) > BigInt(after)) })
      return r.fulfill({ json: history[msgs[1]] ?? [] })
    }
    if (msgs && method === 'POST') {
      const b = typeof body === 'object' && body ? body : {}
      return r.fulfill({ status: 201, json: { ...base(msgs[1]), id: String(5000 + posted.length), type: 0, author: me, content: b.content ?? '', nonce: b.nonce, poll: b.poll, timestamp: iso() } })
    }
    if (pathname.endsWith('/ack')) return r.fulfill({ json: { token: null } })
    if (pathname.endsWith('/pins')) return r.fulfill({ json: [] })
    if (pathname.endsWith('/soundboard-sounds') && method === 'GET') return r.fulfill({ json: { items: sounds } })
    if (pathname.includes('/scheduled-events') && method === 'GET') return r.fulfill({ json: pathname.startsWith('/api/v9/users') ? [] : events })
    if (pathname.startsWith('/api/v9/gifs')) return r.fulfill({ status: 404, json: { code: 0, message: 'GIFs are not configured' } })
    if (method === 'GET') return r.fulfill({ status: 404, json: { code: 0, message: 'Not found in smoke fixtures' } })
    r.fulfill({ status: 204 })
  })
  await page.goto(ORIGIN + url)
  await page.locator('.app[data-gateway="ready"]').waitFor()
  return { page, ctx, ops, posted, dispatch }
}

module.exports = { open, FAKE_LIVEKIT, ORIGIN, PORT, root, shot, P, user, me, bob, carol, G, G2, member, base, iso, history, threads, channels, events, sounds, emojis, stickers, old }
