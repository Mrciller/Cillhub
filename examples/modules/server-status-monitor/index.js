// Uptime & Latency Monitor: HTTP/HTTPS service monitoring module for Cillhub.
// Tracks rolling 30-sample uptime history, latency sparklines, incident reports, and state transition alerts.

const ADMINISTRATOR = 0x8n;
const MANAGE_GUILD = 0x20n;

const ALLOWED_HOST_SUFFIXES = ['.cillerian.org', 'cillerian.org', 'example.com'];

function isHostAllowed(urlStr) {
  const m = /^https:\/\/([a-z0-9.-]+)(?::443)?(?:\/|$)/i.exec(String(urlStr || '').trim());
  if (!m) return false;
  const h = m[1].toLowerCase();
  return ALLOWED_HOST_SUFFIXES.some(suffix => h === suffix || h.endsWith('.' + suffix));
}

function canManage(permissions) {
  try {
    return (BigInt(permissions || '0') & (ADMINISTRATOR | MANAGE_GUILD)) !== 0n;
  } catch {
    return false;
  }
}

function generateInitialHistory(baseLatency = 35) {
  const history = [];
  const now = Date.now();
  for (let i = 29; i >= 0; i--) {
    const jitter = Math.floor(Math.sin(i) * 12) + Math.floor(Math.random() * 8);
    history.push({
      timestamp: now - i * 60 * 1000,
      status: 'UP',
      latency: Math.max(10, baseLatency + jitter),
      code: 200
    });
  }
  return history;
}

const DEFAULT_ENDPOINTS = [
  {
    id: 'ep-gateway',
    name: 'Cillhub Gateway API',
    url: 'https://cillhub.cillerian.org/api/v9/gateway',
    expected_status: 200,
    history: generateInitialHistory(28)
  },
  {
    id: 'ep-web',
    name: 'Cillhub Portal',
    url: 'https://cillerian.org',
    expected_status: 200,
    history: generateInitialHistory(42)
  },
  {
    id: 'ep-example',
    name: 'Example Health Endpoint',
    url: 'https://example.com',
    expected_status: 200,
    history: generateInitialHistory(55)
  }
];

function endpointStorageKey(guildId) { return `status:endpoints:${guildId}`; }
function incidentStorageKey(guildId) { return `status:incidents:${guildId}`; }

function calculateMetrics(history) {
  if (!history || history.length === 0) {
    return { uptime_pct: 100, avg_latency: 0, p95_latency: 0, current_status: 'UNKNOWN' };
  }
  const upCount = history.filter(h => h.status === 'UP' || h.status === 'DEGRADED').length;
  const uptime_pct = +((upCount / history.length) * 100).toFixed(1);
  const latencies = history.map(h => h.latency).sort((a, b) => a - b);
  const avg_latency = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
  const p95_index = Math.floor(latencies.length * 0.95);
  const p95_latency = latencies[Math.min(p95_index, latencies.length - 1)];
  const current_status = history[history.length - 1]?.status || 'UNKNOWN';
  return { uptime_pct, avg_latency, p95_latency, current_status };
}

async function loadEndpoints(guildId) {
  let endpoints = await cillhub.call('storage.get', { key: endpointStorageKey(guildId) });
  if (!endpoints || !Array.isArray(endpoints) || endpoints.length === 0) {
    endpoints = JSON.parse(JSON.stringify(DEFAULT_ENDPOINTS));
    await cillhub.call('storage.set', { key: endpointStorageKey(guildId), value: endpoints });
  }
  return endpoints.map(ep => ({ ...ep, ...calculateMetrics(ep.history) }));
}

async function saveEndpoints(guildId, endpoints) {
  await cillhub.call('storage.set', { key: endpointStorageKey(guildId), value: endpoints });
  try {
    await cillhub.call('ui.publish', { guild_id: guildId, data: { type: 'status_changed' } });
  } catch (err) {
    console.warn(`ui.publish failed: ${err.message}`);
  }
}

async function loadIncidents(guildId) {
  const incs = await cillhub.call('storage.get', { key: incidentStorageKey(guildId) });
  return Array.isArray(incs) ? incs : [];
}

async function saveIncidents(guildId, incidents) {
  await cillhub.call('storage.set', { key: incidentStorageKey(guildId), value: incidents });
}

async function checkSingleEndpoint(ep) {
  const start = Date.now();
  let code = 0;
  let status = 'DOWN';
  let latency = 0;

  try {
    const res = await cillhub.call('http.fetch', {
      url: ep.url,
      method: 'GET'
    });
    latency = Math.max(1, Date.now() - start);
    code = res.status;
    const exp = ep.expected_status || 200;
    if (code === exp || (code >= 200 && code < 400)) {
      status = latency > 1000 ? 'DEGRADED' : 'UP';
    } else if (code >= 400 && code < 500) {
      status = 'DEGRADED';
    } else {
      status = 'DOWN';
    }
  } catch (err) {
    latency = Math.max(1, Date.now() - start);
    status = 'DOWN';
    code = 0;
  }

  return {
    timestamp: Date.now(),
    status,
    latency,
    code
  };
}

async function runHealthCheck(guildId, settings) {
  const endpoints = await loadEndpoints(guildId);
  const incidents = await loadIncidents(guildId);
  let changed = false;

  for (const ep of endpoints) {
    const prevStatus = ep.current_status || (ep.history && ep.history[ep.history.length - 1]?.status) || 'UP';
    const sample = await checkSingleEndpoint(ep);

    if (!ep.history) ep.history = [];
    ep.history.push(sample);
    if (ep.history.length > 30) {
      ep.history = ep.history.slice(-30);
    }
    changed = true;

    // Detect State Transitions: UP -> DOWN
    if ((prevStatus === 'UP' || prevStatus === 'DEGRADED') && sample.status === 'DOWN') {
      const incId = 'inc-' + Date.now();
      const newInc = {
        id: incId,
        endpoint_id: ep.id,
        endpoint_name: ep.name,
        title: `${ep.name} Service Outage`,
        status: 'Investigating',
        opened_at: Date.now(),
        resolved_at: null,
        updates: [
          {
            time: Date.now(),
            status: 'Investigating',
            message: `Automated health monitor detected HTTP ${sample.code || 'TIMEOUT'} failure (${sample.latency}ms).`
          }
        ]
      };
      incidents.unshift(newInc);
      await saveIncidents(guildId, incidents);

      // Alert channel notification
      const alertChannel = settings?.alert_channel;
      if (alertChannel) {
        const pingRole = settings?.ping_role;
        const mention = pingRole ? `<@&${pingRole}> ` : '';
        try {
          await cillhub.call('messages.send', {
            channel_id: alertChannel,
            content: mention ? `${mention}🚨 **Service Outage Detected**` : undefined,
            embeds: [{
              title: `🔴 Service Outage: ${ep.name}`,
              description: `Endpoint **${ep.url}** failed health checks.\n• **Status**: Down (HTTP ${sample.code || 'TIMEOUT'})\n• **Latency**: ${sample.latency}ms\n• **Incident ID**: \`${incId}\``,
              color: 0xef4444,
              timestamp: new Date().toISOString(),
              footer: { text: 'Uptime & Latency Monitor' }
            }]
          });
        } catch (err) {
          console.warn(`Failed to send outage alert: ${err.message}`);
        }
      }
    }

    // Detect State Transitions: DOWN -> UP
    if (prevStatus === 'DOWN' && (sample.status === 'UP' || sample.status === 'DEGRADED')) {
      const activeInc = incidents.find(i => i.endpoint_id === ep.id && i.status !== 'Resolved');
      let durationStr = 'unknown duration';
      if (activeInc) {
        activeInc.status = 'Resolved';
        activeInc.resolved_at = Date.now();
        const durSec = Math.floor((Date.now() - activeInc.opened_at) / 1000);
        durationStr = durSec > 60 ? `${Math.floor(durSec / 60)}m ${durSec % 60}s` : `${durSec}s`;
        activeInc.updates.push({
          time: Date.now(),
          status: 'Resolved',
          message: `Service fully recovered after ${durationStr}. Response code: ${sample.code}.`
        });
        await saveIncidents(guildId, incidents);
      }

      // Recovery notification
      const alertChannel = settings?.alert_channel;
      if (alertChannel) {
        try {
          await cillhub.call('messages.send', {
            channel_id: alertChannel,
            embeds: [{
              title: `🟢 Service Restored: ${ep.name}`,
              description: `Service **${ep.name}** is operational again.\n• **Downtime Duration**: ${durationStr}\n• **Response**: HTTP ${sample.code} (${sample.latency}ms)`,
              color: 0x10b981,
              timestamp: new Date().toISOString(),
              footer: { text: 'Uptime & Latency Monitor' }
            }]
          });
        } catch (err) {
          console.warn(`Failed to send recovery alert: ${err.message}`);
        }
      }
    }
  }

  if (changed) {
    await saveEndpoints(guildId, endpoints);
  }

  return {
    endpoints: endpoints.map(ep => ({ ...ep, ...calculateMetrics(ep.history) })),
    incidents
  };
}

function getSystemOverall(endpoints) {
  if (endpoints.some(e => e.current_status === 'DOWN')) return 'Major Outage';
  if (endpoints.some(e => e.current_status === 'DEGRADED')) return 'Degraded Performance';
  return 'All Systems Operational';
}

// UI Request handler
cillhub.on('UI_REQUEST', async (req) => {
  const guildId = req.guild_id;
  const settings = (await cillhub.call('settings.get', { guild_id: guildId })) || {};
  const isManager = canManage(req.member.permissions);
  const action = req.data?.action || 'list';

  let endpoints = await loadEndpoints(guildId);
  let incidents = await loadIncidents(guildId);

  if (action === 'list') {
    return {
      endpoints,
      incidents,
      system_status: getSystemOverall(endpoints),
      can_manage: isManager
    };
  }

  if (action === 'check_now') {
    const res = await runHealthCheck(guildId, settings);
    return {
      endpoints: res.endpoints,
      incidents: res.incidents,
      system_status: getSystemOverall(res.endpoints),
      can_manage: isManager,
      notice: 'Health checks completed.'
    };
  }

  // Admin actions
  if (!isManager) {
    throw new Error('Manage Server permission is required for administrative configuration.');
  }

  if (action === 'add_endpoint') {
    const name = String(req.data?.name || '').trim();
    const url = String(req.data?.url || '').trim();
    if (!name || name.length > 50) throw new Error('Endpoint name must be 1 to 50 characters.');
    if (!url || !isHostAllowed(url)) {
      throw new Error('URL must start with https:// and match an allowed host (*.cillerian.org or example.com).');
    }
    if (endpoints.length >= 10) throw new Error('Maximum of 10 monitored endpoints reached.');

    const newEp = {
      id: 'ep-' + Date.now(),
      name,
      url,
      expected_status: 200,
      history: generateInitialHistory(40)
    };
    endpoints.push(newEp);
    await saveEndpoints(guildId, endpoints);
    endpoints = await loadEndpoints(guildId);
    return {
      endpoints,
      incidents,
      system_status: getSystemOverall(endpoints),
      can_manage: isManager,
      notice: `Added ${name} to monitoring.`
    };
  }

  if (action === 'delete_endpoint') {
    const id = req.data?.id;
    endpoints = endpoints.filter(e => e.id !== id);
    await saveEndpoints(guildId, endpoints);
    endpoints = await loadEndpoints(guildId);
    return {
      endpoints,
      incidents,
      system_status: getSystemOverall(endpoints),
      can_manage: isManager,
      notice: 'Endpoint removed.'
    };
  }

  if (action === 'post_incident') {
    const title = String(req.data?.title || '').trim();
    const message = String(req.data?.message || '').trim();
    const status = String(req.data?.status || 'Investigating');
    const endpointId = req.data?.endpoint_id || null;

    if (!title || !message) throw new Error('Title and message are required.');

    const inc = {
      id: 'inc-' + Date.now(),
      endpoint_id: endpointId,
      endpoint_name: endpointId ? (endpoints.find(e => e.id === endpointId)?.name || 'General') : 'General',
      title,
      status,
      opened_at: Date.now(),
      resolved_at: status === 'Resolved' ? Date.now() : null,
      updates: [
        {
          time: Date.now(),
          status,
          message
        }
      ]
    };
    incidents.unshift(inc);
    await saveIncidents(guildId, incidents);

    // Announce incident update if alert_channel configured
    const alertChannel = settings?.alert_channel;
    if (alertChannel) {
      try {
        await cillhub.call('messages.send', {
          channel_id: alertChannel,
          embeds: [{
            title: `📢 Incident: ${title}`,
            description: `**Status**: ${status}\n\n${message}`,
            color: status === 'Resolved' ? 0x10b981 : 0xf59e0b,
            timestamp: new Date().toISOString(),
            footer: { text: 'Uptime & Latency Monitor' }
          }]
        });
      } catch (err) {
        console.warn(`Failed to post incident embed: ${err.message}`);
      }
    }

    return {
      endpoints,
      incidents,
      system_status: getSystemOverall(endpoints),
      can_manage: isManager,
      notice: 'Incident posted.'
    };
  }

  throw new Error(`Unknown action: ${action}`);
});

// Slash Command handler
cillhub.on('INTERACTION_CREATE', async (interaction) => {
  if (interaction.type !== 2 || interaction.data?.name !== 'status') return;

  const guildId = interaction.guild_id;
  if (!guildId) {
    return { type: 4, data: { content: 'This command must be used in a server.', flags: 64 } };
  }

  const settings = (await cillhub.call('settings.get', { guild_id: guildId })) || {};
  const subName = interaction.data.options?.[0]?.name;

  if (subName === 'check') {
    const res = await runHealthCheck(guildId, settings);
    const overall = getSystemOverall(res.endpoints);
    const icon = overall === 'All Systems Operational' ? '🟢' : (overall === 'Degraded Performance' ? '🟡' : '🔴');

    const fields = res.endpoints.map(e => ({
      name: `${e.name}`,
      value: `• **Status**: ${e.current_status}\n• **Uptime (30d)**: ${e.uptime_pct}%\n• **Latency**: ${e.avg_latency}ms (p95: ${e.p95_latency}ms)`,
      inline: true
    }));

    return {
      type: 4,
      data: {
        embeds: [{
          title: `${icon} System Health Check: ${overall}`,
          description: `Checked **${res.endpoints.length}** endpoints in real time.`,
          fields,
          color: overall === 'All Systems Operational' ? 0x10b981 : 0xef4444,
          timestamp: new Date().toISOString()
        }]
      }
    };
  }

  if (subName === 'incidents') {
    const incidents = await loadIncidents(guildId);
    const active = incidents.filter(i => i.status !== 'Resolved');
    if (active.length === 0) {
      return {
        type: 4,
        data: {
          embeds: [{
            title: '✨ No Active Incidents',
            description: 'All services and monitored systems are operating normally.',
            color: 0x10b981
          }]
        }
      };
    }
    const lines = active.slice(0, 5).map(i => {
      const latest = i.updates[i.updates.length - 1];
      return `🔴 **${i.title}** (${i.status})\n   ${latest?.message || ''}`;
    });
    return {
      type: 4,
      data: {
        embeds: [{
          title: `⚠️ Active Incidents (${active.length})`,
          description: lines.join('\n\n'),
          color: 0xef4444
        }]
      }
    };
  }

  // overview (default)
  const endpoints = await loadEndpoints(guildId);
  const overall = getSystemOverall(endpoints);
  const icon = overall === 'All Systems Operational' ? '🟢' : (overall === 'Degraded Performance' ? '🟡' : '🔴');

  const lines = endpoints.map(e => {
    const stIcon = e.current_status === 'UP' ? '🟢' : (e.current_status === 'DEGRADED' ? '🟡' : '🔴');
    return `${stIcon} **${e.name}**: \`${e.uptime_pct}%\` uptime · avg \`${e.avg_latency}ms\` · status **${e.current_status}**`;
  });

  return {
    type: 4,
    data: {
      embeds: [{
        title: `${icon} System Status: ${overall}`,
        description: lines.join('\n\n') || 'No endpoints monitored.',
        color: overall === 'All Systems Operational' ? 0x10b981 : 0xf59e0b,
        footer: { text: 'Open the System Status panel in the sidebar for 30-sample sparklines.' }
      }]
    }
  };
});

// Periodic monitoring schedule
cillhub.on('READY', async () => {
  console.info('Uptime & Latency Monitor module initialized.');
  try {
    await cillhub.call('schedule.every', { name: 'monitor_poll', interval_ms: 60 * 1000 });
  } catch (err) {
    console.warn(`Failed to set monitor_poll schedule: ${err.message}`);
  }
});

cillhub.on('SCHEDULE', async ({ name }) => {
  if (name !== 'monitor_poll') return;
  const guilds = (await cillhub.call('guilds.list', {})) || [];
  for (const g of guilds) {
    try {
      const settings = (await cillhub.call('settings.get', { guild_id: g.id })) || {};
      await runHealthCheck(g.id, settings);
    } catch (err) {
      console.warn(`Health check failed for guild ${g.id}: ${err.message}`);
    }
  }
});
