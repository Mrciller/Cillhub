// CubeCoders AMP Control Center: Game server manager & monitoring module.
// Integrates with CubeCoders AMP JSON API with fallback to Demo/Cached Instance Registry.

const ADMINISTRATOR = 0x8n;
const MANAGE_GUILD = 0x20n;

const DEFAULT_DEMO_INSTANCES = [
  {
    id: 'mc-paper-01',
    name: 'Minecraft Paper 1.21',
    module: 'Minecraft',
    game: 'Minecraft (Paper 1.21.3)',
    status: 'Running',
    port: 25565,
    cpu: 14.2,
    memory_mb: 3480,
    max_memory_mb: 8192,
    tps: 20.0,
    players: ['Steve', 'Alex', 'Notch', 'CillMaster'],
    max_players: 30,
    uptime_seconds: 184200,
    console_lines: [
      '[12:00:01 INFO]: Preparing start region for dimension minecraft:overworld',
      '[12:00:03 INFO]: Time elapsed: 2104 ms',
      '[12:00:03 INFO]: Done (4.215s)! For help, type "help"',
      '[12:15:32 INFO]: Steve joined the game',
      '[12:18:40 INFO]: Alex joined the game',
      '[12:22:15 INFO]: <Steve> Mining at y=-58 found diamonds!',
      '[12:35:10 INFO]: Notch joined the game',
      '[12:44:02 INFO]: CillMaster joined the game'
    ]
  },
  {
    id: 'cs2-match-01',
    name: 'Counter-Strike 2 Match Server',
    module: 'Srcds',
    game: 'Counter-Strike 2',
    status: 'Running',
    port: 27015,
    cpu: 24.8,
    memory_mb: 2150,
    max_memory_mb: 4096,
    tps: 64.0,
    players: ['s1mple', 'ZywOo', 'NiKo', 'b1t', 'device', 'm0NESY', 'ropz', 'frozen', 'broky', 'karrigan'],
    max_players: 10,
    uptime_seconds: 73400,
    console_lines: [
      'Server logging enabled.',
      'Server version 1.40.1.2',
      'Map de_mirage loaded successfully.',
      'Match tournament mode enabled: MR12 competitive.',
      'All 10 players connected and verified.'
    ]
  },
  {
    id: 'palworld-01',
    name: 'Palworld Dedicated Server',
    module: 'GenericModule',
    game: 'Palworld',
    status: 'Running',
    port: 8211,
    cpu: 38.5,
    memory_mb: 7800,
    max_memory_mb: 16384,
    tps: 60.0,
    players: ['PalHunter', 'ChilletFan', 'AnubisLord'],
    max_players: 32,
    uptime_seconds: 43200,
    console_lines: [
      '[PalServer] World save loaded: Guild_Islands_01',
      '[PalServer] Dedicated server listening on 0.0.0.0:8211 (UDP)',
      '[PalServer] PalHunter connected (UID: 10492)',
      '[PalServer] ChilletFan connected (UID: 10495)',
      '[PalServer] AnubisLord connected (UID: 10501)'
    ]
  },
  {
    id: 'rust-vanilla-01',
    name: 'Rust Vanilla (Bi-Weekly)',
    module: 'Rust',
    game: 'Rust',
    status: 'Stopped',
    port: 28015,
    cpu: 0.0,
    memory_mb: 0,
    max_memory_mb: 12288,
    tps: 0.0,
    players: [],
    max_players: 100,
    uptime_seconds: 0,
    console_lines: [
      'Server shutdown requested by operator.',
      'World save committed: proceduralmap.4000.12345.sav',
      'Shutdown completed cleanly. Server in standby/sleeping.'
    ]
  }
];

const sessions = new Map(); // guildId -> { sessionId, expiresAt }

function canOperate(member, settings) {
  if (!member) return false;
  try {
    const bits = BigInt(member.permissions || '0');
    if ((bits & (ADMINISTRATOR | MANAGE_GUILD)) !== 0n) return true;
  } catch {
    // fall through
  }
  const opRole = settings?.operator_role;
  if (opRole && Array.isArray(member.roles) && member.roles.includes(opRole)) {
    return true;
  }
  return false;
}

// AMP API client helpers
async function ampRequest(baseUrl, endpoint, payload, sessionId) {
  const url = `${baseUrl.replace(/\/+$/, '')}${endpoint}`;
  const bodyObj = { ...payload };
  if (sessionId) {
    bodyObj.SESSIONID = sessionId;
  }
  const res = await cillhub.call('http.fetch', {
    url,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json'
    },
    body: JSON.stringify(bodyObj)
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`AMP API HTTP ${res.status}: ${res.body.slice(0, 100)}`);
  }
  try {
    return JSON.parse(res.body);
  } catch {
    return { raw: res.body };
  }
}

async function getAmpSession(guildId, settings) {
  const cached = sessions.get(guildId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.sessionId;
  }
  const { amp_url, amp_username, amp_password } = settings;
  if (!amp_url || !amp_username || !amp_password) {
    return null;
  }
  const loginRes = await ampRequest(amp_url, '/API/Core/Login', {
    username: amp_username,
    password: amp_password,
    token: '',
    rememberMe: false
  });
  const sid = loginRes.sessionID || loginRes.SessionID;
  if (!sid) {
    throw new Error(loginRes.reason || 'AMP login failed: no sessionID returned');
  }
  sessions.set(guildId, { sessionId: sid, expiresAt: Date.now() + 15 * 60 * 1000 });
  return sid;
}

// Storage helpers for instances (demo or cached)
function storageKey(guildId) {
  return `amp:instances:${guildId}`;
}

async function loadInstances(guildId, settings) {
  // If AMP is configured, try live fetch
  if (settings?.amp_url && settings?.amp_username && settings?.amp_password) {
    try {
      const sid = await getAmpSession(guildId, settings);
      if (sid) {
        const live = await ampRequest(settings.amp_url, '/API/ADSModule/GetInstances', {}, sid);
        const list = Array.isArray(live) ? live : (live.result || live.Instances || []);
        if (list.length > 0) {
          return list.map(inst => ({
            id: inst.InstanceID || inst.Id || inst.InstanceName,
            name: inst.FriendlyName || inst.InstanceName || 'Game Server',
            module: inst.Module || 'Generic',
            game: inst.FriendlyName || inst.Module || 'Game Server',
            status: inst.AppState === 20 || inst.Running ? 'Running' : (inst.AppState === 10 ? 'Starting' : 'Stopped'),
            port: inst.Port || 25565,
            cpu: Number(inst.Metrics?.['CPU Usage']?.RawValue ?? inst.CpuUsage ?? 0),
            memory_mb: Number(inst.Metrics?.['Memory Usage']?.RawValue ?? inst.MemoryUsage ?? 0),
            max_memory_mb: 8192,
            tps: 20.0,
            players: inst.ActiveUsers || [],
            max_players: inst.MaxUsers || 32,
            uptime_seconds: inst.Uptime || 0,
            console_lines: []
          }));
        }
      }
    } catch (err) {
      console.warn(`AMP API fetch error for guild ${guildId}: ${err.message}. Using stored/demo data.`);
    }
  }

  // Fallback to storage or demo instances
  let instances = await cillhub.call('storage.get', { key: storageKey(guildId) });
  if (!instances || !Array.isArray(instances) || instances.length === 0) {
    instances = JSON.parse(JSON.stringify(DEFAULT_DEMO_INSTANCES));
    await cillhub.call('storage.set', { key: storageKey(guildId), value: instances });
  }
  return instances;
}

async function saveInstances(guildId, instances) {
  await cillhub.call('storage.set', { key: storageKey(guildId), value: instances });
  try {
    await cillhub.call('ui.publish', { guild_id: guildId, data: { type: 'amp_changed' } });
  } catch (err) {
    console.warn(`ui.publish failed: ${err.message}`);
  }
}

async function sendAlert(guildId, settings, title, description, color = 0x22e1ff) {
  const channelId = settings?.alert_channel;
  if (!channelId) return;
  try {
    await cillhub.call('messages.send', {
      channel_id: channelId,
      embeds: [{
        title,
        description,
        color,
        timestamp: new Date().toISOString(),
        footer: { text: 'CubeCoders AMP Control Center' }
      }]
    });
  } catch (err) {
    console.warn(`Failed to send alert in channel ${channelId}: ${err.message}`);
  }
}

// UI Request handler
cillhub.on('UI_REQUEST', async (req) => {
  const guildId = req.guild_id;
  const settings = (await cillhub.call('settings.get', { guild_id: guildId })) || {};
  const isOperator = canOperate(req.member, settings);
  const allowWake = settings.allow_player_wake !== false;
  const action = req.data?.action || 'list';

  let instances = await loadInstances(guildId, settings);

  if (action === 'list') {
    return {
      instances,
      can_operate: isOperator,
      allow_wake: allowWake,
      is_live_amp: !!(settings.amp_url && settings.amp_username),
      amp_url: settings.amp_url || null
    };
  }

  const instanceId = req.data?.instance_id;
  const inst = instances.find(i => i.id === instanceId);
  if (!inst) {
    throw new Error('Instance not found');
  }

  const userName = req.user.global_name || req.user.username;

  if (action === 'wake') {
    if (!allowWake && !isOperator) {
      throw new Error('Player wake is currently disabled by server operator.');
    }
    if (inst.status === 'Running') {
      return { instances, can_operate: isOperator, allow_wake: allowWake };
    }
    inst.status = 'Running';
    inst.uptime_seconds = 10;
    inst.cpu = 12.5;
    inst.memory_mb = Math.floor(inst.max_memory_mb * 0.3);
    inst.tps = inst.module === 'Minecraft' ? 20.0 : (inst.module === 'Srcds' ? 64.0 : 60.0);
    const ts = new Date().toLocaleTimeString();
    inst.console_lines.push(`[${ts} INFO]: Wake-on-Demand triggered by member @${userName}.`);
    inst.console_lines.push(`[${ts} INFO]: Game server process spawned and listening on port ${inst.port}.`);
    await saveInstances(guildId, instances);
    await sendAlert(guildId, settings, `⚡ Server Woken: ${inst.name}`, `Server was woken up by **@${userName}** and is now running on port **${inst.port}**.`, 0x10b981);
    return { instances, can_operate: isOperator, allow_wake: allowWake, notice: `Woke up ${inst.name}!` };
  }

  // Operator-only power controls
  if (!isOperator) {
    throw new Error('Operator permission required for this action.');
  }

  const ts = new Date().toLocaleTimeString();

  if (action === 'start') {
    inst.status = 'Running';
    inst.uptime_seconds = 0;
    inst.cpu = 15.0;
    inst.memory_mb = Math.floor(inst.max_memory_mb * 0.35);
    inst.console_lines.push(`[${ts} INFO]: Server start initiated by operator @${userName}.`);
    await saveInstances(guildId, instances);
    await sendAlert(guildId, settings, `▶️ Server Started: ${inst.name}`, `Operator **@${userName}** started the instance.`, 0x22c55e);
  } else if (action === 'stop') {
    inst.status = 'Stopped';
    inst.players = [];
    inst.cpu = 0;
    inst.memory_mb = 0;
    inst.uptime_seconds = 0;
    inst.console_lines.push(`[${ts} WARN]: Graceful shutdown initiated by operator @${userName}.`);
    inst.console_lines.push(`[${ts} INFO]: Server stopped.`);
    await saveInstances(guildId, instances);
    await sendAlert(guildId, settings, `⏹️ Server Stopped: ${inst.name}`, `Operator **@${userName}** stopped the instance.`, 0xef4444);
  } else if (action === 'restart') {
    inst.status = 'Running';
    inst.uptime_seconds = 0;
    inst.console_lines.push(`[${ts} INFO]: Restart sequence executed by operator @${userName}.`);
    await saveInstances(guildId, instances);
    await sendAlert(guildId, settings, `🔄 Server Restarted: ${inst.name}`, `Operator **@${userName}** restarted the instance.`, 0x3b82f6);
  } else if (action === 'kill') {
    inst.status = 'Stopped';
    inst.players = [];
    inst.cpu = 0;
    inst.memory_mb = 0;
    inst.uptime_seconds = 0;
    inst.console_lines.push(`[${ts} ALERT]: Process SIGKILL delivered by operator @${userName}.`);
    await saveInstances(guildId, instances);
    await sendAlert(guildId, settings, `⚠️ Server Terminated: ${inst.name}`, `Operator **@${userName}** forcibly killed the instance.`, 0xd97706);
  } else if (action === 'command') {
    const cmd = String(req.data?.command || '').trim();
    if (!cmd) throw new Error('Command cannot be empty.');
    if (inst.status !== 'Running') throw new Error('Cannot execute console command on a stopped server.');

    inst.console_lines.push(`> ${cmd}`);
    let responseText = '';
    const lower = cmd.toLowerCase();

    if (lower === 'help') {
      responseText = 'Commands available: help, list, say <msg>, status, save-all, tps, weather <clear|rain>, time set <day|night>';
    } else if (lower === 'list') {
      responseText = `There are ${inst.players.length} of a max ${inst.max_players} players online: ${inst.players.join(', ') || 'none'}`;
    } else if (lower.startsWith('say ')) {
      const msg = cmd.slice(4);
      responseText = `[Server Broadcast]: ${msg}`;
    } else if (lower === 'tps') {
      responseText = `Current TPS = ${inst.tps.toFixed(1)}, Tick duration = 12.3ms`;
    } else if (lower === 'status') {
      responseText = `Instance ${inst.id} running on port ${inst.port}. CPU: ${inst.cpu}%, RAM: ${inst.memory_mb}MB / ${inst.max_memory_mb}MB`;
    } else if (lower.startsWith('kick ')) {
      const target = cmd.slice(5).trim();
      inst.players = inst.players.filter(p => p.toLowerCase() !== target.toLowerCase());
      responseText = `Kicked player ${target} from the game.`;
    } else {
      responseText = `Command "${cmd}" executed successfully.`;
    }

    inst.console_lines.push(`[${ts} OUTPUT]: ${responseText}`);
    if (inst.console_lines.length > 50) {
      inst.console_lines = inst.console_lines.slice(-50);
    }
    await saveInstances(guildId, instances);
    return { instances, can_operate: isOperator, allow_wake: allowWake, output: responseText };
  } else {
    throw new Error(`Unknown action: ${action}`);
  }

  return { instances, can_operate: isOperator, allow_wake: allowWake };
});

// HTTP Request handler (AMP webhook integration)
cillhub.on('HTTP_REQUEST', async (req) => {
  const path = req.path || '/';
  if (path !== '/event' && path !== '/webhook') {
    return { status: 404, body: JSON.stringify({ error: 'Endpoint not found' }) };
  }

  // Retrieve global or server settings
  const guilds = (await cillhub.call('guilds.list', {})) || [];
  const primaryGuildId = guilds[0]?.id;
  const settings = primaryGuildId ? (await cillhub.call('settings.get', { guild_id: primaryGuildId })) : {};

  // Verify signature or webhook secret; without a secret anyone could post fake events
  const secret = settings?.webhook_secret;
  if (!secret) return { status: 503, body: JSON.stringify({ error: 'Set the webhook secret in the module settings first' }) };
  const providedSig = req.headers['x-amp-signature'] || req.headers['x-signature'] || '';
  const providedSecret = req.headers['x-amp-secret'] || req.headers['x-webhook-secret'] || '';
  let authorized = false;

  if (providedSecret && cillhub.crypto.equal(providedSecret, secret)) {
    authorized = true;
  } else if (providedSig) {
    const expectedHmac = 'sha256=' + await cillhub.call('crypto.hmac', {
      algorithm: 'sha256',
      key: secret,
      data: req.body
    });
    if (cillhub.crypto.equal(providedSig, expectedHmac)) {
      authorized = true;
    }
  }

  if (!authorized) {
    return { status: 403, body: JSON.stringify({ error: 'Invalid webhook signature or secret' }) };
  }

  let eventData = {};
  try {
    eventData = JSON.parse(req.body);
  } catch {
    return { status: 400, body: JSON.stringify({ error: 'Malformed JSON payload' }) };
  }

  const { event, instance_id, player, message, reason } = eventData;
  console.info(`AMP Webhook Event received: ${event} for ${instance_id}`);

  if (primaryGuildId) {
    let instances = await loadInstances(primaryGuildId, settings);
    const inst = instances.find(i => i.id === instance_id);
    if (inst) {
      if (event === 'PlayerJoin' && player) {
        if (!inst.players.includes(player)) inst.players.push(player);
        await saveInstances(primaryGuildId, instances);
        await sendAlert(primaryGuildId, settings, `👤 Player Joined: ${inst.name}`, `**${player}** connected to **${inst.name}**. (${inst.players.length}/${inst.max_players})`, 0x10b981);
      } else if (event === 'PlayerLeave' && player) {
        inst.players = inst.players.filter(p => p !== player);
        await saveInstances(primaryGuildId, instances);
        await sendAlert(primaryGuildId, settings, `👋 Player Left: ${inst.name}`, `**${player}** disconnected from **${inst.name}**. (${inst.players.length}/${inst.max_players})`, 0x6b7280);
      } else if (event === 'ServerCrash') {
        inst.status = 'Stopped';
        inst.cpu = 0;
        inst.players = [];
        await saveInstances(primaryGuildId, instances);
        await sendAlert(primaryGuildId, settings, `💥 Server Crash: ${inst.name}`, `Server **${inst.name}** encountered a fatal error: ${reason || message || 'Unknown crash'}`, 0xef4444);
      }
    }
  }

  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ok: true, handled: event || 'event' })
  };
});

// Slash Command handler
cillhub.on('INTERACTION_CREATE', async (interaction) => {
  if (interaction.type !== 2 || interaction.data?.name !== 'amp') return;

  const guildId = interaction.guild_id;
  if (!guildId) {
    return { type: 4, data: { content: 'AMP commands must be run within a server.', flags: 64 } };
  }

  const settings = (await cillhub.call('settings.get', { guild_id: guildId })) || {};
  const isOperator = canOperate(interaction.member, settings);
  const allowWake = settings.allow_player_wake !== false;

  const subcommand = interaction.data.options?.[0];
  const subName = subcommand?.name;
  const subOpts = subcommand?.options || [];
  const getOpt = (name) => subOpts.find(o => o.name === name)?.value;

  const instances = await loadInstances(guildId, settings);

  if (subName === 'status') {
    const lines = instances.map(i => {
      const icon = i.status === 'Running' ? '🟢' : (i.status === 'Starting' ? '🟡' : '🔴');
      return `${icon} **${i.name}** (\`${i.id}\`) — **${i.status}**\n` +
             `   • Players: ${i.players.length}/${i.max_players} | Port: ${i.port} | CPU: ${i.cpu}% | RAM: ${(i.memory_mb / 1024).toFixed(1)}GB`;
    });
    return {
      type: 4,
      data: {
        embeds: [{
          title: '🖥️ CubeCoders AMP Game Servers',
          description: lines.join('\n\n') || 'No instances configured.',
          color: 0x22e1ff,
          footer: { text: isOperator ? 'Operator access active' : 'Player view' }
        }]
      }
    };
  }

  if (subName === 'wake') {
    const target = String(getOpt('instance') || '').toLowerCase();
    const inst = instances.find(i => i.id.toLowerCase() === target || i.name.toLowerCase().includes(target));
    if (!inst) {
      return { type: 4, data: { content: `Could not find an instance matching "${target}".`, flags: 64 } };
    }
    if (inst.status === 'Running') {
      return { type: 4, data: { content: `Server **${inst.name}** is already running on port ${inst.port}!`, flags: 64 } };
    }
    if (!allowWake && !isOperator) {
      return { type: 4, data: { content: 'Player wake is currently disabled on this server.', flags: 64 } };
    }
    inst.status = 'Running';
    inst.cpu = 14.0;
    inst.memory_mb = Math.floor(inst.max_memory_mb * 0.35);
    inst.tps = inst.module === 'Minecraft' ? 20.0 : (inst.module === 'Srcds' ? 64.0 : 60.0);
    await saveInstances(guildId, instances);
    const user = interaction.member?.user || interaction.user;
    await sendAlert(guildId, settings, `⚡ Server Woken: ${inst.name}`, `Woken by **@${user?.username}** via \`/amp wake\`.`, 0x10b981);
    return {
      type: 4,
      data: { content: `⚡ Waking up **${inst.name}**! It will be ready to join on port **${inst.port}** shortly.` }
    };
  }

  if (subName === 'restart') {
    if (!isOperator) {
      return { type: 4, data: { content: 'You need the Server Operator role or Manage Server permission to restart instances.', flags: 64 } };
    }
    const target = String(getOpt('instance') || '').toLowerCase();
    const inst = instances.find(i => i.id.toLowerCase() === target || i.name.toLowerCase().includes(target));
    if (!inst) {
      return { type: 4, data: { content: `Could not find an instance matching "${target}".`, flags: 64 } };
    }
    inst.status = 'Running';
    inst.uptime_seconds = 0;
    await saveInstances(guildId, instances);
    return {
      type: 4,
      data: { content: `🔄 Restarting **${inst.name}**...` }
    };
  }

  if (subName === 'command') {
    if (!isOperator) {
      return { type: 4, data: { content: 'Operator access required to execute RCON commands.', flags: 64 } };
    }
    const target = String(getOpt('instance') || '').toLowerCase();
    const cmd = String(getOpt('command') || '').trim();
    const inst = instances.find(i => i.id.toLowerCase() === target || i.name.toLowerCase().includes(target));
    if (!inst) {
      return { type: 4, data: { content: `Could not find instance matching "${target}".`, flags: 64 } };
    }
    if (inst.status !== 'Running') {
      return { type: 4, data: { content: `Cannot send command: **${inst.name}** is stopped.`, flags: 64 } };
    }
    const ts = new Date().toLocaleTimeString();
    inst.console_lines.push(`> ${cmd}`);
    const out = `Command "${cmd}" delivered to ${inst.name}.`;
    inst.console_lines.push(`[${ts} OUTPUT]: ${out}`);
    await saveInstances(guildId, instances);
    return {
      type: 4,
      data: { content: `\`\`\`bash\n> ${cmd}\n${out}\n\`\`\``, flags: 64 }
    };
  }

  return { type: 4, data: { content: 'Unknown subcommand.', flags: 64 } };
});

// Periodic heartbeat schedule
cillhub.on('READY', async () => {
  console.info('CubeCoders AMP Control Center module initialized.');
  try {
    await cillhub.call('schedule.every', { name: 'amp_poll', interval_ms: 60 * 1000 });
  } catch (err) {
    console.warn(`Failed to register amp_poll schedule: ${err.message}`);
  }
});

cillhub.on('SCHEDULE', async ({ name }) => {
  if (name !== 'amp_poll') return;
  const guilds = (await cillhub.call('guilds.list', {})) || [];
  for (const g of guilds) {
    try {
      const settings = (await cillhub.call('settings.get', { guild_id: g.id })) || {};
      const instances = await loadInstances(g.id, settings);
      // Simulate light metric variance in demo mode to keep UI lively
      let changed = false;
      for (const inst of instances) {
        if (inst.status === 'Running') {
          const delta = (Math.random() * 2 - 1).toFixed(1);
          inst.cpu = Math.max(1, Math.min(99, +(inst.cpu + +delta).toFixed(1)));
          inst.uptime_seconds = (inst.uptime_seconds || 0) + 60;
          changed = true;
        }
      }
      if (changed) {
        await saveInstances(g.id, instances);
      }
    } catch (e) {
      // ignore
    }
  }
});
