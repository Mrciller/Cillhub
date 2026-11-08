import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { startServer, guildWith, bits, png } from './helpers.js';

let srv, api, g, alice, bob, carol;
before(async () => {
  srv = await startServer();
  api = srv.api;
  g = await guildWith(srv, ['alice', 'bob', 'carol']);
  ({ alice, bob, carol } = g.users);
  for (const u of [alice, bob, carol]) u.gw = await srv.gateway(u.token);
});
after(() => srv.stop());

const msgs = (ch, who = alice) => api('GET', `/channels/${ch}/messages?limit=5`, who.token).then(r => r.body);
const poll = (extra = {}) => ({ question: { text: 'Pizza?' }, answers: [{ poll_media: { text: 'Yes' } }, { poll_media: { text: 'No', emoji: { name: '🔥' } } }], duration: 1, ...extra });

test('polls: create, vote with events, voters, end early with a POLL_RESULT message', async () => {
  const r = await api('POST', `/channels/${g.general.id}/messages`, bob.token, { poll: poll() });
  assert.equal(r.status, 201);
  const p = r.body.poll;
  assert.deepEqual(p.answers.map(a => [a.answer_id, a.poll_media.text]), [[1, 'Yes'], [2, 'No']]);
  assert.ok(Math.abs(Date.parse(p.expiry) - Date.now() - 3600e3) < 5000);
  assert.deepEqual(p.results, { is_finalized: false, answer_counts: [{ id: 1, count: 0, me_voted: false }, { id: 2, count: 0, me_voted: false }] });
  const vote = (who, answer_ids) => api('PUT', `/channels/${g.general.id}/polls/${r.body.id}/answers/@me`, who.token, { answer_ids });
  assert.equal((await vote(carol, [1])).status, 204);
  assert.deepEqual(await alice.gw.event('MESSAGE_POLL_VOTE_ADD'), { user_id: carol.id, channel_id: g.general.id, message_id: r.body.id, guild_id: g.guild.id, answer_id: 1 });
  assert.equal((await vote(carol, [2])).status, 204);
  assert.equal((await alice.gw.event('MESSAGE_POLL_VOTE_REMOVE')).answer_id, 1);
  assert.equal((await vote(carol, [1, 2])).status, 400, 'not a multiselect poll');
  assert.equal((await vote(carol, [9])).status, 400);
  await vote(alice, [2]);
  const [m] = await msgs(g.general.id, carol);
  assert.deepEqual(m.poll.results.answer_counts, [{ id: 1, count: 0, me_voted: false }, { id: 2, count: 2, me_voted: true }]);
  const voters = (await api('GET', `/channels/${g.general.id}/polls/${r.body.id}/answers/2`, bob.token)).body.users.map(u => u.id).sort();
  assert.deepEqual(voters, [alice.id, carol.id].sort());

  assert.equal((await api('POST', `/channels/${g.general.id}/polls/${r.body.id}/expire`, alice.token)).status, 403, 'only the author ends it');
  const ended = await api('POST', `/channels/${g.general.id}/polls/${r.body.id}/expire`, bob.token);
  assert.equal(ended.body.poll.results.is_finalized, true);
  const result = await carol.gw.event('MESSAGE_CREATE', d => d.type === 46);
  assert.deepEqual(result.message_reference, { message_id: r.body.id, channel_id: g.general.id, guild_id: g.guild.id });
  const fields = Object.fromEntries(result.embeds[0].fields.map(f => [f.name, f.value]));
  assert.equal(result.embeds[0].type, 'poll_result');
  assert.deepEqual(fields, { poll_question_text: 'Pizza?', victor_answer_votes: '2', total_votes: '2', victor_answer_id: '2', victor_answer_text: 'No', victor_answer_emoji_name: '🔥' });
  assert.equal((await vote(carol, [1])).body.code, 520001);

  await api('PUT', `/channels/${g.general.id}/permissions/${g.guild.id}`, alice.token, { type: 0, allow: '0', deny: bits(49) });
  assert.equal((await api('POST', `/channels/${g.general.id}/messages`, bob.token, { poll: poll() })).status, 403, 'SEND_POLLS');
  await api('DELETE', `/channels/${g.general.id}/permissions/${g.guild.id}`, alice.token);
});

test('a poll that expired while the server was down is finalized on start', async () => {
  const r = await api('POST', `/channels/${g.general.id}/messages`, bob.token, { poll: poll({ allow_multiselect: true }) });
  await api('PUT', `/channels/${g.general.id}/polls/${r.body.id}/answers/@me`, carol.token, { answer_ids: [1, 2] });
  await srv.stop(true);
  const db = new DatabaseSync(join(srv.dataDir, 'cillcord.sqlite'));
  db.prepare('UPDATE polls SET expiry = ? WHERE message_id = ?').run(Date.now() - 1000, r.body.id);
  db.close();
  srv = await startServer({ dataDir: srv.dataDir });
  api = srv.api;
  const [result, original] = await msgs(g.general.id);
  assert.equal(original.poll.results.is_finalized, true);
  assert.deepEqual([result.type, result.message_reference.message_id], [46, r.body.id]);
  const fields = Object.fromEntries(result.embeds[0].fields.map(f => [f.name, f.value]));
  assert.deepEqual([fields.total_votes, fields.victor_answer_votes, fields.victor_answer_id], ['1', '1', undefined], 'a tie names no winner');
  for (const u of [alice, bob, carol]) u.gw = await srv.gateway(u.token);
});

test('forwarding: a snapshot with copied files, only from readable channels', async () => {
  const orig = await srv.form('POST', `/channels/${g.general.id}/messages`, bob.token, { content: 'look' }, [['files[0]', 'pic.png', png(4, 4), 'image/png']]);
  const dm = (await api('POST', '/users/@me/channels', carol.token, { recipient_id: alice.id })).body;
  const fwd = await api('POST', `/channels/${dm.id}/messages`, carol.token, { message_reference: { type: 1, message_id: orig.body.id, channel_id: g.general.id } });
  assert.equal(fwd.status, 201);
  assert.equal(fwd.body.flags & 16384, 16384);
  assert.deepEqual(fwd.body.message_reference, { type: 1, message_id: orig.body.id, channel_id: g.general.id, guild_id: g.guild.id });
  const snap = fwd.body.message_snapshots[0].message;
  assert.equal(snap.content, 'look');
  assert.equal(snap.author, undefined);
  assert.deepEqual(fwd.body.attachments, []);
  await api('DELETE', `/channels/${g.general.id}/messages/${orig.body.id}`, bob.token);
  assert.equal((await fetch(srv.origin + snap.attachments[0].url)).status, 200, 'the snapshot keeps its own copy');

  const priv = (await api('POST', `/guilds/${g.guild.id}/channels`, alice.token, {
    name: 'staff', permission_overwrites: [{ id: g.guild.id, type: 0, allow: '0', deny: bits(10) }],
  })).body;
  const secret = (await api('POST', `/channels/${priv.id}/messages`, alice.token, { content: 'secret' })).body;
  const denied = await api('POST', `/channels/${dm.id}/messages`, carol.token, { message_reference: { type: 1, message_id: secret.id, channel_id: priv.id } });
  assert.equal(denied.body.code, 160014);
});

test('voice messages, spoilers and alt text', async () => {
  const ogg = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(60)]);
  const voice = (payload, file = ['files[0]', 'voice.ogg', ogg, 'audio/ogg'], who = bob) =>
    srv.form('POST', `/channels/${g.general.id}/messages`, who.token, payload, file ? [file] : []);
  const meta = { id: 0, duration_secs: 2.5, waveform: Buffer.from([0, 128, 255]).toString('base64') };
  const ok = await voice({ flags: 8192, attachments: [meta] });
  assert.equal(ok.status, 201);
  const [a] = ok.body.attachments;
  assert.deepEqual([ok.body.flags & 8192, a.content_type, a.duration_secs, a.waveform], [8192, 'audio/ogg', 2.5, meta.waveform]);
  assert.equal((await api('PATCH', `/channels/${g.general.id}/messages/${ok.body.id}`, bob.token, { content: 'x' })).status, 400, 'not editable');
  assert.equal((await voice({ flags: 8192, attachments: [{ id: 0 }] })).body.code, 50161);
  assert.equal((await voice({ flags: 8192, content: 'hi', attachments: [meta] })).status, 400);
  assert.equal((await voice({ flags: 8192, attachments: [meta] }, ['files[0]', 'v.ogg', png(), 'audio/ogg'])).status, 400, 'must really be Ogg/WebM');
  await api('PUT', `/channels/${g.general.id}/permissions/${g.guild.id}`, alice.token, { type: 0, allow: '0', deny: bits(46) });
  assert.equal((await voice({ flags: 8192, attachments: [meta] })).body.code, 50173);
  await api('DELETE', `/channels/${g.general.id}/permissions/${g.guild.id}`, alice.token);

  const r = await srv.form('POST', `/channels/${g.general.id}/messages`, bob.token, { attachments: [{ id: 1, description: 'a red square' }] }, [
    ['files[0]', 'SPOILER_cat.png', png(), 'image/png'], ['files[1]', 'square.png', png(), 'image/png'],
  ]);
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.attachments.map(x => [x.filename, x.flags, x.description]), [['SPOILER_cat.png', 8, undefined], ['square.png', 0, 'a red square']]);
});

test('slowmode: 429 with retry_after, MANAGE_MESSAGES bypasses; NSFW and voice text chat', async () => {
  const ch = (await api('POST', `/guilds/${g.guild.id}/channels`, alice.token, { name: 'slow', rate_limit_per_user: 30, nsfw: true })).body;
  assert.deepEqual([ch.rate_limit_per_user, ch.nsfw], [30, true]);
  assert.equal((await api('POST', `/channels/${ch.id}/messages`, bob.token, { content: '1' })).status, 201);
  const limited = await api('POST', `/channels/${ch.id}/messages`, bob.token, { content: '2' });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, 20016);
  assert.equal(limited.body.global, false);
  assert.ok(limited.body.retry_after > 25 && limited.body.retry_after <= 30);
  for (const c of ['a', 'b']) assert.equal((await api('POST', `/channels/${ch.id}/messages`, alice.token, { content: c })).status, 201);
  assert.equal((await api('PATCH', `/channels/${ch.id}`, alice.token, { rate_limit_per_user: 21601 })).status, 400);
  // voice channels carry a text chat
  const v = await api('POST', `/channels/${g.voice.id}/messages`, bob.token, { content: 'in voice' });
  assert.equal(v.status, 201);
  assert.equal((await api('GET', `/channels/${g.voice.id}`, bob.token)).body.last_message_id, v.body.id);
});
