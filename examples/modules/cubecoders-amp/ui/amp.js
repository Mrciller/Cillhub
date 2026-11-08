// CubeCoders AMP Control Center Panel UI script
let ctx = null;
let currentInstances = [];
let isOperator = false;
let allowWake = true;
let activeConsoleInstance = null;

const gridEl = document.getElementById('instances-grid');
const noticeEl = document.getElementById('notice-banner');
const connStatusEl = document.getElementById('connection-status');
const serverCountEl = document.getElementById('server-count-badge');
const refreshBtn = document.getElementById('btn-refresh');

// Console Drawer elements
const consoleDrawer = document.getElementById('console-drawer');
const consoleTitle = document.getElementById('console-instance-name');
const consoleOutput = document.getElementById('console-output');
const consoleInput = document.getElementById('console-input');
const sendCmdBtn = document.getElementById('btn-send-cmd');
const closeConsoleBtn = document.getElementById('btn-close-console');

function showNotice(text, isError = false) {
  if (!text) {
    noticeEl.hidden = true;
    noticeEl.textContent = '';
    return;
  }
  noticeEl.hidden = false;
  noticeEl.textContent = text;
  noticeEl.classList.toggle('error', isError);
  if (!isError) {
    setTimeout(() => { noticeEl.hidden = true; }, 5000);
  }
}

function getGameEmoji(gameModule) {
  switch (gameModule) {
    case 'Minecraft': return '⛏️';
    case 'Srcds': return '🎯';
    case 'GenericModule': return '🐾';
    case 'Rust': return '☢️';
    default: return '🎮';
  }
}

function formatUptime(seconds) {
  if (!seconds || seconds <= 0) return 'Offline';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function render() {
  serverCountEl.textContent = `${currentInstances.length} Server${currentInstances.length === 1 ? '' : 's'}`;
  gridEl.replaceChildren();

  if (currentInstances.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No game servers found in AMP registry.';
    gridEl.append(empty);
    return;
  }

  for (const inst of currentInstances) {
    const card = document.createElement('div');
    card.className = 'server-card';

    // Top Header
    const top = document.createElement('div');
    top.className = 'card-top';

    const titleGroup = document.createElement('div');
    titleGroup.className = 'game-title-group';

    const icon = document.createElement('div');
    icon.className = 'game-icon';
    icon.textContent = getGameEmoji(inst.module);

    const titleTexts = document.createElement('div');
    const sName = document.createElement('div');
    sName.className = 'server-name';
    sName.textContent = inst.name;

    const sGame = document.createElement('div');
    sGame.className = 'server-game';
    sGame.textContent = `${inst.game} • Port ${inst.port}`;

    titleTexts.append(sName, sGame);
    titleGroup.append(icon, titleTexts);

    const statusPill = document.createElement('div');
    const stLower = (inst.status || 'stopped').toLowerCase();
    statusPill.className = `status-pill ${stLower}`;
    const dot = document.createElement('span');
    dot.className = 'dot';
    statusPill.append(dot, document.createTextNode(` ${inst.status}`));

    top.append(titleGroup, statusPill);

    // Metrics section
    const metrics = document.createElement('div');
    metrics.className = 'metrics-section';

    const isRunning = inst.status === 'Running';

    // CPU Row
    const cpuRow = document.createElement('div');
    cpuRow.className = 'metric-row';
    const cpuHeader = document.createElement('div');
    cpuHeader.className = 'metric-header';
    cpuHeader.innerHTML = `<span>CPU Usage</span><span class="val">${isRunning ? inst.cpu.toFixed(1) : '0.0'}%</span>`;
    const cpuTrack = document.createElement('div');
    cpuTrack.className = 'progress-track';
    const cpuFill = document.createElement('div');
    cpuFill.className = 'progress-fill cpu';
    cpuFill.style.width = isRunning ? `${Math.min(100, Math.max(0, inst.cpu))}%` : '0%';
    cpuTrack.append(cpuFill);
    cpuRow.append(cpuHeader, cpuTrack);

    // RAM Row
    const ramRow = document.createElement('div');
    ramRow.className = 'metric-row';
    const ramGb = (inst.memory_mb / 1024).toFixed(1);
    const maxRamGb = (inst.max_memory_mb / 1024).toFixed(1);
    const ramPct = inst.max_memory_mb > 0 ? (inst.memory_mb / inst.max_memory_mb * 100).toFixed(0) : 0;
    const ramHeader = document.createElement('div');
    ramHeader.className = 'metric-header';
    ramHeader.innerHTML = `<span>Memory</span><span class="val">${isRunning ? `${ramGb} / ${maxRamGb} GB` : '0.0 GB'}</span>`;
    const ramTrack = document.createElement('div');
    ramTrack.className = 'progress-track';
    const ramFill = document.createElement('div');
    ramFill.className = 'progress-fill ram';
    ramFill.style.width = isRunning ? `${Math.min(100, Math.max(0, ramPct))}%` : '0%';
    ramTrack.append(ramFill);
    ramRow.append(ramHeader, ramTrack);

    // Meta stats
    const metaStats = document.createElement('div');
    metaStats.className = 'meta-stats';
    const tpsText = isRunning ? (inst.tps ? `${inst.tps.toFixed(1)} TPS` : 'Stable') : '—';
    metaStats.innerHTML = `<span>Tickrate: <strong>${tpsText}</strong></span><span>Uptime: <strong>${formatUptime(inst.uptime_seconds)}</strong></span>`;

    metrics.append(cpuRow, ramRow, metaStats);

    // Players section
    const playersSec = document.createElement('div');
    playersSec.className = 'players-section';
    const playersH = document.createElement('div');
    playersH.className = 'players-header';
    playersH.textContent = `Online Players (${inst.players ? inst.players.length : 0}/${inst.max_players || 32})`;

    const playersList = document.createElement('div');
    playersList.className = 'players-list';
    if (inst.players && inst.players.length > 0) {
      for (const p of inst.players) {
        const pTag = document.createElement('span');
        pTag.className = 'player-tag';
        pTag.textContent = p;
        playersList.append(pTag);
      }
    } else {
      const noP = document.createElement('span');
      noP.className = 'no-players';
      noP.textContent = isRunning ? 'No players connected' : 'Server is sleeping';
      playersList.append(noP);
    }
    playersSec.append(playersH, playersList);

    // Actions toolbar
    const actions = document.createElement('div');
    actions.className = 'card-actions';

    if (!isRunning) {
      // Wake Server Button (available to members if allowWake)
      const wakeBtn = document.createElement('button');
      wakeBtn.type = 'button';
      wakeBtn.className = 'btn wake';
      wakeBtn.innerHTML = '⚡ Wake Server';
      wakeBtn.addEventListener('click', () => performAction('wake', inst.id));
      actions.append(wakeBtn);

      if (isOperator) {
        const startBtn = document.createElement('button');
        startBtn.type = 'button';
        startBtn.className = 'btn secondary';
        startBtn.textContent = 'Start';
        startBtn.addEventListener('click', () => performAction('start', inst.id));
        actions.append(startBtn);
      }
    } else {
      // Running actions
      if (isOperator) {
        const stopBtn = document.createElement('button');
        stopBtn.type = 'button';
        stopBtn.className = 'btn danger';
        stopBtn.textContent = 'Stop';
        stopBtn.addEventListener('click', () => performAction('stop', inst.id));

        const restartBtn = document.createElement('button');
        restartBtn.type = 'button';
        restartBtn.className = 'btn secondary';
        restartBtn.textContent = 'Restart';
        restartBtn.addEventListener('click', () => performAction('restart', inst.id));

        const consoleBtn = document.createElement('button');
        consoleBtn.type = 'button';
        consoleBtn.className = 'btn primary';
        consoleBtn.textContent = 'Console';
        consoleBtn.addEventListener('click', () => openConsole(inst));

        actions.append(consoleBtn, restartBtn, stopBtn);
      } else {
        const infoMsg = document.createElement('span');
        infoMsg.className = 'no-players';
        infoMsg.textContent = 'Server online & ready to join!';
        actions.append(infoMsg);
      }
    }

    card.append(top, metrics, playersSec, actions);
    gridEl.append(card);
  }
}

async function loadData() {
  try {
    refreshBtn.disabled = true;
    const res = await CillhubPanel.request({ action: 'list' });
    currentInstances = res.instances || [];
    isOperator = !!res.can_operate;
    allowWake = res.allow_wake !== false;

    if (res.is_live_amp) {
      connStatusEl.textContent = `Live AMP API (${res.amp_url})`;
    } else {
      connStatusEl.textContent = 'Demo Mode (Managed Instance Store)';
    }

    render();
    if (activeConsoleInstance) {
      const updated = currentInstances.find(i => i.id === activeConsoleInstance.id);
      if (updated) {
        activeConsoleInstance = updated;
        renderConsoleLines();
      }
    }
  } catch (err) {
    showNotice(err.message || 'Failed to load AMP instances', true);
  } finally {
    refreshBtn.disabled = false;
  }
}

async function performAction(action, instanceId) {
  try {
    showNotice(`Executing ${action}...`);
    const res = await CillhubPanel.request({ action, instance_id: instanceId });
    currentInstances = res.instances || [];
    isOperator = !!res.can_operate;
    allowWake = res.allow_wake !== false;
    render();
    if (res.notice) showNotice(res.notice);
    else showNotice(`Action ${action} completed successfully.`);
  } catch (err) {
    showNotice(err.message || `Failed to ${action} instance`, true);
  }
}

function openConsole(inst) {
  activeConsoleInstance = inst;
  consoleTitle.textContent = `${inst.name} (${inst.id})`;
  consoleDrawer.hidden = false;
  renderConsoleLines();
  consoleInput.focus();
}

function renderConsoleLines() {
  consoleOutput.replaceChildren();
  const lines = activeConsoleInstance.console_lines || [];
  if (lines.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'console-line info';
    empty.textContent = '[Console initialized. Ready for RCON input.]';
    consoleOutput.append(empty);
    return;
  }
  for (const line of lines) {
    const div = document.createElement('div');
    div.className = 'console-line';
    if (line.includes('WARN')) div.classList.add('warn');
    else if (line.includes('ERROR') || line.includes('ALERT')) div.classList.add('error');
    else if (line.includes('INFO') || line.includes('OUTPUT')) div.classList.add('info');
    div.textContent = line;
    consoleOutput.append(div);
  }
  consoleOutput.scrollTop = consoleOutput.scrollHeight;
}

async function sendConsoleCommand() {
  const cmd = consoleInput.value.trim();
  if (!cmd || !activeConsoleInstance) return;

  consoleInput.value = '';
  sendCmdBtn.disabled = true;

  try {
    const res = await CillhubPanel.request({
      action: 'command',
      instance_id: activeConsoleInstance.id,
      command: cmd
    });
    currentInstances = res.instances || [];
    const updated = currentInstances.find(i => i.id === activeConsoleInstance.id);
    if (updated) {
      activeConsoleInstance = updated;
      renderConsoleLines();
    }
  } catch (err) {
    const errLine = document.createElement('div');
    errLine.className = 'console-line error';
    errLine.textContent = `[ERROR]: ${err.message}`;
    consoleOutput.append(errLine);
    consoleOutput.scrollTop = consoleOutput.scrollHeight;
  } finally {
    sendCmdBtn.disabled = false;
    consoleInput.focus();
  }
}

// Event Listeners
refreshBtn.addEventListener('click', loadData);
sendCmdBtn.addEventListener('click', sendConsoleCommand);
consoleInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendConsoleCommand();
});
closeConsoleBtn.addEventListener('click', () => {
  consoleDrawer.hidden = true;
  activeConsoleInstance = null;
});

CillhubPanel.onContext((c) => {
  ctx = c;
  document.documentElement.dataset.theme = c.theme;
  document.documentElement.lang = c.locale;
});

CillhubPanel.onEvent((evt) => {
  if (evt?.type === 'amp_changed') {
    loadData();
  }
});

CillhubPanel.ready().then(loadData);
