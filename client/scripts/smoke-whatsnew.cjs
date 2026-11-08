// What's New smoke (src/whatsnew): not on the first-ever run, once after a version change, from User Settings and the
// status menu, German view; plus the old Android app's "moved to a new app" banner (src/android/MovedBanner.tsx).
const assert = require('node:assert/strict')
const path = require('node:path')
const h = require('./smoke-v3-harness.cjs')
const data = require('../src/whatsnew/changelog.json')

const VERSION = data.en[0].releases.find((r) => r.date).version
const seen = (page) => page.evaluate(() => localStorage.getItem('whats-new-seen'))
const ready = (page) => page.locator('.app[data-gateway="ready"]').waitFor()

async function run(browser, errors) {
  // 1. First-ever run on this device: no dialog, the version is only recorded.
  {
    const { page, ctx } = await h.open(browser, { errors })
    await page.getByRole('heading', { name: 'general', level: 1 }).waitFor()
    await page.waitForTimeout(300)
    assert.equal(await page.getByRole('dialog', { name: "What's New" }).count(), 0, 'no What\'s New on the first run')
    assert.equal(await seen(page), VERSION)
    await page.reload()
    await ready(page)
    await page.waitForTimeout(300)
    assert.equal(await page.getByRole('dialog', { name: "What's New" }).count(), 0, 'nothing after a reload either')

    // From the status menu: a dialog with the newest release first, focus inside, Escape closes.
    await page.getByRole('button', { name: /^Set status/ }).click()
    await page.getByRole('menuitem', { name: "What's New" }).click()
    const dlg = page.getByRole('dialog', { name: "What's New" })
    await dlg.getByRole('heading', { name: 'Web app and server', level: 3 }).waitFor()
    // the newest web entry first: "Unreleased" while one exists, else the newest release
    const newest = data.en[0].releases[0]
    assert.match(await dlg.getByRole('heading', { level: 4 }).first().textContent(), newest.date ? new RegExp(`^${newest.version.replace(/\./g, '\\.')} · `) : /^Unreleased$/)
    await dlg.getByRole('heading', { name: new RegExp(`^${VERSION.replace(/\./g, '\\.')} · `), level: 4 }).waitFor()
    await dlg.getByRole('heading', { name: 'Desktop app', level: 3 }).waitFor()
    await dlg.getByRole('heading', { name: 'Android app', level: 3 }).waitFor()
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Changelog', 'focus starts on the list')
    await page.keyboard.press('Escape')
    await dlg.waitFor({ state: 'detached' })

    // From User Settings: a "What's New" tab with h1 > h2 product > h3 release > h4 section.
    await page.getByRole('button', { name: 'User Settings' }).click()
    const settings = page.getByRole('dialog', { name: 'User Settings' })
    await settings.getByRole('tab', { name: "What's New" }).click()
    await settings.getByRole('heading', { name: "What's New", level: 1 }).waitFor()
    await settings.getByRole('heading', { name: 'Web app and server', level: 2 }).waitFor()
    await settings.getByRole('heading', { name: /^1\.0\.0 · /, level: 3 }).first().waitFor()
    await settings.getByRole('heading', { name: 'Added', level: 4 }).first().waitFor()
    await settings.getByText('First release: accounts, servers, text channels', { exact: false }).waitFor()
    await ctx.close()
  }

  // 2. A different version was seen before: the dialog opens once by itself.
  {
    const init = () => { if (!sessionStorage.getItem('smoke-once')) { sessionStorage.setItem('smoke-once', '1'); localStorage.setItem('whats-new-seen', '0.9.0') } }
    const { page, ctx } = await h.open(browser, { errors, init })
    const dlg = page.getByRole('dialog', { name: "What's New" })
    await dlg.getByRole('heading', { name: 'Web app and server' }).waitFor()
    assert.equal(await seen(page), VERSION)
    await page.screenshot({ path: path.join(h.root, 'smoke-whatsnew.png') })
    await dlg.getByRole('button', { name: 'Close' }).click()
    await dlg.waitFor({ state: 'detached' })
    await page.reload()
    await ready(page)
    await page.waitForTimeout(300)
    assert.equal(await dlg.count(), 0, 'shown only once')
    await ctx.close()
  }

  // 3. German: tab, headings and entries come from CHANGELOG.de.md.
  {
    const { page, ctx } = await h.open(browser, { errors, init: () => localStorage.setItem('locale', 'de') })
    await page.getByRole('button', { name: 'Benutzereinstellungen' }).click()
    const settings = page.getByRole('dialog', { name: 'Benutzereinstellungen' })
    await settings.getByRole('tab', { name: 'Neuigkeiten' }).click()
    await settings.getByRole('heading', { name: 'Neuigkeiten', level: 1 }).waitFor()
    await settings.getByRole('heading', { name: 'Web-App und Server', level: 2 }).waitFor()
    const newestDe = data.de[0].releases[0]
    assert.match(await settings.getByRole('tabpanel').getByRole('heading', { level: 3 }).first().textContent(), newestDe.date ? new RegExp(`^${newestDe.version.replace(/\./g, '\\.')} · `) : /^Noch nicht veröffentlicht$/)
    await settings.getByRole('heading', { name: 'Neu', level: 4 }).first().waitFor()
    await settings.getByRole('heading', { name: /^7\.4\.0 · 5\. November 2026$/, level: 3 }).waitFor()
    await settings.getByRole('heading', { name: 'Android-App', level: 2 }).waitFor()
    await ctx.close()
  }

  // 4. The old Android app (1.x) gets a banner pointing to the new app; dismissed until the app starts again. 2.x does not.
  {
    const ua = (v) => ({ userAgent: `Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0 Mobile Safari/537.36 CillhubAndroid/${v}` })
    const { page, ctx } = await h.open(browser, { errors, context: ua('1.1.0') })
    const banner = page.getByRole('status').filter({ hasText: 'Cillhub moved to a new app' })
    await banner.waitFor()
    assert.equal(await banner.getByRole('link', { name: 'Download the new app' }).getAttribute('href'), '/download/android/Cillhub.apk')
    await banner.getByRole('button', { name: 'Dismiss until the app restarts' }).click()
    await banner.waitFor({ state: 'detached' })
    await page.reload()
    await ready(page)
    assert.equal(await banner.count(), 0, 'stays dismissed in this session')
    await ctx.close()
    const fresh = await h.open(browser, { errors, context: ua('1.0.0') })
    await fresh.page.getByText('Cillhub moved to a new app').waitFor()
    await fresh.ctx.close()
    const now = await h.open(browser, { errors, context: ua('2.0.0') })
    await now.page.waitForTimeout(300)
    assert.equal(await now.page.getByText('Cillhub moved to a new app').count(), 0, 'not in the new app')
    await now.ctx.close()
  }
  console.log("ok whats-new - not on first run, once after a version change, status menu, settings tab, German; old Android app banner")
}

module.exports = { run }
