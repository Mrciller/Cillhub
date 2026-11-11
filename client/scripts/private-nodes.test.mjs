// Saved private nodes and add links (src/privateNodes.ts). Run: npm test (node strips the TypeScript types).
import test from 'node:test'
import assert from 'node:assert/strict'
import { addLink, addNode, cleanName, MAX_NODES, normalizeServerUrl, parseAddLink, parseNodes, tokenFor } from '../src/privateNodes.ts'

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
