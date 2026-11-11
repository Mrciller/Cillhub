// Saved private nodes and add links (src/privateNodes.ts). Run: npm test (node strips the TypeScript types).
import test from 'node:test'
import assert from 'node:assert/strict'
import { addLink, addNode, cleanName, MAX_NODES, normalizeServerUrl, parseAddLink, parseNodes, tokenFor, keepSignIn, revoker, inSession } from '../src/privateNodes.ts'

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

test('revoking a node session retries failures a few times and stops on success or 401', async () => {
  const run = async (answers, tries) => {
    const calls = []
    const ok = await revoker(async (url, token) => { calls.push([url, token]); const a = answers[calls.length - 1]; if (a === 'net') throw new Error('down'); return a }, async () => {}, tries)('https://a.example.org', 'tok')
    return [ok, calls.length, calls[0]]
  }
  assert.deepEqual(await run(['net', 500, 429, 204]), [true, 4, ['https://a.example.org/api/v9/auth/logout', 'tok']])
  assert.deepEqual((await run([401])).slice(0, 2), [true, 1])
  assert.deepEqual((await run([500, 500, 500], 3)).slice(0, 2), [false, 3])
  assert.deepEqual((await run([403])).slice(0, 2), [false, 1], 'a permanent refusal is not retried')
  assert.deepEqual((await run([400])).slice(0, 2), [false, 1])
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
})

// ---------- A hostile node (src/instances/registry.ts: the node boundary) ----------
const mem = new Map()
globalThis.localStorage ??= { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) }
const reg = await import('../src/instances/registry.ts')
const { gatewayOk, safePath } = await import('../src/privateNodes.ts')
const store = { channels: {}, users: { 1: { id: '1', username: 'alex' }, 2: { id: '2', username: 'sam' } }, interactions: {}, voiceGuild: null }
reg.setView({ channel: (id) => store.channels[id], user: (id) => store.users[id], interaction: (n) => store.interactions[n], voiceGuild: () => store.voiceGuild })
reg.testNode('n1', 'https://n1.example', '900', '1')
reg.testNode('n2', 'https://n2.example', '950', '1')
// the hub: guild 10 with channel 11, our user 1, friend 2
reg.hubSaw('READY', { user: { id: '1' }, users: [{ id: '2' }], guilds: [{ id: '10', channels: [{ id: '11', guild_id: '10' }] }], private_channels: [{ id: '12' }] })
store.channels[11] = { guild_id: '10' }
// node n1: guild 100 with channel 101
const n1Guild = { id: '100', name: 'Node', channels: [{ id: '101', guild_id: '100' }], members: [{ user: { id: '900', username: 'me-on-node' } }, { user: { id: '901', username: 'kim' } }] }
assert.ok(reg.admit('n1', 'GUILD_CREATE', n1Guild))
store.channels[101] = { guild_id: '100' }

test('N01: a node guild_id does not open hub channels or account-wide events', () => {
  assert.equal(reg.admit('n1', 'MESSAGE_DELETE', { guild_id: '100', channel_id: '11', id: '5' }), null)
  assert.equal(reg.admit('n1', 'CHANNEL_DELETE', { guild_id: '100', id: '11' }), null)
  assert.equal(reg.admit('n1', 'MESSAGE_ACK', { guild_id: '100', channel_id: '12', message_id: '5' }), null)
  for (const t of ['RELATIONSHIP_REMOVE', 'USER_SETTINGS_UPDATE', 'CALL_CREATE', 'CHANNEL_RECIPIENT_ADD', 'INSTANCE_ANNOUNCEMENT', 'SAVED_MESSAGE_CREATE'])
    assert.equal(reg.admit('n1', t, { guild_id: '100', channel_id: '101', id: '2' }), null, t)
  assert.ok(reg.admit('n1', 'MESSAGE_DELETE', { guild_id: '100', channel_id: '101', id: '5' }), 'its own channel works')
})

test('N02: READY, nested channels and join answers cannot overwrite hub or other node objects', () => {
  assert.equal(reg.admit('n1', 'READY', { user: { id: '900' }, guilds: [{ id: '10', channels: [] }] }), null)
  assert.equal(reg.admit('n2', 'GUILD_CREATE', { id: '200', channels: [{ id: '101' }] }), null, "another node's channel")
  assert.equal(reg.admit('n1', 'GUILD_CREATE', { id: '102', channels: [{ id: '103' }], stage_instances: [{ channel_id: '11' }] }), null)
  assert.equal(reg.admitGuild('n2', { id: '100', channels: [] }), false)
})

test('N03: hub claims win, survive deletion, and a node cannot preclaim or reclaim', () => {
  assert.ok(reg.admit('n1', 'CHANNEL_CREATE', { id: '104', guild_id: '100' }))
  assert.equal(reg.route('/channels/104/messages'), 'n1')
  reg.hubSaw('CHANNEL_CREATE', { id: '104', guild_id: '10' }) // the hub introduces the same id
  assert.equal(reg.route('/channels/104/messages'), undefined)
  delete store.channels[11] // the hub channel is gone from the store
  assert.equal(reg.admit('n1', 'CHANNEL_CREATE', { id: '11', guild_id: '100' }), null)
  assert.equal(reg.route('/channels/11/messages'), undefined)
  store.channels[11] = { guild_id: '10' }
  assert.equal(reg.admit('n1', 'MESSAGE_CREATE', { channel_id: '11', id: '7', other_id: '555' }), null)
  assert.equal(reg.nodeOf('555'), undefined, 'rejected payloads claim nothing, and only typed ids are claimed')
})

test('N04: node users never replace hub users or our own record', () => {
  assert.equal(reg.admit('n1', 'USER_UPDATE', { id: '2', username: 'not-sam' }), null)
  assert.equal(reg.admit('n1', 'GUILD_MEMBER_ADD', { guild_id: '100', user: { id: '2', username: 'not-sam' } }), null)
  assert.equal(reg.admitRest('n1', [{ user: { id: '2', username: 'x' } }]), null)
  const self = reg.admitRest('n1', [{ user: { id: '900', username: 'evil' } }])
  assert.deepEqual(self[0].user, { id: '1', username: 'alex' }, 'our node account shows as our hub record')
  assert.equal(reg.admit('n2', 'USER_UPDATE', { id: '901', username: 'taken' }), null, "another node's user")
})

test('N05: ids are numeric snowflakes and paths cannot walk out', () => {
  assert.equal(reg.admit('n1', 'MESSAGE_CREATE', { channel_id: '101', id: '../../../guilds/10' }), null)
  assert.equal(reg.admitRest('n1', { id: '1', guild_id: '10%2f..' }), null)
  assert.equal(reg.admitRest('n1', { role_ids: ['1', 'x'] }), null)
  assert.equal(safePath('/channels/11/messages/../../../guilds/10'), false)
  assert.equal(safePath('/channels/11/messages/%2e%2e'), false)
  assert.equal(safePath('/channels/11/messages/12?around=13'), true)
})

test('N06: voice signalling only for the call on that node', () => {
  store.voiceGuild = '10'
  assert.equal(reg.admit('n1', 'CILLVOICE_ERROR', { code: 1 }), null)
  store.voiceGuild = '100'
  assert.ok(reg.admit('n1', 'CILLVOICE_TRACKS', { tracks: [] }))
  assert.equal(reg.admit('n2', 'CILLVOICE_ANSWER', { sdp: 'x' }), null)
  store.voiceGuild = null
})

test('N07: modals and interaction answers only for an interaction we sent to that node', () => {
  const modal = { nonce: '55', channel_id: '101', id: '56', custom_id: 'm', title: 'Password?', components: [] }
  assert.equal(reg.admit('n1', 'INTERACTION_MODAL_CREATE', modal), null)
  store.interactions[55] = { channelId: '11' }
  assert.equal(reg.admit('n1', 'INTERACTION_MODAL_CREATE', modal), null, 'sent to a hub channel')
  store.interactions[55] = { channelId: '101' }
  assert.ok(reg.admit('n1', 'INTERACTION_MODAL_CREATE', modal))
  assert.equal(reg.admit('n2', 'INTERACTION_MODAL_CREATE', modal), null)
})

test('N08: size, depth and list bounds; gateway only on the node, wss for https', () => {
  let deep = {}
  for (let i = 0; i < 40; i++) deep = { x: deep }
  assert.equal(reg.admit('n1', 'MESSAGE_CREATE', { channel_id: '101', id: '8', embeds: [deep] }), null)
  assert.equal(reg.admitRest('n1', Array.from({ length: reg.LIMITS.list + 1 }, () => ({}))), null)
  assert.equal(gatewayOk('https://n1.example', 'wss://n1.example/gateway'), true)
  assert.equal(gatewayOk('https://n1.example', 'ws://n1.example/gateway'), false)
  assert.equal(gatewayOk('https://n1.example', 'wss://n1.example:8443/gateway'), false)
  assert.equal(gatewayOk('https://n1.example', 'wss://evil.example/gateway'), false)
  assert.equal(gatewayOk('http://127.0.0.1:3394', 'ws://127.0.0.1:3394/gateway'), true)
  // removing a node drops its claims
  reg.removeInstance('n2')
  reg.testNode('n2', 'https://n2.example', '950', '1')
  assert.ok(reg.admit('n2', 'GUILD_CREATE', { id: '300', channels: [{ id: '301' }] }))
  reg.removeInstance('n2')
  assert.equal(reg.nodeOf('300'), undefined)
})
