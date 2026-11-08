// The Cillhub Bot (v5): a first-party application on the v4 bot platform that runs inside this process. Its interactions
// arrive through the normal pipeline (POST /interactions -> startInteraction) and it answers through respond(); no token
// is ever issued for it. Timers (reminders, giveaway ends, scrim pings) are read from the database.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { snowflake } from '../snowflake.js';
import { get, all, run, tx, json, isMember, memberIds, userById } from '../db.js';
import { HttpError } from '../errors.js';
import { P, has, guildPerms } from '../permissions.js';
import { sendToUsers, inProcessBots } from '../gateway.js';
import { localApps, recordForCallback, respond } from '../interactions.js';
import { insertMessage, broadcastMessage, bumpMentions, getChannel } from '../message.js';
import { addJob, schedule } from '../timers.js';
import { parseWhen, roll, drawWinners } from '../botutil.js';
import { validateCommand } from './commands.js';
import { authorize } from './applications.js';
import { loadGuild, removeMember } from './guilds.js';
import { openDm } from './channels.js';
import { insertGroup } from './groups.js';
import { eventObj } from './events.js';

const MAX_REMINDERS = 25;
const SCRIM_PING = 15 * 60 * 1000;
const BOT_PERMS = P.VIEW_CHANNEL | P.SEND_MESSAGES | P.EMBED_LINKS | P.READ_MESSAGE_HISTORY | P.USE_EXTERNAL_EMOJIS;

// --- the application row and its commands, created or refreshed on every start ---------------------------------------
function ensureApp() {
  const found = get('SELECT * FROM applications WHERE builtin = 1');
  if (found) return found;
  const id = snowflake();
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  let username = 'cillhub';
  while (get('SELECT 1 FROM users WHERE username = ?', username)) username = `cillhub_${randomBytes(2).toString('hex')}`;
  tx(() => {
    run('INSERT INTO users (id, email, username, global_name, password_hash, salt, bot) VALUES (?, ?, ?, ?, ?, ?, 1)',
      id, `bot-${id}@bots.invalid`, username, 'Cillhub', randomBytes(32).toString('hex'), randomBytes(16).toString('hex'));
    run(`INSERT INTO applications (id, owner_id, name, description, public_key, private_key, builtin) VALUES (?, ?, 'Cillhub', ?, ?, ?, 1)`,
      id, id, 'Built-in commands: dice, reminders, giveaways, scrims and LFG.',
      Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
  });
  return get('SELECT * FROM applications WHERE id = ?', id);
}
const APP = ensureApp();
const BOT = APP.id;
inProcessBots.add(BOT);

const str = (name, description, extra = {}) => ({ type: 3, name, description, ...extra });
const int = (name, description, extra = {}) => ({ type: 4, name, description, ...extra });
const COMMANDS = [
  { name: 'roll', description: 'Roll dice, e.g. 2d6 or 1d20+3 (default 1d100)', options: [str('dice', 'Dice like 2d6 or 1d20+3', { max_length: 20 })] },
  { name: 'coinflip', description: 'Flip a coin' },
  { name: 'remind', description: 'Get a DM from me later', options: [
    str('when', '10m, 2h, 1d, tomorrow 18:00 or 2026-12-24 18:00', { required: true, max_length: 40 }),
    str('what', 'What to remind you of', { required: true, max_length: 1000 })] },
  { name: 'reminders', description: 'List and cancel your reminders' },
  { name: 'giveaway', description: 'Start a giveaway with an Enter button', options: [
    str('prize', 'What can be won', { required: true, max_length: 200 }), str('duration', 'How long, e.g. 30m, 1h, 2d', { required: true, max_length: 40 }),
    int('winners', 'Number of winners (1-10)', { min_value: 1, max_value: 10 })] },
  { name: 'scrim', description: 'Post a scrim with a live roster', options: [
    str('opponent', 'Who you play against', { required: true, max_length: 90 }), str('when', 'e.g. 20:00, tomorrow 19:30, 2h', { required: true, max_length: 40 }),
    int('slots', 'Roster size (default 5)', { min_value: 1, max_value: 10 })] },
  { name: 'lfg', description: 'Looking for group: a group DM opens once full', options: [
    str('game', 'Which game', { required: true, max_length: 90 }), int('players', 'Group size including you (2-10)', { required: true, min_value: 2, max_value: 10 }),
    str('note', 'Anything else', { max_length: 300 })] },
].map(c => validateCommand({ ...c, contexts: [0] }, true));

tx(() => {
  for (const c of all('SELECT id, name FROM application_commands WHERE application_id = ?', BOT)) {
    if (!COMMANDS.some(d => d.name === c.name)) run('DELETE FROM application_commands WHERE id = ?', c.id);
  }
  for (const d of COMMANDS) {
    const cur = get('SELECT * FROM application_commands WHERE application_id = ? AND guild_id IS NULL AND type = 1 AND name = ?', BOT, d.name);
    if (!cur) { const id = snowflake(); run('INSERT INTO application_commands (id, application_id, guild_id, type, name, data, version) VALUES (?, ?, NULL, 1, ?, ?, ?)', id, BOT, d.name, JSON.stringify(d), id); }
    else if (cur.data !== JSON.stringify(d)) run('UPDATE application_commands SET data = ?, version = ? WHERE id = ?', JSON.stringify(d), snowflake(), cur.id);
  }
});

// --- messages the bot posts on its own (outside an interaction response) ---------------------------------------------
const NO_ROLES = { all: false, here: false, roleIds: [] };
function post(ch, content, replyTo) {
  const m = insertMessage({ ch, authorId: BOT, content, referenceId: replyTo, type: replyTo ? 19 : 0 });
  bumpMentions(ch, m, NO_ROLES);
  broadcastMessage(ch, 'MESSAGE_CREATE', m);
  return m;
}

const ts = (ms, style) => `<t:${Math.floor(ms / 1000)}:${style}>`;
const mention = ids => ids.map(id => `<@${id}>`).join(', ');
const eph = content => ({ type: 4, data: { content, flags: 64 } });
const option = (i, name) => i.data.options?.find(o => o.name === name)?.value;

// --- cards: giveaway, scrim, lfg ---------------------------------------------------------------------------------------
const card = id => get('SELECT * FROM bot_cards WHERE message_id = ?', id);
const members = (id, slot) => all(`SELECT user_id FROM bot_card_members WHERE message_id = ? ${slot ? 'AND slot = ?' : ''} ORDER BY joined_at, rowid`, id, ...(slot ? [slot] : [])).map(r => r.user_id);
const button = (custom_id, label, style, disabled = false) => ({ type: 2, custom_id, label, style, disabled });
const roster = ids => (ids.length ? ids.map(id => `<@${id}>`).join('\n') : '—');

// the message fields of a card from its stored state
function cardView(c, d = json(c.data)) {
  const id = c.message_id;
  if (c.kind === 'giveaway') {
    const entries = members(id).length;
    const winners = d.winner_ids ?? [];
    return {
      content: '',
      embeds: [{
        title: `🎉 ${d.prize}`, color: 0xf1c40f,
        description: d.ended
          ? `Ended ${ts(d.ends_at, 'R')}\n${winners.length ? `Winner${winners.length > 1 ? 's' : ''}: ${mention(winners)}` : 'No valid entries.'}\nHosted by <@${c.host_id}>`
          : `Ends ${ts(d.ends_at, 'R')} (${ts(d.ends_at, 'f')})\nWinners: ${d.winners}\nHosted by <@${c.host_id}>`,
        fields: [{ name: 'Entries', value: String(entries), inline: true }],
      }],
      components: [{ type: 1, components: [
        button('giveaway:enter', 'Enter', 1, !!d.ended), button('giveaway:end', 'End now', 4, !!d.ended), button('giveaway:reroll', 'Reroll', 2, !d.ended),
      ] }],
    };
  }
  if (c.kind === 'scrim') {
    const main = members(id, 'main');
    return {
      content: '',
      embeds: [{
        title: `⚔️ Scrim vs ${d.opponent}`, color: 0xe74c3c, description: `${ts(d.starts_at, 'F')} (${ts(d.starts_at, 'R')})\nHosted by <@${c.host_id}>`,
        fields: [{ name: `Roster (${main.length}/${d.slots})`, value: roster(main), inline: true }, { name: 'Bench', value: roster(members(id, 'bench')), inline: true }],
      }],
      components: [{ type: 1, components: [button('scrim:join', 'Join', 3), button('scrim:bench', 'Bench', 2), button('scrim:leave', 'Leave', 4)] }],
    };
  }
  const joined = members(id);
  const full = !!d.group_id;
  return {
    content: '',
    embeds: [{
      title: `🎮 LFG: ${d.game}`, color: 0x5865f2,
      description: `${d.note ? `${d.note}\n` : ''}Hosted by <@${c.host_id}>${full ? '\nThe group is full: a group DM was opened.' : ''}`,
      fields: [{ name: `Players (${joined.length}/${d.players})`, value: roster(joined) }],
    }],
    components: [{ type: 1, components: [button('lfg:join', full ? 'Full' : 'Join', 1, full)] }],
  };
}

// re-renders a card in place (its interaction token may be long gone)
function refresh(id) {
  const c = card(id);
  if (!c) return;
  const v = cardView(c);
  run('UPDATE messages SET content = ?, embeds = ?, components = ? WHERE id = ?', v.content, JSON.stringify(v.embeds), JSON.stringify(v.components), id);
  const ch = getChannel(c.channel_id);
  if (ch) broadcastMessage(ch, 'MESSAGE_UPDATE', get('SELECT * FROM messages WHERE id = ?', id));
}

function saveCard(id, i, kind, data, dueAt) {
  run('INSERT INTO bot_cards (message_id, kind, guild_id, channel_id, host_id, data, due_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id, kind, i.guild_id, i.channel_id, i.member.user.id, JSON.stringify(data), dueAt);
  schedule();
}
const setData = (id, d, dueAt) => run('UPDATE bot_cards SET data = ?, due_at = ? WHERE message_id = ?', JSON.stringify(d), dueAt, id);

// fair draw among entrants who are still members; a reroll draws again without the previous winners
function endGiveaway(c, reroll = false) {
  const d = json(c.data);
  const previous = d.winner_ids ?? [];
  const pool = members(c.message_id).filter(id => isMember(c.guild_id, id) && !(reroll && previous.includes(id)));
  if (!reroll) d.ends_at = Math.min(d.ends_at, Date.now()); // ended early: the card says when it really ended
  d.winner_ids = drawWinners(pool, d.winners);
  d.ended = true;
  setData(c.message_id, d, null);
  refresh(c.message_id);
  const ch = getChannel(c.channel_id);
  if (ch) post(ch, d.winner_ids.length ? `🎉 Congratulations ${mention(d.winner_ids)}! You won **${d.prize}**.` : `No valid entries for **${d.prize}**${reroll ? ' (reroll)' : ''}.`, c.message_id);
}

function pingScrim(c) {
  const d = json(c.data);
  setData(c.message_id, d, null);
  const ids = [...members(c.message_id, 'main'), ...members(c.message_id, 'bench')].filter(id => isMember(c.guild_id, id));
  const ch = getChannel(c.channel_id);
  if (ch && ids.length) post(ch, `⏰ Scrim vs **${d.opponent}** starts ${ts(d.starts_at, 'R')}: ${ids.map(id => `<@${id}>`).join(' ')}`, c.message_id);
}

// --- commands ----------------------------------------------------------------------------------------------------------
const isManager = (i, c) => c.host_id === i.member.user.id || has(BigInt(i.member.permissions), P.MANAGE_GUILD);

function remindersView(userId) {
  const rows = all('SELECT * FROM bot_reminders WHERE user_id = ? ORDER BY remind_at', userId);
  if (!rows.length) return { content: 'You have no open reminders.', components: [] };
  return {
    content: rows.map((r, n) => `${n + 1}. ${ts(r.remind_at, 'f')}: ${r.content.slice(0, 150)}`).join('\n').slice(0, 2000),
    components: [{ type: 1, components: [{
      type: 3, custom_id: 'reminders:cancel', placeholder: 'Cancel reminders…', min_values: 1, max_values: rows.length,
      options: rows.map((r, n) => ({ label: `${n + 1}. ${r.content}`.slice(0, 100), value: r.id, description: new Date(r.remind_at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' })),
    }] }],
  };
}

const commands = {
  roll(i) {
    const spec = option(i, 'dice') ?? '1d100';
    const r = roll(spec);
    if (!r) return eph('Use dice like `2d6`, `d20` or `1d100+5` (1-100 dice, 2-1000 sides).');
    const shown = r.rolls.length > 20 ? `${r.rolls.slice(0, 20).join(' + ')} + …` : r.rolls.join(' + ');
    const mod = r.mod ? ` ${r.mod > 0 ? '+' : '−'} ${Math.abs(r.mod)}` : '';
    return { type: 4, data: { content: `🎲 **${spec.replace(/\s+/g, '')}**: ${shown}${mod} = **${r.total}**` } };
  },
  coinflip: () => ({ type: 4, data: { content: `🪙 **${roll('1d2').total === 1 ? 'Heads' : 'Tails'}**` } }),
  remind(i) {
    const at = parseWhen(option(i, 'when'));
    if (!at) return eph('I could not read that time. Try `10m`, `2h`, `1d`, `tomorrow 18:00` or `2026-12-24 18:00`.');
    const userId = i.member.user.id;
    if (get('SELECT COUNT(*) AS n FROM bot_reminders WHERE user_id = ?', userId).n >= MAX_REMINDERS) return eph(`You already have ${MAX_REMINDERS} open reminders. Cancel some with /reminders.`);
    run('INSERT INTO bot_reminders (id, user_id, channel_id, guild_id, content, remind_at) VALUES (?, ?, ?, ?, ?, ?)',
      snowflake(), userId, i.channel_id, i.guild_id, option(i, 'what'), at);
    schedule();
    return eph(`⏰ I'll remind you ${ts(at, 'R')} (${ts(at, 'f')}) by DM.`);
  },
  reminders: i => ({ type: 4, data: { ...remindersView(i.member.user.id), flags: 64 } }),
  giveaway(i) {
    const endsAt = parseWhen(option(i, 'duration'));
    if (!endsAt) return eph('I could not read that duration. Try `30m`, `1h` or `2d`.');
    const d = { prize: option(i, 'prize'), winners: option(i, 'winners') ?? 1, ends_at: endsAt, ended: false };
    return [{ type: 4, data: cardView({ kind: 'giveaway', message_id: '0', host_id: i.member.user.id }, d) }, id => saveCard(id, i, 'giveaway', d, endsAt)];
  },
  scrim(i) {
    const startsAt = parseWhen(option(i, 'when'));
    if (!startsAt) return eph('I could not read that time. Try `20:00`, `tomorrow 19:30` or `2h`.');
    const d = { opponent: option(i, 'opponent'), starts_at: startsAt, slots: option(i, 'slots') ?? 5, event_id: null };
    const perms = BigInt(i.member.permissions);
    return [{ type: 4, data: cardView({ kind: 'scrim', message_id: '0', host_id: i.member.user.id }, d) }, id => {
      // the matching scheduled event, if the invoker may create events
      if (has(perms, P.CREATE_EVENTS) || has(perms, P.MANAGE_EVENTS)) {
        d.event_id = snowflake();
        const ch = getChannel(i.channel_id);
        run(`INSERT INTO scheduled_events (id, guild_id, channel_id, creator_id, name, description, scheduled_start_time, scheduled_end_time,
             privacy_level, status, entity_type, entity_metadata) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 2, 1, 3, ?)`,
        d.event_id, i.guild_id, i.member.user.id, `Scrim vs ${d.opponent}`, `Roster in #${ch?.name ?? 'channel'}`,
        new Date(startsAt).toISOString(), new Date(startsAt + 2 * 3600 * 1000).toISOString(), JSON.stringify({ location: `#${ch?.name ?? 'channel'}`.slice(0, 100) }));
        sendToUsers(memberIds(i.guild_id), 'GUILD_SCHEDULED_EVENT_CREATE', eventObj(get('SELECT * FROM scheduled_events WHERE id = ?', d.event_id)));
      }
      saveCard(id, i, 'scrim', d, Math.max(Date.now(), startsAt - SCRIM_PING));
    }];
  },
  lfg(i) {
    const d = { game: option(i, 'game'), players: option(i, 'players'), note: option(i, 'note') ?? null, group_id: null };
    const host = i.member.user.id;
    return [{ type: 4, data: cardView({ kind: 'lfg', message_id: '0', host_id: host }, d) }, id => {
      saveCard(id, i, 'lfg', d, null);
      run('INSERT INTO bot_card_members (message_id, user_id, joined_at) VALUES (?, ?, ?)', id, host, Date.now());
      refresh(id);
    }];
  },
};

// --- components on the bot's messages ----------------------------------------------------------------------------------
const join = (id, userId, slot = '') => run(`INSERT INTO bot_card_members (message_id, user_id, slot, joined_at) VALUES (?, ?, ?, ?)
  ON CONFLICT DO UPDATE SET slot = excluded.slot, joined_at = CASE WHEN slot = excluded.slot THEN joined_at ELSE excluded.joined_at END`, id, userId, slot, Date.now());
const ACK = { type: 6 }; // the card is re-rendered directly

const components = {
  'reminders:cancel'(i) {
    const userId = i.member.user.id;
    for (const id of i.data.values) run('DELETE FROM bot_reminders WHERE id = ? AND user_id = ?', id, userId);
    return { type: 7, data: remindersView(userId) };
  },
  'giveaway:enter'(i, c) {
    const userId = i.member.user.id;
    const left = run('DELETE FROM bot_card_members WHERE message_id = ? AND user_id = ?', c.message_id, userId).changes;
    if (!left) join(c.message_id, userId);
    refresh(c.message_id);
    return eph(left ? 'You left the giveaway.' : '🎉 You entered the giveaway. Click again to leave.');
  },
  'giveaway:end'(i, c) {
    if (!isManager(i, c)) return eph('Only the host or members with Manage Server can end a giveaway.');
    endGiveaway(c);
    return ACK;
  },
  'giveaway:reroll'(i, c) {
    if (!isManager(i, c)) return eph('Only the host or members with Manage Server can reroll.');
    endGiveaway(c, true);
    return ACK;
  },
  'scrim:join'(i, c) {
    const userId = i.member.user.id;
    const main = members(c.message_id, 'main');
    if (!main.includes(userId) && main.length >= json(c.data).slots) return eph('The roster is full. Use Bench to sign up as a sub.');
    join(c.message_id, userId, 'main');
    refresh(c.message_id);
    return ACK;
  },
  'scrim:bench'(i, c) {
    join(c.message_id, i.member.user.id, 'bench');
    refresh(c.message_id);
    return ACK;
  },
  'scrim:leave'(i, c) {
    run('DELETE FROM bot_card_members WHERE message_id = ? AND user_id = ?', c.message_id, i.member.user.id);
    refresh(c.message_id);
    return ACK;
  },
  'lfg:join'(i, c) {
    const userId = i.member.user.id;
    const d = json(c.data);
    const ids = members(c.message_id);
    if (ids.includes(userId)) return eph('You are already in this group.');
    if (d.group_id || ids.length >= d.players) return eph('This group is full.');
    join(c.message_id, userId);
    if (ids.length + 1 === d.players) {
      const all_ = [...ids, userId].filter(id => isMember(c.guild_id, id));
      d.group_id = insertGroup(userById(c.host_id), all_.filter(id => id !== c.host_id), undefined, `${d.game} LFG`.slice(0, 100)).id;
      setData(c.message_id, d, null);
    }
    refresh(c.message_id);
    return ACK;
  },
};

function route(i) {
  if (i.type === 2) return commands[i.data.name]?.(i) ?? eph('Unknown command.');
  if (i.type === 3) {
    const handler = components[i.data.custom_id];
    if (i.data.custom_id === 'reminders:cancel') return handler(i);
    const c = card(i.message.id);
    return handler && c ? handler(i, c) : eph('This card is no longer active.');
  }
  return eph('Unsupported interaction.');
}

localApps.set(BOT, i => {
  let out;
  try { out = route(i); } catch (e) { console.error('Cillhub Bot failed:', e); out = eph('Something went wrong.'); }
  const [body, posted] = Array.isArray(out) ? out : [out];
  try {
    const r = respond(recordForCallback(i.id, i.token), body, !!posted);
    if (posted) posted(r.interaction.response_message_id);
  } catch (e) { console.error('Cillhub Bot response failed:', e); }
});

// --- timers --------------------------------------------------------------------------------------------------------------
addJob({
  name: 'bot reminders',
  next: () => get('SELECT MIN(remind_at) AS t FROM bot_reminders').t,
  run: now => {
    for (const r of all('SELECT * FROM bot_reminders WHERE remind_at <= ? ORDER BY remind_at', now)) {
      run('DELETE FROM bot_reminders WHERE id = ?', r.id);
      try {
        const dm = getChannel(openDm({ body: { recipient_id: r.user_id }, user: userById(BOT) }).id);
        post(dm, `⏰ Reminder${r.channel_id ? ` (from <#${r.channel_id}>)` : ''}: ${r.content}`.slice(0, 2000));
      } catch (e) {
        if (!(e instanceof HttpError)) console.error('reminder failed:', e); // no shared guild any more, or blocked: dropped
      }
    }
  },
});

addJob({
  name: 'bot cards',
  next: () => get('SELECT MIN(due_at) AS t FROM bot_cards WHERE due_at IS NOT NULL').t,
  run: now => {
    for (const c of all('SELECT * FROM bot_cards WHERE due_at IS NOT NULL AND due_at <= ?', now)) {
      if (!isMember(c.guild_id, BOT)) setData(c.message_id, json(c.data), null); // uninstalled meanwhile: the card stays as it is
      else if (c.kind === 'giveaway') endGiveaway(c);
      else if (c.kind === 'scrim') pingScrim(c);
      else setData(c.message_id, json(c.data), null);
    }
  },
});

// --- install from Server Settings -> Integrations (MANAGE_GUILD); the OAuth2 flow with this app id works as well -----------
const state = g => ({ application_id: BOT, installed: isMember(g.id, BOT) });
function install(ctx) {
  const g = loadGuild(ctx.params.id, ctx.user, P.MANAGE_GUILD);
  const permissions = String(BOT_PERMS & guildPerms(g.id, ctx.user.id));
  authorize({ ...ctx, query: new URLSearchParams({ client_id: BOT, scope: 'bot applications.commands' }), body: { authorize: true, guild_id: g.id, permissions } });
  return state(g);
}
function uninstall(ctx) {
  const g = loadGuild(ctx.params.id, ctx.user, P.MANAGE_GUILD);
  if (isMember(g.id, BOT)) removeMember(g.id, userById(BOT));
  return state(g);
}

export const cillcordBotId = BOT;
export default [
  ['GET', '/guilds/:id/cillcord-bot', ctx => state(loadGuild(ctx.params.id, ctx.user)), { userOnly: true }],
  ['PUT', '/guilds/:id/cillcord-bot', install, { userOnly: true }],
  ['DELETE', '/guilds/:id/cillcord-bot', uninstall, { userOnly: true }],
];
