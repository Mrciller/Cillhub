// Jukebox & Watch Queue: collaborative voting media queue with host controls & live updates.

const MANAGE = 0x8n | 0x20n; // ADMINISTRATOR | MANAGE_GUILD
const MAX_QUEUE_ITEMS = 50;
const MAX_HISTORY = 10;

const storageKey = (guildId) => `jukebox:${guildId}`;

async function loadQueue(guildId) {
  const data = await cillhub.call('storage.get', { key: storageKey(guildId) });
  if (!data || typeof data !== 'object') {
    return { now_playing: null, items: [], history: [] };
  }
  return {
    now_playing: data.now_playing || null,
    items: Array.isArray(data.items) ? data.items : [],
    history: Array.isArray(data.history) ? data.history : [],
  };
}

async function saveQueue(guildId, queue) {
  // Sort items: most votes first, then earliest created
  queue.items.sort((a, b) => b.votes.length - a.votes.length || a.created_at - b.created_at);
  queue.history = queue.history.slice(0, MAX_HISTORY);
  await cillhub.call('storage.set', { key: storageKey(guildId), value: queue });
  try {
    await cillhub.call('ui.publish', { guild_id: guildId, data: { type: 'queue_updated' } });
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

async function announceNowPlaying(channelId, item) {
  if (!channelId || !item) return;
  try {
    const urlStr = item.url ? ` · [Watch Link](${item.url})` : '';
    const durStr = item.duration_label ? ` [${item.duration_label}]` : '';
    await cillhub.call('messages.send', {
      channel_id: channelId,
      content: `🎵 **Now Playing:** **${item.title}**${durStr}${urlStr}\n*Requested by <@${item.submitted_by.id}>*`,
      allowed_mentions: { parse: [] },
      components: [
        {
          type: 1,
          components: [
            { type: 2, style: 2, label: 'Skip', custom_id: 'jukebox:skip' },
            { type: 2, style: 2, label: 'View Queue', custom_id: 'jukebox:refresh' },
          ],
        },
      ],
    });
  } catch (err) {
    console.warn(`Failed to announce now playing: ${err.message}`);
  }
}

cillhub.on('UI_REQUEST', async (req) => {
  const guildId = req.guild_id;
  const data = req.data && typeof req.data === 'object' ? req.data : {};
  const queue = await loadQueue(guildId);
  const isMod = canManage(req.member.permissions);
  const me = {
    id: req.user.id,
    name: req.user.global_name || req.user.username,
  };

  const getView = () => {
    const enrichedItems = queue.items.map((it) => ({
      ...it,
      vote_count: it.votes.length,
      has_voted: it.votes.includes(me.id),
      can_delete: isMod || it.submitted_by.id === me.id,
    }));

    return {
      now_playing: queue.now_playing,
      items: enrichedItems,
      history: queue.history,
      can_manage: isMod,
      user_id: me.id,
    };
  };

  if (data.action === 'list') {
    return getView();
  }

  if (data.action === 'add') {
    if (queue.items.length >= MAX_QUEUE_ITEMS) {
      throw new Error(`The queue is currently full (max ${MAX_QUEUE_ITEMS} items).`);
    }

    const title = String(data.title || '').trim();
    if (!title || title.length > 100) {
      throw new Error('Title must be between 1 and 100 characters.');
    }

    let url = String(data.url || '').trim();
    if (url && !/^https?:\/\//i.test(url)) {
      url = `https://${url}`;
    }
    if (url.length > 300) url = url.slice(0, 300);

    const duration = String(data.duration || '').trim().slice(0, 20);
    const id = await cillhub.call('crypto.random', { bytes: 4 });

    const newItem = {
      id,
      title,
      url: url || null,
      duration_label: duration || null,
      submitted_by: me,
      created_at: Date.now(),
      votes: [me.id], // submitter auto-upvotes
    };

    if (!queue.now_playing) {
      // If nothing is playing, play immediately!
      queue.now_playing = {
        id: newItem.id,
        title: newItem.title,
        url: newItem.url,
        duration_label: newItem.duration_label,
        submitted_by: newItem.submitted_by,
        started_at: Date.now(),
        votes: 1,
      };
      await saveQueue(guildId, queue);
      await announceNowPlaying(req.channel_id, queue.now_playing);
    } else {
      queue.items.push(newItem);
      await saveQueue(guildId, queue);
    }

    return getView();
  }

  if (data.action === 'vote') {
    const item = queue.items.find((it) => it.id === data.id);
    if (!item) throw new Error('Item not found in queue.');

    const idx = item.votes.indexOf(me.id);
    if (idx !== -1) {
      item.votes.splice(idx, 1);
    } else {
      item.votes.push(me.id);
    }

    await saveQueue(guildId, queue);
    return getView();
  }

  if (data.action === 'play_next') {
    if (!isMod) throw new Error('Only moderators can force play next.');
    if (!queue.items.length) throw new Error('Queue is empty.');

    if (queue.now_playing) {
      queue.history.unshift(queue.now_playing);
    }
    const nextItem = queue.items.shift();
    queue.now_playing = {
      id: nextItem.id,
      title: nextItem.title,
      url: nextItem.url,
      duration_label: nextItem.duration_label,
      submitted_by: nextItem.submitted_by,
      started_at: Date.now(),
      votes: nextItem.votes.length,
    };

    await saveQueue(guildId, queue);
    await announceNowPlaying(req.channel_id, queue.now_playing);
    return getView();
  }

  if (data.action === 'skip') {
    const isPlayingOwner = queue.now_playing && queue.now_playing.submitted_by.id === me.id;
    if (!isMod && !isPlayingOwner) {
      throw new Error('Only moderators or the submitter can skip the current track.');
    }
    if (!queue.now_playing) throw new Error('Nothing is currently playing.');

    queue.history.unshift(queue.now_playing);

    if (queue.items.length > 0) {
      const nextItem = queue.items.shift();
      queue.now_playing = {
        id: nextItem.id,
        title: nextItem.title,
        url: nextItem.url,
        duration_label: nextItem.duration_label,
        submitted_by: nextItem.submitted_by,
        started_at: Date.now(),
        votes: nextItem.votes.length,
      };
      await announceNowPlaying(req.channel_id, queue.now_playing);
    } else {
      queue.now_playing = null;
    }

    await saveQueue(guildId, queue);
    return getView();
  }

  if (data.action === 'remove') {
    const item = queue.items.find((it) => it.id === data.id);
    if (!item) throw new Error('Item not found.');
    if (!isMod && item.submitted_by.id !== me.id) {
      throw new Error('You do not have permission to remove this item.');
    }

    queue.items = queue.items.filter((it) => it.id !== item.id);
    await saveQueue(guildId, queue);
    return getView();
  }

  if (data.action === 'clear') {
    if (!isMod) throw new Error('Only moderators can clear the queue.');
    queue.items = [];
    await saveQueue(guildId, queue);
    return getView();
  }

  throw new Error(`Unknown action: ${data.action}`);
});

function buildQueueListMessage(queue) {
  const np = queue.now_playing;
  const npText = np
    ? `🎶 **Now Playing:** **${np.title}**${np.duration_label ? ` [${np.duration_label}]` : ''} · Requested by <@${np.submitted_by.id}>`
    : '🎶 **Now Playing:** *Nothing currently playing*';

  let listText = '';
  if (!queue.items.length) {
    listText = '\n*Queue is empty. Submit a track using `/jukebox` or in the Jukebox channel panel!*';
  } else {
    const lines = queue.items.slice(0, 5).map((it, idx) => {
      const votes = `[🔺 ${it.votes.length}]`;
      const dur = it.duration_label ? ` (${it.duration_label})` : '';
      return `\`${idx + 1}.\` ${votes} **${it.title}**${dur} — requested by <@${it.submitted_by.id}>`;
    });
    listText = `\n**Upcoming Queue (${queue.items.length} items):**\n${lines.join('\n')}`;
  }

  const buttons = [];
  if (queue.items.length > 0) {
    const topItem = queue.items[0];
    buttons.push({
      type: 2,
      style: 1,
      label: `Upvote #${1}`,
      custom_id: `jukebox:vote:${topItem.id}`,
    });
  }
  if (queue.now_playing) {
    buttons.push({ type: 2, style: 2, label: 'Skip Current', custom_id: 'jukebox:skip' });
  }
  buttons.push({ type: 2, style: 2, label: 'Refresh', custom_id: 'jukebox:refresh' });

  return {
    content: `${npText}\n${listText}`,
    allowed_mentions: { parse: [] },
    components: [{ type: 1, components: buttons }],
  };
}

cillhub.on('INTERACTION_CREATE', async (i) => {
  const guildId = i.guild_id;
  if (!guildId) {
    return { type: 4, data: { content: 'Jukebox can only be used in servers.', flags: 64 } };
  }

  const queue = await loadQueue(guildId);
  const user = i.member?.user ?? i.user;
  const isMod = canManage(i.member?.permissions);

  // Slash Command /jukebox
  if (i.type === 2 && i.data?.name === 'jukebox') {
    const opts = {};
    for (const o of i.data.options || []) opts[o.name] = o.value;

    if (opts.title) {
      const title = String(opts.title).trim().slice(0, 100);
      let url = String(opts.url || '').trim();
      if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
      const dur = String(opts.duration || '').trim().slice(0, 20);
      const id = await cillhub.call('crypto.random', { bytes: 4 });

      const me = { id: user.id, name: user.global_name || user.username };
      const newItem = {
        id,
        title,
        url: url || null,
        duration_label: dur || null,
        submitted_by: me,
        created_at: Date.now(),
        votes: [user.id],
      };

      if (!queue.now_playing) {
        queue.now_playing = {
          id: newItem.id,
          title: newItem.title,
          url: newItem.url,
          duration_label: newItem.duration_label,
          submitted_by: me,
          started_at: Date.now(),
          votes: 1,
        };
        await saveQueue(guildId, queue);
        return {
          type: 4,
          data: {
            content: `🎵 **Now Playing:** **${title}**${url ? ` (${url})` : ''} · Requested by <@${user.id}>!`,
            allowed_mentions: { parse: [] },
            components: [
              {
                type: 1,
                components: [{ type: 2, style: 2, label: 'Skip', custom_id: 'jukebox:skip' }],
              },
            ],
          },
        };
      }

      queue.items.push(newItem);
      await saveQueue(guildId, queue);

      return {
        type: 4,
        data: {
          content: `✅ Added **${title}** to the queue with your initial upvote! (Position #${queue.items.findIndex((it) => it.id === id) + 1})`,
          flags: 64,
        },
      };
    }

    // No title option -> render current queue status
    const msg = buildQueueListMessage(queue);
    return { type: 4, data: msg };
  }

  // Button Interactions
  if (i.type === 3) {
    const customId = String(i.data?.custom_id || '');

    if (customId === 'jukebox:refresh') {
      const msg = buildQueueListMessage(queue);
      return { type: 7, data: msg };
    }

    if (customId.startsWith('jukebox:vote:')) {
      const itemId = customId.slice('jukebox:vote:'.length);
      const item = queue.items.find((it) => it.id === itemId);
      if (!item) {
        return { type: 4, data: { content: 'That item is no longer in the queue.', flags: 64 } };
      }

      const idx = item.votes.indexOf(user.id);
      if (idx !== -1) {
        item.votes.splice(idx, 1);
      } else {
        item.votes.push(user.id);
      }

      await saveQueue(guildId, queue);
      const msg = buildQueueListMessage(queue);
      return { type: 7, data: msg };
    }

    if (customId === 'jukebox:skip') {
      const isOwner = queue.now_playing && queue.now_playing.submitted_by.id === user.id;
      if (!isMod && !isOwner) {
        return { type: 4, data: { content: 'Only moderators or the requester can skip.', flags: 64 } };
      }
      if (!queue.now_playing) {
        return { type: 4, data: { content: 'Nothing is currently playing.', flags: 64 } };
      }

      queue.history.unshift(queue.now_playing);
      if (queue.items.length > 0) {
        const nextItem = queue.items.shift();
        queue.now_playing = {
          id: nextItem.id,
          title: nextItem.title,
          url: nextItem.url,
          duration_label: nextItem.duration_label,
          submitted_by: nextItem.submitted_by,
          started_at: Date.now(),
          votes: nextItem.votes.length,
        };
      } else {
        queue.now_playing = null;
      }

      await saveQueue(guildId, queue);
      const msg = buildQueueListMessage(queue);
      return { type: 7, data: msg };
    }
  }
});
