// End-to-end check of 7.10 password reset by email and the sign-up captcha, in a real browser against a throwaway
// instance from server/ with client/dist and a temp DATA_DIR on E2E_PORT (3392). Local stand-ins: an SMTP server on
// E2E_SMTP_PORT (3393) that keeps the mails, and the reCAPTCHA verify endpoint on E2E_CAPTCHA_PORT (3394, the server's
// CAPTCHA_VERIFY_URL); Google's api.js is answered by the page route with a checkbox that ticks itself.
// Jordan is the instance admin (real CLI, TOTP computed here) and sets SMTP and captcha over the admin API; Alex forgets
// the password, opens the link from the mail, sets a new one and signs in; Robin signs up through the captcha.
// Run: NODE_PATH=<dir with playwright> node scripts/e2e-reset.cjs   (E2E_FAIL_SHOTS=<dir> saves the page when a step fails)
const { chromium } = require('playwright')
const { spawn, execFileSync } = require('node:child_process')
const { createHmac } = require('node:crypto')
const net = require('node:net')
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const ROOT = path.join(__dirname, '..')
const SERVER_DIR = path.join(ROOT, 'server')
const DIST = process.env.E2E_STATIC_DIR ?? path.join(ROOT, 'client', 'dist')
const PORT = Number(process.env.E2E_PORT ?? 3392)
const SMTP_PORT = Number(process.env.E2E_SMTP_PORT ?? 3393)
const CAPTCHA_PORT = Number(process.env.E2E_CAPTCHA_PORT ?? 3394)
const BASE = `http://localhost:${PORT}` // also the instance's public address (reset links need one)
const SECRET = 'JBSWY3DPEHPK3PXP'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failed = false
const results = []
const children = []
let page
async function step(name, fn) {
  try {
    await fn()
    console.log(`ok - ${name}`)
    results.push(true)
  } catch (e) {
    console.log(`not ok - ${name}\n  ${String(e.message).split('\n')[0]}`)
    failed = true
    results.push(false)
    if (process.env.E2E_FAIL_SHOTS && page) await page.screenshot({ path: path.join(process.env.E2E_FAIL_SHOTS, 'fail-reset.png') }).catch(() => {})
    throw e
  }
}
const check = (ok, what) => { if (!ok) throw new Error(what) }
async function until(what, fn, ms = 5000) {
  for (const end = Date.now() + ms; ; await sleep(100)) {
    const v = await fn().catch(() => null)
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`)
  }
}
function totp(secret, at = Date.now()) {
  let bits = ''
  for (const c of secret) bits += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c).toString(2).padStart(5, '0')
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)))
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30000)))
  const h = createHmac('sha1', key).update(counter).digest()
  return String((h.readUInt32BE(h[19] & 15) & 0x7fffffff) % 1e6).padStart(6, '0')
}
async function api(method, p, token, body) {
  const res = await fetch(`${BASE}/api/v9${p}`, { method, headers: { ...(token && { Authorization: token }), 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${text}`)
  return text ? JSON.parse(text) : null
}

// SMTP stand-in: accepts everything, keeps {to, data}
const mails = []
const smtp = net.createServer((sock) => {
  sock.write('220 stub\r\n')
  let buf = ''
  let inData = false
  let msg = { to: [], data: '' }
  sock.on('data', (chunk) => {
    buf += chunk
    for (let i; (i = buf.indexOf('\r\n')) >= 0;) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 2)
      if (inData) {
        if (line === '.') (inData = false), mails.push(msg), (msg = { to: [], data: '' }), sock.write('250 queued\r\n')
        else msg.data += `${line}\n`
        continue
      }
      const cmd = line.slice(0, 4).toUpperCase()
      if (cmd === 'EHLO') sock.write('250 stub\r\n')
      else if (cmd === 'RCPT') msg.to.push(line.match(/<(.*)>/)?.[1]), sock.write('250 ok\r\n')
      else if (cmd === 'DATA') (inData = true), sock.write('354 go\r\n')
      else if (cmd === 'QUIT') sock.end('221 bye\r\n')
      else sock.write('250 ok\r\n')
    }
  })
  sock.on('error', () => {})
})
// reCAPTCHA verify stand-in: only the token the page's checkbox hands out passes
const verified = []
const captcha = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const f = new URLSearchParams(body)
    verified.push(f.get('response'))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ success: f.get('secret') === 'secret-jordan' && f.get('response') === 'checkbox-ticked' }))
  })
})
const CAPTCHA_JS = `window.grecaptcha = { render(el, o) { el.textContent = 'captcha ' + o.sitekey; setTimeout(() => o.callback('checkbox-ticked'), 50); return 0 } };
  window[new URL(document.currentScript.src).searchParams.get('onload')]()`

async function main() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error(`no client build in ${DIST}: run npm run build in client/`)
  await new Promise((r) => smtp.listen(SMTP_PORT, '127.0.0.1', r))
  await new Promise((r) => captcha.listen(CAPTCHA_PORT, '127.0.0.1', r))
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cillhub-e2e-reset-'))
  const dataDir = path.join(tmp, 'data')
  fs.mkdirSync(dataDir)
  const out = fs.openSync(path.join(tmp, 'server.log'), 'w')
  // nothing from a sourced .env: a fresh standalone instance
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('LIVEKIT_') && !k.startsWith('CILLCORD_') && k !== 'VOICE_BACKEND')),
    PORT: String(PORT), DATA_DIR: dataDir, STATIC_DIR: DIST, CAPTCHA_VERIFY_URL: `http://127.0.0.1:${CAPTCHA_PORT}/verify`,
  }
  children.push(spawn(process.execPath, ['src/index.js'], { cwd: SERVER_DIR, env, stdio: ['ignore', out, out] }))
  await until('the instance', async () => (await fetch(`${BASE}/api/v9/instance`)).ok, 20000)
  const browser = await chromium.launch()
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' })
    page = await ctx.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.route('https://www.google.com/recaptcha/api.js*', (r) => r.fulfill({ contentType: 'text/javascript', body: CAPTCHA_JS }))
    let jordan
    let alex

    await step('1. Jordan is instance admin and sets SMTP; Alex has an account', async () => {
      jordan = (await api('POST', '/auth/register', null, { email: 'jordan@example.com', username: 'jordan', password: 'hunter2hunter2' })).token
      await api('POST', '/users/@me/mfa/totp/enable', jordan, { password: 'hunter2hunter2', secret: SECRET, code: totp(SECRET) })
      execFileSync(process.execPath, ['src/admin-cli.js', 'grant', 'jordan'], { cwd: SERVER_DIR, env: { ...process.env, DATA_DIR: dataDir } })
      alex = (await api('POST', '/auth/register', null, { email: 'alex@example.com', username: 'alex', password: 'old-pass-alex' })).token
      await api('PATCH', '/admin/settings', jordan, { smtp_host: '127.0.0.1', smtp_port: SMTP_PORT, smtp_security: 'none', smtp_from: 'Cillhub <no-reply@example.org>', public_url: BASE })
      check((await api('GET', '/instance')).password_reset === true, 'password_reset offered')
    })

    let link
    await step('2. Alex asks for a reset on the login page and gets the mail', async () => {
      await page.goto(`${BASE}/login`)
      await page.getByRole('button', { name: 'Forgot password?' }).click()
      await page.getByLabel('Email').fill('alex@example.com')
      await page.getByRole('button', { name: 'Send link' }).click()
      await page.getByText('If an account with this address exists, a mail with a link is on its way.').waitFor()
      const mail = await until('the reset mail', async () => mails.find((m) => m.to.includes('alex@example.com')))
      link = mail.data.replace(/=\n/g, '').replace(/=3D/g, '=').match(/http:\/\/\S+\/reset\?token=[\w-]+/)?.[0]
      check(link?.startsWith(`${BASE}/reset?token=`), `link on this instance: ${link}`)
    })

    await step('3. the link sets a new password; the old session ends; the old password stops working', async () => {
      await page.goto(link)
      await page.getByLabel('New Password', { exact: true }).fill('new-pass-alex')
      await page.getByLabel('Confirm New Password').fill('new-pass-alex')
      await page.getByRole('button', { name: 'Change Password' }).click()
      await page.getByRole('heading', { name: 'Password changed' }).waitFor()
      check(!page.url().includes('token='), 'token left the address bar')
      check((await fetch(`${BASE}/api/v9/users/@me`, { headers: { Authorization: alex } })).status === 401, 'old session revoked')
      const old = await fetch(`${BASE}/api/v9/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: 'alex', password: 'old-pass-alex' }) })
      check(old.status === 401, 'old password refused')
    })

    await step('4. Alex signs in with the new password and reaches the app; the link works only once', async () => {
      await page.getByRole('link', { name: 'Log In' }).click()
      await page.getByLabel('Email or username').fill('alex')
      await page.getByLabel('Password').fill('new-pass-alex')
      await page.getByRole('button', { name: 'Log In' }).click()
      await page.waitForURL('**/channels/@me')
      const again = await fetch(`${BASE}/api/v9/auth/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: new URL(link).searchParams.get('token'), password: 'third-pass-alex' }) })
      check(again.status === 400, 'second use refused')
    })

    await step('5. with captcha keys set, Robin signs up through the checkbox (server checks the token)', async () => {
      await api('PATCH', '/admin/settings', jordan, { captcha_site_key: 'site-jordan', captcha_secret: 'secret-jordan' })
      const refused = await fetch(`${BASE}/api/v9/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'kim@example.com', username: 'kim', password: 'hunter2hunter2' }) })
      check(refused.status === 400 && (await refused.json()).captcha_sitekey === 'site-jordan', 'register without a token answers with the site key')
      const fresh = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' })
      page = await fresh.newPage()
      page.on('pageerror', (e) => errors.push(e.message))
      await page.route('https://www.google.com/recaptcha/api.js*', (r) => r.fulfill({ contentType: 'text/javascript', body: CAPTCHA_JS }))
      await page.goto(`${BASE}/register`)
      await page.getByText('captcha site-jordan').waitFor()
      await page.getByLabel('Email').fill('robin@example.com')
      await page.getByLabel('Username').fill('robin')
      await page.getByLabel('Password').fill('hunter2hunter2')
      await page.getByRole('button', { name: 'Continue' }).click()
      await page.waitForURL('**/channels/@me')
      check(verified.includes('checkbox-ticked'), 'the server asked the verify endpoint')
    })

    await step('6. no uncaught page errors', async () => { if (errors.length) throw new Error(errors.join('; ')) })
  } catch (e) {
    if (!results.length || results.at(-1)) console.log(`not ok - setup: ${e.message}`), (failed = true)
  } finally {
    await browser.close().catch(() => {})
    for (const c of children) c.kill()
    smtp.close()
    captcha.close()
    await sleep(300)
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  console.log(`${results.filter(Boolean).length}/${results.length} steps passed`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  for (const c of children) c.kill()
  process.exit(1)
})
