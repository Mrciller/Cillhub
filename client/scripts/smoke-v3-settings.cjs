// v3 smoke: Server Settings (audit log, AutoMod), timeout from the member menu, rules screening gate.
const assert = require('node:assert/strict')
const h = require('./smoke-v3-harness.cjs')

const snow = (ago) => String((BigInt(Date.now() - ago - 1420070400000) << 22n) | 1n)
const log = {
  audit_log_entries: [
    { id: snow(60e3), user_id: '100', target_id: '101', action_type: 24, reason: 'cleanup', changes: [{ key: 'nick', old_value: null, new_value: 'bobby' }] },
    { id: snow(120e3), user_id: '100', target_id: '102', action_type: 22, reason: 'spam' },
    { id: snow(180e3), user_id: '101', target_id: '300', action_type: 10, changes: [{ key: 'name', new_value: 'general' }] },
    { id: snow(240e3), user_id: '100', target_id: '777', action_type: 140, changes: [{ key: 'name', new_value: 'No slurs' }] },
  ],
  users: [h.me, h.bob, h.carol], webhooks: [], threads: [], auto_moderation_rules: [], guild_scheduled_events: [],
}
const rule = {
  id: '777', guild_id: h.G, name: 'No slurs', creator_id: '100', event_type: 1, trigger_type: 1, trigger_metadata: { keyword_filter: ['badword*'], regex_patterns: [], allow_list: [] },
  actions: [{ type: 1, metadata: { custom_message: 'Please keep it civil.' } }], enabled: true, exempt_roles: [], exempt_channels: [],
}
const verification = { version: '2026-01-01T00:00:00.000Z', description: 'Welcome to the lounge.', form_fields: [{ field_type: 'TERMS', label: 'Read and agree to the server rules', values: ['Be kind', 'No spam'], required: true }] }

async function run(browser, errors) {
  const routes = async (r, { pathname, method, body }) => {
    if (pathname.endsWith(`/guilds/${h.G}/audit-logs`)) return r.fulfill({ json: log }), true
    if (pathname.endsWith(`/guilds/${h.G}/auto-moderation/rules`) && method === 'GET') return r.fulfill({ json: [rule] }), true
    if (pathname.endsWith(`/guilds/${h.G}/auto-moderation/rules`) && method === 'POST') return r.fulfill({ json: { ...rule, ...body, id: '778' } }), true
    if (pathname.endsWith(`/guilds/${h.G}/members/101`) && method === 'PATCH') return r.fulfill({ json: h.member(h.bob, ['500'], body) }), true
    if (pathname.endsWith(`/guilds/${h.G2}/member-verification`)) return r.fulfill({ json: verification }), true
    if (pathname.endsWith(`/guilds/${h.G2}/requests/@me`) && method === 'PUT') return r.fulfill({ json: { status: 'APPROVED' } }), true
    return false
  }
  const { page, posted, dispatch, ctx } = await h.open(browser, { routes, errors })

  // Audit log page renders readable entries with an expandable change list.
  await page.getByRole('button', { name: 'Nightfall Gaming', exact: true }).click()
  await page.getByRole('button', { name: 'Server Settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Nightfall Gaming' })
  await settings.getByRole('tab', { name: 'Audit Log' }).click()
  const entries = settings.getByRole('list', { name: 'Audit log entries' })
  await entries.getByText('banned').waitFor()
  await entries.getByText('created AutoMod rule').waitFor()
  const first = entries.getByRole('button', { name: /updated member/ })
  await first.click()
  assert.equal(await first.getAttribute('aria-expanded'), 'true')
  await entries.getByText('bobby').waitFor()
  await entries.getByText('cleanup').waitFor()
  await page.mouse.move(0, 0)
  await page.screenshot({ path: h.shot('settings') })
  console.log('ok v3-settings 1 - audit log entries, change list and reason')

  // AutoMod: rule list, editor opens, a new keyword rule is posted.
  await settings.getByRole('tab', { name: 'AutoMod' }).click()
  await settings.getByRole('list', { name: 'AutoMod rules' }).getByText('No slurs').waitFor()
  await settings.getByRole('button', { name: 'Create Rule' }).click()
  const editor = page.getByRole('dialog', { name: 'Create AutoMod Rule' })
  await editor.getByLabel('Keywords', { exact: true }).fill('spoiler*, leak')
  await editor.getByRole('button', { name: 'Create Rule' }).click()
  await editor.waitFor({ state: 'detached' })
  const created = posted.find((p) => p.method === 'POST' && p.pathname.endsWith('/auto-moderation/rules'))
  assert.deepEqual(created.body.trigger_metadata.keyword_filter, ['spoiler*', 'leak'])
  assert.equal(created.body.actions[0].type, 1)
  await page.keyboard.press('Escape')
  await settings.waitFor({ state: 'detached' })
  console.log('ok v3-settings 2 - AutoMod editor creates a keyword rule')

  // Member context menu -> Timeout -> PATCH communication_disabled_until; the member list shows it.
  const members = page.getByRole('complementary', { name: 'Members' })
  await members.getByRole('listitem').filter({ hasText: 'bob' }).click({ button: 'right' })
  await page.getByRole('menu').getByRole('menuitem', { name: 'Timeout bob' }).click()
  const tm = page.getByRole('dialog', { name: 'Timeout bob' })
  await tm.getByLabel('1 hour').check()
  await tm.getByRole('button', { name: 'Timeout', exact: true }).click()
  await tm.waitFor({ state: 'detached' })
  const patch = posted.find((p) => p.method === 'PATCH' && p.pathname.endsWith(`/guilds/${h.G}/members/101`))
  const until = Date.parse(patch.body.communication_disabled_until)
  assert.ok(until > Date.now() + 3500e3 && until < Date.now() + 3700e3, 'one hour timeout')
  await members.getByRole('img', { name: 'Timed out' }).waitFor()
  console.log('ok v3-settings 3 - timeout from the member menu')

  // Rules screening: pending members cannot talk until they accept the rules.
  await page.getByRole('navigation', { name: 'Servers' }).getByRole('link', { name: /^Rules Lounge/ }).click()
  await page.waitForURL(`**/channels/${h.G2}/310`)
  const complete = page.getByRole('button', { name: 'Complete' })
  await complete.waitFor()
  const box = page.getByRole('textbox', { name: 'Message #rules-chat' })
  assert.ok((await box.count()) === 0 || (await box.isDisabled()), 'composer blocked while pending')
  await complete.click()
  const rules = page.getByRole('dialog', { name: 'Rules Lounge Rules' })
  await rules.getByText('No spam').waitFor()
  const submit = rules.getByRole('button', { name: 'Submit' })
  assert.equal(await submit.isDisabled(), true)
  await rules.getByLabel('I have read and agree to the rules').check()
  await submit.click()
  await rules.waitFor({ state: 'detached' })
  const put = posted.find((p) => p.method === 'PUT' && p.pathname.endsWith(`/guilds/${h.G2}/requests/@me`))
  assert.equal(put.body.form_fields[0].response, true)
  assert.equal(put.body.version, verification.version)
  dispatch('GUILD_MEMBER_UPDATE', { ...h.member(h.me, [], { pending: false }), guild_id: h.G2 })
  await box.waitFor()
  assert.equal(await box.isEnabled(), true, 'composer enabled after accepting')
  console.log('ok v3-settings 4 - rules screening blocks the composer until accepted')

  assert.deepEqual(errors.filter((e) => e.startsWith('native dialog')), [], 'no native dialogs')
  await ctx.close()
}

module.exports = { run }
