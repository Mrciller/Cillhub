// XP & Level Rewards: Chat & Voice XP leveling, automated milestone roles, rank cards & leaderboard.

const COOLDOWN_MS = 60 * 1000; // 60s message anti-spam cooldown
const VOICE_TICK_XP = 25; // 25 XP per 5 minutes of active voice chat
const MAX_LEADERBOARD_ENTRIES = 500;

const storageKey = (guildId) => `xp_leaderboard:${guildId}`;

const calcLevel = (xp) => Math.floor(0.1 * Math.sqrt(Math.max(0, xp)));
const xpForLevel = (lvl) => 100 * (lvl * lvl);
const xpForNext = (lvl) => 100 * ((lvl + 1) * (lvl + 1));

async function loadLeaderboard(guildId) {
  const list = await cillhub.call('storage.get', { key: storageKey(guildId) });
  return Array.isArray(list) ? list : [];
}

async function saveLeaderboard(guildId, list) {
  list.sort((a, b) => b.xp - a.xp);
  const trimmed = list.slice(0, MAX_LEADERBOARD_ENTRIES);
  await cillhub.call('storage.set', { key: storageKey(guildId), value: trimmed });
  try {
    await cillhub.call('ui.publish', { guild_id: guildId, data: { type: 'xp_updated' } });
  } catch (err) {
    // Ignore publish failure if no panels are open
  }
}

async function checkMilestones(guildId, user, oldLevel, newLevel, settings, announceChannelId) {
  if (newLevel <= oldLevel) return;

  // 1. Announce level up
  const targetChannel = settings?.level_up_channel || announceChannelId;
  if (targetChannel) {
    try {
      await cillhub.call('messages.send', {
        channel_id: targetChannel,
        content: `🎉 Congratulations <@${user.id}>! You've leveled up to **Level ${newLevel}**! ⭐`,
        allowed_mentions: { parse: [], users: [user.id] },
      });
    } catch (err) {
      console.warn(`Failed to announce level up: ${err.message}`);
    }
  }

  // 2. Grant milestone roles
  if (newLevel >= 5 && oldLevel < 5 && settings?.role_level_5) {
    try {
      await cillhub.call('members.add_role', { guild_id: guildId, user_id: user.id, role_id: settings.role_level_5 });
    } catch (err) {
      console.warn(`Giving Level 5 role failed: ${err.message}`);
    }
  }
  if (newLevel >= 10 && oldLevel < 10 && settings?.role_level_10) {
    try {
      await cillhub.call('members.add_role', { guild_id: guildId, user_id: user.id, role_id: settings.role_level_10 });
    } catch (err) {
      console.warn(`Giving Level 10 role failed: ${err.message}`);
    }
  }
  if (newLevel >= 25 && oldLevel < 25 && settings?.role_level_25) {
    try {
      await cillhub.call('members.add_role', { guild_id: guildId, user_id: user.id, role_id: settings.role_level_25 });
    } catch (err) {
      console.warn(`Giving Level 25 role failed: ${err.message}`);
    }
  }
}

// Register recurring voice XP schedule (every 5 minutes)
cillhub.on('READY', async () => {
  try {
    await cillhub.call('schedule.every', { name: 'voice_xp_tick', interval_ms: 300_000 });
  } catch (err) {
    console.warn(`Failed to register voice XP schedule: ${err.message}`);
  }
});

// Periodic voice XP grant
cillhub.on('SCHEDULE', async ({ name }) => {
  if (name !== 'voice_xp_tick') return;

  let guilds = [];
  try {
    guilds = (await cillhub.call('guilds.list', {})) || [];
  } catch (err) {
    console.warn(`Failed to list guilds on schedule: ${err.message}`);
    return;
  }

  for (const g of guilds) {
    try {
      const states = (await cillhub.call('voice.list', { guild_id: g.id })) || [];
      const eligible = states.filter((v) => !v.self_mute && !v.mute && !v.self_deaf && !v.deaf && v.user_id);
      if (!eligible.length) continue;

      const settings = (await cillhub.call('settings.get', { guild_id: g.id })) || {};
      const list = await loadLeaderboard(g.id);
      let changed = false;

      for (const vs of eligible) {
        let entry = list.find((u) => u.id === vs.user_id);
        const name = vs.member?.user?.global_name || vs.member?.user?.username || 'Member';
        if (!entry) {
          entry = { id: vs.user_id, name, xp: 0, level: 0, messages: 0, voice_mins: 0, last_msg_at: 0 };
          list.push(entry);
        } else if (name && entry.name !== name) {
          entry.name = name;
        }

        const oldLevel = entry.level;
        entry.xp += VOICE_TICK_XP;
        entry.voice_mins = (entry.voice_mins || 0) + 5;
        const newLevel = calcLevel(entry.xp);
        entry.level = newLevel;
        changed = true;

        if (newLevel > oldLevel) {
          await checkMilestones(g.id, entry, oldLevel, newLevel, settings, null);
        }
      }

      if (changed) {
        await saveLeaderboard(g.id, list);
      }
    } catch (err) {
      console.warn(`Voice XP tick error in guild ${g.id}: ${err.message}`);
    }
  }
});

// Message XP on MESSAGE_CREATE
cillhub.on('MESSAGE_CREATE', async (msg) => {
  if (!msg.guild_id || msg.author?.bot) return;

  const guildId = msg.guild_id;
  const author = msg.author;
  const now = Date.now();

  const settings = (await cillhub.call('settings.get', { guild_id: guildId })) || {};
  const xpPerMsg = Number(settings.xp_per_message) || 20;

  const list = await loadLeaderboard(guildId);
  const name = author.global_name || author.username;
  let entry = list.find((u) => u.id === author.id);

  if (!entry) {
    entry = { id: author.id, name, xp: xpPerMsg, level: calcLevel(xpPerMsg), messages: 1, voice_mins: 0, last_msg_at: now };
    list.push(entry);
    await checkMilestones(guildId, entry, 0, entry.level, settings, msg.channel_id);
    await saveLeaderboard(guildId, list);
    return;
  }

  // Update display name if changed
  if (name) entry.name = name;

  // Anti-spam cooldown check
  if (now - (entry.last_msg_at || 0) < COOLDOWN_MS) {
    entry.messages = (entry.messages || 0) + 1;
    await saveLeaderboard(guildId, list);
    return;
  }

  const oldLevel = entry.level;
  entry.xp += xpPerMsg;
  entry.messages = (entry.messages || 0) + 1;
  entry.last_msg_at = now;
  const newLevel = calcLevel(entry.xp);
  entry.level = newLevel;

  await checkMilestones(guildId, entry, oldLevel, newLevel, settings, msg.channel_id);
  await saveLeaderboard(guildId, list);
});

function formatRankCard(entry, rankIndex, totalCount) {
  const lvl = entry.level;
  const curBase = xpForLevel(lvl);
  const nextBase = xpForNext(lvl);
  const progressXp = entry.xp - curBase;
  const neededXp = nextBase - curBase;
  const pct = Math.min(100, Math.floor((progressXp / neededXp) * 100));

  return {
    id: entry.id,
    name: entry.name,
    xp: entry.xp,
    level: lvl,
    messages: entry.messages || 0,
    voice_mins: entry.voice_mins || 0,
    rank: rankIndex + 1,
    total_users: totalCount,
    progress_xp: progressXp,
    needed_xp: neededXp,
    progress_pct: pct,
  };
}

// UI Panel handler for Leaderboard & XP
cillhub.on('UI_REQUEST', async (req) => {
  const guildId = req.guild_id;
  const data = req.data && typeof req.data === 'object' ? req.data : {};
  const list = await loadLeaderboard(guildId);
  const myId = req.user.id;

  const myIndex = list.findIndex((u) => u.id === myId);
  const myEntry = myIndex !== -1 ? list[myIndex] : { id: myId, name: req.user.global_name || req.user.username, xp: 0, level: 0, messages: 0, voice_mins: 0 };
  const myCard = formatRankCard(myEntry, myIndex !== -1 ? myIndex : list.length, list.length);

  if (data.action === 'user_card') {
    const targetId = data.user_id || myId;
    const idx = list.findIndex((u) => u.id === targetId);
    if (idx !== -1) {
      return { card: formatRankCard(list[idx], idx, list.length) };
    }
    return { card: myCard };
  }

  // Default: list view
  const enrichedList = list.slice(0, 100).map((u, i) => formatRankCard(u, i, list.length));
  return {
    my_card: myCard,
    leaderboard: enrichedList,
    total_users: list.length,
  };
});

function renderProgressBar(pct) {
  const totalBars = 10;
  const filled = Math.min(totalBars, Math.max(0, Math.round((pct / 100) * totalBars)));
  const empty = totalBars - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

// Slash command handling (/rank and /leaderboard)
cillhub.on('INTERACTION_CREATE', async (i) => {
  const guildId = i.guild_id;
  if (!guildId) {
    return { type: 4, data: { content: 'Levels and rank commands are server-only.', flags: 64 } };
  }

  const list = await loadLeaderboard(guildId);

  if (i.type === 2 && i.data?.name === 'rank') {
    const opts = {};
    for (const o of i.data.options || []) opts[o.name] = o.value;

    const targetUserId = opts.user || (i.member?.user ?? i.user).id;
    const idx = list.findIndex((u) => u.id === targetUserId);

    if (idx === -1) {
      return {
        type: 4,
        data: {
          content: `<@${targetUserId}> has not earned any XP yet. Send messages or participate in voice channels to begin leveling up!`,
          flags: 64,
        },
      };
    }

    const card = formatRankCard(list[idx], idx, list.length);
    const bar = renderProgressBar(card.progress_pct);

    const voiceHours = Math.floor(card.voice_mins / 60);
    const voiceRemainingMins = card.voice_mins % 60;
    const voiceStr = voiceHours > 0 ? `${voiceHours}h ${voiceRemainingMins}m` : `${voiceRemainingMins}m`;

    return {
      type: 4,
      data: {
        content: [
          `⭐ **Rank Card — ${card.name}**`,
          `**Rank:** #${card.rank} / ${card.total_users} · **Level:** ${card.level}`,
          `**Total XP:** ${card.xp.toLocaleString()} XP`,
          `**Progress:** \`[${bar}]\` ${card.progress_pct}% (${card.progress_xp.toLocaleString()} / ${card.needed_xp.toLocaleString()} XP to Level ${card.level + 1})`,
          `**Activity:** 💬 ${card.messages.toLocaleString()} messages · 🎙️ ${voiceStr} voice`,
        ].join('\n'),
        allowed_mentions: { parse: [] },
      },
    };
  }

  if (i.type === 2 && i.data?.name === 'leaderboard') {
    if (!list.length) {
      return {
        type: 4,
        data: { content: '⭐ **Server Leaderboard**\nNo members have earned XP yet. Start chatting to climb the ranks!' },
      };
    }

    const medals = ['🥇', '🥈', '🥉'];
    const lines = list.slice(0, 10).map((u, idx) => {
      const medal = medals[idx] || `\`#${idx + 1}\``;
      return `${medal} **${u.name}** — Level **${u.level}** (${u.xp.toLocaleString()} XP)`;
    });

    return {
      type: 4,
      data: {
        content: `⭐ **Server XP Leaderboard — Top 10**\n\n${lines.join('\n')}\n\n*Check the **Leaderboard & XP** sidebar panel to view full rankings!*`,
        allowed_mentions: { parse: [] },
      },
    };
  }
});
