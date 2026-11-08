// LFG Party Finder: create & browse squads, live voice status, auto-notification when ready.

const MANAGE = 0x8n | 0x20n; // ADMINISTRATOR | MANAGE_GUILD
const EXPIRY_MS = 24 * 60 * 60 * 1000; // Squads expire after 24 hours
const MAX_SQUADS = 40;

const storageKey = (guildId) => `lfg:${guildId}`;

async function loadSquads(guildId) {
  const all = (await cillhub.call('storage.get', { key: storageKey(guildId) })) || [];
  const cutoff = Date.now() - EXPIRY_MS;
  return all.filter((s) => s.created_at > cutoff);
}

async function saveSquads(guildId, squads) {
  await cillhub.call('storage.set', { key: storageKey(guildId), value: squads });
  try {
    await cillhub.call('ui.publish', { guild_id: guildId, data: { type: 'squads_updated' } });
  } catch (err) {
    console.warn(`ui.publish failed: ${err.message}`);
  }
}

function canManage(permissions) {
  try {
    return (BigInt(permissions || '0') & MANAGE) !== 0n;
  } catch {
    return false;
  }
}

async function notifyReady(guildId, squad) {
  if (squad.notified_full || !squad.channel_id) return;
  squad.notified_full = true;
  try {
    const mentions = squad.members.map((m) => `<@${m.id}>`).join(' ');
    const voiceMsg = squad.voice_channel_id ? `\n🔊 **Join Voice:** <#${squad.voice_channel_id}>` : '';
    await cillhub.call('messages.send', {
      channel_id: squad.channel_id,
      content: `🎉 **Squad Ready!** The squad for **${squad.game}** is now full (${squad.members.length}/${squad.max_slots})!\n**Party:** ${mentions}${voiceMsg}`,
      allowed_mentions: { parse: [], users: squad.members.map((m) => m.id) },
    });
  } catch (err) {
    console.warn(`Failed to send squad ready notification: ${err.message}`);
  }
}

// Track member voice states live and push to open panels
cillhub.on('VOICE_STATE_UPDATE', async (vs) => {
  if (!vs.guild_id) return;
  try {
    await cillhub.call('ui.publish', {
      guild_id: vs.guild_id,
      data: {
        type: 'voice_update',
        user_id: vs.user_id,
        channel_id: vs.channel_id,
      },
    });
  } catch (err) {
    // Ignore publish failure when no panels are listening
  }
});

cillhub.on('UI_REQUEST', async (req) => {
  const guildId = req.guild_id;
  const data = req.data && typeof req.data === 'object' ? req.data : {};
  let squads = await loadSquads(guildId);

  // Helper to fetch live voice status & voice channels
  const getView = async () => {
    let voiceUsers = {};
    let voiceChannels = [];
    try {
      const states = (await cillhub.call('voice.list', { guild_id: guildId })) || [];
      for (const s of states) {
        if (s.user_id && s.channel_id) voiceUsers[s.user_id] = s.channel_id;
      }
    } catch (e) {
      console.warn(`voice.list failed: ${e.message}`);
    }

    try {
      const channels = (await cillhub.call('channels.list', { guild_id: guildId })) || [];
      voiceChannels = channels.filter((c) => c.type === 2).map((c) => ({ id: c.id, name: c.name }));
    } catch (e) {
      console.warn(`channels.list failed: ${e.message}`);
    }

    const enrichedSquads = squads.map((sq) => ({
      ...sq,
      members: sq.members.map((m) => ({
        ...m,
        in_voice: !!voiceUsers[m.id],
        in_party_voice: sq.voice_channel_id ? voiceUsers[m.id] === sq.voice_channel_id : false,
        current_voice_id: voiceUsers[m.id] || null,
      })),
    }));

    return {
      squads: enrichedSquads,
      voice_channels: voiceChannels,
      user_id: req.user.id,
      can_manage: canManage(req.member.permissions),
    };
  };

  if (data.action === 'list') {
    return await getView();
  }

  const me = {
    id: req.user.id,
    name: req.user.global_name || req.user.username,
  };

  if (data.action === 'create') {
    if (squads.length >= MAX_SQUADS) {
      throw new Error(`This server already has ${MAX_SQUADS} active squads.`);
    }
    const game = String(data.game || '').trim();
    if (!game || game.length > 60) throw new Error('Game title must be between 1 and 60 characters.');
    const slots = Number(data.max_slots);
    if (!Number.isInteger(slots) || slots < 2 || slots > 16) {
      throw new Error('Party size must be an integer between 2 and 16.');
    }
    const desc = String(data.description || '').trim().slice(0, 200);
    const neededRoles = String(data.needed_roles || '').trim().slice(0, 100);
    const voiceChannelId = data.voice_channel_id ? String(data.voice_channel_id) : null;

    const id = await cillhub.call('crypto.random', { bytes: 4 });
    const newSquad = {
      id,
      guild_id: guildId,
      channel_id: req.channel_id || null,
      creator_id: me.id,
      creator_name: me.name,
      game,
      description: desc,
      needed_roles: neededRoles,
      max_slots: slots,
      voice_channel_id: voiceChannelId,
      created_at: Date.now(),
      notified_full: false,
      members: [
        {
          id: me.id,
          name: me.name,
          role: 'Leader',
          joined_at: Date.now(),
        },
      ],
    };

    squads.unshift(newSquad);
    await saveSquads(guildId, squads);

    // Announce to channel if panel is open in a channel
    if (req.channel_id) {
      try {
        const vText = voiceChannelId ? ` · 🔊 <#${voiceChannelId}>` : '';
        await cillhub.call('messages.send', {
          channel_id: req.channel_id,
          content: `🎮 **LFG:** <@${me.id}> started a squad for **${game}** (1/${slots})!${vText}`,
          allowed_mentions: { parse: [] },
          components: [
            {
              type: 1,
              components: [
                { type: 2, style: 1, label: 'Join Squad', custom_id: `lfg:join:${id}` },
                { type: 2, style: 2, label: 'Refresh', custom_id: 'lfg:refresh' },
              ],
            },
          ],
        });
      } catch (err) {
        console.warn(`Channel squad announcement failed: ${err.message}`);
      }
    }

    return await getView();
  }

  const squad = squads.find((s) => s.id === data.id);
  if (!squad) throw new Error('That squad no longer exists.');
  const inSquad = squad.members.some((m) => m.id === me.id);

  if (data.action === 'join') {
    if (inSquad) return await getView();
    if (squad.members.length >= squad.max_slots) throw new Error('That squad is already full.');

    const roleName = String(data.role || 'Member').trim().slice(0, 30);
    squad.members.push({
      id: me.id,
      name: me.name,
      role: roleName || 'Member',
      joined_at: Date.now(),
    });

    if (squad.members.length >= squad.max_slots) {
      await notifyReady(guildId, squad);
    }
    await saveSquads(guildId, squads);
    return await getView();
  }

  if (data.action === 'leave') {
    if (!inSquad) return await getView();
    squad.members = squad.members.filter((m) => m.id !== me.id);
    squad.notified_full = false; // re-open ready alert if someone else joins later

    if (squad.members.length === 0) {
      squads = squads.filter((s) => s.id !== squad.id);
    } else if (squad.creator_id === me.id) {
      // Reassign leader
      squad.creator_id = squad.members[0].id;
      squad.creator_name = squad.members[0].name;
      squad.members[0].role = 'Leader';
    }

    await saveSquads(guildId, squads);
    return await getView();
  }

  if (data.action === 'delete') {
    if (squad.creator_id !== me.id && !canManage(req.member.permissions)) {
      throw new Error('Only the squad creator or an admin can delete this squad.');
    }
    squads = squads.filter((s) => s.id !== squad.id);
    await saveSquads(guildId, squads);
    return await getView();
  }

  throw new Error(`Unknown action: ${data.action}`);
});

function buildSquadListMessage(squads) {
  if (!squads.length) {
    return {
      content: '🎮 **LFG Party Finder**\nNo active squads right now. Create one using `/lfg` or open the **Party Finder** channel panel!',
      components: [
        {
          type: 1,
          components: [{ type: 2, style: 2, label: 'Refresh', custom_id: 'lfg:refresh' }],
        },
      ],
    };
  }

  const lines = squads.slice(0, 5).map((s) => {
    const isFull = s.members.length >= s.max_slots;
    const badge = isFull ? '🔴 FULL' : '🟢 OPEN';
    const v = s.voice_channel_id ? ` · <#${s.voice_channel_id}>` : '';
    const desc = s.description ? `\n> *${s.description}*` : '';
    const roles = s.needed_roles ? ` (Roles: ${s.needed_roles})` : '';
    return `**${s.game}** [${s.members.length}/${s.max_slots}] ${badge}${v}${roles}${desc}`;
  });

  const buttons = [];
  const openSquads = squads.filter((s) => s.members.length < s.max_slots).slice(0, 4);
  for (const s of openSquads) {
    buttons.push({
      type: 2,
      style: 1,
      label: `Join ${s.game.slice(0, 15)}`,
      custom_id: `lfg:join:${s.id}`,
    });
  }
  buttons.push({ type: 2, style: 2, label: 'Refresh', custom_id: 'lfg:refresh' });

  return {
    content: `🎮 **LFG Party Finder — Active Squads**\n\n${lines.join('\n\n')}`,
    allowed_mentions: { parse: [] },
    components: [{ type: 1, components: buttons }],
  };
}

cillhub.on('INTERACTION_CREATE', async (i) => {
  const guildId = i.guild_id;
  if (!guildId) {
    return { type: 4, data: { content: 'LFG squads can only be used in servers.', flags: 64 } };
  }

  // Handle /lfg slash command
  if (i.type === 2 && i.data?.name === 'lfg') {
    const opts = {};
    for (const o of i.data.options || []) opts[o.name] = o.value;

    let squads = await loadSquads(guildId);

    // If game option was supplied, create squad
    if (opts.game) {
      const user = i.member?.user ?? i.user;
      const game = String(opts.game).trim().slice(0, 60);
      const slots = Math.min(16, Math.max(2, Number(opts.slots) || 5));
      const desc = String(opts.description || '').trim().slice(0, 200);
      const voiceId = opts.voice_channel ? String(opts.voice_channel) : null;
      const id = await cillhub.call('crypto.random', { bytes: 4 });

      const newSquad = {
        id,
        guild_id: guildId,
        channel_id: i.channel_id,
        creator_id: user.id,
        creator_name: user.global_name || user.username,
        game,
        description: desc,
        needed_roles: '',
        max_slots: slots,
        voice_channel_id: voiceId,
        created_at: Date.now(),
        notified_full: false,
        members: [{ id: user.id, name: user.global_name || user.username, role: 'Leader', joined_at: Date.now() }],
      };

      squads.unshift(newSquad);
      await saveSquads(guildId, squads);

      const vText = voiceId ? `\n🔊 **Voice Channel:** <#${voiceId}>` : '';
      const dText = desc ? `\n> *${desc}*` : '';

      return {
        type: 4,
        data: {
          content: `🎮 **New Squad Created by <@${user.id}>!**\n**Game:** ${game} (${1}/${slots})${vText}${dText}`,
          allowed_mentions: { parse: [] },
          components: [
            {
              type: 1,
              components: [
                { type: 2, style: 1, label: 'Join Squad', custom_id: `lfg:join:${id}` },
                { type: 2, style: 2, label: 'Leave', custom_id: `lfg:leave:${id}` },
                { type: 2, style: 2, label: 'Refresh', custom_id: 'lfg:refresh' },
              ],
            },
          ],
        },
      };
    }

    // No game option -> list open squads
    const msg = buildSquadListMessage(squads);
    return { type: 4, data: msg };
  }

  // Handle button clicks
  if (i.type === 3) {
    const customId = String(i.data?.custom_id || '');
    let squads = await loadSquads(guildId);
    const user = i.member?.user ?? i.user;

    if (customId === 'lfg:refresh') {
      const msg = buildSquadListMessage(squads);
      return { type: 7, data: msg };
    }

    if (customId.startsWith('lfg:join:')) {
      const squadId = customId.slice('lfg:join:'.length);
      const squad = squads.find((s) => s.id === squadId);
      if (!squad) {
        return { type: 4, data: { content: 'That squad is no longer active.', flags: 64 } };
      }
      const alreadyIn = squad.members.some((m) => m.id === user.id);
      if (alreadyIn) {
        return { type: 4, data: { content: "You're already in this squad!", flags: 64 } };
      }
      if (squad.members.length >= squad.max_slots) {
        return { type: 4, data: { content: 'This squad is already full.', flags: 64 } };
      }

      squad.members.push({
        id: user.id,
        name: user.global_name || user.username,
        role: 'Member',
        joined_at: Date.now(),
      });

      if (squad.members.length >= squad.max_slots) {
        await notifyReady(guildId, squad);
      }
      await saveSquads(guildId, squads);

      const msg = buildSquadListMessage(squads);
      return { type: 7, data: msg };
    }

    if (customId.startsWith('lfg:leave:')) {
      const squadId = customId.slice('lfg:leave:'.length);
      const squad = squads.find((s) => s.id === squadId);
      if (!squad) {
        return { type: 4, data: { content: 'That squad is no longer active.', flags: 64 } };
      }

      squad.members = squad.members.filter((m) => m.id !== user.id);
      squad.notified_full = false;
      if (squad.members.length === 0) {
        squads = squads.filter((s) => s.id !== squad.id);
      } else if (squad.creator_id === user.id) {
        squad.creator_id = squad.members[0].id;
        squad.creator_name = squad.members[0].name;
        squad.members[0].role = 'Leader';
      }
      await saveSquads(guildId, squads);

      const msg = buildSquadListMessage(squads);
      return { type: 7, data: msg };
    }
  }
});
