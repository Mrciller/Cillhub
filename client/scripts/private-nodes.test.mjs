// Saved private nodes and add links (src/privateNodes.ts). Run: npm test (node strips the TypeScript types).
import test from 'node:test'
import assert from 'node:assert/strict'
import { addLink, addNode, cleanName, MAX_NODES, normalizeServerUrl, parseAddLink, parseNodes, tokenFor, keepSignIn, revocations, inSession } from '../src/privateNodes.ts'

test('addresses become origins; http only for localhost', () => {
  assert.equal(normalizeServerUrl('chat.example.org/'), 'https://chat.example.org')
  assert.equal(normalizeServerUrl('HTTPS://Chat.Example.org:443'), 'https://chat.example.org')
  assert.equal(normalizeServerUrl('http://localhost:3000/x'), 'http://localhost:3000') // login screen: path dropped as before
  assert.equal(normalizeServerUrl('http://127.0.0.1:3398', true), 'http://127.0.0.1:3398')
  assert.equal(normalizeServerUrl('xn--bcher-kva.example', true), 'https://xn--bcher-kva.example')
  assert.equal(normalizeServerUrl('bücher.example', true), 'https://xn--bcher-kva.example') // shown as punycode
  for (const bad of ['http://chat.example.org', 'ftp://a.b', ' ', 'javascript:alert(1)', 'https://', 'https://a b.org'])
    assert.equal(normalizeServerUrl(bad, true), null, bad)
})

test('strict: only an origin, no path, query, fragment or user info', () => {
  for (const bad of ['https://chat.example.org/x', 'https://chat.example.org/?a=1', 'https://chat.example.org?', 'https://chat.example.org#a',
    'https://user@chat.example.org', 'https://user:pw@evil.test', 'https://chat.example.org@evil.test'])
    assert.equal(normalizeServerUrl(bad, true), null, bad)
})

test('add: normalised, duplicates refused by origin, cap', () => {
  let list = addNode([], 'chat.example.org', 'Robin\u0007s node ')
  assert.deepEqual(list, [{ origin: 'https://chat.example.org', name: 'Robins node' }])
  assert.equal(addNode(list, 'https://CHAT.example.org/', 'x'), 'duplicate')
  assert.equal(addNode(list, 'https://chat.example.org:443', 'x'), 'duplicate')
  assert.equal(addNode(list, 'http://chat.example.org', 'x'), 'invalid')
  list = []
  for (let i = 0; i < MAX_NODES; i++) list = addNode(list, `n${i}.example.org`, '')
  assert.equal(list.length, 20)
  assert.equal(addNode(list, 'one-more.example.org', ''), 'full')
})

test('names are plain short text', () => {
  assert.equal(cleanName('<b>Kim</b>'), '<b>Kim</b>') // rendered as text, never as markup
  assert.equal(cleanName('x'.repeat(100)).length, 64)
  assert.equal(cleanName({ toString: () => 'x' }), '')
})

test('stored list: malformed entries and duplicates dropped, cap kept', () => {
  assert.deepEqual(parseNodes('nope'), [])
  assert.deepEqual(parseNodes('{"origin":"https://a.org"}'), [])
  assert.deepEqual(parseNodes(JSON.stringify([{ origin: 'https://a.org', name: 'A' }, { origin: 'https://a.org/', name: 'B' }, { origin: 'http://b.org' }, null, 3])),
    [{ origin: 'https://a.org', name: 'A' }])
  assert.equal(parseNodes(JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ origin: `https://n${i}.org`, name: '' })))).length, MAX_NODES)
})

test('add links: build and parse', () => {
  const link = addLink('https://hub.example.org/', 'https://node.example.org')
  assert.equal(link, 'https://hub.example.org/add-node#https://node.example.org')
  assert.equal(parseAddLink(new URL(link).hash), 'https://node.example.org')
  assert.equal(parseAddLink('#https%3A%2F%2Fnode.example.org'), 'https://node.example.org')
  assert.equal(parseAddLink('#node.example.org'), 'https://node.example.org')
  for (const bad of ['', '#', '#%E0%A4%A', '#https://node.example.org/evil', '#https://a@node.example.org', '#http://node.example.org', '#javascript:alert(1)'])
    assert.equal(parseAddLink(bad), null, bad)
})

test('a request carries only the token of the origin it goes to', () => {
  const hub = { origin: 'https://hub.example.org', token: 'hub-token' }
  const nodes = [{ url: 'https://a.example.org', token: 'a-token' }, { url: 'https://b.example.org', token: 'b-token' }]
  assert.equal(tokenFor('https://hub.example.org/api/v9/users/@me', hub, nodes), 'hub-token')
  assert.equal(tokenFor('https://a.example.org/api/v9/channels/1/messages', hub, nodes), 'a-token')
  assert.equal(tokenFor('https://b.example.org/api/v9/gateway', hub, nodes), 'b-token')
  // anything that is not exactly a known origin gets nothing: look-alike hosts, other ports, user info, http
  for (const url of ['https://a.example.org.evil.test/api', 'https://a.example.org:444/api', 'https://hub.example.org@a.example.org/api',
    'http://a.example.org/api', 'https://evil.test/https://a.example.org', 'not a url'])
    assert.notEqual(tokenFor(url, hub, nodes), 'hub-token', url)
  assert.equal(tokenFor('https://a.example.org:444/api', hub, nodes), null)
  assert.equal(tokenFor('https://hub.example.org@a.example.org/api', hub, nodes), 'a-token') // user info is not the host
  // a node entry whose address has a path or that claims another node's origin never gets a token
  assert.equal(tokenFor('https://a.example.org/api', hub, [...nodes, { url: 'https://a.example.org', token: 'dup' }]), null)
  assert.equal(tokenFor('https://c.example.org/api', hub, [{ url: 'https://c.example.org/x', token: 'c' }]), null)
  for (const n of nodes) for (const other of [hub.token, ...nodes.filter((x) => x !== n).map((x) => x.token)])
    assert.notEqual(tokenFor(`${n.url}/api/v9/users/@me`, hub, nodes), other)
})

test('a sign-in that finishes after logout, an account change or removal is not kept', () => {
  const saved = [{ origin: 'https://a.example.org', name: 'A' }]
  assert.equal(keepSignIn('1:100', '1:100', saved, 'https://a.example.org'), true)
  assert.equal(keepSignIn('1:100', '2:', saved, 'https://a.example.org'), false, 'logged out meanwhile')
  assert.equal(keepSignIn('1:100', '2:200', saved, 'https://a.example.org'), false, 'another account now, same node in its list')
  assert.equal(keepSignIn('1:100', '1:100', [], 'https://a.example.org'), false, 'node removed meanwhile')
  // the session is the stored hub token: another tab logging out ('') or in as someone else changes it
  assert.equal(keepSignIn('hub-token-a', '', saved, 'https://a.example.org'), false)
  assert.equal(keepSignIn('hub-token-a', 'hub-token-b', saved, 'https://a.example.org'), false)
})

test('F10: unconfirmed node sessions to end stay stored, survive a reload and stop on success, 401 or a final answer', async () => {
  let saved = null
  const store = { get: () => saved, set: (v) => (saved = v) }
  const calls = []
  let answers = []
  const send = async (url, token) => { calls.push([url, token]); const a = answers.shift(); if (a === 'net' || a === undefined) throw new Error('down'); return a }
  const e = { owner: 'https://hub.example.org 1', origin: 'https://a.example.org', token: 'tok' }
  answers = ['net', 500]
  assert.equal(await revocations(store, send, async () => {}, 2).add(e), false)
  assert.equal(JSON.parse(saved).length, 0, 'gave up after the tries')
  // a reload in the middle: the stored entry is resumed by a fresh queue
  saved = JSON.stringify([{ ...e, tries: 1 }])
  answers = [204]
  await revocations(store, send, async () => {}, 5).resume()
  assert.deepEqual(calls.at(-1), ['https://a.example.org/api/v9/auth/logout', 'tok'])
  assert.equal(JSON.parse(saved).length, 0, 'confirmed, so the token is gone from storage')
  answers = [403]
  assert.equal(await revocations(store, send, async () => {}).add(e), false)
  assert.equal(calls.filter(([, t]) => t === 'tok').length, 4, 'a final answer is not retried')
  saved = JSON.stringify([{ ...e, origin: 'https://a.example.org/x', tries: 0 }]) // only clean origins are resumed
  const before = calls.length
  await revocations(store, send, async () => {}).resume()
  assert.equal(calls.length, before)
})

test('list changes stop as soon as the hub session changed (logout or login, in any tab)', async () => {
  let token = 'hub-a'
  const done = []
  const step = (name, after) => async () => { done.push(name); if (after) token = after }
  assert.equal(await inSession('hub-a', () => token, [step('initial', 'hub-b'), step('add')]), false)
  assert.deepEqual(done, ['initial'], 'the add never runs with the new account')
  token = 'hub-a'
  assert.equal(await inSession('hub-a', () => token, [step('initial'), step('add')]), true)
  assert.deepEqual(done, ['initial', 'initial', 'add'])
  // F9: Remove confirmed after the tab switched account: the DELETE never goes out
  token = 'hub-b'
  assert.equal(await inSession('hub-a', () => token, [step('delete')]), false)
  assert.ok(!done.includes('delete'))
})

// ---------- A hostile node (src/instances/registry.ts: node ids in their own namespace) ----------
const mem = new Map()
globalThis.localStorage ??= { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) }
const reg = await import('../src/instances/registry.ts')
const { gatewayOk, safePath } = await import('../src/privateNodes.ts')
const sent = new Map()
const view = { voiceGuild: null }
reg.setView({ user: (id) => (id === '1' ? { id: '1', username: 'alex', avatar: 'hub' } : undefined), interaction: (n) => sent.get(n), consume: (n) => sent.delete(n), voiceGuild: () => view.voiceGuild })
reg.testNode('7', 'https://n1.example', '900', '1')
reg.testNode('8', 'https://n2.example', '950', '1')

test('F1: whatever a node answers or sends, its ids are its own: a hub channel id comes back scoped', () => {
  const ch = reg.admitRest('7', { id: '11', guild_id: '10', name: 'x' }) // a REST answer naming hub channel 11
  assert.deepEqual([ch.id, ch.guild_id], ['7:11', '7:10'])
  const m = reg.admit('7', 'MESSAGE_DELETE', { guild_id: '100', channel_id: '11', id: '5' })
  assert.deepEqual([m.channel_id, m.id], ['7:11', '7:5'], 'never the hub message 5 in hub channel 11')
  for (const t of ['RELATIONSHIP_REMOVE', 'USER_SETTINGS_UPDATE', 'CALL_CREATE', 'CHANNEL_RECIPIENT_ADD', 'INSTANCE_ANNOUNCEMENT', 'SAVED_MESSAGE_CREATE'])
    assert.equal(reg.admit('7', t, { guild_id: '100', id: '2' }), null, t)
})

test('F2: routing reads the prefix; a node cannot claim hub or other node ids at any time', () => {
  assert.equal(reg.route('/channels/7:101/messages'), '7')
  assert.equal(reg.route('/channels/11/messages'), undefined, 'bare = hub, whatever a node said before')
  assert.equal(reg.route('/channels/8:101/messages'), '8')
  assert.equal(reg.route('/users/@me/profile?guild_id=7:100'), '7')
  assert.equal(reg.outboundPath('7', '/channels/7:101/messages/7:5/reactions/party%3A7%3A55/@me?around=7:5'), '/channels/101/messages/5/reactions/party%3A55/@me?around=5')
  assert.equal(reg.route('/emojis/7:55.png'), '7')
  assert.equal(reg.outboundPath('7', '/emojis/7:55.png'), '/emojis/55.png')
})

test('F3: canonical string ids only; node users are scoped, our node account is our hub record', () => {
  assert.equal(reg.admitRest('7', [{ user: { id: 2, username: 'sam?' } }]), null, 'numeric id')
  assert.equal(reg.admitRest('7', [{ user: { id: '02x' } }]), null)
  const list = reg.admitRest('7', [{ user: { id: '2', username: 'not-sam' } }, { user: { id: '900', username: 'evil', avatar: 'node' } }])
  assert.equal(list[0].user.id, '7:2', 'cannot touch hub user 2')
  assert.deepEqual([list[1].user.id, list[1].user.username, list[1].user.avatar], ['1', 'alex', 'hub'])
  assert.equal(reg.admit('7', 'USER_UPDATE', { id: '900', username: 'evil' }), null)
})

test('F4: second targets in reducers are scoped too (voice channel status, event users, deletes)', () => {
  const v = reg.admit('7', 'VOICE_CHANNEL_STATUS_UPDATE', { channel_id: '101', id: '11', status: 'x' })
  assert.equal(v.id, '7:11')
  const e = reg.admit('7', 'GUILD_SCHEDULED_EVENT_USER_ADD', { guild_id: '100', guild_scheduled_event_id: '42', user_id: '900' })
  assert.deepEqual([e.guild_scheduled_event_id, e.user_id], ['7:42', '1'])
  const b = reg.admit('7', 'MESSAGE_DELETE_BULK', { channel_id: '101', ids: ['5', '6'] })
  assert.deepEqual(b.ids, ['7:5', '7:6'])
  const g = reg.admit('7', 'GUILD_CREATE', { id: '100', roles: [{ id: '100', name: '@everyone' }], members: [{ user: { id: '901' }, roles: ['3'] }], channels: [] })
  assert.deepEqual([g.roles[0].id, g.members[0].roles[0]], ['7:100', '7:3'], 'role objects and role id lists')
  assert.equal(reg.admit('7', 'GUILD_MEMBER_UPDATE', { guild_id: '100', user: { id: '901' }, roles: ['x'] }), null)
  const c = reg.admit('7', 'MESSAGE_CREATE', { channel_id: '101', id: '9', content: 'hi <@900> <@2> <#11> <:p:55> <@&3>', author: { id: '901' } })
  assert.equal(c.content, 'hi <@1> <@7:2> <#7:11> <:p:7:55> <@&7:3>')
  assert.equal(reg.outbound('7', { content: c.content }).content, 'hi <@900> <@2> <#11> <:p:55> <@&3>')
})

test('F5: a voice state of ours from a node only for that node', () => {
  assert.equal(reg.admit('7', 'VOICE_STATE_UPDATE', { user_id: '900', guild_id: '100', channel_id: '101', session_id: 'x' }).guild_id, '7:100')
  assert.equal(reg.admit('7', 'VOICE_STATE_UPDATE', { user_id: '900', channel_id: '101', session_id: 'x' }), null, 'no guild = a hub call')
})

test('F6: interaction answers only for an open interaction of the fitting kind in that node, consumed when terminal', () => {
  const modal = { nonce: '55', channel_id: '101', id: '56', custom_id: 'm', title: 'Password?', application: { id: '30' }, components: [] }
  assert.equal(reg.admit('7', 'INTERACTION_MODAL_CREATE', modal), null)
  sent.set('55', { channelId: '11', appId: '30', type: 2 })
  assert.equal(reg.admit('7', 'INTERACTION_MODAL_CREATE', modal), null, 'sent into a hub channel')
  sent.set('55', { channelId: '7:101', appId: '7:31', type: 2 })
  assert.equal(reg.admit('7', 'INTERACTION_MODAL_CREATE', modal), null, 'another application')
  sent.set('55', { channelId: '7:101', appId: '7:30', type: 4 })
  assert.equal(reg.admit('7', 'INTERACTION_MODAL_CREATE', modal), null, 'an autocomplete cannot open a modal')
  sent.set('55', { channelId: '7:101', appId: '7:30', type: 2 })
  assert.equal(reg.admit('8', 'INTERACTION_MODAL_CREATE', modal), null, 'another node')
  assert.ok(reg.admit('7', 'INTERACTION_MODAL_CREATE', modal))
  assert.equal(reg.admit('7', 'INTERACTION_MODAL_CREATE', modal), null, 'replay after the terminal answer')
})

test('F7: structural limits everywhere, also inside components and activities', () => {
  let deep = {}
  for (let i = 0; i < 40; i++) deep = { components: [deep] }
  assert.equal(reg.admit('7', 'MESSAGE_CREATE', { channel_id: '101', id: '8', components: [deep] }), null)
  assert.equal(reg.admit('7', 'PRESENCE_UPDATE', { user: { id: '901' }, activities: [{ party: Array.from({ length: reg.LIMITS.list + 1 }, () => 1) }] }), null)
  assert.equal(reg.admitRest('7', Array.from({ length: reg.LIMITS.list + 1 }, () => ({}))), null)
  assert.equal(gatewayOk('https://n1.example', 'ws://n1.example/gateway'), false)
})

test('F8: emoji ids in components and activities are snowflakes; CDN paths cannot walk out', () => {
  assert.equal(reg.admit('7', 'MESSAGE_CREATE', { channel_id: '101', id: '8', components: [{ type: 1, components: [{ type: 2, emoji: { id: '../api/v9/users/@me?x=' } }] }] }), null)
  assert.equal(reg.admit('7', 'PRESENCE_UPDATE', { user: { id: '901' }, activities: [{ type: 4, emoji: { id: '1/../../x' } }] }), null)
  const ok = reg.admit('7', 'MESSAGE_CREATE', { channel_id: '101', id: '8', components: [{ type: 1, id: 1, components: [{ type: 2, id: 2, custom_id: 'free text', emoji: { id: '55' } }] }] })
  assert.equal(ok.components[0].components[0].emoji.id, '7:55')
  assert.equal(safePath('/emojis/../api/v9/users/@me.png'), false)
  assert.equal(safePath('/emojis/7:55.png'), true)
})
