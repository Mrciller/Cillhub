import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, guildWith } from './helpers.js';

let srv, api, g, gid, alice, bob, carol;
before(async () => {
  srv = await startServer();
  api = srv.api;
  g = await guildWith(srv, ['alice', 'bob', 'carol']);
  gid = g.guild.id;
  g.id = gid;
  ({ alice, bob, carol } = g.users);
  alice.gw = await srv.gateway(alice.token);
  bob.gw = await srv.gateway(bob.token);
});
after(() => srv.stop());

test('Task 6.1: Bulk delete messages', async () => {
  // Post 3 messages from alice and bob
  const m1 = (await api('POST', `/channels/${g.general.id}/messages`, alice.token, { content: 'msg 1' })).body;
  const m2 = (await api('POST', `/channels/${g.general.id}/messages`, bob.token, { content: 'msg 2' })).body;
  const m3 = (await api('POST', `/channels/${g.general.id}/messages`, alice.token, { content: 'msg 3' })).body;

  // Single message should be rejected (< 2)
  const tooFew = await api('POST', `/channels/${g.general.id}/messages/bulk-delete`, alice.token, { messages: [m1.id] });
  assert.equal(tooFew.status, 400);

  // Bulk delete m1 and m2
  const bobP = bob.gw.event('MESSAGE_DELETE_BULK', d => d.channel_id === g.general.id);
  const del = await api('POST', `/channels/${g.general.id}/messages/bulk-delete`, alice.token, { messages: [m1.id, m2.id] });
  assert.equal(del.status, 204);
  const ev = await bobP;
  assert.deepEqual(ev.ids.sort(), [m1.id, m2.id].sort());

  // Verify messages are gone
  const remaining = (await api('GET', `/channels/${g.general.id}/messages`, alice.token)).body;
  assert.ok(!remaining.some(m => m.id === m1.id || m.id === m2.id));
  assert.ok(remaining.some(m => m.id === m3.id));
});

test('Task 6.2: Message edit history', async () => {
  const m = (await api('POST', `/channels/${g.general.id}/messages`, alice.token, { content: 'Version 1' })).body;
  
  // Edit content
  await api('PATCH', `/channels/${g.general.id}/messages/${m.id}`, alice.token, { content: 'Version 2' });
  await api('PATCH', `/channels/${g.general.id}/messages/${m.id}`, alice.token, { content: 'Version 3' });

  // Get edits
  const res = await api('GET', `/channels/${g.general.id}/messages/${m.id}/edits`, alice.token);
  assert.equal(res.status, 200);
  assert.equal(res.body.edits.length, 2);
  assert.equal(res.body.edits[0].content, 'Version 1');
  assert.equal(res.body.edits[1].content, 'Version 2');
});

test('Task 6.3: Forum solved message & pinned forum posts', async () => {
  // Create a forum channel (type 15)
  const forum = (await api('POST', `/guilds/${gid}/channels`, alice.token, { name: 'qa-forum', type: 15 })).body;
  assert.equal(forum.type, 15);

  // Create a thread in the forum
  const post = (await api('POST', `/channels/${forum.id}/threads`, alice.token, { name: 'How to do X?', message: { content: 'Question' } })).body;
  assert.equal(post.solved_message_id, null);

  // Bob posts a reply in the thread
  const reply = (await api('POST', `/channels/${post.id}/messages`, bob.token, { content: 'Here is the solution' })).body;

  // Alice marks Bob's reply as solved
  const updateP = bob.gw.event('THREAD_UPDATE', d => d.id === post.id);
  const patched = await api('PATCH', `/channels/${post.id}`, alice.token, { solved_message_id: reply.id });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.solved_message_id, reply.id);
  const gwEv = await updateP;
  assert.equal(gwEv.solved_message_id, reply.id);

  // Pin the post (flags bit 2 = 2)
  const pinned = await api('PATCH', `/channels/${post.id}`, alice.token, { flags: 2 });
  assert.equal(pinned.status, 200);
  assert.equal(pinned.body.flags & 2, 2);

  // Clear solved message
  const unsolve = await api('PATCH', `/channels/${post.id}`, alice.token, { solved_message_id: null });
  assert.equal(unsolve.status, 200);
  assert.equal(unsolve.body.solved_message_id, null);
});

test('Task 6.4: DM read indicators (CHANNEL_RECIPIENT_ACK)', async () => {
  // Open a DM between Alice and Bob
  const dm = (await api('POST', '/users/@me/channels', alice.token, { recipient_id: bob.id })).body;
  const msg = (await api('POST', `/channels/${dm.id}/messages`, bob.token, { content: 'Ping' })).body;

  // Alice acks the message
  const ackP = bob.gw.event('CHANNEL_RECIPIENT_ACK', d => d.channel_id === dm.id);
  const ackRes = await api('POST', `/channels/${dm.id}/messages/${msg.id}/ack`, alice.token);
  assert.equal(ackRes.status, 200);
  const ackEv = await ackP;
  assert.equal(ackEv.user_id, alice.id);
  assert.equal(ackEv.message_id, msg.id);

  // Alice disables dm_read_receipts
  await api('PATCH', '/users/@me/settings', alice.token, { privacy: { dm_read_receipts: false } });
  
  // Bob posts another message
  const msg2 = (await api('POST', `/channels/${dm.id}/messages`, bob.token, { content: 'Ping 2' })).body;

  // Alice acks it, Bob should not receive CHANNEL_RECIPIENT_ACK
  const nonePromise = bob.gw.none(f => f.t === 'CHANNEL_RECIPIENT_ACK', 300);
  await api('POST', `/channels/${dm.id}/messages/${msg2.id}/ack`, alice.token);
  const noAck = await nonePromise;
  assert.equal(noAck, true);

  // Restore privacy setting
  await api('PATCH', '/users/@me/settings', alice.token, { privacy: { dm_read_receipts: true } });
});

test('Task 6.6 & 6.16: Polls with anonymous voting, role restrictions, and quiz mode', async () => {
  // 1. Role restricted poll
  const role = (await api('POST', `/guilds/${gid}/roles`, alice.token, { name: 'VIP' })).body;
  const pollMsg = (await api('POST', `/channels/${g.general.id}/messages`, alice.token, {
    poll: {
      question: { text: 'VIP Poll' },
      answers: [{ poll_media: { text: 'A' } }, { poll_media: { text: 'B' } }],
      allowed_role_ids: [role.id],
    },
  })).body;
  assert.deepEqual(pollMsg.poll.allowed_role_ids, [role.id]);

  // Bob doesn't have role, vote should fail with 403
  const failVote = await api('PUT', `/channels/${g.general.id}/polls/${pollMsg.id}/answers/@me`, bob.token, { answer_ids: [1] });
  assert.equal(failVote.status, 403);

  // Grant role to Bob
  await api('PUT', `/guilds/${gid}/members/${bob.id}/roles/${role.id}`, alice.token);
  const okVote = await api('PUT', `/channels/${g.general.id}/polls/${pollMsg.id}/answers/@me`, bob.token, { answer_ids: [1] });
  assert.ok(okVote.status === 200 || okVote.status === 204);

  // 2. Anonymous Quiz Poll
  const quizMsg = (await api('POST', `/channels/${g.general.id}/messages`, alice.token, {
    poll: {
      question: { text: 'What is 2+2?' },
      answers: [{ poll_media: { text: '3' } }, { poll_media: { text: '4' } }],
      anonymous: true,
      correct_answer_id: 2,
    },
  })).body;
  assert.equal(quizMsg.poll.anonymous, true);
  assert.equal(quizMsg.poll.is_quiz, true);
  // Creator can see correct_answer_id
  assert.equal(quizMsg.poll.correct_answer_id, 2);

  // Bob viewing the message before voting should not see the answer
  const bobView = (await api('GET', `/channels/${g.general.id}/messages/${quizMsg.id}`, bob.token)).body;
  assert.equal(bobView.poll.is_quiz, true);
  assert.equal(bobView.poll.correct_answer_id, null);

  // Bob votes on option 2; vote should return or reveal correct_answer_id
  const bobVoteP = alice.gw.event('MESSAGE_POLL_VOTE_ADD', d => d.message_id === quizMsg.id);
  const bobVote = await api('PUT', `/channels/${g.general.id}/polls/${quizMsg.id}/answers/@me`, bob.token, { answer_ids: [2] });
  assert.equal(bobVote.body.correct_answer_id, 2);

  // For Alice, the anonymous event received should have user_id: '0'
  const aliceEv = await bobVoteP;
  assert.equal(aliceEv.user_id, '0');
  assert.equal(aliceEv.answer_id, 2);

  // Voters endpoint for anonymous poll should return empty list
  const votersRes = await api('GET', `/channels/${g.general.id}/polls/${quizMsg.id}/answers/2`, alice.token);
  assert.deepEqual(votersRes.body.users, []);

  // Now Bob viewing the poll sees correct_answer_id
  const bobViewAfter = (await api('GET', `/channels/${g.general.id}/messages/${quizMsg.id}`, bob.token)).body;
  assert.equal(bobViewAfter.poll.correct_answer_id, 2);
});

test('Task 6.7: User data export', async () => {
  const res = await api('GET', '/users/@me/export', alice.token);
  assert.equal(res.status, 200);
  assert.ok(res.body.exported_at);
  assert.equal(res.body.user.id, alice.id);
  assert.ok(Array.isArray(res.body.guilds));
  assert.ok(Array.isArray(res.body.messages));
  assert.ok(Array.isArray(res.body.relationships));
  assert.ok(Array.isArray(res.body.notes));
  assert.ok(Array.isArray(res.body.bookmarks));
});

test('Task 6.8: Channel clone', async () => {
  // Create channel with specific topic and rate limit
  const src = (await api('POST', `/guilds/${gid}/channels`, alice.token, {
    name: 'source-channel',
    topic: 'Original topic',
    rate_limit_per_user: 10,
  })).body;

  // Clone channel
  const cloned = await api('POST', `/channels/${src.id}/clone`, alice.token, { name: 'source-channel-clone' });
  assert.equal(cloned.status, 201);
  assert.notEqual(cloned.body.id, src.id);
  assert.equal(cloned.body.name, 'source-channel-clone');
  assert.equal(cloned.body.topic, 'Original topic');
  assert.equal(cloned.body.rate_limit_per_user, 10);
});

test('Task 6.9: Channel media gallery', async () => {
  // Post link message
  await api('POST', `/channels/${g.general.id}/messages`, alice.token, { content: 'Check this https://cillhub.org' });

  const linksRes = await api('GET', `/channels/${g.general.id}/media?tab=links`, alice.token);
  assert.equal(linksRes.status, 200);
  assert.ok(linksRes.body.messages.some(m => m.content.includes('https://cillhub.org')));
});

test('Task 6.11: Guild snippets & !trigger expansion', async () => {
  // Create a snippet
  const sn = await api('POST', `/guilds/${gid}/snippets`, alice.token, {
    name: 'rules',
    content: 'Be respectful and kind!',
  });
  assert.equal(sn.status, 201);
  assert.equal(sn.body.name, 'rules');

  // List snippets
  const list = await api('GET', `/guilds/${gid}/snippets`, bob.token);
  assert.ok(list.body.snippets.some(s => s.name === 'rules'));

  // Post message with trigger !rules
  const msg = (await api('POST', `/channels/${g.general.id}/messages`, bob.token, { content: '!rules' })).body;
  assert.equal(msg.content, '!rules');
  assert.ok(msg.embeds.length >= 1);
  assert.equal(msg.embeds[0].title, '!rules');
  assert.equal(msg.embeds[0].description, 'Be respectful and kind!');

  // Patch snippet
  const updated = await api('PATCH', `/guilds/${gid}/snippets/${sn.body.id}`, alice.token, {
    content: 'Updated rules!',
  });
  assert.equal(updated.body.content, 'Updated rules!');

  // Delete snippet
  const del = await api('DELETE', `/guilds/${gid}/snippets/${sn.body.id}`, alice.token);
  assert.equal(del.status, 204);
});

test('Task 6.13: Thread member notification flags', async () => {
  // Create public thread
  const t = (await api('POST', `/channels/${g.general.id}/threads`, alice.token, { name: 'Discussion', type: 11 })).body;

  // Bob joins thread
  await api('PUT', `/channels/${t.id}/thread-members/@me`, bob.token);

  // Bob updates notification level to 2 (Muted)
  const bobGwP = bob.gw.event('THREAD_MEMBER_UPDATE', d => d.id === t.id);
  const res = await api('PATCH', `/channels/${t.id}/thread-members/@me`, bob.token, { flags: 2 });
  assert.equal(res.status, 200);
  assert.equal(res.body.flags, 2);
  const ev = await bobGwP;
  assert.equal(ev.flags, 2);
});
