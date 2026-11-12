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

test('channel key wrap with the fixed ephemeral key, and unwrap with Sam\'s key', async () => {
  const eph = { priv: await C.importPrivate(u(v.wrap.ephemeral.pkcs8)), pub: v.wrap.ephemeral.public_key }
  const w = await C.wrap(u(v.channel.key), v.sam.public_key, v.channel.id, v.channel.epoch, v.wrap.user_id, eph, u(v.wrap.nonce))
  assert.equal(w, v.wrap.wrapped_json)
  const sam = await C.importPrivate(u(v.sam.pkcs8))
  assert.deepEqual(await C.unwrap(sam, w, v.channel.id, v.channel.epoch, v.wrap.user_id), u(v.channel.key))
  await assert.rejects(C.unwrap(sam, w, v.channel.id, v.channel.epoch + 1, v.wrap.user_id), 'epoch is bound in')
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
