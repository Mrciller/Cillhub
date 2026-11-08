// v8 smoke (CONTRACT-v8 §2, §5, §6, §9) with the faked backend of smoke-v3-harness: Admin › Modules (list with crashed
// reason, enable switch, install from a Git URL, permission review, Install with the exact lists and the 2FA elevation
// header, settings form with every type, per-server values, logs, remove), module panels (channel_panel side panel with a
// sandboxed iframe, guild_sidebar page, message_accessory), the postMessage bridge (ready → context, a request round trip,
// error mapping, size and shape checks, messages from another window ignored, MODULE_UI_EVENT) and the MODULE badge.
// Saves smoke-v8-*.png. Run alone: SMOKE_ONLY=v8 npm run smoke (or as part of npm run smoke).
const assert = require('node:assert/strict')
const path = require('node:path')
const h = require('./smoke-v3-harness.cjs')

const shot = (name) => path.join(h.root, `smoke-v8-${name}.png`)
const schema = [
  { key: 'title', type: 'text', label: 'Board title', placeholder: 'Scrims' },
  { key: 'intro', type: 'text', label: 'Intro', multiline: true, max_length: 500 },
  { key: 'max_teams', type: 'number', label: 'Max teams', min: 2, max: 16, integer: true },
  { key: 'pings', type: 'toggle', label: 'Ping on new scrims' },
  { key: 'region', type: 'select', label: 'Region', options: [{ value: 'eu', label: 'Europe' }, { value: 'na', label: 'North America' }] },
  { key: 'channel', type: 'channel', label: 'Announcement channel', per_server: true, channel_types: [0, 5] },
  { key: 'role', type: 'role', label: 'Ping role', per_server: true },
  { key: 'owner', type: 'user', label: 'Organizer' },
  { key: 'api_token', type: 'secret', label: 'API token' },
  { key: 'webhook_secret', type: 'secret', label: 'Webhook secret' },
]
const perms = ['commands', 'messages.read', 'messages.send', 'storage', 'ui', 'http.fetch', 'http.routes']
const hosts = ['api.example.com']
const mod = (extra = {}) => ({
  id: 'scrim-board', name: 'Scrim Board', version: '1.0.0', description: 'Lists upcoming scrims.', author: 'Jane Doe', homepage: null, application_id: '1300', icon: null,
  source: { type: 'git', filename: null, git_url: 'https://git.example.com/me/scrim-board.git', git_ref: 'main', commit: '3f2a9c1d00ff' },
  permissions: perms, http_hosts: hosts, enabled: false, status: 'disabled', status_reason: null, scope: 'all', guild_ids: [], per_server_settings: false,
  settings_schema: schema, settings: { title: 'Scrims', intro: null, max_teams: 8, pings: false, region: 'eu', channel: null, role: null, owner: null, api_token: { set: false }, webhook_secret: { set: true } },
  commands: [{ name: 'scrim', type: 1, description: 'Add a scrim' }], panels: [{ id: 'board', slot: 'channel_panel', title: 'Scrims' }], http_url: '/modules/scrim-board/http/',
  storage: { used_bytes: 2048, quota_bytes: 5242880 }, stats: { started_at: null, events: 120, errors: 1, crashes: 0, restarts: 0, last_error: 'TypeError: x is undefined', last_error_at: h.iso(-60e3) },
  installed_at: h.iso(-86400e3), updated_at: h.iso(-3600e3), ...extra,
})
const crashed = { ...mod(), id: 'twitch-alerts', name: 'Twitch Alerts', version: '0.3.1', status: 'crashed', status_reason: 'Crashed 5 times in 10 minutes', application_id: '1301' }
const pkg = {
  package_id: 'pkg1', expires_at: h.iso(1800e3), source: mod().source, files: 7, size: 18233, update_of: null, warnings: ['The homepage is missing.'],
  manifest: { manifest_version: 1, id: 'scrim-board', name: 'Scrim Board', version: '1.0.0', description: 'Lists upcoming scrims.', author: 'Jane Doe', main: 'index.js', permissions: perms, http_hosts: hosts,
    commands: [{ name: 'scrim', description: 'Add a scrim', options: [] }], settings: schema, ui: { panels: [{ id: 'board', slot: 'channel_panel', title: 'Scrims', entry: 'ui/board.html' }] } },
  permissions: perms, http_hosts: hosts,
}
const adminGuild = { id: '200', name: 'Nightfall Gaming', icon: null, description: null, created_at: h.iso(), owner: null, member_count: 3, channel_count: 7, message_count: 0, storage_bytes: 0, invites_disabled: false }
const guildDetail = { ...adminGuild, settings: {}, emoji_count: 0, sticker_count: 0, invites: [], bans: [], audit_log: [],
  roles: [{ id: '200', name: '@everyone', position: 0 }, { id: '500', name: 'Staff', position: 1 }],
  channels: [{ id: '600', name: 'Text Channels', type: 4, parent_id: null, position: 0, nsfw: false }, { id: '300', name: 'general', type: 0, parent_id: '600', position: 0, nsfw: false },
    { id: '302', name: 'Lounge', type: 2, parent_id: null, position: 1, nsfw: false }] }

/** Waits for a recorded call matching `pred`. */
async function waitFor(list, pred, what) {
  for (let i = 0; i < 100; i++) {
    const c = list.find(pred)
    if (c) return c
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`expected ${what}; got ${JSON.stringify(list.map((c) => `${c.method} ${c.path}`))}`)
}

async function admin(browser, errors) {
  const calls = []
  let current = mod()
  let finishes = 0
  const { page, ctx } = await h.open(browser, { errors, ready: (d) => ({ ...d, user: { ...d.user, instance_admin: true, mfa_enabled: true } }), routes: async (r, { pathname, method, body, url }) => {
    const json = (j, status = 200) => (r.fulfill({ status, json: j }), true)
    const headers = r.request().headers()
    if (pathname === '/api/v9/users/@me') return json({ ...h.me, instance_admin: true, mfa_enabled: true })
    if (pathname === '/api/v9/instance') return json({ name: 'Cillhub', motd: null, registration_mode: 'open', announcement: null })
    if (pathname === '/api/v9/mfa/finish') return (finishes++, calls.push({ method, path: '/mfa/finish', body }), json({ token: 'elev-token' }))
    if (!pathname.startsWith('/api/v9/admin/')) return false
    const p = pathname.slice('/api/v9/admin'.length)
    calls.push({ method, path: p, body, query: Object.fromEntries(url.searchParams), mfa: headers['x-cillhub-mfa-authorization'] ?? null })
    const elevated = () => headers['x-cillhub-mfa-authorization'] === 'elev-token'
    const needMfa = () => json({ code: 60003, message: 'Two factor is required for this operation', mfa: { ticket: 'tick-1', methods: [{ type: 'totp' }, { type: 'backup' }] } }, 401)
    if (p === '/modules' && method === 'GET') return json([current, crashed])
    if (p === '/modules/packages' && method === 'POST') return json(pkg, 201)
    if (p === '/modules' && method === 'POST') return elevated() ? json(current, 201) : needMfa()
    if (p === '/modules/scrim-board' && method === 'GET') return json(current)
    if (p === '/modules/scrim-board' && method === 'PATCH') return json((current = { ...current, ...body }))
    if (p === '/modules/scrim-board' && method === 'DELETE') return elevated() ? (r.fulfill({ status: 204 }), true) : needMfa()
    if (p === '/modules/scrim-board/settings' && method === 'PUT') return json((current = { ...current, updated_at: h.iso(), settings: { ...current.settings, ...body.values } }))
    if (p === '/modules/scrim-board/guilds/200/settings') return method === 'DELETE' ? (r.fulfill({ status: 204 }), true) : json({ guild_id: '200', values: { channel: null, role: '500', ...(method === 'PUT' && body.values) } })
    if (p === '/modules/scrim-board/logs') return json([
      { id: '3', at: h.iso(-10e3), level: 'error', message: 'TypeError: x is undefined' },
      { id: '2', at: h.iso(-20e3), level: 'system', message: 'Started (pid sandbox)' },
      { id: '1', at: h.iso(-30e3), level: 'info', message: 'Loaded 3 scrims' },
    ])
    if (p === '/modules/twitch-alerts' && method === 'PATCH') return json({ ...crashed, ...body, status: 'starting', status_reason: null })
    if (p === '/guilds') return json([adminGuild])
    if (p === '/guilds/200') return json(guildDetail)
    return json({ code: 0, message: `not faked: ${method} ${p}` }, 404)
  } })

  await page.goto(`${h.ORIGIN}/admin/modules`)
  await page.getByRole('heading', { name: 'Modules', level: 1 }).waitFor()
  const table = page.getByRole('table', { name: 'Modules' })
  await table.getByText('Crashed 5 times in 10 minutes').waitFor()
  await table.getByRole('button', { name: 'Scrim Board' }).waitFor()
  await table.getByRole('switch', { name: 'Enable Twitch Alerts' }).click()
  assert.deepEqual((await waitFor(calls, (c) => c.method === 'PATCH' && c.path === '/modules/twitch-alerts', 'PATCH twitch-alerts')).body, { enabled: true })
  console.log('ok v8 1 - modules list: name, version, crashed reason, enabled switch sends PATCH {enabled}')

  // Install from a Git URL → review → Install with the 2FA elevation.
  await page.getByRole('button', { name: 'Install Module' }).click()
  await page.getByRole('heading', { name: 'Install a module' }).waitFor()
  await page.getByLabel('Git URL (https://)').fill('https://git.example.com/me/scrim-board.git')
  await page.getByLabel('Branch or tag (optional)').fill('main')
  await page.getByRole('button', { name: 'Fetch and Review' }).click()
  assert.deepEqual((await waitFor(calls, (c) => c.method === 'POST' && c.path === '/modules/packages', 'staging')).body, { git_url: 'https://git.example.com/me/scrim-board.git', git_ref: 'main' })
  const review = page.getByRole('region', { name: 'Review Scrim Board before installing' })
  await review.waitFor()
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'review-h', 'focus moves to the review heading')
  await review.getByText('Reads messages, edits, deletions and reactions in channels it can see, including older messages.').waitFor()
  await review.getByText('Sends requests to these websites, and only to these:').waitFor()
  await review.getByText('api.example.com').waitFor()
  await review.getByText('/scrim', { exact: true }).waitFor()
  await review.getByText('Scrims · Side panel in channels').waitFor()
  await review.getByText('The homepage is missing.').waitFor()
  assert.equal(await review.locator('.module-perms > li').count(), perms.length, 'every permission is explained')
  await page.screenshot({ path: shot('review'), fullPage: true })
  await review.getByRole('button', { name: 'Approve and Install' }).click()
  const code = page.getByRole('dialog', { name: 'Install Scrim Board?' })
  await code.getByLabel('Authentication or backup code').fill('123 456')
  await code.getByRole('button', { name: 'Install' }).click()
  const finish = await waitFor(calls, (c) => c.path === '/mfa/finish', 'POST /mfa/finish')
  assert.deepEqual(finish.body, { ticket: 'tick-1', mfa_type: 'totp', data: '123456' })
  const install = await waitFor(calls, (c) => c.method === 'POST' && c.path === '/modules' && c.mfa, 'elevated install')
  assert.deepEqual(install.body, { package_id: 'pkg1', approve: { permissions: perms, http_hosts: hosts } })
  assert.equal(install.mfa, 'elev-token')
  await page.getByText('Scrim Board was installed. It starts disabled: enable it when you are ready.').waitFor()
  await page.getByRole('heading', { name: 'Scrim Board 1.0.0' }).waitFor()
  console.log('ok v8 2 - install from Git URL: staging body, review explains every permission, hosts, commands, panels, warnings; Install sends the exact lists after /mfa/finish with X-Cillhub-MFA-Authorization')

  // Overview, then Settings with each type.
  await page.getByText('TypeError: x is undefined').waitFor()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const form = page.locator('form.module-settings')
  await form.getByLabel('Board title').fill('Weekly scrims')
  await form.getByLabel('Intro').fill('Line one\nLine two')
  await form.getByLabel('Max teams').fill('12')
  await form.getByLabel('Ping on new scrims').check()
  await form.getByLabel('Region').selectOption('na')
  const chField = form.locator('.field', { has: page.getByText('Announcement channel', { exact: true }) })
  await chField.getByRole('searchbox').fill('Night')
  await chField.getByRole('button', { name: 'Nightfall Gaming' }).click()
  await form.getByLabel('Announcement channel').selectOption('300')
  assert.equal(await form.getByLabel('Announcement channel').locator('option').count(), 2, 'channel_types keeps text channels only (plus None)')
  const roleField = form.locator('.field', { has: page.getByText('Ping role', { exact: true }) })
  await roleField.getByRole('searchbox').fill('Night')
  await roleField.getByRole('button', { name: 'Nightfall Gaming' }).click()
  await form.getByLabel('Ping role').selectOption('500')
  await form.getByLabel('Organizer').fill('101')
  const secret = form.locator('.field', { has: page.getByText('API token', { exact: true }) })
  await secret.getByText('No value set').waitFor()
  await form.getByLabel('API token').fill('s3cr3t')
  const hook = form.locator('.field', { has: page.getByText('Webhook secret', { exact: true }) })
  await hook.getByText('A value is set').waitFor()
  await hook.getByRole('button', { name: 'Clear' }).click()
  await hook.getByText('Cleared when you save.').waitFor()
  await page.screenshot({ path: shot('settings'), fullPage: true })
  await form.getByRole('button', { name: 'Save Settings' }).click()
  const saved = await waitFor(calls, (c) => c.method === 'PUT' && c.path === '/modules/scrim-board/settings', 'PUT settings')
  assert.deepEqual(saved.body, { values: { title: 'Weekly scrims', intro: 'Line one\nLine two', max_teams: 12, pings: true, region: 'na', channel: '300', role: '500', owner: '101', api_token: 's3cr3t', webhook_secret: null } })
  console.log('ok v8 3 - settings form: text, multiline, number, toggle, select, channel and role (server picked first), user, secret replace and clear; only changed keys')

  // Per-server values.
  await page.getByLabel('Allow different values per server').click()
  assert.deepEqual((await waitFor(calls, (c) => c.method === 'PATCH' && c.path === '/modules/scrim-board' && c.body.per_server_settings, 'PATCH per_server_settings')).body, { per_server_settings: true })
  const pick = page.locator('.module-guild-search', { has: page.getByText('Edit values for server') })
  await pick.getByRole('searchbox').fill('Night')
  await pick.getByRole('button', { name: 'Nightfall Gaming' }).click()
  const sv = page.getByRole('region', { name: 'Values for Nightfall Gaming' })
  await sv.getByLabel('Ping role').waitFor()
  assert.equal(await sv.getByLabel('Board title').count(), 0, 'only per_server keys per server')
  assert.equal(await sv.getByLabel('Ping role').inputValue(), '500')
  await sv.getByLabel('Announcement channel').selectOption('300')
  await sv.getByRole('button', { name: 'Save Settings' }).click()
  assert.deepEqual((await waitFor(calls, (c) => c.method === 'PUT' && c.path === '/modules/scrim-board/guilds/200/settings', 'PUT guild settings')).body, { values: { channel: '300' } })
  await sv.getByRole('button', { name: 'Reset this server' }).click()
  await page.getByRole('dialog', { name: 'Reset Nightfall Gaming?' }).getByRole('button', { name: 'Reset' }).click()
  await waitFor(calls, (c) => c.method === 'DELETE' && c.path === '/modules/scrim-board/guilds/200/settings', 'DELETE guild settings')
  console.log('ok v8 4 - per-server settings: toggle, server picker, per_server keys only, PUT and reset')

  // Logs.
  await page.getByRole('button', { name: 'Logs', exact: true }).click()
  const log = page.getByRole('list', { name: 'Log, newest first' })
  await log.getByText('Loaded 3 scrims').waitFor()
  assert.equal(await log.locator('li').count(), 3)
  await page.getByLabel('Level').selectOption('system')
  await log.getByText('Loaded 3 scrims').waitFor({ state: 'detached' })
  assert.equal(await log.locator('li').count(), 1)
  console.log('ok v8 5 - logs: newest first, level filter incl. system')

  // Remove: type the id, delete data, confirm, 2FA.
  await page.getByRole('button', { name: 'Remove', exact: true }).click()
  const removeBtn = page.getByRole('button', { name: 'Remove Module' })
  assert.equal(await removeBtn.isDisabled(), true, 'disabled until the id is typed')
  await page.getByLabel('Delete them').check()
  await page.getByLabel('Type the module ID (scrim-board) to confirm').fill('scrim-board')
  await removeBtn.click()
  await page.getByRole('dialog', { name: 'Remove Scrim Board?' }).getByRole('button', { name: 'Remove Module' }).click()
  const rc = page.getByRole('dialog', { name: 'Remove Scrim Board?' })
  await rc.getByLabel('Authentication or backup code').fill('ABCD-EFGH')
  await rc.getByRole('button', { name: 'Remove Module' }).click()
  const del = await waitFor(calls, (c) => c.method === 'DELETE' && c.path === '/modules/scrim-board' && c.mfa, 'elevated DELETE')
  assert.deepEqual(del.body, { confirm: 'scrim-board', keep_data: false })
  assert.deepEqual(calls.filter((c) => c.path === '/mfa/finish').at(-1).body, { ticket: 'tick-1', mfa_type: 'backup', data: 'ABCDEFGH' })
  await page.getByText('Scrim Board was removed.').waitFor()
  await table.waitFor()
  assert.equal(finishes, 2)
  console.log('ok v8 6 - remove: id typed, keep/delete data, confirmation, backup code elevation, DELETE {confirm, keep_data}')
  await ctx.close()
}

// A panel page that records every message from its parent and can post anything (window.send).
const PANEL = `<!doctype html><title>board</title><body>board<script>
window.got = []; addEventListener('message', (e) => { if (e.source === parent) got.push(e.data) });
window.send = (m) => parent.postMessage(m, '*');
</script>`

async function panels(browser, errors) {
  const bot = h.user('1300', 'scrim-board', { bot: true, module: true, global_name: 'Scrim Board' })
  const panelList = [
    { module_id: 'scrim-board', application_id: '1300', panel_id: 'board', slot: 'channel_panel', title: 'Scrims', icon: '🏆', height: 360, url: '/modules/scrim-board/ui/ui/board.html' },
    { module_id: 'scrim-board', application_id: '1300', panel_id: 'home', slot: 'guild_sidebar', title: 'Scrim HQ', icon: null, height: 360, url: '/modules/scrim-board/ui/ui/home.html' },
    { module_id: 'scrim-board', application_id: '1300', panel_id: 'card', slot: 'message_accessory', title: 'Scrim card', icon: null, height: 120, url: '/modules/scrim-board/ui/ui/card.html' },
  ]
  const uiCalls = []
  const accessoryMsg = { ...h.base(), id: '425', type: 0, author: bot, content: 'Scrim tonight 20:00', application_id: '1300', module_accessory: { module_id: 'scrim-board', panel_id: 'card' }, timestamp: h.iso(-30e3) }
  // The harness's init script (token into localStorage) also runs in the sandboxed panel frames, where storage access
  // throws; those errors prove the sandbox and are dropped, every other page error is kept.
  const frameErrors = []
  const { page, ctx, dispatch } = await h.open(browser, {
    errors: frameErrors,
    ready: (d) => ({ ...d, users: [...d.users, bot], guilds: d.guilds.map((g) => (g.id === h.G ? { ...g, module_panels: panelList, members: [...g.members, h.member(bot)] } : g)) }),
    routes: async (r, { pathname, method, body }) => {
      if (pathname === `/api/v9/guilds/${h.G}/members`) return r.fulfill({ json: [h.member(h.me), h.member(h.bob, ['500']), h.member(h.carol), h.member(bot)] }), true
      if (pathname === '/api/v9/modules/scrim-board/ui' && method === 'POST') {
        uiCalls.push(body)
        if (body.data?.fail) return r.fulfill({ status: 504, json: { code: 0, message: 'The module did not answer in time.' } }), true
        return r.fulfill({ json: { data: { items: [1, 2], echo: body.data } } }), true
      }
      return false
    },
  })
  await ctx.route('**/modules/scrim-board/ui/**', (r) => r.fulfill({ contentType: 'text/html', body: PANEL }))
  dispatch('MESSAGE_CREATE', accessoryMsg) // after the route, so the accessory iframe gets the fake panel

  // MODULE badge on the message, the accessory iframe under it, and in the member list.
  const msg = page.locator('#msg-425')
  await msg.locator('.bot-tag', { hasText: 'MODULE' }).waitFor()
  const acc = msg.locator('iframe.module-frame')
  await acc.waitFor()
  assert.equal(await acc.getAttribute('sandbox'), 'allow-scripts')
  assert.equal(await acc.getAttribute('title'), 'Scrim card')
  assert.equal(await acc.evaluate((f) => f.style.height), '120px')
  await page.locator('.member-btn', { hasText: 'Scrim Board' }).locator('.bot-tag', { hasText: 'MODULE' }).waitFor()
  console.log('ok v8 7 - MODULE badge on messages and in the member list; message_accessory iframe under the message with the panel height')

  // channel_panel: header button opens the side panel with the sandboxed iframe.
  const btn = page.getByRole('button', { name: 'Scrims', exact: true })
  await btn.click()
  const aside = page.getByRole('complementary', { name: 'Scrims' })
  const frameEl = aside.locator('iframe')
  await frameEl.waitFor()
  assert.equal(await frameEl.getAttribute('sandbox'), 'allow-scripts', 'sandbox is exactly allow-scripts')
  assert.equal(await frameEl.getAttribute('referrerpolicy'), 'no-referrer')
  assert.equal(await frameEl.getAttribute('title'), 'Scrims')
  assert.equal(await btn.getAttribute('aria-pressed'), 'true')
  const frame = await (await frameEl.elementHandle()).contentFrame()
  await frame.waitForFunction(() => window.got?.some((m) => m.type === 'context'))
  const got = () => frame.evaluate(() => window.got)
  const reply = async (id) => {
    await frame.waitForFunction((i) => window.got.some((m) => m.type === 'response' && m.id === i), id)
    return (await got()).find((m) => m.type === 'response' && m.id === id)
  }
  await frame.evaluate(() => (window.got = [], send({ cillhub: 1, type: 'request', id: 'r1', action: 'ready' })))
  const r1 = await reply('r1')
  const msgs = await got()
  assert.deepEqual(msgs.map((m) => m.type), ['context', 'response'], 'ready: a context message, then the response')
  assert.deepEqual(r1, { cillhub: 1, type: 'response', id: 'r1', ok: true, data: null })
  assert.deepEqual(msgs[0].context, { module_id: 'scrim-board', panel_id: 'board', slot: 'channel_panel', guild_id: h.G, channel_id: '300', message_id: null,
    user: { id: '100', username: 'ciller', global_name: null, avatar: null }, locale: 'en-US', theme: 'dark' })
  assert.ok(!JSON.stringify(msgs).includes('smoke-token'), 'no token in bridge messages')
  console.log('ok v8 8 - channel_panel: header button, side panel, iframe sandbox="allow-scripts" no-referrer with title; ready → context then response, no token')

  await frame.evaluate(() => send({ cillhub: 1, type: 'request', id: 'r2', action: 'request', data: { op: 'list' } }))
  assert.deepEqual((await reply('r2')).data, { items: [1, 2], echo: { op: 'list' } })
  assert.deepEqual(uiCalls.at(-1), { panel_id: 'board', guild_id: h.G, channel_id: '300', data: { op: 'list' } })
  await frame.evaluate(() => send({ cillhub: 1, type: 'request', id: 'r3', action: 'request', data: { fail: true } }))
  assert.deepEqual((await reply('r3')).error, { code: 'TIMEOUT', message: 'The module did not answer in time.' })
  await frame.evaluate(() => send({ cillhub: 1, type: 'request', id: 'r4', action: 'teleport' }))
  assert.equal((await reply('r4')).error.code, 'UNKNOWN_ACTION')
  await frame.evaluate(() => send({ cillhub: 1, type: 'request', id: 'r5', action: 'resize', data: { height: 5000 } }))
  assert.equal((await reply('r5')).ok, true)
  const n = uiCalls.length
  // Too large, wrong shape, and a request from another window: all ignored.
  await frame.evaluate(() => send({ cillhub: 1, type: 'request', id: 'big', action: 'request', data: 'x'.repeat(70 * 1024) }))
  await frame.evaluate(() => send({ cillhub: 2, type: 'request', id: 'shape', action: 'request', data: {} }))
  await page.evaluate(() => window.postMessage({ cillhub: 1, type: 'request', id: 'foreign', action: 'request', data: {} }, '*'))
  await page.waitForTimeout(400)
  assert.equal(uiCalls.length, n, 'no UI request for oversized, malformed or foreign messages')
  assert.ok(!(await got()).some((m) => ['big', 'shape', 'foreign'].includes(m.id)), 'nothing answered')
  // MODULE_UI_EVENT of this module and server reaches the panel; another server's does not.
  dispatch('MODULE_UI_EVENT', { module_id: 'scrim-board', guild_id: h.G2, data: { other: true } })
  dispatch('MODULE_UI_EVENT', { module_id: 'scrim-board', guild_id: h.G, data: { added: 'Team A' } })
  await frame.waitForFunction(() => window.got.some((m) => m.type === 'event'))
  assert.deepEqual((await got()).filter((m) => m.type === 'event').map((m) => m.data), [{ added: 'Team A' }])
  await page.screenshot({ path: shot('panel') })
  console.log('ok v8 9 - bridge: request round trip to POST /modules/:id/ui, 504 → TIMEOUT, UNKNOWN_ACTION, resize; >64 KiB, wrong shape and other windows ignored; MODULE_UI_EVENT forwarded per server')

  // close from the panel, then Escape with focus back on the header button.
  await frame.evaluate(() => send({ cillhub: 1, type: 'request', id: 'r6', action: 'close' }))
  await aside.waitFor({ state: 'detached' })
  await btn.click()
  await aside.getByRole('heading', { name: 'Scrims' }).waitFor()
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'H2', 'focus moves into the panel')
  await page.keyboard.press('Escape')
  await aside.waitFor({ state: 'detached' })
  assert.equal(await btn.evaluate((b) => b === document.activeElement), true, 'focus returns to the header button')
  console.log('ok v8 10 - panel closes from the bridge and with Escape; focus moves in and back')

  // guild_sidebar entry: the panel replaces the chat; picking a channel brings the chat back.
  const nav = page.getByRole('navigation', { name: 'Nightfall Gaming channels' })
  await page.getByRole('list', { name: 'Modules' }).getByRole('button', { name: 'Scrim HQ' }).click()
  const main = page.getByRole('main', { name: 'Scrim HQ' })
  assert.equal(await main.locator('iframe').getAttribute('sandbox'), 'allow-scripts')
  await nav.getByRole('link', { name: 'general' }).click()
  await main.waitFor({ state: 'detached' })
  await page.getByRole('log', { name: 'Messages in #general' }).waitFor()
  console.log('ok v8 11 - guild_sidebar entry opens the panel in the main area; a channel click returns to the chat')

  // GUILD_MODULE_PANELS_UPDATE removes the header button.
  dispatch('GUILD_MODULE_PANELS_UPDATE', { guild_id: h.G, module_panels: [] })
  await btn.waitFor({ state: 'detached' })
  console.log('ok v8 12 - GUILD_MODULE_PANELS_UPDATE updates the panels')
  await ctx.close()
  errors.push(...frameErrors.filter((e) => !/sandboxed and lacks the 'allow-same-origin' flag/.test(e)))
}

async function run(browser, errors) {
  await admin(browser, errors)
  await panels(browser, errors)
}

module.exports = { run }
