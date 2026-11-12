// Member memory of encrypted DMs (src/e2ee/members.ts). Run: npm test (node strips the TypeScript types).
import test from 'node:test'
import assert from 'node:assert/strict'
import { acceptMember, checkMembers, sendPlan, trustedMaker } from '../src/e2ee/members.ts'

test('first use stores the list; a 1:1 DM only with exactly one other member', () => {
  assert.deepEqual(checkMembers(1, undefined, ['sam']), { accepted: ['sam'], added: [], bad: false, next: { ids: ['sam'] } })
  for (const others of [[], ['sam', 'kim']]) assert.deepEqual(checkMembers(1, undefined, others), { accepted: [], added: [], bad: true, next: null })
  assert.deepEqual(checkMembers(3, undefined, ['sam', 'kim']).next, { ids: ['sam', 'kim'] })
})

test('1:1 DM: any change of the list is refused, nothing stored, no Accept', () => {
  const mem = { ids: ['sam'] }
  const ghost = checkMembers(1, mem, ['sam', 'kim'])
  assert.equal(ghost.bad, true); assert.equal(ghost.next, null); assert.deepEqual(ghost.accepted, ['sam'])
  assert.equal(checkMembers(1, mem, ['kim']).bad, true)
  assert.equal(checkMembers(1, mem, ['sam']).bad, false)
})

test('group DM: an added member waits for Accept, then the epoch of the Accept is renewed; a gone one is dropped', () => {
  const mem = { ids: ['sam', 'robin'] }
  const r = checkMembers(3, mem, ['sam', 'robin', 'kim'])
  assert.deepEqual([r.added, r.bad, r.next], [['kim'], false, null])
  assert.equal(trustedMaker(mem, 'alex', 'kim', true), false)
  assert.equal(trustedMaker(mem, 'alex', 'kim', false), false, 'old epochs too')
  const after = acceptMember(mem, 'kim', 4)
  assert.deepEqual(checkMembers(3, after, ['sam', 'robin', 'kim']).added, [])
  assert.equal(trustedMaker(after, 'alex', 'kim', true), true)
  const gone = checkMembers(3, mem, ['sam'])
  assert.deepEqual(gone.next, { ids: ['sam'], left: ['robin'] })
  assert.equal(trustedMaker(gone.next, 'alex', 'robin', true), false, 'no current key from someone gone')
  assert.equal(trustedMaker(gone.next, 'alex', 'robin', false), true, 'their old wraps still open')
  assert.deepEqual(checkMembers(3, gone.next, ['sam', 'robin']).added, ['robin'], 'coming back needs Accept again')
  assert.equal(trustedMaker(undefined, 'alex', 'alex', true), true)
})

test('send: a failed wrap check is never renewed silently; missing or stale wraps renew', () => {
  const c = { epoch: 4, unverified: false, haveKey: true, wrapped: ['alex', 'sam'], stale: [] }
  assert.equal(sendPlan(c, ['alex', 'sam']), 'use')
  assert.equal(sendPlan({ ...c, unverified: true, haveKey: false }, ['alex', 'sam']), 'refuse')
  assert.equal(sendPlan({ ...c, haveKey: false }, ['alex', 'sam']), 'renew')
  assert.equal(sendPlan({ ...c, stale: ['sam'] }, ['alex', 'sam']), 'renew')
  assert.equal(sendPlan(c, ['alex']), 'renew', 'a member left')
  assert.equal(sendPlan(c, ['alex', 'sam', 'kim'], 4), 'renew', 'never wrap the key of the Accept epoch for the new member')
  assert.equal(sendPlan({ ...c, epoch: 5 }, ['alex', 'sam'], 4), 'use')
})
