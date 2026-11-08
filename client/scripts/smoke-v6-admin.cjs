// v6 admin smoke (fake API + gateway from smoke-v3-harness): instance admin dashboard (CONTRACT-v6 §0). Non-admins see no
// entry and /admin makes no admin request; admins without 2FA get the explanation screen; every page renders against a faked
// /api/v9/admin/*, and each action calls the expected endpoint with the expected body. Also: "Report message" from the
// message menu, the announcement banner, the login MOTD and the registration-code field. Saves smoke-v6-admin-*.png.
// Run alone: SMOKE_ONLY=v6-admin npm run smoke (or as part of npm run smoke).
const assert = require('node:assert/strict')
const path = require('node:path')
const h = require('./smoke-v3-harness.cjs')

const shot = (name) => path.join(h.root, `smoke-v6-admin-${name}.png`)
const days = Array.from({ length: 14 }, (_, i) => ({ date: new Date(Date.UTC(2026, 9, 22 + i)).toISOString().slice(0, 10), count: [12, 40, 33, 8, 0, 55, 61][i % 7] + i }))
// Shapes of server/src/routes/admin.js.
const overview = {
  users: { total: 128, bots: 2, disabled: 1, active_24h: 31, active_7d: 77, online: 12 }, guilds: 9, channels: 64,
  messages: { total: 48211, per_day: days },
  voice: { in_voice_now: 3, minutes_30d: 5120, minutes_per_day: [], backends: { configured: ['livekit', 'cillvoice'], default: 'livekit', livekit: { configured: true, reachable: true }, cillvoice: { configured: true, running: false } } },
  reports_open: 2, storage: { uploads_bytes: 3.2 * 1024 ** 3, uploads_by_kind: {}, database_bytes: 48 * 1024 ** 2 }, disk: { free_bytes: 120 * 1024 ** 3, total_bytes: 400 * 1024 ** 3 },
  version: '6.0.0', node: 'v24.0.0', started_at: h.iso(-3 * 86400e3), uptime_seconds: 3 * 86400 + 7200, recent_errors: [{ at: h.iso(-60e3), message: 'unfurl timeout for example.com' }],
}
const adminUser = (id, username, extra = {}) => ({
  id, username, global_name: null, avatar: null, email: `${username}@example.com`, created_at: h.iso(-90 * 86400e3), last_seen: h.iso(-3600e3), bot: false,
  mfa_enabled: false, disabled: false, deleted: false, instance_admin: false, require_password_change: false, guild_count: 2, application_count: 0, online: false, ...extra,
})
const users = [adminUser('100', 'ciller', { mfa_enabled: true, instance_admin: true, online: true }), adminUser('101', 'bob', { application_count: 1 }), adminUser('102', 'carol', { disabled: true })]
const guild = { id: '200', name: 'Nightfall Gaming', icon: null, description: 'Gaming org', created_at: h.iso(-80 * 86400e3), owner: { id: '100', username: 'ciller', global_name: null },
  member_count: 3, channel_count: 7, message_count: 1234, storage_bytes: 5e6, invites_disabled: false }
const report = (id, extra = {}) => ({
  id, status: 'open', reason: 'harassment', note: 'keeps insulting people', created_at: h.iso(-600e3), actions: [], reporter: h.carol, author: h.bob,
  guild: { id: '200', name: 'Nightfall Gaming' }, channel: { id: '300', type: 0, name: 'general' },
  message: { id: '420', content: 'you are all <b>bad</b>', timestamp: h.iso(-700e3), attachments: [], exists: true }, link: '/channels/200/300/420', ...extra,
})
let settings = { registration_mode: 'open', instance_name: 'Cillhub', motd: null, max_upload_bytes: 25 * 1024 ** 2, gifs_enabled: true, voice_backend: null,
  announcement: { id: '1', content: 'Maintenance tonight', created_at: h.iso(-86400e3) }, voice: { configured: ['livekit', 'cillvoice'], default: 'livekit' } }

function adminRoutes(calls, { mfa = true } = {}) {
  return async (r, { pathname, method, body, url }) => {
    const json = (j, status = 200) => (r.fulfill({ status, json: j }), true)
    if (pathname === '/api/v9/users/@me') return json({ ...h.me, instance_admin: true, mfa_enabled: mfa })
    if (pathname === '/api/v9/instance') return json({ name: 'Cillhub', motd: null, registration_mode: 'open', gifs_enabled: true, max_upload_bytes: 25 * 1024 ** 2, announcement: null })
    if (!pathname.startsWith('/api/v9/admin/')) return false
    const p = pathname.slice('/api/v9/admin'.length)
    calls.push({ method, path: p, body, query: Object.fromEntries(url.searchParams) })
    if (method === 'GET') {
      if (p === '/overview') return json(overview)
      if (p === '/users') return json(users.filter((u) => u.username.includes(url.searchParams.get('query') ?? '')))
      const um = p.match(/^\/users\/(\d+)$/)
      if (um) return json({ ...users.find((u) => u.id === um[1]), guilds: [{ id: '200', name: 'Nightfall Gaming', icon: null, owner: false }], applications: [{ id: '950', name: 'Bobbot' }],
        sessions: [{ id_hash: 'abc', created_at: h.iso(-7 * 86400e3), approx_last_used_time: h.iso(-60e3), client_info: { os: 'Windows', platform: 'Cillhub Web' } }],
        audit_log: [{ id: '1', admin_id: '100', action: 'user.logout', target_type: 'user', target_id: um[1], details: null, ip_hash: 'x', created_at: h.iso(-86400e3) }] })
      if (p === '/guilds') return json([guild])
      if (p === '/guilds/200') return json({ ...guild, settings: { verification_level: 0, features: ['COMMUNITY'] }, emoji_count: 1, sticker_count: 1,
        roles: [{ id: '200', name: '@everyone', position: 0 }, { id: '500', name: 'Staff', position: 1 }],
        channels: [{ id: '300', name: 'general', type: 0, parent_id: null, position: 0, nsfw: false }, { id: '302', name: 'Lounge', type: 2, parent_id: null, position: 1, nsfw: false }],
        invites: [{ code: 'cill', channel_id: '300', inviter_id: '100', uses: 4, max_uses: 0, created_at: h.iso(), expires_at: null }], bans: [{ user: h.user('103', 'troll'), reason: 'spam' }],
        audit_log: [{ id: '1', user_id: '100', target_id: '101', action_type: 22, changes: null, options: null, reason: 'spam' }] })
      if (p === '/reports') return json(url.searchParams.get('status') === 'resolved'
        ? [report('8002', { status: 'resolved', actions: [{ action: 'ban', admin_id: '100', at: h.iso(), note: null }] })]
        : [report('8001'), report('8003', { guild: null, author: h.bob, channel: { id: '330' }, message: { id: '431', content: 'dm spam', timestamp: h.iso(), exists: false }, link: '/channels/@me/330/431' })])
      if (p === '/settings') return json(settings)
      if (p === '/registration-codes') return json([{ code: 'WELCOME123', created_by: '100', created_at: h.iso(), expires_at: null, max_uses: 1, uses: 0, note: null }])
      if (p === '/audit-log') return json([{ id: '7', admin_id: '100', action: 'user.disable', target_type: 'user', target_id: '102', details: { sessions_closed: 2 }, ip_hash: 'x', created_at: h.iso() }])
    }
    if (p === '/settings' && method === 'PATCH') return json((settings = { ...settings, ...body }))
    if (p === '/registration-codes' && method === 'POST') return json({ code: 'NEWCODE234', created_by: '100', created_at: h.iso(), expires_at: null, max_uses: body.max_uses, uses: 0, note: null }, 201)
    if (p === '/announcements' && method === 'POST') return json({ announcement: { id: '2', content: body.content, created_at: h.iso() }, dm_count: 3 }, 201)
    if (/^\/reports\/\d+\/resolve$/.test(p)) return json(report(p.split('/')[2], { status: 'resolved', actions: [{ action: body.action, admin_id: '100', at: h.iso(), note: null }] }))
    if (/^\/users\/\d+(\/[a-z-]+)?$/.test(p) && method === 'POST') return json(users.find((u) => u.id === p.split('/')[2]))
    if (/^\/guilds\/200\/(transfer|invites-disabled)$/.test(p)) return json(guild)
    return r.fulfill({ status: 204 }), true
  }
}

/** Clicks and returns the admin call it triggered (method + path). */
async function call(calls, method, p, act) {
  const before = calls.length
  await act()
  for (let i = 0; i < 50; i++) {
    const c = calls.slice(before).find((x) => x.method === method && x.path === p)
    if (c) return c
    await new Promise((res) => setTimeout(res, 50))
  }
  throw new Error(`expected ${method} /admin${p}; got ${JSON.stringify(calls.slice(before))}`)
}

async function run(browser, errors) {
  // 1. A non-admin: no menu entry, /admin redirects without any admin request.
  {
    const adminRequests = []
    const { page, ctx } = await h.open(browser, { errors, routes: async (r, { pathname }) => {
      if (pathname === '/api/v9/users/@me') return r.fulfill({ json: h.me }), true
      return pathname.startsWith('/api/v9/admin') ? (adminRequests.push(pathname), r.fulfill({ status: 403, json: { code: 50013, message: 'Missing Access' } }), true) : false
    } })
    await page.getByRole('button', { name: /^Set status/ }).click()
    await page.getByRole('menuitem', { name: 'Set Custom Status' }).waitFor()
    assert.equal(await page.getByRole('menuitem', { name: 'Admin Dashboard' }).count(), 0, 'no admin entry for non-admins')
    await page.keyboard.press('Escape')
    await page.goto(`${h.ORIGIN}/admin/users`)
    await page.waitForURL('**/channels/@me')
    assert.deepEqual(adminRequests, [], 'a non-admin visiting /admin makes no admin request')
    console.log('ok v6-admin 1 - non-admin: no menu entry, /admin redirects, no admin requests')
    await ctx.close()
  }

  // 2. Admin without 2FA: explanation screen, button to the security settings, no admin request.
  {
    const calls = []
    const { page, ctx } = await h.open(browser, { errors, routes: adminRoutes(calls, { mfa: false }), ready: (d) => ({ ...d, user: { ...d.user, instance_admin: true, mfa_enabled: false } }) })
    await page.getByRole('button', { name: /^Set status/ }).click()
    await page.getByRole('menuitem', { name: 'Admin Dashboard' }).click()
    await page.getByRole('heading', { name: 'Two-factor authentication required' }).waitFor()
    assert.deepEqual(calls, [], 'no admin route is called without 2FA')
    await page.screenshot({ path: shot('2fa') })
    await page.getByRole('button', { name: 'Open Security Settings' }).click()
    await page.waitForURL('**/channels/@me')
    await page.locator('.app[data-gateway="ready"]').waitFor()
    await page.getByRole('heading', { name: 'My Account' }).first().waitFor()
    console.log('ok v6-admin 2 - admin without 2FA: explanation screen, opens security settings, no admin requests')
    await ctx.close()
  }

  // 3. Admin with 2FA: every page and its actions.
  const calls = []
  const { page, ctx, dispatch, posted } = await h.open(browser, { errors, routes: adminRoutes(calls), ready: (d) => ({ ...d, user: { ...d.user, instance_admin: true, mfa_enabled: true } }) })

  // Report a message from the context menu (any user).
  await page.locator('#msg-420').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Report Message' }).click()
  const rd = page.getByRole('dialog', { name: 'Report Message' })
  await rd.getByRole('button', { name: 'Report' }).click()
  await rd.getByText('Choose a reason.').waitFor()
  await rd.getByLabel('Harassment or bullying').check()
  await rd.getByLabel('Note (optional)').fill('insults')
  await rd.getByRole('button', { name: 'Report' }).click()
  await page.getByText('Thanks. The instance admins will review this message.').waitFor()
  assert.deepEqual(posted.find((x) => x.pathname === '/api/v9/channels/300/messages/420/report').body, { reason: 'harassment', note: 'insults' })
  console.log('ok v6-admin 3 - Report Message: reason required, POST /channels/:id/messages/:mid/report { reason, note }')

  // Announcement banner from the gateway, dismissible.
  dispatch('INSTANCE_ANNOUNCEMENT', { id: '55', content: 'Server maintenance at 22:00', created_at: h.iso() })
  const banner = page.locator('.instance-banner')
  await banner.getByText('Server maintenance at 22:00').waitFor()
  await banner.getByRole('button', { name: 'Dismiss' }).click()
  await banner.waitFor({ state: 'hidden' })
  console.log('ok v6-admin 4 - INSTANCE_ANNOUNCEMENT shows a dismissible banner')

  // Overview.
  await page.getByRole('button', { name: /^Set status/ }).click()
  await page.getByRole('menuitem', { name: 'Admin Dashboard' }).click()
  await page.getByRole('heading', { name: 'Overview', level: 1 }).waitFor()
  await page.waitForURL('**/admin/overview')
  const tiles = page.getByRole('list', { name: 'Instance statistics' })
  await tiles.getByText('128').waitFor()
  assert.equal(await page.locator('.chart-bar').count(), days.filter((d) => d.count).length, 'one bar per day with messages')
  await page.getByText('LiveKit: OK').waitFor()
  await page.getByText('cillvoice: Down').waitFor()
  await tiles.getByText('48,211').waitFor()
  await page.getByText('unfurl timeout for example.com').waitFor()
  await page.locator('.chart-hit').nth(5).hover()
  await page.locator('.chart-tip').waitFor()
  await page.getByText('Show as table').click()
  assert.equal(await page.getByRole('table', { name: 'Messages per day' }).locator('tbody tr').count(), 14)
  await page.screenshot({ path: shot('overview'), fullPage: true })
  console.log('ok v6-admin 5 - overview: tiles, SVG bar chart with tooltip, table view, health, errors')

  // Users: search, drawer, actions.
  const nav = page.getByRole('navigation', { name: 'Admin dashboard' })
  await nav.getByRole('link', { name: 'Users' }).click()
  const table = page.getByRole('table', { name: 'Users' })
  await table.getByRole('button', { name: 'bob' }).waitFor()
  assert.equal(await table.locator('thead th').count(), 9)
  await page.getByRole('searchbox').fill('car')
  await table.getByRole('button', { name: 'bob' }).waitFor({ state: 'detached' })
  assert.equal(calls.filter((c) => c.path === '/users').at(-1).query.query, 'car')
  await page.getByRole('searchbox').fill('')
  await table.getByRole('button', { name: 'bob' }).click()
  const drawer = page.getByRole('dialog', { name: 'User bob' })
  await drawer.getByText('Windows · Cillhub Web').waitFor()
  await drawer.getByText('Bobbot').waitFor()
  await drawer.getByRole('button', { name: 'Disable Account' }).click()
  await call(calls, 'POST', '/users/101/disable', () => page.getByRole('dialog', { name: 'Disable bob?' }).getByRole('button', { name: 'Disable Account' }).click())
  await drawer.getByRole('button', { name: 'Force Logout' }).click()
  await call(calls, 'POST', '/users/101/logout', () => page.getByRole('dialog', { name: 'Log out everywhere?' }).getByRole('button', { name: 'Log Out Everywhere' }).click())
  await drawer.getByRole('button', { name: 'Require Password Change' }).click()
  assert.deepEqual((await call(calls, 'POST', '/users/101/require-password-change', () => page.getByRole('dialog', { name: 'Require a new password?' }).getByRole('button', { name: 'Require Password Change' }).click())).body, { required: true })
  await drawer.getByRole('button', { name: 'Delete Account' }).click()
  const typed = page.getByRole('dialog', { name: 'Delete bob?' })
  await typed.getByLabel('Type the username to confirm').fill('bob')
  await typed.getByRole('button', { name: 'Continue' }).click()
  const code = page.getByRole('dialog', { name: 'Delete bob?' })
  await code.getByLabel('Authentication or backup code').fill('123 456')
  assert.deepEqual((await call(calls, 'DELETE', '/users/101', () => code.getByRole('button', { name: 'Delete Account' }).click())).body, { confirm: 'bob', code: '123456' })
  await drawer.waitFor({ state: 'detached' })
  await table.getByRole('button', { name: 'ciller' }).click()
  await page.getByRole('dialog', { name: 'User ciller' }).getByText('Admin actions are not available for instance administrators.', { exact: false }).waitFor()
  await page.keyboard.press('Escape')
  console.log('ok v6-admin 6 - users: table with headers, search, drawer with sessions, disable/logout/password/delete call the right endpoints')

  // Servers.
  await nav.getByRole('link', { name: 'Servers' }).click()
  await page.getByRole('table', { name: 'Servers' }).getByRole('button', { name: 'Nightfall Gaming' }).click()
  const sd = page.getByRole('dialog', { name: 'Server Nightfall Gaming' })
  await sd.getByText('troll · spam').waitFor()
  await sd.getByText('banned', { exact: false }).waitFor()
  await sd.getByRole('button', { name: 'Disable Invites' }).click()
  assert.deepEqual((await call(calls, 'PUT', '/guilds/200/invites-disabled', () => page.getByRole('dialog', { name: 'Disable invites?' }).getByRole('button', { name: 'Disable Invites' }).click())).body, { disabled: true })
  await sd.getByRole('button', { name: 'Transfer Ownership' }).click()
  const tr = page.getByRole('dialog', { name: 'Transfer Ownership' })
  await tr.getByLabel('User ID of the new owner').fill('101')
  await tr.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('dialog', { name: 'Transfer Ownership' }).getByLabel('Authentication or backup code').fill('654321')
  assert.deepEqual((await call(calls, 'POST', '/guilds/200/transfer', () => page.getByRole('dialog', { name: 'Transfer Ownership' }).getByRole('button', { name: 'Transfer Ownership' }).click())).body, { owner_id: '101', code: '654321' })
  await sd.getByRole('button', { name: 'Delete Server' }).click()
  let del = page.getByRole('dialog', { name: 'Delete Nightfall Gaming?' })
  await del.getByLabel('Type the server name to confirm').fill('Nightfall')
  await del.getByRole('button', { name: 'Continue' }).click()
  await page.getByText('The name did not match. Nothing was deleted.').waitFor()
  assert.ok(!calls.some((c) => c.method === 'DELETE' && c.path === '/guilds/200'), 'a wrong name deletes nothing')
  await sd.getByRole('button', { name: 'Delete Server' }).click()
  del = page.getByRole('dialog', { name: 'Delete Nightfall Gaming?' })
  await del.getByLabel('Type the server name to confirm').fill('Nightfall Gaming')
  await del.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('dialog', { name: 'Delete Nightfall Gaming?' }).getByLabel('Authentication or backup code').fill('111222')
  assert.deepEqual((await call(calls, 'DELETE', '/guilds/200', () => page.getByRole('dialog', { name: 'Delete Nightfall Gaming?' }).getByRole('button', { name: 'Delete Server' }).click())).body, { confirm: 'Nightfall Gaming', code: '111222' })
  console.log('ok v6-admin 7 - servers: detail (roles, channels, invites, bans, audit log), disable invites, transfer, delete only with the typed name')

  // Reports.
  await nav.getByRole('link', { name: 'Reports' }).click()
  const card = page.locator('.admin-report').first()
  await card.getByText('you are all <b>bad</b>').waitFor() // plain text, not HTML
  assert.equal(await card.getByRole('link', { name: 'Open in context' }).getAttribute('href'), '/channels/200/300/420')
  const dmCard = page.locator('.admin-report').nth(1)
  await dmCard.getByText('dm spam').waitFor()
  assert.equal(await dmCard.getByRole('button', { name: 'Ban Author' }).count(), 0, 'no server actions for a DM')
  assert.equal(await dmCard.getByRole('link', { name: 'Open in context' }).count(), 0, 'no link to a deleted message')
  assert.deepEqual((await call(calls, 'POST', '/reports/8001/resolve', () => card.getByRole('button', { name: 'Dismiss' }).click())).body, { action: 'dismiss' })
  await card.getByRole('button', { name: 'Timeout Author' }).click()
  const to = page.getByRole('dialog', { name: 'Timeout bob' })
  assert.deepEqual((await call(calls, 'POST', '/reports/8001/resolve', () => to.getByRole('button', { name: 'Timeout' }).click())).body, { action: 'timeout', duration_seconds: 3600 })
  await card.getByRole('button', { name: 'Ban Author' }).click()
  assert.deepEqual((await call(calls, 'POST', '/reports/8001/resolve', () => page.getByRole('dialog', { name: 'Ban bob?' }).getByRole('button', { name: 'Ban' }).click())).body, { action: 'ban' })
  await page.getByRole('button', { name: 'Resolved' }).click()
  await page.getByRole('listitem').filter({ hasText: /^Author banned · / }).first().waitFor() // the list entry, not the toast with the same words
  console.log('ok v6-admin 8 - reports: reported content as plain text, context link, dismiss/timeout/ban resolve with the right action')

  // Instance settings + registration codes.
  await nav.getByRole('link', { name: 'Instance Settings' }).click()
  await page.getByLabel('Instance name').waitFor()
  await page.getByLabel('Invite-only', { exact: true }).check()
  await page.getByLabel('Message of the day').fill('Welcome to Nightfall!')
  await page.getByLabel('Maximum upload size (MB)').fill('50')
  await page.getByLabel('Enable the GIF picker').uncheck()
  await page.getByLabel('Voice backend for new calls').selectOption('cillvoice')
  const patch = await call(calls, 'PATCH', '/settings', () => page.getByRole('button', { name: 'Save Changes' }).click())
  assert.deepEqual(patch.body, { instance_name: 'Cillhub', motd: 'Welcome to Nightfall!', registration_mode: 'invite', max_upload_bytes: 50 * 1024 ** 2, gifs_enabled: false, voice_backend: 'cillvoice' })
  await page.getByRole('table', { name: 'Registration codes' }).getByText('WELCOME123').waitFor()
  assert.deepEqual((await call(calls, 'POST', '/registration-codes', () => page.getByRole('button', { name: 'Create Code' }).click())).body, { max_uses: 1, max_age: 7 * 86400 })
  await page.getByRole('button', { name: 'Revoke WELCOME123' }).click()
  await call(calls, 'DELETE', '/registration-codes/WELCOME123', () => page.getByRole('dialog', { name: 'Revoke code?' }).getByRole('button', { name: 'Revoke' }).click())
  console.log('ok v6-admin 9 - instance settings PATCH body, registration codes create/revoke')

  // Announcements.
  await nav.getByRole('link', { name: 'Announcements' }).click()
  await page.getByText('Maintenance tonight').waitFor()
  await page.getByRole('button', { name: 'Remove Announcement' }).click()
  await call(calls, 'DELETE', '/announcements', () => page.getByRole('dialog', { name: 'Remove the announcement?' }).getByRole('button', { name: 'Remove' }).click())
  await page.getByRole('textbox', { name: 'New announcement' }).fill('New season starts Friday')
  await page.getByLabel('Also send it as a DM from Cillhub System').check()
  await page.getByRole('button', { name: 'Send Announcement' }).click()
  assert.deepEqual((await call(calls, 'POST', '/announcements', () => page.getByRole('dialog', { name: 'Send announcement?' }).getByRole('button', { name: 'Send' }).click())).body, { content: 'New season starts Friday', dm: true })
    await page.getByText('Announcement sent, 3 DMs.').waitFor()
  console.log('ok v6-admin 10 - announcements: clear (DELETE), send POST /admin/announcements { content, dm }')

  // Audit log with a filter.
  await nav.getByRole('link', { name: 'Admin Audit Log' }).click()
  await page.getByRole('table', { name: 'Admin Audit Log' }).getByText('user.disable').waitFor()
  await page.getByLabel('Action', { exact: true }).fill('user.')
  await page.getByLabel('Admin (user ID)').fill('100')
  const al = await call(calls, 'GET', '/audit-log', () => page.getByRole('button', { name: 'Filter' }).click())
  assert.deepEqual([al.query.action, al.query.admin_id], ['user.', '100'])
  console.log('ok v6-admin 11 - admin audit log: table, filter by action')

  // Light theme, German, keyboard: Tab reaches the nav and Enter opens a page.
  await page.evaluate(() => (localStorage.setItem('user-settings', JSON.stringify({ theme: 'light' })), localStorage.setItem('locale', 'de')))
  await page.goto(`${h.ORIGIN}/admin/overview`)
  await page.getByRole('heading', { name: 'Nachrichten pro Tag' }).waitFor()
  await page.getByRole('navigation', { name: 'Admin-Dashboard' }).getByRole('link', { name: 'Meldungen' }).waitFor()
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light')
  await page.screenshot({ path: shot('light-de'), fullPage: true })
  await page.getByRole('link', { name: 'Benutzer' }).focus()
  await page.keyboard.press('Enter')
  await page.getByRole('table', { name: 'Benutzer' }).waitFor()
  await page.evaluate(() => (localStorage.removeItem('user-settings'), localStorage.setItem('locale', 'en-US')))
  console.log('ok v6-admin 12 - light theme + German, keyboard navigation')

  // The server refusing with 60003 (2FA required) switches to the explanation screen.
  await page.route('**/api/v9/admin/overview', (r) => r.fulfill({ status: 403, json: { code: 60003, message: 'Two factor is required for this operation' } }))
  await page.goto(`${h.ORIGIN}/admin/overview`)
  await page.getByRole('heading', { name: 'Two-factor authentication required' }).waitFor()
  console.log('ok v6-admin 13 - a 60003 answer shows the 2FA screen')
  await ctx.close()

  // Login page MOTD, register page with a registration code (invite-only).
  const lc = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' })
  const lp = await lc.newPage()
  lp.on('pageerror', (e) => errors.push(e.message))
  let registered
  await lp.route('**/api/v9/**', (r) => {
    const { pathname } = new URL(r.request().url())
    if (pathname === '/api/v9/instance') return r.fulfill({ json: { name: 'Cillhub', motd: 'Scrims every Friday at 20:00', registration_mode: 'invite', announcement: null } })
    if (pathname === '/api/v9/auth/register') return (registered = r.request().postDataJSON()), r.fulfill({ status: 400, json: { code: 50035, message: 'Invalid Form Body', errors: { registration_code: { _errors: [{ code: 'INVALID', message: 'Unknown registration code.' }] } } } })
    r.abort()
  })
  await lp.goto(`${h.ORIGIN}/login`)
  await lp.getByRole('note', { name: 'Message of the day' }).getByText('Scrims every Friday at 20:00').waitFor()
  await lp.getByRole('link', { name: 'Register' }).click()
  await lp.getByLabel('Email').fill('new@example.com')
  await lp.getByLabel('Username').fill('newbie')
  await lp.getByLabel('Password').fill('hunter2hunter2')
  await lp.getByLabel('Registration code').fill('WELCOME1')
  await lp.getByRole('button', { name: 'Continue' }).click()
  await lp.getByText('Unknown registration code.').waitFor()
  assert.equal(registered.registration_code, 'WELCOME1')
  await lc.close()
  console.log('ok v6-admin 14 - login shows the MOTD; invite-only register sends registration_code and shows its error')

  // An admin required a password change: login answers required_actions, the new password goes to PATCH /users/@me.
  const pc = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' })
  const pp = await pc.newPage()
  pp.on('pageerror', (e) => errors.push(e.message))
  let patched
  await pp.route('**/api/v9/**', (r) => {
    const { pathname } = new URL(r.request().url())
    if (pathname === '/api/v9/instance') return r.fulfill({ json: { name: 'Cillhub', motd: null, registration_mode: 'open', announcement: null } })
    if (pathname === '/api/v9/auth/login') return r.fulfill({ json: { token: 'restricted-token', user_settings: {}, required_actions: ['update_password'] } })
    if (pathname === '/api/v9/users/@me' && r.request().method() === 'PATCH')
      return (patched = { auth: r.request().headers().authorization, body: r.request().postDataJSON() }), r.fulfill({ json: { ...h.me, token: 'fresh-token' } })
    r.abort()
  })
  await pp.goto(`${h.ORIGIN}/login`)
  await pp.getByLabel('Email or username').fill('bob')
  await pp.getByLabel('Password').fill('oldpassword')
  await pp.getByRole('button', { name: 'Log In' }).click()
  await pp.getByRole('heading', { name: 'Choose a new password' }).waitFor()
  await pp.getByLabel('Current Password').fill('oldpassword')
  await pp.getByLabel('New Password', { exact: true }).fill('newpassword1')
  await pp.getByLabel('Confirm New Password').fill('newpassword1')
  await pp.getByRole('button', { name: 'Change Password' }).click()
  await pp.waitForURL('**/channels/@me')
  assert.deepEqual(patched, { auth: 'restricted-token', body: { password: 'oldpassword', new_password: 'newpassword1' } })
  assert.equal(await pp.evaluate(() => localStorage.getItem('token')), 'fresh-token')
  await pc.close()
  console.log('ok v6-admin 15 - required password change after login: PATCH /users/@me, then the app')
}

module.exports = { run }
