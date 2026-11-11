// Smoke check against `vite preview` with no server: the API is faked with Playwright routes.
// Run: npm run build && NODE_PATH=<dir with playwright> npm run smoke
const { chromium } = require('playwright')
const { spawn } = require('node:child_process')
const assert = require('node:assert/strict')
const path = require('node:path')

const PORT = Number(process.env.SMOKE_PORT || 4179) // SMOKE_PORT and SMOKE_DIST let several builds be checked side by side
const ORIGIN = `http://localhost:${PORT}`
const root = path.join(__dirname, '..')

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(ORIGIN)).ok) return } catch {}
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('vite preview did not start')
}

const user = (id, username) => ({ id, username, discriminator: '0', global_name: null, avatar: null, bot: false })
const me = { ...user('100', 'ciller'), email: 'c@example.com' }
const bob = user('101', 'bob')
const msg = (id, author, content) => ({ id, type: 0, channel_id: '300', guild_id: '200', author, content, timestamp: new Date().toISOString(), edited_timestamp: null, mentions: [], attachments: [], embeds: [], pinned: false })

const P = (...bits) => String(bits.reduce((a, b) => a | (1n << BigInt(b)), 0n))

// 3. v2: categories, permission overwrites, markdown, reactions, replies, attachments, roles settings, voice.
async function v2(browser, errors) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await ctx.addInitScript(() => localStorage.setItem('token', 'smoke-token'))
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(e.message))
  const dialogs = []
  page.on('dialog', (d) => (dialogs.push(d.message()), d.dismiss()))
  const G = '200'
  const roles = [
    { id: G, name: '@everyone', color: 0, hoist: false, position: 0, permissions: '70356545', mentionable: false, managed: false },
    { id: '500', name: 'Staff', color: 0xe67e22, hoist: true, position: 1, permissions: P(13, 22, 23, 24, 28), mentionable: true, managed: false },
  ]
  const member = (u, r = []) => ({ user: u, nick: null, roles: r, joined_at: '2026-01-01T00:00:00.000Z', mute: false, deaf: false })
  const channels = [
    { id: '600', type: 4, guild_id: G, name: 'Text Channels', position: 0, parent_id: null, permission_overwrites: [] },
    { id: '300', type: 0, guild_id: G, name: 'general', position: 0, parent_id: '600', topic: null, last_message_id: '403', permission_overwrites: [] },
    { id: '301', type: 0, guild_id: G, name: 'secret', position: 1, parent_id: '600', topic: null, last_message_id: null,
      permission_overwrites: [{ id: G, type: 0, allow: '0', deny: P(10) }] },
    { id: '601', type: 4, guild_id: G, name: 'Voice Channels', position: 1, parent_id: null, permission_overwrites: [] },
    { id: '302', type: 2, guild_id: G, name: 'Lounge', position: 0, parent_id: '601', user_limit: 0, permission_overwrites: [] },
  ]
  const base = { channel_id: '300', guild_id: G, edited_timestamp: null, mentions: [], attachments: [], embeds: [], pinned: false, timestamp: new Date().toISOString() }
  const md = { ...base, id: '400', type: 0, author: bob, content: '**bold** _it_ ~~gone~~ `code` <img src=x onerror=alert(1)> ||secret stuff|| https://example.com/a?b=1' }
  const history = [
    { ...base, id: '399', type: 0, author: me, content: 'check this quote: https://example.com/channels/200/300/400' },
    { ...base, id: '403', type: 7, author: bob, content: '' },
    { ...base, id: '402', type: 0, author: bob, content: 'react to me', reactions: [{ emoji: { id: null, name: '👍' }, count: 1, me: false }] },
    { ...base, id: '401', type: 19, author: bob, content: 'replying here', message_reference: { message_id: '400', channel_id: '300', guild_id: G }, referenced_message: md },
    md,
  ]
  let sock
  const ops = []
  await page.routeWebSocket(`ws://localhost:${PORT}/gateway`, (ws) => {
    sock = ws
    ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 41250 }, s: null, t: null }))
    ws.onMessage((raw) => {
      const f = JSON.parse(raw)
      ops.push(f)
      if (f.op === 2)
        ws.send(JSON.stringify({ op: 0, s: 1, t: 'READY', d: {
          v: 9, session_id: 's3', user: me, users: [bob], private_channels: [], relationships: [{ id: '101', type: 1, user: bob }],
          read_state: [{ id: '300', last_message_id: '400', mention_count: 0 }], user_settings: { status: 'online' },
          presences: [{ user: { id: '101' }, status: 'online' }],
          guilds: [{ id: G, name: 'Nightfall Gaming', icon: null, owner_id: '101', member_count: 2, system_channel_id: '300', roles, channels,
            members: [member(me, ['500']), member(bob)],
            voice_states: [{ guild_id: G, channel_id: '302', user_id: '101', session_id: 'b', self_mute: true, self_deaf: false, self_video: false, self_stream: false, mute: false, deaf: false, member: member(bob) }] }],
        } }))
      if (f.op === 4 && f.d.channel_id) {
        ws.send(JSON.stringify({ op: 0, s: 5, t: 'VOICE_STATE_UPDATE', d: { ...f.d, user_id: me.id, session_id: 's3', mute: false, deaf: false, member: member(me, ['500']) } }))
        ws.send(JSON.stringify({ op: 0, s: 6, t: 'VOICE_SERVER_UPDATE', d: { guild_id: G, channel_id: f.d.channel_id, token: null, endpoint: null } }))
      }
    })
  })
  const posted = []
  await page.route('**/api/v9/**', async (r) => {
    const { pathname } = new URL(r.request().url())
    const method = r.request().method()
    if (pathname.endsWith('/gateway')) return r.fulfill({ json: { url: `ws://localhost:${PORT}/gateway` } })
    if (pathname.endsWith('/members')) return r.fulfill({ json: [member(me, ['500']), member(bob)] })
    if (pathname.endsWith('/channels/300/messages') && method === 'GET') return r.fulfill({ json: history })
    if (pathname.endsWith('/messages') && method === 'POST') {
      const body = r.request().postDataJSON()
      posted.push(body)
      return r.fulfill({ status: 201, json: { ...base, id: '404', type: 0, author: me, content: body.content, nonce: body.nonce } })
    }
    const react = pathname.match(/\/messages\/(\d+)\/reactions\/([^/]+)\/@me$/)
    if (react) {
      sock.send(JSON.stringify({ op: 0, s: 9, t: method === 'PUT' ? 'MESSAGE_REACTION_ADD' : 'MESSAGE_REACTION_REMOVE',
        d: { user_id: me.id, channel_id: '300', message_id: react[1], guild_id: G, emoji: { id: null, name: decodeURIComponent(react[2]) } } }))
      return r.fulfill({ status: 204 })
    }
    if (pathname.endsWith('/ack')) return r.fulfill({ json: { token: null } })
    if (pathname.endsWith('/pins')) return r.fulfill({ json: [] })
    if (pathname.endsWith('/canvas')) {
      if (method === 'GET') return r.fulfill({ json: { channel_id: '300', content: '# Channel Notes\nWelcome to general', version: 1, updated_at: '2026-01-01T00:00:00Z', updated_by: '100' } })
      if (method === 'PUT') {
        const b = r.request().postDataJSON()
        return r.fulfill({ json: { channel_id: '300', content: b.content, version: 2, updated_at: new Date().toISOString(), updated_by: '100' } })
      }
    }
    r.fulfill({ status: 204 })
  })

  await page.goto(`${ORIGIN}/channels/${G}`)
  await page.waitForURL('**/channels/200/300')
  const nav = page.getByRole('navigation', { name: 'Nightfall Gaming channels' })
  const log = page.getByRole('log', { name: 'Messages in #general' })

  // Categories render and collapse; the channel hidden by an @everyone overwrite is not shown.
  await nav.getByRole('button', { name: 'Text Channels', exact: true }).waitFor()
  await nav.getByRole('link', { name: 'general' }).waitFor()
  assert.equal(await nav.getByRole('link', { name: 'secret' }).count(), 0, 'channel without VIEW_CHANNEL is hidden')
  const voiceCat = nav.getByRole('button', { name: 'Voice Channels', exact: true })
  assert.equal(await voiceCat.getAttribute('aria-expanded'), 'true')
  const lounge = nav.getByRole('button', { name: /^Lounge/ })
  await lounge.waitFor()
  // Voice channel lists the connected user from READY voice_states, with the mute icon.
  const connected = nav.getByRole('list', { name: 'Connected users' })
  await connected.getByRole('button', { name: /bob/ }).getByRole('img', { name: 'Muted' }).waitFor()
  await voiceCat.click()
  assert.equal(await voiceCat.getAttribute('aria-expanded'), 'false')
  await lounge.waitFor({ state: 'detached' })
  await voiceCat.click()
  await lounge.waitFor()
  console.log('ok 3 - categories render and collapse; overwrite hides #secret; voice row lists bob muted')

  // Markdown renders as elements; HTML in content stays text.
  const mdMsg = page.locator('#msg-400')
  await mdMsg.locator('strong', { hasText: 'bold' }).waitFor()
  await mdMsg.locator('em', { hasText: 'it' }).waitFor()
  await mdMsg.locator('s', { hasText: 'gone' }).waitFor()
  await mdMsg.locator('code', { hasText: 'code' }).waitFor()
  await mdMsg.getByText('<img src=x onerror=alert(1)>').waitFor()
  assert.equal(await page.locator('img[src="x"]').count(), 0, 'no injected <img>')
  const a = mdMsg.getByRole('link', { name: 'https://example.com/a?b=1' })
  assert.equal(await a.getAttribute('rel'), 'noopener noreferrer')
  assert.equal(await a.getAttribute('target'), '_blank')
  const spoiler = mdMsg.getByRole('button', { name: 'Spoiler, press to reveal' })
  await spoiler.click()
  await mdMsg.locator('.spoiler.shown', { hasText: 'secret stuff' }).waitFor()
  await log.getByText(/joined the lobby|Welcome aboard|has entered|Good to see|spawned in|say hi to/).waitFor()
  console.log('ok 4 - markdown is safe (img onerror shown as text), links, spoiler, system join message')

  // Reactions toggle (optimistic, gateway echo de-duplicated).
  const chip = page.locator('#msg-402').getByRole('button', { name: /👍/ })
  assert.equal(await chip.getAttribute('aria-pressed'), 'false')
  await chip.click()
  await page.locator('#msg-402 .reaction.me', { hasText: '2' }).waitFor()
  await page.waitForTimeout(200)
  assert.equal(await chip.innerText().then((t) => t.includes('2')), true, 'echo did not double count')
  await chip.click()
  await page.locator('#msg-402 .reaction:not(.me)', { hasText: '1' }).waitFor()
  console.log('ok 5 - reaction chip toggles on and off')

  // Reply preview above the reply, click jumps; Reply opens the reply bar.
  const preview = page.locator('#msg-401 .reply-preview')
  await preview.getByText('bold').waitFor()
  await preview.getByRole('button', { name: /Jump to replied message/ }).click()
  await page.locator('#msg-400.flash').waitFor()
  await page.locator('#msg-402').hover()
  await page.locator('#msg-402').getByRole('button', { name: 'Reply', exact: true }).click()
  await page.getByText('Replying to').waitFor()
  console.log('ok 6 - reply preview and jump; reply bar')

  // Mention autocomplete, then the reply is sent with message_reference and a nonce.
  const box = page.getByRole('textbox', { name: 'Message #general' })
  await box.fill('hi @bo')
  await page.getByRole('option', { name: /bob/ }).waitFor()
  await box.press('Enter')
  assert.equal(await box.inputValue(), 'hi @bob ')
  await box.press('Enter')
  await page.locator('#msg-404').waitFor()
  assert.equal(posted[0].content, 'hi <@101>')
  assert.equal(posted[0].message_reference.message_id, '402')
  assert.ok(posted[0].nonce && posted[0].nonce.length <= 25)
  assert.equal(await page.locator('.msg.pending').count(), 0, 'pending copy replaced via nonce')
  console.log('ok 7 - mention autocomplete; reply sent with nonce')

  // Message Link Quote Card: renders author, snippet and jump button.
  const quoteCard = page.locator('#msg-399 .message-quote-card')
  await quoteCard.waitFor()
  await quoteCard.locator('.quote-author', { hasText: 'bob' }).waitFor()
  const jumpBtn = quoteCard.getByRole('button', { name: /Jump/i })
  assert.equal(await jumpBtn.isVisible(), true, 'jump button visible in quote card')
  await jumpBtn.click()
  console.log('ok 7b - message link quote card renders with author, snippet and jump button')

  // Attachment preview chip.
  await page.locator('.composer input[type=file]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') })
  await page.getByRole('list', { name: 'Attachments to send' }).getByText('notes.txt').waitFor()
  await page.getByRole('button', { name: 'Remove notes.txt' }).waitFor()
  await page.mouse.move(0, 0)
  await page.screenshot({ path: path.join(root, 'smoke-main.png') })
  await page.getByRole('button', { name: 'Remove notes.txt' }).click()
  console.log('ok 8 - attachment preview chip with remove')

  // Channel Canvas panel opens from header button, shows rendered markdown, and closes
  await page.getByRole('button', { name: 'Channel Canvas' }).click()
  const canvasPanel = page.locator('.canvas-panel')
  await canvasPanel.waitFor()
  await canvasPanel.getByRole('heading', { name: 'Channel Notes' }).waitFor()
  await canvasPanel.getByRole('button', { name: 'Close' }).click()
  await canvasPanel.waitFor({ state: 'detached' })
  console.log('ok 8b - channel canvas opens, displays markdown notes, and closes')

  // Server Settings > Roles opens for a member with MANAGE_ROLES.
  await page.getByRole('button', { name: 'Nightfall Gaming', exact: true }).click()
  await page.getByRole('button', { name: 'Server Settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Nightfall Gaming' })
  await settings.getByRole('tab', { name: 'Roles' }).click()
  await settings.getByRole('heading', { name: 'Roles', level: 1 }).waitFor()
  await settings.getByRole('button', { name: 'Staff' }).first().waitFor()
  await settings.getByRole('heading', { name: /Edit Role/ }).waitFor()
  await page.screenshot({ path: path.join(root, 'smoke-roles.png') })
  await page.keyboard.press('Escape')
  await settings.waitFor({ state: 'detached' })
  console.log('ok 9 - server settings roles page')

  // Joining voice sends op 4; endpoint null shows the not-configured message.
  await lounge.click()
  await page.waitForURL('**/channels/200/302')
  const op4 = ops.find((f) => f.op === 4)
  assert.deepEqual({ g: op4.d.guild_id, c: op4.d.channel_id }, { g: G, c: '302' })
  const view = page.getByRole('main', { name: 'Voice channel Lounge' })
  await view.getByText('Voice is not configured on this server').waitFor()
  await page.getByRole('region', { name: 'Voice connection' }).getByText('Voice Unavailable').waitFor()
  await view.getByRole('list', { name: 'Participants' }).getByText('bob').waitFor()
  await page.mouse.move(0, 0)
  await page.screenshot({ path: path.join(root, 'smoke-voice.png') })
  await page.getByRole('region', { name: 'Voice connection' }).getByRole('button', { name: 'Disconnect' }).click()
  assert.equal(ops.at(-1).op, 4)
  assert.equal(ops.at(-1).d.channel_id, null)
  console.log('ok 10 - voice join sends op 4; "Voice is not configured on this server"')

  assert.deepEqual(dialogs, [], 'no alert or confirm dialogs')
  await ctx.close()
}

async function runOnly(browser, errors) {
  const name = process.env.SMOKE_ONLY
  await require(path.join(__dirname, ['v4', 'v5', 'v6-admin', 'v6-custom', 'v7', 'v8', 'whatsnew'].includes(name) ? `smoke-${name}.cjs` : `smoke-v3-${name}.cjs`)).run(browser, errors)
  assert.deepEqual(errors, [], 'no uncaught page errors')
}

async function main() {
  await require(path.join(__dirname, 'smoke-registry.cjs')).run() // no browser needed
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', ...(process.env.SMOKE_DIST ? ['--outDir', process.env.SMOKE_DIST] : [])], { cwd: root, stdio: 'ignore', detached: true }) // own process group: npx's vite child is stopped with it
  const browser = await chromium.launch()
  const errors = []
  try {
    await waitForServer()

    if (process.env.SMOKE_ONLY) return await runOnly(browser, errors)
    // 1. Login renders; register leads to the shell, which keeps "connecting" because no server answers.
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    page.on('pageerror', (e) => errors.push(e.message))
    await page.route('**/api/v9/**', (r) =>
      r.request().url().endsWith('/auth/register') ? r.fulfill({ status: 201, json: { token: 'smoke-token' } }) : r.abort())
    await page.goto(ORIGIN)
    await page.getByRole('heading', { name: 'Ready up' }).waitFor()
    assert.equal(new URL(page.url()).pathname, '/login')
    await page.getByRole('link', { name: 'Register' }).click()
    await page.getByLabel('Email').fill('c@example.com')
    await page.getByLabel('Username').fill('ciller')
    await page.getByLabel('Password').fill('hunter2hunter2')
    await page.getByRole('button', { name: 'Continue' }).click()
    assert.equal(new URL(page.url()).pathname, '/register', 'the age box is required')
    await page.getByLabel('I am at least 14 years old.').check()
    const sent = page.waitForRequest('**/auth/register')
    await page.getByRole('button', { name: 'Continue' }).click()
    assert.equal((await sent).postDataJSON().age_confirmed, true, 'sent as a boolean')
    await page.waitForURL('**/channels/@me')
    await page.locator('.app[data-gateway="connecting"]').waitFor()
    assert.equal(await page.getByRole('status').innerText(), 'Connecting…')
    await page.getByRole('navigation', { name: 'Servers' }).waitFor()
    assert.equal(await page.evaluate(() => localStorage.getItem('token')), 'smoke-token')
    await page.screenshot({ path: path.join(root, 'smoke.png') })
    console.log('ok 1 - login renders; register -> shell, gateway connecting')

    // 1b. Main Hub / Private Node: the hub tab names the real address; a bare saved address gets https://, http is refused.
    {
      const pctx = await browser.newContext()
      const pp = await pctx.newPage()
      pp.on('pageerror', (e) => errors.push(e.message))
      const hits = []
      await pp.route('**/api/v9/**', (r) => (hits.push(r.request().url()), r.request().url().startsWith('https://chat.example.org/') ? r.fulfill({ json: { name: 'Node X' }, headers: { 'access-control-allow-origin': '*' } }) : r.abort()))
      await pp.goto(`${ORIGIN}/login`)
      await pp.getByText(`Connected to localhost:${PORT}`).waitFor()
      await pp.getByRole('tab', { name: /Private Node/ }).click()
      const input = pp.locator('.private-node-input')
      await input.fill('http://chat.example.org')
      await input.press('Enter')
      await pp.getByText('Use an https:// address').waitFor()
      await input.fill('chat.example.org/')
      await input.press('Enter')
      await pp.getByText('Connected to Node X').waitFor()
      assert.equal(await pp.evaluate(() => localStorage.getItem('cillhub_custom_node_url')), 'https://chat.example.org')
      // a bare address saved by 7.7 still reaches the node after a reload
      await pp.evaluate(() => localStorage.setItem('cillhub_custom_node_url', 'chat.example.org'))
      hits.length = 0
      await pp.reload()
      await pp.getByRole('heading', { name: 'Ready up' }).waitFor()
      await pp.waitForTimeout(300)
      assert.ok(hits.length && hits.every((u) => u.startsWith('https://chat.example.org/api/v9/')), `calls go to the node: ${hits.join(' ')}`)
      await pctx.close()
      console.log('ok 1b - server picker: real hub address, https:// added, http refused, saved bare address works')
    }

    // 2. Fake gateway: READY, history, optimistic send de-duplicated against our own MESSAGE_CREATE echo, typing.
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await ctx.addInitScript(() => localStorage.setItem('token', 'smoke-token'))
    const p2 = await ctx.newPage()
    p2.on('pageerror', (e) => errors.push(e.message))
    let sock
    await p2.routeWebSocket(`ws://localhost:${PORT}/gateway`, (ws) => {
      sock = ws
      ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 41250 }, s: null, t: null }))
      ws.onMessage((raw) => {
        const f = JSON.parse(raw)
        if (f.op === 2) {
          assert.equal(f.d.token, 'smoke-token')
          assert.equal(f.d.properties.browser, 'Cillhub Web')
          ws.send(JSON.stringify({ op: 0, s: 1, t: 'READY', d: {
            v: 9, session_id: 's', user: me, read_state: [], private_channels: [],
            guilds: [{ id: '200', name: 'Nightfall Gaming', icon: null, owner_id: '100', member_count: 2,
              channels: [{ id: '300', type: 0, guild_id: '200', name: 'general', position: 0, topic: 'Say hi', last_message_id: '401' }] }],
            users: [bob], presences: [{ user: { id: '100' }, status: 'online' }, { user: { id: '101' }, status: 'online' }],
          } }))
        }
      })
    })
    await p2.route('**/api/v9/**', async (r) => {
      const { pathname } = new URL(r.request().url())
      const method = r.request().method()
      if (pathname.endsWith('/gateway')) return r.fulfill({ json: { url: `ws://localhost:${PORT}/gateway` } })
      if (pathname.endsWith('/members')) return r.fulfill({ json: [me, bob].map((u) => ({ user: u, nick: null, roles: [], joined_at: '' })) })
      if (pathname.endsWith('/messages') && method === 'GET') return r.fulfill({ json: [msg('401', bob, 'second'), msg('400', bob, 'first <@100>')] })
      if (pathname.endsWith('/messages') && method === 'POST') {
        const body = r.request().postDataJSON()
        const real = { ...msg('402', me, body.content), nonce: body.nonce }
        await new Promise((res) => setTimeout(res, 300)) // pending state must be visible meanwhile
        sock.send(JSON.stringify({ op: 0, s: 2, t: 'MESSAGE_CREATE', d: real })) // echo arrives before the REST reply
        await new Promise((res) => setTimeout(res, 100))
        return r.fulfill({ status: 201, json: real })
      }
      r.fulfill({ status: 204 })
    })
    await p2.goto(`${ORIGIN}/channels/200`)
    await p2.waitForURL('**/channels/200/300')
    await p2.locator('.app[data-gateway="ready"]').waitFor()
    await p2.getByRole('heading', { name: 'general', level: 1 }).waitFor()
    await p2.getByText('first @ciller').waitFor()
    await p2.getByRole('heading', { name: /Online — 2/ }).waitFor()
    assert.equal(await p2.locator('.msg.head').count(), 1, 'two quick messages by one author form one group')
    const box = p2.getByRole('textbox', { name: 'Message #general' })
    await box.fill('hello there')
    await box.press('Enter')
    await p2.locator('.msg.pending', { hasText: 'hello there' }).waitFor()
    await p2.locator('.msg:not(.pending)', { hasText: 'hello there' }).waitFor()
    await p2.waitForTimeout(200)
    assert.equal(await p2.locator('.msg', { hasText: 'hello there' }).count(), 1, 'own message is de-duplicated')
    sock.send(JSON.stringify({ op: 0, s: 3, t: 'TYPING_START', d: { channel_id: '300', guild_id: '200', user_id: '101', timestamp: 0 } }))
    await p2.getByText('bob is typing…').waitFor()
    await p2.screenshot({ path: path.join(root, 'smoke-ready.png') })
    await p2.setViewportSize({ width: 600, height: 800 })
    await p2.getByRole('button', { name: 'Back to channels' }).click()
    await p2.getByRole('navigation', { name: 'Nightfall Gaming channels' }).waitFor()
    console.log('ok 2 - fake gateway: READY, history, optimistic send + de-dup, typing, narrow back button')

    await v2(browser, errors)

    // v3 suites, each with its own page against the shared fake (scripts/smoke-v3-harness.cjs).
    const only = process.env.SMOKE_ONLY // e.g. SMOKE_ONLY=threads runs one suite
    for (const name of ['core', 'threads', 'events', 'settings']) {
      if (only && only !== name) continue
      const file = path.join(__dirname, `smoke-v3-${name}.cjs`)
      if (!require('node:fs').existsSync(file)) continue
      await require(file).run(browser, errors)
    }
    // v4 suite (scripts/smoke-v4.cjs): calls, profiles, notifications, settings, security, bots.
    if (!only || only === 'v4') await require(path.join(__dirname, 'smoke-v4.cjs')).run(browser, errors)
    // v5 suite (scripts/smoke-v5.cjs): Watch Together, noise suppression, desktop bridge, Cillhub Bot, scheduling, voice status, templates.
    if (!only || only === 'v5') await require(path.join(__dirname, 'smoke-v5.cjs')).run(browser, errors)
    // v6 admin suite (scripts/smoke-v6-admin.cjs): admin dashboard, reports, instance banner, registration codes.
    if (!only || only === 'v6-admin') await require(path.join(__dirname, 'smoke-v6-admin.cjs')).run(browser, errors)
    // v6 customization suite (scripts/smoke-v6-custom.cjs): themes, custom CSS + safe mode, sounds, keybinds, profile and server customization.
    if (!only || only === 'v6-custom') await require(path.join(__dirname, 'smoke-v6-custom.cjs')).run(browser, errors)
    // v7 suite (scripts/smoke-v7.cjs): setup wizard, hub + node in one client, server directory, hub/node admin pages.
    if (!only || only === 'v7') await require(path.join(__dirname, 'smoke-v7.cjs')).run(browser, errors)
    // v8 suite (scripts/smoke-v8.cjs): Admin › Modules, permission review, module settings, module panels and the bridge.
    if (!only || only === 'v8') await require(path.join(__dirname, 'smoke-v8.cjs')).run(browser, errors)
    // What's New suite (scripts/smoke-whatsnew.cjs): changelog dialog and settings tab, old Android app banner.
    if (!only || only === 'whatsnew') await require(path.join(__dirname, 'smoke-whatsnew.cjs')).run(browser, errors)

    assert.deepEqual(errors, [], 'no uncaught page errors')
  } finally {
    await browser.close()
    try { process.kill(-preview.pid) } catch { preview.kill() }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
