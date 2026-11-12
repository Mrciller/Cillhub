// Encrypted DMs (src/e2ee/crypto.ts) against the server's fixed test vectors (server/test/fixtures/e2ee-vectors.json).
// Run: npm test (node strips the TypeScript types).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as C from '../src/e2ee/crypto.ts'

const v = JSON.parse(readFileSync(new URL('../../server/test/fixtures/e2ee-vectors.json', import.meta.url), 'utf8'))
const u = (s) => C.unb64(s)

test('recovery key text and backup', async () => {
  const rk = u(v.recovery.key)
  assert.equal(C.recoveryText(rk), v.recovery.display)
  assert.deepEqual(C.parseRecovery(v.recovery.display.toLowerCase().replace(/-/g, ' ')), rk)
  assert.equal(C.parseRecovery('not a key'), null)
  assert.equal(await C.sealBackup(rk, v.recovery.user_id, u(v.alex.pkcs8), u(v.recovery.nonce)), v.recovery.backup_json)
  assert.deepEqual(await C.openBackup(rk, v.recovery.user_id, v.recovery.backup_json), u(v.alex.pkcs8))
  await assert.rejects(C.openBackup(C.random(20), v.recovery.user_id, v.recovery.backup_json))
})

test('channel key wrap v2 by Alex with the fixed ephemeral key, and unwrap with Sam\'s key', async () => {
  const eph = { priv: await C.importPrivate(u(v.wrap.ephemeral.pkcs8)), pub: v.wrap.ephemeral.public_key }
  const by = { id: v.wrap.wrapper.user_id, priv: await C.importPrivate(u(v.wrap.wrapper.pkcs8)) }
  const w = await C.wrap(u(v.channel.key), v.sam.public_key, v.channel.id, v.channel.epoch, v.wrap.user_id, by, eph, u(v.wrap.nonce))
  assert.equal(w, v.wrap.wrapped_json)
  assert.equal(C.wrapper(w), v.wrap.wrapper.user_id)
  const sam = await C.importPrivate(u(v.sam.pkcs8))
  assert.deepEqual(await C.unwrap(sam, w, v.channel.id, v.channel.epoch, v.wrap.user_id, v.wrap.wrapper.public_key), u(v.channel.key))
  await assert.rejects(C.unwrap(sam, w, v.channel.id, v.channel.epoch + 1, v.wrap.user_id, v.wrap.wrapper.public_key), 'epoch is bound in')
  await assert.rejects(C.unwrap(sam, w, v.channel.id, v.channel.epoch, v.wrap.user_id, v.sam.public_key), 'only the wrapper\'s key opens it')
  const v1 = JSON.stringify((({ by, ...rest }) => rest)(JSON.parse(w)))
  await assert.rejects(C.unwrap(sam, v1, v.channel.id, v.channel.epoch, v.wrap.user_id, v.wrap.wrapper.public_key), 'a v1 wrap is refused')
})

test('a wrap made without the account key of its `by` (only public keys known) does not open', async () => {
  // the attacker writes into the database: a channel key of their own, wrapped to Sam, claiming to be Alex
  const attacker = await C.newAccountKey()
  const sam = await C.importPrivate(u(v.sam.pkcs8))
  const forged = await C.wrap(C.random(32), v.sam.public_key, v.channel.id, 2, v.sam.user_id, { id: v.alex.user_id, priv: attacker.priv })
  assert.equal(C.wrapper(forged), v.alex.user_id)
  await assert.rejects(C.unwrap(sam, forged, v.channel.id, 2, v.sam.user_id, v.alex.public_key))
  // swapping in another ephemeral key does not help either
  const eph = await C.newAccountKey()
  const tampered = JSON.stringify({ ...JSON.parse(forged), eph: eph.pub })
  await assert.rejects(C.unwrap(sam, tampered, v.channel.id, 2, v.sam.user_id, v.alex.public_key))
})

test('message envelope, key and commitment; the AAD binds channel and author', async () => {
  const { envelope, mk } = await C.seal(u(v.channel.key), v.channel.id, v.message.author_id, v.channel.epoch, v.message.plaintext_json, u(v.message.nonce24))
  assert.deepEqual(envelope, v.message.envelope)
  assert.equal(C.b64(mk), v.message.mk)
  const opened = await C.open(u(v.channel.key), v.channel.id, v.message.author_id, v.message.envelope)
  assert.equal(opened.text, v.message.plaintext_json)
  await assert.rejects(C.open(u(v.channel.key), v.channel.id, v.sam.user_id, v.message.envelope))
  await assert.rejects(C.open(u(v.channel.key), v.channel.id, v.message.author_id, { ...v.message.envelope, kc: C.b64(C.random(32)) }))
})

test('attachment and security code', async () => {
  const f = await C.encryptFile(u(v.attachment.plaintext), u(v.attachment.key), u(v.attachment.iv))
  assert.equal(C.b64(f.data), v.attachment.ciphertext)
  assert.deepEqual(await C.decryptFile(u(v.attachment.ciphertext), v.attachment.key, v.attachment.iv), u(v.attachment.plaintext))
  assert.equal(await C.securityCode(v.alex.public_key, v.sam.public_key), v.security_code.code)
  assert.equal(await C.securityCode(v.sam.public_key, v.alex.public_key), v.security_code.code)
})
