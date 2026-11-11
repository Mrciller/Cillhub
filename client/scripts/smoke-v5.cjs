// v5 smoke (fake API + gateway from smoke-v3-harness): Watch Together with a stand-in YouTube IFrame API, voice channel
// status, noise suppression modes (Enhanced falls back when AudioWorklet is missing), game activity and hotkeys from a fake
// window.cillcordDesktop, Cillhub Bot (Integrations, slash picker, cards), Send later + scheduled list, Remind me, server
// templates (create, sync, export, create from template, import from file). Saves smoke-v5-*.png (1440×900).
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const h = require('./smoke-v3-harness.cjs')

const shot = (name) => path.join(h.root, `smoke-v5-${name}.png`)
const cillbot = h.user('950', 'Cillhub', { bot: true })
const VIDEO = 'dQw4w9WgXcQ'
const session = (extra = {}) => ({
  channel_id: '302', guild_id: h.G, host_id: '100', control: 'host',
  queue: [{ video_id: VIDEO, title: 'Never Gonna Give You Up', added_by: '100' }, { video_id: 'yPYZpwSpKmA', title: 'Together Forever', added_by: '101' }],
  current: { video_id: VIDEO, started_at: Date.now(), position: 0, playing: true, rate: 1 }, ...extra,
})
// Stand-in for https://www.youtube.com/iframe_api: records what the app asks the player to do on window.__yt.
const FAKE_YT = `
const yt = (window.__yt = { seeks: [], time: 0, state: -1, videoId: null, opts: null })
window.YT = { Player: class {
  constructor(el, o) { yt.opts = o; yt.videoId = o.videoId; yt.time = o.playerVars.start || 0; setTimeout(() => o.events.onReady({ target: this }), 50) }
  loadVideoById(x) { yt.videoId = x.videoId; yt.time = x.startSeconds || 0; yt.state = 1 }
  playVideo() { yt.state = 1 } pauseVideo() { yt.state = 2 }
  seekTo(s) { yt.seeks.push(s); yt.time = s }
  getCurrentTime() { return yt.time } getDuration() { return 212 } getPlayerState() { return yt.state }
  getPlaybackRate() { return 1 } setPlaybackRate() {} destroy() {}
  setVolume(v) { yt.volume = v } mute() { yt.muted = true } unMute() { yt.muted = false }
} }
window.onYouTubeIframeAPIReady && window.onYouTubeIframeAPIReady()
`
const index = {
  applications: [{ id: '950', name: 'Cillhub', description: 'Built-in commands', icon: null, bot_id: '950' }],
  application_commands: ['roll', 'coinflip', 'remind', 'giveaway', 'scrim', 'lfg'].map((name, i) => ({ id: String(960 + i), application_id: '950', version: '1', type: 1, name, description: `/${name}` })),
}

async function run(browser, errors) {
  const scheduled = []
  const routes = async (r, { pathname, method, body }) => {
    const json = (j, status = 200) => (r.fulfill({ status, json: j }), true)
    if (pathname.endsWith('/channels/302/watch') && method === 'POST') return json(session())
    if (pathname.endsWith('/users/@me/scheduled-messages') && method === 'GET') return json(scheduled)
    const sc = pathname.match(/\/channels\/(\d+)\/scheduled-messages$/)
    if (sc && method === 'POST') {
      const m = { id: String(7000 + scheduled.length), channel_id: sc[1], guild_id: h.G, ...body }
      scheduled.push(m)
      return json(m, 201)
    }
    if (pathname.endsWith('/guilds/200/cillcord-bot')) return json({ application_id: '950', installed: method === 'PUT' })
    if (pathname.endsWith('/guilds/200/export') && method === 'GET') {
      const role = (id, name) => ({ id, name, permissions: '1024', color: 0, hoist: false, mentionable: false, icon: null, unicode_emoji: null })
      const chan = (id, type, name, parent_id, permission_overwrites = []) => ({ id, type, name, position: 0, topic: null, nsfw: false, rate_limit_per_user: 0, user_limit: 0, parent_id, permission_overwrites })
      return json({ format: 'cillcord-guild', version: 1, exported_at: h.iso(), serialized_source_guild: {
        name: 'Nightfall Gaming', description: null, verification_level: 0, default_message_notifications: 0, explicit_content_filter: 0, preferred_locale: 'en-US',
        afk_timeout: 300, afk_channel_id: null, system_channel_id: 3, system_channel_flags: 0, roles: [role(0, '@everyone'), role(1, 'Staff')],
        channels: [chan(2, 4, 'Text Channels', null), chan(3, 0, 'general', 2, [{ id: 1, type: 0, allow: '0', deny: '2048' }]), chan(4, 2, 'Lobby', null)], emojis: [],
      } })
    }
    const sm = pathname.match(/\/users\/@me\/scheduled-messages\/(\d+)$/)
    if (sm && method === 'PATCH') return json({ ...scheduled.find((x) => x.id === sm[1]), ...body })
    if (/\/users\/@me\/saved-messages\/300\/\d+$/.test(pathname) && (method === 'PUT' || method === 'DELETE')) return r.fulfill({ status: 204 }), true
    if (pathname.endsWith('/application-command-index')) return json(index)
    if (pathname.endsWith('/guilds/200/templates') && method === 'GET') return json([])
    if (pathname.endsWith('/guilds/200/templates') && method === 'POST')
      return json({ code: 'cillTPL1', name: body.name, description: body.description, usage_count: 0, creator_id: '100', created_at: h.iso(), updated_at: h.iso(), source_guild_id: h.G, is_dirty: null, serialized_source_guild: { name: 'Nightfall Gaming', roles: [{ id: 0 }], channels: [{ id: 2 }, { id: 3 }] } })
    if (pathname.endsWith('/guilds/200/templates/cillTPL1') && method === 'PUT')
      return json({ code: 'cillTPL1', name: 'Org setup', description: null, usage_count: 3, creator_id: '100', created_at: h.iso(), updated_at: h.iso(), source_guild_id: h.G, is_dirty: false, serialized_source_guild: { name: 'Nightfall Gaming', roles: [{ id: 0 }], channels: [] } })
    if (pathname.endsWith('/guilds/templates/cillTPL1') && method === 'GET')
      return json({ code: 'cillTPL1', name: 'Org setup', description: 'Our layout', usage_count: 3, creator_id: '100', created_at: h.iso(), updated_at: h.iso(), source_guild_id: h.G, is_dirty: false, serialized_source_guild: { name: 'Nightfall Gaming', roles: [{ id: 0 }, { id: 1 }], channels: [{ id: 2 }] } })
    if (pathname.endsWith('/guilds/templates/external/hgM48av5Q69A') && method === 'GET')
      return json({ code: 'hgM48av5Q69A', name: 'Friends & Family', description: null, usage_count: 9, external: true, serialized_source_guild: { name: 'Friends & Family', description: null, verification_level: 0, default_message_notifications: 0, explicit_content_filter: 0, preferred_locale: 'en-US', afk_timeout: 300, afk_channel_id: null, system_channel_id: 2, system_channel_flags: 0, roles: [{ id: 0, name: '@everyone', permissions: '0', color: 0, hoist: false, mentionable: false }], channels: [{ id: 1, type: 4, name: 'Text Channels', position: 0, parent_id: null, permission_overwrites: [] }, { id: 2, type: 0, name: 'general', position: 0, parent_id: 1, permission_overwrites: [] }] } })
    const newGuild = (id, name) => ({ id, name, icon: null, owner_id: '100', member_count: 1, system_channel_id: `${id}1`, roles: [{ id, name: '@everyone', color: 0, hoist: false, position: 0, permissions: '0', mentionable: false }],
      channels: [{ id: `${id}1`, type: 0, guild_id: id, name: 'general', position: 0, parent_id: null, last_message_id: null, permission_overwrites: [] }], members: [h.member(h.me)] })
    if (pathname.endsWith('/guilds/templates/cillTPL1') && method === 'POST') return json(newGuild('260', body.name), 201)
    if (pathname === '/api/v9/guilds' && method === 'POST') return json(newGuild('270', body.name), 201)
    return false
  }
  // Fake desktop bridge (desktop 1.1.0 preload shape) and an old boolean noise setting to migrate.
  const init = () => {
    window.__desk = {}
    window.cillcordDesktop = Object.freeze({
      platform: 'win32', version: '1.1.0', onUpdateStatus: () => () => {},
      onGameActivity(cb) { window.__desk.game = cb; return () => {} },
      onHotkey(cb) { window.__desk.hotkey = cb; return () => {} },
    })
    if (!localStorage.getItem('voice-settings')) localStorage.setItem('voice-settings', JSON.stringify({ v: 2, noiseSuppression: false }))
  }
  const { page, ctx, ops, posted, dispatch } = await h.open(browser, { routes, errors, init, livekit: true })
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: h.ORIGIN })
  await page.route('https://www.youtube.com/iframe_api', (r) => r.fulfill({ contentType: 'text/javascript', body: FAKE_YT }))
  // Clicks and returns the JSON body of the request it causes (method + path suffix).
  const bodyOf = async (locator, method, suffix) => {
    const [req] = await Promise.all([page.waitForRequest((r) => r.method() === method && new URL(r.url()).pathname.endsWith(suffix)), locator.click()])
    try { return req.postDataJSON() } catch { return null }
  }
  const sidebar = page.getByRole('navigation', { name: 'Nightfall Gaming channels' })
  const members = page.getByRole('complementary', { name: 'Members' })

  // 1. Desktop bridge: the detected game becomes a Playing activity in op 3 and shows in the member list.
  await page.evaluate(() => window.__desk.game({ name: 'Counter-Strike 2', start: Date.now() - 90e3 }))
  await members.getByText('Playing Counter-Strike 2').waitFor()
  const op3 = ops.findLast((f) => f.op === 3)
  const playing = op3.d.activities.find((a) => a.type === 0)
  assert.equal(playing.name, 'Counter-Strike 2')
  assert.ok(playing.timestamps.start <= Date.now() - 90e3)
  dispatch('PRESENCE_UPDATE', { user: { id: '101' }, status: 'online', activities: [{ type: 0, name: 'VALORANT', timestamps: { start: Date.now() - 600e3 } }] })
  await members.getByText('Playing VALORANT').waitFor()
  console.log('ok v5 1 - desktop game activity sent as type 0 in op 3; Playing lines in the member list')

  // 2. Watch Together: start from the voice view, the player follows a remote seek and pause, host controls.
  await sidebar.getByRole('button', { name: /^Lounge/ }).click()
  await page.getByRole('region', { name: 'Voice connection' }).getByText('Voice Connected').waitFor()
  dispatch('VOICE_STATE_UPDATE', { guild_id: h.G, channel_id: '302', user_id: '101', session_id: 'b', self_mute: false, self_deaf: false, mute: false, deaf: false, member: h.member(h.bob, ['500']) })
  await sidebar.getByRole('list', { name: 'Connected users' }).getByText('Playing VALORANT').waitFor()
  await page.getByRole('button', { name: 'Watch Together' }).click()
  const watch = page.getByRole('region', { name: 'Watch Together' })
  await watch.getByLabel('YouTube link').fill('https://example.com/not-youtube')
  await watch.getByRole('button', { name: 'Start Watching' }).click()
  await watch.getByText(/Paste a YouTube link/).waitFor()
  await watch.getByLabel('YouTube link').fill(`https://youtu.be/${VIDEO}`)
  assert.deepEqual(await bodyOf(watch.getByRole('button', { name: 'Start Watching' }), 'POST', '/channels/302/watch'), { video_url: `https://youtu.be/${VIDEO}` })
  // 7.11: the YouTube player loads only after a click (remembered on this device)
  assert.equal(await page.evaluate(() => !!window.__yt), false, 'no YouTube script before consent')
  await watch.getByText(/Your IP address and browser data go to Google/).waitFor()
  await watch.getByRole('button', { name: 'Load player' }).click()
  assert.equal(await page.evaluate(() => localStorage.getItem('watch-youtube-ok')), '1')
  await page.waitForFunction(() => window.__yt?.opts)
  const opts = await page.evaluate(() => ({ host: window.__yt.opts.host, videoId: window.__yt.opts.videoId, controls: window.__yt.opts.playerVars.controls }))
  assert.deepEqual(opts, { host: 'https://www.youtube-nocookie.com', videoId: VIDEO, controls: 0 })
  await sidebar.getByText('Watching: Never Gonna Give You Up').waitFor()
  await watch.getByRole('status').getByText('In sync').waitFor()
  dispatch('WATCH_SESSION_UPDATE', session({ current: { video_id: VIDEO, started_at: new Date().toISOString(), position: 95, playing: true, rate: 1 } }))
  await page.waitForFunction(() => window.__yt.seeks.some((s) => s >= 95 && s < 97))
  dispatch('WATCH_SESSION_UPDATE', session({ current: { video_id: VIDEO, started_at: Date.now(), position: 120, playing: false, rate: 1 } }))
  await page.waitForFunction(() => window.__yt.state === 2 && Math.abs(window.__yt.time - 120) < 0.5)
  const play = await bodyOf(watch.getByRole('button', { name: 'Play' }), 'PATCH', '/channels/302/watch')
  assert.equal(play.action, 'play')
  assert.ok(Math.abs(play.position - 120) < 1, `play from the synced position (${play.position})`)
  assert.deepEqual(await bodyOf(watch.getByRole('switch', { name: 'Control: everyone' }), 'PATCH', '/channels/302/watch'), { control: 'everyone' })
  assert.deepEqual(await bodyOf(watch.getByRole('button', { name: 'Remove Together Forever from the queue' }), 'PATCH', '/channels/302/watch'), { action: 'remove', index: 1 })
  // loudness: default 60 %, slider, mute, saved on this device
  await page.waitForFunction(() => window.__yt.volume === 60 && window.__yt.muted === false)
  await watch.getByRole('slider', { name: 'Video volume' }).fill('25')
  await page.waitForFunction(() => window.__yt.volume === 25)
  await watch.getByRole('button', { name: 'Mute video' }).click()
  await page.waitForFunction(() => window.__yt.muted === true && window.__yt.volume === 0)
  await watch.getByRole('button', { name: 'Unmute video' }).click()
  await page.waitForFunction(() => window.__yt.muted === false && window.__yt.volume === 25)
  assert.deepEqual(JSON.parse(await page.evaluate(() => localStorage.getItem('watch-audio'))), { volume: 25, muted: false, duck: true, duckTo: 30 })
  console.log('ok v5 2 - Watch Together: start (POST video_url), nocookie player, remote seek and pause sync, play/control/remove PATCH, sidebar line, volume/mute saved per device')

  // 3. Voice channel status from the channel menu; shown in the sidebar and the header; cleared by the event.
  await sidebar.getByRole('button', { name: /^Lounge/ }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Set Channel Status' }).click()
  const dlg = page.getByRole('dialog', { name: 'Set Channel Status' })
  await dlg.getByLabel('Status').fill('Scrim vs Team X 🔥')
  assert.deepEqual(await bodyOf(dlg.getByRole('button', { name: 'Save' }), 'PUT', '/channels/302/voice-status'), { status: 'Scrim vs Team X 🔥' })
  await sidebar.getByText('Scrim vs Team X 🔥').waitFor()
  await page.getByRole('main', { name: 'Voice channel Lounge' }).locator('.voice-status-head').getByText('Scrim vs Team X 🔥').waitFor()
  await page.screenshot({ path: shot('watch') })
  dispatch('VOICE_CHANNEL_STATUS_UPDATE', { id: '302', guild_id: h.G, status: null })
  await sidebar.getByText('Scrim vs Team X 🔥').waitFor({ state: 'detached' })
  console.log('ok v5 3 - voice channel status: PUT voice-status, sidebar + header, cleared by VOICE_CHANNEL_STATUS_UPDATE')

  // 4. Global hotkeys from the desktop app toggle mute and deafen.
  const before = ops.length
  await page.evaluate(() => window.__desk.hotkey('toggle-mute'))
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('voice-settings')).selfMute === true)
  assert.ok(ops.slice(before).some((f) => f.op === 4 && f.d.self_mute === true && !f.d.self_deaf))
  await page.evaluate(() => window.__desk.hotkey('toggle-deafen'))
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('voice-settings')).selfDeaf === true)
  assert.ok(ops.slice(before).some((f) => f.op === 4 && f.d.self_deaf === true))
  await page.evaluate(() => window.__desk.hotkey('toggle-deafen')) // undeafen keeps the mute from before deafening
  await page.waitForFunction(() => { const v = JSON.parse(localStorage.getItem('voice-settings')); return v.selfMute && !v.selfDeaf })
  await page.evaluate(() => window.__desk.hotkey('toggle-mute'))
  await page.waitForFunction(() => { const v = JSON.parse(localStorage.getItem('voice-settings')); return !v.selfMute && !v.selfDeaf })
  console.log('ok v5 4 - desktop hotkeys toggle mute and deafen (op 4)')

  // 5. Noise suppression: the old boolean migrates to "off"; Enhanced without AudioWorklet falls back to Standard with a note.
  await page.getByRole('button', { name: 'User Settings' }).click()
  await page.getByRole('tab', { name: 'Voice & Video' }).click()
  const noise = page.getByLabel('Noise Suppression')
  assert.equal(await noise.inputValue(), 'off')
  await noise.selectOption('standard')
  await page.waitForFunction(() => window.__lk.restart?.noiseSuppression === true)
  await page.evaluate(() => { delete window.AudioWorkletNode })
  await noise.selectOption('enhanced')
  await page.getByText(/Enhanced noise suppression is unavailable \(This browser has no AudioWorklet or WebAssembly\.\)\. Using Standard\./).waitFor()
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('voice-settings')).noiseSuppression), 'enhanced')
  await page.waitForTimeout(100)
  assert.equal(await page.evaluate(() => window.__lk.restart.noiseSuppression), true, 'browser suppression stays on while Enhanced is unavailable')
  await page.getByRole('button', { name: 'Close settings' }).click()
  await page.getByRole('region', { name: 'Voice connection' }).getByRole('button', { name: 'Disconnect' }).click()
  console.log('ok v5 5 - noise suppression: boolean migrated to off, Standard restarts the mic, Enhanced falls back cleanly')

  // 6. Cillhub Bot: Integrations → Add, its commands in the slash picker, a giveaway card with an Enter button.
  await page.getByRole('button', { name: 'Nightfall Gaming', exact: true }).click()
  await page.getByRole('button', { name: 'Server Settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Nightfall Gaming' })
  await settings.getByRole('tab', { name: 'Integrations' }).click()
  await bodyOf(settings.getByRole('button', { name: 'Add Cillhub Bot' }), 'PUT', '/guilds/200/cillcord-bot')
  await settings.getByText('Cillhub Bot is in this server.', { exact: false }).waitFor()
  await page.getByRole('button', { name: 'Close settings' }).click()
  await sidebar.getByRole('link', { name: /general/ }).click()
  const box = page.getByRole('textbox', { name: 'Message #general' })
  await box.fill('/give')
  await page.getByRole('listbox', { name: 'Commands' }).getByRole('option', { name: /\/giveaway/ }).waitFor()
  await box.fill('')
  dispatch('MESSAGE_CREATE', { ...h.base(), id: '490', type: 0, author: cillbot, content: '', application_id: '950', timestamp: h.iso(),
    interaction_metadata: { id: '991', type: 2, user: h.me, name: 'giveaway' },
    embeds: [{ type: 'rich', title: 'Gaming Mouse', description: 'Hosted by <@100>. Click **Enter** to join!', color: 0xeb459e, timestamp: h.iso(3600e3),
      fields: [{ name: 'Winners', value: '2', inline: true }, { name: 'Entries', value: '14', inline: true }], footer: { text: 'Ends in 1 hour' } }],
    components: [{ type: 1, components: [{ type: 2, style: 1, label: 'Enter', custom_id: 'giveaway:enter:490', emoji: { name: '🎉' } }] }] })
  dispatch('MESSAGE_CREATE', { ...h.base(), id: '491', type: 0, author: cillbot, content: '', application_id: '950', timestamp: h.iso(),
    embeds: [{ type: 'rich', title: 'Scrim vs Team X', description: 'Best of 3, Mirage / Inferno / Nuke', timestamp: h.iso(86400e3),
      fields: [{ name: 'Roster (2/5)', value: '<@100>\n<@101>', inline: true }, { name: 'Bench', value: '—', inline: true }] }],
    components: [{ type: 1, components: [{ type: 2, style: 3, label: 'Join', custom_id: 'scrim:join:491' }, { type: 2, style: 2, label: 'Bench', custom_id: 'scrim:bench:491' }, { type: 2, style: 4, label: 'Leave', custom_id: 'scrim:leave:491' }] }] })
  const card = page.locator('#msg-490 .bot-card-giveaway')
  await card.getByRole('heading', { name: 'Gaming Mouse' }).waitFor()
  await card.locator('time').getByText(/^Ends /).waitFor()
  await page.locator('#msg-491 .bot-card-scrim').getByRole('button', { name: 'Bench' }).waitFor()
  const click = await bodyOf(card.getByRole('button', { name: /Enter/ }), 'POST', '/interactions')
  assert.equal(click.type, 3)
  assert.equal(click.data.custom_id, 'giveaway:enter:490')
  await page.locator('#msg-491').scrollIntoViewIfNeeded()
  await page.screenshot({ path: shot('bot') })
  console.log('ok v5 6 - Cillhub Bot: Integrations add (PUT /guilds/:id/cillcord-bot), slash picker, giveaway/scrim cards, Enter interaction')

  // 7. Send later and the scheduled list (edit, cancel).
  await box.fill('gg, scrim at 8')
  await page.getByRole('button', { name: 'Send later' }).click()
  const later = page.getByRole('dialog', { name: 'Send Later' })
  const at = new Date(Date.now() + 2 * 3600e3)
  const local = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 16)
  await later.getByLabel('Date and time').fill(local(at))
  await later.getByRole('button', { name: 'Schedule Message' }).click()
  await later.waitFor({ state: 'detached' })
  const sched = posted.find((p) => p.pathname.endsWith('/channels/300/scheduled-messages')).body
  assert.equal(sched.content, 'gg, scrim at 8')
  assert.ok(Math.abs(Date.parse(sched.send_at) - at.getTime()) < 60e3)
  assert.equal(await box.inputValue(), '', 'the composer is cleared')
  await page.getByRole('button', { name: 'Inbox' }).click()
  const inbox = page.getByRole('dialog', { name: 'Inbox' })
  await inbox.getByRole('tab', { name: 'Scheduled' }).click()
  const list = inbox.getByRole('list', { name: 'Scheduled messages' })
  await list.getByText('gg, scrim at 8').waitFor()
  await list.getByRole('button', { name: 'Edit' }).click()
  const edit = list.getByRole('form', { name: 'Edit Scheduled Message' })
  await edit.getByLabel('Message').fill('gg, scrim at 9')
  assert.equal((await bodyOf(edit.getByRole('button', { name: 'Save' }), 'PATCH', '/users/@me/scheduled-messages/7000')).content, 'gg, scrim at 9')
  await list.getByText('gg, scrim at 9').waitFor()
  await page.screenshot({ path: shot('scheduled') })
  await list.getByRole('button', { name: 'Cancel scheduled message' }).click()
  await bodyOf(list.getByRole('button', { name: 'Cancel Message' }), 'DELETE', '/users/@me/scheduled-messages/7000')
  await inbox.getByText('No scheduled messages.').waitFor()
  await page.keyboard.press('Escape')
  dispatch('SCHEDULED_MESSAGE_DELETE', { id: '7001', channel_id: '300', guild_id: h.G, failed: true, code: 50013 })
  await page.getByText('A scheduled message to #general could not be sent.').waitFor()
  console.log('ok v5 7 - Send later (POST /channels/:id/scheduled-messages), scheduled list with edit (PATCH) and cancel (DELETE), a refused send reported')

  // 8. Remind me from the message menu; a due reminder notifies and is listed in the inbox.
  await page.locator('#msg-420').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Remind Me' }).click()
  const remind = await bodyOf(page.getByRole('menu', { name: 'Remind Me' }).getByRole('menuitem', { name: 'In 1 hour' }), 'PUT', '/users/@me/saved-messages/300/420')
  assert.ok(Math.abs(Date.parse(remind.due_at) - Date.now() - 3600e3) < 60e3)
  dispatch('SAVED_MESSAGE_CREATE', { message: h.history['300'][2], save_data: { channel_id: '300', message_id: '418', guild_id: h.G, saved_at: h.iso(-3600e3), due_at: h.iso(-1000) } })
  await page.getByRole('alert').getByText('Reminder: bob: Best lineup? Vote!').waitFor()
  await page.getByRole('button', { name: 'Inbox' }).click()
  await inbox.getByRole('tab', { name: /Reminders/ }).click()
  const rl = inbox.getByRole('list', { name: 'Reminders' })
  await rl.getByText('Due', { exact: true }).waitFor()
  await rl.getByText('bob: pog', { exact: false }).waitFor()
  await page.screenshot({ path: shot('reminders') })
  await bodyOf(rl.getByRole('button', { name: 'Mark reminder done' }), 'DELETE', '/users/@me/saved-messages/300/418')
  await rl.getByText('Due', { exact: true }).waitFor({ state: 'detached' })
  await page.keyboard.press('Escape')
  // 8b. Bookmarks: save a message from its menu (PUT saved-messages with empty body), view in Inbox -> Bookmarks, remove (DELETE).
  await page.locator('#msg-417').click({ button: 'right' })
  const bmReq = await bodyOf(page.getByRole('menuitem', { name: 'Bookmark Message' }), 'PUT', '/users/@me/saved-messages/300/417')
  assert.deepEqual(bmReq, {})
  await page.getByText('Message bookmarked.').waitFor()
  await page.getByRole('button', { name: 'Inbox' }).click()
  await inbox.getByRole('tab', { name: 'Bookmarks' }).click()
  const bml = inbox.getByRole('list', { name: 'Bookmarks' })
  await bml.getByText('bob: Watch this', { exact: false }).waitFor()
  await page.screenshot({ path: shot('bookmarks') })
  await bodyOf(bml.getByRole('button', { name: 'Remove Bookmark' }), 'DELETE', '/users/@me/saved-messages/300/417')
  await inbox.getByText('No bookmarks yet.', { exact: false }).waitFor()
  await page.keyboard.press('Escape')
  console.log('ok v5 8 - Remind me (PUT saved-messages due_at), due reminder toast and inbox list, done (DELETE), Bookmarks tab')

  // 9. Server template: create, sync, copy link, export JSON; then create from the template and import the export.
  await page.getByRole('button', { name: 'Nightfall Gaming', exact: true }).click()
  await page.getByRole('button', { name: 'Server Settings' }).click()
  await settings.getByRole('tab', { name: 'Server Template' }).click()
  await settings.getByLabel('Template Title').fill('Org setup')
  assert.deepEqual(await bodyOf(settings.getByRole('button', { name: 'Generate Template' }), 'POST', '/guilds/200/templates'), { name: 'Org setup', description: null })
  assert.equal(await settings.getByLabel('Template Link').inputValue(), `${h.ORIGIN}/template/cillTPL1`)
  await settings.getByRole('button', { name: 'Copy' }).click()
  await page.getByText('Link copied.').waitFor()
  await settings.getByRole('button', { name: 'Sync Template' }).click()
  await settings.getByText('Used 3 times', { exact: false }).waitFor()
  await page.screenshot({ path: shot('templates') })
  const [download] = await Promise.all([page.waitForEvent('download'), settings.getByRole('button', { name: 'Export Server' }).click()])
  const file = path.join(require('node:os').tmpdir(), `smoke-v5-export-${process.pid}.json`)
  await download.saveAs(file)
  const exported = JSON.parse(fs.readFileSync(file, 'utf8'))
  const snap = exported.serialized_source_guild
  assert.equal(snap.name, 'Nightfall Gaming')
  assert.deepEqual(snap.roles.map((r) => [r.id, r.name]), [[0, '@everyone'], [1, 'Staff']])
  const general = snap.channels.find((c) => c.name === 'general')
  assert.equal(snap.channels.find((c) => c.id === general.parent_id).name, 'Text Channels')
  assert.equal(snap.system_channel_id, general.id)
  assert.ok(!snap.channels.some((c) => c.type === 11), 'threads are not exported')
  await page.getByRole('button', { name: 'Close settings' }).click()

  await page.getByRole('button', { name: 'Add a server' }).click()
  const add = page.getByRole('dialog', { name: 'Add a server' })
  await add.getByLabel('Template link or code').fill(`${h.ORIGIN}/template/cillTPL1`)
  await add.getByRole('button', { name: 'Preview Template' }).click()
  await add.getByText('2 roles, 1 channels').waitFor()
  assert.deepEqual(await bodyOf(add.getByRole('button', { name: 'Create Server' }), 'POST', '/guilds/templates/cillTPL1'), { name: 'Nightfall Gaming' })
  await page.waitForURL('**/channels/260/2601')
  await page.getByRole('button', { name: 'Add a server' }).click()
  await add.getByLabel('Server export (.json)').setInputFiles(file)
  await add.getByText(`${snap.roles.length} roles, ${snap.channels.length} channels`).waitFor()
  const imported = await bodyOf(add.getByRole('button', { name: 'Import Server' }), 'POST', '/api/v9/guilds')
  await page.waitForURL('**/channels/270/2701')
  assert.equal(imported.name, 'Nightfall Gaming')
  assert.deepEqual(imported.roles, snap.roles)
  // a template link from the other chat app: previewed through the server, created via POST /guilds with its snapshot
  await page.getByRole('button', { name: 'Add a server' }).click()
  await add.getByLabel('Template link or code').fill('https://templates.example/hgM48av5Q69A')
  await add.getByRole('button', { name: 'Preview Template' }).click()
  await add.getByText('1 roles, 2 channels').waitFor()
  const ext = await bodyOf(add.getByRole('button', { name: 'Create Server' }), 'POST', '/api/v9/guilds')
  assert.deepEqual([ext.name, ext.channels.map((c) => c.name), ext.system_channel_id], ['Friends & Family', ['Text Channels', 'general'], 2])
  // built-in starter template: roles, private staff category, system channel
  await page.getByRole('button', { name: 'Add a server' }).click()
  await add.getByText('Esports Team', { exact: true }).click()
  assert.ok(await add.getByRole('radio', { name: /Esports Team/ }).isChecked())
  await add.locator('form', { hasText: 'Start from a template' }).getByLabel('Server name').fill('Team Ciller')
  const starter = await bodyOf(add.getByRole('button', { name: 'Use Template' }), 'POST', '/api/v9/guilds')
  assert.equal(starter.name, 'Team Ciller')
  assert.deepEqual(starter.roles.map((r) => r.name), ['@everyone', 'Staff', 'Coach', 'Player', 'Sub'])
  assert.equal(starter.roles[0].permissions, undefined, 'server default for @everyone')
  const staffCat = starter.channels.find((c) => c.type === 4 && c.name === 'Staff')
  assert.deepEqual(staffCat.permission_overwrites.map((o) => [o.id, o.allow, o.deny]), [[0, '0', '1024'], [1, '1024', '0']])
  assert.equal(starter.channels.find((c) => c.id === starter.system_channel_id).name, 'announcements')
  assert.deepEqual(imported.channels, snap.channels)
  assert.equal(imported.system_channel_id, snap.system_channel_id)
  fs.rmSync(file, { force: true })
  console.log('ok v5 9 - server template create/sync/copy link, export JSON (GET /guilds/:id/export), create from template, import from file (POST /guilds)')

  // 10. Light theme with the v5 panels (bot cards).
  await page.goto(`${h.ORIGIN}/channels/${h.G}/300`)
  await page.locator('.app[data-gateway="ready"]').waitFor()
  dispatch('USER_SETTINGS_UPDATE', { theme: 'light' })
  dispatch('MESSAGE_CREATE', { ...h.base(), id: '492', type: 0, author: cillbot, content: '', application_id: '950', timestamp: h.iso(),
    embeds: [{ type: 'rich', title: 'LFG: Valorant ranked', description: '2 more for Diamond lobby', fields: [{ name: 'Players (3/5)', value: '<@100> <@101> <@102>' }] }],
    components: [{ type: 1, components: [{ type: 2, style: 1, label: 'Join', custom_id: 'lfg:join:492' }] }] })
  await page.locator('#msg-492 .bot-card-lfg').waitFor()
  await page.screenshot({ path: shot('light') })
  dispatch('USER_SETTINGS_UPDATE', { theme: 'dark' })
  console.log('ok v5 10 - light theme with an LFG card')
  await ctx.close()
  await micDevices(browser, errors)
}

// 11. Microphone choice with faked devices: a stale saved id is found again by its label and captured with `exact`, a missing mic
// falls back to the default one with a notice, and a noise-removing virtual mic turns Cillhub's suppression and auto gain off.
async function micDevices(browser, errors) {
  const init = () => {
    window.__fakeMics = [['default', 'Default - Built-in Microphone'], ['builtin', 'Built-in Microphone'], ['hs-1', 'Headset (USB)'], ['nv-2', 'Microphone (NVIDIA Broadcast)']]
    window.__gum = []
    navigator.mediaDevices.enumerateDevices = async () => window.__fakeMics.map(([deviceId, label]) => ({ kind: 'audioinput', deviceId, label, groupId: 'g' }))
    navigator.mediaDevices.getUserMedia = async ({ audio }) => {
      window.__gum.push(audio)
      const d = audio.deviceId?.exact ? window.__fakeMics.find((m) => m[0] === audio.deviceId.exact) : window.__fakeMics[0]
      if (!d) throw Object.assign(new Error('no such device'), { name: 'OverconstrainedError' })
      const track = { kind: 'audio', label: d[1], readyState: 'live', stop() {}, getSettings: () => ({ deviceId: d[0] }) }
      return { getAudioTracks: () => [track], getTracks: () => [track] }
    }
    if (!localStorage.getItem('voice-settings')) localStorage.setItem('voice-settings', JSON.stringify({ v: 2, input: 'hs-OLD', inputLabel: 'Headset (USB)' }))
  }
  const { page, ctx } = await h.open(browser, { errors, init, livekit: true })
  const lastGum = () => page.evaluate(() => window.__gum.at(-1))
  const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('voice-settings')))
  // (a) the saved id went stale (driver update): found again by label, captured with exact, new id saved
  await page.getByRole('navigation', { name: 'Nightfall Gaming channels' }).getByRole('button', { name: /^Lounge/ }).click()
  await page.getByRole('region', { name: 'Voice connection' }).getByText('Voice Connected').waitFor()
  await page.waitForFunction(() => window.__gum.length > 0)
  let c = await lastGum()
  assert.deepEqual([c.deviceId, c.noiseSuppression, c.autoGainControl], [{ exact: 'hs-1' }, true, true])
  assert.equal((await saved()).input, 'hs-1')
  await page.getByRole('button', { name: 'User Settings' }).click()
  await page.getByRole('tab', { name: 'Voice & Video' }).click()
  await page.getByText('Microphone in use: Headset (USB)').waitFor()
  assert.equal(await page.getByLabel('Input Device').inputValue(), 'hs-1')
  // (b) the headset is unplugged: the next capture uses the default mic, with a toast and a notice in Voice & Video
  await page.evaluate(() => { window.__fakeMics = window.__fakeMics.filter((m) => m[0] !== 'hs-1'); navigator.mediaDevices.dispatchEvent(new Event('devicechange')) })
  await page.getByText('Microphone “Headset (USB)” not found. Using the default microphone.').first().waitFor()
  await page.getByRole('checkbox', { name: /Echo Cancellation/ }).uncheck()
  await page.locator('.toasts').getByText('Microphone “Headset (USB)” not found. Using the default microphone.').waitFor()
  c = await lastGum()
  assert.deepEqual([c.deviceId, c.echoCancellation], [{ ideal: 'default' }, false])
  assert.equal((await saved()).input, 'hs-1', 'the choice is kept for when the headset is back')
  await page.getByText('Microphone in use: Default - Built-in Microphone').waitFor()
  // (c) NVIDIA Broadcast: Cillhub's suppression and auto gain off, echo cancellation as chosen; the override turns them back on
  await page.getByLabel('Input Device').selectOption('nv-2')
  await page.getByText('NVIDIA Broadcast detected: Cillhub’s noise suppression and auto gain are off so they don’t fight it.').waitFor()
  await page.waitForFunction(() => window.__gum.at(-1).deviceId.exact === 'nv-2')
  c = await lastGum()
  assert.deepEqual([c.noiseSuppression, c.autoGainControl, c.echoCancellation], [false, false, false])
  assert.deepEqual([(await saved()).input, (await saved()).inputLabel, (await saved()).noiseSuppression], ['nv-2', 'Microphone (NVIDIA Broadcast)', 'standard'])
  assert.equal(await page.getByLabel('Noise Suppression', { exact: true }).inputValue(), 'off')
  assert.ok(await page.getByLabel('Noise Suppression', { exact: true }).isDisabled())
  assert.ok(!(await page.getByRole('checkbox', { name: /Automatic Gain Control/ }).isChecked()))
  await page.getByText('Microphone in use: Microphone (NVIDIA Broadcast)').waitFor()
  const n = await page.evaluate(() => window.__gum.length)
  await page.getByRole('checkbox', { name: 'Use Cillhub’s noise suppression and auto gain anyway' }).check()
  await page.waitForFunction((n) => window.__gum.length > n, n)
  c = await lastGum()
  assert.deepEqual([c.deviceId, c.noiseSuppression, c.autoGainControl], [{ exact: 'nv-2' }, true, true])
  assert.equal(await page.getByLabel('Noise Suppression', { exact: true }).inputValue(), 'standard')
  await page.screenshot({ path: shot('mic') })
  await page.getByRole('button', { name: 'Close settings' }).click()
  await page.getByRole('region', { name: 'Voice connection' }).getByRole('button', { name: 'Disconnect' }).click()
  await ctx.close()
  console.log('ok v5 11 - mic: stale id found by label (exact), missing mic falls back to default with a notice, NVIDIA Broadcast turns suppression/AGC off, override turns them on')
}

module.exports = { run }
