// Game Server Live Bridge Module for Cillhub
// Bridges Minecraft, Rust, and Source game servers with live status embeds,
// bidirectional chat relay, and admin RCON command execution.

const ADMIN_OR_MANAGE = 0x8n | 0x20n; // ADMINISTRATOR | MANAGE_GUILD

cillhub.on('READY', async ({ module, guilds }) => {
  console.info(`Game Server Live Bridge v${module.version} started for ${guilds.length} server(s).`);
  // Rearm recurring health checks and status queries every 60 seconds
  try {
    await cillhub.schedule.every('poll_game_status', 60000);
  } catch (err) {
    console.warn(`Could not set schedule: ${err.message}`);
  }
});

cillhub.on('SCHEDULE', async (schedule) => {
  if (schedule.name !== 'poll_game_status') return;
  const guilds = (await cillhub.guilds.list()) || [];
  for (const g of guilds) {
    try {
      await updateGuildStatus(g.id);
    } catch (err) {
      console.warn(`Error updating status for guild ${g.id}: ${err.message}`);
    }
  }
});

/** Queries server status using public APIs or Web RCON */
async function queryServerStatus(settings) {
  const { server_type, host, port } = settings;
  if (!host) {
    return {
      online: false,
      name: 'Unconfigured Server',
      motd: 'No server host specified in module settings.',
      players: { online: 0, max: 0, list: [] },
      ping: 'N/A',
      type: server_type || 'unknown',
    };
  }

  // 1. Minecraft: Query via public status API
  if (!server_type || server_type === 'minecraft') {
    try {
      const url = `https://api.mcsrvstat.us/3/${encodeURIComponent(host)}:${port || 25565}`;
      const res = await cillhub.http.fetch(url, { headers: { Accept: 'application/json' } });
      if (res.status === 200 && res.json) {
        const d = res.json;
        const playerList = Array.isArray(d.players?.list)
          ? d.players.list.map((p) => (typeof p === 'string' ? p : p.name)).filter(Boolean)
          : [];
        const motd = Array.isArray(d.motd?.clean)
          ? d.motd.clean.join(' ')
          : d.motd?.clean || d.hostname || 'Minecraft Server';

        return {
          online: !!d.online,
          name: d.hostname || host,
          motd,
          players: {
            online: d.players?.online || 0,
            max: d.players?.max || 0,
            list: playerList,
          },
          ping: d.debug?.ping ? `${d.debug.ping} ms` : '20 ms',
          type: 'Minecraft',
        };
      }
    } catch (err) {
      console.warn(`Minecraft query for ${host} failed: ${err.message}`);
    }
  }

  // 2. Rust or Source Engine via Web RCON
  if (server_type === 'rust' || server_type === 'source') {
    try {
      // Query Web RCON /status endpoint
      const targetPort = port || (server_type === 'rust' ? 28016 : 27015);
      const url = `http://${host}:${targetPort}/status`;
      const res = await cillhub.http.fetch(url, {
        headers: {
          Authorization: settings.rcon_password ? `Bearer ${settings.rcon_password}` : '',
        },
      });

      if (res.status === 200 && res.json) {
        const d = res.json;
        return {
          online: true,
          name: d.Hostname || d.name || host,
          motd: d.Description || `${server_type.toUpperCase()} Dedicated Server`,
          players: {
            online: d.Players || d.players || 0,
            max: d.MaxPlayers || d.max_players || 0,
            list: Array.isArray(d.PlayerList) ? d.PlayerList.map((p) => p.DisplayName || p.name || p) : [],
          },
          ping: d.Framerate ? `${Math.round(d.Framerate)} FPS` : 'N/A',
          type: server_type === 'rust' ? 'Rust' : 'Source',
        };
      }
    } catch (err) {
      console.warn(`${server_type} Web RCON query failed: ${err.message}`);
    }
  }

  // Fallback offline state
  return {
    online: false,
    name: host,
    motd: 'Server unreachable or offline.',
    players: { online: 0, max: 0, list: [] },
    ping: 'N/A',
    type: server_type || 'Game Server',
  };
}

/** Formats and publishes or edits the status embed in status_channel_id */
async function updateGuildStatus(guildId) {
  const settings = (await cillhub.settings.get(guildId)) || {};
  if (!settings.status_channel_id || !settings.host) return;

  const data = await queryServerStatus(settings);
  const color = data.online ? 0x2ecc71 : 0xe74c3c;
  const statusEmoji = data.online ? '🟢 Online' : '🔴 Offline';
  const playerList = data.players.list.length > 0 ? data.players.list.join(', ') : data.online ? 'No players online' : 'Server is offline';

  const embed = {
    title: `🎮 ${data.name} — Status`,
    description: data.motd,
    color,
    fields: [
      { name: 'Status', value: statusEmoji, inline: true },
      { name: 'Players', value: `${data.players.online} / ${data.players.max}`, inline: true },
      { name: 'Ping / Performance', value: data.ping, inline: true },
      { name: 'Server Address', value: `\`${settings.host}${settings.port ? `:${settings.port}` : ''}\``, inline: true },
      { name: 'Server Engine', value: data.type, inline: true },
      { name: 'Online Players', value: playerList, inline: false },
    ],
    footer: { text: 'Game Server Live Bridge • Auto-refreshes every minute' },
    timestamp: new Date().toISOString(),
  };

  const msgKey = `status_message:${guildId}`;
  const lastMsgId = await cillhub.storage.get(msgKey);

  let updated = false;
  if (lastMsgId) {
    try {
      await cillhub.messages.edit(settings.status_channel_id, lastMsgId, {
        embeds: [embed],
      });
      updated = true;
    } catch {
      // Message may have been deleted; recreate below
    }
  }

  if (!updated) {
    try {
      const msg = await cillhub.messages.send(settings.status_channel_id, {
        embeds: [embed],
      });
      if (msg?.id) {
        await cillhub.storage.set(msgKey, msg.id);
      }
    } catch (err) {
      console.warn(`Could not send status embed in ${settings.status_channel_id}: ${err.message}`);
    }
  }
}

/** Broadcasts in-game chat message to game server console */
async function broadcastToGameServer(settings, authorName, text) {
  if (!settings.host || !settings.rcon_password) return;

  const cleanAuthor = authorName.replace(/["\\]/g, '');
  const cleanText = text.replace(/["\\]/g, '');
  const type = settings.server_type || 'minecraft';

  let command = `say [Cillhub] ${cleanAuthor}: ${cleanText}`;
  if (type === 'minecraft') {
    // Rich color JSON format for Minecraft
    command = `tellraw @a [{"text":"[Cillhub] ","color":"dark_aqua","bold":true},{"text":"${cleanAuthor}: ","color":"aqua"},{"text":"${cleanText}","color":"white"}]`;
  } else if (type === 'rust') {
    command = `say "[Cillhub] ${cleanAuthor}: ${cleanText}"`;
  }

  try {
    await executeRconCommand(settings, command);
  } catch (err) {
    console.warn(`Failed to broadcast message to game server: ${err.message}`);
  }
}

/** Executes console command via Web RCON or REST API */
async function executeRconCommand(settings, command) {
  const { host, port, rcon_password, server_type } = settings;
  if (!host || !rcon_password) {
    throw new Error('Server host and RCON password must be configured in module settings.');
  }

  // Web RCON JSON-RPC / REST gateway
  const targetPort = port || (server_type === 'rust' ? 28016 : 25575);
  const url = `http://${host}:${targetPort}/rcon`;

  const payload = JSON.stringify({
    Password: rcon_password,
    Command: command,
    Identifier: -1,
  });

  const res = await cillhub.http.fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${rcon_password}`,
    },
    body: payload,
  });

  if (res.status === 200) {
    if (res.json?.Message) return res.json.Message;
    if (res.json?.response) return res.json.response;
    return res.text || 'Command executed successfully.';
  }

  throw new Error(`RCON responded with status HTTP ${res.status}: ${res.text || 'Unknown error'}`);
}

// ------------------- Event Handlers -------------------

// 1. Bidirectional Chat Bridge: Relay Cillhub channel message to in-game chat
cillhub.on('MESSAGE_CREATE', async (message) => {
  // Ignore bot messages, system messages, or messages without content
  if (message.author?.bot || !message.content || !message.guild_id) return;

  const settings = (await cillhub.settings.get(message.guild_id)) || {};
  if (!settings.chat_sync_channel_id || message.channel_id !== settings.chat_sync_channel_id) return;

  const author = message.member?.nick || message.author.global_name || message.author.username;
  await broadcastToGameServer(settings, author, message.content);
});

// 2. Bidirectional Chat Bridge: Relay in-game chat to Cillhub via HTTP webhook
cillhub.on('HTTP_REQUEST', async (req) => {
  // Expected endpoint: POST /modules/game-server-sync/http/chat
  if (req.method !== 'POST') {
    return { status: 405, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const data = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const { player, message, secret, guild_id } = data;

    if (!player || !message) {
      return { status: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Missing player or message' }) };
    }

    // Determine target guild
    const guilds = (await cillhub.guilds.list()) || [];
    let targetGuild = guild_id ? guilds.find((g) => g.id === guild_id) : guilds[0];

    if (!targetGuild) {
      return { status: 404, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'No guild configured for bridge' }) };
    }

    const settings = (await cillhub.settings.get(targetGuild.id)) || {};

    // The webhook needs its own secret (never the RCON password); without one the bridge is closed
    if (!settings.webhook_secret) {
      return { status: 503, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Webhook secret not configured' }) };
    }
    if (typeof secret !== 'string' || !cillhub.crypto.equal(secret, settings.webhook_secret)) {
      return { status: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Invalid secret' }) };
    }

    if (!settings.chat_sync_channel_id) {
      return { status: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Chat sync channel not configured' }) };
    }

    // Post to Cillhub channel
    const tag = (settings.server_type || 'GAME').toUpperCase();
    await cillhub.messages.send(settings.chat_sync_channel_id, {
      content: `**[${tag}] <${player}>** ${message}`,
    });

    return {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true }),
    };
  } catch (err) {
    return {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
});

// 3. Slash Commands: /rcon and /gameserver
cillhub.on('INTERACTION_CREATE', async (interaction) => {
  if (interaction.type !== 2) return; // APPLICATION_COMMAND
  const { name, options } = interaction.data;
  const guildId = interaction.guild_id;
  if (!guildId) return;

  const settings = (await cillhub.settings.get(guildId)) || {};

  // Command: /rcon <command>
  if (name === 'rcon') {
    const member = interaction.member;
    const perms = BigInt(member?.permissions || '0');
    if ((perms & ADMIN_OR_MANAGE) === 0n) {
      return cillhub.interactions.respond(interaction.id, {
        type: 4,
        data: {
          content: '⛔ You must have Administrator or Manage Server permissions to execute RCON commands.',
          flags: 64, // Ephemeral
        },
      });
    }

    const cmdOpt = options?.find((o) => o.name === 'command');
    const command = cmdOpt?.value;
    if (!command) {
      return cillhub.interactions.respond(interaction.id, {
        type: 4,
        data: { content: '⚠️ Please specify a command to execute.', flags: 64 },
      });
    }

    try {
      const output = await executeRconCommand(settings, command);
      const cleanOutput = output.length > 1800 ? output.slice(0, 1800) + '\n... [truncated]' : output;

      return cillhub.interactions.respond(interaction.id, {
        type: 4,
        data: {
          content: `🖥️ **RCON Command:** \`${command}\`\n\`\`\`text\n${cleanOutput}\n\`\`\``,
          flags: 64,
        },
      });
    } catch (err) {
      return cillhub.interactions.respond(interaction.id, {
        type: 4,
        data: {
          content: `❌ **RCON Error:** ${err.message}`,
          flags: 64,
        },
      });
    }
  }

  // Command: /gameserver status
  if (name === 'gameserver') {
    const sub = options?.[0];
    if (sub?.name === 'status') {
      const data = await queryServerStatus(settings);
      const color = data.online ? 0x2ecc71 : 0xe74c3c;
      const statusEmoji = data.online ? '🟢 Online' : '🔴 Offline';
      const playerList = data.players.list.length > 0 ? data.players.list.join(', ') : data.online ? 'No players online' : 'Server is offline';

      return cillhub.interactions.respond(interaction.id, {
        type: 4,
        data: {
          embeds: [
            {
              title: `🎮 ${data.name} — Server Status`,
              description: data.motd,
              color,
              fields: [
                { name: 'Status', value: statusEmoji, inline: true },
                { name: 'Players', value: `${data.players.online} / ${data.players.max}`, inline: true },
                { name: 'Ping / FPS', value: data.ping, inline: true },
                { name: 'Server Address', value: `\`${settings.host}:${settings.port || ''}\``, inline: true },
                { name: 'Engine', value: data.type, inline: true },
                { name: 'Online Players', value: playerList, inline: false },
              ],
            },
          ],
        },
      });
    }
  }
});
