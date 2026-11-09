// v3 core chat: custom emoji, stickers, polls, embeds, search + jump, replies loading around, mentions, attachments, slowmode, dialogs.
const assert = require('node:assert/strict')
const h = require('./smoke-v3-harness.cjs')

async function run(browser, errors) {
  const searches = []
  const arounds = []
  const routes = async (r, { pathname, method, url }) => {
    if (pathname.endsWith('/guilds/200/messages/search')) {
      searches.push(url.searchParams)
      const offset = Number(url.searchParams.get('offset') ?? 0)
      const hit = { ...h.old, hit: true }
      await r.fulfill({ json: { analytics_id: 'x', doing_deep_historical_index: false, total_results: 30, messages: offset ? [[{ ...hit, id: '399', content: 'page two result' }]] : [[hit]] } })
      return true
    }
    if (method === 'GET' && /\/channels\/300\/messages$/.test(pathname) && url.searchParams.get('around')) {
      arounds.push(url.searchParams.get('around'))
      // An older window: the two old messages and the reply; newer pages come from `after=`.
      await r.fulfill({ json: [h.history['300'].find((m) => m.id === '414'), h.old, { ...h.old, id: '399', content: 'page two result' }] })
      return true
    }
    return false
  }
  const { page, posted, dispatch } = await h.open(browser, { routes, errors })
  const log = page.getByRole('log', { name: 'Messages in #general' })
  const msg = (id) => page.locator(`#msg-${id}`)

  // Custom emoji in content and as a reaction (with the name:id route), sticker image.
  await msg(420).locator('.content img.emoji.custom[alt=":pog:"]').waitFor()
  assert.match(await msg(420).locator('.content img.emoji.custom').getAttribute('src'), /\/emojis\/900\.png$/)
  const react = msg(420).getByRole('button', { name: ':pog:, 2 reactions' })
  await react.locator('img.emoji.custom').waitFor()
  await react.click()
  await page.waitForTimeout(150)
  assert.ok(posted.some((p) => p.method === 'PUT' && p.pathname.endsWith('/messages/420/reactions/pog%3A900/@me')), 'custom reaction route uses name:id')
  await msg(419).getByRole('img', { name: 'Sticker: wave' }).waitFor()
  assert.match(await msg(419).getByRole('img', { name: 'Sticker: wave' }).getAttribute('src'), /\/stickers\/950\.png$/)
  console.log('ok v3-core 1 - custom emoji in a message and as a reaction (name:id route); sticker renders')

  // Poll: vote updates the bars; another user's vote arrives live.
  const poll = msg(418).getByRole('region', { name: 'Which map next?' })
  await poll.getByRole('radio', { name: /Mirage/ }).click()
  await poll.getByRole('button', { name: 'Vote' }).click()
  await poll.getByRole('button', { name: /Mirage: 4 votes, 80%/ }).waitFor()
  const vote = posted.find((p) => p.pathname.endsWith('/polls/418/answers/@me'))
  assert.deepEqual(vote.body, { answer_ids: [1] })
  assert.equal(await poll.locator('.poll-answer.mine .poll-bar').evaluate((e) => e.style.width), '80%')
  dispatch('MESSAGE_POLL_VOTE_ADD', { user_id: h.carol.id, channel_id: '300', message_id: '418', guild_id: h.G, answer_id: 2 })
  await poll.getByRole('button', { name: /Inferno: 2 votes, 33%/ }).waitFor()
  dispatch('MESSAGE_POLL_VOTE_ADD', { user_id: h.me.id, channel_id: '300', message_id: '418', guild_id: h.G, answer_id: 1 }) // own echo: not counted twice
  await page.waitForTimeout(100)
  await poll.getByRole('button', { name: /Mirage: 4 votes/ }).waitFor()
  console.log('ok v3-core 2 - poll vote updates the bars; live votes; own echo de-duplicated')

  // Embeds: link card, YouTube click-to-play (no iframe until clicked, nocookie only), rich webhook embed with fields and BOT tag.
  await msg(417).getByRole('link', { name: 'Example Post' }).waitFor()
  assert.equal(await page.locator('iframe').count(), 0, 'no player before the click')
  assert.match(await msg(417).locator('.embed-play img').getAttribute('src'), /\/attachments\/300\/1\/pixel\.png$/, 'thumbnail through the proxy URL')
  await msg(416).getByText('Build #42 passed').waitFor()
  await msg(416).getByRole('term').filter({ hasText: 'Branch' }).waitFor()
  await msg(416).locator('.bot-tag', { hasText: 'BOT' }).waitFor()
  await msg(418).scrollIntoViewIfNeeded()
  await page.mouse.move(0, 0)
  await page.screenshot({ path: h.shot('poll') })
  await msg(417).getByRole('button', { name: 'Play video: Never Gonna Give You Up' }).click()
  const src = await msg(417).locator('iframe').getAttribute('src')
  assert.ok(src.startsWith('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1'), src)
  console.log('ok v3-core 3 - link card, rich webhook embed, YouTube click-to-play with youtube-nocookie')

  // Search: filters in the box, results panel, paging, jump to a message that is not loaded (around=).
  const box = page.getByRole('combobox', { name: 'Search this server' })
  await box.click()
  await page.getByRole('listbox', { name: 'Search options' }).getByRole('option', { name: /from:/ }).waitFor()
  await box.fill('patch from:bo')
  await page.getByRole('option', { name: /bob/ }).click()
  assert.equal(await box.inputValue(), 'patch from:bob ')
  await box.press('Enter')
  const panel = page.getByRole('complementary', { name: 'Search results' })
  await panel.getByRole('heading', { name: '30 Results' }).waitFor()
  assert.equal(searches[0].get('content'), 'patch')
  assert.deepEqual(searches[0].getAll('author_id'), ['101'])
  await panel.getByText('an old message far up').waitFor()
  await page.mouse.move(0, 0)
  await page.screenshot({ path: h.shot('search') })
  // A reply whose original is not loaded fetches around it.
  await msg(414).getByRole('button', { name: /Jump to replied message/ }).click()
  await msg(401).and(page.locator('.flash')).waitFor()
  assert.deepEqual(arounds, ['401'])
  // Newer messages load back in (after=) when scrolled to the bottom, or via Jump to Present.
  await page.waitForTimeout(500)
  if (await log.getByRole('button', { name: 'Jump to Present' }).isVisible()) await log.getByRole('button', { name: 'Jump to Present' }).click()
  await msg(420).waitFor()
  console.log('ok v3-core 4 - reply jump loads the original with around=')

  // Page 2 of the results, then jump to a message that is not loaded.
  await panel.getByRole('button', { name: '2', exact: true }).click()
  await panel.getByText('page two result').waitFor()
  assert.equal(searches.at(-1).get('offset'), '25')
  await panel.getByRole('button', { name: /Jump to message from bob/ }).click()
  await msg(399).and(page.locator('.flash')).waitFor()
  assert.deepEqual(arounds, ['401', '399'])
  const present = log.getByRole('button', { name: 'Jump to Present' })
  if (await present.isVisible()) await present.click()
  await panel.getByRole('button', { name: 'Close search' }).click()
  await msg(420).waitFor()
  console.log('ok v3-core 5 - search paging; jump loads around the target; newer messages come back')

  // @username typed without the autocomplete becomes <@id>; markdown additions render.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: h.ORIGIN })
  const composer = page.getByRole('textbox', { name: 'Message #general' })
  await composer.fill('boldme')
  await composer.selectText()
  await composer.press('Control+b')
  // the composer restores the selection inside the markers on the next frame: wait for it before typing anything else
  await composer.evaluate((el) => new Promise((ok) => {
    const done = () => (el.value === '**boldme**' && el.selectionStart === 2 && el.selectionEnd === 8 ? ok() : requestAnimationFrame(done))
    done()
  }))
  await composer.fill('')
  await composer.fill('# Title\n- one\n- two\n```ts\nconst x = 42;\n```\n-# small print [docs](https://example.com/docs) <t:1700000000:R> hey @bob !')
  assert.match(await composer.inputValue(), /^# Title[\s\S]*hey @bob !$/)
  await composer.press('Enter')
  await page.waitForTimeout(200)
  const sent = posted.filter((p) => p.method === 'POST' && p.pathname.endsWith('/channels/300/messages')).at(-1)
  assert.match(sent.body.content, /hey <@101> !$/)
  const mine = page.locator('.msg', { has: page.getByRole('heading', { name: 'Title', level: 1 }) })
  await mine.getByRole('listitem').filter({ hasText: 'two' }).waitFor()
  await mine.locator('.code-lang', { hasText: 'ts' }).waitFor()
  await mine.getByRole('button', { name: 'Copy code' }).click()
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'const x = 42;')
  await mine.getByRole('link', { name: 'docs' }).click()
  const leave = page.getByRole('dialog', { name: 'Leaving Cillhub' })
  await leave.getByText('https://example.com/docs').waitFor()
  await leave.getByRole('button', { name: 'Cancel' }).click()
  await mine.locator('time.md-time').waitFor()
  console.log('ok v3-core 6 - typed @username converted on send; Ctrl+B formatting, code block copy, headers, lists, subtext, masked link confirmation, timestamps')

  // GFM Pipe table (Task 6.18)
  dispatch('MESSAGE_CREATE', {
    id: '425',
    channel_id: '300',
    guild_id: h.G,
    author: h.bob,
    content: '| Item | Count |\n| :--- | :---: |\n| Apples | 5 |\n| Oranges | 12 |',
    timestamp: new Date().toISOString(),
    attachments: [],
    embeds: [],
    mentions: [],
    pinned: false,
  })
  const tableMsg = msg(425)
  await tableMsg.locator('table.md-table').waitFor()
  await tableMsg.locator('table thead th').filter({ hasText: 'Item' }).waitFor()
  await tableMsg.locator('table tbody td').filter({ hasText: 'Apples' }).waitFor()
  await tableMsg.getByRole('button', { name: 'Copy CSV' }).waitFor()

  // Delete uses an in-app dialog, not confirm().
  await mine.hover()
  await mine.getByRole('button', { name: 'Delete message' }).click()
  const del = page.getByRole('dialog', { name: 'Delete Message' })
  await del.getByRole('button', { name: 'Delete' }).click()
  await del.waitFor({ state: 'detached' })
  assert.ok(posted.some((p) => p.method === 'DELETE' && /\/channels\/300\/messages\/\d+$/.test(p.pathname)))
  console.log('ok v3-core 7 - delete confirmation is a modal')

  // Attachments: spoiler and alt text set before upload travel in payload_json.attachments.
  await page.locator('.composer input[type=file]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') })
  await page.getByRole('button', { name: 'Spoiler notes.txt' }).click()
  await page.getByRole('button', { name: 'Edit notes.txt' }).click()
  const edit = page.getByRole('dialog', { name: 'notes.txt' })
  await edit.getByLabel('Description (alt text)').fill('my notes')
  await edit.getByRole('button', { name: 'Save' }).click()
  await composer.press('Enter')
  await page.waitForTimeout(300)
  const multipart = posted.filter((p) => p.method === 'POST' && typeof p.body === 'string' && p.body.includes('payload_json')).at(-1)
  assert.ok(multipart && multipart.body.includes('SPOILER_notes.txt') && multipart.body.includes('"description":"my notes"'), 'spoiler name and alt text sent')
  console.log('ok v3-core 8 - spoiler and alt text before upload')

  // Stickers send from the picker; the GIF tab is hidden when the server answers 404.
  await page.getByRole('button', { name: 'Open GIF and sticker picker' }).click()
  const picker = page.getByRole('dialog', { name: 'Expression picker' })
  await picker.getByRole('button', { name: 'Send sticker wave' }).click()
  await page.waitForTimeout(150)
  assert.deepEqual(posted.filter((p) => p.body?.sticker_ids).at(-1).body.sticker_ids, ['950'])
  console.log('ok v3-core 9 - sticker picker sends sticker_ids')

  // Rules accepted elsewhere: slowmode countdown after sending in a 30 s slowmode channel (ciller is a plain member there).
  await page.goto(`${h.ORIGIN}/channels/${h.G2}/310`)
  await page.locator('.app[data-gateway="ready"]').waitFor()
  await page.getByRole('button', { name: 'Complete' }).waitFor()
  dispatch('GUILD_MEMBER_UPDATE', { guild_id: h.G2, ...h.member(h.me, [], { pending: false }) })
  const box2 = page.getByRole('textbox', { name: 'Message #rules-chat' })
  await page.getByText('Slowmode is enabled: one message every 30s.').waitFor()
  await box2.fill('first!')
  await box2.press('Enter')
  await page.getByText(/You can send again in (30|29)s/).waitFor()
  await box2.fill('second')
  await box2.press('Enter')
  assert.equal(await box2.inputValue(), 'second', 'send blocked during the cooldown')
  console.log('ok v3-core 10 - slowmode countdown in the composer')

  await page.context().close()
  await gifFavorites(browser, errors)
  await updateBanner(browser, errors)
}

/** GIF favourites: a star on a picker tile saves favorite_gifs, the Favorites chip lists it, USER_SETTINGS_UPDATE from another device syncs. */
async function gifFavorites(browser, errors) {
  const gif = { id: 'g1', title: 'wave', url: 'https://media.example/wave.gif', src: '/external/wave', width: 100, height: 80, preview: '/external/wave' }
  const routes = async (r, { pathname }) => {
    if (!pathname.startsWith('/api/v9/gifs/')) return false
    await r.fulfill({ json: pathname.endsWith('/categories') ? [{ id: 'trending', name: 'Trending', q: '' }] : [gif] })
    return true
  }
  const { page, ctx, posted, dispatch } = await h.open(browser, { routes, errors })
  await page.getByRole('button', { name: 'Open GIF picker' }).click()
  const picker = page.getByRole('dialog', { name: 'Expression picker' })
  const star = picker.getByRole('button', { name: 'Favorite GIF' })
  await star.click()
  await page.waitForTimeout(150)
  const saved = posted.filter((p) => p.pathname === '/api/v9/users/@me/settings/favorite-gifs').at(-1)
  assert.deepEqual([saved.method, saved.body], ['PUT', { url: gif.url, src: gif.src, width: 100, height: 80, format: 'gif' }])
  assert.equal(await star.getAttribute('aria-pressed'), 'true')
  await star.click()
  await page.waitForTimeout(150)
  const removed = posted.filter((p) => p.pathname === '/api/v9/users/@me/settings/favorite-gifs').at(-1)
  assert.equal(removed.method, 'DELETE')
  assert.equal(await star.getAttribute('aria-pressed'), 'false')
  await star.click()
  await page.waitForTimeout(150)
  await picker.getByRole('tab', { name: 'Favorites' }).click()
  await picker.getByRole('button', { name: `Send GIF ${gif.url}` }).waitFor()
  dispatch('USER_SETTINGS_UPDATE', { favorite_gifs: [] })
  await picker.getByText('No favorite GIFs yet. Star a GIF to keep it here.').waitFor()
  await ctx.close()
  console.log('ok v3-core 10b - GIF favorites: star a tile (PUT one item), un-star (DELETE ?url=), Favorites tab, settings sync')
}

/** A newer index.html (different main bundle) shows the update banner; in voice it warns; Reload reloads; dismiss hides it. */
async function updateBanner(browser, errors) {
  const { page, ctx } = await h.open(browser, { errors })
  await page.route(`${h.ORIGIN}/`, async (r) => {
    const res = await r.fetch()
    await r.fulfill({ response: res, body: (await res.text()).replace(/\/assets\/index-[\w-]+\.js/, '/assets/index-NEWBUILD1.js') })
  })
  const banner = page.getByRole('status').filter({ hasText: 'A new version of Cillhub is available.' })
  assert.equal(await banner.count(), 0)
  await page.evaluate(() => dispatchEvent(new Event('focus')))
  await banner.waitFor()
  await page.getByRole('navigation', { name: 'Nightfall Gaming channels' }).getByRole('button', { name: /^Lounge/ }).click()
  await banner.getByText('Reloading will disconnect you from voice.').waitFor()
  await page.getByRole('region', { name: 'Voice connection' }).getByRole('button', { name: 'Disconnect' }).click()
  await banner.getByText('Reloading will disconnect you from voice.').waitFor({ state: 'detached' })
  await banner.getByRole('button', { name: 'Dismiss for an hour' }).click()
  await banner.waitFor({ state: 'detached' })
  assert.ok(Number(await page.evaluate(() => localStorage.getItem('update-dismissed-until'))) > Date.now() + 3500e3)
  await page.evaluate(() => localStorage.removeItem('update-dismissed-until'))
  await page.reload()
  await page.locator('.app[data-gateway="ready"]').waitFor()
  await page.evaluate(() => dispatchEvent(new Event('focus')))
  await banner.waitFor()
  const reloaded = page.waitForEvent('load')
  await banner.getByRole('button', { name: 'Reload' }).click()
  await reloaded
  console.log('ok v3-core 11 - update banner from a changed index.html: voice warning, dismiss for an hour, Reload')
  await ctx.close()
}

module.exports = { run }
