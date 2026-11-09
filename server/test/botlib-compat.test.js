// Acceptance: an unmodified bot built on a real bot library (v14) against Cillhub. Needs the library installed outside the repo:
//   D=$(mktemp -d) && (cd $D && npm i <the v14 bot library>) && BOTLIB=$D/node_modules/<its package> node --test test/botlib-compat.test.js
// Without it the test is skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startServer } from './helpers.js';

const require = createRequire(import.meta.url);
let botlib = null;
try { botlib = process.env.BOTLIB && require(process.env.BOTLIB); } catch { /* not installed */ }
const skip = botlib ? false : 'bot library not installed; set BOTLIB to its package directory (see the comment above)';

const once = (emitter, event, pred = () => true, ms = 10_000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { emitter.off(event, on); reject(new Error(`timed out waiting for ${event}`)); }, ms);
  function on(...args) { if (pred(...args)) { clearTimeout(timer); emitter.off(event, on); resolve(args[0]); } }
  emitter.on(event, on);
});

test('bot library v14: login, OAuth2 install, /ping with a button, component update, MESSAGE_CONTENT', { skip, timeout: 60_000 }, async () => {
  const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, Events } = botlib;
  const srv = await startServer();
  const clients = [];
  try {
    const alice = await srv.register('alice');
    const guild = (await srv.api('POST', '/guilds', alice.token, { name: 'Bot Test' })).body;
    const general = guild.channels.find(c => c.name === 'general');
    const app = (await srv.api('POST', '/applications', alice.token, { name: 'PingBot' })).body;
    assert.ok(app.bot.token, 'bot token shown once on creation');

    // 1. OAuth2 install with a managed role
    const q = `client_id=${app.id}&scope=bot%20applications.commands&permissions=2048`;
    const preview = await srv.api('GET', `/oauth2/authorize?${q}`, alice.token);
    assert.deepEqual(preview.body.guilds.map(g => g.id), [guild.id]);
    const auth = await srv.api('POST', `/oauth2/authorize?${q}`, alice.token, { authorize: true, guild_id: guild.id, permissions: '2048' });
    assert.equal(auth.status, 200);
    const roles = (await srv.api('GET', `/guilds/${guild.id}/roles`, alice.token)).body;
    assert.deepEqual(roles.filter(r => r.managed).map(r => [r.name, r.tags.bot_id, r.permissions]), [['PingBot', app.id, '2048']]);

    const user = await srv.gateway(alice.token);
    const start = async intents => {
      const client = new Client({ intents, rest: { api: `${srv.origin}/api` } });
      clients.push(client);
      const ready = once(client, Events.ClientReady);
      await client.login(app.bot.token);
      await ready;
      return client;
    };

    // 2. login reaches ready with the installed guild from GUILD_CREATE
    const bot = await start([GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]);
    assert.equal(bot.user.id, app.id);
    assert.equal(bot.application.id, app.id);
    assert.ok(bot.guilds.cache.get(guild.id)?.available, 'guild available after GUILD_CREATE');

    // 3. guild slash command
    const cmd = await bot.guilds.cache.get(guild.id).commands.create({ name: 'ping', description: 'Replies with pong' });
    assert.equal(cmd.name, 'ping');

    bot.on(Events.InteractionCreate, async i => {
      if (i.isChatInputCommand() && i.commandName === 'ping') {
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('again').setLabel('Again').setStyle(ButtonStyle.Primary));
        await i.reply({ content: 'Pong!', components: [row] });
      } else if (i.isButton() && i.customId === 'again') {
        await i.update({ content: `Clicked by ${i.user.username}`, components: [] });
      }
    });

    // 4. the user runs /ping, the bot answers with a button
    const index = (await srv.api('GET', `/channels/${general.id}/application-command-index`, alice.token)).body;
    const ping = index.application_commands.find(c => c.name === 'ping');
    assert.ok(ping);
    const run = await srv.api('POST', '/interactions', alice.token, {
      type: 2, application_id: app.id, guild_id: guild.id, channel_id: general.id, session_id: user.ready.session_id, nonce: 'n1',
      data: { id: ping.id, name: 'ping', type: 1, version: ping.version },
    });
    assert.equal(run.status, 204);
    const reply = await user.event('MESSAGE_CREATE', m => m.content === 'Pong!', 5000);
    assert.equal(reply.author.id, app.id);
    assert.equal(reply.components[0].components[0].custom_id, 'again');
    assert.equal(reply.interaction_metadata.user.id, alice.id);
    await user.event('INTERACTION_SUCCESS', d => d.nonce === 'n1');

    // 5. the user clicks the button, the bot updates the message
    const click = await srv.api('POST', '/interactions', alice.token, {
      type: 3, application_id: app.id, guild_id: guild.id, channel_id: general.id, message_id: reply.id, data: { component_type: 2, custom_id: 'again' },
    });
    assert.equal(click.status, 204);
    const updated = await user.event('MESSAGE_UPDATE', m => m.id === reply.id, 5000);
    assert.deepEqual([updated.content, updated.components], ['Clicked by alice', []]);

    // 6. messageCreate without MESSAGE_CONTENT: content empty
    const got = once(bot, Events.MessageCreate, m => m.author.id === alice.id);
    await srv.api('POST', `/channels/${general.id}/messages`, alice.token, { content: 'secret words' });
    assert.equal((await got).content, '');
    await bot.destroy();

    // 7. enabling the privileged intent on the application, a new login gets the content
    await srv.api('PATCH', `/applications/${app.id}`, alice.token, { flags: 1 << 19 });
    const bot2 = await start([GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]);
    const got2 = once(bot2, Events.MessageCreate, m => m.author.id === alice.id);
    await srv.api('POST', `/channels/${general.id}/messages`, alice.token, { content: 'hello bot' });
    assert.equal((await got2).content, 'hello bot');
  } finally {
    for (const c of clients) await c.destroy().catch(() => {});
    await srv.stop();
  }
});

test('bot library v14: ATTACHMENT option read with getAttachment, files in reply, followUp and editReply', { skip, timeout: 60_000 }, async () => {
  const { Client, GatewayIntentBits, Events, AttachmentBuilder, MessageFlags } = botlib;
  const srv = await startServer();
  let client;
  try {
    const alice = await srv.register('alice');
    const guild = (await srv.api('POST', '/guilds', alice.token, { name: 'Files' })).body;
    const general = guild.channels.find(c => c.name === 'general');
    const app = (await srv.api('POST', '/applications', alice.token, { name: 'FileBot' })).body;
    await srv.api('POST', `/oauth2/authorize?client_id=${app.id}&scope=bot`, alice.token, { authorize: true, guild_id: guild.id, permissions: '0' });
    const user = await srv.gateway(alice.token);
    client = new Client({ intents: [GatewayIntentBits.Guilds], rest: { api: `${srv.origin}/api` } });
    const ready = once(client, Events.ClientReady);
    await client.login(app.bot.token);
    await ready;
    await client.guilds.cache.get(guild.id).commands.set([{ name: 'echo', description: 'Echo a file', options: [{ type: 11, name: 'file', description: 'Any file', required: true }] }]);
    const seen = [];
    let finished;
    const done = new Promise(r => { finished = r; });
    client.on(Events.InteractionCreate, async i => {
      const a = i.options.getAttachment('file');
      const bytes = Buffer.from(await (await fetch(srv.origin + a.url)).arrayBuffer());
      seen.push({ name: a.name, size: a.size, contentType: a.contentType, bytes: bytes.toString() });
      await i.reply({ content: `echo of ${a.name}`, files: [new AttachmentBuilder(bytes, { name: `echo-${a.name}`, description: 'copy' })] });
      await i.followUp({ content: 'just for you', files: [new AttachmentBuilder(Buffer.from('psst'), { name: 'psst.txt' })], flags: MessageFlags.Ephemeral });
      await i.editReply({ content: 'edited with a second file', files: [new AttachmentBuilder(Buffer.from('two'), { name: 'two.txt' })] });
      finished();
    });
    const echo = (await srv.api('GET', `/channels/${general.id}/application-command-index`, alice.token)).body.application_commands.find(c => c.name === 'echo');
    const r = await srv.form('POST', '/interactions', alice.token, {
      type: 2, application_id: app.id, guild_id: guild.id, channel_id: general.id, nonce: 'f1', session_id: user.ready.session_id,
      data: { id: echo.id, name: 'echo', type: 1, version: echo.version, options: [{ type: 11, name: 'file', value: 0 }], attachments: [{ id: '0', filename: 'notes.txt' }] },
    }, [['files[0]', 'notes.txt', 'hello file', 'text/plain']]);
    assert.equal(r.status, 204);
    const reply = await user.event('MESSAGE_CREATE', m => m.content === 'echo of notes.txt', 5000);
    assert.deepEqual(seen, [{ name: 'notes.txt', size: 10, contentType: 'text/plain', bytes: 'hello file' }]);
    assert.deepEqual(reply.attachments.map(a => [a.filename, a.description]), [['echo-notes.txt', 'copy']]);
    assert.equal(await (await fetch(srv.origin + reply.attachments[0].url)).text(), 'hello file');
    const eph = await user.event('MESSAGE_CREATE', m => m.content === 'just for you', 5000);
    assert.equal(eph.flags & 64, 64);
    assert.equal(await (await fetch(srv.origin + eph.attachments[0].url)).text(), 'psst');
    const edited = await user.event('MESSAGE_UPDATE', m => m.id === reply.id && m.content === 'edited with a second file', 5000);
    assert.deepEqual(edited.attachments.map(a => a.filename), ['two.txt']); // the library lists only the new file: the old one is dropped
    await done; // every REST call of the bot got its answer
  } finally {
    await client?.destroy().catch(() => {});
    await srv.stop();
  }
});
