import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

let srv, api, socket, gateway;

before(async () => {
  srv = await startServer();
  ({ api, socket, gateway } = srv);
});

after(() => srv.stop());

const s = {}; // state shared by the sequential tests below

test('register two users', async () => {
  for (const name of ['alice', 'bob']) {
    const r = await api('POST', '/auth/register', null, { email: `${name}@example.com`, username: name, password: 'hunter2hunter2' });
    assert.equal(r.status, 201);
    assert.match(r.body.token, /^[A-Za-z0-9_-]{43}$/);
    s[name] = { token: r.body.token };
  }
  const dup = await api('POST', '/auth/register', null, { email: 'x@example.com', username: 'ALICE', password: 'hunter2hunter2' });
  assert.equal(dup.status, 400);
  assert.equal(dup.body.code, 50035);
  assert.ok(dup.body.errors.username._errors[0].code);
  const short = await api('POST', '/auth/register', null, { email: 'y@example.com', username: 'yy', password: 'short' });
  assert.equal(short.status, 400);
  assert.ok(short.body.errors.password);
});

test('login with email and with username', async () => {
  const byEmail = await api('POST', '/auth/login', null, { login: 'alice@example.com', password: 'hunter2hunter2' });
  assert.equal(byEmail.status, 200);
  const byName = await api('POST', '/auth/login', null, { login: 'Bob', password: 'hunter2hunter2' });
  assert.equal(byName.status, 200);
  s.alice.id = byEmail.body.user_id;
  s.bob.id = byName.body.user_id;
  assert.match(s.alice.id, /^\d+$/);
  const wrong = await api('POST', '/auth/login', null, { login: 'alice', password: 'wrongwrong' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.code, 40001);
  const unknown = await api('POST', '/auth/login', null, { login: 'nobody', password: 'wrongwrong' });
  assert.equal(unknown.status, 401);
});

test('auth header: raw and Bearer work, bad token is 401, logout invalidates', async () => {
  const raw = await api('GET', '/users/@me', s.alice.token);
  assert.equal(raw.status, 200);
  // v4 adds profile and MFA fields to the user object
  assert.deepEqual(raw.body, {
    id: s.alice.id, username: 'alice', discriminator: '0', global_name: null, avatar: null, bot: false, banner: null, accent_color: null,
    public_flags: 0, email: 'alice@example.com', mfa_enabled: false, verified: true, bio: '', pronouns: '',
    // v6 customization (v9 API shapes) and, for yourself, profile theme/effect/widgets and the admin flag
    avatar_decoration_data: null, collectibles: null, display_name_styles: null, primary_guild: null,
    theme_colors: null, profile_effect: null, widgets: [], instance_admin: false,
  });
  assert.equal((await api('GET', '/users/@me', `Bearer ${s.alice.token}`)).status, 200);
  const bad = await api('GET', '/users/@me', 'nope');
  assert.equal(bad.status, 401);
  assert.equal(bad.body.code, 40001);
  assert.equal((await api('GET', '/users/@me')).status, 401);
  const other = await api('GET', `/users/${s.bob.id}`, s.alice.token);
  assert.equal(other.body.email, undefined);
  const extra = (await api('POST', '/auth/login', null, { login: 'alice', password: 'hunter2hunter2' })).body.token;
  assert.equal((await api('POST', '/auth/logout', extra)).status, 204);
  assert.equal((await api('GET', '/users/@me', extra)).status, 401);
});

test('gateway: heartbeat ACK, bad token closes 4004, unknown op closes 4001', async () => {
  s.alice.gw = await gateway(s.alice.token);
  s.bob.gw = await gateway(s.bob.token);
  assert.equal(s.alice.gw.ready.v, 9);
  assert.equal(s.alice.gw.ready.user.email, 'alice@example.com');
  assert.deepEqual(s.alice.gw.ready.guilds, []);
  s.alice.gw.send({ op: 1, d: null });
  const ack = await s.alice.gw.wait(f => f.op === 11);
  assert.deepEqual(ack, { op: 11, d: null, s: null, t: null });

  const bad = socket();
  await bad.wait(f => f.op === 10);
  bad.send({ op: 2, d: { token: 'nope', properties: {} } });
  assert.equal(await bad.closed, 4004);

  const odd = socket();
  await odd.wait(f => f.op === 10);
  odd.send({ op: 42, d: null });
  assert.equal(await odd.closed, 4001);

  const resume = socket();
  await resume.wait(f => f.op === 10);
  resume.send({ op: 6, d: { token: s.alice.token, session_id: 'x', seq: 1 } });
  assert.deepEqual((await resume.wait(f => f.op === 9)).d, false);
});

test('create guild: has #general, creator is member', async () => {
  const r = await api('POST', '/guilds', s.alice.token, { name: 'Nightfall' });
  assert.equal(r.status, 201);
  assert.equal(r.body.owner_id, s.alice.id);
  assert.equal(r.body.member_count, 1);
  assert.equal(r.body.channels.length, 4); // v2: two categories, #general and a voice channel
  s.guild = r.body;
  s.general = r.body.channels.find(c => c.name === 'general');
  assert.equal(s.general.type, 0);
  const ev = await s.alice.gw.event('GUILD_CREATE');
  assert.equal(ev.id, s.guild.id);
  assert.equal(ev.members[0].user.id, s.alice.id);
  const members = await api('GET', `/guilds/${s.guild.id}/members?limit=1000`, s.alice.token);
  assert.deepEqual(members.body.map(m => m.user.id), [s.alice.id]);
  const mine = await api('GET', '/users/@me/guilds', s.alice.token);
  assert.deepEqual(mine.body.map(g => g.id), [s.guild.id]);
  assert.equal(mine.body[0].channels, undefined);
});

test('create channel', async () => {
  const r = await api('POST', `/guilds/${s.guild.id}/channels`, s.alice.token, { name: 'Off Topic' });
  assert.equal(r.status, 201);
  assert.equal(r.body.name, 'off-topic');
  assert.equal(r.body.type, 0);
  assert.equal(r.body.position, 2); // v2: last among top-level channels, after the two categories
  s.offTopic = r.body;
  assert.equal((await s.alice.gw.event('CHANNEL_CREATE')).id, s.offTopic.id);
  const blank = await api('POST', `/guilds/${s.guild.id}/channels`, s.alice.token, { name: '   ' });
  assert.equal(blank.status, 400);
  assert.equal(blank.body.code, 50035);
});

test('non-member gets 403 on a guild channel', async () => {
  const r = await api('GET', `/channels/${s.general.id}/messages`, s.bob.token);
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 50001);
  assert.equal((await api('GET', `/guilds/${s.guild.id}`, s.bob.token)).status, 403);
  assert.equal((await api('GET', '/channels/123', s.bob.token)).body.code, 10003);
});

test('invite + join', async () => {
  const inv = await api('POST', `/channels/${s.general.id}/invites`, s.alice.token, {});
  assert.equal(inv.status, 201);
  assert.match(inv.body.code, /^[A-Za-z0-9]{8}$/);
  assert.equal(inv.body.guild.id, s.guild.id);
  assert.equal(inv.body.inviter.id, s.alice.id);
  const peek = await api('GET', `/invites/${inv.body.code}`);
  assert.equal(peek.status, 200);
  assert.equal(peek.body.uses, 0);
  assert.equal(peek.body.approximate_member_count, undefined);
  assert.equal((await api('GET', `/invites/${inv.body.code}?with_counts=true`)).body.approximate_member_count, 1);
  assert.equal((await api('GET', '/invites/nope1234')).body.code, 10006);

  const joined = await api('POST', `/invites/${inv.body.code}`, s.bob.token);
  assert.equal(joined.status, 200);
  assert.equal(joined.body.id, s.guild.id);
  assert.equal(joined.body.member_count, 2);
  assert.equal(joined.body.channels.length, 5);

  const add = await s.alice.gw.event('GUILD_MEMBER_ADD');
  assert.equal(add.guild_id, s.guild.id);
  assert.equal(add.user.id, s.bob.id);
  assert.ok(add.joined_at);
  const create = await s.bob.gw.event('GUILD_CREATE');
  assert.equal(create.id, s.guild.id);
  assert.equal(create.members.length, 2);
  assert.equal(create.channels.length, 5);
});

test('message over REST reaches the other user as MESSAGE_CREATE', async () => {
  const r = await api('POST', `/channels/${s.general.id}/messages`, s.bob.token, { content: `hi <@${s.alice.id}>` });
  assert.equal(r.status, 201);
  const ev = await s.alice.gw.event('MESSAGE_CREATE', d => d.id === r.body.id); // v2: the join message came first
  assert.deepEqual(ev, r.body);
  assert.equal(ev.channel_id, s.general.id);
  assert.equal(ev.guild_id, s.guild.id);
  assert.equal(ev.content, `hi <@${s.alice.id}>`);
  assert.equal(ev.author.id, s.bob.id);
  assert.equal(ev.author.username, 'bob');
  assert.match(ev.timestamp, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.equal(ev.edited_timestamp, null);
  assert.deepEqual(ev.mentions.map(u => u.id), [s.alice.id]);
  assert.deepEqual([ev.attachments, ev.embeds, ev.pinned, ev.type], [[], [], false, 0]);
  await s.bob.gw.event('MESSAGE_CREATE', d => d.id === ev.id); // sender's own session too
  s.message = r.body;
  const ch = await api('GET', `/channels/${s.general.id}`, s.alice.token);
  assert.equal(ch.body.last_message_id, ev.id);
  const empty = await api('POST', `/channels/${s.general.id}/messages`, s.bob.token, { content: '  ' });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.code, 50006);
  const long = await api('POST', `/channels/${s.general.id}/messages`, s.bob.token, { content: 'x'.repeat(2001) });
  assert.equal(long.body.code, 50035);
});

test('edit and delete propagate', async () => {
  const notAuthor = await api('PATCH', `/channels/${s.general.id}/messages/${s.message.id}`, s.alice.token, { content: 'hacked' });
  assert.equal(notAuthor.status, 403);
  const edit = await api('PATCH', `/channels/${s.general.id}/messages/${s.message.id}`, s.bob.token, { content: 'hello' });
  assert.equal(edit.status, 200);
  const upd = await s.alice.gw.event('MESSAGE_UPDATE');
  assert.equal(upd.id, s.message.id);
  assert.equal(upd.content, 'hello');
  assert.ok(upd.edited_timestamp);

  const second = await api('POST', `/channels/${s.general.id}/messages`, s.bob.token, { content: 'second' });
  const list = await api('GET', `/channels/${s.general.id}/messages?limit=50`, s.alice.token);
  const userMessages = ms => ms.filter(m => m.type === 0).map(m => m.id); // v2: leaves out bob's join message
  assert.deepEqual(userMessages(list.body), [second.body.id, s.message.id]);
  const older = await api('GET', `/channels/${s.general.id}/messages?before=${second.body.id}`, s.alice.token);
  assert.deepEqual(userMessages(older.body), [s.message.id]);
  assert.equal((await api('GET', `/channels/${s.general.id}/messages?limit=101`, s.alice.token)).status, 400);
  const third = await api('POST', `/channels/${s.general.id}/messages`, s.bob.token, { content: 'third' });
  const around = await api('GET', `/channels/${s.general.id}/messages?around=${second.body.id}&limit=2`, s.alice.token); // one newer, then the message
  assert.deepEqual(around.body.map(m => m.id), [third.body.id, second.body.id]);

  const del = await api('DELETE', `/channels/${s.general.id}/messages/${s.message.id}`, s.alice.token); // guild owner may delete
  assert.equal(del.status, 204);
  assert.deepEqual(await s.bob.gw.event('MESSAGE_DELETE'), { id: s.message.id, channel_id: s.general.id, guild_id: s.guild.id });
  assert.equal((await api('DELETE', `/channels/${s.general.id}/messages/${s.message.id}`, s.alice.token)).body.code, 10008);
});

test('typing sends TYPING_START', async () => {
  assert.equal((await api('POST', `/channels/${s.general.id}/typing`, s.bob.token)).status, 204);
  const ev = await s.alice.gw.event('TYPING_START');
  assert.equal(ev.channel_id, s.general.id);
  assert.equal(ev.guild_id, s.guild.id);
  assert.equal(ev.user_id, s.bob.id);
  assert.ok(Number.isInteger(ev.timestamp) && Math.abs(ev.timestamp - Date.now() / 1000) < 10);
});

test('DM create + message round-trip', async () => {
  const dm = await api('POST', '/users/@me/channels', s.alice.token, { recipient_id: s.bob.id });
  assert.equal(dm.status, 200);
  assert.equal(dm.body.type, 1);
  assert.deepEqual(dm.body.recipients.map(u => u.id), [s.bob.id]);
  const bobSide = await s.bob.gw.event('CHANNEL_CREATE');
  assert.equal(bobSide.id, dm.body.id);
  assert.deepEqual(bobSide.recipients.map(u => u.id), [s.alice.id]);
  const again = await api('POST', '/users/@me/channels', s.bob.token, { recipient_id: s.alice.id });
  assert.equal(again.body.id, dm.body.id);

  const sent = await api('POST', `/channels/${dm.body.id}/messages`, s.alice.token, { content: 'psst' });
  assert.equal(sent.status, 201);
  const ev = await s.bob.gw.event('MESSAGE_CREATE', d => d.id === sent.body.id);
  assert.equal(ev.content, 'psst');
  assert.equal(ev.channel_id, dm.body.id);
  assert.equal(ev.guild_id, undefined);
  const reply = await api('POST', `/channels/${dm.body.id}/messages`, s.bob.token, { content: 'yes?' });
  await s.alice.gw.event('MESSAGE_CREATE', d => d.id === reply.body.id);
  const dms = await api('GET', '/users/@me/channels', s.bob.token);
  assert.deepEqual(dms.body.map(c => [c.id, c.last_message_id]), [[dm.body.id, reply.body.id]]);
});

test('presence: op 3 reaches users sharing a DM, READY lists presences, second session closes cleanly', async () => {
  s.alice.gw.send({ op: 3, d: { status: 'idle' } });
  assert.deepEqual(await s.bob.gw.event('PRESENCE_UPDATE', d => d.status === 'idle'), { user: { id: s.alice.id }, status: 'idle', activities: [], client_status: { web: 'idle' } });
  const second = await gateway(s.bob.token);
  assert.deepEqual(second.ready.presences.find(p => p.user.id === s.alice.id), { user: { id: s.alice.id }, status: 'idle', activities: [], client_status: { web: 'idle' } });
  second.ws.close();
  await second.closed;
  s.bob.gw.send({ op: 1, d: null });
  await s.bob.gw.wait(f => f.op === 11);
});

test('owner cannot leave; member can', async () => {
  const r = await api('DELETE', `/users/@me/guilds/${s.guild.id}`, s.alice.token);
  assert.equal(r.status, 400);
  assert.equal(typeof r.body.code, 'number');
  assert.equal((await api('DELETE', `/users/@me/guilds/${s.guild.id}`, s.bob.token)).status, 204);
  assert.equal((await s.bob.gw.event('GUILD_DELETE')).id, s.guild.id);
  assert.equal((await s.alice.gw.event('GUILD_MEMBER_REMOVE')).user.id, s.bob.id);
});

test('the last text channel cannot be deleted; other channels can', async () => {
  const del = await api('DELETE', `/channels/${s.offTopic.id}`, s.alice.token);
  assert.equal(del.status, 200);
  assert.equal(del.body.id, s.offTopic.id);
  assert.equal((await s.alice.gw.event('CHANNEL_DELETE')).id, s.offTopic.id);
  assert.equal((await api('GET', `/channels/${s.offTopic.id}`, s.alice.token)).status, 404);
  const r = await api('DELETE', `/channels/${s.general.id}`, s.alice.token);
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 0);
});

test('snowflakes are increasing strings', async () => {
  const { snowflake } = await import('../src/snowflake.js');
  const ids = Array.from({ length: 10000 }, snowflake);
  for (let i = 1; i < ids.length; i++) assert.ok(BigInt(ids[i]) > BigInt(ids[i - 1]));
  assert.ok(Number((BigInt(ids[0]) >> 22n) + 1420070400000n) <= Date.now() + 10);
});
