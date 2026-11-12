import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, guildWith, png, bits } from './helpers.js';

let srv, api, g, alice, bob, carol, other;
const s = {};
before(async () => {
  srv = await startServer();
  api = srv.api;
  g = await guildWith(srv, ['alice', 'bob', 'carol']);
  ({ alice, bob, carol } = g.users);
  await api('PATCH', `/guilds/${g.guild.id}`, alice.token, { auto_spam_slowmode_enabled: false }); // these tests send fast on purpose
  for (const u of [alice, bob]) u.gw = await srv.gateway(u.token);
  other = (await api('POST', '/guilds', bob.token, { name: 'Bob Place' })).body;
});
after(() => srv.stop());

const uri = (type, b) => `data:${type};base64,${b.toString('base64')}`;
const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([1, 0, 1, 0]), Buffer.alloc(20)]);

test('custom emoji: CREATE/MANAGE_GUILD_EXPRESSIONS, validation, animated GIFs, CDN, GUILD_EMOJIS_UPDATE', async () => {
  const add = (who, body, guild = g.guild.id) => api('POST', `/guilds/${guild}/emojis`, who.token, body);
  assert.equal((await add(bob, { name: 'nope', image: uri('image/png', png()) })).status, 403);
  assert.equal((await add(alice, { name: 'x', image: uri('image/png', png()) })).status, 400, 'name 2-32');
  assert.equal((await add(alice, { name: 'bad-name', image: uri('image/png', png()) })).status, 400);
  assert.equal((await add(alice, { name: 'big', image: uri('image/png', Buffer.concat([png(), Buffer.alloc(300 * 1024)])) })).status, 400);
  const r = await add(alice, { name: 'cill', image: uri('image/png', png(16, 16)) });
  assert.equal(r.status, 201);
  s.emoji = r.body;
  assert.deepEqual([r.body.name, r.body.animated, r.body.roles, r.body.user.id], ['cill', false, [], alice.id]);
  assert.equal((await bob.gw.event('GUILD_EMOJIS_UPDATE')).emojis[0].id, s.emoji.id);
  const anim = (await add(alice, { name: 'party', image: uri('image/gif', gif) })).body;
  assert.equal(anim.animated, true);
  const cdn = await fetch(`${srv.origin}/emojis/${s.emoji.id}.webp`);
  assert.deepEqual([cdn.status, cdn.headers.get('content-type')], [200, 'image/png']);
  assert.deepEqual((await api('GET', `/guilds/${g.guild.id}`, bob.token)).body.emojis.map(e => e.name), ['cill', 'party']);
  // members with CREATE_GUILD_EXPRESSIONS edit their own, not others'
  const maker = (await api('POST', `/guilds/${g.guild.id}/roles`, alice.token, { name: 'maker', permissions: bits(10, 11, 16, 43) })).body;
  await api('PATCH', `/guilds/${g.guild.id}/members/${carol.id}`, alice.token, { roles: [maker.id] });
  const own = (await add(carol, { name: 'carols', image: uri('image/png', png()) })).body;
  assert.equal((await api('PATCH', `/guilds/${g.guild.id}/emojis/${own.id}`, carol.token, { name: 'renamed' })).body.name, 'renamed');
  assert.equal((await api('PATCH', `/guilds/${g.guild.id}/emojis/${s.emoji.id}`, carol.token, { name: 'mine' })).status, 403);
  assert.equal((await api('DELETE', `/guilds/${g.guild.id}/emojis/${own.id}`, carol.token)).status, 204);
  assert.equal((await fetch(`${srv.origin}/emojis/${own.id}.png`)).status, 404);
});

test('custom emoji in messages and reactions: USE_EXTERNAL_EMOJIS and role locks', async () => {
  const m = (await api('POST', `/channels/${g.general.id}/messages`, bob.token, { content: `hi <:cill:${s.emoji.id}>` })).body;
  assert.equal(m.content, `hi <:cill:${s.emoji.id}>`);
  const react = (who, emoji) => api('PUT', `/channels/${g.general.id}/messages/${m.id}/reactions/${encodeURIComponent(emoji)}/@me`, who.token);
  assert.equal((await react(bob, `cill:${s.emoji.id}`)).status, 204);
  const ev = await alice.gw.event('MESSAGE_REACTION_ADD');
  assert.deepEqual(ev.emoji, { id: s.emoji.id, name: 'cill' });
  const [msg] = (await api('GET', `/channels/${g.general.id}/messages?limit=1`, alice.token)).body;
  assert.deepEqual(msg.reactions, [{ emoji: { id: s.emoji.id, name: 'cill' }, count: 1, me: false }]);
  assert.equal((await react(bob, 'nope:123')).body.code, 10014);

  // an emoji from another guild: only for its members, and only with USE_EXTERNAL_EMOJIS
  const ext = (await api('POST', `/guilds/${other.id}/emojis`, bob.token, { name: 'bobs', image: uri('image/png', png()) })).body;
  const withExt = (await api('POST', `/channels/${g.general.id}/messages`, bob.token, { content: `<:bobs:${ext.id}>` })).body;
  assert.equal(withExt.content, `<:bobs:${ext.id}>`);
  const notMember = (await api('POST', `/channels/${g.general.id}/messages`, alice.token, { content: `<:bobs:${ext.id}>` })).body;
  assert.equal(notMember.content, ':bobs:', 'unusable emoji degrade to :name:');
  await api('PUT', `/channels/${g.general.id}/permissions/${g.guild.id}`, alice.token, { type: 0, allow: '0', deny: bits(18) });
  assert.equal((await api('POST', `/channels/${g.general.id}/messages`, bob.token, { content: `<:bobs:${ext.id}>` })).body.content, ':bobs:');
  assert.equal((await react(bob, `bobs:${ext.id}`)).body.code, 10014);
  await api('DELETE', `/channels/${g.general.id}/permissions/${g.guild.id}`, alice.token);

  // role-locked emoji
  const vip = (await api('POST', `/guilds/${g.guild.id}/roles`, alice.token, { name: 'vip' })).body;
  await api('PATCH', `/guilds/${g.guild.id}/emojis/${s.emoji.id}`, alice.token, { roles: [vip.id] });
  const lockedMsg = (await api('POST', `/channels/${g.general.id}/messages`, bob.token, { content: `<:cill:${s.emoji.id}>` })).body;
  assert.equal(lockedMsg.content, ':cill:');
  // editing a message also enforces custom emoji access (external and role-locked)
  assert.equal((await api('PATCH', `/channels/${g.general.id}/messages/${lockedMsg.id}`, bob.token, { content: `<:cill:${s.emoji.id}>` })).body.content, ':cill:');
  assert.equal((await api('PATCH', `/channels/${g.general.id}/messages/${notMember.id}`, alice.token, { content: `<:bobs:${ext.id}>` })).body.content, ':bobs:');
  await api('PATCH', `/guilds/${g.guild.id}/members/${bob.id}`, alice.token, { roles: [vip.id] });
  assert.equal((await api('PATCH', `/channels/${g.general.id}/messages/${lockedMsg.id}`, bob.token, { content: `<:cill:${s.emoji.id}>` })).body.content, `<:cill:${s.emoji.id}>`);
  assert.equal((await api('POST', `/channels/${g.general.id}/messages`, bob.token, { content: `<:cill:${s.emoji.id}>` })).body.content, `<:cill:${s.emoji.id}>`);
});

test('stickers: multipart upload, validation, sticker_ids in messages, GUILD_STICKERS_UPDATE', async () => {
  const add = (who, fields, file = ['file', 's.png', png(320, 320), 'image/png'], guild = g.guild.id) =>
    srv.form('POST', `/guilds/${guild}/stickers`, who.token, new Map(Object.entries(fields)), file ? [file] : []);
  assert.equal((await add(bob, { name: 'wave', tags: '👋' })).status, 403);
  assert.equal((await add(alice, { name: 'wave', tags: '👋' }, ['file', 's.png', png(321, 320), 'image/png'])).status, 400, 'max 320x320');
  assert.equal((await add(alice, { name: 'wave', tags: '👋' }, ['file', 's.txt', 'hello', 'text/plain'])).status, 400);
  const r = await add(alice, { name: 'wave', tags: '👋', description: 'hello there' });
  assert.equal(r.status, 201);
  const st = r.body;
  assert.deepEqual([st.name, st.tags, st.type, st.format_type, st.guild_id], ['wave', '👋', 2, 1, g.guild.id]);
  assert.equal((await bob.gw.event('GUILD_STICKERS_UPDATE')).stickers[0].id, st.id);
  assert.equal((await fetch(`${srv.origin}/stickers/${st.id}.png`)).status, 200);
  assert.equal((await api('GET', `/stickers/${st.id}`, bob.token)).body.name, 'wave');
  const m = await api('POST', `/channels/${g.general.id}/messages`, bob.token, { sticker_ids: [st.id] });
  assert.equal(m.status, 201);
  assert.deepEqual(m.body.sticker_items, [{ id: st.id, name: 'wave', format_type: 1 }]);
  assert.equal((await api('POST', `/channels/${g.general.id}/messages`, bob.token, { sticker_ids: ['1', '2', '3', '4'] })).status, 400);
  // another guild's sticker needs membership there and USE_EXTERNAL_STICKERS
  const ext = (await add(bob, { name: 'bobst', tags: 'b' }, undefined, other.id)).body;
  assert.equal((await api('POST', `/channels/${g.general.id}/messages`, bob.token, { sticker_ids: [ext.id] })).status, 201);
  assert.equal((await api('POST', `/channels/${g.general.id}/messages`, alice.token, { sticker_ids: [ext.id] })).status, 400);
  assert.equal((await api('PATCH', `/guilds/${g.guild.id}/stickers/${st.id}`, alice.token, { name: 'hi' })).body.name, 'hi');
  assert.equal((await api('DELETE', `/guilds/${g.guild.id}/stickers/${st.id}`, alice.token)).status, 204);
  assert.deepEqual((await api('GET', '/sticker-packs', bob.token)).body, { sticker_packs: [] });
});

test('GIF picker answers 404 without GIPHY_API_KEY or returns curated fallback', async () => {
  const res = await api('GET', '/gifs/trending', bob.token);
  assert.ok(res.status === 200 || res.status === 404);
  const searchRes = await api('GET', '/gifs/search?q=cat', bob.token);
  assert.ok(searchRes.status === 200 || searchRes.status === 404);
});

test('scheduled events: create, interested users with events, status transitions, permissions', async () => {
  const start = new Date(Date.now() + 3600e3).toISOString();
  const body = { name: 'Scrim night', entity_type: 2, channel_id: g.voice.id, privacy_level: 2, scheduled_start_time: start, description: 'bring snacks' };
  assert.equal((await api('POST', `/guilds/${g.guild.id}/scheduled-events`, bob.token, body)).status, 403);
  const r = await api('POST', `/guilds/${g.guild.id}/scheduled-events`, alice.token, { ...body, image: uri('image/png', png()) });
  assert.equal(r.status, 200);
  const e = r.body;
  assert.deepEqual([e.status, e.entity_type, e.channel_id, e.creator.id, e.user_count], [1, 2, g.voice.id, alice.id, 0]);
  assert.equal((await bob.gw.event('GUILD_SCHEDULED_EVENT_CREATE')).id, e.id);
  assert.equal((await fetch(`${srv.origin}/guild-events/${e.id}/${e.image}`)).status, 200);
  assert.equal((await api('POST', `/guilds/${g.guild.id}/scheduled-events`, alice.token, { ...body, entity_type: 3, channel_id: null })).status, 400, 'external needs location and end');
  const ext = await api('POST', `/guilds/${g.guild.id}/scheduled-events`, alice.token, {
    name: 'LAN', entity_type: 3, entity_metadata: { location: 'Klagenfurt' }, scheduled_start_time: start, scheduled_end_time: new Date(Date.now() + 7200e3).toISOString(),
  });
  assert.deepEqual([ext.body.channel_id, ext.body.entity_metadata], [null, { location: 'Klagenfurt' }]);

  assert.equal((await api('PUT', `/guilds/${g.guild.id}/scheduled-events/${e.id}/users/@me`, bob.token)).status, 200);
  assert.deepEqual(await alice.gw.event('GUILD_SCHEDULED_EVENT_USER_ADD'), { guild_scheduled_event_id: e.id, user_id: bob.id, guild_id: g.guild.id });
  const users = (await api('GET', `/guilds/${g.guild.id}/scheduled-events/${e.id}/users?with_member=true`, alice.token)).body;
  assert.deepEqual(users.map(u => [u.guild_scheduled_event_id, u.user.id, u.member.user.id]), [[e.id, bob.id, bob.id]]);
  assert.equal((await api('GET', `/guilds/${g.guild.id}/scheduled-events?with_user_count=true`, bob.token)).body.find(x => x.id === e.id).user_count, 1);
  assert.equal((await api('DELETE', `/guilds/${g.guild.id}/scheduled-events/${e.id}/users/@me`, bob.token)).status, 204);
  await alice.gw.event('GUILD_SCHEDULED_EVENT_USER_REMOVE');

  const patch = b => api('PATCH', `/guilds/${g.guild.id}/scheduled-events/${e.id}`, alice.token, b);
  assert.equal((await patch({ status: 3 })).status, 400, 'SCHEDULED cannot jump to COMPLETED');
  assert.equal((await patch({ status: 2 })).body.status, 2);
  assert.equal((await patch({ status: 3 })).body.status, 3);
  assert.equal((await patch({ name: 'late' })).body.code, 180000);
  const ready = await srv.gateway(bob.token);
  assert.deepEqual(ready.ready.guilds[0].guild_scheduled_events.map(x => x.name), ['LAN']);
  ready.ws.close();
  assert.equal((await api('DELETE', `/guilds/${g.guild.id}/scheduled-events/${ext.body.id}`, alice.token)).status, 204);
  assert.equal((await bob.gw.event('GUILD_SCHEDULED_EVENT_DELETE')).id, ext.body.id);
});
