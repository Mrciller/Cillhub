import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, guildWith, png } from './helpers.js';

let srv, api, g, alice, bob, hook;
before(async () => {
  srv = await startServer();
  api = srv.api;
  g = await guildWith(srv, ['alice', 'bob']);
  ({ alice, bob } = g.users);
  bob.gw = await srv.gateway(bob.token);
});
after(() => srv.stop());

const execute = (w, body, query = '') => api('POST', `/webhooks/${w.id}/${w.token}${query}`, null, body);

test('incoming webhooks: MANAGE_WEBHOOKS to manage, token to execute, overrides and rich embeds', async () => {
  assert.equal((await api('POST', `/channels/${g.general.id}/webhooks`, bob.token, { name: 'nope' })).status, 403);
  assert.equal((await api('POST', `/channels/${g.general.id}/webhooks`, alice.token, { name: 'Cillhub Alerts' })).body.errors.name._errors[0].message, 'Name cannot contain "cillhub".');
  const r = await api('POST', `/channels/${g.general.id}/webhooks`, alice.token, { name: 'Deploys', avatar: `data:image/png;base64,${png().toString('base64')}` });
  assert.equal(r.status, 200);
  hook = r.body;
  assert.deepEqual([hook.type, hook.channel_id, hook.user.id, typeof hook.token, typeof hook.avatar], [1, g.general.id, alice.id, 'string', 'string']);
  assert.equal((await fetch(`${srv.origin}/avatars/${hook.id}/${hook.avatar}`)).status, 200);
  assert.deepEqual((await api('GET', `/guilds/${g.guild.id}/webhooks`, alice.token)).body.map(w => w.id), [hook.id]);
  assert.equal((await api('GET', `/channels/${g.general.id}/webhooks`, bob.token)).status, 403);

  assert.equal((await execute(hook, { content: 'fire and forget' })).status, 204);
  const created = await bob.gw.event('MESSAGE_CREATE', d => d.content === 'fire and forget');
  assert.deepEqual([created.webhook_id, created.author.id, created.author.bot, created.author.username], [hook.id, hook.id, true, 'Deploys']);

  const sent = await execute(hook, {
    content: 'build <@&1> @everyone', username: 'CI', avatar_url: 'https://example.com/a.png',
    embeds: [{ title: 'Build 42', description: 'green', color: 0x00ff00, url: 'https://ci.example/42', fields: [{ name: 'time', value: '3m', inline: true }],
      author: { name: 'ci', icon_url: 'https://example.com/i.png' }, footer: { text: 'f' }, timestamp: '2026-11-03T12:00:00Z', thumbnail: { url: 'https://example.com/t.png' } }],
    allowed_mentions: { parse: [] },
  }, '?wait=true');
  assert.equal(sent.status, 200);
  const m = sent.body;
  assert.deepEqual([m.author.username, m.mention_everyone], ['CI', false]);
  assert.match(m.author.avatar_url, /^\/external\//);
  const [e] = m.embeds;
  assert.deepEqual([e.type, e.title, e.color, e.fields, e.timestamp], ['rich', 'Build 42', 0xff00, [{ name: 'time', value: '3m', inline: true }], '2026-11-03T12:00:00.000Z']);
  assert.match(e.thumbnail.proxy_url, /^\/external\//);
  assert.match(e.author.proxy_icon_url, /^\/external\//);
  assert.equal((await execute(hook, { embeds: [{ title: 'x'.repeat(257) }] })).status, 400);
  assert.equal((await execute(hook, { embeds: [{ image: { url: 'javascript:alert(1)' } }] })).status, 400);
  assert.equal((await execute(hook, {})).body.code, 50006);

  // multipart with a file; the message belongs to the webhook, not to its creator
  const file = await srv.form('POST', `/webhooks/${hook.id}/${hook.token}?wait=true`, null, { content: 'artifact' }, [['files[0]', 'log.txt', 'ok', 'text/plain']]);
  assert.equal(file.status, 200);
  assert.equal(file.body.attachments[0].filename, 'log.txt');
  assert.equal((await api('PATCH', `/channels/${g.general.id}/messages/${file.body.id}`, alice.token, { content: 'mine?' })).status, 403);

  // edit, read and delete by token
  const path = `/webhooks/${hook.id}/${hook.token}/messages/${m.id}`;
  assert.equal((await api('PATCH', path, null, { content: 'edited' })).body.content, 'edited');
  assert.equal((await api('GET', path)).body.content, 'edited');
  assert.equal((await api('DELETE', path)).status, 204);
  assert.equal((await api('GET', path)).status, 404);
});

test('webhook token checks: wrong token 401, regenerated token, deleted webhook 404', async () => {
  const wrong = await execute({ id: hook.id, token: `${hook.token.slice(0, -2)}xx` }, { content: 'x' });
  assert.deepEqual([wrong.status, wrong.body.code], [401, 50027]);
  assert.equal((await api('GET', `/webhooks/${hook.id}/nope`)).status, 401);
  assert.equal((await api('GET', `/webhooks/${hook.id}/${hook.token}`)).body.user, undefined);
  const fresh = (await api('POST', `/webhooks/${hook.id}/regenerate-token`, alice.token)).body;
  assert.notEqual(fresh.token, hook.token);
  assert.equal((await execute(hook, { content: 'old token' })).status, 401);
  assert.equal((await execute(fresh, { content: 'new token' })).status, 204);
  assert.equal((await api('DELETE', `/webhooks/${hook.id}`, bob.token)).status, 403);
  assert.equal((await api('DELETE', `/webhooks/${fresh.id}/${fresh.token}`)).status, 204);
  const gone = await execute(fresh, { content: 'x' });
  assert.deepEqual([gone.status, gone.body.code], [404, 10015]);
  assert.equal((await api('GET', '/webhooks/123/abc')).status, 404);
});

test('webhooks post into threads and create forum posts', async () => {
  const w = (await api('POST', `/channels/${g.general.id}/webhooks`, alice.token, { name: 'bot' })).body;
  const t = (await api('POST', `/channels/${g.general.id}/threads`, alice.token, { name: 'build log', type: 11 })).body;
  const inThread = await execute(w, { content: 'step 1' }, `?wait=true&thread_id=${t.id}`);
  assert.equal(inThread.body.channel_id, t.id);
  assert.equal((await execute(w, { content: 'x', thread_name: 'n' })).body.code, 220003);
  const forum = (await api('POST', `/guilds/${g.guild.id}/channels`, alice.token, { name: 'releases', type: 15 })).body;
  const fw = (await api('POST', `/channels/${forum.id}/webhooks`, alice.token, { name: 'rel' })).body;
  assert.equal((await execute(fw, { content: 'x' })).body.code, 220001);
  const postMsg = await execute(fw, { content: 'v1.0', thread_name: 'Release 1.0' }, '?wait=true');
  assert.equal(postMsg.status, 200);
  const thread = (await api('GET', `/channels/${postMsg.body.channel_id}`, bob.token)).body;
  assert.deepEqual([thread.id, thread.name, thread.parent_id], [postMsg.body.id, 'Release 1.0', forum.id]);
});

test('announcement channels: follow with a channel follower webhook, crosspost re-posts with IS_CROSSPOST', async () => {
  const news = (await api('POST', `/guilds/${g.guild.id}/channels`, alice.token, { name: 'news', type: 5 })).body;
  assert.equal(news.type, 5);
  const other = await srv.register('dave');
  const og = (await api('POST', '/guilds', other.token, { name: 'Other' })).body;
  await api('POST', `/invites/${g.invite.code}`, other.token);
  const target = og.channels.find(c => c.type === 0);
  const f = await api('POST', `/channels/${news.id}/followers`, other.token, { webhook_channel_id: target.id });
  assert.equal(f.status, 200);
  assert.equal(f.body.channel_id, news.id);
  assert.equal((await api('POST', `/channels/${news.id}/followers`, bob.token, { webhook_channel_id: g.general.id })).status, 403);
  const followHook = (await api('GET', `/channels/${target.id}/webhooks`, other.token)).body[0];
  assert.deepEqual([followHook.type, followHook.source_channel.id, followHook.source_guild.id, followHook.token], [2, news.id, g.guild.id, undefined]);

  const m = (await api('POST', `/channels/${news.id}/messages`, alice.token, { content: 'v3 is out' })).body;
  assert.equal((await api('POST', `/channels/${news.id}/messages/${m.id}/crosspost`, bob.token)).status, 403);
  const published = await api('POST', `/channels/${news.id}/messages/${m.id}/crosspost`, alice.token);
  assert.equal(published.body.flags & 1, 1);
  assert.equal((await api('POST', `/channels/${news.id}/messages/${m.id}/crosspost`, alice.token)).body.code, 40033);
  const [copy] = (await api('GET', `/channels/${target.id}/messages?limit=1`, other.token)).body;
  assert.deepEqual([copy.content, copy.flags & 2, copy.webhook_id, copy.message_reference],
    ['v3 is out', 2, followHook.id, { message_id: m.id, channel_id: news.id, guild_id: g.guild.id }]);
});
