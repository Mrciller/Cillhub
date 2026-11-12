// Encrypted DMs: keys, epochs and wraps, the rules once a DM is encrypted, report reveal, and the fixed test vectors
// every client (web, Android) must reproduce byte for byte. The crypto here is a reference built on node:crypto only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, createHash, createCipheriv, createPrivateKey, hkdfSync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer, guildWith } from './helpers.js';

// --- reference implementation ---------------------------------------------------------------------------------------------
const b64 = b => Buffer.from(b).toString('base64url');
const seed = (label, n = 32) => createHash('sha256').update(`cillhub e2ee test ${label}`).digest().subarray(0, n);
const hkdf = (ikm, salt, info) => Buffer.from(hkdfSync('sha256', ikm, salt, info, 32));
const gcm = (key, iv, pt, aad) => {
  const c = createCipheriv('aes-256-gcm', key, iv);
  if (aad) c.setAAD(aad);
  return Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
};
function keyPair(d = randomBytes(32)) {
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(d);
  const pub = ecdh.getPublicKey();
  const pkcs8 = createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: b64(d), x: b64(pub.subarray(1, 33)), y: b64(pub.subarray(33)) }, format: 'jwk' })
    .export({ type: 'pkcs8', format: 'der' });
  return { d, pub, pkcs8, ecdh };
}
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += BASE32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits) out += BASE32[(value << (5 - bits)) & 31];
  return out.match(/.{1,4}/g).join('-');
}
function backup(recovery, userId, pkcs8, n = randomBytes(12)) {
  const bk = hkdf(recovery, Buffer.from(userId), 'cillhub-e2ee-backup-v1');
  return { bk, backup: JSON.stringify({ v: 1, n: b64(n), c: b64(gcm(bk, n, pkcs8)) }) };
}
// wrap v2: ikm = ECDH(eph, member) || ECDH(wrapper's account key, member); `by` is the wrapper's user id
function wrap(channelKey, memberPub, channelId, epoch, userId, by, byKey, eph = keyPair(), n = randomBytes(12)) {
  const sharedEph = eph.ecdh.computeSecret(memberPub), sharedBy = byKey.ecdh.computeSecret(memberPub);
  const ikm = Buffer.concat([sharedEph, sharedBy]);
  const info = `cillhub-e2ee-wrap-v2|${epoch}|${userId}|${by}`;
  const wk = hkdf(ikm, Buffer.from(channelId), info);
  return { sharedEph, sharedBy, ikm, info, wk, wrapped: JSON.stringify({ by, eph: b64(eph.pub), n: b64(n), c: b64(gcm(wk, n, channelKey)) }) };
}
function seal(channelKey, channelId, authorId, epoch, payload, nonce = randomBytes(24)) {
  const plaintext = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const mk = hkdf(channelKey, nonce, 'cillhub-e2ee-msg-v1');
  const aad = `${channelId}|${authorId}`;
  const c = gcm(mk, nonce.subarray(0, 12), Buffer.from(plaintext), Buffer.from(aad));
  const kc = createHash('sha256').update(mk).update(nonce).digest();
  return { plaintext, aad, mk, kc, envelope: { v: 1, e: epoch, n: b64(nonce), c: b64(c), kc: b64(kc) } };
}
function securityCode(a, b) {
  const [x, y] = [a, b].sort(Buffer.compare);
  const n = BigInt(`0x${createHash('sha256').update(x).update(y).digest('hex')}`) % 10n ** 60n;
  return n.toString().padStart(60, '0').match(/.{5}/g).join(' ');
}

// --- vectors ----------------------------------------------------------------------------------------------------------------
const VECTORS = new URL('./fixtures/e2ee-vectors.json', import.meta.url);
function vectors() {
  const ids = { alex: '1300000000000000001', sam: '1300000000000000002', channel: '1300000000000000100' };
  const alex = keyPair(seed('alex private key')), sam = keyPair(seed('sam private key')), eph = keyPair(seed('ephemeral private key'));
  const party = (id, k) => ({ user_id: id, d: b64(k.d), pkcs8: b64(k.pkcs8), public_key: b64(k.pub) });
  const recovery = seed('recovery key', 20), bn = seed('backup nonce', 12);
  const bu = backup(recovery, ids.alex, alex.pkcs8, bn);
  const channelKey = seed('channel key'), wn = seed('wrap nonce', 12);
  const w = wrap(channelKey, sam.pub, ids.channel, 1, ids.sam, ids.alex, alex, eph, wn);
  const fileKey = seed('attachment key'), fileIv = seed('attachment iv', 12);
  const file = Buffer.from('Hello again', 'utf8');
  const plaintext = JSON.stringify({ content: 'Hello Sam, this is encrypted.', files: [{ id: '0', k: b64(fileKey), n: b64(fileIv), name: 'note.txt', type: 'text/plain', size: file.length }] });
  const msg = seal(channelKey, ids.channel, ids.alex, 1, plaintext, seed('message nonce', 24));
  return {
    about: 'Encrypted DM test vectors. All binary values are base64url without padding. Strings marked json are exact bytes (utf8).',
    alex: party(ids.alex, alex), sam: party(ids.sam, sam),
    recovery: { user_id: ids.alex, key: b64(recovery), display: base32(recovery), bk: b64(bu.bk), nonce: b64(bn), backup_json: bu.backup },
    channel: { id: ids.channel, epoch: 1, key: b64(channelKey) },
    wrap: {
      user_id: ids.sam, wrapper: party(ids.alex, alex), ephemeral: { d: b64(eph.d), pkcs8: b64(eph.pkcs8), public_key: b64(eph.pub) }, nonce: b64(wn),
      shared_eph: b64(w.sharedEph), shared_by: b64(w.sharedBy), ikm: b64(w.ikm), info: w.info, wk: b64(w.wk), wrapped_json: w.wrapped,
    },
    message: { author_id: ids.alex, nonce24: b64(seed('message nonce', 24)), aad: msg.aad, plaintext_json: plaintext, mk: b64(msg.mk), kc: b64(msg.kc), envelope: msg.envelope },
    attachment: { key: b64(fileKey), iv: b64(fileIv), plaintext: b64(file), ciphertext: b64(gcm(fileKey, fileIv, file)) },
    security_code: { between: [ids.alex, ids.sam], code: securityCode(alex.pub, sam.pub) },
  };
}

test('test vectors: fixed keys and nonces give the committed file byte for byte', async () => {
  const v = vectors();
  if (!existsSync(VECTORS)) writeFileSync(VECTORS, `${JSON.stringify(v, null, 2)}\n`);
  assert.deepEqual(JSON.parse(readFileSync(VECTORS, 'utf8')), v);
  // the same values through WebCrypto (what the web client uses), so both stacks agree
  const s = globalThis.crypto.subtle;
  const ub = x => Buffer.from(x, 'base64url');
  const priv = await s.importKey('pkcs8', ub(v.wrap.ephemeral.pkcs8), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const pub = await s.importKey('raw', ub(v.sam.public_key), { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  assert.equal(b64(await s.deriveBits({ name: 'ECDH', public: pub }, priv, 256)), v.wrap.shared_eph);
  const byPriv = await s.importKey('pkcs8', ub(v.wrap.wrapper.pkcs8), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  assert.equal(b64(await s.deriveBits({ name: 'ECDH', public: pub }, byPriv, 256)), v.wrap.shared_by);
  const ck = await s.importKey('raw', ub(v.channel.key), 'HKDF', false, ['deriveBits']);
  const mk = await s.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: ub(v.message.nonce24), info: Buffer.from('cillhub-e2ee-msg-v1') }, ck, 256);
  assert.equal(b64(mk), v.message.mk);
  assert.equal(securityCode(ub(v.sam.public_key), ub(v.alex.public_key)), v.security_code.code);
});

// --- server -----------------------------------------------------------------------------------------------------------------
let srv, api, alex, sam, robin, guild;
const keys = {};
async function setupKeys(u) {
  const k = keyPair();
  const r = await api('PUT', '/users/@me/e2ee/keys', u.token, { public_key: b64(k.pub), backup: backup(randomBytes(20), u.id, k.pkcs8).backup });
  assert.equal(r.status, 200);
  keys[u.name] = k;
  return k;
}
const sql = (q, ...a) => { const db = new DatabaseSync(join(srv.dataDir, 'cillcord.sqlite')); try { return db.prepare(q).all(...a); } finally { db.close(); } };
const friends = async (a, b) => {
  await api('POST', '/users/@me/relationships', a.token, { username: b.name });
  assert.equal((await api('PUT', `/users/@me/relationships/${a.id}`, b.token, {})).status, 204);
};
const openDm = async (a, b) => (await api('POST', '/users/@me/channels', a.token, { recipient_id: b.id })).body;
const wrapsFor = (ch, epoch, members, channelKey, by = alex) =>
  Object.fromEntries(members.map(u => [u.id, wrap(channelKey, keys[u.name].pub, ch, epoch, u.id, by.id, keys[by.name]).wrapped]));

before(async () => {
  srv = await startServer();
  api = srv.api;
  ({ users: { alex, sam, robin }, guild } = await guildWith(srv, ['alex', 'sam', 'robin']));
});
after(() => srv.stop());

test('keys: shape checked, backup only for its owner, public key only for people sharing a DM', async () => {
  const k = keyPair();
  const good = { public_key: b64(k.pub), backup: backup(randomBytes(20), alex.id, k.pkcs8).backup };
  const put = body => api('PUT', '/users/@me/e2ee/keys', alex.token, body);
  assert.equal((await put({ ...good, public_key: b64(randomBytes(65)) })).status, 400, 'not a curve point');
  assert.equal((await put({ ...good, public_key: `${good.public_key}=` })).status, 400, 'padding');
  assert.equal((await put({ identity_key: 'x', signed_prekey: 'y' })).status, 400, 'the old draft shape');
  assert.equal((await put({ ...good, backup: '{"v":1,"n":"AAAA","c":"AAAA"}' })).status, 400);
  assert.equal((await put({ ...good, backup: JSON.stringify({ ...JSON.parse(good.backup), x: 1 }) })).status, 400, 'extra field');
  assert.equal((await api('GET', '/users/@me/e2ee/keys', alex.token)).status, 404);
  assert.equal((await put(good)).status, 200);
  keys.alex = k;
  assert.deepEqual((await api('GET', '/users/@me/e2ee/keys', alex.token)).body, good);
  assert.equal((await api('GET', `/users/${alex.id}/e2ee/keys`, sam.token)).status, 404, 'no shared DM yet');
  const dm = await openDm(alex, sam);
  assert.equal(dm.e2ee_epoch, 0);
  const other = await api('GET', `/users/${alex.id}/e2ee/keys`, sam.token);
  assert.deepEqual(other.body, { public_key: good.public_key }, 'never the backup');
});

test('epoch: every member needs a key, exactly the members are wrapped, a race gets one 409', async () => {
  const dm = await openDm(alex, sam);
  const ck = randomBytes(32);
  const epoch = (e, wraps) => api('PUT', `/channels/${dm.id}/e2ee/epoch`, alex.token, { epoch: e, wraps });
  assert.equal((await epoch(1, { [alex.id]: wrap(ck, keys.alex.pub, dm.id, 1, alex.id, alex.id, keys.alex).wrapped })).body.code, 50303, 'Sam has no key');
  await setupKeys(sam);
  await setupKeys(robin);
  assert.equal((await epoch(1, wrapsFor(dm.id, 1, [alex], ck))).status, 400, 'Sam not wrapped');
  assert.equal((await epoch(1, wrapsFor(dm.id, 1, [alex, sam, robin], ck))).status, 400, 'Robin is no member');
  assert.equal((await epoch(1, { ...wrapsFor(dm.id, 1, [alex], ck), [sam.id]: '{"eph":"x","n":"y","c":"z"}' })).status, 400, 'bad wrap');
  assert.equal((await epoch(2, wrapsFor(dm.id, 2, [alex, sam], ck))).status, 409, 'not current + 1');
  const both = await Promise.all([epoch(1, wrapsFor(dm.id, 1, [alex, sam], ck)), epoch(1, wrapsFor(dm.id, 1, [alex, sam], randomBytes(32)))]);
  assert.deepEqual(both.map(r => r.status).sort(), [200, 409]);
  assert.equal((await api('GET', `/channels/${dm.id}`, sam.token)).body.e2ee_epoch, 1);
  const mine = (await api('GET', `/channels/${dm.id}/e2ee/keys`, sam.token)).body;
  assert.equal(mine.epoch, 1);
  assert.equal(mine.keys.length, 1);
  assert.deepEqual(mine.wrapped_users.sort(), [alex.id, sam.id].sort());
  assert.ok((await api('GET', `/channels/${dm.id}/e2ee/keys`, robin.token)).status >= 403, 'a non-member reads no wraps');
  assert.ok((await api('PUT', `/channels/${dm.id}/e2ee/wraps`, robin.token, { epoch: 1, wraps: {} })).status >= 403);
});

test('wraps: `by` must be the caller; a v1 wrap (no `by`) and a malformed `by` are refused; stored in key order', async () => {
  const dm = await openDm(sam, robin);
  const cur = (await api('GET', `/channels/${dm.id}/e2ee/keys`, sam.token)).body.epoch;
  const e = cur + 1, ck = randomBytes(32);
  const put = (wraps, u = sam) => api('PUT', `/channels/${dm.id}/e2ee/epoch`, u.token, { epoch: e, wraps });
  const foreign = wrapsFor(dm.id, e, [sam, robin], ck, robin); // Robin's wraps, sent by Sam
  assert.equal((await put(foreign)).body.code, 50035, 'foreign by');
  const v1 = Object.fromEntries(Object.entries(wrapsFor(dm.id, e, [sam, robin], ck, sam)).map(([id, w]) => { const { by, ...rest } = JSON.parse(w); return [id, JSON.stringify(rest)]; }));
  assert.equal((await put(v1)).status, 400, 'v1 shape');
  const good = wrapsFor(dm.id, e, [sam, robin], ck, sam);
  const bad = by => ({ ...good, [robin.id]: JSON.stringify({ ...JSON.parse(good[robin.id]), by }) });
  assert.equal((await put(bad(`${sam.id}x`))).status, 400, 'not digits');
  assert.equal((await put(bad(Number(sam.id)))).status, 400, 'a number, not a string');
  assert.equal((await put(good)).status, 200);
  assert.equal(JSON.parse(sql('SELECT wrapped FROM dm_keys WHERE channel_id = ? AND user_id = ?', dm.id, robin.id)[0].wrapped).by, sam.id);
  assert.deepEqual(Object.keys(JSON.parse(sql('SELECT wrapped FROM dm_keys WHERE channel_id = ? AND user_id = ?', dm.id, robin.id)[0].wrapped)), ['by', 'eph', 'n', 'c']);
  sql('DELETE FROM dm_keys WHERE channel_id = ? AND user_id = ?', dm.id, robin.id);
  const add = (wraps, u) => api('PUT', `/channels/${dm.id}/e2ee/wraps`, u.token, { epoch: e, wraps });
  assert.equal((await add(wrapsFor(dm.id, e, [robin], ck, sam), robin)).status, 400, 'PUT wraps: foreign by');
  assert.equal((await add(wrapsFor(dm.id, e, [robin], ck, robin), robin)).status, 200);
});

// an encrypted 1:1 DM between Alex and Sam with a known channel key
async function encryptedDm(a = alex, b = sam) {
  const dm = await openDm(a, b);
  const cur = (await api('GET', `/channels/${dm.id}/e2ee/keys`, a.token)).body.epoch;
  const ck = randomBytes(32);
  assert.equal((await api('PUT', `/channels/${dm.id}/e2ee/epoch`, a.token, { epoch: cur + 1, wraps: wrapsFor(dm.id, cur + 1, [a, b], ck, a) })).status, 200);
  return { dm, ck, epoch: cur + 1 };
}

test('encrypted DM: plain text refused, envelope checked and capped, content is the placeholder', async () => {
  const { dm, ck, epoch } = await encryptedDm();
  const post = body => api('POST', `/channels/${dm.id}/messages`, alex.token, body);
  assert.equal((await post({ content: 'hello in the clear' })).body.code, 50305);
  const { envelope } = seal(ck, dm.id, alex.id, epoch, { content: 'hi Sam' });
  assert.equal((await post({ content: 'also plain', e2ee_envelope: envelope })).status, 400);
  assert.equal((await post({ e2ee_envelope: { ...envelope, e: epoch + 1 } })).status, 409);
  assert.equal((await post({ e2ee_envelope: { ...envelope, x: 1 } })).status, 400);
  assert.equal((await post({ e2ee_envelope: { ...envelope, n: b64(randomBytes(12)) } })).status, 400);
  assert.equal((await post({ e2ee_envelope: JSON.stringify(envelope) })).status, 400, 'an object, not a string');
  assert.equal((await post({ e2ee_envelope: { ...envelope, c: b64(randomBytes(12_500)) } })).status, 400, 'over 16384 characters');
  const sent = await post({ e2ee_envelope: envelope, nonce: '1' });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.type, 0);
  assert.equal(sent.body.content, 'Encrypted message. Update the app to read it.');
  assert.deepEqual(sent.body.e2ee_envelope, envelope);
  const reply = await post({ e2ee_envelope: seal(ck, dm.id, alex.id, epoch, { content: 'reply' }).envelope, message_reference: { message_id: sent.body.id } });
  assert.equal(reply.body.type, 19);
  assert.equal(reply.body.referenced_message.e2ee_envelope.kc, envelope.kc);
  assert.equal((await post({ sticker_ids: [] })).status, 400);
  const plain = await openDm(alex, robin); // not encrypted: an envelope there is refused
  assert.equal((await api('POST', `/channels/${plain.id}/messages`, alex.token, { e2ee_envelope: envelope })).status, 400);
  const hits = await api('GET', `/channels/${dm.id}/messages/search?content=Encrypted`, alex.token);
  assert.equal(hits.body.total_results, 0, 'placeholders are not search results');
  const row = sql('SELECT content, e2ee_envelope FROM messages WHERE id = ?', sent.body.id)[0];
  assert.equal(row.content, 'Encrypted message. Update the app to read it.');
});

test('encrypted DM: polls, scheduled, recurring and forwards refused; attachments stored as ciphertext without names', async () => {
  const { dm, ck, epoch } = await encryptedDm();
  const post = body => api('POST', `/channels/${dm.id}/messages`, alex.token, body);
  const env = () => seal(ck, dm.id, alex.id, epoch, { content: 'x' }).envelope;
  const poll = { question: { text: 'Q?' }, answers: [{ poll_media: { text: 'a' } }] };
  assert.equal((await post({ e2ee_envelope: env(), poll })).body.code, 50301);
  assert.equal((await post({ poll })).body.code, 50301);
  const later = await api('POST', `/channels/${dm.id}/scheduled-messages`, alex.token, { content: 'later', send_at: new Date(Date.now() + 3600_000).toISOString() });
  assert.equal(later.body.code, 50301);
  assert.equal((await api('POST', `/channels/${dm.id}/recurring-messages`, alex.token, { content: 'daily' })).body.code, 50301);
  const m = (await post({ e2ee_envelope: env() })).body;
  const plainDm = await openDm(alex, robin);
  const fwd = await api('POST', `/channels/${plainDm.id}/messages`, alex.token, { message_reference: { type: 1, message_id: m.id, channel_id: dm.id } });
  assert.equal(fwd.body.code, 50301, 'an encrypted message is not forwarded');
  const hello = (await api('POST', `/channels/${plainDm.id}/messages`, alex.token, { content: 'plain' })).body;
  const into = await post({ message_reference: { type: 1, message_id: hello.id, channel_id: plainDm.id } });
  assert.equal(into.body.code, 50301, 'nothing plain is forwarded into an encrypted DM');
  const secret = Buffer.from('the real file bytes');
  const fk = randomBytes(32), fiv = randomBytes(12);
  const up = await srv.upload(dm.id, alex.token, { e2ee_envelope: env(), attachments: [{ id: '0', filename: 'secret-plan.png', description: 'alt text' }] },
    [['secret-plan.png', gcm(fk, fiv, secret), 'image/png']]);
  assert.equal(up.status, 201);
  const a = up.body.attachments[0];
  assert.equal(a.filename, 'file.bin');
  assert.equal(a.content_type, 'application/octet-stream');
  assert.equal(a.description, undefined);
  const stored = readFileSync(join(srv.dataDir, 'attachments', dm.id, a.id));
  assert.ok(!stored.includes(secret));
});

test('encrypted DM: edit replaces the envelope without history; plain edits refused', async () => {
  const { dm, ck, epoch } = await encryptedDm();
  const m = (await api('POST', `/channels/${dm.id}/messages`, alex.token, { e2ee_envelope: seal(ck, dm.id, alex.id, epoch, { content: 'one' }).envelope })).body;
  const patch = (u, body) => api('PATCH', `/channels/${dm.id}/messages/${m.id}`, u.token, body);
  assert.equal((await patch(alex, { content: 'two in the clear' })).body.code, 50305);
  const next = seal(ck, dm.id, alex.id, epoch, { content: 'two' }).envelope;
  assert.equal((await patch(sam, { e2ee_envelope: next })).status, 403, 'only the author');
  const ok = await patch(alex, { e2ee_envelope: next });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.e2ee_envelope, next);
  assert.ok(ok.body.edited_timestamp);
  assert.deepEqual((await api('GET', `/channels/${dm.id}/messages/${m.id}/edits`, alex.token)).body.edits, []);
});

test('report reveal: a matching key stores the plain text; a forged key or another message\'s key is refused', async () => {
  const { dm, ck, epoch } = await encryptedDm();
  const send = (text, extra = {}) => {
    const s = seal(ck, dm.id, alex.id, epoch, { content: text, ...extra });
    return api('POST', `/channels/${dm.id}/messages`, alex.token, { e2ee_envelope: s.envelope }).then(r => ({ id: r.body.id, mk: b64(s.mk) }));
  };
  const before1 = await send('context one');
  const fk = randomBytes(32), fiv = randomBytes(12);
  const s = seal(ck, dm.id, alex.id, epoch, { content: 'the reported text', files: [{ id: '0', k: b64(fk), n: b64(fiv), name: 'pic.png', type: 'image/png', size: 3 }] });
  const up = await srv.upload(dm.id, alex.token, { e2ee_envelope: s.envelope }, [['file.bin', gcm(fk, fiv, Buffer.from('png')), 'application/octet-stream']]);
  const bad = { id: up.body.id, mk: b64(s.mk) };
  const later1 = await send('after the report');
  const report = reveal => api('POST', `/channels/${dm.id}/messages/${bad.id}/report`, sam.token, { reason: 'harassment', reveal });
  assert.equal((await report([{ id: bad.id, mk: b64(randomBytes(32)) }])).status, 400, 'forged key');
  assert.equal((await report([{ id: bad.id, mk: before1.mk }])).status, 400, 'key of another message: wrong kc');
  assert.equal((await report([before1])).status, 400, 'the reported message itself is missing');
  assert.equal((await report([bad, later1])).status, 400, 'only messages up to the reported one');
  assert.equal((await report([bad, { ...before1, mk: bad.mk }])).status, 400, 'one bad entry refuses all');
  assert.equal((await report(Array.from({ length: 12 }, () => bad))).status, 400);
  assert.equal(sql('SELECT COUNT(*) AS n FROM reports')[0].n, 0, 'nothing stored for a refused reveal');
  const ok = await report([before1, bad]);
  assert.equal(ok.status, 201);
  const snap = JSON.parse(sql('SELECT snapshot FROM reports WHERE id = ?', ok.body.id)[0].snapshot);
  assert.equal(snap.content, 'the reported text');
  assert.equal(snap.encrypted, true);
  assert.equal(snap.revealed, true);
  assert.deepEqual(snap.context.map(c => c.content), ['context one']);
  assert.equal(snap.attachments[0].filename, 'pic.png');
  assert.equal(snap.attachments[0].key, b64(fk));
  assert.equal(snap.attachments[0].id, up.body.attachments[0].id);
  // a plain message reported with a reveal is refused; without one it is reported as before
  const plainDm = await openDm(alex, robin);
  const p = (await api('POST', `/channels/${plainDm.id}/messages`, alex.token, { content: 'plain' })).body;
  assert.equal((await api('POST', `/channels/${plainDm.id}/messages/${p.id}/report`, robin.token, { reason: 'spam', reveal: [{ id: p.id, mk: bad.mk }] })).status, 400);
});

test('groups: a removed member forces a new epoch; wraps are added, never overwritten; a key reset drops current wraps', async () => {
  await friends(alex, sam);
  await friends(alex, robin);
  const g = (await api('POST', '/users/@me/channels', alex.token, { recipients: [sam.id, robin.id] })).body;
  assert.equal(g.type, 3);
  const ck = randomBytes(32);
  assert.equal((await api('PUT', `/channels/${g.id}/e2ee/epoch`, alex.token, { epoch: 1, wraps: wrapsFor(g.id, 1, [alex, sam, robin], ck) })).status, 200);
  const robinWrap = sql('SELECT wrapped FROM dm_keys WHERE channel_id = ? AND user_id = ?', g.id, robin.id)[0].wrapped;
  const add = await api('PUT', `/channels/${g.id}/e2ee/wraps`, sam.token, { epoch: 1, wraps: wrapsFor(g.id, 1, [robin], randomBytes(32), sam) });
  assert.equal(add.status, 200);
  assert.equal(sql('SELECT wrapped FROM dm_keys WHERE channel_id = ? AND user_id = ?', g.id, robin.id)[0].wrapped, robinWrap, 'never overwritten');
  assert.equal((await api('DELETE', `/channels/${g.id}/recipients/${robin.id}`, alex.token)).status, 204);
  const env = seal(ck, g.id, alex.id, 1, { content: 'robin is gone' }).envelope;
  assert.equal((await api('POST', `/channels/${g.id}/messages`, alex.token, { e2ee_envelope: env })).body.code, 50302);
  const ck2 = randomBytes(32);
  assert.equal((await api('PUT', `/channels/${g.id}/e2ee/epoch`, sam.token, { epoch: 2, wraps: wrapsFor(g.id, 2, [alex, sam], ck2, sam) })).status, 200);
  assert.equal((await api('POST', `/channels/${g.id}/messages`, alex.token, { e2ee_envelope: seal(ck2, g.id, alex.id, 2, { content: 'new key' }).envelope })).status, 201);
  // Sam resets: the epoch 2 wrap for Sam goes (it opens only with the old key), the old epoch's stays
  await setupKeys(sam);
  const left = sql('SELECT epoch FROM dm_keys WHERE channel_id = ? AND user_id = ? ORDER BY epoch', g.id, sam.id).map(r => r.epoch);
  assert.deepEqual(left, [1]);
  const fresh = await api('PUT', `/channels/${g.id}/e2ee/wraps`, alex.token, { epoch: 2, wraps: wrapsFor(g.id, 2, [sam], ck2) });
  assert.deepEqual(fresh.body.wrapped_users.sort(), [alex.id, sam.id].sort());
});

test('a DM with a bot is never encrypted: the bot has no key and cannot set one', async () => {
  const app = (await api('POST', '/applications', alex.token, { name: 'Helper' })).body;
  const botAuth = `Bot ${app.bot.token}`;
  await api('POST', `/oauth2/authorize?client_id=${app.id}&scope=bot`, alex.token, { authorize: true, guild_id: guild.id, permissions: '3072' });
  const k = keyPair();
  assert.equal((await api('PUT', '/users/@me/e2ee/keys', botAuth, { public_key: b64(k.pub), backup: backup(randomBytes(20), app.id, k.pkcs8).backup })).status, 403);
  const dm = (await api('POST', '/users/@me/channels', botAuth, { recipient_id: alex.id })).body;
  const r = await api('PUT', `/channels/${dm.id}/e2ee/epoch`, alex.token, { epoch: 1, wraps: { [alex.id]: wrap(randomBytes(32), keys.alex.pub, dm.id, 1, alex.id, alex.id, keys.alex).wrapped } });
  assert.equal(r.body.code, 50303);
  assert.equal(dm.e2ee_epoch, 0);
  assert.equal((await api('POST', `/channels/${dm.id}/messages`, botAuth, { content: 'plain from the bot' })).status, 201);
});
