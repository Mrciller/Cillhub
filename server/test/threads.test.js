import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { startServer, guildWith, bits } from './helpers.js';

let srv, api, g, alice, bob, carol;
const s = {};
before(async () => {
  srv = await startServer();
  api = srv.api;
  g = await guildWith(srv, ['alice', 'bob', 'carol']);
  ({ alice, bob, carol } = g.users);
  for (const u of [alice, bob, carol]) u.gw = await srv.gateway(u.token);
});
after(() => srv.stop());

const post = (ch, who, content) => api('POST', `/channels/${ch}/messages`, who.token, { content });

test('thread from a message: shares its id, sets the message thread field, members and counts', async () => {
  const m = (await post(g.general.id, bob, 'topic')).body;
  const r = await api('POST', `/channels/${g.general.id}/messages/${m.id}/threads`, carol.token, { name: 'side talk', auto_archive_duration: 60 });
  assert.equal(r.status, 201);
  s.thread = r.body;
  assert.deepEqual([r.body.id, r.body.type, r.body.parent_id, r.body.owner_id, r.body.member_count], [m.id, 11, g.general.id, carol.id, 1]);
  assert.deepEqual([r.body.thread_metadata.archived, r.body.thread_metadata.auto_archive_duration, r.body.thread_metadata.locked], [false, 60, false]);
  assert.equal(r.body.member.user_id, carol.id);
  const created = await alice.gw.event('THREAD_CREATE', d => d.id === m.id);
  assert.equal(created.newly_created, true);
  const upd = await bob.gw.event('MESSAGE_UPDATE', d => d.id === m.id);
  assert.equal(upd.thread.id, m.id);
  assert.equal(upd.flags & 32, 32);
  assert.equal((await api('POST', `/channels/${g.general.id}/messages/${m.id}/threads`, bob.token, { name: 'again' })).body.code, 160004);

  assert.equal((await post(s.thread.id, bob, 'in thread')).status, 201);
  const ch = (await api('GET', `/channels/${s.thread.id}`, carol.token)).body;
  assert.deepEqual([ch.message_count, ch.total_message_sent, ch.member.user_id], [1, 1, carol.id]);

  assert.equal((await api('PUT', `/channels/${s.thread.id}/thread-members/@me`, bob.token)).status, 204);
  const mu = await carol.gw.event('THREAD_MEMBERS_UPDATE', d => d.added_members);
  assert.deepEqual([mu.id, mu.member_count, mu.added_members[0].user_id, mu.added_members[0].member.user.id], [s.thread.id, 2, bob.id, bob.id]);
  const list = (await api('GET', `/channels/${s.thread.id}/thread-members`, alice.token)).body;
  assert.deepEqual(list.map(x => x.user_id).sort(), [bob.id, carol.id].sort());
  assert.equal((await api('DELETE', `/channels/${s.thread.id}/thread-members/@me`, bob.token)).status, 204);
  assert.deepEqual((await carol.gw.event('THREAD_MEMBERS_UPDATE', d => d.removed_member_ids)).removed_member_ids, [bob.id]);

  const active = (await api('GET', `/guilds/${g.guild.id}/threads/active`, carol.token)).body;
  assert.deepEqual(active.threads.map(t => t.id), [s.thread.id]);
  assert.deepEqual(active.members.map(x => x.user_id), [carol.id]);
  const ready = await srv.gateway(carol.token);
  assert.deepEqual(ready.ready.guilds[0].threads.map(t => [t.id, Object.keys(t.member).sort().join()]), [[s.thread.id, 'flags,join_timestamp']]);
  ready.ws.close();
});

test('SEND_MESSAGES_IN_THREADS, not SEND_MESSAGES, governs threads; archived and locked threads', async () => {
  const everyone = g.guild.id;
  // deny sending in threads only: parent still works
  await api('PUT', `/channels/${g.general.id}/permissions/${everyone}`, alice.token, { type: 0, allow: '0', deny: bits(38) });
  assert.equal((await post(s.thread.id, bob, 'no')).status, 403);
  assert.equal((await post(g.general.id, bob, 'yes')).status, 201);
  // deny SEND_MESSAGES but allow in threads (announcement-style)
  await api('PUT', `/channels/${g.general.id}/permissions/${everyone}`, alice.token, { type: 0, allow: bits(38), deny: bits(11) });
  assert.equal((await post(g.general.id, bob, 'no')).status, 403);
  assert.equal((await post(s.thread.id, bob, 'yes')).status, 201);
  await api('DELETE', `/channels/${g.general.id}/permissions/${everyone}`, alice.token);

  // the creator archives; sending reopens it
  const a = await api('PATCH', `/channels/${s.thread.id}`, carol.token, { archived: true });
  assert.equal(a.body.thread_metadata.archived, true);
  assert.equal((await bob.gw.event('THREAD_UPDATE', d => d.thread_metadata.archived)).id, s.thread.id);
  assert.equal((await api('PUT', `/channels/${s.thread.id}/thread-members/@me`, bob.token)).body.code, 50083);
  const archived = (await api('GET', `/channels/${g.general.id}/threads/archived/public`, bob.token)).body;
  assert.deepEqual([archived.threads.map(t => t.id), archived.has_more], [[s.thread.id], false]);
  assert.equal((await post(s.thread.id, bob, 'reopen')).status, 201);
  await bob.gw.event('THREAD_UPDATE', d => !d.thread_metadata.archived);
  // locking takes MANAGE_THREADS; then only moderators send
  assert.equal((await api('PATCH', `/channels/${s.thread.id}`, carol.token, { locked: true })).status, 403);
  assert.equal((await api('PATCH', `/channels/${s.thread.id}`, alice.token, { locked: true })).status, 200);
  assert.equal((await post(s.thread.id, bob, 'locked')).body.code, 160005);
  assert.equal((await post(s.thread.id, alice, 'mod')).status, 201);
  await api('PATCH', `/channels/${s.thread.id}`, alice.token, { locked: false });
  // deleting a thread needs MANAGE_THREADS
  assert.equal((await api('DELETE', `/channels/${s.thread.id}`, carol.token)).status, 403);
});

test('private threads: only members and MANAGE_THREADS see them; invitable; removal', async () => {
  const r = await api('POST', `/channels/${g.general.id}/threads`, bob.token, { name: 'secret', type: 12, invitable: false });
  assert.equal(r.status, 201);
  const t = r.body;
  assert.deepEqual([t.type, t.thread_metadata.invitable], [12, false]);
  assert.equal((await api('GET', `/channels/${t.id}`, carol.token)).status, 403);
  assert.equal((await api('GET', `/channels/${t.id}`, alice.token)).status, 200, 'the owner has MANAGE_THREADS');
  assert.equal((await post(t.id, carol, 'hi')).status, 403);
  assert.ok(await carol.gw.none(f => f.t === 'THREAD_CREATE' && f.d.id === t.id));
  assert.ok(!(await api('GET', `/guilds/${g.guild.id}/threads/active`, carol.token)).body.threads.some(x => x.id === t.id));
  // not invitable: the creator cannot add people, a moderator can
  assert.equal((await api('PUT', `/channels/${t.id}/thread-members/${carol.id}`, bob.token)).status, 403);
  assert.equal((await api('PUT', `/channels/${t.id}/thread-members/${carol.id}`, alice.token)).status, 204);
  assert.equal((await carol.gw.event('THREAD_CREATE', d => d.id === t.id)).member.user_id, carol.id);
  assert.equal((await post(t.id, carol, 'now I can')).status, 201);
  // creating private threads needs CREATE_PRIVATE_THREADS
  await api('PUT', `/channels/${g.general.id}/permissions/${g.guild.id}`, alice.token, { type: 0, allow: '0', deny: bits(36) });
  assert.equal((await api('POST', `/channels/${g.general.id}/threads`, bob.token, { name: 'x', type: 12 })).status, 403);
  await api('DELETE', `/channels/${g.general.id}/permissions/${g.guild.id}`, alice.token);
  // the private thread's creator may remove members
  assert.equal((await api('DELETE', `/channels/${t.id}/thread-members/${carol.id}`, bob.token)).status, 204);
  assert.equal((await api('GET', `/channels/${t.id}`, carol.token)).status, 403);
  const priv = (await api('GET', `/channels/${g.general.id}/threads/archived/private`, carol.token));
  assert.equal(priv.status, 403);
});

test('THREAD_LIST_SYNC when access to a parent channel is gained', async () => {
  const hidden = (await api('POST', `/guilds/${g.guild.id}/channels`, alice.token, {
    name: 'hidden', permission_overwrites: [{ id: g.guild.id, type: 0, allow: '0', deny: bits(10) }],
  })).body;
  const t = (await api('POST', `/channels/${hidden.id}/threads`, alice.token, { name: 'inner', type: 11 })).body;
  assert.ok(await carol.gw.none(f => f.t === 'THREAD_CREATE' && f.d.id === t.id));
  await api('PUT', `/channels/${hidden.id}/permissions/${carol.id}`, alice.token, { type: 1, allow: bits(10), deny: '0' });
  const sync = await carol.gw.event('THREAD_LIST_SYNC', d => d.channel_ids?.includes(hidden.id));
  assert.deepEqual([sync.guild_id, sync.threads.map(x => x.id), sync.members], [g.guild.id, [t.id], []]);
});

test('forum channels: tags, REQUIRE_TAG, posts are threads whose first message shares the id, no direct messages', async () => {
  const f = await api('POST', `/guilds/${g.guild.id}/channels`, alice.token, {
    name: 'Help Desk', type: 15, topic: 'Rules here', available_tags: [{ name: 'bug', emoji_name: '🐛' }, { name: 'staff', moderated: true }],
    default_reaction_emoji: { emoji_name: '👍' }, default_sort_order: 1, default_forum_layout: 2, flags: 16,
  });
  assert.equal(f.status, 201);
  s.forum = f.body;
  assert.deepEqual([f.body.name, f.body.flags, f.body.default_forum_layout, f.body.available_tags.map(t => t.name)], ['help-desk', 16, 2, ['bug', 'staff']]);
  const [bug, staff] = f.body.available_tags;
  assert.equal((await post(s.forum.id, bob, 'hi')).body.code, 40058);
  const noTag = await api('POST', `/channels/${s.forum.id}/threads`, bob.token, { name: 'Crash', message: { content: 'it crashes' } });
  assert.equal(noTag.body.code, 40067);
  assert.equal((await api('POST', `/channels/${s.forum.id}/threads`, bob.token, { name: 'x', applied_tags: [staff.id], message: { content: 'x' } })).body.code, 40066);
  const p = await api('POST', `/channels/${s.forum.id}/threads`, bob.token, { name: 'Crash', applied_tags: [bug.id], message: { content: 'it crashes' } });
  assert.equal(p.status, 201);
  assert.deepEqual([p.body.type, p.body.parent_id, p.body.applied_tags, p.body.message.id, p.body.message.channel_id, p.body.message_count],
    [11, s.forum.id, [bug.id], p.body.id, p.body.id, 0]);
  assert.equal((await api('GET', `/channels/${s.forum.id}`, bob.token)).body.last_message_id, p.body.id);
  // pinning a post is for moderators
  assert.equal((await api('PATCH', `/channels/${p.body.id}`, bob.token, { flags: 2 })).status, 403);
  assert.equal((await api('PATCH', `/channels/${p.body.id}`, alice.token, { flags: 2 })).body.flags, 2);
});

test('auto-archive is computed from the database: an idle thread archives on the next start', async () => {
  const m = (await post(g.general.id, bob, 'old')).body;
  const t = (await api('POST', `/channels/${g.general.id}/messages/${m.id}/threads`, bob.token, { name: 'idle', auto_archive_duration: 60 })).body;
  await srv.stop(true);
  const db = new DatabaseSync(join(srv.dataDir, 'cillcord.sqlite'));
  db.prepare('UPDATE channels SET last_activity = ? WHERE id = ?').run(Date.now() - 61 * 60 * 1000, t.id);
  db.close();
  srv = await startServer({ dataDir: srv.dataDir });
  const ch = (await srv.api('GET', `/channels/${t.id}`, bob.token)).body;
  assert.equal(ch.thread_metadata.archived, true);
  api = srv.api;
});
