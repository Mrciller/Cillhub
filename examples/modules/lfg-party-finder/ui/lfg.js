// LFG Party Finder client panel script
let ctx = null;
let state = {
  squads: [],
  voice_channels: [],
  user_id: null,
  can_manage: false,
};
let currentFilter = 'all';

const statusEl = document.getElementById('status');
const squadListEl = document.getElementById('squad-list');
const activeCountEl = document.getElementById('active-count');
const createPanel = document.getElementById('create-panel');
const toggleCreateBtn = document.getElementById('toggle-create-btn');
const submitCreateBtn = document.getElementById('submit-create-btn');
const cancelCreateBtn = document.getElementById('cancel-create-btn');
const voiceSelect = document.getElementById('voice-select');

const gameInput = document.getElementById('game-input');
const slotsInput = document.getElementById('slots-input');
const rolesInput = document.getElementById('roles-input');
const descInput = document.getElementById('desc-input');

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.className = isError ? 'status-msg error' : 'status-msg';
}

function updateVoiceDropdown() {
  voiceSelect.replaceChildren();
  const optNone = document.createElement('option');
  optNone.value = '';
  optNone.textContent = 'None / External';
  voiceSelect.appendChild(optNone);

  for (const vc of state.voice_channels || []) {
    const opt = document.createElement('option');
    opt.value = vc.id;
    opt.textContent = `🔊 ${vc.name}`;
    voiceSelect.appendChild(opt);
  }
}

function renderSquads() {
  squadListEl.replaceChildren();
  const myId = state.user_id || (ctx && ctx.user && ctx.user.id);

  let filtered = state.squads || [];
  if (currentFilter === 'open') {
    filtered = filtered.filter((s) => s.members.length < s.max_slots);
  } else if (currentFilter === 'mine') {
    filtered = filtered.filter((s) => s.members.some((m) => m.id === myId));
  }

  activeCountEl.textContent = `${state.squads.length} active`;

  if (!filtered.length) {
    const emptyLi = document.createElement('li');
    emptyLi.className = 'empty-card';
    emptyLi.textContent = currentFilter === 'mine'
      ? "You haven't joined or created any squads."
      : 'No active squads matching this filter. Create one above!';
    squadListEl.appendChild(emptyLi);
    return;
  }

  for (const s of filtered) {
    const li = document.createElement('li');
    li.className = 'squad-card';

    const isFull = s.members.length >= s.max_slots;
    const isJoined = s.members.some((m) => m.id === myId);
    const isCreator = s.creator_id === myId;
    const canDelete = isCreator || state.can_manage;

    // Header: Game, Slots pill, Status badge
    const header = document.createElement('div');
    header.className = 'card-header';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'title-wrap';

    const gameTitle = document.createElement('h3');
    gameTitle.textContent = s.game;
    titleWrap.appendChild(gameTitle);

    const slotPill = document.createElement('span');
    slotPill.className = `slot-badge ${isFull ? 'full' : 'open'}`;
    slotPill.textContent = `${s.members.length}/${s.max_slots} Players`;
    titleWrap.appendChild(slotPill);

    header.appendChild(titleWrap);

    // Linked voice indicator
    if (s.voice_channel_id) {
      const vChan = state.voice_channels.find((vc) => vc.id === s.voice_channel_id);
      const vName = vChan ? vChan.name : 'Voice Channel';
      const vBadge = document.createElement('span');
      vBadge.className = 'voice-badge';
      vBadge.textContent = `🔊 ${vName}`;
      header.appendChild(vBadge);
    }

    li.appendChild(header);

    // Details: Description and needed roles
    if (s.description || s.needed_roles) {
      const details = document.createElement('div');
      details.className = 'card-details';
      if (s.description) {
        const desc = document.createElement('p');
        desc.className = 'squad-desc';
        desc.textContent = s.description;
        details.appendChild(desc);
      }
      if (s.needed_roles) {
        const roles = document.createElement('div');
        roles.className = 'role-tags';
        for (const r of s.needed_roles.split(',').map((x) => x.trim()).filter(Boolean)) {
          const tag = document.createElement('span');
          tag.className = 'role-tag';
          tag.textContent = `Need: ${r}`;
          roles.appendChild(tag);
        }
        details.appendChild(roles);
      }
      li.appendChild(details);
    }

    // Members roster with live voice state
    const roster = document.createElement('div');
    roster.className = 'roster';

    const rosterTitle = document.createElement('div');
    rosterTitle.className = 'roster-title';
    rosterTitle.textContent = 'Roster:';
    roster.appendChild(rosterTitle);

    const memberGrid = document.createElement('div');
    memberGrid.className = 'member-grid';

    for (const m of s.members) {
      const chip = document.createElement('div');
      chip.className = `member-chip ${m.in_voice ? 'in-voice' : ''}`;

      const indicator = document.createElement('span');
      indicator.className = `voice-dot ${m.in_party_voice ? 'party-voice' : m.in_voice ? 'active-voice' : 'no-voice'}`;
      indicator.title = m.in_party_voice ? 'In squad voice channel' : m.in_voice ? 'In another voice channel' : 'Not in voice';

      const name = document.createElement('span');
      name.className = 'member-name';
      name.textContent = m.name;

      const role = document.createElement('span');
      role.className = 'member-role';
      role.textContent = m.role || 'Member';

      chip.appendChild(indicator);
      chip.appendChild(name);
      chip.appendChild(role);
      memberGrid.appendChild(chip);
    }

    // Render empty slot placeholders
    for (let i = s.members.length; i < s.max_slots; i++) {
      const emptySlot = document.createElement('div');
      emptySlot.className = 'member-chip empty-slot';
      emptySlot.textContent = `Slot ${i + 1}`;
      memberGrid.appendChild(emptySlot);
    }

    roster.appendChild(memberGrid);
    li.appendChild(roster);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'card-actions';

    if (isJoined) {
      const leaveBtn = document.createElement('button');
      leaveBtn.type = 'button';
      leaveBtn.className = 'danger';
      leaveBtn.textContent = 'Leave Squad';
      leaveBtn.addEventListener('click', () => doAction({ action: 'leave', id: s.id }, 'Left squad.'));
      actions.appendChild(leaveBtn);
    } else if (!isFull) {
      const joinBtn = document.createElement('button');
      joinBtn.type = 'button';
      joinBtn.className = 'primary';
      joinBtn.textContent = 'Join Squad';
      joinBtn.addEventListener('click', () => {
        const preferredRole = s.needed_roles ? s.needed_roles.split(',')[0].trim() : 'Player';
        doAction({ action: 'join', id: s.id, role: preferredRole }, 'Joined squad!');
      });
      actions.appendChild(joinBtn);
    }

    if (canDelete) {
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'text-btn danger';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', () => doAction({ action: 'delete', id: s.id }, 'Squad deleted.'));
      actions.appendChild(delBtn);
    }

    li.appendChild(actions);
    squadListEl.appendChild(li);
  }
}

async function doAction(data, successMsg) {
  try {
    const res = await CillhubPanel.request(data);
    state = res;
    updateVoiceDropdown();
    renderSquads();
    if (successMsg) setStatus(successMsg);
    return true;
  } catch (err) {
    setStatus(err.message, true);
    return false;
  }
}

async function refresh() {
  if (!ctx) return;
  await doAction({ action: 'list' }, '');
}

// Toggle Create Panel
toggleCreateBtn.addEventListener('click', () => {
  const isHidden = createPanel.classList.toggle('hidden');
  toggleCreateBtn.textContent = isHidden ? '+ Create Squad' : 'Close';
  if (!isHidden) gameInput.focus();
});

cancelCreateBtn.addEventListener('click', () => {
  createPanel.classList.add('hidden');
  toggleCreateBtn.textContent = '+ Create Squad';
});

// Submit Create
submitCreateBtn.addEventListener('click', async () => {
  const game = gameInput.value.trim();
  if (!game) {
    setStatus('Please enter a game or activity name.', true);
    gameInput.focus();
    return;
  }

  submitCreateBtn.disabled = true;
  const ok = await doAction(
    {
      action: 'create',
      game,
      max_slots: Number(slotsInput.value) || 5,
      voice_channel_id: voiceSelect.value || null,
      needed_roles: rolesInput.value.trim(),
      description: descInput.value.trim(),
    },
    'Squad created successfully!'
  );
  submitCreateBtn.disabled = false;

  if (ok) {
    gameInput.value = '';
    rolesInput.value = '';
    descInput.value = '';
    createPanel.classList.add('hidden');
    toggleCreateBtn.textContent = '+ Create Squad';
  }
});

// Filter Tabs
for (const tab of ['all', 'open', 'mine']) {
  const btn = document.getElementById(`filter-${tab}`);
  if (btn) {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-bar .tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = tab;
      renderSquads();
    });
  }
}

// Cillhub bridge lifecycle
CillhubPanel.onContext((c) => {
  ctx = c;
  document.documentElement.dataset.theme = c.theme;
  document.documentElement.lang = c.locale;
});

CillhubPanel.onEvent((data) => {
  if (data && (data.type === 'squads_updated' || data.type === 'voice_update')) {
    refresh();
  }
});

CillhubPanel.ready().then(refresh);
