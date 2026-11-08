// v5: the built-in Cillhub Bot through the real interaction pipeline, and its timers across a restart
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { startServer, guildWith, until } from './helpers.js';
import { parseWhen, drawWinners, roll } from '../src/botutil.js';

let srv, api, g, alice, bob, carol, botId, cmds;

before(async () => {
  srv = await startServer();
  api = srv.api;
  g = await guildWith(srv, ['alice', 'bob', 'carol']);
  ({ alice, bob, carol } = g.users);
  for (const u of [alice, bob]) u.gw = await srv.gateway(u.token);
});
after(() => srv.stop());

const connect = async () => {
  for (const u of [alice, bob]) u.gw = await srv.gateway(u.token);
};

async function run(who, name, options = []) {
  const cmd = cmds.find(c => c.name === name);
  const r = await api('POST', '/interactions', who.token, {
    type: 2, application_id: botId, guild_id: g.guild.id, channel_id: g.general.id, nonce: name, data: { id: cmd.id, name, type: 1, options },
  });
  assert.equal(r.status, 204, JSON.stringify(r.body));
  await who.gw.event('INTERACTION_SUCCESS', d => d.nonce === name);
  return who.gw.event('MESSAGE_CREATE', d => d.author.id === botId && d.interaction_metadata?.name === name);
}
async function click(who, message, custom_id, extra = {}) {
  const r = await api('POST', '/interactions', who.token, {
    type: 3, application_id: botId, guild_id: g.guild.id, channel_id: g.general.id, message_id: message.id, nonce: custom_id,
    data: { component_type: extra.values ? 3 : 2, custom_id, ...extra },
  });
  assert.equal(r.status, 204, JSON.stringify(r.body));
  await who.gw.event('INTERACTION_SUCCESS', d => d.nonce === custom_id);
}
const cardUpdate = (u, id, pred = () => true) => u.gw.event('MESSAGE_UPDATE', d => d.id === id && pred(d));

test('install: MANAGE_GUILD adds the bot from Integrations; its slash commands appear in the command index', async () => {
  assert.equal((await api('PUT', `/guilds/${g.guild.id}/cillcord-bot`, bob.token)).status, 403);
  const state = (await api('GET', `/guilds/${g.guild.id}/cillcord-bot`, bob.token)).body;
  assert.equal(state.installed, false);
  botId = state.application_id;
  const added = await api('PUT', `/guilds/${g.guild.id}/cillcord-bot`, alice.token);
  assert.deepEqual(added.body, { application_id: botId, installed: true });
  const member = await bob.gw.event('GUILD_MEMBER_ADD', d => d.user.id === botId);
  assert.deepEqual([member.user.bot, member.user.global_name], [true, 'Cillhub']);
  // it runs in the server process, so it shows online without a gateway session
  const fresh = await srv.gateway(bob.token);
  assert.equal(fresh.ready.presences.find(p => p.user.id === botId)?.status, 'online');
  const index = (await api('GET', `/channels/${g.general.id}/application-command-index`, bob.token)).body;
  cmds = index.application_commands;
  assert.deepEqual(cmds.map(c => c.name).sort(), ['coinflip', 'giveaway', 'lfg', 'remind', 'reminders', 'roll', 'scrim']);
  assert.equal(index.applications[0].name, 'Cillhub');
  // nobody can manage or impersonate it: it has no owner but itself and no token
  assert.equal((await api('GET', `/applications/${botId}`, alice.token)).status, 403);
});

test('/roll and /coinflip answer in the channel', async () => {
  const m = await run(bob, 'roll', [{ name: 'dice', type: 3, value: '2d6+3' }]);
  const [, a, b, total] = /^🎲 \*\*2d6\+3\*\*: (\d) \+ (\d) \+ 3 = \*\*(\d+)\*\*$/.exec(m.content);
  assert.equal(Number(a) + Number(b) + 3, Number(total));
  assert.equal(m.type, 20);
  assert.match((await run(bob, 'roll')).content, /^🎲 \*\*1d100\*\*: \d+ = \*\*\d+\*\*$/);
  const bad = await run(bob, 'roll', [{ name: 'dice', type: 3, value: '0d0' }]);
  assert.equal(bad.flags & 64, 64); // ephemeral hint
  assert.match((await run(bob, 'coinflip')).content, /Heads|Tails/);
});

test('/remind and /reminders: list and cancel through the select menu', async () => {
  const r = await run(bob, 'remind', [{ name: 'when', type: 3, value: '2h' }, { name: 'what', type: 3, value: 'stretch' }]);
  assert.equal(r.flags & 64, 64);
  assert.match(r.content, /remind you <t:\d+:R>/);
  assert.match((await run(bob, 'remind', [{ name: 'when', type: 3, value: 'whenever' }, { name: 'what', type: 3, value: 'x' }])).content, /could not read/);
  const list = await run(bob, 'reminders');
  assert.match(list.content, /1\. <t:\d+:f>: stretch/);
  const select = list.components[0].components[0];
  await click(bob, list, 'reminders:cancel', { values: [select.options[0].value] });
  assert.equal((await cardUpdate(bob, list.id)).content, 'You have no open reminders.');
});

test('/giveaway: enter, managers end early and reroll, the draw only picks entrants', async () => {
  const card = await run(alice, 'giveaway', [{ name: 'prize', type: 3, value: 'Mousepad' }, { name: 'duration', type: 3, value: '1h' }]);
  assert.equal(card.embeds[0].title, '🎉 Mousepad');
  await click(bob, card, 'giveaway:enter');
  assert.equal((await cardUpdate(alice, card.id)).embeds[0].fields[0].value, '1');
  assert.match((await bob.gw.event('MESSAGE_CREATE', d => d.flags & 64)).content, /entered/);
  await click(bob, card, 'giveaway:end'); // not the host, no MANAGE_GUILD
  assert.match((await bob.gw.event('MESSAGE_CREATE', d => d.flags & 64)).content, /Only the host/);
  await click(alice, card, 'giveaway:end');
  const ended = await cardUpdate(alice, card.id, d => d.components[0].components[0].disabled);
  assert.match(ended.embeds[0].description, new RegExp(`Winner: <@${bob.id}>`));
  const endedAt = Number(/^Ended <t:(\d+):R>/.exec(ended.embeds[0].description)?.[1]);
  assert.ok(Math.abs(endedAt * 1000 - Date.now()) < 10_000, 'ended early: the card shows the real end time, not the planned one');
  const won = await alice.gw.event('MESSAGE_CREATE', d => d.author.id === botId && d.content.startsWith('🎉 Congratulations'));
  assert.deepEqual([won.content.includes(`<@${bob.id}>`), won.message_reference.message_id], [true, card.id]);
  // a reroll excludes the previous winner: nobody left
  await click(alice, card, 'giveaway:reroll');
  assert.match((await alice.gw.event('MESSAGE_CREATE', d => d.author.id === botId && d.content.startsWith('No valid entries'))).content, /reroll/);
});

test('/scrim: roster buttons, a matching scheduled event; /lfg opens a group DM when full', async () => {
  const card = await run(alice, 'scrim', [{ name: 'opponent', type: 3, value: 'Team X' }, { name: 'when', type: 3, value: '3h' }, { name: 'slots', type: 4, value: 1 }]);
  const event = await bob.gw.event('GUILD_SCHEDULED_EVENT_CREATE');
  assert.deepEqual([event.name, event.entity_type, event.creator_id, event.entity_metadata.location], ['Scrim vs Team X', 3, alice.id, '#general']);
  await click(bob, card, 'scrim:join');
  assert.equal((await cardUpdate(alice, card.id)).embeds[0].fields[0].value, `<@${bob.id}>`);
  await click(alice, card, 'scrim:join'); // one slot: full
  assert.match((await alice.gw.event('MESSAGE_CREATE', d => d.flags & 64)).content, /roster is full/);
  await click(alice, card, 'scrim:bench');
  assert.deepEqual((await cardUpdate(alice, card.id)).embeds[0].fields.map(f => f.value), [`<@${bob.id}>`, `<@${alice.id}>`]);
  await click(bob, card, 'scrim:leave');
  assert.deepEqual((await cardUpdate(alice, card.id)).embeds[0].fields.map(f => [f.name, f.value]), [['Roster (0/1)', '—'], ['Bench', `<@${alice.id}>`]]);

  const lfg = await run(alice, 'lfg', [{ name: 'game', type: 3, value: 'CS2' }, { name: 'players', type: 4, value: 2 }]);
  await cardUpdate(alice, lfg.id, d => d.embeds[0].fields[0].name === 'Players (1/2)');
  await click(bob, lfg, 'lfg:join');
  const group = await bob.gw.event('CHANNEL_CREATE', d => d.type === 3);
  assert.deepEqual([group.name, group.owner_id, group.recipients.map(u => u.id)], ['CS2 LFG', alice.id, [alice.id]]);
  assert.equal((await cardUpdate(alice, lfg.id, d => d.components[0].components[0].disabled)).components[0].components[0].label, 'Full');
});

test('timers survive a restart: /remind DMs, giveaways end, scrims ping, message reminders fire', async () => {
  await run(bob, 'remind', [{ name: 'when', type: 3, value: '1d' }, { name: 'what', type: 3, value: 'buy snacks' }]);
  const give = await run(alice, 'giveaway', [{ name: 'prize', type: 3, value: 'Headset' }, { name: 'duration', type: 3, value: '2d' }]);
  await click(bob, give, 'giveaway:enter');
  const scrim = await run(alice, 'scrim', [{ name: 'opponent', type: 3, value: 'Team Y' }, { name: 'when', type: 3, value: '5h' }]);
  await click(bob, scrim, 'scrim:join');
  const msg = (await api('POST', `/channels/${g.general.id}/messages`, alice.token, { content: 'remember me' })).body;
  const saved = await api('PUT', `/users/@me/saved-messages/${g.general.id}/${msg.id}`, alice.token, { due_at: new Date(Date.now() + 86400e3).toISOString() });
  assert.equal(saved.body.save_data.due_at.slice(0, 10), new Date(Date.now() + 86400e3).toISOString().slice(0, 10));
  await srv.stop(true);

  // while the server is down, everything falls due (the reminder only a moment after the next start)
  const db = new DatabaseSync(join(srv.dataDir, 'cillcord.sqlite'));
  db.prepare('UPDATE bot_reminders SET remind_at = ?').run(Date.now() - 1000);
  db.prepare('UPDATE bot_cards SET due_at = ? WHERE due_at IS NOT NULL').run(Date.now() - 1000);
  db.prepare('UPDATE saved_messages SET due_at = ?').run(Date.now() + 2500);
  db.close();
  srv = await startServer({ dataDir: srv.dataDir });
  api = srv.api;
  await connect();
  const due = await alice.gw.event('MESSAGE_REMINDER_DUE');
  assert.deepEqual([due.message.content, due.save_data.message_id], ['remember me', msg.id]);

  const dm = await until(async () => (await api('GET', '/users/@me/channels', bob.token)).body.find(c => c.type === 1 && c.recipients[0].id === botId));
  const [reminder] = (await api('GET', `/channels/${dm.id}/messages`, bob.token)).body;
  assert.equal(reminder.content, `⏰ Reminder (from <#${g.general.id}>): buy snacks`);
  const history = (await api('GET', `/channels/${g.general.id}/messages?limit=10`, alice.token)).body;
  assert.ok(history.some(m => m.content === `🎉 Congratulations <@${bob.id}>! You won **Headset**.` && m.message_reference.message_id === give.id));
  assert.ok(history.some(m => m.content.startsWith('⏰ Scrim vs **Team Y** starts') && m.content.includes(`<@${bob.id}>`)));
  const card = history.find(m => m.id === give.id);
  assert.equal(card.components[0].components[0].disabled, true);
  // nothing fires twice after another restart
  await srv.stop(true);
  srv = await startServer({ dataDir: srv.dataDir });
  api = srv.api;
  await connect();
  const after = (await api('GET', `/channels/${g.general.id}/messages?limit=10`, alice.token)).body;
  assert.equal(after.filter(m => m.content.includes('**Headset**')).length, 1);
});

test('the winner draw is uniform and without repeats; time phrases and dice parse', () => {
  const counts = new Map();
  for (let i = 0; i < 20000; i++) for (const w of drawWinners(['a', 'b', 'c', 'd'], 2)) counts.set(w, (counts.get(w) ?? 0) + 1);
  for (const n of counts.values()) assert.ok(Math.abs(n - 10000) < 400, `each entrant wins about half the draws, got ${n}`);
  for (let i = 0; i < 200; i++) assert.equal(new Set(drawWinners([1, 2, 3, 4, 5], 3)).size, 3);
  assert.deepEqual(drawWinners([1, 2], 5).sort(), [1, 2]);
  assert.deepEqual(drawWinners([], 1), []);

  const now = Date.UTC(2026, 10, 3, 21, 0); // 22:00 in Berlin (CET)
  assert.equal(parseWhen('10m', now), now + 600e3);
  assert.equal(parseWhen('1h 30m', now), now + 5400e3);
  assert.equal(new Date(parseWhen('tomorrow 18:00', now)).toISOString(), '2026-11-04T17:00:00.000Z');
  assert.equal(new Date(parseWhen('18:00', now)).toISOString(), '2026-11-04T17:00:00.000Z'); // already past today
  assert.equal(new Date(parseWhen('2027-07-01 18:00', now)).toISOString(), '2027-07-01T16:00:00.000Z'); // summer time
  for (const bad of ['', 'soon', '25:00', '0m', '2026-01-01 10:00', '600d']) assert.equal(parseWhen(bad, now), null, bad);
  assert.equal(roll('d1'), null);
  assert.equal(roll('101d6'), null);
  assert.equal(roll('3d1000').rolls.length, 3);
});
