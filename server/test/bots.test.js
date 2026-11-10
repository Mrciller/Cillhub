import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createPublicKey, verify as edVerify } from 'node:crypto';
import { startServer, guildWith, png } from './helpers.js';

const I = { GUILDS: 1, GUILD_MEMBERS: 2, GUILD_PRESENCES: 256, GUILD_MESSAGES: 512, MESSAGE_CONTENT: 1 << 15 };
let srv, api, g, alice, bob, app;
const bot = token => `Bot ${token}`;

before(async () => {
  srv = await startServer();
  api = srv.api;
  g = await guildWith(srv, ['alice', 'bob']);
  ({ alice, bob } = g.users);
  app = (await api('POST', '/applications', alice.token, { name: 'Helper' })).body;
  await api('POST', `/oauth2/authorize?client_id=${app.id}&scope=bot`, alice.token, { authorize: true, guild_id: g.guild.id, permissions: '3072' });
  alice.gw = await srv.gateway(alice.token);
  bob.gw = await srv.gateway(bob.token);
});
after(() => srv.stop());

// a raw bot connection; resolves with the socket after READY or with the close code
async function botGateway(d) {
  const gw = srv.socket();
  await gw.wait(f => f.op === 10);
  gw.send({ op: 2, d: { token: app.bot.token, properties: { os: 'linux', browser: 'test', device: 'test' }, ...d } });
  const first = await Promise.race([gw.wait(f => f.t === 'READY'), gw.closed]);
  if (typeof first === 'number') return { code: first };
  gw.ready = first.d;
  return gw;
}

test('applications: bot user, token kinds kept apart, user-only and bot-only routes', async () => {
  assert.equal(app.bot.bot, true);
  assert.equal(app.id, app.bot.id);
  assert.match(app.verify_key, /^[0-9a-f]{64}$/);
  assert.equal((await api('GET', '/applications', alice.token)).body.length, 1);
  assert.equal((await api('GET', `/applications/${app.id}`, bob.token)).status, 403);
  // bot token only with "Bot ", user token never with it
  assert.equal((await api('GET', '/users/@me', bot(app.bot.token))).body.bot, true);
  assert.equal((await api('GET', '/users/@me', app.bot.token)).status, 401);
  assert.equal((await api('GET', '/users/@me', bot(alice.token))).status, 401);
  assert.deepEqual((await api('GET', '/gateway/bot', alice.token)).body.code, 20002);
  const gb = (await api('GET', '/gateway/bot', bot(app.bot.token))).body;
  assert.deepEqual([gb.shards, gb.session_start_limit.max_concurrency], [1, 1]);
  assert.equal((await api('GET', '/users/@me/relationships', bot(app.bot.token))).body.code, 20001);
  assert.equal((await api('GET', '/users/@me/settings', bot(app.bot.token))).body.code, 20001);
  assert.equal((await api('POST', `/invites/${g.invite.code}`, bot(app.bot.token))).body.code, 20001);
  assert.equal((await api('GET', '/applications/@me', bot(app.bot.token))).body.id, app.id);
  // bot libraries talk to /api/v10
  const v10 = await fetch(`${srv.origin}/api/v10/users/@me`, { headers: { Authorization: bot(app.bot.token) } });
  assert.equal(v10.status, 200);
  // reset revokes the old token
  const fresh = (await api('POST', `/applications/${app.id}/bot/reset`, alice.token)).body.token;
  assert.equal((await api('GET', '/users/@me', bot(app.bot.token))).status, 401);
  app.bot.token = fresh;
});

test('OAuth2 install: MANAGE_GUILD needed, only permissions the installer has, managed role cannot be assigned or deleted', async () => {
  const other = (await api('POST', '/applications', bob.token, { name: 'Other' })).body;
  const q = `client_id=${other.id}&scope=bot`;
  assert.equal((await api('POST', `/oauth2/authorize?${q}`, bob.token, { authorize: true, guild_id: g.guild.id })).status, 403);
  assert.equal((await api('POST', `/oauth2/authorize?${q}`, alice.token, { authorize: true, guild_id: g.guild.id, permissions: '8' })).status, 200);
  const role = (await api('GET', `/guilds/${g.guild.id}/roles`, alice.token)).body.find(r => r.tags?.bot_id === other.id);
  assert.equal(role.managed, true);
  assert.equal((await api('PATCH', `/guilds/${g.guild.id}/members/${bob.id}`, alice.token, { roles: [role.id] })).status, 400);
  assert.equal((await api('DELETE', `/guilds/${g.guild.id}/roles/${role.id}`, alice.token)).status, 400);
  // kicking the bot removes its managed role
  assert.equal((await api('DELETE', `/guilds/${g.guild.id}/members/${other.id}`, alice.token)).status, 204);
  assert.equal((await api('GET', `/guilds/${g.guild.id}/roles`, alice.token)).body.some(r => r.id === role.id), false);
});

test('bot gateway: invalid intents 4013, privileged without the flag 4014, READY then GUILD_CREATE', async () => {
  assert.equal((await botGateway({ intents: 1 << 30 })).code, 4013);
  assert.equal((await botGateway({})).code, 4013);
  assert.equal((await botGateway({ intents: I.GUILDS | I.MESSAGE_CONTENT })).code, 4014);
  assert.equal((await botGateway({ intents: I.GUILDS | I.GUILD_MEMBERS })).code, 4014);
  const gw = await botGateway({ intents: I.GUILDS, shard: [0, 1] });
  assert.deepEqual(gw.ready.guilds, [{ id: g.guild.id, unavailable: true }]);
  assert.deepEqual(gw.ready.application, { id: app.id, flags: 0 });
  assert.deepEqual(gw.ready.shard, [0, 1]);
  const gc = await gw.event('GUILD_CREATE');
  assert.equal(gc.id, g.guild.id);
  // without GUILD_PRESENCES only the bot itself is in members
  assert.deepEqual(gc.members.map(m => m.user.id), [app.id]);
  gw.ws.close();
});

test('intents filter events; MESSAGE_CONTENT redaction except mentions; REST redaction follows the app flag', async () => {
  const quiet = await botGateway({ intents: I.GUILDS });
  const gw = await botGateway({ intents: I.GUILDS | I.GUILD_MESSAGES });
  await api('POST', `/channels/${g.general.id}/messages`, bob.token, { content: 'plain words' });
  const plain = await gw.event('MESSAGE_CREATE', m => m.author.id === bob.id);
  assert.deepEqual([plain.content, plain.embeds, plain.attachments], ['', [], []]);
  await api('POST', `/channels/${g.general.id}/messages`, bob.token, { content: `hi <@${app.id}>` });
  assert.equal((await gw.event('MESSAGE_CREATE', m => m.content.includes('hi'))).content, `hi <@${app.id}>`);
  assert.ok(await quiet.none(f => f.t === 'MESSAGE_CREATE', 300), 'no MESSAGE_CREATE without GUILD_MESSAGES');
  assert.ok(await quiet.none(f => f.t === 'TYPING_START', 10));
  const listed = (await api('GET', `/channels/${g.general.id}/messages?limit=5`, bot(app.bot.token))).body;
  assert.equal(listed.find(m => m.author.id === bob.id && !m.content.includes(app.id)).content, '');
  await api('PATCH', `/applications/${app.id}`, alice.token, { flags: 1 << 19 });
  const full = await botGateway({ intents: I.GUILDS | I.GUILD_MESSAGES | I.MESSAGE_CONTENT });
  await api('POST', `/channels/${g.general.id}/messages`, bob.token, { content: 'now visible' });
  assert.equal((await full.event('MESSAGE_CREATE', m => m.author.id === bob.id)).content, 'now visible');
  assert.ok((await api('GET', `/channels/${g.general.id}/messages?limit=5`, bot(app.bot.token))).body.some(m => m.content === 'plain words'));
  [quiet, gw, full].forEach(x => x.ws.close());
});

test('RESUME replays missed events then RESUMED; a bad session gets op 9', async () => {
  const gw = await botGateway({ intents: I.GUILDS | I.GUILD_MESSAGES });
  await gw.event('GUILD_CREATE');
  const lastSeq = Math.max(...gw.frames.map(f => f.s ?? 0), 2);
  gw.ws.close();
  await gw.closed;
  await api('POST', `/channels/${g.general.id}/messages`, bob.token, { content: 'while away' });
  const again = srv.socket();
  await again.wait(f => f.op === 10);
  again.send({ op: 6, d: { token: app.bot.token, session_id: gw.ready.session_id, seq: lastSeq } });
  const missed = await again.event('MESSAGE_CREATE');
  assert.equal(missed.author.id, bob.id); // content redacted: this session did not ask for MESSAGE_CONTENT
  await again.event('RESUMED');
  const bad = srv.socket();
  await bad.wait(f => f.op === 10);
  bad.send({ op: 6, d: { token: app.bot.token, session_id: 'nope', seq: 1 } });
  assert.equal((await bad.wait(f => f.op === 9)).d, false);
  again.ws.close();
});

test('op 8 member chunks: whole list needs GUILD_MEMBERS, prefix queries and user_ids work without', async () => {
  const gw = await botGateway({ intents: I.GUILDS });
  gw.send({ op: 8, d: { guild_id: g.guild.id, query: 'bo', limit: 10, nonce: 'q' } });
  const chunk = await gw.event('GUILD_MEMBERS_CHUNK');
  assert.deepEqual([chunk.members.map(m => m.user.id), chunk.chunk_index, chunk.chunk_count, chunk.nonce], [[bob.id], 0, 1, 'q']);
  gw.send({ op: 8, d: { guild_id: g.guild.id, user_ids: [alice.id, '123'] } });
  assert.deepEqual((await gw.event('GUILD_MEMBERS_CHUNK')).not_found, ['123']);
  gw.send({ op: 8, d: { guild_id: g.guild.id, query: '', limit: 0 } });
  assert.equal(await gw.closed, 4013);
  await api('PATCH', `/applications/${app.id}`, alice.token, { flags: (1 << 19) | (1 << 15) });
  const full = await botGateway({ intents: I.GUILDS | I.GUILD_MEMBERS });
  full.send({ op: 8, d: { guild_id: g.guild.id, query: '', limit: 0 } });
  assert.equal((await full.event('GUILD_MEMBERS_CHUNK')).members.length, 3);
  full.ws.close();
});

test('application commands: validation, upsert by name, bulk overwrite, default_member_permissions in the index', async () => {
  const base = `/applications/${app.id}/guilds/${g.guild.id}/commands`;
  const B = bot(app.bot.token);
  assert.equal((await api('POST', base, B, { name: 'Bad Name', description: 'x' })).status, 400);
  assert.equal((await api('POST', base, B, { name: 'opt', description: 'x', options: [{ type: 3, name: 'a', description: 'a' }, { type: 3, name: 'b', description: 'b', required: true }] })).status, 400);
  assert.equal((await api('POST', base, B, { name: 'ac', description: 'x', options: [{ type: 3, name: 'a', description: 'a', autocomplete: true, choices: [{ name: 'x', value: 'x' }] }] })).status, 400);
  const c1 = await api('POST', base, B, { name: 'echo', description: 'Echo', options: [{ type: 3, name: 'text', description: 't', required: true, max_length: 10 }] });
  assert.equal(c1.status, 201);
  const c2 = await api('POST', base, B, { name: 'echo', description: 'Echo again' });
  assert.deepEqual([c2.status, c2.body.id], [200, c1.body.id]);
  assert.equal((await api('POST', `/applications/${app.id}/commands`, alice.token, { name: 'x', description: 'x' })).body.code, 20002);
  const other = (await api('POST', '/applications', bob.token, { name: 'Third' })).body;
  assert.equal((await api('GET', `/applications/${app.id}/commands`, bot(other.bot.token))).body.code, 20012);
  const all = (await api('PUT', base, B, [
    { name: 'echo', description: 'Echo', options: [{ type: 3, name: 'text', description: 't', required: true, max_length: 10 }] },
    { name: 'admin', description: 'Admins only', default_member_permissions: '8' },
    { name: 'Inspect', type: 2 },
  ])).body;
  assert.equal(all.find(c => c.name === 'echo').id, c1.body.id);
  const names = who => api('GET', `/guilds/${g.guild.id}/application-command-index`, who.token).then(r => r.body.application_commands.map(c => c.name).sort());
  assert.deepEqual(await names(alice), ['Inspect', 'admin', 'echo']);
  assert.deepEqual(await names(bob), ['Inspect', 'echo']);
});

async function command(name) {
  return (await api('GET', `/channels/${g.general.id}/application-command-index`, alice.token)).body.application_commands.find(c => c.name === name);
}
const runCommand = (who, cmd, extra = {}) => api('POST', '/interactions', who.token, {
  type: 2, application_id: app.id, guild_id: g.guild.id, channel_id: g.general.id, data: { id: cmd.id, name: cmd.name, type: cmd.type, ...extra },
});

test('interactions: options validated, unanswered ones fail after 3 s and the token dies; tokens belong to one app', async () => {
  const echo = await command('echo');
  assert.equal((await runCommand(alice, echo, { options: [{ name: 'text', type: 3, value: 'x'.repeat(11) }] })).status, 400);
  assert.equal((await runCommand(alice, echo)).status, 400);
  assert.equal((await runCommand(bob, await command('Inspect'), { target_id: alice.id })).status, 204);
  const gw = await botGateway({ intents: I.GUILDS });
  assert.equal((await runCommand(alice, echo, { options: [{ name: 'text', type: 3, value: 'hi' }] })).status, 204);
  const i = await gw.event('INTERACTION_CREATE', d => d.data.name === 'echo');
  assert.deepEqual([i.data.options, i.member.user.id, i.channel_id, i.version, i.entitlements], [[{ name: 'text', type: 3, value: 'hi' }], alice.id, g.general.id, 1, []]);
  await alice.gw.event('INTERACTION_CREATE', d => d.id === i.id);
  const failure = (await alice.gw.wait(f => f.t === 'INTERACTION_FAILURE' && f.d.id === i.id, 6000)).d;
  assert.equal(failure.reason_code, 2);
  const late = await api('POST', `/interactions/${i.id}/${i.token}/callback`, null, { type: 4, data: { content: 'too late' } });
  assert.deepEqual([late.status, late.body.code], [404, 10062]);
  // answered in time; a second answer is refused; another app cannot use the token
  assert.equal((await runCommand(alice, echo, { options: [{ name: 'text', type: 3, value: 'ok' }] })).status, 204);
  const j = await gw.event('INTERACTION_CREATE', d => d.data.options?.[0].value === 'ok');
  assert.equal((await api('POST', `/interactions/${i.id}/${j.token}/callback`, null, { type: 4, data: { content: 'x' } })).status, 404);
  assert.equal((await api('POST', `/interactions/${j.id}/${j.token}/callback`, null, { type: 4, data: { content: 'echo: ok' } })).status, 204);
  assert.equal((await api('POST', `/interactions/${j.id}/${j.token}/callback`, null, { type: 4, data: { content: 'again' } })).body.code, 40060);
  const other = (await api('GET', '/applications', bob.token)).body[0];
  assert.equal((await api('PATCH', `/webhooks/${other.id}/${j.token}/messages/@original`, null, { content: 'hijack' })).status, 401);
  const edited = await api('PATCH', `/webhooks/${app.id}/${j.token}/messages/@original`, null, { content: 'edited' });
  assert.equal(edited.body.content, 'edited');
  const follow = await api('POST', `/webhooks/${app.id}/${j.token}`, null, { content: 'follow-up' });
  assert.equal(follow.body.content, 'follow-up');
  gw.ws.close();
});

test('ephemeral responses reach only the invoker and are never stored; components and modals round-trip', async () => {
  const gw = await botGateway({ intents: I.GUILDS });
  await runCommand(alice, await command('echo'), { options: [{ name: 'text', type: 3, value: 'eph' }] });
  const i = await gw.event('INTERACTION_CREATE');
  const row = [{ type: 1, components: [{ type: 2, style: 1, label: 'Open', custom_id: 'open' }, { type: 2, style: 5, label: 'Site', url: 'https://example.com' }] }];
  await api('POST', `/interactions/${i.id}/${i.token}/callback`, null, { type: 4, data: { content: 'only you', flags: 64, components: row } });
  const eph = await alice.gw.event('MESSAGE_CREATE', m => m.content === 'only you');
  assert.equal(eph.flags & 64, 64);
  assert.ok(await bob.gw.none(f => f.t === 'MESSAGE_CREATE' && f.d.id === eph.id, 300));
  assert.equal((await api('GET', `/channels/${g.general.id}/messages?limit=20`, alice.token)).body.some(m => m.id === eph.id), false);
  // bob cannot press alice's ephemeral button; alice can, and a modal opens
  const press = who => api('POST', '/interactions', who.token, { type: 3, application_id: app.id, channel_id: g.general.id, message_id: eph.id, data: { component_type: 2, custom_id: 'open' } });
  assert.equal((await press(bob)).status, 404);
  assert.equal((await press(alice)).status, 204);
  const click = await gw.event('INTERACTION_CREATE', d => d.type === 3);
  assert.equal(click.message.id, eph.id);
  const modal = { custom_id: 'form', title: 'Tell me', components: [{ type: 1, components: [{ type: 4, custom_id: 'name', style: 1, label: 'Name', max_length: 5 }] }] };
  await api('POST', `/interactions/${click.id}/${click.token}/callback`, null, { type: 9, data: modal });
  const opened = await alice.gw.event('INTERACTION_MODAL_CREATE');
  const submit = value => api('POST', '/interactions', alice.token, { type: 5, application_id: app.id, channel_id: g.general.id, data: { id: opened.id, custom_id: 'form', components: [{ type: 1, components: [{ type: 4, custom_id: 'name', value }] }] } });
  assert.equal((await submit('toolong')).status, 400);
  assert.equal((await submit('Ann')).status, 204);
  const sub = await gw.event('INTERACTION_CREATE', d => d.type === 5);
  assert.equal(sub.data.components[0].components[0].value, 'Ann');
  await api('POST', `/interactions/${sub.id}/${sub.token}/callback`, null, { type: 7, data: { content: 'thanks Ann', components: [] } });
  assert.equal((await alice.gw.event('MESSAGE_UPDATE', m => m.id === eph.id)).content, 'thanks Ann');
  gw.ws.close();
});

test('HTTP interactions: endpoint verified by PING (and a bad signature must be refused), payloads signed with Ed25519', async () => {
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(app.verify_key, 'hex')]), format: 'der', type: 'spki' });
  const received = [];
  let checkSignatures = true;
  const site = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const ok = edVerify(null, Buffer.from(req.headers['x-signature-timestamp'] + body), key, Buffer.from(String(req.headers['x-signature-ed25519']), 'hex'));
      if (checkSignatures && !ok) { res.writeHead(401); return res.end(); }
      const i = JSON.parse(body);
      received.push({ i, ok });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(i.type === 1 ? { type: 1 } : { type: 4, data: { content: `http says ${i.data.options[0].value}` } }));
    });
  });
  await new Promise(r => site.listen(0, '127.0.0.1', r));
  const port = site.address().port;
  const url = `http://127.0.0.1:${port}/interactions`;
  try {
    // the server under test only reaches this local site because the test env allows it
    const blocked = await api('PATCH', `/applications/${app.id}`, alice.token, { interactions_endpoint_url: url });
    assert.equal(blocked.status, 400);
    await srv.stop(true);
    srv = await startServer({ dataDir: srv.dataDir, env: { CILLCORD_UNFURL_ALLOW: `127.0.0.1:${port}` } });
    api = srv.api;
    alice.gw = await srv.gateway(alice.token);
    checkSignatures = false; // an endpoint that accepts anything is refused
    assert.equal((await api('PATCH', `/applications/${app.id}`, alice.token, { interactions_endpoint_url: url })).status, 400);
    checkSignatures = true;
    received.length = 0;
    assert.equal((await api('PATCH', `/applications/${app.id}`, alice.token, { interactions_endpoint_url: url })).body.interactions_endpoint_url, url);
    assert.ok(received.every(r => r.ok));
    await runCommand(alice, await command('echo'), { options: [{ name: 'text', type: 3, value: 'signed' }] });
    assert.equal((await alice.gw.event('MESSAGE_CREATE', m => m.author.id === app.id)).content, 'http says signed');
    assert.equal(received.at(-1).i.type, 2);
    assert.ok(received.at(-1).ok);
  } finally {
    site.close();
  }
});

test('autocomplete: one focused option, choices go back to the invoker only', async () => {
  await api('PATCH', `/applications/${app.id}`, alice.token, { interactions_endpoint_url: null });
  const B = bot(app.bot.token);
  await api('POST', `/applications/${app.id}/guilds/${g.guild.id}/commands`, B, { name: 'pick', description: 'Pick', options: [{ type: 3, name: 'game', description: 'g', autocomplete: true }] });
  const pick = await command('pick');
  const gw = await botGateway({ intents: I.GUILDS });
  const ask = focused => api('POST', '/interactions', alice.token, { type: 4, application_id: app.id, channel_id: g.general.id, nonce: 'ac', data: { id: pick.id, name: 'pick', type: 1, options: [{ name: 'game', type: 3, value: 'val', focused }] } });
  assert.equal((await ask(false)).status, 400);
  assert.equal((await ask(true)).status, 204);
  const i = await gw.event('INTERACTION_CREATE', d => d.type === 4);
  assert.equal((await api('POST', `/interactions/${i.id}/${i.token}/callback`, null, { type: 4, data: { content: 'no' } })).status, 400);
  await api('POST', `/interactions/${i.id}/${i.token}/callback`, null, { type: 8, data: { choices: [{ name: 'Valorant', value: 'valorant' }] } });
  assert.deepEqual(await alice.gw.event('APPLICATION_COMMAND_AUTOCOMPLETE_RESPONSE'), { choices: [{ name: 'Valorant', value: 'valorant' }], nonce: 'ac' });
  gw.ws.close();
});

test('ATTACHMENT options: multipart Create Interaction, resolved.attachments with an ephemeral URL; files in callbacks, follow-ups and edits', async () => {
  const B = bot(app.bot.token);
  await api('POST', `/applications/${app.id}/guilds/${g.guild.id}/commands`, B, { name: 'upload', description: 'Upload', options: [{ type: 11, name: 'file', description: 'f', required: true }] });
  const cmd = await command('upload');
  const gw = await botGateway({ intents: I.GUILDS });
  bob.gw = await srv.gateway(bob.token); // the HTTP test restarted the server
  const invoke = (who, data, files = [['files[0]', 'pic.png', png(2, 3), 'image/png']], type = 2) => srv.form('POST', '/interactions', who.token,
    { type, application_id: app.id, guild_id: g.guild.id, channel_id: g.general.id, nonce: 'up', data: { id: cmd.id, name: 'upload', type: 1, ...data } }, files);
  const opt = { options: [{ name: 'file', type: 11, value: 0 }], attachments: [{ id: '0', filename: 'pic.png' }] };
  // the option must name an uploaded file; only commands take files; ATTACH_FILES is needed in guilds
  assert.equal((await runCommand(alice, cmd, { options: [{ name: 'file', type: 11, value: 0 }] })).status, 400);
  assert.equal((await invoke(alice, { ...opt, options: [{ name: 'file', type: 11, value: 1 }] })).status, 400);
  assert.equal((await invoke(alice, opt, undefined, 4)).status, 400);
  await api('PUT', `/channels/${g.general.id}/permissions/${bob.id}`, alice.token, { type: 1, allow: '0', deny: String(1 << 15) });
  assert.equal((await invoke(bob, opt)).status, 403);
  await api('DELETE', `/channels/${g.general.id}/permissions/${bob.id}`, alice.token);

  assert.equal((await invoke(alice, opt)).status, 204);
  const i = await gw.event('INTERACTION_CREATE', d => d.data.name === 'upload');
  const id = i.data.options[0].value;
  const a = i.data.resolved.attachments[id];
  assert.deepEqual([a.id, a.filename, a.content_type, a.size, a.width, a.height, a.ephemeral], [id, 'pic.png', 'image/png', 33, 2, 3, true]);
  assert.match(a.url, new RegExp(`^/ephemeral-attachments/${app.id}/${id}/pic.png\\?key=[\\w-]{24}$`));
  const got = await fetch(srv.origin + a.url);
  assert.deepEqual([got.status, got.headers.get('content-type'), got.headers.get('x-content-type-options')], [200, 'image/png', 'nosniff']);
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), png(2, 3));
  assert.equal((await fetch(`${srv.origin}/ephemeral-attachments/1/${id}/pic.png`)).status, 404);
  assert.equal((await fetch(`${srv.origin}/ephemeral-attachments/${app.id}/${id}/pic.png`)).status, 404, 'no key, no file');

  // a file in the callback (payload_json with data.attachments), referenced from an embed with attachment://
  const cb = await srv.form('POST', `/interactions/${i.id}/${i.token}/callback`, null,
    { type: 4, data: { content: 'got it', attachments: [{ id: 0, description: 'echo' }], embeds: [{ title: 'pic', image: { url: 'attachment://echo.png' } }] } },
    [['files[0]', 'echo.png', png(4, 4), 'image/png']]);
  assert.equal(cb.status, 204);
  const reply = await alice.gw.event('MESSAGE_CREATE', m => m.content === 'got it');
  const att = reply.attachments[0];
  assert.deepEqual([att.filename, att.description, att.url], ['echo.png', 'echo', `/attachments/${g.general.id}/${att.id}/${att.url.split('/')[4]}/echo.png`]);
  assert.equal(reply.embeds[0].image.url, att.url);
  assert.equal((await fetch(srv.origin + att.url)).status, 200);

  // an ephemeral follow-up with a file: only the invoker sees it, served from the ephemeral path
  const fu = await srv.form('POST', `/webhooks/${app.id}/${i.token}`, null, { content: 'secret file', flags: 64, attachments: [{ id: 0 }] }, [['files[0]', 'notes.txt', 'hi', 'text/plain']]);
  assert.equal(fu.status, 200);
  assert.match(fu.body.attachments[0].url, new RegExp(`^/ephemeral-attachments/${app.id}/\\d+/notes.txt\\?key=[\\w-]{24}$`));
  const eph = await alice.gw.event('MESSAGE_CREATE', m => m.content === 'secret file');
  assert.equal(eph.attachments[0].content_type, 'text/plain');
  assert.ok(await bob.gw.none(f => f.t === 'MESSAGE_CREATE' && f.d.id === eph.id, 200));
  const txt = await fetch(srv.origin + eph.attachments[0].url);
  assert.deepEqual([await txt.text(), txt.headers.get('content-disposition')], ['hi', 'attachment; filename="notes.txt"']);

  // editing the original: keep the listed attachment and add a new file; then an empty list removes them all
  const ed = await srv.form('PATCH', `/webhooks/${app.id}/${i.token}/messages/@original`, null, { attachments: [{ id: att.id }, { id: 0 }] }, [['files[0]', 'b.png', png(), 'image/png']]);
  assert.deepEqual(ed.body.attachments.map(x => x.filename), ['echo.png', 'b.png']);
  // percent-encoded as bot libraries send it
  const cleared = await srv.form('PATCH', `/webhooks/${app.id}/${i.token}/messages/%40original`, null, { attachments: [] });
  assert.deepEqual(cleared.body.attachments, []);
  assert.equal((await fetch(srv.origin + att.url)).status, 404);
  // a deferred response cannot carry files
  assert.equal((await invoke(alice, opt)).status, 204);
  const j = await gw.event('INTERACTION_CREATE', d => d.data.name === 'upload');
  assert.equal((await srv.form('POST', `/interactions/${j.id}/${j.token}/callback`, null, { type: 5 }, [['files[0]', 'x.png', png(), 'image/png']])).status, 400);
  gw.ws.close();
});
