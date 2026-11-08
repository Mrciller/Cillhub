import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, guildWith, bits } from './helpers.js';

let srv, api, g, alice, bob, carol;
const s = {};
before(async () => {
  srv = await startServer();
  api = srv.api;
  g = await guildWith(srv, ['alice', 'bob', 'carol']);
  ({ alice, bob, carol } = g.users);
  for (const u of [alice, bob, carol]) u.gw = await srv.gateway(u.token);
  // carol moderates: MODERATE_MEMBERS, VIEW_AUDIT_LOG, MANAGE_GUILD
  s.mod = (await api('POST', `/guilds/${g.guild.id}/roles`, alice.token, { name: 'Mod', permissions: bits(10, 11, 16, 40, 7, 5) })).body;
  await api('PATCH', `/guilds/${g.guild.id}/members/${carol.id}`, alice.token, { roles: [s.mod.id] });
});
after(() => srv.stop());

const send = (who, content, ch = g.general.id) => api('POST', `/channels/${ch}/messages`, who.token, { content });

test('timeouts: MODERATE_MEMBERS and rank; a timed-out member cannot send, react, start threads or join voice', async () => {
  const until = new Date(Date.now() + 60_000).toISOString();
  assert.equal((await api('PATCH', `/guilds/${g.guild.id}/members/${carol.id}`, bob.token, { communication_disabled_until: until })).status, 403);
  assert.equal((await api('PATCH', `/guilds/${g.guild.id}/members/${bob.id}`, carol.token, { communication_disabled_until: new Date(Date.now() + 29 * 86400e3).toISOString() })).status, 400);
  const m = (await send(alice, 'react to me')).body;
  const r = await api('PATCH', `/guilds/${g.guild.id}/members/${bob.id}`, carol.token, { communication_disabled_until: until }, { 'X-Audit-Log-Reason': encodeURIComponent('spam, again') });
  assert.equal(r.status, 200);
  assert.equal(r.body.communication_disabled_until, until);
  assert.equal((await alice.gw.event('GUILD_MEMBER_UPDATE', d => d.user.id === bob.id)).communication_disabled_until, until);
  const one = await api('GET', `/guilds/${g.guild.id}/members/${bob.id}`, alice.token);
  assert.deepEqual([one.status, one.body.user.id, one.body.communication_disabled_until], [200, bob.id, until], 'Get Guild Member');
  assert.equal((await api('GET', `/guilds/${g.guild.id}/members/1`, alice.token)).body.code, 10007);
  const role = (await api('POST', `/guilds/${g.guild.id}/roles`, alice.token, { name: 'Tagged' })).body;
  assert.equal((await api('PUT', `/guilds/${g.guild.id}/members/${bob.id}/roles/${role.id}`, alice.token)).status, 204, 'Add Guild Member Role');
  assert.ok((await api('GET', `/guilds/${g.guild.id}/members/${bob.id}`, alice.token)).body.roles.includes(role.id));
  assert.equal((await api('DELETE', `/guilds/${g.guild.id}/members/${bob.id}/roles/${role.id}`, alice.token)).status, 204, 'Remove Guild Member Role');
  assert.ok(!(await api('GET', `/guilds/${g.guild.id}/members/${bob.id}`, alice.token)).body.roles.includes(role.id));
  assert.equal((await api('PUT', `/guilds/${g.guild.id}/members/${alice.id}/roles/${role.id}`, bob.token)).status, 403, 'needs MANAGE_ROLES');
  assert.equal((await send(bob, 'hi')).status, 403);
  await api('PUT', `/channels/${g.general.id}/messages/${m.id}/reactions/%F0%9F%91%8D/@me`, alice.token);
  assert.equal((await api('PUT', `/channels/${g.general.id}/messages/${m.id}/reactions/%F0%9F%91%8D/@me`, bob.token)).status, 403);
  assert.equal((await api('POST', `/channels/${g.general.id}/messages/${m.id}/threads`, bob.token, { name: 't' })).status, 403);
  assert.equal((await api('GET', `/channels/${g.general.id}/messages`, bob.token)).status, 200, 'reading still works');
  // voice: no VOICE_SERVER_UPDATE at all for a timed-out member (others get one even without LiveKit)
  bob.gw.send({ op: 4, d: { guild_id: g.guild.id, channel_id: g.voice.id, self_mute: false, self_deaf: false } });
  assert.ok(await bob.gw.none(f => f.t === 'VOICE_SERVER_UPDATE', 400));
  alice.gw.send({ op: 4, d: { guild_id: g.guild.id, channel_id: g.voice.id, self_mute: false, self_deaf: false } });
  await alice.gw.event('VOICE_SERVER_UPDATE');
  // lifting it restores everything
  await api('PATCH', `/guilds/${g.guild.id}/members/${bob.id}`, carol.token, { communication_disabled_until: null });
  assert.equal((await send(bob, 'back')).status, 201);
});

test('audit log: entries with changes, reason and filters; VIEW_AUDIT_LOG', async () => {
  await api('PATCH', `/guilds/${g.guild.id}`, alice.token, { name: 'Renamed', afk_timeout: 900 });
  await api('POST', `/guilds/${g.guild.id}/channels`, alice.token, { name: 'audit-me' }, { 'X-Audit-Log-Reason': 'tidy' });
  assert.equal((await api('GET', `/guilds/${g.guild.id}/audit-logs`, bob.token)).status, 403);
  const log = (await api('GET', `/guilds/${g.guild.id}/audit-logs`, carol.token)).body;
  const timeout = log.audit_log_entries.find(e => e.action_type === 24 && e.target_id === bob.id && e.reason);
  assert.equal(timeout.reason, 'spam, again');
  assert.equal(timeout.user_id, carol.id);
  assert.deepEqual(timeout.changes.map(c => c.key), ['communication_disabled_until']);
  const update = log.audit_log_entries.find(e => e.action_type === 1);
  assert.deepEqual(update.changes.map(c => [c.key, c.old_value, c.new_value]), [['name', 'Test Guild', 'Renamed'], ['afk_timeout', 300, 900]]);
  assert.ok(log.users.some(u => u.id === bob.id));
  const created = (await api('GET', `/guilds/${g.guild.id}/audit-logs?action_type=10`, carol.token)).body.audit_log_entries;
  assert.deepEqual(created.map(e => [e.reason, e.changes.find(c => c.key === 'name').new_value]), [['tidy', 'audit-me']]);
  const mine = (await api('GET', `/guilds/${g.guild.id}/audit-logs?user_id=${carol.id}&limit=1`, carol.token)).body.audit_log_entries;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].user_id, carol.id);
  // role changes record $add
  await api('PATCH', `/guilds/${g.guild.id}/members/${bob.id}`, alice.token, { roles: [s.mod.id] });
  const roles = (await api('GET', `/guilds/${g.guild.id}/audit-logs?action_type=25`, carol.token)).body.audit_log_entries;
  assert.deepEqual(roles[0].changes, [{ key: '$add', new_value: [{ id: s.mod.id, name: 'Mod' }] }]);
  await api('PATCH', `/guilds/${g.guild.id}/members/${bob.id}`, alice.token, { roles: [] });
});

test('AutoMod: keyword wildcards and allow list block; alert, timeout and exemptions; mention spam', async () => {
  const alerts = (await api('POST', `/guilds/${g.guild.id}/channels`, alice.token, { name: 'mod-log' })).body;
  const rule = await api('POST', `/guilds/${g.guild.id}/auto-moderation/rules`, carol.token, {
    name: 'no cats', event_type: 1, trigger_type: 1, enabled: true,
    trigger_metadata: { keyword_filter: ['cat*', '*dog', 'bad word'], allow_list: ['category'] },
    actions: [{ type: 1, metadata: { custom_message: 'Keep it clean' } }, { type: 2, metadata: { channel_id: alerts.id } }],
  });
  assert.equal(rule.status, 200);
  assert.equal((await api('POST', `/guilds/${g.guild.id}/auto-moderation/rules`, carol.token, {
    name: 'bad trigger', trigger_type: 'toString', actions: [{ type: 1 }],
  })).status, 400);
  assert.equal((await carol.gw.event('AUTO_MODERATION_RULE_CREATE')).id, rule.body.id);
  assert.equal((await api('GET', `/guilds/${g.guild.id}/auto-moderation/rules`, bob.token)).status, 403);
  const blocked = await send(bob, 'my Catapult is broken');
  assert.deepEqual([blocked.status, blocked.body.code, blocked.body.message], [400, 200000, 'Keep it clean']);
  const exec = await carol.gw.event('AUTO_MODERATION_ACTION_EXECUTION', d => d.action.type === 1);
  assert.deepEqual([exec.user_id, exec.matched_keyword, exec.matched_content, exec.message_id], [bob.id, 'cat*', 'Cat', undefined]);
  const alert = await carol.gw.event('MESSAGE_CREATE', d => d.channel_id === alerts.id);
  assert.deepEqual([alert.type, alert.author.id, alert.embeds[0].type, alert.embeds[0].description], [24, bob.id, 'auto_moderation_message', 'my Catapult is broken']);
  for (const ok of ['concatenate', 'a category', 'dogma', 'bad words']) assert.equal((await send(bob, ok)).status, 201, ok);
  for (const no of ['hotdog', 'a bad word!', 'CAT']) assert.equal((await send(bob, no)).status, 400, no);
  assert.equal((await send(alice, 'the owner may say cat')).status, 201);
  // exempt roles skip the rule; edits are checked too
  await api('PATCH', `/guilds/${g.guild.id}/auto-moderation/rules/${rule.body.id}`, carol.token, { exempt_roles: [s.mod.id] });
  assert.equal((await send(carol, 'cats')).status, 201);
  const fine = (await send(bob, 'fine')).body;
  assert.equal((await api('PATCH', `/channels/${g.general.id}/messages/${fine.id}`, bob.token, { content: 'cat' })).body.code, 200000);

  const spam = await api('POST', `/guilds/${g.guild.id}/auto-moderation/rules`, carol.token, {
    name: 'mentions', event_type: 1, trigger_type: 5, enabled: true, trigger_metadata: { mention_total_limit: 2 },
    actions: [{ type: 3, metadata: { duration_seconds: 60 } }],
  });
  assert.equal(spam.status, 200);
  assert.equal((await send(bob, `<@${alice.id}> <@${carol.id}>`)).status, 201);
  assert.equal((await send(bob, `<@${alice.id}> <@${carol.id}> <@&${s.mod.id}>`)).status, 201, 'TIMEOUT alone does not block');
  const timed = await alice.gw.event('GUILD_MEMBER_UPDATE', d => d.user.id === bob.id && d.communication_disabled_until);
  assert.ok(Date.parse(timed.communication_disabled_until) > Date.now());
  assert.equal((await send(bob, 'muted')).status, 403);
  await api('PATCH', `/guilds/${g.guild.id}/members/${bob.id}`, carol.token, { communication_disabled_until: null });
  const log = (await api('GET', `/guilds/${g.guild.id}/audit-logs`, carol.token)).body.audit_log_entries.map(e => e.action_type);
  for (const t of [140, 141, 143, 144, 145]) assert.ok(log.includes(t), `audit ${t}`);
});

test('AutoMod regex guard: nested quantifiers and backreferences refused; runaway patterns hit the time budget', async () => {
  const mk = regex_patterns => api('POST', `/guilds/${g.guild.id}/auto-moderation/rules`, carol.token, {
    name: 'regex', event_type: 1, trigger_type: 1, enabled: true, trigger_metadata: { regex_patterns }, actions: [{ type: 1 }],
  });
  for (const bad of ['(a+)+$', '(x*)*y', '(\\w+\\s?)*$', '(a)\\1', '(?<=a)b', '(?!x)y', '[', 'x'.repeat(2049)]) {
    const r = await mk([bad]);
    assert.equal(r.status, 400, bad);
  }
  // alternation can still backtrack exponentially: the 50 ms budget stops it, treated as no match
  const r = await mk(['^(a|a)*$', 'b[0-9]{2}x']);
  assert.equal(r.status, 200);
  const t = Date.now();
  assert.equal((await send(bob, `${'a'.repeat(40)}!`)).status, 201);
  assert.ok(Date.now() - t < 2000);
  assert.equal((await send(bob, 'code B42x')).status, 400);
  await api('DELETE', `/guilds/${g.guild.id}/auto-moderation/rules/${r.body.id}`, carol.token);
});

test('AutoMod MEMBER_PROFILE: nicknames members set themselves are checked', async () => {
  const r = await api('POST', `/guilds/${g.guild.id}/auto-moderation/rules`, carol.token, {
    name: 'names', trigger_type: 6, enabled: true, trigger_metadata: { keyword_filter: ['admin*'] }, actions: [{ type: 1 }],
  });
  assert.deepEqual([r.status, r.body.event_type], [200, 2]);
  assert.equal((await api('PATCH', `/guilds/${g.guild.id}/members/@me`, bob.token, { nick: 'Administrator' })).body.code, 200000);
  assert.equal((await api('PATCH', `/guilds/${g.guild.id}/members/@me`, bob.token, { nick: 'Bobby' })).body.nick, 'Bobby');
  assert.equal((await api('POST', `/guilds/${g.guild.id}/auto-moderation/rules`, carol.token, {
    name: 'again', trigger_type: 6, trigger_metadata: {}, actions: [{ type: 1 }],
  })).status, 400, 'one MEMBER_PROFILE rule per guild');
  await api('DELETE', `/guilds/${g.guild.id}/auto-moderation/rules/${r.body.id}`, carol.token);
});

test('verification level LOW: accounts younger than 5 minutes cannot send unless they hold a role', async () => {
  assert.equal((await api('PATCH', `/guilds/${g.guild.id}`, alice.token, { verification_level: 3 })).status, 400);
  await api('PATCH', `/guilds/${g.guild.id}`, alice.token, { verification_level: 1 });
  const r = await send(bob, 'too new');
  assert.deepEqual([r.status, r.body.code], [403, 50009]);
  assert.equal((await send(carol, 'has a role')).status, 201);
  await api('PATCH', `/guilds/${g.guild.id}`, alice.token, { verification_level: 0 });
  assert.equal((await send(bob, 'ok now')).status, 201);
});

test('rules screening: new members join pending, can only read until they accept', async () => {
  assert.equal((await api('PATCH', `/guilds/${g.guild.id}/member-verification`, alice.token, { enabled: true })).status, 400);
  const v = await api('PATCH', `/guilds/${g.guild.id}/member-verification`, alice.token, {
    enabled: true, description: 'Our rules', form_fields: [{ field_type: 'TERMS', label: 'Read the rules', values: ['Be nice', 'No spam'] }],
  });
  assert.equal(v.status, 200);
  assert.ok((await api('GET', `/guilds/${g.guild.id}`, alice.token)).body.features.includes('MEMBER_VERIFICATION_GATE_ENABLED'));
  const dan = await srv.register('dan');
  const pre = await api('GET', `/guilds/${g.guild.id}/member-verification?invite_code=${g.invite.code}`, dan.token);
  assert.deepEqual(pre.body.form_fields[0].values, ['Be nice', 'No spam']);
  await api('POST', `/invites/${g.invite.code}`, dan.token);
  const member = (await api('GET', `/guilds/${g.guild.id}/members`, alice.token)).body.find(m => m.user.id === dan.id);
  assert.equal(member.pending, true);
  assert.equal((await api('GET', `/channels/${g.general.id}/messages`, dan.token)).status, 200);
  assert.equal((await send(dan, 'hello?')).status, 403);
  assert.equal((await api('PUT', `/guilds/${g.guild.id}/requests/@me`, dan.token, { form_fields: [] })).status, 400);
  const req = await api('PUT', `/guilds/${g.guild.id}/requests/@me`, dan.token, { version: v.body.version, form_fields: [{ field_type: 'TERMS', response: true }] });
  assert.equal(req.body.application_status, 'APPROVED');
  assert.equal((await alice.gw.event('GUILD_MEMBER_UPDATE', d => d.user.id === dan.id)).pending, false);
  assert.equal((await send(dan, 'hello!')).status, 201);
  await api('PATCH', `/guilds/${g.guild.id}/member-verification`, alice.token, { enabled: false });
});

test('welcome screen, vanity URL, guild features and settings', async () => {
  const ws = await api('PATCH', `/guilds/${g.guild.id}/welcome-screen`, alice.token, {
    enabled: true, description: 'Welcome!', welcome_channels: [{ channel_id: g.general.id, description: 'Say hi', emoji_name: '👋' }],
  });
  assert.deepEqual(ws.body, { description: 'Welcome!', welcome_channels: [{ channel_id: g.general.id, description: 'Say hi', emoji_id: null, emoji_name: '👋' }], background: null, accent_color: null });
  assert.equal((await api('GET', `/guilds/${g.guild.id}/welcome-screen`, bob.token)).body.description, 'Welcome!');
  assert.equal((await api('PATCH', `/guilds/${g.guild.id}/vanity-url`, bob.token, { code: 'cill' })).status, 403);
  assert.equal((await api('PATCH', `/guilds/${g.guild.id}/vanity-url`, alice.token, { code: 'No Caps' })).status, 400);
  assert.deepEqual((await api('PATCH', `/guilds/${g.guild.id}/vanity-url`, alice.token, { code: 'cill-org' })).body, { code: 'cill-org', uses: 0 });
  const inv = (await api('GET', '/invites/cill-org')).body;
  assert.deepEqual([inv.code, inv.guild.id, inv.guild.vanity_url_code, inv.guild.welcome_screen.description, inv.channel.id],
    ['cill-org', g.guild.id, 'cill-org', 'Welcome!', g.general.id]);
  assert.ok(inv.guild.features.includes('WELCOME_SCREEN_ENABLED'));
  const erin = await srv.register('erin');
  assert.equal((await api('POST', '/invites/cill-org', erin.token)).status, 200);
  assert.deepEqual((await api('GET', `/guilds/${g.guild.id}/vanity-url`, alice.token)).body, { code: 'cill-org', uses: 1 });
  const other = (await api('POST', '/guilds', erin.token, { name: 'Taken' })).body;
  assert.equal((await api('PATCH', `/guilds/${other.id}/vanity-url`, erin.token, { code: 'cill-org' })).body.code, 50020);

  const patched = await api('PATCH', `/guilds/${g.guild.id}`, alice.token, {
    afk_channel_id: g.voice.id, afk_timeout: 300, description: 'An org', rules_channel_id: g.general.id, features: ['COMMUNITY'],
  });
  assert.deepEqual([patched.body.afk_channel_id, patched.body.afk_timeout, patched.body.description, patched.body.rules_channel_id],
    [g.voice.id, 300, 'An org', g.general.id]);
  assert.ok(patched.body.features.includes('COMMUNITY'));
  assert.equal((await api('PATCH', `/guilds/${g.guild.id}`, alice.token, { afk_timeout: 42 })).status, 400);
  assert.equal((await api('PATCH', `/guilds/${g.guild.id}`, alice.token, { afk_channel_id: g.general.id })).status, 400);
  assert.equal((await api('PATCH', `/guilds/${g.guild.id}`, carol.token, { features: [] })).status, 403, 'COMMUNITY needs ADMINISTRATOR');
});
