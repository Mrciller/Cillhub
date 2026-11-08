// End-to-end check: two browsers (Alice, Bob) against a running server that serves client/dist.
// Run: NODE_PATH=<dir with playwright> E2E_BASE_URL=http://127.0.0.1:3100 node scripts/e2e.cjs
// Needs a fresh DATA_DIR (usernames Alice, Bob and Carol are registered). E2E_SCREENSHOTS=1 also writes docs/screenshots/*.png.
const { chromium } = require('playwright')
const path = require('node:path')

const BASE = (process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3100').replace(/\/$/, '')
const SHOTS = process.env.E2E_SCREENSHOTS ? path.join(__dirname, '..', 'docs', 'screenshots') : null
const LIVE = { timeout: 5000 } // live updates must arrive within 5 s, without reload
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failed = false
const errors = []

async function step(name, fn) {
  try {
    await fn()
    console.log(`ok - ${name}`)
  } catch (e) {
    console.log(`not ok - ${name}\n  ${String(e.message).split('\n')[0]}`)
    failed = true
    throw e
  }
}

// Polls until fn() is truthy; the message says what was expected.
async function until(what, fn, ms = 5000) {
  for (const end = Date.now() + ms; ; await sleep(100)) {
    if (await fn().catch(() => false)) return
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`)
  }
}

async function newUser(browser, name) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`))
  page.on('dialog', (d) => (errors.push(`${name}: unexpected native dialog "${d.message()}"`), d.dismiss())) // v3: all confirmations are in-app modals
  return page
}

async function ready(page) {
  await page.getByRole('navigation', { name: 'Servers' }).waitFor()
  await until('the gateway to connect (no "Connecting…")', async () => (await page.getByText('Connecting…').count()) === 0, 10000)
}

async function register(page, name) {
  await page.goto(BASE + '/')
  await page.getByRole('heading', { name: 'Ready up' }).waitFor()
  await page.getByRole('link', { name: 'Register' }).click()
  await page.getByLabel('Email').fill(`${name.toLowerCase()}@example.com`)
  await page.getByLabel('Username').fill(name)
  await page.getByLabel('Password').fill('correct horse battery')
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.waitForURL('**/channels/@me')
  await ready(page)
}

const log = (page, label) => page.getByRole('log', { name: `Messages in ${label}` })
const message = (page, label, text) => log(page, label).getByRole('listitem').filter({ hasText: text })
const members = (page) => page.getByRole('complementary', { name: 'Members' })
const channelLink = (page, guild, name) => page.getByRole('navigation', { name: `${guild} channels` }).getByRole('link', { name })

async function send(page, label, text) {
  const box = page.getByRole('textbox', { name: `Message ${label}` })
  await box.fill(text)
  await box.press('Enter')
}

async function guildMenu(page, guild, item) {
  await page.getByRole('button', { name: guild, exact: true }).click()
  await page.getByRole('button', { name: item }).click()
}

async function main() {
  const browser = await chromium.launch()
  try {
    const alice = await newUser(browser, 'Alice')
    const bob = await newUser(browser, 'Bob')
    let code

    if (SHOTS) {
      await alice.goto(BASE + '/login')
      await alice.getByRole('heading', { name: 'Ready up' }).waitFor()
      await alice.screenshot({ path: path.join(SHOTS, 'login.png') })
    }

    await step('app is served and Alice registers; gateway connects', () => register(alice, 'Alice'))
    await step('Bob registers; gateway connects', () => register(bob, 'Bob'))

    await step('Alice creates server "Nightfall" and lands in #general', async () => {
      await alice.getByRole('button', { name: 'Add a server' }).click()
      const dialog = alice.getByRole('dialog', { name: 'Add a server' })
      await dialog.getByLabel('Server name').fill('Nightfall')
      await dialog.getByRole('button', { name: 'Create', exact: true }).click()
      await alice.getByRole('link', { name: 'Nightfall' }).waitFor()
      await alice.getByRole('heading', { level: 1, name: 'general' }).waitFor()
      await channelLink(alice, 'Nightfall', 'general').waitFor()
    })

    await step('Alice creates channel "scrims"', async () => {
      await guildMenu(alice, 'Nightfall', 'Create Channel')
      const dialog = alice.getByRole('dialog', { name: 'Create channel' })
      await dialog.getByLabel('Channel name').fill('scrims')
      await dialog.getByRole('button', { name: 'Create Channel' }).click()
      await alice.getByRole('heading', { level: 1, name: 'scrims' }).waitFor()
      await channelLink(alice, 'Nightfall', 'scrims').waitFor()
    })

    await step('Alice opens Invite People and reads the code', async () => {
      await guildMenu(alice, 'Nightfall', 'Invite People')
      const dialog = alice.getByRole('dialog', { name: 'Invite friends' })
      const field = dialog.getByLabel('Send this invite link to a friend')
      await until('an invite link in the field', async () => /\/invite\/[A-Za-z0-9]{8}$/.test(await field.inputValue()))
      code = (await field.inputValue()).split('/').pop()
      await dialog.getByRole('button', { name: 'Done' }).click()
    })

    await step('Bob joins via /invite/CODE and sees the server and both channels', async () => {
      await bob.goto(`${BASE}/invite/${code}`)
      await bob.getByRole('heading', { name: 'Nightfall' }).waitFor()
      await bob.getByText('1 Member').waitFor()
      await bob.getByRole('button', { name: 'Join' }).click()
      await ready(bob)
      await bob.getByRole('link', { name: 'Nightfall' }).waitFor()
      await channelLink(bob, 'Nightfall', 'general').waitFor()
      await channelLink(bob, 'Nightfall', 'scrims').waitFor()
    })

    await step('Alice sends "hello bob" in #scrims and Bob sees it live', async () => {
      await channelLink(bob, 'Nightfall', 'scrims').click()
      await log(bob, '#scrims').waitFor()
      await send(alice, '#scrims', 'hello bob')
      await message(bob, '#scrims', 'hello bob').waitFor(LIVE)
    })

    await step('Bob replies and Alice sees it live', async () => {
      await send(bob, '#scrims', 'hi alice')
      await message(alice, '#scrims', 'hi alice').waitFor(LIVE)
    })

    await step('Alice edits her message and Bob sees the edit', async () => {
      const msg = message(alice, '#scrims', 'hello bob')
      await msg.hover()
      await msg.getByRole('button', { name: 'Edit message' }).click()
      const box = alice.getByRole('textbox', { name: 'Edit message' })
      await box.fill('hello bob, ready for scrims?')
      await box.press('Enter')
      await message(bob, '#scrims', 'hello bob, ready for scrims?').filter({ hasText: '(edited)' }).waitFor(LIVE)
    })

    await step('Alice deletes her message and it vanishes for Bob', async () => {
      const msg = message(alice, '#scrims', 'hello bob')
      await msg.hover()
      await msg.getByRole('button', { name: 'Delete message' }).click()
      await alice.getByRole('dialog', { name: 'Delete Message' }).getByRole('button', { name: 'Delete', exact: true }).click()
      await message(bob, '#scrims', 'hello bob').waitFor({ state: 'detached', ...LIVE })
    })

    await step('Bob starts typing and Alice sees "Bob is typing…"', async () => {
      await bob.getByRole('textbox', { name: 'Message #scrims' }).fill('one sec')
      await alice.getByText('Bob is typing…').waitFor(LIVE)
      await bob.getByRole('textbox', { name: 'Message #scrims' }).fill('')
    })

    await step('member list shows Alice and Bob online, for both', async () => {
      for (const page of [alice, bob]) {
        await members(page).getByRole('heading', { name: 'Online — 2' }).waitFor(LIVE)
        for (const name of ['Alice', 'Bob'])
          await members(page).getByRole('listitem').filter({ hasText: name }).getByRole('img', { name: 'Online' }).waitFor(LIVE)
      }
    })

    if (SHOTS) {
      await send(bob, '#scrims', 'lobby is up, code in DMs')
      await send(alice, '#scrims', 'joining now')
      await send(alice, '#scrims', 'bring the new smoke lineups')
      await message(alice, '#scrims', 'bring the new smoke lineups').waitFor()
      await alice.mouse.move(0, 0) // no hover toolbar in the shots
      await sleep(500)
      for (const [file, width, height] of [['desktop', 1440, 900], ['tablet', 768, 1024], ['phone', 390, 844]]) {
        await alice.setViewportSize({ width, height })
        await sleep(300)
        await alice.screenshot({ path: path.join(SHOTS, `${file}.png`) })
      }
      await alice.setViewportSize({ width: 1440, height: 900 })
    }

    await step('Bob opens a DM with Alice from Home and sends "dm test"; Alice sees it under Home', async () => {
      await bob.getByRole('link', { name: 'Direct Messages' }).click()
      await bob.getByRole('button', { name: 'Find or start a conversation' }).click()
      const dialog = bob.getByRole('dialog', { name: 'Find or start a conversation' })
      await dialog.getByLabel('Search for a user').fill('Alice')
      await dialog.getByRole('button', { name: /Alice/ }).click()
      await bob.getByRole('heading', { level: 1, name: 'Alice' }).waitFor()
      await send(bob, '@Alice', 'dm test')
      await message(bob, '@Alice', 'dm test').waitFor()
      await alice.getByRole('link', { name: 'Direct Messages' }).click()
      await alice.getByRole('navigation', { name: 'Direct messages' }).getByRole('link', { name: 'Bob' }).click(LIVE)
      await message(alice, '@Bob', 'dm test').waitFor(LIVE)
    })

    await step("Bob leaves the server and Alice's member list updates", async () => {
      await alice.getByRole('link', { name: 'Nightfall' }).click()
      await members(alice).getByRole('heading', { name: 'Online — 2' }).waitFor()
      await bob.getByRole('link', { name: 'Nightfall' }).click()
      await guildMenu(bob, 'Nightfall', 'Leave Server')
      await bob.getByRole('dialog', { name: "Leave 'Nightfall'" }).getByRole('button', { name: 'Leave Server' }).click()
      await bob.getByRole('link', { name: 'Nightfall' }).waitFor({ state: 'detached', ...LIVE })
      await members(alice).getByRole('listitem').filter({ hasText: 'Bob' }).waitFor({ state: 'detached', ...LIVE })
      await members(alice).getByRole('heading', { name: 'Online — 1' }).waitFor(LIVE)
    })

    await step("reloading Alice's page restores server, channels and messages", async () => {
      await channelLink(alice, 'Nightfall', 'scrims').click()
      await alice.reload()
      await ready(alice)
      await alice.getByRole('heading', { level: 1, name: 'scrims' }).waitFor()
      await channelLink(alice, 'Nightfall', 'general').waitFor()
      await message(alice, '#scrims', 'hi alice').waitFor()
      if (await message(alice, '#scrims', 'hello bob').count()) throw new Error('the deleted message came back after reload')
      await alice.getByRole('link', { name: 'Direct Messages' }).click()
      await alice.getByRole('navigation', { name: 'Direct messages' }).getByRole('link', { name: 'Bob' }).click()
      await message(alice, '@Bob', 'dm test').waitFor()
    })

    // Carol shares no guild or DM with Alice yet, so only GUILD_CREATE can tell her that Alice is online.
    await step('Carol, already connected, joins from "Add a server" and sees Alice online', async () => {
      const carol = await newUser(browser, 'Carol')
      await register(carol, 'Carol')
      await carol.getByRole('button', { name: 'Add a server' }).click()
      const dialog = carol.getByRole('dialog', { name: 'Add a server' })
      await dialog.getByLabel('Invite link or code').fill(code)
      await dialog.getByRole('button', { name: 'Join server' }).click()
      await carol.getByRole('heading', { level: 1, name: 'general' }).waitFor()
      await members(carol).getByRole('listitem').filter({ hasText: 'Alice' }).getByRole('img', { name: 'Online' }).waitFor(LIVE)
    })

    await step('no uncaught errors in either page', async () => {
      if (errors.length) throw new Error(errors.join('; '))
    })
  } catch {
    // step() already reported it; later steps depend on earlier ones
  } finally {
    await browser.close()
  }
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
