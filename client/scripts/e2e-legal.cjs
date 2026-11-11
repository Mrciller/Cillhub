// 7.10.3 legal, end to end against a real server (server/src/index.js serving client/dist on a temporary database):
// legal links on login, sign-up with the terms and age boxes, the legal pages (Markdown cannot inject HTML), the public
// notice form -> admin decision -> status page, remove by link, disable with reasons -> login shows them -> appeal.
// Run: npm run build && NODE_PATH=<dir with playwright> node scripts/e2e-legal.cjs   (SHOTS=<dir> saves screenshots, E2E_PORT fixes the port)
const { chromium } = require('playwright')
const { spawn, execFileSync } = require('node:child_process')
const { createHmac } = require('node:crypto')
const { mkdtempSync, rmSync, mkdirSync } = require('node:fs')
const { tmpdir } = require('node:os')
const assert = require('node:assert/strict')
const path = require('node:path')

const SERVER = path.join(__dirname, '../../server')
const SHOTS = process.env.SHOTS
const shot = async (page, name, full = false) => SHOTS && (await page.waitForTimeout(500), await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: full })) // after the card animation
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'
function totp(at = Date.now()) {
  const key = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x21, 0xde, 0xad, 0xbe, 0xef, 0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x21, 0xde, 0xad, 0xbe, 0xef])
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)))
  const h = createHmac('sha1', key).update(msg).digest()
  return String((h.readUInt32BE(h[19] & 0xf) & 0x7fffffff) % 1_000_000).padStart(6, '0')
}

async function main() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cillhub-e2e-legal-'))
  if (SHOTS) mkdirSync(SHOTS, { recursive: true })
  const env = { ...process.env, PORT: process.env.E2E_PORT || '0', DATA_DIR: dataDir, STATIC_DIR: path.join(__dirname, '../dist'), NODE_ENV: 'test', CILLCORD_RATE_LIMIT_SCALE: '100' }
  for (const k of Object.keys(env)) if (k.startsWith('LIVEKIT_')) delete env[k]
  const proc = spawn(process.execPath, ['src/index.js'], { cwd: SERVER, env, stdio: ['ignore', 'pipe', 'inherit'] })
  const port = await new Promise((resolve, reject) => {
    let out = ''
    proc.stdout.on('data', (c) => { out += c; const m = out.match(/listening on \S+:(\d+)/); if (m) resolve(m[1]) })
    proc.on('exit', (code) => reject(new Error(`server exited with ${code}`)))
  })
  const O = `http://localhost:${port}`
  const api = async (method, p, token, body, headers = {}) => {
    const r = await fetch(`${O}/api/v9${p}`, { method, headers: { ...(token && { Authorization: token }), ...(body && { 'Content-Type': 'application/json' }), ...headers }, body: body && JSON.stringify(body) })
    return { status: r.status, body: r.status === 204 ? null : await r.json() }
  }
  const browser = await chromium.launch()
  const errors = []
  try {
    // Admin Alex with 2FA; the operator fields and documents (test data only)
    const reg = (name, extra = {}) => api('POST', '/auth/register', null, { email: `${name}@example.org`, username: name, password: 'hunter2hunter2', age_confirmed: true, ...extra })
    const alex = (await reg('alex')).body.token
    execFileSync(process.execPath, ['src/admin-cli.js', 'grant', 'alex'], { cwd: SERVER, env: { ...process.env, DATA_DIR: dataDir } })
    const on = await api('POST', '/users/@me/mfa/totp/enable', alex, { password: 'hunter2hunter2', secret: SECRET, code: totp() })
    const backup = on.body.backup_codes.map((c) => c.code)
    const admin = (await api('POST', '/auth/login', null, { login: 'alex', password: 'hunter2hunter2' }))
    const adminToken = (await api('POST', '/auth/mfa/totp', null, { ticket: admin.body.ticket, code: backup.shift() })).body.token
    assert.equal((await api('PATCH', '/admin/settings', adminToken, { legal_operator: { name: 'Example Verein', legal_form: 'Verein', address: 'Musterstraße 1\n1010 Wien\nÖsterreich', email: 'legal@example.org', languages: 'Deutsch, English' } })).status, 200)
    const imprint = '# Example Verein\nMusterstraße 1, 1010 Wien\n\n<img src=x onerror="window.__xss=1"><script>window.__xss=2</script> **bold** and [a link](https://example.org)'
    await api('PUT', '/admin/legal/imprint', adminToken, { en: imprint, de: imprint })
    await api('PUT', '/admin/legal/privacy', adminToken, { en: '# Privacy notice\n- We store your email address.', de: '# Datenschutzerklärung\n- Wir speichern deine E-Mail-Adresse.' })
    await api('PUT', '/admin/legal/terms', adminToken, { en: '# Terms of use\nBe kind.', de: '# Nutzungsbedingungen\nSei nett.' })

    // 1. Login shows the legal links; register needs the boxes
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' })
    const page = await ctx.newPage()
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(`${O}/login`)
    const links = page.getByRole('navigation', { name: 'Legal' })
    for (const name of ['Imprint', 'Privacy', 'Terms', 'Report illegal content', 'Source code']) await links.getByRole('link', { name }).waitFor()
    await shot(page, 'login-links')
    await page.getByRole('link', { name: 'Register' }).click()
    await page.getByLabel('Email').fill('sam@example.org')
    await page.getByLabel('Username').fill('sam')
    await page.getByLabel('Password').fill('hunter2hunter2')
    await page.getByLabel('I am at least 14 years old.').check()
    await shot(page, 'signup')
    const terms = page.locator('input[name="terms_accepted"]')
    await terms.check()
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.waitForURL('**/channels/@me')
    console.log('ok legal 1 - login footer links; sign-up with the terms and age boxes')

    // 2. Legal pages without a session; the imprint's HTML stays text
    const anon = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' })
    const ap = await anon.newPage()
    ap.on('pageerror', (e) => errors.push(e.message))
    await ap.goto(`${O}/impressum`)
    await ap.getByRole('heading', { name: 'Contact for users and authorities (DSA Art. 11/12)' }).waitFor()
    await ap.locator('.legal-text').waitFor()
    assert.match(await ap.locator('.legal-text').innerHTML(), /&lt;img src=x onerror=.*&lt;script&gt;/, 'the tags show as text')
    assert.equal(await ap.locator('.legal-text img, .legal-text script').count(), 0, 'no markup from the document')
    assert.equal(await ap.evaluate(() => window.__xss), undefined)
    await shot(ap, 'imprint')
    await ap.goto(`${O}/privacy`)
    await ap.getByText('We store your email address.').waitFor()
    await shot(ap, 'privacy')
    await ap.goto(`${O}/terms`)
    await ap.getByText('Be kind.').waitFor()
    await shot(ap, 'terms')
    console.log('ok legal 2 - imprint (with the DSA contact), privacy and terms open without login; Markdown HTML is text')

    // 3. Public notice -> admin decides -> status page shows the decision
    await ap.goto(`${O}/report-content`)
    await ap.getByLabel('Kind of illegal content').selectOption('hate_speech')
    await ap.getByLabel('Link to the message, file or server').fill(`${O}/channels/1/2/3`)
    await ap.getByLabel('Why is it illegal?').fill('The message insults a group of people.')
    await ap.getByLabel('Your name').fill('Kim')
    await ap.getByLabel('Your email').fill('kim@example.org')
    await ap.getByLabel('I confirm in good faith').check()
    await shot(ap, 'report-form', true)
    await ap.getByRole('button', { name: 'Send notice' }).click()
    const code = await ap.locator('.legal-code').innerText()
    await shot(ap, 'report-received')
    const ad = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' })
    await ad.addInitScript((t) => localStorage.setItem('token', t), adminToken)
    const admin2 = await ad.newPage()
    admin2.on('pageerror', (e) => errors.push(e.message))
    await admin2.goto(`${O}/admin/overview`)
    await admin2.getByRole('heading', { name: 'Overview' }).waitFor()
    await admin2.goto(`${O}/admin/settings`)
    await admin2.getByRole('heading', { name: 'Legal' }).scrollIntoViewIfNeeded()
    await shot(admin2, 'admin-legal')
    await admin2.goto(`${O}/admin/reports`)
    await admin2.getByRole('button', { name: 'Public notices' }).click()
    const card = admin2.locator('.admin-report', { hasText: 'insults a group' })
    await card.waitFor()
    await shot(admin2, 'admin-notice')
    await card.getByRole('button', { name: 'Action taken' }).click()
    await admin2.getByLabel('Decision for the notifier').fill('We removed the message and warned the author.')
    await admin2.getByRole('button', { name: 'Send decision' }).click()
    await admin2.getByText('Decision sent.').waitFor()
    await ap.goto(`${O}/report-content/status#${code}`)
    await ap.getByText('We removed the message and warned the author.').waitFor()
    await shot(ap, 'report-status')
    console.log('ok legal 3 - public notice form, admin decision, status page by code')

    // 4. Remove by link with reasons; the preserved copy is listed
    const jordan = (await reg('jordan', { terms_accepted: true })).body.token
    const g = (await api('POST', '/guilds', jordan, { name: 'Taylor Fans' })).body
    const ch = g.channels.find((c) => c.name === 'general')
    const m = (await api('POST', `/channels/${ch.id}/messages`, jordan, { content: 'propaganda text' })).body
    await admin2.getByRole('button', { name: 'Remove by link' }).click()
    await admin2.getByLabel('Link to a message, attachment or server').fill(`${O}/channels/${g.id}/${ch.id}/${m.id}`)
    await admin2.getByRole('button', { name: 'Show' }).click()
    await admin2.locator('blockquote', { hasText: 'propaganda text' }).waitFor()
    await shot(admin2, 'admin-remove-by-link')
    await admin2.getByRole('button', { name: 'Remove and preserve' }).click()
    const rd = admin2.getByRole('dialog', { name: 'Remove this message?' })
    await rd.getByLabel('Reason').selectOption('terrorism')
    await rd.getByLabel('Explanation for the affected user').fill('Terrorist propaganda; removal order of the authority.')
    await rd.getByRole('button', { name: 'Remove and preserve' }).click()
    await admin2.locator('.admin-report', { hasText: 'removal order of the authority' }).waitFor()
    assert.equal((await api('GET', `/channels/${ch.id}/messages/${m.id}`, jordan)).status, 404)
    console.log('ok legal 4 - remove by link: preview, reasons, gone at once, preserved copy listed')

    // 5. Disable with reasons -> the login says why -> appeal -> admin queue
    await admin2.goto(`${O}/admin/users`)
    await admin2.getByRole('table', { name: 'Users' }).getByRole('button', { name: 'jordan' }).click()
    await admin2.getByRole('dialog', { name: 'User jordan' }).getByRole('button', { name: 'Disable Account' }).click()
    const dd = admin2.getByRole('dialog', { name: 'Disable jordan?' })
    await dd.getByLabel('Reason').selectOption('harassment')
    await dd.getByLabel('Explanation for the affected user').fill('Repeated harassment of other members after two warnings.')
    await shot(admin2, 'admin-disable-reason')
    await dd.getByRole('button', { name: 'Disable Account' }).click()
    await admin2.getByText('Account disabled.').waitFor()
    const jp = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' })).newPage()
    jp.on('pageerror', (e) => errors.push(e.message))
    await jp.goto(`${O}/login`)
    await jp.getByLabel('Email or username').fill('jordan')
    await jp.getByLabel('Password').fill('hunter2hunter2')
    await jp.getByRole('button', { name: 'Log In' }).click()
    await jp.getByText('Repeated harassment of other members after two warnings.').waitFor()
    await shot(jp, 'login-disabled-reason')
    await jp.getByRole('link', { name: 'Appeal this decision' }).click()
    await jp.getByLabel('Why should the decision be changed?').fill('I was quoting someone else; please look at the whole thread.')
    await jp.getByRole('button', { name: 'Send appeal' }).click()
    await jp.getByRole('heading', { name: 'Your appeal' }).waitFor()
    await shot(jp, 'appeal')
    await admin2.goto(`${O}/admin/reports`)
    await admin2.getByRole('button', { name: 'Appeals' }).click()
    await admin2.getByText('I was quoting someone else').waitFor()
    await shot(admin2, 'admin-appeals')
    await admin2.getByRole('button', { name: 'Yearly numbers' }).click()
    await admin2.getByText('Median handling time').waitFor()
    await shot(admin2, 'admin-numbers')
    console.log('ok legal 5 - disable with reasons, the login shows them, appeal lands in the admin queue')

    // 6. Light theme and German
    const de = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' })
    await de.addInitScript(() => (localStorage.setItem('user-settings', JSON.stringify({ theme: 'light' })), localStorage.setItem('locale', 'de')))
    const dp = await de.newPage()
    dp.on('pageerror', (e) => errors.push(e.message))
    await dp.goto(`${O}/register`)
    await dp.getByText('Ich bin mindestens 14 Jahre alt.').waitFor()
    await shot(dp, 'signup-de-light')
    await dp.goto(`${O}/datenschutz`)
    await dp.getByText('Wir speichern deine E-Mail-Adresse.').waitFor()
    await shot(dp, 'privacy-de-light')
    await dp.goto(`${O}/report-content`)
    await dp.getByRole('heading', { name: 'Rechtswidrige Inhalte melden' }).waitFor()
    await shot(dp, 'report-form-de-light', true)
    console.log('ok legal 6 - light theme and German')
    assert.deepEqual(errors, [], 'no uncaught page errors')
  } finally {
    await browser.close()
    proc.kill()
    rmSync(dataDir, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
