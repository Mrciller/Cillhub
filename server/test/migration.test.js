import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { scryptSync } from 'node:crypto';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { startServer, tempDir } from './helpers.js';

test('a v1 database upgrades in place to v3', async () => {
  const dir = await tempDir();
  const file = join(dir, 'cillcord.sqlite');
  const v1 = new DatabaseSync(file);
  v1.exec(readFileSync(new URL('./fixtures/v1-schema.sql', import.meta.url), 'utf8'));
  const hash = scryptSync('hunter2hunter2', 'salt', 64).toString('hex');
  v1.exec(`
    INSERT INTO users (id, email, username, global_name, password_hash, salt) VALUES ('100', 'old@example.com', 'oldtimer', NULL, '${hash}', 'salt');
    INSERT INTO guilds (id, name, owner_id) VALUES ('200', 'Old Guild', '100');
    INSERT INTO members (guild_id, user_id, joined_at) VALUES ('200', '100', '2026-01-01T00:00:00.000Z');
    INSERT INTO channels (id, type, guild_id, name, position, last_message_id) VALUES ('300', 0, '200', 'general', 0, '400'), ('301', 0, '200', 'random', 1, NULL);
    INSERT INTO messages (id, channel_id, author_id, content, timestamp) VALUES ('400', '300', '100', 'from v1', '2026-01-01T00:00:00.000Z');
    INSERT INTO invites (code, guild_id, channel_id, inviter_id, uses, expires_at) VALUES ('OLDCODE1', '200', '300', '100', 3, NULL);`);
  assert.equal(v1.prepare('PRAGMA user_version').get().user_version, 0);
  v1.close();

  const srv = await startServer({ dataDir: dir });
  try {
    const { token } = (await srv.api('POST', '/auth/login', null, { login: 'oldtimer', password: 'hunter2hunter2' })).body;
    const guild = (await srv.api('GET', '/guilds/200', token)).body;
    assert.deepEqual(guild.roles, [{ id: '200', name: '@everyone', color: 0, hoist: false, position: 0, permissions: '673423025360449', mentionable: false, managed: false, colors: { primary_color: 0, secondary_color: null, tertiary_color: null }, icon: null, unicode_emoji: null }]); // v3 migration adds its default bits
    assert.equal(guild.system_channel_id, '300');
    assert.equal(guild.icon, null);
    assert.deepEqual(guild.channels.map(c => [c.id, c.parent_id, c.permission_overwrites.length]), [['300', null, 0], ['301', null, 0]]);
    const [msg] = (await srv.api('GET', '/channels/300/messages', token)).body;
    assert.deepEqual([msg.content, msg.type, msg.mention_roles, msg.mention_everyone, msg.pinned], ['from v1', 0, [], false, false]);
    assert.equal((await srv.api('POST', '/channels/300/messages', token, { content: 'from v2' })).status, 201);
    const invite = (await srv.api('GET', '/invites/OLDCODE1')).body;
    assert.deepEqual([invite.uses, invite.max_uses, invite.max_age, invite.expires_at], [3, 0, 0, null]);
    assert.ok(invite.created_at);
    const gw = await srv.gateway(token);
    assert.equal(gw.ready.user_settings.status, 'online'); // v4: the full settings document
    assert.equal(gw.ready.user.avatar, null);
  } finally {
    await srv.stop(true);
  }
  const db = new DatabaseSync(file);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 19); // v4 … v13 and later migrations ran too
  db.close();
  // a second start on the upgraded database changes nothing
  const again = await startServer({ dataDir: dir });
  const { token } = (await again.api('POST', '/auth/login', null, { login: 'oldtimer', password: 'hunter2hunter2' })).body;
  assert.equal((await again.api('GET', '/guilds/200/roles', token)).body.length, 1);
  await again.stop();
});

test('a v2 database upgrades in place to v3: new default bits, searchable history, v3 features work', async () => {
  const dir = await tempDir();
  const file = join(dir, 'cillcord.sqlite');
  const v2 = new DatabaseSync(file);
  v2.exec(readFileSync(new URL('./fixtures/v2-schema.sql', import.meta.url), 'utf8'));
  const hash = scryptSync('hunter2hunter2', 'salt', 64).toString('hex');
  v2.exec(`
    INSERT INTO users (id, email, username, password_hash, salt) VALUES ('100', 'old@example.com', 'oldtimer', '${hash}', 'salt');
    INSERT INTO guilds (id, name, owner_id, system_channel_id) VALUES ('200', 'Old Guild', '100', '300');
    INSERT INTO roles (id, guild_id, name, position, permissions) VALUES ('200', '200', '@everyone', 0, '70356545'), ('201', '200', 'Admin', 1, '8');
    INSERT INTO members (guild_id, user_id, joined_at) VALUES ('200', '100', '2026-01-01T00:00:00.000Z');
    INSERT INTO channels (id, type, guild_id, name, position, last_message_id) VALUES ('300', 0, '200', 'general', 0, '400'), ('301', 2, '200', 'Voice', 1, NULL);
    INSERT INTO messages (id, channel_id, author_id, content, timestamp) VALUES ('400', '300', '100', 'history from version two', '2026-01-01T00:00:00.000Z');`);
  assert.equal(v2.prepare('PRAGMA user_version').get().user_version, 2);
  v2.close();

  const srv = await startServer({ dataDir: dir });
  try {
    const { token } = (await srv.api('POST', '/auth/login', null, { login: 'oldtimer', password: 'hunter2hunter2' })).body;
    const guild = (await srv.api('GET', '/guilds/200', token)).body;
    assert.deepEqual(guild.roles.map(r => [r.id, r.permissions]), [['200', '673423025360449'], ['201', '8']]);
    assert.deepEqual([guild.afk_timeout, guild.verification_level, guild.emojis, guild.stickers], [300, 0, [], []]);
    const general = guild.channels.find(c => c.id === '300');
    assert.deepEqual([general.nsfw, general.rate_limit_per_user, general.flags], [false, 0, 0]);
    const found = (await srv.api('GET', '/guilds/200/messages/search?content=version', token)).body;
    assert.deepEqual(found.messages.map(([m]) => [m.id, m.flags, m.embeds]), [['400', 0, []]]);
    const t = await srv.api('POST', '/channels/300/messages/400/threads', token, { name: 'old thread' });
    assert.equal(t.status, 201);
    assert.equal((await srv.api('POST', `/channels/${t.body.id}/messages`, token, { content: 'v3 reply' })).status, 201);
    const gw = await srv.gateway(token);
    assert.deepEqual(gw.ready.guilds[0].threads.map(x => x.id), ['400']);
  } finally {
    await srv.stop(true);
  }
  const db = new DatabaseSync(file);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 19); // v4 … v13 and later migrations ran too
  db.close();
  const again = await startServer({ dataDir: dir });
  const { token } = (await again.api('POST', '/auth/login', null, { login: 'oldtimer', password: 'hunter2hunter2' })).body;
  assert.equal((await again.api('GET', '/guilds/200/roles', token)).body[0].permissions, '673423025360449');
  await again.stop();
});

test('a v3 database upgrades in place to v4: profiles, settings, bots and commands work on old data', async () => {
  const dir = await tempDir();
  const file = join(dir, 'cillcord.sqlite');
  const v3 = new DatabaseSync(file);
  v3.exec(readFileSync(new URL('./fixtures/v3-schema.sql', import.meta.url), 'utf8'));
  const hash = scryptSync('hunter2hunter2', 'salt', 64).toString('hex');
  v3.exec(`
    INSERT INTO users (id, email, username, password_hash, salt, status) VALUES ('100', 'old@example.com', 'oldtimer', '${hash}', 'salt', 'dnd'),
      ('101', 'pal@example.com', 'pal', '${hash}', 'salt', 'online');
    INSERT INTO tokens (token_hash, user_id) VALUES ('${'a'.repeat(64)}', '100');
    INSERT INTO relationships (user_id, other_id, type) VALUES ('100', '101', 1), ('101', '100', 1);
    INSERT INTO guilds (id, name, owner_id, system_channel_id) VALUES ('200', 'Old Guild', '100', '300');
    INSERT INTO roles (id, guild_id, name, position, permissions) VALUES ('200', '200', '@everyone', 0, '673423025360449');
    INSERT INTO members (guild_id, user_id, joined_at) VALUES ('200', '100', '2026-01-01T00:00:00.000Z');
    INSERT INTO channels (id, type, guild_id, name, position) VALUES ('300', 0, '200', 'general', 0);
    INSERT INTO messages (id, channel_id, author_id, content, timestamp) VALUES ('400', '300', '100', 'from v3', '2026-01-01T00:00:00.000Z');`);
  assert.equal(v3.prepare('PRAGMA user_version').get().user_version, 3);
  v3.close();

  const srv = await startServer({ dataDir: dir });
  try {
    const { token } = (await srv.api('POST', '/auth/login', null, { login: 'oldtimer', password: 'hunter2hunter2' })).body;
    const me = (await srv.api('GET', '/users/@me', token)).body;
    assert.deepEqual([me.bio, me.mfa_enabled, me.banner], ['', false, null]);
    assert.equal((await srv.api('GET', '/users/@me/settings', token)).body.status, 'dnd');
    assert.equal((await srv.api('GET', '/auth/sessions', token)).body.user_sessions.length, 2);
    const [msg] = (await srv.api('GET', '/channels/300/messages', token)).body;
    assert.deepEqual([msg.content, msg.components], ['from v3', []]);
    assert.equal((await srv.api('GET', '/users/101/profile', token)).body.mutual_friends_count, 0);
    const app = (await srv.api('POST', '/applications', token, { name: 'Upgraded' })).body;
    assert.equal((await srv.api('POST', `/oauth2/authorize?client_id=${app.id}&scope=bot`, token, { authorize: true, guild_id: '200' })).status, 200);
    const cmd = await srv.api('POST', `/applications/${app.id}/guilds/200/commands`, `Bot ${app.bot.token}`, { name: 'hello', description: 'Hi' });
    assert.equal(cmd.status, 201);
    const group = await srv.api('POST', '/users/@me/channels', token, { recipients: ['101', '100'] });
    assert.equal(group.body.type, 3);
  } finally {
    await srv.stop(true);
  }
  const db = new DatabaseSync(file);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 19);
  db.close();
  await rm(dir, { recursive: true, force: true });
});

test('a v4 database upgrades in place to v5: built-in bot, scheduled messages, saved messages and templates work on old data', async () => {
  const dir = await tempDir();
  const file = join(dir, 'cillcord.sqlite');
  const v4 = new DatabaseSync(file);
  v4.exec(readFileSync(new URL('./fixtures/v4-schema.sql', import.meta.url), 'utf8'));
  const hash = scryptSync('hunter2hunter2', 'salt', 64).toString('hex');
  v4.exec(`
    INSERT INTO users (id, email, username, password_hash, salt) VALUES ('100', 'old@example.com', 'oldtimer', '${hash}', 'salt'),
      ('101', 'c@example.com', 'cillhub', '${hash}', 'salt');
    INSERT INTO guilds (id, name, owner_id, system_channel_id) VALUES ('200', 'Old Guild', '100', '300');
    INSERT INTO roles (id, guild_id, name, position, permissions) VALUES ('200', '200', '@everyone', 0, '673423025360449');
    INSERT INTO members (guild_id, user_id, joined_at) VALUES ('200', '100', '2026-01-01T00:00:00.000Z');
    INSERT INTO channels (id, type, guild_id, name, position) VALUES ('300', 0, '200', 'general', 0);
    INSERT INTO messages (id, channel_id, author_id, content, timestamp) VALUES ('400', '300', '100', 'from v4', '2026-01-01T00:00:00.000Z');`);
  assert.equal(v4.prepare('PRAGMA user_version').get().user_version, 4);
  v4.close();

  const srv = await startServer({ dataDir: dir });
  try {
    const { token } = (await srv.api('POST', '/auth/login', null, { login: 'oldtimer', password: 'hunter2hunter2' })).body;
    const bot = (await srv.api('PUT', '/guilds/200/cillcord-bot', token)).body;
    assert.equal(bot.installed, true);
    const botUser = (await srv.api('GET', `/users/${bot.application_id}`, token)).body;
    assert.deepEqual([botUser.bot, botUser.global_name, botUser.username !== 'cillhub'], [true, 'Cillhub', true]); // the name was taken
    const names = (await srv.api('GET', '/guilds/200/application-command-index', token)).body.application_commands.map(c => c.name).sort();
    assert.deepEqual(names, ['coinflip', 'giveaway', 'lfg', 'remind', 'reminders', 'roll', 'scrim']);
    const later = await srv.api('POST', '/channels/300/scheduled-messages', token, { content: 'later', send_at: new Date(Date.now() + 3600e3).toISOString() });
    assert.equal(later.status, 201);
    assert.equal((await srv.api('PUT', '/users/@me/saved-messages/300/400', token, {})).body.save_data.message_id, '400');
    assert.equal((await srv.api('POST', '/guilds/200/templates', token, { name: 'Old' })).status, 201);
  } finally {
    await srv.stop(true);
  }
  const db = new DatabaseSync(file);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 19);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM applications WHERE builtin = 1').get().n, 1);
  db.close();
  // a second start keeps the one built-in app and its commands
  const again = await startServer({ dataDir: dir });
  await again.stop(true);
  const db2 = new DatabaseSync(file);
  assert.deepEqual([db2.prepare('SELECT COUNT(*) AS n FROM applications WHERE builtin = 1').get().n, db2.prepare('SELECT COUNT(*) AS n FROM application_commands').get().n], [1, 7]);
  db2.close();
  await rm(dir, { recursive: true, force: true });
});

test('a v5 database upgrades in place to v6: admin flag, customization and reports work on old data', async () => {
  const dir = await tempDir();
  const file = join(dir, 'cillcord.sqlite');
  const v5 = new DatabaseSync(file);
  v5.exec(readFileSync(new URL('./fixtures/v5-schema.sql', import.meta.url), 'utf8'));
  const hash = scryptSync('hunter2hunter2', 'salt', 64).toString('hex');
  v5.exec(`
    INSERT INTO users (id, email, username, password_hash, salt) VALUES ('100', 'old@example.com', 'oldtimer', '${hash}', 'salt'),
      ('101', 'b@example.com', 'buddy', '${hash}', 'salt');
    INSERT INTO guilds (id, name, owner_id, system_channel_id) VALUES ('200', 'Old Guild', '100', '300');
    INSERT INTO roles (id, guild_id, name, position, permissions, color) VALUES ('200', '200', '@everyone', 0, '673423025360449', 0), ('201', '200', 'Red', 1, '0', 16711680);
    INSERT INTO members (guild_id, user_id, joined_at) VALUES ('200', '100', '2026-01-01T00:00:00.000Z'), ('200', '101', '2026-01-01T00:00:00.000Z');
    INSERT INTO channels (id, type, guild_id, name, position) VALUES ('300', 0, '200', 'general', 0), ('301', 2, '200', 'Voice', 1);
    INSERT INTO messages (id, channel_id, author_id, content, timestamp) VALUES ('400', '300', '101', 'from v5', '2026-01-01T00:00:00.000Z');`);
  assert.equal(v5.prepare('PRAGMA user_version').get().user_version, 5);
  v5.close();

  const srv = await startServer({ dataDir: dir });
  try {
    const { token } = (await srv.api('POST', '/auth/login', null, { login: 'oldtimer', password: 'hunter2hunter2' })).body;
    const me = (await srv.api('GET', '/users/@me', token)).body;
    assert.deepEqual([me.instance_admin, me.display_name_styles, me.avatar_decoration_data, me.primary_guild, me.widgets], [false, null, null, null, []]);
    const guild = (await srv.api('GET', '/guilds/200', token)).body;
    assert.deepEqual(guild.roles.find(r => r.id === '201').colors, { primary_color: 16711680, secondary_color: null, tertiary_color: null });
    assert.deepEqual([guild.splash, guild.banner, guild.profile, guild.entrance_sounds_enabled, guild.greeting_templates], [null, null, null, true, []]);
    assert.deepEqual(guild.channels.find(c => c.id === '300').icon_emoji, null);
    assert.equal((await srv.api('PATCH', '/guilds/200/profile', token, { tag: 'OLD' })).body.tag, 'OLD');
    assert.equal((await srv.api('PATCH', '/users/@me', token, { display_name_font_id: 12, display_name_effect_id: 1, display_name_colors: [255] })).status, 200);
    assert.equal((await srv.api('POST', '/channels/300/messages/400/report', token, { reason: 'spam' })).status, 201);
    assert.equal((await srv.api('GET', '/instance')).body.registration_mode, 'open');
  } finally {
    await srv.stop(true);
  }
  const db = new DatabaseSync(file);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 19);
  assert.deepEqual([db.prepare('SELECT COUNT(*) AS n FROM reports').get().n, db.prepare("SELECT instance_admin FROM users WHERE id = '100'").get().instance_admin], [1, 0]);
  db.close();
  const again = await startServer({ dataDir: dir });
  assert.equal((await again.api('GET', '/guilds/200/profile', (await again.api('POST', '/auth/login', null, { login: 'oldtimer', password: 'hunter2hunter2' })).body.token)).body.tag, 'OLD');
  await again.stop();
});

test('a v6 database upgrades in place to v7: linked-account columns, directory and federation tables, old data intact', async () => {
  const dir = await tempDir();
  const file = join(dir, 'cillcord.sqlite');
  const v6 = new DatabaseSync(file);
  v6.exec(readFileSync(new URL('./fixtures/v6-schema.sql', import.meta.url), 'utf8'));
  const hash = scryptSync('hunter2hunter2', 'salt', 64).toString('hex');
  v6.exec(`
    INSERT INTO users (id, email, username, password_hash, salt, instance_admin) VALUES ('100', 'old@example.com', 'oldtimer', '${hash}', 'salt', 1);
    INSERT INTO guilds (id, name, owner_id, system_channel_id) VALUES ('200', 'Old Guild', '100', '300');
    INSERT INTO roles (id, guild_id, name, position, permissions) VALUES ('200', '200', '@everyone', 0, '673423025360449');
    INSERT INTO members (guild_id, user_id, joined_at) VALUES ('200', '100', '2026-01-01T00:00:00.000Z');
    INSERT INTO channels (id, type, guild_id, name, position) VALUES ('300', 0, '200', 'general', 0);
    INSERT INTO messages (id, channel_id, author_id, content, timestamp) VALUES ('400', '300', '100', 'from v6', '2026-01-01T00:00:00.000Z');
    INSERT INTO instance_settings (key, value) VALUES ('instance_name', '"Old Name"');`);
  assert.equal(v6.prepare('PRAGMA user_version').get().user_version, 6);
  v6.close();

  const srv = await startServer({ dataDir: dir });
  try {
    const { token } = (await srv.api('POST', '/auth/login', null, { login: 'oldtimer', password: 'hunter2hunter2' })).body;
    assert.equal((await srv.api('GET', '/channels/300/messages', token)).body[0].content, 'from v6');
    assert.deepEqual((await srv.api('GET', '/server/version')).body, { version: 'dev', role: 'node', mode: 'standalone', contract: 7, setup_required: false });
    assert.equal((await srv.api('GET', '/instance')).body.name, 'Old Name');
  } finally {
    await srv.stop(true);
  }
  const db = new DatabaseSync(file);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 19);
  assert.deepEqual({ ...db.prepare("SELECT home, hub_user_id, instance_admin FROM users WHERE id = '100'").get() }, { home: null, hub_user_id: null, instance_admin: 1 });
  for (const t of ['fed_link_codes', 'fed_nodes', 'fed_node_accounts', 'directory_entries', 'directory_reports']) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0);
  db.close();
  const again = await startServer({ dataDir: dir });
  assert.equal((await again.api('POST', '/auth/login', null, { login: 'oldtimer', password: 'hunter2hunter2' })).status, 200);
  await again.stop();
});

test('a v7 database upgrades to v8: built-in names become Cillhub, a taken username stays', async () => {
  const dir = await tempDir();
  const file = join(dir, 'cillcord.sqlite');
  const v7 = new DatabaseSync(file);
  // 001-007 never change, so replaying them gives the frozen v7 schema
  for (const m of ['001-v1', '002-v2', '003-v3', '004-v4', '005-v5', '006-v6', '007-v7']) v7.exec(readFileSync(new URL(`../src/migrations/${m}.sql`, import.meta.url), 'utf8'));
  const hash = scryptSync('hunter2hunter2', 'salt', 64).toString('hex');
  v7.exec(`
    PRAGMA user_version = 7;
    INSERT INTO users (id, email, username, global_name, password_hash, salt) VALUES ('100', 'old@example.com', 'oldtimer', NULL, '${hash}', 'salt'),
      ('101', 'h@example.com', 'CillHub', 'Hub Fan', '${hash}', 'salt');
    INSERT INTO users (id, email, username, global_name, password_hash, salt, bot) VALUES ('102', 'bot-102@bots.invalid', 'cillcord', 'Cillcord', 'x', 'x', 1);
    INSERT INTO users (id, email, username, global_name, password_hash, salt, system) VALUES ('103', 'system-103@users.invalid', 'cillcord-system', 'Cillcord System', 'x', 'x', 1);
    INSERT INTO applications (id, owner_id, name, description, public_key, private_key, builtin) VALUES ('102', '102', 'Cillcord', 'Built-in commands', 'k', 'k', 1);
    INSERT INTO instance_settings (key, value) VALUES ('instance_name', '"Cillcord"'), ('system_user_id', '"103"');`);
  v7.close();

  const srv = await startServer({ dataDir: dir });
  try {
    assert.equal((await srv.api('GET', '/instance')).body.name, 'Cillhub');
  } finally {
    await srv.stop(true);
  }
  const db = new DatabaseSync(file);
  const user = id => ({ ...db.prepare('SELECT username, global_name FROM users WHERE id = ?').get(id) });
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 19);
  assert.deepEqual(user('101'), { username: 'CillHub', global_name: 'Hub Fan' }); // the owner of the name keeps it
  assert.deepEqual(user('102'), { username: 'cillcord', global_name: 'Cillhub' }); // so the bot keeps its old username
  assert.deepEqual(user('103'), { username: 'cillhub-system', global_name: 'Cillhub System' });
  assert.deepEqual(db.prepare('SELECT id, name FROM applications WHERE builtin = 1').all().map(a => [a.id, a.name]), [['102', 'Cillhub']]);
  db.close();
  await rm(dir, { recursive: true, force: true });
});

test('a v9 database upgrades to v10: module tables and the users.module flag, old data intact', async () => {
  const dir = await tempDir();
  const file = join(dir, 'cillcord.sqlite');
  const v9 = new DatabaseSync(file);
  v9.exec(readFileSync(new URL('./fixtures/v9-schema.sql', import.meta.url), 'utf8'));
  const hash = scryptSync('hunter2hunter2', 'salt', 64).toString('hex');
  v9.exec(`
    PRAGMA user_version = 9;
    INSERT INTO users (id, email, username, password_hash, salt) VALUES ('100', 'old@example.com', 'oldtimer', '${hash}', 'salt');
    INSERT INTO guilds (id, name, owner_id, system_channel_id) VALUES ('200', 'Old Guild', '100', '300');
    INSERT INTO roles (id, guild_id, name, position, permissions) VALUES ('200', '200', '@everyone', 0, '673423025360449');
    INSERT INTO members (guild_id, user_id, joined_at) VALUES ('200', '100', '2026-01-01T00:00:00.000Z');
    INSERT INTO channels (id, type, guild_id, name, position) VALUES ('300', 0, '200', 'general', 0);
    INSERT INTO messages (id, channel_id, author_id, content, timestamp) VALUES ('400', '300', '100', 'from v9', '2026-01-01T00:00:00.000Z');`);
  v9.close();

  const srv = await startServer({ dataDir: dir });
  try {
    const { token } = (await srv.api('POST', '/auth/login', null, { login: 'oldtimer', password: 'hunter2hunter2' })).body;
    const [msg] = (await srv.api('GET', '/channels/300/messages', token)).body;
    assert.deepEqual([msg.content, msg.author.module, msg.module_accessory], ['from v9', undefined, undefined]);
    assert.equal((await srv.api('GET', '/admin/modules', token)).status, 403);
  } finally {
    await srv.stop(true);
  }
  const db = new DatabaseSync(file);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 19);
  assert.equal(db.prepare("SELECT module FROM users WHERE id = '100'").get().module, 0);
  for (const t of ['modules', 'module_settings', 'module_storage', 'module_logs', 'module_schedules', 'module_message_panels']) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0);
  db.close();
  await rm(dir, { recursive: true, force: true });
});

test('a v10 database upgrades to v11: message_ttl, quality_mode, canvas, onboarding, analytics tables and columns, old data intact', async () => {
  const dir = await tempDir();
  const file = join(dir, 'cillcord.sqlite');
  const v10 = new DatabaseSync(file);
  v10.exec(readFileSync(new URL('./fixtures/v10-schema.sql', import.meta.url), 'utf8'));
  const hash = scryptSync('hunter2hunter2', 'salt', 64).toString('hex');
  v10.exec(`
    PRAGMA user_version = 10;
    INSERT INTO users (id, email, username, password_hash, salt) VALUES ('100', 'old@example.com', 'oldtimer', '${hash}', 'salt');
    INSERT INTO guilds (id, name, owner_id, system_channel_id) VALUES ('200', 'Old Guild', '100', '300');
    INSERT INTO roles (id, guild_id, name, position, permissions) VALUES ('200', '200', '@everyone', 0, '673423025360449');
    INSERT INTO members (guild_id, user_id, joined_at) VALUES ('200', '100', '2026-01-01T00:00:00.000Z');
    INSERT INTO channels (id, type, guild_id, name, position) VALUES ('300', 0, '200', 'general', 0), ('301', 2, '200', 'voice', 1);
    INSERT INTO messages (id, channel_id, author_id, content, timestamp) VALUES ('400', '300', '100', 'from v10', '2026-01-01T00:00:00.000Z');`);
  v10.close();

  const srv = await startServer({ dataDir: dir });
  try {
    const { token } = (await srv.api('POST', '/auth/login', null, { login: 'oldtimer', password: 'hunter2hunter2' })).body;
    const ch = (await srv.api('GET', '/channels/300', token)).body;
    assert.equal(ch.message_ttl, 0);
    const vch = (await srv.api('GET', '/channels/301', token)).body;
    assert.equal(vch.quality_mode, 'speech');
  } finally {
    await srv.stop(true);
  }
  const db = new DatabaseSync(file);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 19);
  for (const t of ['channel_canvas', 'guild_onboarding', 'guild_analytics_daily', 'webauthn_credentials', 'user_e2ee_keys', 'soundboard_packs', 'recurring_messages', 'channel_whiteboard', 'message_edits', 'guild_snippets', 'dm_requests', 'guild_server_guide', 'saved_message_folders', 'user_connections']) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0);
  assert.equal(db.prepare("SELECT e2ee_envelope FROM messages WHERE id = '400'").get().e2ee_envelope, null);
  assert.equal(db.prepare("SELECT anti_raid FROM guilds WHERE id = '200'").get().anti_raid, null);
  assert.equal(db.prepare("SELECT calendar_token FROM users WHERE id = '100'").get().calendar_token, null);
  assert.equal(db.prepare("SELECT solved_message_id FROM channels WHERE id = '300'").get().solved_message_id, null);
  assert.equal(db.prepare("SELECT vanity_code FROM guilds WHERE id = '200'").get().vanity_code, null);
  db.close();
  await rm(dir, { recursive: true, force: true });
});
