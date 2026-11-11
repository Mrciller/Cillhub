const { chromium } = require('playwright')
// Drag and drop: someone with Move Members drags a connected user onto another voice channel; the user's client follows.
// Run: NODE_PATH=<playwright> E2E_BASE_URL=http://127.0.0.1:3300 node scripts/e2e-voice-drag.cjs (a throwaway instance with voice)
const B = (process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3300').replace(/\/$/, ''), API = B + '/api/v9'
const j = (m, p, b, tok) => fetch(API + p, { method: m, headers: { 'content-type': 'application/json', ...(tok && { authorization: tok }) }, body: b && JSON.stringify(b) }).then((r) => r.json())
;(async () => {
  const n = Date.now() % 1e6
  const reg = (u) => j('POST', '/auth/register', { age_confirmed: true, email: u + '@example.com', username: u, password: 'Very-long-pass-123', date_of_birth: '2000-01-01', consent: true })
  const a = await reg('ddalice' + n), b = await reg('ddbob' + n)
  const g = await j('POST', '/guilds', { name: 'Drag' }, a.token)
  const inv = await j('POST', `/channels/${g.system_channel_id}/invites`, {}, a.token)
  await j('POST', `/invites/${inv.code}`, {}, b.token)
  const chans = await j('GET', `/guilds/${g.id}/channels`, null, a.token)
  const general = chans.find((c) => c.type === 2)
  const lounge = await j('POST', `/guilds/${g.id}/channels`, { name: 'Lounge', type: 2, parent_id: general.parent_id }, a.token)
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] })
  const open = async (tok) => { const c = await browser.newContext({ serviceWorkers: 'block', permissions: ['microphone'], viewport: { width: 1280, height: 800 } }); await c.addInitScript((t) => localStorage.setItem('token', t), tok); const p = await c.newPage(); await p.goto(`${B}/channels/${g.id}/${g.system_channel_id}`); await p.waitForTimeout(1200); return p }
  const pb = await open(b.token)
  await pb.getByRole('button', { name: /^General \(voice channel/ }).click(); await pb.waitForTimeout(2500)
  const pa = await open(a.token)
  const bobRow = pa.locator('.voice-users li', { hasText: 'ddbob' })
  await bobRow.waitFor()
  if ((await bobRow.getAttribute('draggable')) !== 'true') throw new Error('Bob is not draggable for Alice')
  await bobRow.dragTo(pa.getByRole('button', { name: /^Lounge \(voice channel/ }))
  await pa.waitForTimeout(1500)
  const loungeUsers = await pa.locator('li', { has: pa.getByRole('button', { name: /^Lounge \(voice channel/ }) }).locator('.voice-users li').allInnerTexts()
  if (!loungeUsers.some((x) => x.includes('ddbob'))) throw new Error('Bob was not moved to Lounge: ' + JSON.stringify(loungeUsers))
  console.log('ok - drag and drop moved Bob to Lounge')
  // Bob's own client follows the move
  await pb.waitForFunction(() => /Lounge/.test(document.querySelector('.voice-panel')?.textContent ?? ''), null, { timeout: 10000 })
  console.log('ok - Bob\'s client follows to Lounge')

  await browser.close()
})().catch((e) => { console.error('FAIL', e.message); process.exit(1) })
