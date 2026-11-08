const api = window.desktopSettings;
const $ = (id) => document.getElementById(id);
let state = null;
let recording = null; // button currently recording a shortcut

const pretty = (acc) => acc || 'Off';

function render(s) {
  state = s;
  $('version').textContent = s.version;
  $('share').checked = s.shareActivity;
  $('gpu').checked = s.gpuScreenShare;
  $('gpu-note').textContent = s.gpuScreenShare !== s.gpuActive ? 'Restart Cillhub to apply this change (Quit Cillhub in the tray menu, then open it again).' : '';
  $('detected').textContent = s.detected ? `Detected now: ${s.detected}${s.shareActivity ? '' : ' (not shared)'}` : 'No game detected';
  const list = $('games');
  list.replaceChildren(...s.customGames.map((g, i) => {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = g.name;
    const code = document.createElement('code');
    code.textContent = g.exe;
    label.append(code);
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'link';
    rm.textContent = 'Remove';
    rm.setAttribute('aria-label', `Remove ${g.name}`);
    rm.addEventListener('click', () => save({ customGames: s.customGames.filter((_, j) => j !== i) }, 'games-error').then(() => $('exe').focus()));
    li.append(label, rm);
    return li;
  }));
  $('no-games').hidden = s.customGames.length > 0;
  for (const btn of document.querySelectorAll('[data-action]')) {
    const action = btn.dataset.action;
    if (btn !== recording) btn.textContent = pretty(s.hotkeys[action]);
    const failed = s.hotkeyFailures[action];
    $(`w-${action}`).textContent = failed ? `${failed} could not be registered: another app is probably using it. Pick a different shortcut.` : '';
  }

  if (s.gpuInfo) {
    if ($('av1-badge')) {
      $('av1-badge').textContent = s.gpuInfo.av1Supported ? 'Hardware (Supported)' : (s.gpuInfo.platform === 'win32' ? 'Software / Inactive' : 'N/A on Linux');
      $('av1-badge').className = `badge ${s.gpuInfo.av1Supported ? 'ok' : 'dim'}`;
    }
    if ($('h264-badge')) {
      $('h264-badge').textContent = s.gpuInfo.h264Supported ? 'Hardware (Enabled)' : 'Software (OpenH264)';
      $('h264-badge').className = `badge ${s.gpuInfo.h264Supported ? 'ok' : 'dim'}`;
    }
    if ($('gpu-accel-badge')) {
      const active = s.gpuInfo.videoEncode === 'enabled';
      $('gpu-accel-badge').textContent = active ? 'GPU Accelerated' : s.gpuInfo.videoEncode;
      $('gpu-accel-badge').className = `badge ${active ? 'ok' : 'dim'}`;
    }
  }

  if (s.updateStatus) {
    const u = s.updateStatus;
    const statusLabel = $('update-status-label');
    const updateBadge = $('update-badge');
    const installBtn = $('btn-install-update');
    if (statusLabel && updateBadge && installBtn) {
      if (u.state === 'ready') {
        updateBadge.textContent = 'Ready';
        updateBadge.className = 'badge ok';
        statusLabel.textContent = `Update to ${u.version} is downloaded and ready to install.`;
        installBtn.hidden = false;
        installBtn.textContent = 'Restart to update';
      } else if (u.state === 'downloading') {
        updateBadge.textContent = 'Downloading';
        updateBadge.className = 'badge active';
        statusLabel.textContent = `Downloading update${u.percent !== undefined ? ` (${u.percent}%)` : '…'}`;
        installBtn.hidden = true;
      } else if (u.state === 'checking') {
        updateBadge.textContent = 'Checking';
        updateBadge.className = 'badge active';
        statusLabel.textContent = 'Checking for updates…';
        installBtn.hidden = true;
      } else if (u.state === 'error') {
        updateBadge.textContent = 'Error';
        updateBadge.className = 'badge dim';
        statusLabel.textContent = 'Update check failed. Check network connection.';
        installBtn.hidden = true;
      } else {
        updateBadge.textContent = 'Up to date';
        updateBadge.className = 'badge ok';
        statusLabel.textContent = `You are on the latest version (${s.version}).`;
        installBtn.hidden = true;
      }
    }
  }
}

async function save(patch, errorId) {
  const s = await api.set(patch);
  $(errorId).textContent = s.error || '';
  render(s);
  return !s.error;
}

$('share').addEventListener('change', (e) => save({ shareActivity: e.target.checked }, 'games-error'));
$('gpu').addEventListener('change', (e) => save({ gpuScreenShare: e.target.checked }, 'gpu-note'));

$('add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const exe = $('exe').value.trim();
  if (!exe) { $('games-error').textContent = 'Enter the program file name, for example mygame.exe.'; $('exe').focus(); return; }
  if (state.customGames.some((g) => g.exe.toLowerCase() === exe.toLowerCase())) { $('games-error').textContent = `${exe} is already in the list.`; return; }
  if (await save({ customGames: [...state.customGames, { exe, name: $('gname').value }] }, 'games-error')) {
    $('exe').value = $('gname').value = '';
    $('exe').focus();
  }
});

// Keyboard event -> Electron accelerator ("Ctrl+Shift+M"); null while only modifiers are held.
function accelerator(e) {
  const c = e.code;
  const key = /^Key[A-Z]$/.test(c) ? c.slice(3) : /^Digit\d$/.test(c) ? c.slice(5) : /^Numpad\d$/.test(c) ? `num${c.slice(6)}`
    : /^F([1-9]|1\d|2[0-4])$/.test(c) ? c : { Space: 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
      Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert' }[c];
  if (!key) return null;
  return [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super', key].filter(Boolean).join('+');
}

function stopRecording() {
  if (!recording) return;
  recording.setAttribute('aria-pressed', 'false');
  recording = null;
  api.recording(false);
  render(state);
}

for (const btn of document.querySelectorAll('[data-action]')) {
  btn.addEventListener('click', () => {
    if (recording === btn) return stopRecording();
    stopRecording();
    recording = btn;
    btn.setAttribute('aria-pressed', 'true');
    btn.textContent = 'Press keys…';
    $('keys-error').textContent = '';
    api.recording(true);
  });
  btn.addEventListener('blur', stopRecording);
  btn.addEventListener('keydown', async (e) => {
    if (recording !== btn || e.key === 'Tab') return;
    e.preventDefault();
    if (e.key === 'Escape') return stopRecording();
    const acc = e.key === 'Backspace' ? '' : accelerator(e);
    if (acc === null) return;
    const action = btn.dataset.action;
    stopRecording();
    await save({ hotkeys: { ...state.hotkeys, [action]: acc } }, 'keys-error');
  });
}
for (const btn of document.querySelectorAll('[data-reset]')) {
  btn.addEventListener('click', () => save({ hotkeys: { ...state.hotkeys, [btn.dataset.reset]: state.defaults[btn.dataset.reset] } }, 'keys-error'));
}

$('btn-check-update')?.addEventListener('click', async () => {
  $('update-status-label').textContent = 'Checking for updates…';
  await api.checkForUpdates();
});
$('btn-install-update')?.addEventListener('click', async () => {
  await api.installUpdate();
});

api.onState(render);
api.get().then((s) => {
  render(s);
  const target = location.hash && document.getElementById(`h-${location.hash.slice(1)}`);
  if (target) { target.scrollIntoView(); target.focus(); }
});
