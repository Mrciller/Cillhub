// v4 smoke (fake API + gateway from smoke-v3-harness): group DMs, incoming call and call view, blocking, profiles and notes,
// custom status, notification settings, inbox, slash commands, ephemeral messages, components and modals, quick switcher,
// guild folders, 2FA, MFA login, developer portal, light theme and German UI. Saves smoke-v4-*.png (1440×900).
const assert = require('node:assert/strict')
const path = require('node:path')
const h = require('./smoke-v3-harness.cjs')

const shot = (name) => path.join(h.root, `smoke-v4-${name}.png`)
const eve = h.user('103', 'eve')
const dicey = h.user('900', 'Dicey', { bot: true })
const dm = { id: '800', type: 1, recipients: [h.bob], last_message_id: '850' }
const group = { id: '810', type: 3, recipients: [h.bob, h.carol], owner_id: '100', name: null, icon: null, last_message_id: null }
const app = { id: '900', name: 'Dicey', description: 'Rolls dice', icon: null, flags: 0, bot: dicey, verify_key: 'ab'.repeat(32) }
const index = {
  applications: [{ id: '900', name: 'Dicey', description: 'Rolls dice', icon: null, bot_id: '900' }],
  application_commands: [
    { id: '901', application_id: '900', version: '1', type: 1, name: 'roll', description: 'Roll a die', options: [
      { type: 4, name: 'sides', description: 'How many sides', required: true, min_value: 2, max_value: 100 },
      { type: 3, name: 'label', description: 'What for', choices: [{ name: 'Initiative', value: 'init' }, { name: 'Damage', value: 'dmg' }] },
    ] },
    { id: '902', application_id: '900', version: '1', type: 3, name: 'Reroll this' },
  ],
}
const msg = (id, author, content, extra = {}) => ({ ...h.base(), id, type: 0, author, content, timestamp: h.iso(), ...extra })

async function main(browser, errors) {
  const interactions = []
  const mentionQueries = []
  const routes = async (r, { pathname, method, body, url }) => {
    const json = (j, status = 200) => (r.fulfill({ status, json: j }), true)
    if (pathname.endsWith('/users/@me/channels') && method === 'POST') return json(group)
    if (pathname.endsWith('/users/101/profile')) return json({ user: { ...h.bob, bio: 'Entry fragger. **IGL** on Sundays.', banner: 'abc', accent_color: 0xeb459e }, user_profile: { bio: 'Entry fragger. **IGL** on Sundays.', pronouns: 'he/him', banner: 'abc', accent_color: 0xeb459e }, mutual_guilds: [{ id: h.G, nick: null }], mutual_friends_count: 1, mutual_friends: [h.carol] })
    if (pathname.endsWith('/users/@me/notes/101')) return method === 'GET' ? json({ note: '' }) : (r.fulfill({ status: 204 }), true)
    if (pathname.endsWith('/users/@me/settings')) return method === 'PATCH' ? json(body) : json({ status: 'online' })
    if (/\/users\/@me\/guilds\/\d+\/settings$/.test(pathname)) return json({ guild_id: pathname.split('/')[5], message_notifications: 0, suppress_everyone: false, suppress_roles: false, mobile_push: true, hide_muted_channels: false, channel_overrides: [], ...body })
    if (pathname.endsWith('/users/@me/mentions')) return mentionQueries.push(url.searchParams), json([msg('460', h.bob, 'gg <@100>, nice clutch!', { mentions: [h.me] })])
    if (pathname.endsWith('/application-command-index')) return json(index)
    if (pathname.endsWith('/interactions') && method === 'POST') return interactions.push(body), r.fulfill({ status: 204 }), true
    if (pathname.endsWith('/users/@me/mfa/totp/enable')) return json({ token: 'smoke-token-2', backup_codes: Array.from({ length: 10 }, (_, i) => ({ code: `abcd${1000 + i}`, consumed: false })) })
    return false
  }
  const ready = (d) => ({
    ...d, users: [...d.users, eve, dicey], private_channels: [dm],
    relationships: [{ id: '101', type: 1, user: h.bob }, { id: '102', type: 1, user: h.carol }, { id: '103', type: 2, user: eve }],
    user_guild_settings: { entries: [], partial: false, version: 1 },
  })
  const { page, ctx, ops, posted, dispatch } = await h.open(browser, { routes, errors, ready, livekit: true, url: '/channels/@me' })
  const app$ = page.locator('.app')

  // 1. Group DM from friends.
  await page.getByRole('button', { name: 'Create DM' }).click()
  const pick = page.getByRole('dialog', { name: 'Select Friends' })
  await pick.getByRole('checkbox').nth(0).check()
  await pick.getByRole('checkbox').nth(1).check()
  await pick.getByRole('button', { name: 'Create Group DM' }).click()
  await page.waitForURL('**/channels/@me/810')
  assert.deepEqual(posted.find((p) => p.pathname.endsWith('/users/@me/channels')).body, { recipients: ['101', '102'] })
  await page.getByRole('button', { name: /bob, carol, edit group name/ }).waitFor()
  await page.getByRole('complementary', { name: 'Members' }).getByText('carol').waitFor()
  console.log('ok v4 1 - group DM created from two friends (POST /users/@me/channels {recipients}); header and member list')

  // 2. Incoming call: ringing popup with Decline (stop-ringing) and Accept (joins the DM call, call view).
  const voice = (u, extra = {}) => ({ guild_id: null, channel_id: '800', user_id: u.id, session_id: 'b', self_mute: false, self_deaf: false, self_video: false, self_stream: false, mute: false, deaf: false, ...extra })
  dispatch('CALL_CREATE', { channel_id: '800', message_id: '851', region: 'local', ringing: ['100'], voice_states: [voice(h.bob)] })
  const ring = page.getByRole('alertdialog', { name: 'bob' })
  await ring.getByText('Incoming Call…').waitFor()
  await ring.getByRole('button', { name: 'Decline' }).click()
  await ring.waitFor({ state: 'detached' })
  assert.ok(posted.some((p) => p.pathname.endsWith('/channels/800/call/stop-ringing')))
  dispatch('CALL_UPDATE', { channel_id: '800', message_id: '851', region: 'local', ringing: ['100'] })
  await ring.getByRole('button', { name: 'Accept' }).click()
  await page.waitForURL('**/channels/@me/800')
  const join = ops.findLast((f) => f.op === 4)
  assert.equal(join.d.guild_id, null)
  assert.equal(join.d.channel_id, '800')
  const call = page.getByRole('region', { name: 'Call' })
  await call.getByRole('list', { name: 'Participants' }).getByText('bob').waitFor()
  await call.getByRole('button', { name: 'Leave Call' }).waitFor()
  await page.getByRole('region', { name: 'Voice connection' }).getByText('Voice Connected').waitFor()
  await page.screenshot({ path: shot('call') })
  await call.getByRole('button', { name: 'Leave Call' }).click()
  assert.equal(ops.findLast((f) => f.op === 4).d.channel_id, null)
  console.log('ok v4 2 - incoming call rings (Decline → stop-ringing, Accept → op 4 guild_id null), call view with the voice grid')

  // 3. Blocked user's message collapses.
  await page.goto(`${h.ORIGIN}/channels/${h.G}/300`)
  await app$.and(page.locator('[data-gateway="ready"]')).waitFor()
  dispatch('MESSAGE_CREATE', msg('470', eve, 'you cannot see me'))
  const log = page.getByRole('log', { name: 'Messages in #general' })
  await log.getByText('Blocked message').waitFor()
  assert.equal(await log.getByText('you cannot see me').count(), 0)
  await log.getByRole('button', { name: 'Show message' }).click()
  await log.getByText('you cannot see me').waitFor()
  console.log('ok v4 3 - blocked message collapsed with a reveal')

  // 4. Full profile modal: banner, bio, pronouns, mutuals, note saved on blur.
  await page.getByRole('complementary', { name: 'Members' }).getByRole('button', { name: /bob/ }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Profile' }).click()
  const profile = page.getByRole('dialog', { name: 'bob' })
  await profile.getByText('he/him').waitFor()
  await profile.locator('strong', { hasText: 'IGL' }).waitFor()
  assert.match(await profile.locator('.pcard-banner').getAttribute('style'), /\/banners\/101\/abc/)
  await profile.getByRole('tab', { name: /Mutual Servers/ }).waitFor()
  await profile.getByRole('textbox', { name: 'Note' }).fill('Plays AWP')
  await page.screenshot({ path: shot('profile') })
  await profile.getByRole('textbox', { name: 'Note' }).blur()
  await page.waitForTimeout(100)
  assert.deepEqual(posted.find((p) => p.pathname.endsWith('/users/@me/notes/101') && p.method === 'PUT').body, { note: 'Plays AWP' })
  await page.keyboard.press('Escape')
  console.log('ok v4 4 - profile modal with banner, bio, pronouns, mutuals; note saved with PUT')

  // 5. Custom status: settings PATCH and op 3 with a type 4 activity.
  await page.getByRole('button', { name: /^Set status, currently/ }).click()
  await page.getByRole('menuitem', { name: 'Set Custom Status' }).click()
  const cs = page.getByRole('dialog', { name: 'Set a custom status' })
  await cs.getByRole('textbox').fill('Grinding ranked')
  await cs.getByRole('button', { name: 'Save' }).click()
  await page.getByRole('region', { name: 'Your account' }).getByText('Grinding ranked').waitFor()
  assert.equal(posted.findLast((p) => p.pathname.endsWith('/users/@me/settings')).body.custom_status.text, 'Grinding ranked')
  const presence = ops.findLast((f) => f.op === 3)
  assert.equal(presence.d.activities[0].type, 4)
  assert.equal(presence.d.activities[0].state, 'Grinding ranked')
  console.log('ok v4 5 - custom status saved in settings and sent as a type 4 activity')

  // 6. Muting a server removes its unread pill (mentions still badge).
  const rail = page.getByRole('navigation', { name: /^(Servers|Server)$/ })
  const lounge = rail.getByRole('link', { name: /^Rules Lounge/ })
  assert.match(await lounge.getAttribute('aria-label'), /unread/)
  await lounge.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'For 1 Hour' }).click()
  await page.waitForFunction(() => !document.querySelector('a[aria-label^="Rules Lounge"]').getAttribute('aria-label').includes('unread'))
  const mute = posted.find((p) => p.pathname.endsWith(`/users/@me/guilds/${h.G2}/settings`)).body
  assert.equal(mute.muted, true)
  assert.equal(mute.mute_config.selected_time_window, 3600)
  console.log('ok v4 6 - Mute Server (1 hour) sends user guild settings and hides the unread pill')

  // 7. Inbox: mentions with filters.
  await page.getByRole('button', { name: 'Inbox' }).click()
  const inbox = page.getByRole('dialog', { name: 'Inbox' })
  await inbox.getByText('nice clutch!').waitFor()
  await page.screenshot({ path: shot('inbox') })
  await inbox.getByRole('checkbox', { name: 'Include role mentions' }).uncheck()
  await inbox.getByText('nice clutch!').waitFor()
  assert.ok(mentionQueries.some((q) => q.get('roles') === 'false' && q.get('everyone') === 'true'), 'filters go to GET /users/@me/mentions')
  await inbox.getByRole('tab', { name: 'Unreads' }).click()
  await inbox.getByRole('button', { name: 'Mark All as Read' }).waitFor()
  await page.keyboard.press('Escape')
  console.log('ok v4 7 - inbox mentions (filters) and unreads tab')

  // 8. Slash command picker with options → POST /interactions (type 2); "Sending command…" until INTERACTION_SUCCESS.
  const box = page.getByRole('textbox', { name: 'Message #general' })
  await box.fill('/ro')
  const picker = page.getByRole('listbox', { name: 'Commands' })
  await picker.getByRole('option', { name: /\/roll/ }).waitFor()
  await page.screenshot({ path: shot('slash') })
  await box.press('Enter')
  const form = page.getByRole('group', { name: 'Command /roll' })
  await form.getByRole('spinbutton', { name: 'sides' }).fill('20')
  await form.getByRole('button', { name: /label/ }).click()
  await form.getByRole('combobox', { name: /label/ }).selectOption('dmg')
  await form.getByRole('button', { name: 'Send' }).click()
  await page.getByText('Sending command…').waitFor()
  const cmd = interactions.find((i) => i.type === 2)
  assert.equal(cmd.application_id, '900')
  assert.equal(cmd.data.name, 'roll')
  assert.deepEqual(cmd.data.options, [{ type: 4, name: 'sides', value: 20 }, { type: 3, name: 'label', value: 'dmg' }])
  dispatch('INTERACTION_CREATE', { id: '990', nonce: cmd.nonce })
  dispatch('INTERACTION_SUCCESS', { id: '990', nonce: cmd.nonce })
  await page.getByText('Sending command…').waitFor({ state: 'detached' })
  console.log('ok v4 8 - slash command picker, required and optional options, POST /interactions type 2')

  // 9. Ephemeral answer: "Only you can see this" + Dismiss.
  const meta = { id: '990', type: 2, user: h.me, name: 'roll' }
  dispatch('MESSAGE_CREATE', msg('480', dicey, 'You rolled **17**', { flags: 64, application_id: '900', interaction_metadata: meta, webhook_id: '900' }))
  const eph = log.locator('#msg-480')
  await eph.getByText('Only you can see this').waitFor()
  await eph.getByText('used /roll').waitFor()
  await eph.getByRole('button', { name: 'Dismiss message' }).click()
  await eph.waitFor({ state: 'detached' })
  console.log('ok v4 9 - ephemeral message with "used /roll" line and Dismiss')

  // 10. Components: button and string select send MESSAGE_COMPONENT interactions; link buttons ask first.
  dispatch('MESSAGE_CREATE', msg('481', dicey, 'Roll again?', { application_id: '900', components: [
    { type: 1, components: [{ type: 2, style: 1, label: 'Reroll', custom_id: 'reroll' }, { type: 2, style: 5, label: 'Rules', url: 'https://example.com/rules' }] },
    { type: 1, components: [{ type: 3, custom_id: 'die', placeholder: 'Pick a die', options: [{ label: 'd6', value: '6' }, { label: 'd20', value: '20' }] }] },
  ] }))
  const comp = log.locator('#msg-481')
  await comp.locator('.bot-tag', { hasText: 'APP' }).waitFor()
  await comp.getByRole('button', { name: 'Reroll' }).click()
  await page.waitForTimeout(100)
  const click = interactions.find((i) => i.type === 3 && i.data.custom_id === 'reroll')
  assert.equal(click.message_id, '481')
  dispatch('INTERACTION_SUCCESS', { id: '991', nonce: click.nonce })
  await comp.getByRole('button', { name: 'Rules' }).click()
  await page.getByRole('dialog', { name: 'Leaving Cillhub' }).getByText('https://example.com/rules').waitFor()
  await page.getByRole('button', { name: 'Cancel' }).click()
  await comp.getByRole('button', { name: 'Pick a die' }).click()
  await page.getByRole('listbox', { name: 'Pick a die' }).getByRole('button', { name: 'd20' }).click()
  await page.waitForTimeout(100)
  assert.deepEqual(interactions.find((i) => i.data.custom_id === 'die').data.values, ['20'])
  console.log('ok v4 10 - button and select components send type 3 interactions; link button confirmation')

  // 11. Modal from the app: text input, submit sends MODAL_SUBMIT (type 5).
  dispatch('INTERACTION_MODAL_CREATE', { id: '992', channel_id: '300', custom_id: 'feedback', title: 'Feedback', application: { id: '900', name: 'Dicey' },
    components: [{ type: 1, components: [{ type: 4, custom_id: 'text', label: 'Your feedback', style: 2, required: true }] }] })
  const modal = page.getByRole('dialog', { name: 'Feedback' })
  await modal.getByLabel('Your feedback').fill('More dice please')
  await modal.getByRole('button', { name: 'Submit' }).click()
  await modal.waitFor({ state: 'detached' })
  const submit = interactions.find((i) => i.type === 5)
  assert.equal(submit.data.id, '992')
  assert.equal(submit.data.components[0].components[0].value, 'More dice please')
  console.log('ok v4 11 - application modal submits the text input (type 5)')

  // 12. Quick switcher (Ctrl+K), fuzzy.
  await page.keyboard.press('Control+k')
  const qs = page.getByRole('combobox', { name: 'Where would you like to go?' })
  await qs.fill('nws')
  await page.getByRole('option', { name: /news/ }).waitFor()
  await qs.press('Enter')
  await page.waitForURL(`**/channels/${h.G}/303`)
  console.log('ok v4 12 - quick switcher finds #news with a fuzzy query')

  // 13. 2FA: password, QR code and key, code → backup codes.
  await page.getByRole('button', { name: 'User Settings' }).click()
  await page.getByRole('button', { name: 'Enable Authenticator App' }).click()
  const twofa = page.getByRole('dialog', { name: 'Enable Two-Factor Auth' })
  await twofa.getByLabel('Password').fill('hunter2hunter2')
  await twofa.getByRole('button', { name: 'Continue' }).click()
  await twofa.getByRole('img', { name: 'QR code for your authenticator app' }).waitFor()
  const secret = (await twofa.getByLabel('2FA key').innerText()).replace(/\s/g, '')
  assert.match(secret, /^[A-Z2-7]{32}$/)
  await twofa.getByLabel('6-digit code').fill('123456')
  await twofa.getByRole('button', { name: 'Activate' }).click()
  await twofa.getByRole('list', { name: 'Backup codes' }).getByText('abcd-1000').waitFor()
  assert.deepEqual(posted.find((p) => p.pathname.endsWith('/mfa/totp/enable')).body, { password: 'hunter2hunter2', secret, code: '123456' })
  assert.equal(await page.evaluate(() => localStorage.getItem('token')), 'smoke-token-2')
  await twofa.getByRole('button', { name: 'Done' }).click()
  console.log('ok v4 13 - 2FA enable: QR code, manual key, code, backup codes, new token stored')

  // 14. Light theme and German UI, synced through PATCH /users/@me/settings.
  await page.getByRole('tab', { name: 'Appearance' }).click()
  await page.getByRole('radio', { name: 'Light', exact: true }).check() // exact: v6 adds "Arctic (light)" and similar
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light')
  assert.equal(posted.findLast((p) => p.pathname.endsWith('/users/@me/settings')).body.theme, 'light')
  await page.getByRole('button', { name: 'Close settings' }).click()
  await page.screenshot({ path: shot('light') })
  await page.getByRole('button', { name: 'User Settings' }).click()
  await page.getByRole('tab', { name: 'Language' }).click()
  await page.getByRole('radio', { name: 'Deutsch' }).check()
  await page.getByRole('tab', { name: 'Sprache', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Einstellungen schließen' }).or(page.getByRole('button', { name: 'Close settings' })).first().click()
  await page.getByRole('button', { name: 'Benutzereinstellungen' }).waitFor()
  await page.getByRole('link', { name: 'Direktnachrichten' }).waitFor()
  await page.getByRole('textbox', { name: 'Nachricht an #news' }).or(page.getByRole('textbox', { name: /#news/ })).first().waitFor()
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'de')
  console.log('ok v4 14 - light theme and German UI strings')

  // 15. Guild folder: drop one server onto another.
  const g2 = rail.getByRole('link', { name: /^Rules Lounge/ })
  await g2.dragTo(rail.getByRole('link', { name: /^Nightfall Gaming/ }))
  await rail.getByRole('button', { name: /^(Folder|Ordner) / }).waitFor()
  const folders = posted.findLast((p) => p.pathname.endsWith('/users/@me/settings') && p.body.guild_folders).body
  const folder = folders.guild_folders.find((f) => f.id !== null)
  assert.deepEqual(folder.guild_ids, [h.G, h.G2])
  assert.deepEqual(folders.guild_positions, [h.G, h.G2])
  console.log('ok v4 15 - dragging a server onto another creates a folder (guild_folders + guild_positions)')
  await ctx.close()
}

async function login(browser, errors) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(e.message))
  let attempts = 0
  const sent = []
  await page.route('**/api/v9/**', (r) => {
    const { pathname } = new URL(r.request().url())
    if (pathname.endsWith('/auth/login')) return ++attempts === 1 ? r.fulfill({ status: 429, json: { message: 'You are being rate limited.', retry_after: 2, global: false } }) : r.fulfill({ json: { user_id: '100', mfa: true, ticket: 'tkt', totp: true, backup: true } })
    if (pathname.endsWith('/auth/mfa/totp')) return sent.push(r.request().postDataJSON()), r.fulfill({ json: { token: 'mfa-token' } })
    r.abort()
  })
  await page.goto(`${h.ORIGIN}/login`)
  await page.getByLabel('Email or username').fill('ciller')
  await page.getByLabel('Password').fill('hunter2hunter2')
  await page.getByRole('button', { name: 'Log In' }).click()
  await page.getByText(/Too many attempts\. Try again in \d seconds\./).waitFor()
  await page.getByRole('button', { name: 'Log In' }).and(page.locator(':not([disabled])')).waitFor({ timeout: 5000 })
  await page.getByRole('button', { name: 'Log In' }).click()
  await page.getByRole('heading', { name: 'Multi-Factor Authentication' }).waitFor()
  await page.getByRole('button', { name: 'Use a backup code' }).click()
  await page.getByLabel('Backup code').fill('abcd-1234')
  await page.getByRole('button', { name: 'Log In' }).click()
  await page.waitForURL('**/channels/@me')
  assert.deepEqual(sent[0], { code: 'abcd1234', ticket: 'tkt' })
  assert.equal(await page.evaluate(() => localStorage.getItem('token')), 'mfa-token')
  console.log('ok v4 16 - login: rate limit countdown, then the MFA step with a backup code via /auth/mfa/totp')
  await ctx.close()
}

async function portal(browser, errors) {
  const routes = async (r, { pathname, method, body }) => {
    const json = (j) => (r.fulfill({ json: j }), true)
    if (pathname.endsWith('/applications') && method === 'GET') return json([app])
    if (pathname.endsWith('/applications/900/bot/reset')) return json({ token: 'OTAw.bot.smoke-secret' })
    if (pathname.endsWith('/applications/900') && method === 'PATCH') return json({ ...app, ...body })
    return false
  }
  const { page, posted, ctx } = await h.open(browser, { routes, errors })
  await page.goto(`${h.ORIGIN}/developers/applications`)
  await page.getByRole('main', { name: 'Developer Portal' }).getByRole('link', { name: 'Dicey' }).click()
  await page.getByRole('navigation', { name: 'Developer Portal' }).getByRole('link', { name: 'Bot' }).click()
  await page.getByRole('button', { name: 'Reset Token' }).click()
  await page.getByRole('dialog', { name: 'Reset Bot Token?' }).getByRole('button', { name: 'Yes, do it!' }).click()
  await page.getByLabel('Bot token').getByText('OTAw.bot.smoke-secret').waitFor()
  // The switch is controlled by the saved application, so it flips once the PATCH answers.
  await page.getByRole('switch', { name: 'Message Content Intent' }).click()
  await page.locator('#intent-524288:checked').waitFor()
  assert.equal(posted.find((p) => p.method === 'PATCH' && p.pathname.endsWith('/applications/900')).body.flags, 1 << 19)
  await page.screenshot({ path: shot('developer-portal') })
  await page.getByRole('link', { name: 'OAuth2' }).click()
  assert.match(await page.getByLabel('Generated URL').inputValue(), /\/oauth2\/authorize\?client_id=900&scope=bot%20applications.commands&permissions=0/)
  console.log('ok v4 17 - developer portal: token reset shown once, privileged intent toggle, OAuth2 URL')
  await ctx.close()
}

async function run(browser, errors) {
  await main(browser, errors)
  await login(browser, errors)
  await portal(browser, errors)
}
module.exports = { run }
