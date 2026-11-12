// v7 smoke (CONTRACT-v7): two faked instances in one browser context, the hub (this origin) and a linked node at
// https://node.example (REST, CDN and gateway all intercepted). Covers the first-run wizard, the server directory with the
// node sign-in through the hub (popup + consent screen), node servers in the rail with marker, mentions, aliasing of our
// node account, sending and voice through the node, offline / suspended / disconnect handling, invite links of the node,
// listing a server in the directory, and the admin pages (hub: Nodes, Server Directory; node: Federation, Updates).
// Saves smoke-v7-*.png. Run alone: SMOKE_ONLY=v7 npm run smoke (or as part of npm run smoke).
const assert = require('node:assert/strict')
const path = require('node:path')
const h = require('./smoke-v3-harness.cjs')

const shot = (name) => path.join(h.root, `smoke-v7-${name}.png`)
const NODE = 'https://node.example'
const N = '7000' // node id
const NODE_ME = '7001' // our linked account on the node (the hub knows us as h.me.id = '100')
const dana = h.user('7002', 'dana')
const nodeRecord = (status = 'active', online = true) => ({ node_id: N, name: "Dana's Node", url: NODE, description: 'LAN crew', icon: null, version: '7.0.0', mode: 'connected',
  public_servers_count: 1, member_count: 12, online, last_seen: h.iso(-60e3), status })
const nodeMe = { ...h.user(NODE_ME, 'ciller'), hub_user_id: '100', avatar: 'nodehash' }
const NG = '7100'
const nodeGuild = {
  id: NG, name: 'Node Arena', icon: null, owner_id: '7002', member_count: 2, system_channel_id: '7101', features: [], afk_channel_id: null, afk_timeout: 300, verification_level: 0,
  roles: [{ id: NG, name: '@everyone', color: 0, hoist: false, position: 0, permissions: h.P(0, 6, 10, 11, 14, 15, 16, 18, 20, 21, 25, 26, 31), mentionable: false, managed: false }],
  channels: [
    { id: '7101', type: 0, guild_id: NG, name: 'arena-chat', position: 0, parent_id: null, last_message_id: '7150', permission_overwrites: [] },
    { id: '7103', type: 0, guild_id: NG, name: 'off-topic', position: 1, parent_id: null, last_message_id: null, permission_overwrites: [] },
    { id: '7102', type: 2, guild_id: NG, name: 'Arena Voice', position: 2, parent_id: null, user_limit: 0, permission_overwrites: [] },
  ],
  members: [h.member(nodeMe), h.member(dana)], voice_states: [], emojis: [], stickers: [],
}
const NG2 = '7200'
const nodeGuild2 = { ...nodeGuild, id: NG2, name: 'Node Scrims', roles: [{ ...nodeGuild.roles[0], id: NG2 }],
  channels: [{ id: '7201', type: 0, guild_id: NG2, name: 'scrims', position: 0, parent_id: null, last_message_id: null, permission_overwrites: [] }] }
const hubGuild = {
  id: '200', name: 'Nightfall Gaming', icon: null, owner_id: '100', member_count: 1, system_channel_id: '300', features: [], roles: [{ id: '200', name: '@everyone', color: 0, hoist: false, position: 0, permissions: h.P(10, 11), mentionable: false, managed: false }],
  channels: [{ id: '300', type: 0, guild_id: '200', name: 'general', position: 0, parent_id: null, last_message_id: null, permission_overwrites: [] }], members: [h.member(h.me)], voice_states: [], description: null,
}
const listing = (id, name, node, extra = {}) => ({ id, name, description: `${name} is a friendly place.`, icon: null, banner: null, icon_url: null, banner_url: null, keywords: ['cs2', 'scrims'],
  preferred_locale: 'de', approximate_member_count: 42, approximate_presence_count: 7, primary_category_id: 1, node, ...extra })
const nodeChip = (status = 'active', online = true) => ({ node_id: N, name: "Dana's Node", url: NODE, icon: null, status, online })
const cors = { 'access-control-allow-origin': h.ORIGIN, 'access-control-allow-headers': 'authorization, content-type, x-audit-log-reason', 'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE' }
const until = async (fn, what) => {
  for (let i = 0; i < 100; i++) {
    const v = fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** A context with the faked hub (role "hub") and node. */
async function twoInstances(browser, errors, { init } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' })
  // try: the popup also passes through documents of other origins (redirects) where storage is denied
  await ctx.addInitScript(() => { try { localStorage.setItem('token', 'smoke-token') } catch { /* not our origin */ } })
  if (init) await ctx.addInitScript(init)
  const st = { nodes: [nodeRecord()], nodeOffline: false, hubCalls: [], nodeCalls: [], clientState: null, hubSock: null, nodeSock: null, hubOps: [], nodeOps: [], nodeIdentify: [] }
  ctx.on('page', (p) => (p.on('pageerror', (e) => errors.push(e.message)), p.on('dialog', (d) => (errors.push(`native dialog: ${d.message()}`), d.dismiss()))))
  await ctx.route('**/livekit-client*.js', (r) => (/\/assets\//.test(r.request().url()) ? r.fulfill({ contentType: 'text/javascript', body: h.FAKE_LIVEKIT }) : r.fallback()))

  // ----- hub -----
  await ctx.routeWebSocket(`ws://localhost:${h.PORT}/gateway`, (ws) => {
    st.hubSock = ws
    ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 41250 } }))
    ws.onMessage((raw) => {
      const f = JSON.parse(raw)
      st.hubOps.push(f)
      if (f.op === 2) ws.send(JSON.stringify({ op: 0, s: 1, t: 'READY', d: hubReady() }))
    })
  })
  const hubReady = () => ({ v: 9, session_id: 'hub-sess', user: { ...h.me, instance_admin: false }, users: [], private_channels: [], relationships: [], read_state: [], user_settings: { status: 'online' }, presences: [], guilds: [hubGuild] })
  await ctx.route(new RegExp(`^${h.ORIGIN}/(api/v9|attachments|icons|avatars)/`), async (r) => {
    const req = r.request()
    const url = new URL(req.url())
    const p = url.pathname.replace('/api/v9', '')
    const method = req.method()
    let body
    try { body = req.postDataJSON() } catch { body = undefined }
    st.hubCalls.push({ method, p, body, query: Object.fromEntries(url.searchParams) })
    const json = (j, status = 200) => r.fulfill({ status, json: j })
    if (p === '/instance') return json({ name: 'Cillhub Hub', motd: null, registration_mode: 'open', announcement: null, federation: { role: 'hub', mode: null, hub_url: null } })
    if (p === '/gateway') return json({ url: `ws://localhost:${h.PORT}/gateway` })
    if (p === '/users/@me') return json({ ...h.me, instance_admin: true, mfa_enabled: true })
    if (p === '/federation/nodes') return json(st.nodes)
    if (p === '/discovery/categories') return json([{ id: 1, name: 'Esports', is_primary: true }, { id: 2, name: 'Gaming', is_primary: true }, { id: 3, name: 'Community', is_primary: true }])
    if (p === '/discoverable-guilds') return json({ total: 3, limit: 24, offset: 0, guilds: [listing('260', 'Hub Lounge', null), listing(NG, 'Node Arena', nodeChip()), listing('7300', 'Sleepy Node Server', nodeChip('active', false), { keywords: null })] })
    if (p === '/guilds/260/members/@me' && method === 'PUT') return json({ ...hubGuild, id: '260', name: 'Hub Lounge', roles: [{ ...hubGuild.roles[0], id: '260' }], channels: [{ ...hubGuild.channels[0], id: '360', guild_id: '260', name: 'lounge' }] })
    if (p === '/oauth2/authorize' && method === 'GET') return json({ node: { node_id: N, name: "Dana's Node", url: NODE, icon: null }, user: h.me, authorized: false })
    if (p === '/oauth2/authorize' && method === 'POST') return json({ location: body.authorize ? `${NODE}/api/v9/federation/hub-callback?code=c1&state=nodestate` : `${NODE}/api/v9/federation/hub-callback?error=access_denied&state=nodestate` })
    if (p === '/guilds/200/members') return json([h.member(h.me)])
    if (p === '/guilds/200/discovery-metadata' && method === 'GET') return json({ code: 10004, message: 'Unknown' }, 404)
    if (p === '/guilds/200/discovery-metadata') return json({ guild_id: '200', listed: body.listed, primary_category_id: body.primary_category_id, keywords: body.keywords })
    if (p === '/guilds/200' && method === 'PATCH') return json({ ...hubGuild, ...body })
    if (/\/messages$/.test(p) && method === 'GET') return json([])
    if (method === 'GET') return json({ code: 0, message: 'Not found in smoke fixtures' }, 404)
    return r.fulfill({ status: 204 })
  })

  // ----- node -----
  await ctx.routeWebSocket(`wss://node.example/gateway`, (ws) => {
    st.nodeSock = ws
    ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 41250 } }))
    ws.onMessage((raw) => {
      const f = JSON.parse(raw)
      st.nodeOps.push(f)
      if (f.op === 2) {
        st.nodeIdentify.push(f.d.token)
        ws.send(JSON.stringify({ op: 0, s: 1, t: 'READY', d: { v: 9, session_id: 'node-sess', user: nodeMe, users: [dana], private_channels: [{ id: '7900', type: 1, recipients: [dana] }],
          relationships: [], read_state: [{ id: '7101', last_message_id: '7150', mention_count: 0 }], presences: [{ user: { id: '7002' }, status: 'online' }], guilds: [nodeGuild] } }))
      }
      if (f.op === 4 && f.d.channel_id) {
        ws.send(JSON.stringify({ op: 0, s: 2, t: 'VOICE_STATE_UPDATE', d: { guild_id: NG, channel_id: f.d.channel_id, user_id: NODE_ME, session_id: 'node-sess', self_mute: false, self_deaf: false, mute: false, deaf: false, member: h.member(nodeMe) } }))
        ws.send(JSON.stringify({ op: 0, s: 3, t: 'VOICE_SERVER_UPDATE', d: { guild_id: NG, channel_id: f.d.channel_id, token: 'node-voice-token', endpoint: '/livekit' } }))
      }
    })
  })
  await ctx.route(/^https:\/\/node\.example\//, async (r) => {
    const req = r.request()
    const url = new URL(req.url())
    const p = url.pathname.replace('/api/v9', '')
    const method = req.method()
    if (method === 'OPTIONS') return r.fulfill({ status: 204, headers: cors })
    let body
    try { body = req.postDataJSON() } catch { body = undefined }
    st.nodeCalls.push({ method, p, body, auth: req.headers().authorization })
    const json = (j, status = 200) => r.fulfill({ status, json: j, headers: cors })
    if (p === '/federation/hub-login') {
      st.clientState = url.searchParams.get('state')
      assert.equal(url.searchParams.get('return_to'), `${h.ORIGIN}/instances/callback`)
      return r.fulfill({ status: 302, headers: { location: `${h.ORIGIN}/oauth2/authorize?client_id=${N}&response_type=code&scope=identify&redirect_uri=${encodeURIComponent(`${NODE}/api/v9/federation/hub-callback`)}&code_challenge=xyz&code_challenge_method=S256&state=nodestate` } })
    }
    if (p === '/federation/hub-callback') return r.fulfill({ status: 302, headers: { location: `${h.ORIGIN}/instances/callback#token=node-token&state=${st.clientState}&node_id=${N}` } })
    if (url.pathname.startsWith('/attachments/')) return r.fulfill({ contentType: 'image/png', headers: cors, body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64') })
    if (p === '/gateway') return st.nodeOffline ? json({ message: 'down' }, 503) : json({ url: 'wss://node.example/gateway' })
    if (p === `/guilds/${NG}/members/@me` && method === 'PUT') return json(nodeGuild)
    if (p === '/invites/abc' && method === 'POST') return json(nodeGuild2)
    if (p === `/guilds/${NG}/members`) return json(nodeGuild.members)
    if (p === '/channels/7101/messages' && method === 'GET') return json([
      { id: '7150', channel_id: '7101', guild_id: NG, type: 0, author: dana, content: `welcome <@${NODE_ME}>!`, mentions: [nodeMe], attachments: [{ id: '1', filename: 'map.png', size: 68, content_type: 'image/png', url: '/attachments/7101/1/map.png', proxy_url: '/attachments/7101/1/map.png', width: 1, height: 1 }], embeds: [], timestamp: h.iso(-60e3), edited_timestamp: null, pinned: false, flags: 0 },
    ])
    if (p === '/channels/7101/messages' && method === 'POST') {
      const m = { id: '7160', channel_id: '7101', guild_id: NG, type: 0, author: nodeMe, content: body.content, nonce: body.nonce, mentions: [], attachments: [], embeds: [], timestamp: h.iso(), edited_timestamp: null, pinned: false, flags: 0 }
      st.nodeSock.send(JSON.stringify({ op: 0, s: 9, t: 'MESSAGE_CREATE', d: m }))
      return json(m, 201)
    }
    if (method === 'GET') return json({ code: 0, message: 'Not found' }, 404)
    return r.fulfill({ status: 204, headers: cors })
  })
  const page = await ctx.newPage()
  const nodeDispatch = (t, d) => st.nodeSock.send(JSON.stringify({ op: 0, s: 50, t, d }))
  return { ctx, page, st, nodeDispatch, hubReady }
}

async function setupWizard(browser, errors) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(e.message))
  const calls = []
  let completes = 0
  let pending = true
  await page.route('**/api/v9/**', async (r) => {
    const url = new URL(r.request().url())
    const p = url.pathname.replace('/api/v9', '')
    const method = r.request().method()
    let body
    try { body = r.request().postDataJSON() } catch { body = undefined }
    calls.push({ method, p, body, auth: r.request().headers().authorization })
    const json = (j, status = 200) => r.fulfill({ status, json: j })
    if (p === '/instance') return json({ name: 'Cillhub', motd: null, registration_mode: 'closed', announcement: null, setup_pending: pending, federation: { role: 'node', mode: null, hub_url: null } })
    if (p === '/setup') return json({ required: true, role: 'node', version: '7.0.0', hub_url: 'https://hub.example.com', mode_hint: null, updater: true, auto_update: 'off', auto_update_hour: 4, admin_created: false, admin_mfa_enabled: false })
    if (p === '/setup/verify') return body.setup_code === 'SETUP-1234' ? r.fulfill({ status: 204 }) : json({ code: 0, message: 'Wrong setup code.' }, 401)
    if (p === '/setup/admin') return json({ token: 'admin-token', user_id: '900', mfa_required: true }, 201)
    if (p === '/users/@me/mfa/totp/enable') return json({ token: 'admin-token-2', backup_codes: Array.from({ length: 10 }, (_, i) => ({ code: `bk${i}code`, consumed: false })) })
    // a documentation address: the browser's STUN probe gets no answer, so the reachability check fails
    if (p === '/setup/voice-check') return json({ configured: ['cillvoice'], default: 'cillvoice', cillvoice: { public_ip: '203.0.113.7', udp_port: 50250, stun_url: 'stun:203.0.113.7:50250', listening: true, probe_until: h.iso() } })
    if (p === '/setup/complete') {
      if (++completes === 1) return json({ code: 0, message: 'The hub refused the link: Unknown, used or expired link code.', errors: { link_code: { _errors: [{ code: 'FED_LINK_CODE_INVALID', message: 'The hub refused the link: Unknown, used or expired link code.' }] } } }, 400)
      pending = false
      return json({ instance: { name: body.instance_name, motd: null, registration_mode: body.registration_mode, announcement: null, setup_pending: false, federation: { role: 'node', mode: 'connected', hub_url: body.hub_url } } })
    }
    if (method === 'GET') return json({ code: 0, message: 'nope' }, 404)
    return r.fulfill({ status: 204 })
  })
  await page.goto(`${h.ORIGIN}/login`)
  await page.waitForURL('**/setup')
  const main = page.getByRole('main', { name: 'Set up Cillhub' })
  await main.getByRole('heading', { name: 'Setup code', level: 2 }).waitFor()
  await main.getByLabel('Setup code').fill('wrong')
  await main.getByRole('button', { name: 'Continue' }).click()
  await main.getByText('Wrong setup code.').waitFor()
  await main.getByLabel('Setup code').fill('SETUP-1234')
  await main.getByRole('button', { name: 'Continue' }).click()
  await main.getByRole('heading', { name: 'Instance', level: 2 }).waitFor()
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'setup-step', 'each step heading takes focus')
  await main.getByLabel('Instance name').fill('LAN Crew')
  await main.getByRole('button', { name: 'Continue' }).click()
  await main.getByLabel('Username').fill('dana')
  await main.getByLabel('Email').fill('dana@lan.example')
  await main.getByLabel('Password', { exact: true }).fill('correct horse battery')
  await main.getByLabel('Repeat password').fill('correct horse battery')
  await main.getByRole('button', { name: 'Continue' }).click()
  await main.getByRole('heading', { name: 'Two-factor authentication', level: 2 }).waitFor()
  const admin = calls.find((c) => c.p === '/setup/admin')
  assert.deepEqual(admin.body, { setup_code: 'SETUP-1234', username: 'dana', email: 'dana@lan.example', password: 'correct horse battery' })
  await main.getByRole('img', { name: 'QR code for your authenticator app' }).waitFor()
  await main.getByLabel('6-digit code').fill('123456')
  await main.getByRole('button', { name: 'Activate' }).click()
  await main.getByText('bk0code').waitFor()
  const mfa = calls.find((c) => c.p === '/users/@me/mfa/totp/enable')
  assert.equal(mfa.auth, 'admin-token', '2FA is enrolled with the new admin token')
  assert.equal(mfa.body.password, 'correct horse battery')
  assert.ok(await main.getByRole('button', { name: 'Continue' }).isDisabled(), 'backup codes must be confirmed as saved')
  await main.getByLabel('I saved my backup codes').check()
  await main.getByRole('button', { name: 'Continue' }).click()
  await main.getByLabel('Only people with a registration code').check()
  await main.getByRole('button', { name: 'Continue' }).click()
  await main.getByRole('heading', { name: 'Hub connection', level: 2 }).waitFor()
  await main.getByLabel(/Connected to the hub/).check()
  assert.equal(await main.getByLabel('Hub address').inputValue(), 'https://hub.example.com')
  await main.getByLabel('Link code').fill('BADCODE')
  await main.getByRole('button', { name: 'Continue' }).click()
  await main.getByText('cillvoice listens on UDP port 50250').waitFor()
  await main.locator('li.fail', { hasText: 'This browser reaches 203.0.113.7:50250 over UDP' }).waitFor({ timeout: 15000 })
  await page.screenshot({ path: shot('setup-voice') })
  await main.getByRole('button', { name: 'Continue' }).click()
  await main.getByRole('button', { name: 'Finish setup' }).click()
  // The hub refused the link code: back to the hub step with the reason next to the field.
  await main.getByText('The hub refused the link: Unknown, used or expired link code.').waitFor()
  await main.getByRole('heading', { name: 'Hub connection', level: 2 }).waitFor()
  await main.getByLabel('Link code').fill('GOOD-LINK')
  await main.getByRole('button', { name: 'Continue' }).click()
  await main.getByRole('button', { name: 'Continue' }).click()
  await main.getByText('Connected to https://hub.example.com').waitFor()
  assert.equal(await main.getByLabel('Off: I update by hand').isChecked(), true, 'automatic updates default to off')
  await main.getByLabel('Security and patch releases only (recommended)').check()
  await main.getByLabel('Maintenance window').selectOption('3')
  await page.screenshot({ path: shot('setup') })
  await main.getByRole('button', { name: 'Finish setup' }).click()
  await page.waitForURL('**/channels/@me')
  const done = calls.filter((c) => c.p === '/setup/complete').at(-1)
  assert.deepEqual(done.body, { setup_code: 'SETUP-1234', instance_name: 'LAN Crew', registration_mode: 'invite', mode: 'connected', hub_url: 'https://hub.example.com', link_code: 'GOOD-LINK', auto_update: 'patch', auto_update_hour: 3 })
  assert.equal(done.auth, 'admin-token-2', 'setup finishes as the new admin')
  assert.equal(await page.evaluate(() => localStorage.getItem('token')), 'admin-token-2')
  console.log('ok v7 1 - setup wizard: code check, name, admin + mandatory 2FA, registration, connected mode with link-code retry, voice check, automatic updates, finish')
  await ctx.close()
}

async function multiInstance(browser, errors) {
  const { ctx, page, st, nodeDispatch, hubReady } = await twoInstances(browser, errors)
  // Directory: search, category and language filters; node badge and status.
  await page.goto(`${h.ORIGIN}/directory`)
  await page.getByRole('heading', { name: 'Server Directory', level: 1 }).waitFor()
  const card = (name) => page.locator('.dir-card', { has: page.getByRole('heading', { name, level: 3 }) })
  await card('Node Arena').getByText("on Dana's Node").waitFor()
  await card('Sleepy Node Server').getByText('· Offline').waitFor()
  assert.ok(await card('Sleepy Node Server').getByRole('button', { name: 'Join Sleepy Node Server' }).isDisabled(), 'servers on an offline node cannot be joined')
  await page.getByRole('searchbox', { name: 'Search servers' }).fill('arena')
  await page.getByRole('button', { name: 'Esports' }).click()
  await page.getByLabel('Language').selectOption('de')
  await until(() => st.hubCalls.find((c) => c.p === '/discoverable-guilds' && c.query.query === 'arena' && c.query.category_id === '1' && c.query.locale === 'de'), 'directory query')
  await page.mouse.move(0, 0)
  await page.screenshot({ path: shot('directory') })
  await card('Hub Lounge').getByRole('button', { name: 'Report' }).click()
  await page.getByRole('dialog', { name: 'Report Hub Lounge' }).getByLabel('What is wrong with this listing?').fill('spam links')
  await page.getByRole('dialog', { name: 'Report Hub Lounge' }).getByRole('button', { name: 'Report' }).click()
  await page.getByText('Thanks. The hub admins will review this server.').waitFor()
  assert.deepEqual(st.hubCalls.find((c) => c.p === '/discoverable-guilds/260/report').body, { reason: 'spam links' })
  console.log('ok v7 2 - directory: search, category, language, node badge and status, offline node not joinable, report')

  // Join a node server: popup → node → hub consent screen → node → our callback → token handed back → join on the node.
  const [popup] = await Promise.all([page.waitForEvent('popup'), card('Node Arena').getByRole('button', { name: 'Join Node Arena' }).click()])
  await popup.getByRole('heading', { name: "Sign in to Dana's Node with your Cillhub account" }).waitFor()
  await popup.getByText('Your password, email, direct messages, friends or other servers').waitFor()
  await popup.screenshot({ path: shot('consent') })
  await popup.getByRole('button', { name: 'Authorize' }).click()
  await popup.waitForEvent('close')
  await page.waitForURL(`**/channels/7000~${NG}/7000~7101`) // node ids carry their node's id
  assert.equal(await page.evaluate(() => localStorage.getItem('instance-token:7000')), 'node-token', 'the node token is stored per instance')
  assert.ok(!st.hubCalls.some((c) => JSON.stringify(c).includes('node-token')), 'the node token never goes to the hub')
  const join = st.nodeCalls.find((c) => c.p === `/guilds/${NG}/members/@me`)
  assert.equal(join.method, 'PUT')
  assert.equal(join.auth, 'node-token')
  await until(() => st.nodeIdentify.includes('node-token'), 'node gateway IDENTIFY with the node token')
  const rail = page.getByRole('navigation', { name: 'Servers' })
  const nodeIcon = rail.getByRole('link', { name: /^Node Arena on Dana's Node \(Connected\)/ })
  await nodeIcon.waitFor()
  await rail.locator('.node-marker.ready').first().waitFor()
  await rail.getByRole('link', { name: /^Nightfall Gaming/ }).waitFor()
  console.log('ok v7 3 - node sign-in through the hub: popup, consent screen, state checked, token per instance, second gateway, server in the rail with node marker')

  // Messages from the node: our node account shows as us, root-relative URLs go to the node, REST goes to the node.
  const chat = page.getByRole('main').filter({ has: page.getByRole('heading', { name: 'arena-chat', level: 1 }) })
  await chat.getByText('welcome @ciller!').waitFor()
  const img = await page.locator('img[src*="map.png"]').first().getAttribute('src')
  assert.equal(img, `${NODE}/attachments/7101/1/map.png`)
  assert.equal(st.nodeCalls.find((c) => c.p === '/channels/7101/messages' && c.method === 'GET').auth, 'node-token')
  const box = page.getByRole('textbox', { name: 'Message #arena-chat' })
  await box.fill(`hi <@100> from the hub`)
  await box.press('Enter')
  const sent = await until(() => st.nodeCalls.find((c) => c.p === '/channels/7101/messages' && c.method === 'POST'), 'message POST to the node')
  assert.equal(sent.body.content, `hi <@${NODE_ME}> from the hub`, 'our hub id is turned into our node id on the way out')
  await page.locator('.msg:not(.pending)', { hasText: 'from the hub' }).waitFor()
  await page.waitForTimeout(200)
  assert.equal(await page.locator('.msg', { hasText: 'from the hub' }).count(), 1, 'own node message de-duplicated')
  // A mention in another node channel badges the node server.
  nodeDispatch('MESSAGE_CREATE', { id: '7170', channel_id: '7103', guild_id: NG, type: 0, author: dana, content: `<@${NODE_ME}> scrim at 8?`, mentions: [nodeMe], attachments: [], embeds: [], timestamp: h.iso(), edited_timestamp: null, pinned: false, flags: 0 })
  await rail.getByRole('link', { name: /^Node Arena on Dana's Node \(Connected\), 1 mention/ }).waitFor()
  // DMs from the node are not shown (they stay on the hub).
  assert.equal(await page.getByText('7900').count(), 0)
  console.log('ok v7 4 - node chat: our node account aliased to us, attachments from the node origin, send via node REST, mention badge per instance')

  // Voice on a node server: op 4 on the node's gateway, the node's (root-relative) voice endpoint.
  const hubOps4 = st.hubOps.filter((f) => f.op === 4).length
  await page.getByRole('navigation', { name: 'Node Arena channels' }).getByRole('button', { name: /^Arena Voice/ }).click()
  const op4 = await until(() => st.nodeOps.find((f) => f.op === 4 && f.d.channel_id === '7102'), 'op 4 on the node')
  assert.equal(op4.d.guild_id, NG)
  assert.equal(st.hubOps.filter((f) => f.op === 4).length, hubOps4, 'no voice op on the hub gateway')
  await page.getByRole('region', { name: 'Voice connection' }).getByText('Voice Connected').waitFor()
  assert.equal(await page.evaluate(() => window.__lk?.url), 'wss://node.example/livekit', 'voice uses the node backend')
  await page.screenshot({ path: shot('node-voice') })
  await page.getByRole('region', { name: 'Voice connection' }).getByRole('button', { name: 'Disconnect' }).click()
  await until(() => st.nodeOps.some((f) => f.op === 4 && f.d.channel_id === null), 'voice leave on the node')
  console.log('ok v7 5 - voice on a node server: op 4 on the node gateway, session aliased, node voice endpoint')

  // Invite link of the linked node (already signed in: straight to the node); unknown instances are refused.
  await rail.getByRole('button', { name: 'Add a server' }).click()
  const add = page.getByRole('dialog', { name: 'Add a server' })
  await add.getByText("Dana's Node").waitFor() // "Your other instances"
  await add.getByLabel('Invite link from another instance').fill('https://elsewhere.example/invite/zzz')
  await add.getByRole('button', { name: 'Sign in and join' }).click()
  await add.getByText('elsewhere.example is not linked to this hub. Open the invite on its own site instead.').waitFor()
  await add.getByLabel('Invite link from another instance').fill(`${NODE}/invite/abc`)
  await add.getByRole('button', { name: 'Sign in and join' }).click()
  await page.waitForURL(`**/channels/7000~${NG2}/7000~7201`)
  assert.equal(st.nodeCalls.find((c) => c.p === '/invites/abc').auth, 'node-token')
  await rail.getByRole('link', { name: /^Node Scrims on Dana's Node/ }).waitFor()
  console.log('ok v7 6 - node invite link: linked node joined with the stored token, unknown instance refused')

  // Offline: the node drops the connection and does not answer; servers greyed out, status line; then it comes back.
  await nodeIcon.click()
  await page.waitForURL(`**/channels/7000~${NG}/**`)
  st.nodeOffline = true
  st.nodeSock.close({ code: 1011 })
  await page.getByRole('status').getByText("Dana's Node is not reachable right now.", { exact: false }).waitFor()
  await rail.locator('.rail-entry.node-down').first().waitFor()
  await rail.getByRole('link', { name: /^Node Arena on Dana's Node \(Offline\)/ }).waitFor()
  await page.screenshot({ path: shot('node-offline') })
  st.nodeOffline = false
  await rail.getByRole('link', { name: /^Node Arena on Dana's Node \(Connected\)/ }).waitFor({ timeout: 15000 })
  assert.equal(await page.locator('.rail-entry.node-down').count(), 0)
  console.log('ok v7 7 - offline node: greyed servers and status line, reconnects when it is back')

  // A hostile node: admitted payloads with wrong-typed fields. A render error cuts the nodes off and the hub view renders
  // again; an event the store cannot apply cuts the node off. Both times its servers go and the hub keeps working.
  const hubLink = rail.getByRole('link', { name: /^Nightfall Gaming/ })
  st.nodeSock.send(JSON.stringify({ op: 0, t: 'GUILD_UPDATE', d: { id: NG, name: { x: 1 } } }))
  await page.getByText("Display error: Dana's Node was disconnected", { exact: false }).waitFor()
  await hubLink.waitFor()
  assert.equal(await rail.getByRole('link', { name: /Dana's Node/ }).count(), 0, 'node servers dropped after the render error')
  await page.reload() // cut off until the next start
  await nodeIcon.click() // its channel's messages are loaded, then the hub view is shown
  await page.waitForURL(`**/channels/7000~${NG}/7000~7101`)
  await page.locator('.msg').first().waitFor()
  await hubLink.click()
  const warned = []
  page.on('console', (m) => m.type() === 'warning' && warned.push(m.text()))
  st.nodeSock.send(JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', d: { id: '7190', type: 0, channel_id: '7101', guild_id: NG, author: dana, content: 'poll', timestamp: new Date().toISOString(), mentions: [], attachments: [], embeds: [], poll: {} } }))
  st.nodeSock.send(JSON.stringify({ op: 0, t: 'MESSAGE_POLL_VOTE_ADD', d: { user_id: '7002', channel_id: '7101', guild_id: NG, message_id: '7190', answer_id: 1 } }))
  await rail.getByRole('link', { name: /Dana's Node/ }).waitFor({ state: 'detached' }) // cut off after the reducer throw
  assert.ok(warned.some((w) => w.includes('MESSAGE_POLL_VOTE_ADD could not be applied')), 'the store threw on the vote, not the render')
  await rail.getByRole('button', { name: 'Add a server' }).click()
  await page.getByRole('dialog', { name: 'Add a server' }).getByText('Cut off: sent too much or broken data').waitFor()
  await page.keyboard.press('Escape')
  // a render error with no node state left: the plain reload screen (a broken hub payload stands in for any other bug)
  st.hubSock.send(JSON.stringify({ op: 0, t: 'GUILD_UPDATE', d: { id: hubGuild.id, name: { x: 1 } } }))
  await page.getByRole('heading', { name: 'Something went wrong' }).waitFor()
  await page.getByRole('button', { name: 'Reload' }).click()
  await hubLink.waitFor()
  await nodeIcon.waitFor({ timeout: 15000 }) // the next start connects the node again
  console.log('ok v7 7b - hostile node: render error and reducer throw cut the node off, the hub view stays usable; reload screen without node state')

  // Suspended by the hub (seen on the next hub READY): the node connection closes and its servers disappear; the node
  // stays under "Your other instances" with its status, where it can be disconnected for good.
  st.nodes = [nodeRecord('suspended')]
  st.hubSock.send(JSON.stringify({ op: 0, s: 2, t: 'READY', d: hubReady() }))
  await until(async () => (await rail.getByRole('link', { name: /Dana's Node/ }).count()) === 0, 'node servers removed')
  await rail.getByRole('link', { name: /^Nightfall Gaming/ }).waitFor()
  await rail.getByRole('button', { name: 'Add a server' }).click()
  const add2 = page.getByRole('dialog', { name: 'Add a server' })
  await add2.getByText('Suspended by the hub', { exact: false }).waitFor()
  await add2.getByRole('button', { name: "Disconnect from Dana's Node" }).click()
  await page.getByRole('dialog', { name: "Disconnect from Dana's Node?" }).getByRole('button', { name: 'Disconnect' }).click()
  await until(() => st.nodeCalls.some((c) => c.p === '/auth/logout'), 'node logout')
  assert.equal(await page.evaluate(() => localStorage.getItem('instance-token:7000')), null, 'node token forgotten')
  await add2.getByText('Your other instances').waitFor({ state: 'detached' })
  await page.keyboard.press('Escape')
  await add2.waitFor({ state: 'detached' })
  console.log('ok v7 8 - suspended node: connection closed, its servers disappear, Disconnect from instance forgets the token')

  // Listing a hub server in the directory (Server Settings → Server Directory).
  await rail.getByRole('link', { name: /^Nightfall Gaming/ }).click()
  await page.getByRole('button', { name: 'Nightfall Gaming' }).first().click()
  await page.getByRole('button', { name: 'Server Settings' }).click()
  await page.getByRole('tab', { name: 'Server Directory' }).click()
  await page.getByLabel('List this server in the server directory').check()
  await page.getByLabel('Description').fill('Nightfall esports org')
  await page.getByLabel('Category').selectOption({ label: 'Esports' })
  await page.getByLabel('Tags (comma-separated, up to 5)').fill('cs2, valorant')
  await page.getByLabel('Language').selectOption('de')
  await page.getByRole('button', { name: 'Save Changes' }).click()
  const meta = await until(() => st.hubCalls.find((c) => c.p === '/guilds/200/discovery-metadata' && c.method === 'PATCH'), 'metadata PATCH')
  assert.deepEqual(meta.body, { listed: true, primary_category_id: 1, keywords: ['cs2', 'valorant'], preferred_locale: 'de' })
  assert.deepEqual(st.hubCalls.find((c) => c.p === '/guilds/200' && c.method === 'PATCH').body, { description: 'Nightfall esports org' })
  await page.screenshot({ path: shot('listing') })
  await page.keyboard.press('Escape')
  console.log('ok v7 9 - Server Settings → Server Directory: listed, description, category, tags, language')

  // Joining a hub server from the directory (Explore servers in the rail).
  await rail.getByRole('link', { name: 'Explore servers' }).click()
  await card('Hub Lounge').getByRole('button', { name: 'Join Hub Lounge' }).click()
  await page.waitForURL('**/channels/260**')
  assert.equal(st.hubCalls.find((c) => c.p === '/guilds/260/members/@me').method, 'PUT')
  console.log('ok v7 10 - hub server joined from the directory (PUT /guilds/:id/members/@me)')
  await ctx.close()
}

async function adminPages(browser, errors) {
  // Hub: Nodes and Server Directory moderation.
  {
    const { ctx, page, st } = await twoInstances(browser, errors)
    const admin = []
    const update = { updater: true, auto_update: 'patch', auto_update_hour: 4, remote_update: true, latest_version: '7.0.2', reported_at: h.iso(-60e3),
      last_result: { action: 'update', version: '7.0.2', state: 'failed', rolled_back: true, error: 'the app exited (code 3)', at: h.iso(-7200e3) }, last_auto: null }
    const node = { ...nodeRecord(), sign_in: 'both', status_reason: null, users_count: 9, servers_count: 3, linked_at: h.iso(-86400e3), update }
    let hubFed = { role: 'hub', url: h.ORIGIN, public_key: 'x'.repeat(43), user_link_codes: false, release: null, nodes: { active: 1, banned: 1 } }
    await page.route('**/api/v9/admin/**', (r) => {
      const url = new URL(r.request().url())
      const p = url.pathname.replace('/api/v9/admin', '')
      const method = r.request().method()
      let body
      try { body = r.request().postDataJSON() } catch { body = undefined }
      admin.push({ method, p, body, query: Object.fromEntries(url.searchParams) })
      const json = (j) => r.fulfill({ json: j })
      if (p === '/federation/nodes') return json([node, { ...node, node_id: '7400', name: 'Old LAN', url: 'https://old.example', status: 'banned', online: false }])
      const code = (o) => ({ id: '5001', created_by: '100', created_at: h.iso(-3600e3), expires_at: h.iso(80000e3), used_at: null, node_id: null, note: null, status: 'valid', ...o })
      if (p === '/federation/link-codes' && method === 'GET') return json([code()])
      if (p === '/federation/link-codes' && method === 'POST') return json(code({ id: '5002', code: 'LINK-9F3K-22QX', created_at: h.iso() }))
      if (p === '/federation' && method === 'GET') return json(hubFed)
      if (p === '/federation' && method === 'PATCH') return json((hubFed = { ...hubFed, ...body }))
      if (p === '/federation/release' && method === 'PUT') return json((hubFed.release = { version: body.version, notes: body.notes, published_at: h.iso() }))
      if (p === '/audit-log') return json([{ id: '1', admin_id: '100', action: 'node.link', target_type: 'node', target_id: N, details: null, created_at: h.iso(-86400e3) }])
      if (p === '/federation/nodes/7000/update') return json({ node, result: { status: 202, accepted: true, message: null } })
      if (/^\/federation\/nodes\/7000\/(suspend|ban)$/.test(p)) return json({ ...node, status: p.endsWith('ban') ? 'banned' : 'suspended', status_reason: body.reason })
      if (p === '/directory') return json([{ guild: listing(NG, 'Node Arena', nodeChip()), hidden: false, reports: [{ id: '1', reason: 'posts spam links', reporter_id: '102', created_at: h.iso(-600e3) }] }])
      if (p === `/directory/${NG}`) return json({ guild: listing(NG, 'Node Arena', nodeChip()), hidden: body.hidden, hidden_reason: body.reason, reports: [] })
      return r.fulfill({ status: 204 })
    })
    await page.goto(`${h.ORIGIN}/admin/nodes`)
    const nav = page.getByRole('navigation', { name: 'Admin dashboard' })
    await nav.getByRole('link', { name: 'Server Directory' }).waitFor()
    assert.equal(await nav.getByRole('link', { name: 'Updates' }).count(), 0, 'the hub has no node update page')
    await page.getByRole('row', { name: /Dana's Node/ }).getByText('Online').waitFor()
    await page.getByRole('row', { name: /Old LAN/ }).getByText('Banned').waitFor()
    const danaRow = page.getByRole('row', { name: /Dana's Node/ })
    await danaRow.getByText('Security and patch · 04:00 UTC').waitFor()
    await danaRow.getByText('Update failed').waitFor()
    await page.getByRole('button', { name: 'Create Link Code' }).click()
    await page.getByText('LINK-9F3K-22QX').waitFor()
    await page.getByLabel(/Hub users with two-factor authentication may create link codes/).check()
    await until(() => admin.find((c) => c.p === '/federation' && c.method === 'PATCH'), 'user link codes switch')
    assert.deepEqual(admin.find((c) => c.p === '/federation' && c.method === 'PATCH').body, { user_link_codes: true })
    await page.mouse.move(0, 0)
    await page.screenshot({ path: shot('admin-nodes') })
    await page.getByRole('button', { name: "Dana's Node" }).click()
    const drawer = page.getByRole('dialog', { name: "Node Dana's Node" })
    await drawer.getByText('node.link').waitFor()
    assert.equal(admin.find((c) => c.p === '/audit-log').query.target_id, N)
    await drawer.getByText('Update 7.0.2 · Failed · previous version restored: the app exited (code 3)', { exact: false }).waitFor()
    await drawer.getByText('Allowed').waitFor()
    await drawer.getByRole('button', { name: 'Request Update' }).click()
    const rd = page.getByRole('dialog', { name: "Ask Dana's Node to update now?" })
    await rd.getByLabel('Authentication or backup code').fill('222333')
    await rd.getByRole('button', { name: 'Request Update' }).click()
    await until(() => admin.find((c) => c.p === '/federation/nodes/7000/update'), 'update request')
    assert.deepEqual(admin.find((c) => c.p === '/federation/nodes/7000/update').body, { code: '222333' })
    await page.getByText('The node started the update.').waitFor()
    await drawer.getByRole('button', { name: 'Suspend' }).click()
    const sd = page.getByRole('dialog', { name: "Suspend Dana's Node?" })
    await sd.getByLabel('Reason (shown in the audit log)').fill('spam servers')
    await sd.getByRole('button', { name: 'Suspend' }).click()
    await until(() => admin.find((c) => c.p === '/federation/nodes/7000/suspend'), 'suspend')
    assert.deepEqual(admin.find((c) => c.p === '/federation/nodes/7000/suspend').body, { reason: 'spam servers' })
    await drawer.getByRole('button', { name: 'Ban Node' }).click()
    const bd = page.getByRole('dialog', { name: "Ban Dana's Node?" })
    await bd.getByLabel('Reason (shown in the audit log)').fill('malware')
    await bd.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('dialog', { name: "Ban Dana's Node?" }).getByLabel('Authentication or backup code').fill('123 456')
    await page.getByRole('dialog', { name: "Ban Dana's Node?" }).getByRole('button', { name: 'Ban Node' }).click()
    await until(() => admin.find((c) => c.p === '/federation/nodes/7000/ban'), 'ban')
    assert.deepEqual(admin.find((c) => c.p === '/federation/nodes/7000/ban').body, { reason: 'malware', code: '123456' })
    await drawer.getByRole('button', { name: 'Close' }).last().click()
    await nav.getByRole('link', { name: 'Release Channel' }).click()
    await page.getByText('None yet').waitFor()
    await page.getByRole('textbox', { name: 'Version' }).fill('7.0.0')
    await page.getByLabel('Release notes').fill('Hub network and self-hosting')
    await page.getByRole('button', { name: 'Publish' }).click()
    await page.locator('.admin-facts').getByText('7.0.0').waitFor()
    assert.deepEqual(admin.find((c) => c.p === '/federation/release' && c.method === 'PUT').body, { version: '7.0.0', notes: 'Hub network and self-hosting' })
    console.log('ok v7 11 - hub Nodes page: list with status/version/counts/automatic updates, link code, user link code switch, audit, update report + update request with 2FA code, suspend with reason, ban with 2FA code, release channel')

    await nav.getByRole('link', { name: 'Server Directory' }).click()
    await page.getByText('posts spam links').waitFor()
    assert.equal(admin.find((c) => c.p === '/directory').query.filter, 'reported')
    await page.screenshot({ path: shot('admin-directory') })
    await page.getByRole('button', { name: 'Hide' }).click()
    const hd = page.getByRole('dialog', { name: 'Hide Node Arena from the directory?' })
    await hd.getByLabel('Reason').selectOption('spam')
    await hd.getByLabel('Explanation for the affected user').fill('spam')
    await hd.getByRole('button', { name: 'Hide' }).click()
    await until(() => admin.find((c) => c.p === `/directory/${NG}` && c.method === 'PATCH'), 'hide')
    assert.deepEqual(admin.find((c) => c.p === `/directory/${NG}`).body, { hidden: true, category: 'spam', ground: 'terms', reason: 'spam' })
    await page.getByRole('button', { name: 'Dismiss Reports' }).click()
    await until(() => admin.find((c) => c.p === `/directory/${NG}/reports` && c.method === 'DELETE'), 'dismiss')
    console.log('ok v7 12 - hub directory moderation: reported listings, hide with reason, dismiss reports')
    assert.ok(st.hubCalls.length > 0)
    await ctx.close()
  }
  // Node: Federation and Updates.
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' })
    await ctx.addInitScript(() => localStorage.setItem('token', 'smoke-token'))
    const page = await ctx.newPage()
    page.on('pageerror', (e) => errors.push(e.message))
    const calls = []
    let fed = { role: 'node', mode: 'standalone', hub_url: null, node_id: null, hub_name: null, hub_status: 'unlinked', last_heartbeat: null, last_error: null, sign_in: 'local', update_check: true }
    const check = { at: h.iso(-3600e3), latest: { version: '7.0.1', notes: '- Fixes voice on IPv6\n- Faster directory', size: 123e6, min_upgrade_from: null }, update_available: true, can_update: true, error: null }
    let upd = { updater: true, reachable: true, current_version: '7.0.0', auto_check: true, last_check: check, state: 'idle', previous: { image: 'sha256:aa', version: '6.9.0' },
      backup: '/install/backups/20261028-pre-7.0.0', error: null, auto_update: 'off', auto_update_hour: 4, remote_update: true, last_auto: null }
    let polls = 0
    await page.route('**/api/v9/**', (r) => {
      const url = new URL(r.request().url())
      const p = url.pathname.replace('/api/v9', '')
      const method = r.request().method()
      let body
      try { body = r.request().postDataJSON() } catch { body = undefined }
      calls.push({ method, p, body })
      const json = (j, status = 200) => r.fulfill({ status, json: j })
      if (p === '/instance') return json({ name: 'LAN Crew', motd: null, registration_mode: 'invite', announcement: null, federation: { role: 'node', mode: 'standalone', hub_url: null } })
      if (p === '/users/@me') return json({ ...h.me, instance_admin: true, mfa_enabled: true })
      if (p === '/admin/federation' && method === 'GET') return json(fed)
      if (p === '/admin/federation/link') return json((fed = { ...fed, mode: 'connected', hub_url: body.hub_url, node_id: N, hub_status: 'linked', last_heartbeat: h.iso() }))
      if (p === '/admin/federation' && method === 'PATCH') return json((fed = { ...fed, ...body }))
      if (p === '/admin/updates' && method === 'GET') return json(upd.state === 'updating' && ++polls > 1 ? (upd = { ...upd, state: 'done', step: null, current_version: '7.0.1', previous: { image: 'sha256:bb', version: '7.0.0' }, last_check: { ...check, update_available: false } }) : upd)
      if (p === '/admin/updates' && method === 'PATCH') return json((upd = { ...upd, ...body }))
      if (p === '/admin/updates/apply') return json((upd = { ...upd, state: 'updating', action: 'update', target_version: '7.0.1', step: 'loading the image' }))
      if (p === '/admin/updates/rollback') return json((upd = { ...upd, state: 'rolling_back', action: 'rollback', target_version: '7.0.0' }))
      if (method === 'GET') return json({ code: 0, message: 'nope' }, 404)
      return r.fulfill({ status: 204 })
    })
    await page.goto(`${h.ORIGIN}/admin/federation`)
    const nav = page.getByRole('navigation', { name: 'Admin dashboard' })
    await nav.getByRole('link', { name: 'Updates' }).waitFor()
    assert.equal(await nav.getByRole('link', { name: 'Nodes' }).count(), 0, 'nodes have no Nodes page')
    await page.getByText('Not linked').waitFor()
    await page.getByLabel('Hub address').fill('https://hub.example.com')
    await page.getByLabel('Link code').fill('LINK-9F3K-22QX')
    await page.getByRole('button', { name: 'Link', exact: true }).click()
    await page.getByRole('button', { name: 'Unlink from Hub' }).waitFor()
    assert.deepEqual(calls.find((c) => c.p === '/admin/federation/link').body, { hub_url: 'https://hub.example.com', link_code: 'LINK-9F3K-22QX' })
    await page.getByLabel('Hub accounts only').check()
    await until(() => calls.find((c) => c.p === '/admin/federation' && c.method === 'PATCH'), 'sign-in PATCH')
    assert.deepEqual(calls.find((c) => c.p === '/admin/federation' && c.method === 'PATCH').body, { sign_in: 'hub' })
    await page.screenshot({ path: shot('admin-federation') })
    console.log('ok v7 13 - node Federation page: status, link with hub URL + code, sign-in methods')

    await nav.getByRole('link', { name: 'Updates' }).click()
    await page.getByText('Fixes voice on IPv6', { exact: false }).waitFor()
    await page.getByText('20261028-pre-7.0.0', { exact: false }).waitFor()
    await page.screenshot({ path: shot('admin-updates') })
    await page.getByRole('button', { name: 'Update to 7.0.1' }).click()
    const ud = page.getByRole('dialog', { name: 'Update to 7.0.1?' })
    await ud.getByLabel('Authentication or backup code').fill('654321')
    await ud.getByRole('button', { name: 'Update Now' }).click()
    await page.getByText('Updating… · 7.0.1 · loading the image').waitFor()
    assert.deepEqual(calls.find((c) => c.p === '/admin/updates/apply').body, { version: '7.0.1', code: '654321' })
    await page.locator('.admin-facts').getByText('7.0.1').waitFor({ timeout: 10000 }) // polled until the restart finished
    await page.getByRole('button', { name: 'Roll Back' }).click()
    await page.getByRole('dialog', { name: 'Roll back to 7.0.0?' }).getByLabel('Authentication or backup code').fill('111111')
    await page.getByRole('dialog', { name: 'Roll back to 7.0.0?' }).getByRole('button', { name: 'Roll Back' }).click()
    await page.getByText('Rolling back…').waitFor()
    assert.deepEqual(calls.find((c) => c.p === '/admin/updates/rollback').body, { code: '111111' })
    await page.getByLabel('All releases').click() // controlled: checked once the server answers
    await until(() => calls.find((c) => c.p === '/admin/updates' && c.method === 'PATCH'), 'auto-update PATCH')
    assert.deepEqual(calls.find((c) => c.p === '/admin/updates' && c.method === 'PATCH').body, { auto_update: 'all' })
    await page.locator('input[name=auto_update][value=all]:checked').waitFor() // shown as saved
    await page.getByLabel('Maintenance window').selectOption('2')
    await page.getByLabel('Let the network hub ask this server to update now').click()
    await until(() => calls.filter((c) => c.p === '/admin/updates' && c.method === 'PATCH').length === 3, 'hour and remote PATCH')
    assert.deepEqual(calls.filter((c) => c.p === '/admin/updates' && c.method === 'PATCH').slice(1).map((c) => c.body), [{ auto_update_hour: 2 }, { remote_update: false }])
    console.log('ok v7 14 - node Updates page: versions, release notes, last backup, update with 2FA code + progress polling, rollback, automatic updates, remote requests')
    await ctx.close()
  }
}

async function germanLight(browser, errors) {
  const { ctx, page } = await twoInstances(browser, errors, { init: () => { try { localStorage.setItem('locale', 'de'); localStorage.setItem('user-settings', JSON.stringify({ theme: 'light' })) } catch { /* not our origin */ } } })
  await page.goto(`${h.ORIGIN}/directory`)
  await page.getByRole('heading', { name: 'Serververzeichnis', level: 1 }).waitFor()
  await page.getByText('auf Dana\'s Node').first().waitFor()
  await page.getByRole('button', { name: 'Node Arena beitreten' }).waitFor()
  // Text on the cards keeps WCAG AA contrast in the light theme.
  const ratio = await page.evaluate(() => {
    const rgb = (c) => c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number)
    const lum = (c) => { const [r, g, b] = rgb(c).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
    const el = document.querySelector('.dir-desc')
    const bg = getComputedStyle(el.closest('.dir-card')).backgroundColor
    const [a, b] = [lum(getComputedStyle(el).color), lum(bg)].sort((x, y) => y - x)
    return (a + 0.05) / (b + 0.05)
  })
  assert.ok(ratio >= 4.5, `directory text contrast ${ratio.toFixed(2)} ≥ 4.5`)
  await page.mouse.move(0, 0)
  await page.screenshot({ path: shot('directory-light-de') })
  console.log('ok v7 15 - German UI and light theme on the directory (text contrast ≥ 4.5:1)')
  await ctx.close()
}

async function run(browser, errors) {
  await setupWizard(browser, errors)
  await multiInstance(browser, errors)
  await adminPages(browser, errors)
  await germanLight(browser, errors)
}

module.exports = { run }
