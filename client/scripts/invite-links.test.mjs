// Invite link detection (src/chat/inviteLinks.ts). Run: npm test (node strips the TypeScript types).
import test from 'node:test'
import assert from 'node:assert/strict'
import { inviteCodes, onlyInvite } from '../src/chat/inviteLinks.ts'

const hub = 'https://hub.example.org'

test('links of this hub are found, each code once', () => {
  assert.deepEqual(inviteCodes(`join https://hub.example.org/invite/hTKzmakQ now`, hub), ['hTKzmakQ'])
  assert.deepEqual(inviteCodes(`${hub}/invite/abc ${hub}/invite/abc (${hub}/invite/my-club_2).`, hub), ['abc', 'my-club_2'])
  assert.deepEqual(inviteCodes(`<${hub}/invite/abcDEF12>`, hub), ['abcDEF12'])
  assert.deepEqual(inviteCodes(`${hub}/invite/abc`, `${hub}/`), ['abc']) // origin with a trailing slash
})

test('other hosts and look-alikes are no match', () => {
  for (const s of [
    'https://other.example.org/invite/abcDEF12',
    'https://hub.example.org.evil.test/invite/abcDEF12',
    'http://hub.example.org/invite/abcDEF12', // other scheme, other origin
    'https://evil.test/?u=https://hub.example.org/invite/abcDEF12',
    'xhttps://hub.example.org/invite/abcDEF12',
    `${hub}/invite/abcDEF12/extra`,
    `${hub}/invites/abcDEF12`,
    'abcDEF12',
  ]) assert.deepEqual(inviteCodes(s, hub), [], s)
})

test('code grammar: 2-32 of letters, digits, _ and -', () => {
  assert.deepEqual(inviteCodes(`${hub}/invite/a`, hub), [])
  assert.deepEqual(inviteCodes(`${hub}/invite/ab`, hub), ['ab'])
  assert.deepEqual(inviteCodes(`${hub}/invite/${'a'.repeat(32)}`, hub), ['a'.repeat(32)])
  assert.deepEqual(inviteCodes(`${hub}/invite/${'a'.repeat(33)}`, hub), [])
  assert.deepEqual(inviteCodes(`${hub}/invite/a%20b`, hub), [])
})

test('at most 3 cards per message', () => {
  const s = ['aa', 'bb', 'cc', 'dd'].map((c) => `${hub}/invite/${c}`).join(' ')
  assert.deepEqual(inviteCodes(s, hub), ['aa', 'bb', 'cc'])
})

test('a message that is only the link', () => {
  assert.equal(onlyInvite(` ${hub}/invite/abcDEF12 `, hub), true)
  assert.equal(onlyInvite(`<${hub}/invite/abcDEF12>`, hub), true)
  assert.equal(onlyInvite(`hey ${hub}/invite/abcDEF12`, hub), false)
  assert.equal(onlyInvite(`${hub}/invite/aa ${hub}/invite/bb`, hub), false)
  assert.equal(onlyInvite('https://other.example.org/invite/abcDEF12', hub), false)
})
