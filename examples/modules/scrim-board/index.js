// Scrim Board: a channel panel listing upcoming scrims per server, and /scrims (see README.md).
// Each server's scrims live in one storage value, `scrims:<guild_id>`, sorted by start time.

const MANAGE = 0x8n | 0x20n; // ADMINISTRATOR | MANAGE_GUILD
const KEEP_AFTER_START_MS = 3 * 60 * 60 * 1000;
const MAX_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;
const MAX_SCRIMS = 50;

const storageKey = (guildId) => `scrims:${guildId}`;

async function load(guildId) {
  const all = (await cillhub.call('storage.get', { key: storageKey(guildId) })) || [];
  const cutoff = Date.now() - KEEP_AFTER_START_MS;
  return all.filter((s) => s.at > cutoff); // finished scrims drop out on the next save
}

async function save(guildId, scrims) {
  await cillhub.call('storage.set', { key: storageKey(guildId), value: scrims });
  try {
    // Open panels in this server reload the list when they get this.
    await cillhub.call('ui.publish', { guild_id: guildId, data: { type: 'changed' } });
  } catch (err) {
    console.warn(`ui.publish failed: ${err.code || ''} ${err.message}`);
  }
}

function canManage(permissions) {
  try { return (BigInt(permissions) & MANAGE) !== 0n; } catch { return false; }
}

function parseNew(data) {
  const opponent = String(data.opponent ?? '').trim();
  const at = Number(data.at);
  const slots = Number(data.slots);
  if (opponent.length < 1 || opponent.length > 60) throw new Error('The opponent needs 1 to 60 characters.');
  if (!Number.isFinite(at) || at < Date.now() - 60_000 || at > Date.now() + MAX_AHEAD_MS) throw new Error('Pick a start time in the next year.');
  if (!Number.isInteger(slots) || slots < 1 || slots > 20) throw new Error('Slots must be a whole number from 1 to 20.');
  return { opponent, at, slots };
}

cillhub.on('UI_REQUEST', async (req) => {
  const guildId = req.guild_id;
  const data = req.data && typeof req.data === 'object' ? req.data : {};
  let scrims = await load(guildId);
  const view = () => ({ scrims, can_manage: canManage(req.member.permissions) });
  if (data.action === 'list') return view();

  const me = { id: req.user.id, name: req.user.global_name || req.user.username };
  if (data.action === 'add') {
    if (scrims.length >= MAX_SCRIMS) throw new Error(`This server already has ${MAX_SCRIMS} upcoming scrims.`);
    const id = await cillhub.call('crypto.random', { bytes: 6 });
    scrims.push({ id, ...parseNew(data), creator_id: me.id, players: [] });
    scrims.sort((a, b) => a.at - b.at);
  } else {
    const scrim = scrims.find((s) => s.id === data.id);
    if (!scrim) throw new Error('That scrim no longer exists.');
    const joined = scrim.players.some((p) => p.id === me.id);
    if (data.action === 'join') {
      if (joined) return view();
      if (scrim.players.length >= scrim.slots) throw new Error('That scrim is full.');
      scrim.players.push(me);
    } else if (data.action === 'leave') {
      if (!joined) return view();
      scrim.players = scrim.players.filter((p) => p.id !== me.id);
    } else if (data.action === 'remove') {
      if (scrim.creator_id !== me.id && !canManage(req.member.permissions)) {
        throw new Error('Only the person who added it or someone with Manage Server can remove a scrim.');
      }
      scrims = scrims.filter((s) => s !== scrim);
    } else {
      throw new Error(`Unknown action: ${data.action}`);
    }
  }
  await save(guildId, scrims);
  return view();
});

function listText(scrims) {
  if (!scrims.length) return 'No upcoming scrims. Add one in the Scrims panel of any channel.';
  return scrims
    .map((s) => `**${s.opponent.replace(/[*_~`|\\<>]/g, '\\$&')}**: <t:${Math.floor(s.at / 1000)}:F> (<t:${Math.floor(s.at / 1000)}:R>), ${s.players.length}/${s.slots} players`)
    .join('\n');
}

cillhub.on('INTERACTION_CREATE', async (i) => {
  const isCommand = i.type === 2 && i.data?.name === 'scrims';
  const isRefresh = i.type === 3 && i.data?.custom_id === 'scrims:refresh';
  if (!isCommand && !isRefresh) return;
  if (!i.guild_id) return { type: 4, data: { content: 'Scrims belong to a server.', flags: 64 } };
  const scrims = await load(i.guild_id);
  return {
    type: isCommand ? 4 : 7, // 4: new message, 7: update the message the button is on
    data: {
      content: listText(scrims),
      allowed_mentions: { parse: [] },
      components: [{ type: 1, components: [{ type: 2, style: 2, label: 'Refresh', custom_id: 'scrims:refresh' }] }],
    },
  };
});
