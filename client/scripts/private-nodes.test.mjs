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
const view = { voiceGuild: null, channels: { '7~101': { guild_id: '7~100' } } }
const HUB_ME = { id: '1', username: 'alex', global_name: 'Alex', avatar: 'hub' }
reg.setView({ user: (id) => (id === '1' ? HUB_ME : undefined), channel: (id) => view.channels[id], interaction: (n) => sent.get(n), consume: (n) => sent.delete(n), voiceGuild: () => view.voiceGuild })
reg.testNode('7', 'https://n1.example', '900', '1')
reg.testNode('8', 'https://n2.example', '950', '1')

test('F1/F2: a node only ever names its own scoped ids; routing reads the first id of the path', () => {
  const ch = reg.admitRest('7', { id: '11', guild_id: '10', name: 'x' })
  assert.deepEqual([ch.id, ch.guild_id], ['7~11', '7~10'])
  for (const t of ['RELATIONSHIP_REMOVE', 'USER_SETTINGS_UPDATE', 'CALL_CREATE', 'CHANNEL_RECIPIENT_ADD', 'INSTANCE_ANNOUNCEMENT', 'SAVED_MESSAGE_CREATE'])
    assert.equal(reg.admit('7', t, { guild_id: '100', id: '2' }), null, t)
  assert.equal(reg.route('/channels/7~101/messages'), '7')
  assert.equal(reg.route('/channels/11/messages'), undefined)
  assert.equal(reg.route('/users/@me/profile?guild_id=7~100'), '7')
})

test('3: any user object naming our node account becomes our hub record, whole', () => {
  const d = reg.admit('7', 'GUILD_MEMBER_UPDATE', { guild_id: '100', user: { id: '900', global_name: 'spoof' }, roles: [] })
  assert.deepEqual(d.user, HUB_ME)
  assert.notEqual(d.user, HUB_ME, 'a copy, not the store object')
})

test('4: every node event needs its own guild or channel; id lists are lists of snowflake strings', () => {
  assert.equal(reg.admit('7', 'USER_GUILD_SETTINGS_UPDATE', { guild_id: null, muted: true }), null)
  assert.equal(reg.admit('7', 'MESSAGE_DELETE_BULK', { channel_id: '101', guild_id: '100', ids: '5' }), null)
  assert.equal(reg.admit('7', 'MESSAGE_DELETE_BULK', { channel_id: '101', guild_id: '100', ids: [5] }), null)
  assert.deepEqual(reg.admit('7', 'MESSAGE_DELETE_BULK', { channel_id: '101', guild_id: '100', ids: ['5'] }).ids, ['7~5'])
  assert.ok(reg.admit('7', 'MESSAGE_ACK', { channel_id: '101', message_id: '5' }), 'guild from the known channel')
  assert.equal(reg.admit('7', 'MESSAGE_ACK', { channel_id: '102', message_id: '5' }), null, 'unknown channel, no guild')
  const g = reg.admit('7', 'GUILD_CREATE', { id: '100', roles: [{ id: '100' }], members: [{ user: { id: '901' }, roles: ['3'] }], channels: [] })
  assert.deepEqual([g.roles[0].id, g.members[0].roles[0]], ['7~100', '7~3'])
})

test('5: voice signalling and voice servers only for the call on that node (DM calls included)', () => {
  view.voiceGuild = null // a hub DM call
  assert.equal(reg.admit('7', 'VOICE_SERVER_UPDATE', { guild_id: null, endpoint: null }), null)
  assert.equal(reg.admit('7', 'CILLVOICE_ERROR', { message: 'x' }), null)
  view.voiceGuild = '7~100'
  assert.ok(reg.admit('7', 'VOICE_SERVER_UPDATE', { guild_id: '100', endpoint: '/lk', token: 't' }))
  assert.equal(reg.admit('8', 'CILLVOICE_TRACKS', { tracks: [] }), null)
  assert.deepEqual(reg.admit('7', 'CILLVOICE_SPEAKING', { speaking: ['900', '901'] }).speaking, ['1', '7~901'])
  assert.equal(reg.admit('7', 'VOICE_STATE_UPDATE', { user_id: '900', channel_id: '101', session_id: 'x' }), null, 'no guild = refused')
  view.voiceGuild = null
})

test('6: a modal shows where we sent the interaction and names our application, whatever the node says', () => {
  sent.set('55', { channelId: '7~101', appId: '7~30', type: 2 })
  const m = reg.admit('7', 'INTERACTION_MODAL_CREATE', { nonce: '55', id: '56', custom_id: 'm', title: 'Password?', application: { id: '31', name: 'Bank' }, components: [] })
  assert.deepEqual([m.channel_id, m.application.id], ['7~101', '7~30'])
  assert.equal(reg.admit('7', 'INTERACTION_MODAL_CREATE', { nonce: '55', id: '57', custom_id: 'm', title: 'x', components: [] }), null, 'used up')
  sent.set('56', { channelId: '7~101', appId: '7~30', type: 5 })
  assert.equal(reg.admit('7', 'INTERACTION_MODAL_CREATE', { nonce: '56', components: [] }), null, 'a modal submit cannot open another modal')
})

test('7: one id budget per node; past it the payload is refused and the node is over budget', () => {
  reg.testNode('9', 'https://n3.example', '990', '1')
  assert.ok(reg.admit('9', 'READY', { user: { id: '990' }, guilds: [] }))
  const big = Array.from({ length: 5000 }, (_, i) => ({ id: String(i + 1) }))
  let refused = false
  for (let i = 0; i < 60 && !refused; i++) refused = reg.admitRest('9', big.map((x) => ({ id: String(Number(x.id) + i * 5000) }))) === null
  assert.ok(refused && reg.overBudget('9'))
  reg.admit('9', 'READY', { user: { id: '990' }, guilds: [] })
  assert.equal(reg.overBudget('9'), false, 'a new READY starts again')
})

test('11: only user references alias to us; a channel with our node user id stays scoped', () => {
  const c = reg.admit('7', 'CHANNEL_CREATE', { id: '900', guild_id: '100', owner_id: '900', type: 0 })
  assert.deepEqual([c.id, c.owner_id], ['7~900', '1'])
  assert.equal(reg.route(`/channels/${c.id}/messages`), '7')
})

test('12: forged prefixed tokens neutralised; component default values and emoji typed; numeric emoji ids refused', () => {
  const m = reg.admit('7', 'MESSAGE_CREATE', { channel_id: '101', guild_id: '100', id: '9', content: 'a <@8~950> b <#8~1> c <@900> <:x:55>', author: { id: '901' },
    components: [{ type: 1, id: 1, components: [{ type: 5, id: 2, custom_id: 'pick', default_values: [{ id: '900', type: 'user' }, { id: '3', type: 'role' }], emoji: { id: '55' } }] }] })
  assert.equal(m.content, 'a ‹@8~950› b ‹#8~1› c <@1> <:x:7~55>')
  const sel = m.components[0].components[0]
  assert.deepEqual([sel.default_values[0].id, sel.default_values[1].id, sel.emoji.id], ['1', '7~3', '7~55'])
  assert.equal(reg.admit('7', 'MESSAGE_CREATE', { channel_id: '101', guild_id: '100', id: '9', components: [{ type: 2, emoji: { id: 55 } }] }), null)
})

test('13: multipart and JSON bodies route by their channel and go out in the node ids', () => {
  const payload = { type: 2, channel_id: '7~101', application_id: '7~30', data: { id: '7~40' }, message_reference: { message_id: '7~5' }, content: 'hi <@7~901> <@1>' }
  assert.equal(reg.route('/interactions', payload), '7')
  assert.deepEqual(reg.outbound('7', payload), { type: 2, channel_id: '101', application_id: '30', data: { id: '40' }, message_reference: { message_id: '5' }, content: 'hi <@901> <@900>' })
})

test('14: the endpoint primary resource decides; emoji segments never do; mismatched ids are refused (hub emoji named with digits works)', () => {
  assert.equal(reg.route('/channels/11/messages/12/reactions/123:55/@me'), undefined, 'hub emoji named 123 on a hub message: hub')
  assert.equal(reg.pathFits('/channels/11/messages/12/reactions/123:55/@me', undefined), true)
  assert.equal(reg.route('/channels/11/messages/12/reactions/x:7~55/@me'), undefined)
  assert.equal(reg.pathFits('/channels/11/messages/12/reactions/x:7~55/@me', undefined), false, 'node emoji on a hub message')
  assert.equal(reg.pathFits('/channels/7~101/messages/7~12/reactions/x:55/@me', '7'), false, 'hub emoji on a node message')
  assert.equal(reg.pathFits('/channels/7~101/messages/7~12/reactions/x:7~55/@me', '7'), true)
  assert.equal(reg.pathFits('/channels/7~101/messages/8~12', '7'), false, "another node's id")
  assert.equal(reg.outboundPath('7', '/channels/7~101/messages/7~12/reactions/x%3A7~55/@me?around=7~5'), '/channels/101/messages/12/reactions/x%3A55/@me?around=5')
  assert.equal(reg.outboundPath('7', '/channels/17~5'), '/channels/17~5', 'only whole prefixes')
  assert.equal(reg.route('/emojis/7~55.png'), '7')
})

test('15: id-keyed maps go out with bare keys', () => {
  assert.deepEqual(reg.outbound('7', { channel_overrides: { '7~101': { muted: true }, '8~1': {} } }).channel_overrides, { 101: { muted: true }, '8~1': {} })
})

test('limits everywhere; gateway only on the node; CDN paths cannot walk out', () => {
  let deep = {}
  for (let i = 0; i < 40; i++) deep = { components: [deep] }
  assert.equal(reg.admit('7', 'MESSAGE_CREATE', { channel_id: '101', guild_id: '100', id: '8', components: [deep] }), null)
  assert.equal(reg.admitRest('7', [{ user: { id: 2 } }]), null, 'numeric id')
  assert.equal(gatewayOk('https://n1.example', 'ws://n1.example/gateway'), false)
  assert.equal(safePath('/emojis/../api/v9/users/@me.png'), false)
})

test('r4-4: a node cannot set our presence or activities, in any payload', () => {
  const g = reg.admit('7', 'GUILD_CREATE', { id: '100', channels: [], presences: [{ user: { id: '900' }, status: 'offline', activities: [{ name: 'x' }] }, { user: { id: '901' }, status: 'online' }] })
  assert.deepEqual(g.presences.map((p) => p.user.id), ['7~901'])
  const r = reg.admit('7', 'READY', { user: { id: '900' }, guilds: [{ id: '100', channels: [], presences: [{ user: { id: '900' }, status: 'dnd' }] }], presences: [{ user: { id: '900' }, status: 'idle' }] })
  assert.deepEqual([r.presences.length, r.guilds[0].presences.length], [0, 0])
  assert.equal(reg.admit('7', 'PRESENCE_UPDATE', { user: { id: '900' }, status: 'offline', guild_id: '100' }), null)
})

test('r4-7: a node server that leaves takes its users, presences and activities along, unless another server of that node holds them', () => {
  const users = { 1: 'hub-me', 2: 'hub-sam', '7~901': 'kim', '7~902': 'jordan', '8~901': 'other node' }
  assert.deepEqual(Object.keys(reg.pruneNode('7', users, new Set(['7~902']))).sort(), ['1', '2', '7~902', '8~901'])
})

test('r4-12: LiveKit identities of a node room are that node user ids', () => {
  assert.equal(reg.nodeUserId('7', '900'), '1', 'our node account')
  assert.equal(reg.nodeUserId('7', '2'), '7~2', 'never the hub user 2')
  assert.equal(reg.nodeUserId('7', '8~950'), null)
  assert.equal(reg.nodeUserId('7', 'x'), null)
  assert.equal(reg.nodeUserId(undefined, '2'), '2', 'a hub room keeps hub ids')
})

test('r4-16: our hub id becomes our node id only in user positions, never in a stripped resource id', () => {
  assert.equal(reg.outboundPath('7', '/channels/7~1/messages'), '/channels/1/messages', 'a node channel whose id equals our hub id')
  assert.equal(reg.outboundPath('7', '/guilds/7~100/members/1'), '/guilds/100/members/900')
  assert.equal(reg.outboundPath('7', '/guilds/7~100/members/7~1'), '/guilds/100/members/1')
  assert.deepEqual(reg.outbound('7', { channel_id: '7~1', user_id: '1', author: { id: '1' }, target: { id: '1' } }), { channel_id: '1', user_id: '900', author: { id: '900' }, target: { id: '1' } })
})

test('r4-17: forwards and other references only within one server', () => {
  const fwd = (ref) => ({ message_reference: { type: 1, ...ref } })
  assert.equal(reg.bodyFits(fwd({ message_id: '5', channel_id: '11' }), '7'), false, 'hub message forwarded to a node')
  assert.equal(reg.bodyFits(fwd({ message_id: '7~5', channel_id: '7~101' }), undefined), false, 'node message forwarded to the hub')
  assert.equal(reg.bodyFits(fwd({ message_id: '8~5', channel_id: '8~1' }), '7'), false, 'another node')
  assert.equal(reg.bodyFits(fwd({ message_id: '7~5', channel_id: '7~101' }), '7'), true)
  assert.equal(reg.bodyFits({ content: 'x', attachments: [{ id: '0' }], user_id: '1' }, '7'), true, 'upload slots and our own user id')
  assert.equal(reg.bodyFits({ guild_folders: [{ id: 1, guild_ids: ['7~100'] }] }, undefined), true, 'hub settings list node servers')
})

test('r5-7: a refused READY keeps the budget; every store map is either pruned per node or never node-written', async () => {
  reg.testNode('6', 'https://n6.example', '960', '1')
  for (let i = 0; i < 3; i++) reg.admitRest('6', Array.from({ length: 5000 }, (_, j) => ({ id: String(i * 5000 + j + 1) })))
  assert.equal(reg.admit('6', 'READY', { id: 'bad' }), null)
  reg.LIMITS.budget = 14_000
  assert.equal(reg.overBudget('6'), true, 'the refused READY did not reset what the node already brought')
  reg.LIMITS.budget = 200_000
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/store.ts', import.meta.url), 'utf8')
  const type = src.slice(src.indexOf('export type State = {'), src.indexOf('\n}\n', src.indexOf('export type State = {')))
  const keys = [...type.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1])
  const listed = new Set([...reg.NODE_MAPS, ...reg.HUB_STATE])
  assert.deepEqual(keys.filter((k) => !listed.has(k)), [], 'a new State key must be added to NODE_MAPS (pruned per node) or HUB_STATE')
  assert.deepEqual(reg.NODE_MAPS.filter((k) => reg.HUB_STATE.includes(k)), [])
})

test('r5-12: a voice join that a leave or switch overtook while livekit-client loaded goes no further', async () => {
  const { joins } = await import('../src/voice/join.ts')
  const join = joins()
  let release
  const slow = join.start(() => new Promise((r) => (release = r)))
  join.bump() // the user left or switched calls
  release('lib')
  assert.equal(await slow, null)
  const fresh = await join.start(async () => 'lib')
  assert.equal(fresh.lib, 'lib')
  assert.equal(fresh.live(), true)
  join.bump()
  assert.equal(fresh.live(), false)
})

test('r5-18: a member sent next to user_id must be that user, or it is dropped', () => {
  view.voiceGuild = null
  const v = reg.admit('7', 'VOICE_STATE_UPDATE', { guild_id: '100', channel_id: '101', user_id: '900', session_id: 's', member: { user: { id: '666', username: 'attacker' } } })
  assert.equal(v.user_id, '1')
  assert.equal(v.member, undefined)
  const ok = reg.admit('7', 'VOICE_STATE_UPDATE', { guild_id: '100', channel_id: '101', user_id: '901', session_id: 's', member: { user: { id: '901' } } })
  assert.equal(ok.member.user.id, '7~901')
})

test('r5-17: references in id lists, map keys and text tokens must fit the target server too', () => {
  assert.equal(reg.bodyFits({ sticker_ids: ['5'] }, '7'), false, 'a hub sticker to a node')
  assert.equal(reg.bodyFits({ sticker_ids: ['7~5'] }, undefined), false, 'a node sticker to the hub')
  assert.equal(reg.bodyFits({ sticker_ids: ['7~5'] }, '7'), true)
  assert.equal(reg.bodyFits({ content: 'hi <@2>' }, '7'), false, 'a hub user mentioned on a node')
  assert.equal(reg.bodyFits({ content: 'hi <@1> <@7~901> <:x:7~55>' }, '7'), true)
  assert.equal(reg.bodyFits({ content: '<:x:7~55>' }, undefined), false, 'a node emoji in a hub message')
  assert.equal(reg.bodyFits({ channel_overrides: { '8~1': {} } }, '7'), false)
  assert.equal(reg.bodyFits({ guild_positions: ['7~100', '10'], guild_folders: [{ guild_ids: ['8~1'] }] }, undefined), true, 'hub rail settings')
})

test('r5-19: mentions go out in one pass: a node user whose id equals our hub id stays that user', () => {
  assert.equal(reg.outbound('7', { content: '<@7~1> <@1> <@!7~1>' }).content, '<@1> <@900> <@!1>')
})

test('r5-20: call participants are users; poll answer numbers are not snowflakes', () => {
  const m = reg.admit('7', 'MESSAGE_CREATE', { channel_id: '101', guild_id: '100', id: '9', author: { id: '901' }, call: { participants: ['900', '901'] },
    poll: { answers: [{ answer_id: 1, poll_media: { text: 'a' } }], results: { answer_counts: [{ id: 1, count: 2, me_voted: false }] } } })
  assert.deepEqual(m.call.participants, ['1', '7~901'])
  assert.deepEqual([m.poll.answers[0].answer_id, m.poll.results.answer_counts[0].id], [1, 1])
})

test('r6-7: a node ack can only be ours; other people\'s read marks are the hub\'s', () => {
  assert.equal(reg.admit('7', 'MESSAGE_ACK', { channel_id: '101', guild_id: '100', message_id: '5', user_id: '901' }), null)
  assert.ok(reg.admit('7', 'MESSAGE_ACK', { channel_id: '101', guild_id: '100', message_id: '5', user_id: '900' }))
  assert.ok(reg.admit('7', 'MESSAGE_ACK', { channel_id: '101', guild_id: '100', message_id: '5' }))
})

test('r6-21: cillvoice track ids are opaque: scoped in, the same id out', () => {
  view.voiceGuild = '7~100'
  const tr = reg.admit('7', 'CILLVOICE_TRACKS', { channel_id: '101', tracks: [{ id: '901-0', user_id: '901', kind: 'audio', source: 'microphone' }, { id: '900-1', user_id: '900', kind: 'video', source: 'camera' }] })
  assert.deepEqual(tr.tracks.map((t) => [t.id, t.user_id]), [['7~901-0', '7~901'], ['7~900-1', '1']])
  const ans = reg.admit('7', 'CILLVOICE_ANSWER', { channel_id: '101', sdp: 'v=0', subscribed: [{ mid: '3', track_id: '901-0', user_id: '901', source: 'microphone' }], tracks: [] })
  assert.equal(ans.subscribed[0].track_id, '7~901-0')
  assert.deepEqual(reg.outbound('7', { subscribe: [{ mid: '3', track_id: '7~901-0' }] }), { subscribe: [{ mid: '3', track_id: '901-0' }] })
  assert.equal(reg.admit('7', 'CILLVOICE_TRACKS', { tracks: [{ id: '../x' }] }), null)
  view.voiceGuild = null
})

test('r6-20: a READY and a quiz poll from a real current server pass (numeric font, effect, answer ids)', async () => {
  const { readFileSync } = await import('node:fs')
  const fx = JSON.parse(readFileSync(new URL('./fixtures/node-payloads.json', import.meta.url), 'utf8'))
  reg.testNode('5', 'https://n5.example', fx.ready.user.id, '1')
  const r = reg.admit('5', 'READY', fx.ready)
  assert.ok(r, 'READY with display name styles')
  assert.equal(r.user.id, '1')
  const m = reg.admitRest('5', fx.message)
  assert.ok(m, 'quiz poll message')
  assert.equal(m.poll.correct_answer_id, 1)
  const styled = JSON.stringify(r).match(/"font_id":(\d+)/)
  assert.ok(styled, 'the other member keeps its numeric display name style')
  assert.ok(reg.admit('5', 'VOICE_CHANNEL_EFFECT_SEND', { channel_id: '1', guild_id: '2', user_id: '3', animation_id: 0, emoji: null }) !== undefined)
})

test('r6-22: screen share start/switch see a leave or switch through the join generation', async () => {
  const { joins } = await import('../src/voice/join.ts')
  const join = joins()
  const g = join.now()
  join.bump()
  assert.notEqual(join.now(), g, 'a start begun before the leave is stale')
})

test('r6-23: who edited, created or added something is a typed user reference', () => {
  const c = reg.admit('7', 'CHANNEL_CANVAS_UPDATE', { channel_id: '101', guild_id: '100', updated_by: '2', content: 'x' })
  assert.equal(c.updated_by, '7~2', 'never hub user 2')
  assert.equal(reg.admit('7', 'CHANNEL_CANVAS_UPDATE', { channel_id: '101', guild_id: '100', updated_by: '900' }).updated_by, '1')
  const w = reg.admit('7', 'WATCH_SESSION_UPDATE', { channel_id: '101', guild_id: '100', host_id: '901', queue: [{ video_id: 'abc', title: 't', added_by: '2' }] })
  assert.equal(w.queue[0].added_by, '7~2')
  const i = reg.admitRest('7', { code: 'x', inviter: { id: '900', username: 'evil' }, created_by: '2' })
  assert.deepEqual([i.inviter.username, i.created_by], ['alex', '7~2'])
})

test('r6-17: attachment descriptions and poll texts go through the reference check too', () => {
  assert.equal(reg.bodyFits({ content: '', attachments: [{ id: '0', description: 'see <@2>' }] }, '7'), false)
  assert.equal(reg.bodyFits({ attachments: [{ id: '0', description: 'fine' }] }, '7'), true)
  assert.equal(reg.bodyFits({ poll: { question: { text: '<@7~901>?' }, answers: [] } }, undefined), false)
})
