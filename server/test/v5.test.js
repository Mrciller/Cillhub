// v5: scheduled messages, saved messages, server templates and export/import, Spacebar discovery, Playing activities
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, guildWith, bits, png } from './helpers.js';
import { fromExternal } from '../src/routes/templates.js';

let srv, api, g, alice, bob;

before(async () => {
  srv = await startServer();
  api = srv.api;
  g = await guildWith(srv, ['alice', 'bob']);
  ({ alice, bob } = g.users);
  for (const u of [alice, bob]) u.gw = await srv.gateway(u.token);
});
after(() => srv.stop());

const soon = ms => new Date(Date.now() + ms).toISOString();

test('scheduled messages: validated when scheduled, listed, edited, cancelled, sent at the time', async () => {
  const path = `/channels/${g.general.id}/scheduled-messages`;
  assert.equal((await api('POST', path, alice.token, { content: 'past', send_at: soon(-1000) })).status, 400);
  assert.equal((await api('POST', path, alice.token, { content: '', send_at: soon(5000) })).body.code, 50006);
  assert.equal((await api('POST', `/channels/${g.voice.id}/scheduled-messages`, alice.token, { content: 'x', send_at: soon(5000) })).status, 201); // voice text chat
  const s = await api('POST', path, alice.token, { content: 'good morning', send_at: soon(60_000) });
  assert.equal(s.status, 201);
  assert.deepEqual([s.body.channel_id, s.body.guild_id, s.body.content], [g.general.id, g.guild.id, 'good morning']);
  assert.equal((await alice.gw.event('SCHEDULED_MESSAGE_CREATE', d => d.id === s.body.id)).content, 'good morning');
  assert.equal((await api('GET', '/users/@me/scheduled-messages', alice.token)).body.length, 2);
  assert.equal((await api('GET', '/users/@me/scheduled-messages', bob.token)).body.length, 0);
  assert.equal((await api('PATCH', `/users/@me/scheduled-messages/${s.body.id}`, bob.token, { content: 'mine' })).status, 404);
  const edited = await api('PATCH', `/users/@me/scheduled-messages/${s.body.id}`, alice.token, { content: 'good evening', send_at: soon(1200) });
  assert.equal(edited.body.content, 'good evening');
  const sent = await bob.gw.event('MESSAGE_CREATE', d => d.content === 'good evening', 5000);
  assert.equal(sent.author.id, alice.id);
  assert.deepEqual(await alice.gw.event('SCHEDULED_MESSAGE_DELETE', d => d.id === s.body.id), { id: s.body.id, channel_id: g.general.id, guild_id: g.guild.id, message_id: sent.id });
  const other = (await api('GET', '/users/@me/scheduled-messages', alice.token)).body[0];
  assert.equal((await api('DELETE', `/users/@me/scheduled-messages/${other.id}`, alice.token)).status, 204);
  assert.equal((await api('GET', '/users/@me/scheduled-messages', alice.token)).body.length, 0);
  // 25 per user
  for (let i = 0; i < 25; i++) assert.equal((await api('POST', path, bob.token, { content: `n${i}`, send_at: soon(3600e3) })).status, 201);
  assert.equal((await api('POST', path, bob.token, { content: 'one too many', send_at: soon(3600e3) })).status, 400);
  for (const m of (await api('GET', '/users/@me/scheduled-messages', bob.token)).body) await api('DELETE', `/users/@me/scheduled-messages/${m.id}`, bob.token);
});

test('scheduled messages: permissions are checked again at send time', async () => {
  const s = await api('POST', `/channels/${g.general.id}/scheduled-messages`, bob.token, { content: 'sneaky @everyone', send_at: soon(1200) });
  assert.equal(s.status, 201);
  // bob loses SEND_MESSAGES in #general before it is due
  assert.equal((await api('PUT', `/channels/${g.general.id}/permissions/${bob.id}`, alice.token, { type: 1, allow: '0', deny: bits(11) })).status, 204);
  const failed = await bob.gw.event('SCHEDULED_MESSAGE_DELETE', d => d.id === s.body.id, 5000);
  assert.deepEqual([failed.failed, failed.code, failed.message_id], [true, 50013, undefined]);
  assert.ok(!(await api('GET', `/channels/${g.general.id}/messages?limit=5`, alice.token)).body.some(m => m.content.startsWith('sneaky')));
  await api('DELETE', `/channels/${g.general.id}/permissions/${bob.id}`, alice.token);
  // scheduling is refused outright where you cannot send now
  await api('PUT', `/channels/${g.general.id}/permissions/${bob.id}`, alice.token, { type: 1, allow: '0', deny: bits(11) });
  assert.equal((await api('POST', `/channels/${g.general.id}/scheduled-messages`, bob.token, { content: 'x', send_at: soon(5000) })).status, 403);
  await api('DELETE', `/channels/${g.general.id}/permissions/${bob.id}`, alice.token);
});

test('saved messages (user docs): bookmark, reminder due event, unsave', async () => {
  const m = (await api('POST', `/channels/${g.general.id}/messages`, bob.token, { content: 'read this later' })).body;
  const path = `/users/@me/saved-messages/${g.general.id}/${m.id}`;
  const bookmark = await api('PUT', path, alice.token, {});
  assert.deepEqual([bookmark.body.message.id, bookmark.body.save_data.due_at, bookmark.body.save_data.author_summary, bookmark.body.save_data.guild_id], [m.id, null, 'bob', g.guild.id]);
  await alice.gw.event('SAVED_MESSAGE_CREATE', d => d.save_data.message_id === m.id);
  assert.equal((await api('PUT', path, alice.token, { due_at: soon(-5) })).status, 400);
  await api('PUT', path, alice.token, { due_at: soon(1000) });
  const due = await alice.gw.event('MESSAGE_REMINDER_DUE', d => d.save_data.message_id === m.id, 5000);
  assert.equal(due.message.content, 'read this later');
  assert.equal((await api('GET', '/users/@me/saved-messages', alice.token)).body.results.length, 1);
  assert.equal((await api('PUT', `/users/@me/saved-messages/${g.general.id}/1234`, alice.token, {})).status, 404);
  assert.equal((await api('DELETE', path, alice.token)).status, 204);
  assert.deepEqual(await alice.gw.event('SAVED_MESSAGE_DELETE'), { channel_id: g.general.id, message_id: m.id });
  assert.equal((await api('GET', '/users/@me/saved-messages', alice.token)).body.results.length, 0);
});

test('server templates: create, preview without login, use, sync, dirty flag, delete; export and import round trip', async () => {
  const gid = g.guild.id;
  const role = (await api('POST', `/guilds/${gid}/roles`, alice.token, { name: 'Coach', color: 0xff0000, hoist: true, permissions: bits(5) })).body;
  const cat = (await api('POST', `/guilds/${gid}/channels`, alice.token, { name: 'Staff', type: 4 })).body;
  const staff = (await api('POST', `/guilds/${gid}/channels`, alice.token, {
    name: 'coaches', type: 0, parent_id: cat.id, topic: 'Only coaches', rate_limit_per_user: 10,
    permission_overwrites: [{ id: gid, type: 0, allow: '0', deny: bits(10) }, { id: role.id, type: 0, allow: bits(10), deny: '0' }, { id: bob.id, type: 1, allow: bits(10), deny: '0' }],
  })).body;
  assert.ok(staff.id);
  await api('POST', `/guilds/${gid}/channels`, alice.token, { name: 'clips', type: 15, available_tags: [{ name: 'Highlight', emoji_name: '🔥' }] });
  const image = `data:image/png;base64,${png(16, 16).toString('base64')}`;
  assert.equal((await api('POST', `/guilds/${gid}/emojis`, alice.token, { name: 'gg', image, roles: [role.id] })).status, 201);
  await api('PATCH', `/guilds/${gid}`, alice.token, { verification_level: 1, afk_timeout: 900, afk_channel_id: g.voice.id, description: 'Esports' });

  assert.equal((await api('POST', `/guilds/${gid}/templates`, bob.token, { name: 'Org' })).status, 403);
  const t = await api('POST', `/guilds/${gid}/templates`, alice.token, { name: 'Org setup', description: 'Our layout' });
  assert.equal(t.status, 201);
  assert.deepEqual([t.body.code.length, t.body.usage_count, t.body.creator_id, t.body.source_guild_id, t.body.is_dirty], [12, 0, alice.id, gid, false]);
  assert.equal((await api('POST', `/guilds/${gid}/templates`, alice.token, { name: 'Second' })).body.code, 30031);
  const s = t.body.serialized_source_guild;
  assert.equal(s.id, undefined);
  assert.deepEqual(s.roles.map(r => [r.id, r.name]), [[0, '@everyone'], [1, 'Coach']]);
  const sc = s.channels.find(c => c.name === 'coaches');
  assert.deepEqual(sc.permission_overwrites, [{ id: 0, type: 0, allow: '0', deny: bits(10) }, { id: 1, type: 0, allow: bits(10), deny: '0' }]); // no member overwrite
  assert.equal(s.channels.find(c => c.id === sc.parent_id).name, 'Staff');

  // preview needs no login; using it builds an equivalent guild
  const preview = await fetch(`${srv.base}/guilds/templates/${t.body.code}`).then(r => r.json());
  assert.deepEqual([preview.name, preview.is_dirty], ['Org setup', null]);
  const created = await api('POST', `/guilds/templates/${t.body.code}`, bob.token, { name: 'Bob Esports' });
  assert.equal(created.status, 201);
  await bob.gw.event('GUILD_CREATE', d => d.id === created.body.id);
  const check = async (guild, owner) => {
    assert.equal(guild.owner_id, owner.id);
    assert.deepEqual(guild.roles.map(r => [r.name, r.color, r.hoist, r.permissions]), [['@everyone', 0, false, s.roles[0].permissions], ['Coach', 0xff0000, true, bits(5)]]);
    const coach = guild.roles[1].id;
    const ch = guild.channels.find(c => c.name === 'coaches');
    assert.deepEqual([ch.topic, ch.rate_limit_per_user, guild.channels.find(c => c.id === ch.parent_id).name], ['Only coaches', 10, 'Staff']);
    assert.deepEqual(ch.permission_overwrites.map(o => [o.id, o.allow, o.deny]).sort(), [[guild.id, '0', bits(10)], [coach, bits(10), '0']].sort());
    assert.deepEqual(guild.channels.find(c => c.name === 'clips').available_tags.map(x => [x.name, x.emoji_name]), [['Highlight', '🔥']]);
    assert.deepEqual([guild.verification_level, guild.afk_timeout, guild.description], [1, 900, 'Esports']);
    assert.equal(guild.channels.find(c => c.id === guild.afk_channel_id).type, 2);
    assert.deepEqual(guild.emojis.map(e => [e.name, e.roles]), [['gg', [coach]]]);
    assert.equal(guild.channels.find(c => c.id === guild.system_channel_id).name, 'general');
  };
  await check(created.body, bob);
  assert.equal((await api('GET', `/guilds/${gid}/templates`, alice.token)).body[0].usage_count, 1);

  // the guild changes: the template is dirty until synced
  await api('POST', `/guilds/${gid}/channels`, alice.token, { name: 'new-room', type: 0 });
  assert.equal((await api('GET', `/guilds/${gid}/templates`, alice.token)).body[0].is_dirty, true);
  const synced = await api('PUT', `/guilds/${gid}/templates/${t.body.code}`, alice.token);
  assert.deepEqual([synced.body.is_dirty, synced.body.serialized_source_guild.channels.some(c => c.name === 'new-room')], [false, true]);
  assert.equal((await api('PATCH', `/guilds/${gid}/templates/${t.body.code}`, alice.token, { description: null })).body.description, null);

  // export -> import: the same snapshot as a file
  const file = (await api('GET', `/guilds/${gid}/export`, alice.token)).body;
  assert.deepEqual([file.format, file.version], ['cillcord-guild', 1]);
  assert.equal((await api('GET', `/guilds/${gid}/export`, bob.token)).status, 403);
  // imported through Create Guild (docs) with the snapshot's placeholder ids
  const imported = await api('POST', '/guilds', alice.token, file.serialized_source_guild);
  assert.equal(imported.status, 201);
  assert.equal(imported.body.name, 'Test Guild');
  await check(imported.body, alice);
  // imported files are untrusted: bad references and types are refused, nothing is created
  const guildCount = (await api('GET', '/users/@me/guilds', alice.token)).body.length;
  const broken = structuredClone(file.serialized_source_guild);
  broken.channels[0].parent_id = 999;
  assert.equal((await api('POST', '/guilds', alice.token, broken)).status, 400);
  broken.channels[0] = { id: 1, type: 1, name: 'dm' };
  assert.equal((await api('POST', '/guilds', alice.token, broken)).status, 400);
  assert.equal((await api('POST', '/guilds', alice.token, { ...file.serialized_source_guild, emojis: [{ name: 'x1', image: 'data:image/png;base64,PHN2Zz4=' }] })).status, 400);
  assert.equal((await api('GET', '/users/@me/guilds', alice.token)).body.length, guildCount);

  const deleted = await api('DELETE', `/guilds/${gid}/templates/${t.body.code}`, alice.token);
  assert.equal(deleted.body.code, t.body.code);
  assert.equal((await fetch(`${srv.base}/guilds/templates/${t.body.code}`)).status, 404);
});

test('external template links: adapted snapshot creates the same channels 1:1 through POST /guilds', async () => {
  // the shape of the other app's public template API (trimmed), incl. fields and types we adapt
  const ext = { code: 'abc123', name: 'Friends & Family', usage_count: 5, serialized_source_guild: {
    name: 'Friends & Family', description: null, verification_level: 4, default_message_notifications: 0, explicit_content_filter: 2, afk_timeout: 300,
    afk_channel_id: null, system_channel_id: 2, system_channel_flags: 0,
    roles: [{ id: 0, name: '@everyone', permissions: '2248329584434769', color: 0, colors: null, hoist: false, mentionable: false, icon: null, unicode_emoji: null },
      { id: 1, name: 'Mods', permissions: '8', color: 0x00ff00, hoist: true, mentionable: false }],
    channels: [
      { id: 1, type: 4, name: 'Text Channels', position: 0, parent_id: null, permission_overwrites: [] },
      { id: 2, type: 0, name: 'general', position: 0, parent_id: 1, topic: 'hi', permission_overwrites: [], icon_emoji: null, theme_color: null },
      { id: 3, type: 16, name: 'pics', position: 1, parent_id: 1, permission_overwrites: [], available_tags: [{ id: '9', name: 'Cat', moderated: false, emoji_id: '77', emoji_name: null }] },
      { id: 6, type: 15, name: 'help', position: 2, parent_id: 1, permission_overwrites: [], available_tags: [], default_reaction_emoji: { emoji_id: null, emoji_name: null }, default_sort_order: null, default_forum_layout: 0, default_thread_rate_limit_per_user: 0, template: '' },
      { id: 4, type: 4, name: 'Mods only', position: 1, parent_id: null, permission_overwrites: [{ id: 0, type: 0, allow: '0', deny: '1024' }, { id: 1, type: 0, allow: '1024', deny: '0' }] },
      { id: 5, type: 2, name: 'Lounge', position: 0, parent_id: 4, user_limit: 5, permission_overwrites: [] },
    ] } };
  const tpl = fromExternal(ext, 'abc123');
  assert.equal(tpl.external, true);
  const created = await api('POST', '/guilds', bob.token, { name: 'Copied', ...tpl.serialized_source_guild });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const guild = (await bob.gw.event('GUILD_CREATE', d => d.id === created.body.id));
  const chans = guild.channels.filter(c => c.type !== 11).sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  const parentName = c => guild.channels.find(x => x.id === c.parent_id)?.name ?? null;
  assert.deepEqual(chans.map(c => [c.name, c.type, parentName(c)]).sort(), [
    ['Text Channels', 4, null], ['general', 0, 'Text Channels'], ['pics', 15, 'Text Channels'], ['help', 15, 'Text Channels'], ['Mods only', 4, null], ['Lounge', 2, 'Mods only']].sort());
  assert.deepEqual(guild.roles.map(r => [r.name, r.color, r.hoist]), [['@everyone', 0, false], ['Mods', 0x00ff00, true]]);
  const mods = guild.channels.find(c => c.name === 'Mods only');
  assert.deepEqual(mods.permission_overwrites.map(o => [o.id === guild.id ? 'everyone' : 'mods', o.allow, o.deny]).sort(), [['everyone', '0', '1024'], ['mods', '1024', '0']]);
  assert.equal(guild.system_channel_id, guild.channels.find(c => c.name === 'general').id);
  assert.equal(guild.verification_level, 2);
  // bad codes never reach the network
  assert.equal((await api('GET', '/guilds/templates/external/..%2Fusers', bob.token)).status, 404);
});

test('Spacebar discovery: well-known and instance policy endpoints', async () => {
  const wk = await fetch(`${srv.origin}/.well-known/spacebar`);
  assert.equal(wk.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(await wk.json(), { api: `${srv.origin}/api/v9` });
  const client = await fetch(`${srv.origin}/.well-known/spacebar/client`).then(r => r.json());
  assert.deepEqual([client.api.baseUrl, client.api.apiVersions.default, client.gateway.baseUrl], [srv.origin, '9', srv.origin.replace('http', 'ws')]);
  const domains = await fetch(`${srv.origin}/api/policies/instance/domains`).then(r => r.json());
  assert.deepEqual(domains, { cdn: srv.origin, gateway: srv.origin.replace('http', 'ws'), defaultApiVersion: '9', apiEndpoint: `${srv.origin}/api` });
  assert.equal((await fetch(`${srv.origin}/api/policies/instance`).then(r => r.json())).instanceName, 'Cillhub');
  // the gateway URL from discovery works with /gateway appended, as GET /gateway says
  assert.equal((await api('GET', '/gateway')).body.url, `${domains.gateway}/gateway`);
});

test('Playing activities (type 0) from op 3 reach guild members in PRESENCE_UPDATE', async () => {
  alice.gw.send({ op: 3, d: { status: 'online', since: null, afk: false, activities: [{ type: 0, name: 'Counter-Strike 2', timestamps: { start: 1762200000000 } }] } });
  const p = await bob.gw.event('PRESENCE_UPDATE', d => d.user.id === alice.id && d.activities.length);
  assert.deepEqual([p.activities[0].type, p.activities[0].name, p.activities[0].timestamps], [0, 'Counter-Strike 2', { start: 1762200000000 }]);
  alice.gw.send({ op: 3, d: { status: 'online', since: null, afk: false, activities: [] } });
  await bob.gw.event('PRESENCE_UPDATE', d => d.user.id === alice.id && !d.activities.length);
});
