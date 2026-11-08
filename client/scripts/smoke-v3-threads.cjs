// v3 smoke: thread panel, thread members, threads popover, forum post list with tags, tag filter, new post.
const assert = require('node:assert/strict')
const h = require('./smoke-v3-harness.cjs')

async function run(browser, errors) {
  const { page, posted, dispatch, ctx } = await h.open(browser, {
    errors,
    routes: async (r, { pathname, method, body }) => {
      if (pathname === '/api/v9/channels/304/threads' && method === 'POST')
        return r.fulfill({ status: 201, json: { ...h.threads[1], id: '720', name: body.name, applied_tags: body.applied_tags, owner_id: '100', message_count: 1, member_count: 1, last_message_id: '720' } }), true
      if (pathname === '/api/v9/guilds/200/messages/search')
        return r.fulfill({ json: {
          total_results: 1,
          threads: [{ ...h.threads[0], id: '705', name: 'archived-notes', thread_metadata: { ...h.threads[0].thread_metadata, archived: true } }],
          messages: [[{ ...h.base('705'), id: '706', type: 0, author: h.bob, content: 'archived solution', hit: true }]],
        } }), true
      if (pathname === '/api/v9/channels/705/messages' && method === 'GET')
        return r.fulfill({ json: [{ ...h.base('705'), id: '706', type: 0, author: h.bob, content: 'archived solution' }] }), true
      if (/\/channels\/\d+\/thread-members$/.test(pathname) && method === 'GET')
        return r.fulfill({ json: [{ id: '700', user_id: '100', join_timestamp: h.iso(), flags: 0 }, { id: '700', user_id: '101', join_timestamp: h.iso(), flags: 0 }] }), true
      if (/\/threads\/archived\//.test(pathname)) return r.fulfill({ json: { threads: [], members: [], has_more: false } }), true
      return false
    },
  })
  const nav = page.getByRole('navigation', { name: 'Nightfall Gaming channels' })

  // Thread panel opens from the message that started it (chip), or from the joined thread under #general.
  await page.locator('#msg-415').waitFor()
  const chip = page.locator('#msg-415').getByRole('button', { name: /^Open thread patch notes talk/ })
  const fromChip = (await chip.count()) > 0
  if (fromChip) await chip.click()
  else await nav.getByRole('list', { name: 'Threads' }).getByRole('button', { name: 'patch notes talk' }).click()
  const panel = page.getByRole('complementary', { name: 'Thread patch notes talk' })
  await panel.getByText('what do we think about the patch?').waitFor()
  await panel.getByRole('textbox', { name: 'Message #patch notes talk' }).waitFor()
  assert.equal(await page.getByRole('complementary', { name: 'Members' }).count(), 0, 'the panel replaces the member list')
  await page.mouse.move(0, 0)
  await page.screenshot({ path: h.shot('thread') })
  console.log(`ok v3-threads - thread panel opens from ${fromChip ? 'the thread chip under the message' : 'the sidebar thread row (chip not rendered yet)'} and shows its messages`)

  await panel.getByRole('button', { name: 'Thread members' }).click()
  const members = page.getByRole('dialog', { name: 'Thread members' })
  await members.getByText('bob').waitFor()
  await page.keyboard.press('Escape')
  await panel.getByRole('button', { name: 'Close thread' }).click()
  await panel.waitFor({ state: 'detached' })
  console.log('ok v3-threads - thread members popover; close returns to the member list')

  await page.getByRole('main', { name: '#general' }).getByRole('button', { name: 'Threads', exact: true }).click()
  const pop = page.getByRole('dialog', { name: 'Threads' })
  await pop.getByRole('button', { name: /patch notes talk/ }).waitFor()
  await pop.getByRole('tab', { name: 'Archived' }).click()
  await pop.getByText('There are no archived threads.').waitFor()
  await page.keyboard.press('Escape')
  console.log('ok v3-threads - threads popover lists the active thread; archived tab loads')

  // Forum: post list with tags, filter, new post.
  await nav.getByRole('link', { name: 'help-forum' }).click()
  const forum = page.getByRole('main', { name: 'Forum help-forum' })
  const posts = forum.getByRole('list', { name: 'Posts' }).getByRole('listitem')
  await posts.filter({ hasText: 'How do I set up push to talk?' }).locator('.forum-tag', { hasText: 'Question' }).waitFor()
  await posts.filter({ hasText: 'Voice settings guide' }).locator('.forum-tag', { hasText: 'Guide' }).waitFor()
  await posts.filter({ hasText: 'Voice settings guide' }).getByText('Open User Settings, then Voice & Video.').waitFor()
  assert.equal(await posts.count(), 2)
  await page.mouse.move(0, 0)
  await page.screenshot({ path: h.shot('forum') })
  const filter = forum.getByRole('group', { name: 'Filter posts by tag' })
  await filter.getByRole('button', { name: 'Guide' }).click()
  await page.waitForFunction(() => document.querySelectorAll('[aria-label="Posts"] > li').length === 1)
  await filter.getByRole('button', { name: 'Guide' }).click()
  console.log('ok v3-threads - forum post list with tags and starter previews; tag filter narrows it')

  await forum.getByRole('button', { name: 'New Post' }).click()
  const form = forum.getByRole('form', { name: 'New post' })
  await form.getByLabel('Post Title').fill('Mic is too quiet')
  await form.getByLabel('Message').fill('Any tips?')
  await form.getByRole('group', { name: 'Tags for this post' }).getByRole('button', { name: 'Question' }).click()
  await form.getByRole('button', { name: 'Post', exact: true }).click()
  await page.getByRole('complementary', { name: 'Thread Mic is too quiet' }).waitFor()
  const sent = posted.find((p) => p.pathname === '/api/v9/channels/304/threads')
  assert.deepEqual({ name: sent.body.name, tags: sent.body.applied_tags, content: sent.body.message.content }, { name: 'Mic is too quiet', tags: ['801'], content: 'Any tips?' })
  console.log('ok v3-threads - new post sends POST /channels/304/threads with applied_tags and opens it')

  // Search hit in an archived thread not in READY: jumping from #news syncs the thread, switches to #general and opens its thread panel.
  await nav.getByRole('link', { name: 'news' }).click()
  const sbox = page.getByRole('main', { name: '#news' }).getByRole('combobox', { name: 'Search this server' })
  await sbox.fill('archived')
  await sbox.press('Enter')
  const spanel = page.getByRole('complementary', { name: 'Search results' })
  await spanel.getByRole('heading', { name: '#archived-notes' }).waitFor()
  await spanel.getByRole('button', { name: 'Jump to message from bob' }).click()
  await page.waitForURL('**/channels/200/300')
  const archPanel = page.getByRole('complementary', { name: 'Thread archived-notes' })
  await archPanel.locator('#msg-706.flash').waitFor()
  await archPanel.getByRole('button', { name: 'Close thread' }).click()
  console.log('ok v3-threads - search jump into archived thread syncs thread, navigates to parent channel and flashes hit')

  // 3-segment message URL (/channels/:guild/:channel/:message) jumps to the message and normalizes the URL.
  await page.evaluate(() => (history.pushState(null, '', '/channels/200/300/415'), dispatchEvent(new PopStateEvent('popstate'))))
  await page.waitForURL('**/channels/200/300')
  await page.locator('#msg-415.flash').waitFor()
  console.log('ok v3-threads - /channels/:guild/:channel/:message deep link jumps to and flashes the target message')

  // Live MESSAGE_UPDATE / MESSAGE_DELETE on a replied-to message updates the reply preview immediately.
  dispatch('MESSAGE_UPDATE', { id: '401', channel_id: '300', content: 'updated old message' })
  await page.locator('#msg-414 .reply-preview', { hasText: 'updated old message' }).waitFor()
  dispatch('MESSAGE_DELETE', { id: '401', channel_id: '300', guild_id: '200' })
  await page.locator('#msg-414 .reply-preview', { hasText: 'Original message was deleted' }).waitFor()
  console.log('ok v3-threads - live MESSAGE_UPDATE and MESSAGE_DELETE update reply previews')

  await ctx.close()
}

module.exports = { run }
