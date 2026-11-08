import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, guildWith } from './helpers.js';

let srv, api, g, alice, bob, carol;
const s = {};
before(async () => {
  srv = await startServer();
  api = srv.api;
  g = await guildWith(srv, ['alice', 'bob', 'carol']); // carol stays offline
  ({ alice, bob, carol } = g.users);
  alice.gw = await srv.gateway(alice.token);
  bob.gw = await srv.gateway(bob.token);
});
after(() => srv.stop());

const send = (token, body, channel = g.general.id) => api('POST', `/channels/${channel}/messages`, token, body);
// a PNG header claiming 640x480: enough for sniffing and the size reader
const png = (w = 640, h = 480) => {
  const b = Buffer.alloc(33);
  Buffer.from('\x89PNG\r\n\x1a\n', 'latin1').copy(b);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};

test('system join message: type 7 in the system channel, authored by the joiner', async () => {
  const msgs = (await api('GET', `/channels/${g.general.id}/messages`, alice.token)).body;
  assert.deepEqual(msgs.map(m => [m.type, m.author.id, m.content]), [[7, carol.id, ''], [7, bob.id, '']]);
  assert.equal(bob.gw.ready.guilds[0].channels.find(c => c.id === g.general.id).last_message_id, msgs[0].id);
});

test('attachments: multipart upload, image size, inline only for proven media, security headers', async () => {
  const r = await srv.upload(g.general.id, bob.token, { content: 'files' }, [
    ['shot one.png', png(), 'image/png'],
    ['notes.txt', 'hello', 'text/plain'],
  ]);
  assert.equal(r.status, 201);
  const [img, txt] = r.body.attachments;
  assert.deepEqual([img.filename, img.content_type, img.width, img.height, img.size], ['shot_one.png', 'image/png', 640, 480, 33]);
  assert.equal(img.url, `/attachments/${g.general.id}/${img.id}/shot_one.png`);
  assert.equal(txt.width, undefined);
  assert.deepEqual((await alice.gw.event('MESSAGE_CREATE', d => d.id === r.body.id)).attachments, r.body.attachments);

  const get = path => fetch(srv.origin + path);
  const res = await get(img.url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.match(res.headers.get('content-disposition'), /^inline/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('content-security-policy'), "default-src 'none'; sandbox");
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), png());
  assert.match((await get(txt.url)).headers.get('content-disposition'), /^attachment; filename="notes.txt"$/);
  assert.equal((await get(`/attachments/${g.general.id}/${img.id}/other.png`)).status, 404);

  // HTML is never inline, whatever it claims to be
  const html = await srv.upload(g.general.id, bob.token, {}, [['page.html', '<script>alert(1)</script>', 'text/html'], ['fake.png', '<html>', 'image/png']]);
  assert.equal(html.status, 201);
  assert.equal(html.body.content, '');
  const [page, fake] = html.body.attachments;
  assert.equal(fake.content_type, 'application/octet-stream');
  for (const a of [page, fake]) {
    const resp = await get(a.url);
    assert.match(resp.headers.get('content-disposition'), /^attachment;/);
    assert.equal(resp.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(resp.headers.get('content-security-policy'), "default-src 'none'; sandbox");
  }

  const big = await srv.upload(g.general.id, bob.token, {}, [['big.bin', Buffer.alloc(25 * 1024 * 1024 + 1), 'application/octet-stream']]);
  assert.equal(big.status, 413);
  const eleven = await srv.upload(g.general.id, bob.token, {}, Array.from({ length: 11 }, (_, i) => [`${i}.txt`, 'x', 'text/plain']));
  assert.equal(eleven.status, 400);
  assert.equal((await send(bob.token, {})).body.code, 50006);

  // deleting the message deletes its files
  assert.equal((await api('DELETE', `/channels/${g.general.id}/messages/${r.body.id}`, bob.token)).status, 204);
  assert.equal((await get(img.url)).status, 404);
});

test('avatar and guild icon as data URIs, served from the CDN paths', async () => {
  const uri = `data:image/png;base64,${png(1, 1).toString('base64')}`;
  const me = await api('PATCH', '/users/@me', bob.token, { avatar: uri });
  assert.equal(me.status, 200);
  assert.match(me.body.avatar, /^[0-9a-f]{32}$/);
  assert.equal((await alice.gw.event('USER_UPDATE', d => d.id === bob.id)).avatar, me.body.avatar);
  assert.equal((await bob.gw.event('USER_UPDATE')).email, 'bob@example.com');
  const res = await fetch(`${srv.origin}/avatars/${bob.id}/${me.body.avatar}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), png(1, 1));
  const bad = await api('PATCH', '/users/@me', bob.token, { avatar: `data:image/png;base64,${Buffer.from('<svg/>').toString('base64')}` });
  assert.deepEqual([bad.status, bad.body.code], [400, 50035]);
  assert.equal((await api('PATCH', '/users/@me', bob.token, { avatar: null })).body.avatar, null);
  assert.equal((await fetch(`${srv.origin}/avatars/${bob.id}/${me.body.avatar}`)).status, 404);

  assert.equal((await api('PATCH', `/guilds/${g.guild.id}`, bob.token, { icon: uri })).status, 403);
  const guild = await api('PATCH', `/guilds/${g.guild.id}`, alice.token, { icon: uri });
  assert.match(guild.body.icon, /^[0-9a-f]{32}$/);
  assert.equal((await bob.gw.event('GUILD_UPDATE')).icon, guild.body.icon);
  assert.equal((await fetch(`${srv.origin}/icons/${g.guild.id}/${guild.body.icon}`)).status, 200);
});

test('reactions: add, count, me, remove, emoji validation, limit', async () => {
  const m = (await send(alice.token, { content: 'react to me' })).body;
  s.m = m;
  const path = (e, who = '@me') => `/channels/${g.general.id}/messages/${m.id}/reactions/${encodeURIComponent(e)}/${who}`;
  assert.equal((await api('PUT', path('👍'), bob.token)).status, 204);
  const add = await alice.gw.event('MESSAGE_REACTION_ADD');
  assert.deepEqual(add, { user_id: bob.id, channel_id: g.general.id, message_id: m.id, guild_id: g.guild.id, emoji: { id: null, name: '👍' } });
  await api('PUT', path('👍'), alice.token);
  await api('PUT', path('🇦🇹'), alice.token);
  await api('PUT', path('1️⃣'), alice.token);
  const msg = async token => (await api('GET', `/channels/${g.general.id}/messages?limit=1`, token)).body[0];
  assert.deepEqual((await msg(bob.token)).reactions, [
    { emoji: { id: null, name: '👍' }, count: 2, me: true },
    { emoji: { id: null, name: '🇦🇹' }, count: 1, me: false },
    { emoji: { id: null, name: '1️⃣' }, count: 1, me: false },
  ]);
  const users = await api('GET', `/channels/${g.general.id}/messages/${m.id}/reactions/${encodeURIComponent('👍')}`, alice.token);
  assert.deepEqual(users.body.map(u => u.id), [bob.id, alice.id]);
  for (const e of ['a', '👍👍', ':smile:', '1']) {
    const r = await api('PUT', path(e), bob.token);
    assert.deepEqual([r.status, r.body.code], [400, 10014], e);
  }
  assert.equal((await api('DELETE', path('👍'), bob.token)).status, 204);
  assert.deepEqual(await alice.gw.event('MESSAGE_REACTION_REMOVE'), { ...add });
  assert.equal((await api('DELETE', path('👍', alice.id), bob.token)).status, 403);
  assert.equal((await api('DELETE', path('🇦🇹', alice.id), alice.token)).status, 204);
  const emoji = [...'😀😁😂🤣😃😄😅😆😉😊😋😎😍😘🥰😗😙🥲'];
  for (const e of emoji) assert.equal((await api('PUT', path(e), alice.token)).status, 204); // 20 distinct now
  const over = await api('PUT', path('🙂'), alice.token);
  assert.deepEqual([over.status, over.body.code], [400, 30010]);
});

test('pins: MANAGE_MESSAGES, events, newest first, limit 50, DMs', async () => {
  const pin = (id, token, method = 'PUT', ch = g.general.id) => api(method, `/channels/${ch}/pins/${id}`, token);
  assert.equal((await pin(s.m.id, bob.token)).status, 403);
  assert.equal((await pin(s.m.id, alice.token)).status, 204);
  assert.equal((await bob.gw.event('MESSAGE_UPDATE', d => d.id === s.m.id)).pinned, true);
  const pinsUpdate = await bob.gw.event('CHANNEL_PINS_UPDATE');
  assert.equal(pinsUpdate.channel_id, g.general.id);
  assert.ok(pinsUpdate.last_pin_timestamp);
  const ids = [];
  for (let i = 0; i < 49; i++) ids.push((await send(alice.token, { content: `pin ${i}` })).body.id);
  for (const id of ids) assert.equal((await pin(id, alice.token)).status, 204);
  const extra = (await send(alice.token, { content: 'one too many' })).body;
  const full = await pin(extra.id, alice.token);
  assert.deepEqual([full.status, full.body.code], [400, 30003]);
  const pins = (await api('GET', `/channels/${g.general.id}/pins`, bob.token)).body;
  assert.equal(pins.length, 50);
  assert.equal(pins[0].id, ids.at(-1));
  assert.equal((await pin(s.m.id, alice.token, 'DELETE')).status, 204);
  assert.equal((await bob.gw.event('MESSAGE_UPDATE', d => d.id === s.m.id && !d.pinned)).pinned, false);

  const dm = (await api('POST', '/users/@me/channels', bob.token, { recipient_id: alice.id })).body;
  const dmMsg = (await send(alice.token, { content: 'pin me' }, dm.id)).body;
  assert.equal((await pin(dmMsg.id, bob.token, 'PUT', dm.id)).status, 204);
  s.dm = dm;
});

test('replies carry referenced_message; nonce is echoed', async () => {
  const r = await send(bob.token, { content: 'reply', nonce: 'n-123', message_reference: { message_id: s.m.id } });
  assert.equal(r.status, 201);
  assert.equal(r.body.type, 19);
  assert.equal(r.body.nonce, 'n-123');
  assert.deepEqual(r.body.message_reference, { message_id: s.m.id, channel_id: g.general.id, guild_id: g.guild.id });
  assert.equal(r.body.referenced_message.id, s.m.id);
  const ev = await alice.gw.event('MESSAGE_CREATE', d => d.id === r.body.id);
  assert.equal(ev.nonce, 'n-123');
  assert.equal(ev.referenced_message.content, 'react to me');
  const elsewhere = await send(bob.token, { content: 'x', message_reference: { message_id: s.m.id } }, s.dm.id);
  assert.equal(elsewhere.status, 400);
  assert.equal((await send(bob.token, { content: 'x', nonce: 'x'.repeat(26) })).status, 400);
  assert.equal((await send(bob.token, { content: 'no nonce' })).body.nonce, undefined);
  await api('DELETE', `/channels/${g.general.id}/messages/${s.m.id}`, alice.token);
  const after = (await api('GET', `/channels/${g.general.id}/messages?limit=10`, bob.token)).body.find(m => m.id === r.body.id);
  assert.equal(after.referenced_message, null);
  assert.equal(after.message_reference.message_id, s.m.id);
});

test('mentions: @everyone needs MENTION_EVERYONE, roles need mentionable; read states count them', async () => {
  const readState = async (user, channelId) => {
    const gw = await srv.gateway(user.token);
    gw.ws.close();
    return gw.ready.read_state.find(r => r.id === channelId) ?? { mention_count: 0 };
  };
  const last = (await send(bob.token, { content: 'start' })).body;
  assert.deepEqual(await api('POST', `/channels/${g.general.id}/messages/${last.id}/ack`, bob.token), { status: 200, body: { token: null } });
  assert.deepEqual(await bob.gw.event('MESSAGE_ACK'), { channel_id: g.general.id, message_id: last.id });
  assert.deepEqual(await readState(bob, g.general.id), { id: g.general.id, last_message_id: last.id, mention_count: 0 });

  const fromBob = (await send(bob.token, { content: '@everyone look' })).body;
  assert.equal(fromBob.mention_everyone, false);
  assert.equal((await readState(alice, g.general.id)).mention_count, 0);
  const fromAlice = (await send(alice.token, { content: '@everyone look' })).body;
  assert.equal(fromAlice.mention_everyone, true);
  await send(alice.token, { content: `hey <@${bob.id}>` });
  assert.equal((await readState(bob, g.general.id)).mention_count, 2);
  // @here counts only online users: bob is online, carol is not
  await send(alice.token, { content: '@here' });
  assert.equal((await readState(bob, g.general.id)).mention_count, 3);
  assert.equal((await readState(carol, g.general.id)).mention_count, 1);

  const plain = (await api('POST', `/guilds/${g.guild.id}/roles`, alice.token, { name: 'Quiet' })).body;
  const loud = (await api('POST', `/guilds/${g.guild.id}/roles`, alice.token, { name: 'Loud', mentionable: true })).body;
  await api('PATCH', `/guilds/${g.guild.id}/members/${alice.id}`, alice.token, { roles: [loud.id] });
  const roles = (await send(bob.token, { content: `<@&${plain.id}> <@&${loud.id}>` })).body;
  assert.deepEqual(roles.mention_roles, [loud.id]);
  assert.equal((await readState(alice, g.general.id)).mention_count, 1);
  assert.deepEqual((await send(alice.token, { content: `<@&${plain.id}>` })).body.mention_roles, [plain.id]); // owner has MENTION_EVERYONE

  // the author's own message never counts as unread for them
  const own = (await send(bob.token, { content: 'mine' })).body;
  assert.equal((await readState(bob, g.general.id)).last_message_id, own.id);

  // DMs: every message counts for the other participant
  const dmBefore = (await readState(bob, s.dm.id)).mention_count;
  await send(alice.token, { content: 'one' }, s.dm.id);
  const dmTwo = (await send(alice.token, { content: 'two' }, s.dm.id)).body;
  assert.equal((await readState(bob, s.dm.id)).mention_count, dmBefore + 2);

  // deleting the latest message rewinds last_message_id, withdraws unread mentions, and notifies CHANNEL_PINS_UPDATE if pinned
  const ping = (await send(alice.token, { content: `ping <@${bob.id}>` })).body;
  assert.equal((await api('PUT', `/channels/${g.general.id}/pins/${ping.id}`, alice.token)).status, 204);
  await bob.gw.event('CHANNEL_PINS_UPDATE');
  const beforeDel = await readState(bob, g.general.id);
  assert.equal((await api('GET', `/channels/${g.general.id}`, bob.token)).body.last_message_id, ping.id);
  assert.equal((await api('DELETE', `/channels/${g.general.id}/messages/${ping.id}`, alice.token)).status, 204);
  const pinsAfterDel = await bob.gw.event('CHANNEL_PINS_UPDATE');
  assert.equal(pinsAfterDel.channel_id, g.general.id);
  assert.equal((await api('GET', `/channels/${g.general.id}`, bob.token)).body.last_message_id, own.id);
  assert.equal((await readState(bob, g.general.id)).mention_count, beforeDel.mention_count - 1);
  assert.equal(dmTwo.id !== undefined, true);
});

test('an upload to a channel you cannot write in is refused before the files are read', async () => {
  const stranger = await srv.register('stranger');
  const r = await srv.upload(g.general.id, stranger.token, { content: 'x' }, [['a.txt', Buffer.alloc(1024 * 1024), 'text/plain']]);
  assert.deepEqual([r.status, r.body.code], [403, 50001]);
});

test('ephemeral message TTL sweeps expired messages and emits MESSAGE_DELETE, quality_mode sets voice mode', async () => {
  // Voice channel quality_mode
  const patchedVoice = await api('PATCH', `/channels/${g.voice.id}`, alice.token, { quality_mode: 'hifi' });
  assert.equal(patchedVoice.status, 200);
  assert.equal(patchedVoice.body.quality_mode, 'hifi');
  assert.equal((await api('GET', `/channels/${g.voice.id}`, alice.token)).body.quality_mode, 'hifi');

  const badMode = await api('PATCH', `/channels/${g.voice.id}`, alice.token, { quality_mode: 'surround' });
  assert.equal(badMode.status, 400);

  // Set message_ttl = 1 on g.general
  const patchedCh = await api('PATCH', `/channels/${g.general.id}`, alice.token, { message_ttl: 1 });
  assert.equal(patchedCh.status, 200);
  assert.equal(patchedCh.body.message_ttl, 1);
  assert.equal((await api('GET', `/channels/${g.general.id}`, alice.token)).body.message_ttl, 1);

  // Send an ephemeral message
  const msg = (await send(alice.token, { content: 'will disappear' })).body;
  assert.ok(msg.id);

  // Wait for MESSAGE_DELETE event on gateway due to TTL sweep
  const delEvent = await bob.gw.event('MESSAGE_DELETE', d => d.id === msg.id);
  assert.equal(delEvent.id, msg.id);
  assert.equal(delEvent.channel_id, g.general.id);

  // Message should no longer be in history
  const history = (await api('GET', `/channels/${g.general.id}/messages`, alice.token)).body;
  assert.ok(!history.some(m => m.id === msg.id));

  // Reset message_ttl
  await api('PATCH', `/channels/${g.general.id}`, alice.token, { message_ttl: 0 });

  // Test DM message_ttl patch
  const patchedDm = await api('PATCH', `/channels/${s.dm.id}`, alice.token, { message_ttl: 3600 });
  assert.equal(patchedDm.status, 200);
  assert.equal(patchedDm.body.message_ttl, 3600);
  assert.equal((await api('GET', `/channels/${s.dm.id}`, alice.token)).body.message_ttl, 3600);
});

