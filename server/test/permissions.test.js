import { test, before, after } from 'node:test';
import { rm } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { startServer, guildWith, tempDir } from './helpers.js';

const VIEW = 1n << 10n, SEND = 1n << 11n, ATTACH = 1n << 15n, MENTION_EVERYONE = 1n << 17n, ADMIN = 1n << 3n;
const CONNECT = 1n << 20n, SPEAK = 1n << 21n, STREAM = 1n << 9n;
const KICK = 1n << 1n, BAN = 1n << 2n, MANAGE_ROLES = 1n << 28n, MANAGE_NICKNAMES = 1n << 27n, MANAGE_CHANNELS = 1n << 4n;

test('permission algorithm: base, overwrites in order, ADMINISTRATOR and owner', async () => {
  process.env.DATA_DIR = await tempDir();
  const { db, run } = await import('../src/db.js');
  const { channelPerms, guildPerms, ALL, DEFAULT_PERMISSIONS } = await import('../src/permissions.js');
  assert.equal(DEFAULT_PERMISSIONS, '673423025360449'); // v3: v2's 70356545 plus bits 14, 18, 31, 32, 35-38, 42, 45, 46, 49
  for (const id of ['1', '2', '3']) run("INSERT INTO users (id, email, username, password_hash, salt) VALUES (?, ?, ?, 'x', 'x')", id, `${id}@x`, `u${id}`);
  run("INSERT INTO guilds (id, name, owner_id) VALUES ('10', 'g', '1')");
  for (const id of ['1', '2', '3']) run("INSERT INTO members (guild_id, user_id, joined_at) VALUES ('10', ?, 'now')", id);
  run("INSERT INTO roles (id, guild_id, name, position, permissions) VALUES ('10', '10', '@everyone', 0, ?)", String(VIEW | SEND | ATTACH));
  run("INSERT INTO roles (id, guild_id, name, position, permissions) VALUES ('11', '10', 'a', 1, ?)", String(MENTION_EVERYONE));
  run("INSERT INTO roles (id, guild_id, name, position, permissions) VALUES ('12', '10', 'b', 2, '0')");
  run("INSERT INTO roles (id, guild_id, name, position, permissions) VALUES ('13', '10', 'admin', 3, ?)", String(ADMIN));
  run("INSERT INTO member_roles VALUES ('10', '2', '11'), ('10', '2', '12'), ('10', '3', '13')");
  run("INSERT INTO channels (id, type, guild_id, name) VALUES ('20', 0, '10', 'text'), ('21', 2, '10', 'voice')");
  const text = { id: '20', type: 0, guild_id: '10' };
  const voice = { id: '21', type: 2, guild_id: '10' };

  assert.equal(guildPerms('10', '2'), VIEW | SEND | ATTACH | MENTION_EVERYONE);
  assert.equal(channelPerms(text, '2'), VIEW | SEND | ATTACH | MENTION_EVERYONE);
  // @everyone denies SEND; role a denies VIEW, role b allows it back: role overwrites are ORed, allow applied after deny
  run("INSERT INTO overwrites VALUES ('20', '10', 0, '0', ?), ('20', '11', 0, '0', ?), ('20', '12', 0, ?, '0')", String(SEND), String(VIEW), String(VIEW));
  // without SEND in a text channel, ATTACH_FILES and MENTION_EVERYONE go too
  assert.equal(channelPerms(text, '2'), VIEW);
  // the member's own overwrite comes last
  run("INSERT INTO overwrites VALUES ('20', '2', 1, ?, '0')", String(SEND));
  assert.equal(channelPerms(text, '2'), VIEW | SEND | ATTACH | MENTION_EVERYONE);
  run("UPDATE overwrites SET allow = '0', deny = ? WHERE target_id = '2'", String(VIEW));
  assert.equal(channelPerms(text, '2'), 0n, 'no VIEW_CHANNEL means nothing');
  // ADMINISTRATOR and owner ignore overwrites
  run("INSERT INTO overwrites VALUES ('20', '3', 1, '0', ?), ('20', '1', 1, '0', ?)", String(VIEW), String(VIEW));
  assert.equal(channelPerms(text, '3'), ALL);
  assert.equal(channelPerms(text, '1'), ALL);
  // voice without CONNECT drops SPEAK and STREAM
  run("UPDATE roles SET permissions = ? WHERE id = '10'", String(VIEW | CONNECT | SPEAK | STREAM));
  // v3: voice channels have text chat, so without SEND_MESSAGES MENTION_EVERYONE goes there too
  assert.equal(channelPerms(voice, '2'), VIEW | CONNECT | SPEAK | STREAM);
  run("INSERT INTO overwrites VALUES ('21', '10', 0, '0', ?)", String(CONNECT));
  assert.equal(channelPerms(voice, '2'), VIEW);
  assert.equal(channelPerms(text, '99'), 0n, 'non-members have nothing');
  db.close();
  await rm(process.env.DATA_DIR, { recursive: true, force: true });
});

let srv, api, g;
const s = {};
before(async () => {
  srv = await startServer();
  api = srv.api;
  g = await guildWith(srv, ['alice', 'bob', 'carol', 'dave', 'erin']);
  for (const n of Object.keys(g.users)) g.users[n].gw = await srv.gateway(g.users[n].token);
});
after(() => srv.stop());

const guildPath = p => `/guilds/${g.guild.id}${p}`;

test('new guild: @everyone with default permissions, categories, voice channel, system channel', async () => {
  const everyone = g.guild.roles.find(r => r.id === g.guild.id);
  assert.deepEqual(everyone, { id: g.guild.id, name: '@everyone', color: 0, hoist: false, position: 0, permissions: '673423025360449', mentionable: false, managed: false, colors: { primary_color: 0, secondary_color: null, tertiary_color: null }, icon: null, unicode_emoji: null });
  assert.equal(g.general.parent_id, g.textCategory.id);
  assert.equal(g.voice.name, 'General');
  assert.equal(g.voice.user_limit, 0);
  assert.equal(g.guild.system_channel_id, g.general.id);
  assert.deepEqual(g.general.permission_overwrites, []);
  const ready = g.users.bob.gw.ready.guilds[0];
  assert.deepEqual(ready.voice_states, []);
  assert.equal(ready.roles.length, 1);
});

test('roles: create, assign, hierarchy', async () => {
  const { alice, bob, carol, dave, erin } = g.users;
  const mk = async body => (await api('POST', guildPath('/roles'), alice.token, body)).body;
  s.member = await mk({ name: 'Member', mentionable: true });
  s.mod = await mk({ name: 'Mod', permissions: String(KICK | BAN | MANAGE_ROLES | MANAGE_NICKNAMES | MANAGE_CHANNELS | (1n << 10n)) });
  s.admin = await mk({ name: 'Admin', permissions: String(ADMIN) });
  const created = await bob.gw.event('GUILD_ROLE_CREATE', d => d.role.id === s.admin.id);
  assert.equal(created.guild_id, g.guild.id);
  const roles = (await api('GET', guildPath('/roles'), bob.token)).body;
  assert.deepEqual(roles.map(r => r.name), ['@everyone', 'Admin', 'Mod', 'Member']); // each new role lands at position 1
  // put Admin on top
  const reordered = await api('PATCH', guildPath('/roles'), alice.token, [{ id: s.admin.id, position: 3 }, { id: s.member.id, position: 1 }]);
  assert.deepEqual(reordered.body.map(r => [r.name, r.position]), [['@everyone', 0], ['Member', 1], ['Mod', 2], ['Admin', 3]]);

  const assign = (who, roleIds, token = alice.token) => api('PATCH', guildPath(`/members/${who.id}`), token, { roles: roleIds });
  assert.equal((await assign(bob, [s.mod.id])).status, 200);
  assert.equal((await assign(dave, [s.mod.id])).status, 200);
  assert.equal((await assign(erin, [s.admin.id])).status, 200);
  const upd = await carol.gw.event('GUILD_MEMBER_UPDATE', d => d.user.id === erin.id);
  assert.deepEqual(upd.roles, [s.admin.id]);
  assert.equal(upd.guild_id, g.guild.id);

  const denied = r => { assert.equal(r.status, 403); assert.equal(r.body.code, 50013); };
  // a moderator cannot kick or ban the admin, an equal, or the owner
  denied(await api('DELETE', guildPath(`/members/${erin.id}`), bob.token));
  denied(await api('PUT', guildPath(`/bans/${erin.id}`), bob.token, {}));
  denied(await api('DELETE', guildPath(`/members/${dave.id}`), bob.token));
  denied(await api('DELETE', guildPath(`/members/${alice.id}`), bob.token));
  // cannot grant a permission they lack, edit a higher or equal role, or hand out a role above them
  denied(await api('POST', guildPath('/roles'), bob.token, { name: 'x', permissions: String(ADMIN) }));
  denied(await api('PATCH', guildPath(`/roles/${s.admin.id}`), bob.token, { name: 'mine' }));
  denied(await api('PATCH', guildPath(`/roles/${s.mod.id}`), bob.token, { color: 1 }));
  denied(await assign(carol, [s.admin.id], bob.token));
  denied(await api('PATCH', guildPath('/roles'), bob.token, [{ id: s.member.id, position: 3 }]));
  // but may manage what is below
  assert.equal((await assign(carol, [s.member.id], bob.token)).status, 200);
  assert.equal((await api('PATCH', guildPath(`/roles/${s.member.id}`), bob.token, { color: 255, permissions: String(KICK) })).status, 200);
  const nick = await api('PATCH', guildPath(`/members/${carol.id}`), bob.token, { nick: 'Caz' });
  assert.equal(nick.body.nick, 'Caz');
  assert.equal((await api('PATCH', guildPath('/members/@me'), carol.token, { nick: 'Carol C' })).body.nick, 'Carol C');
  // the admin skips the grant rule but not the rank rule
  assert.equal((await api('POST', guildPath('/roles'), erin.token, { name: 'temp', permissions: String(ADMIN) })).status, 200);
  denied(await api('DELETE', guildPath(`/members/${alice.id}`), erin.token));
  const temp = (await api('GET', guildPath('/roles'), erin.token)).body.find(r => r.name === 'temp');
  assert.equal((await api('DELETE', guildPath(`/roles/${temp.id}`), erin.token)).status, 204);
  assert.equal((await bob.gw.event('GUILD_ROLE_DELETE', d => d.role_id === temp.id)).guild_id, g.guild.id);
  assert.equal((await api('DELETE', guildPath(`/roles/${g.guild.id}`), alice.token)).status, 400);
});

test('private channel via overwrite: no VIEW_CHANNEL means 403 and no MESSAGE_CREATE', async () => {
  const { alice, bob, carol } = g.users;
  const r = await api('POST', guildPath('/channels'), alice.token, {
    name: 'Staff Room', parent_id: g.textCategory.id,
    permission_overwrites: [{ id: g.guild.id, type: 0, allow: '0', deny: String(VIEW) }, { id: s.mod.id, type: 0, allow: String(VIEW), deny: '0' }],
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.name, 'staff-room');
  s.staff = r.body;
  // carol still receives the channel (with its overwrites), the reference behaviour
  const created = await carol.gw.event('CHANNEL_CREATE', d => d.id === s.staff.id);
  assert.equal(created.permission_overwrites.length, 2);
  const history = await api('GET', `/channels/${s.staff.id}/messages`, carol.token);
  assert.equal(history.status, 403);
  assert.equal((await api('POST', `/channels/${s.staff.id}/messages`, carol.token, { content: 'hi' })).status, 403);
  const sent = await api('POST', `/channels/${s.staff.id}/messages`, alice.token, { content: 'staff only' });
  await bob.gw.event('MESSAGE_CREATE', d => d.id === sent.body.id);
  assert.ok(await carol.gw.none(f => f.t === 'MESSAGE_CREATE' && f.d.id === sent.body.id));
  // a member overwrite opens it for carol alone
  assert.equal((await api('PUT', `/channels/${s.staff.id}/permissions/${carol.id}`, alice.token, { type: 1, allow: String(VIEW), deny: '0' })).status, 204);
  assert.equal((await carol.gw.event('CHANNEL_UPDATE', d => d.id === s.staff.id)).permission_overwrites.length, 3);
  assert.equal((await api('GET', `/channels/${s.staff.id}/messages`, carol.token)).status, 200);
  // bob (Mod, has MANAGE_ROLES) cannot grant bits he lacks, nor touch the owner
  assert.equal((await api('PUT', `/channels/${s.staff.id}/permissions/${carol.id}`, bob.token, { type: 1, allow: String(ADMIN), deny: '0' })).status, 403);
  assert.equal((await api('PUT', `/channels/${s.staff.id}/permissions/${alice.id}`, bob.token, { type: 1, allow: '0', deny: String(VIEW) })).status, 403);
  assert.equal((await api('DELETE', `/channels/${s.staff.id}/permissions/${carol.id}`, alice.token)).status, 204);
  assert.equal((await api('GET', `/channels/${s.staff.id}/messages`, carol.token)).status, 403);
});

test('categories: children copy overwrites; deleting a category orphans its children', async () => {
  const { alice } = g.users;
  const cat = (await api('POST', guildPath('/channels'), alice.token, {
    name: 'Ops Area', type: 4, permission_overwrites: [{ id: g.guild.id, type: 0, allow: '0', deny: String(SEND) }],
  })).body;
  assert.equal(cat.name, 'Ops Area'); // categories keep their case
  const child = (await api('POST', guildPath('/channels'), alice.token, { name: 'Briefing', parent_id: cat.id })).body;
  assert.deepEqual(child.permission_overwrites, cat.permission_overwrites);
  assert.equal(child.position, 0);
  const vc = (await api('POST', guildPath('/channels'), alice.token, { name: 'Scrim Comms', type: 2, parent_id: cat.id, user_limit: 5 })).body;
  assert.deepEqual([vc.name, vc.user_limit, vc.position, vc.topic], ['Scrim Comms', 5, 1, undefined]);
  assert.equal((await api('POST', guildPath('/channels'), alice.token, { name: 'x', type: 4, parent_id: cat.id })).status, 400);
  assert.equal((await api('DELETE', `/channels/${cat.id}`, alice.token)).status, 200);
  assert.equal((await api('GET', `/channels/${child.id}`, alice.token)).body.parent_id, null);
  s.briefing = child;
});

test('reorder channels', async () => {
  const { alice, carol } = g.users;
  const r = await api('PATCH', guildPath('/channels'), alice.token, [{ id: s.briefing.id, position: 7, parent_id: g.textCategory.id }]);
  assert.equal(r.status, 204);
  const ev = await carol.gw.event('CHANNEL_UPDATE', d => d.id === s.briefing.id && d.position === 7);
  assert.equal(ev.parent_id, g.textCategory.id);
  assert.equal((await api('PATCH', guildPath('/channels'), carol.token, [{ id: s.briefing.id, position: 1 }])).status, 403);
  assert.equal((await api('PATCH', guildPath('/channels'), alice.token, [{ id: '123', position: 1 }])).status, 400);
});

test('kick and ban: ban deletes recent messages, blocks rejoining until unbanned', async () => {
  const { alice, bob, carol, dave } = g.users;
  const old = (await api('POST', `/channels/${g.general.id}/messages`, carol.token, { content: 'old' })).body;
  await new Promise(r => setTimeout(r, 1100));
  const m1 = (await api('POST', `/channels/${g.general.id}/messages`, carol.token, { content: 'one' })).body;
  const m2 = (await api('POST', `/channels/${g.general.id}/messages`, carol.token, { content: 'two' })).body;
  // bob (Mod) bans carol (Member), deleting the last second of her messages
  assert.equal((await api('PUT', guildPath(`/bans/${carol.id}`), bob.token, { reason: 'spam', delete_message_seconds: 1 })).status, 204);
  assert.equal((await carol.gw.event('GUILD_DELETE')).id, g.guild.id);
  assert.equal((await alice.gw.event('GUILD_MEMBER_REMOVE', d => d.user.id === carol.id)).guild_id, g.guild.id);
  const bulk = await alice.gw.event('MESSAGE_DELETE_BULK');
  assert.deepEqual(new Set(bulk.ids), new Set([m1.id, m2.id]));
  assert.equal(bulk.channel_id, g.general.id);
  const left = (await api('GET', `/channels/${g.general.id}/messages`, alice.token)).body.map(m => m.id);
  assert.ok(left.includes(old.id) && !left.includes(m1.id));
  assert.equal((await alice.gw.event('GUILD_BAN_ADD')).user.id, carol.id);
  const bans = await api('GET', guildPath('/bans'), alice.token);
  assert.deepEqual(bans.body.map(b => [b.user.id, b.reason]), [[carol.id, 'spam']]);
  assert.equal((await api('GET', guildPath('/bans'), g.users.erin.token)).status, 200); // admin
  const rejoin = await api('POST', `/invites/${g.invite.code}`, carol.token);
  assert.deepEqual([rejoin.status, rejoin.body.code], [403, 40007]);
  assert.equal((await api('DELETE', guildPath(`/bans/${carol.id}`), bob.token)).status, 204);
  await alice.gw.event('GUILD_BAN_REMOVE');
  assert.equal((await api('POST', `/invites/${g.invite.code}`, carol.token)).status, 200);
  // ban someone who never was a member
  const stranger = await srv.register('stranger');
  assert.equal((await api('PUT', guildPath(`/bans/${stranger.id}`), alice.token, {})).status, 204);
  assert.equal((await api('POST', `/invites/${g.invite.code}`, stranger.token)).body.code, 40007);
  // kick
  assert.equal((await api('DELETE', guildPath(`/members/${carol.id}`), bob.token)).status, 204);
  assert.equal((await carol.gw.event('GUILD_DELETE')).id, g.guild.id);
  assert.equal((await api('GET', guildPath(''), carol.token)).status, 403);
  assert.equal((await api('DELETE', guildPath(`/members/${carol.id}`), alice.token)).body.code, 10007);
  assert.equal((await api('DELETE', guildPath(`/members/${dave.id}`), carol.token)).status, 403);
});

test('invites: max_uses, expiry, listing and revoking', async () => {
  const { alice, bob, dave } = g.users;
  const once = (await api('POST', `/channels/${g.general.id}/invites`, bob.token, { max_uses: 1, max_age: 0 })).body;
  assert.deepEqual([once.max_uses, once.max_age, once.uses, once.expires_at], [1, 0, 0, null]);
  assert.ok(once.created_at);
  const x = await srv.register('xavier');
  const y = await srv.register('yvonne');
  assert.equal((await api('POST', `/invites/${once.code}`, x.token)).status, 200);
  assert.equal((await api('POST', `/invites/${once.code}`, y.token)).body.code, 10006);
  const short = (await api('POST', `/channels/${g.general.id}/invites`, alice.token, { max_age: 1 })).body;
  assert.ok(Date.parse(short.expires_at) - Date.now() <= 1000);
  await new Promise(r => setTimeout(r, 1100));
  assert.equal((await api('GET', `/invites/${short.code}`)).body.code, 10006);
  const list = await api('GET', guildPath('/invites'), alice.token);
  assert.ok(list.body.some(i => i.code === g.invite.code));
  assert.equal((await api('GET', guildPath('/invites'), dave.token)).status, 403);
  const mine = (await api('POST', `/channels/${g.general.id}/invites`, dave.token, {})).body;
  assert.equal((await api('DELETE', `/invites/${mine.code}`, bob.token)).status, 403);
  const revoked = await api('DELETE', `/invites/${mine.code}`, dave.token);
  assert.deepEqual([revoked.status, revoked.body.code], [200, mine.code]);
  assert.equal((await api('GET', `/invites/${mine.code}`)).status, 404);
});

test('overwrites: self-lockout recovery, unchanged bits, and duplicate overwrite targets', async () => {
  const { alice, bob } = g.users;
  const MUTE = 1n << 22n;
  const ch = (await api('POST', guildPath('/channels'), alice.token, {
    name: 'mod-room',
    permission_overwrites: [
      { id: s.mod.id, type: 0, allow: String(VIEW | MANAGE_ROLES | MANAGE_CHANNELS), deny: '0' },
      { id: s.member.id, type: 0, allow: String(MUTE), deny: '0' },
    ],
  })).body;
  // bob (Mod) denies SEND on @everyone; even though bob's channelPerms in ch now lack SEND, bob still has SEND at guild level and can undo or update it
  assert.equal((await api('PUT', `/channels/${ch.id}/permissions/${g.guild.id}`, bob.token, { type: 0, allow: '0', deny: String(SEND) })).status, 204);
  assert.equal((await api('DELETE', `/channels/${ch.id}/permissions/${g.guild.id}`, bob.token)).status, 204);
  // bob lacks MUTE, which is already on Member's overwrite; bob can add SEND to Member's overwrite as long as MUTE is unchanged, but cannot strip MUTE
  assert.equal((await api('PUT', `/channels/${ch.id}/permissions/${s.member.id}`, bob.token, { type: 0, allow: String(MUTE | SEND), deny: '0' })).status, 204);
  assert.equal((await api('PUT', `/channels/${ch.id}/permissions/${s.member.id}`, bob.token, { type: 0, allow: String(SEND), deny: '0' })).status, 403);
  // duplicate target ids in permission_overwrites are rejected with 400 instead of 500
  const dup = await api('PATCH', `/channels/${ch.id}`, alice.token, {
    permission_overwrites: [
      { id: g.guild.id, type: 0, allow: '0', deny: '0' },
      { id: g.guild.id, type: 0, allow: String(VIEW), deny: '0' },
    ],
  });
  assert.equal(dup.status, 400);
});

test('locked and archived threads reject member additions and typing from non-moderators', async () => {
  const { alice, dave } = g.users;
  const x = await srv.register('threadtarget');
  await api('POST', `/invites/${g.invite.code}`, x.token);
  const t = (await api('POST', `/channels/${g.general.id}/threads`, alice.token, { name: 'lock-check', type: 11 })).body;
  assert.equal((await api('PATCH', `/channels/${t.id}`, alice.token, { locked: true })).status, 200);
  // dave (regular member without MANAGE_THREADS) cannot add someone or send typing in a locked thread
  const addLocked = await api('PUT', `/channels/${t.id}/thread-members/${x.id}`, dave.token);
  assert.deepEqual([addLocked.status, addLocked.body.code], [403, 160005]);
  const typeLocked = await api('POST', `/channels/${t.id}/typing`, dave.token);
  assert.deepEqual([typeLocked.status, typeLocked.body.code], [403, 160005]);
  // archived thread rejects typing too
  await api('PATCH', `/channels/${t.id}`, alice.token, { locked: false, archived: true });
  const typeArchived = await api('POST', `/channels/${t.id}/typing`, dave.token);
  assert.deepEqual([typeArchived.status, typeArchived.body.code], [400, 50083]);
});

test('onboarding and anti-raid cannot hand out roles the actor could not assign (audit H1, H2)', async () => {
  const h = await guildWith(srv, ['hown', 'hmod', 'hjoin']);
  const { hown, hmod, hjoin } = h.users;
  const gp = p => `/guilds/${h.guild.id}${p}`;
  const admin = (await api('POST', gp('/roles'), hown.token, { name: 'Admin', permissions: String(ADMIN) })).body;
  const mod = (await api('POST', gp('/roles'), hown.token, { name: 'Mod', permissions: String(1n << 5n) })).body; // MANAGE_GUILD only
  assert.equal((await api('PUT', gp(`/members/${hmod.id}/roles/${mod.id}`), hown.token)).status, 204);
  const prompts = [{ options: [{ id: 'o1', role_ids: [admin.id] }] }];
  assert.equal((await api('PUT', gp('/onboarding'), hmod.token, { enabled: true, prompts })).status, 403, 'no MANAGE_ROLES');
  await api('PATCH', gp(`/roles/${mod.id}`), hown.token, { permissions: String((1n << 5n) | MANAGE_ROLES) });
  assert.equal((await api('PUT', gp('/onboarding'), hmod.token, { enabled: true, prompts })).status, 403, 'Admin is above Mod');
  // a role of another guild is unknown here, both for onboarding and the quarantine role
  const evil = (await api('POST', '/guilds', hmod.token, { name: 'Evil' })).body;
  const foreign = (await api('POST', `/guilds/${evil.id}/roles`, hmod.token, { name: 'R', permissions: String(ADMIN) })).body;
  assert.equal((await api('PUT', gp('/onboarding'), hmod.token, { enabled: true, prompts: [{ options: [{ id: 'o1', role_ids: [foreign.id] }] }] })).status, 404);
  assert.equal((await api('PUT', gp('/anti-raid'), hmod.token, { enabled: true, quarantine_role_id: foreign.id })).status, 404);
  assert.equal((await api('PUT', gp('/anti-raid'), hmod.token, { enabled: true, quarantine_role_id: admin.id })).status, 403);
  // a foreign role row in member_roles (written before this fix) grants nothing
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(`${srv.dataDir}/cillcord.sqlite`);
  db.prepare('INSERT INTO member_roles (guild_id, user_id, role_id) VALUES (?, ?, ?)').run(h.guild.id, hjoin.id, foreign.id);
  db.close();
  assert.equal((await api('GET', gp('/audit-logs'), hjoin.token)).status, 403);
});

test('replies need READ_MESSAGE_HISTORY: a reply answers with the referenced content (audit M5)', async () => {
  const h = await guildWith(srv, ['rown', 'rnew']);
  const { rown, rnew } = h.users;
  const secret = (await api('POST', `/channels/${h.general.id}/messages`, rown.token, { content: 'secret history' })).body;
  await api('PUT', `/channels/${h.general.id}/permissions/${h.guild.id}`, rown.token, { type: 0, allow: '0', deny: String(1n << 16n) });
  const r = await api('POST', `/channels/${h.general.id}/messages`, rnew.token, { content: 'hi', message_reference: { message_id: secret.id } });
  assert.deepEqual([r.status, r.body.code], [403, 160002]);
  assert.equal((await api('POST', `/channels/${h.general.id}/messages`, rown.token, { content: 'ok', message_reference: { message_id: secret.id } })).status, 201);
});
