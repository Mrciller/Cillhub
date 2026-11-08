// Tournament Brackets UI script
let ctx = null;
let tournaments = [];
let activeTourney = null;
let canManage = false;
let me = null;
let reportingMatch = null;

const titleEl = document.getElementById('tourney-title');
const subtitleEl = document.getElementById('tourney-subtitle');
const selectTourneyEl = document.getElementById('tourney-select');
const statusBadgeEl = document.getElementById('status-badge');
const noticeEl = document.getElementById('notice-box');
const championBanner = document.getElementById('champion-banner');
const championName = document.getElementById('champion-name');
const btnJoin = document.getElementById('btn-join');
const btnLeave = document.getElementById('btn-leave');
const btnStart = document.getElementById('btn-start');
const btnOpenCreate = document.getElementById('btn-open-create');
const playerCountPill = document.getElementById('player-count-pill');
const bracketTree = document.getElementById('bracket-tree');

// Report Modal
const modalReport = document.getElementById('modal-report');
const reportMatchLabel = document.getElementById('report-match-label');
const labelP1 = document.getElementById('label-p1');
const labelP2 = document.getElementById('label-p2');
const inputScore1 = document.getElementById('input-score1');
const inputScore2 = document.getElementById('input-score2');
const btnCloseReport = document.getElementById('btn-close-report');
const btnCancelReport = document.getElementById('btn-cancel-report');
const btnSubmitScore = document.getElementById('btn-submit-score');

// Create Modal
const modalCreate = document.getElementById('modal-create');
const btnCloseCreate = document.getElementById('btn-close-create');
const btnCancelCreate = document.getElementById('btn-cancel-create');
const btnSaveCreate = document.getElementById('btn-save-create');
const inputTourneyTitle = document.getElementById('input-tourney-title');
const inputTourneyGame = document.getElementById('input-tourney-game');
const selectTourneySize = document.getElementById('select-tourney-size');
const selectTourneyFormat = document.getElementById('select-tourney-format');

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

function render() {
  if (!activeTourney) {
    bracketTree.innerHTML = '<div class="empty-state">No tournament selected.</div>';
    return;
  }

  titleEl.textContent = activeTourney.title;
  subtitleEl.textContent = `${activeTourney.game} • ${activeTourney.size} Players • ${activeTourney.format === 'round_robin' ? 'Round Robin' : 'Single Elimination'}`;

  // Populate Tournament Selector Dropdown
  selectTourneyEl.replaceChildren();
  for (const t of tournaments) {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.title;
    if (t.id === activeTourney.id) opt.selected = true;
    selectTourneyEl.append(opt);
  }

  // Status Badge
  statusBadgeEl.className = `status-badge ${activeTourney.status}`;
  statusBadgeEl.textContent = activeTourney.status === 'in_progress' ? 'In Progress' : (activeTourney.status === 'registration' ? 'Registration Open' : 'Completed');

  // Champion Banner
  if (activeTourney.champion) {
    championBanner.hidden = false;
    championName.textContent = activeTourney.champion.name;
  } else {
    championBanner.hidden = true;
  }

  // Registration & Action Buttons
  const isJoined = activeTourney.participants.some(p => p.id === me?.id);
  const isReg = activeTourney.status === 'registration';

  btnJoin.hidden = !isReg || isJoined;
  btnLeave.hidden = !isReg || !isJoined;
  playerCountPill.textContent = `${activeTourney.participants.length}/${activeTourney.size} Players`;

  btnStart.hidden = !isReg || !canManage;
  btnOpenCreate.hidden = !canManage;

  // Visual Bracket Tree
  bracketTree.replaceChildren();

  if (activeTourney.rounds.length === 0) {
    const emptyBox = document.createElement('div');
    emptyBox.className = 'empty-state';
    emptyBox.style.padding = '30px';
    emptyBox.style.textAlign = 'center';
    emptyBox.style.color = 'var(--text-muted)';
    emptyBox.innerHTML = `
      <h3>Registration Queue Active</h3>
      <p style="margin-top: 8px;">Waiting for players to join (${activeTourney.participants.length}/${activeTourney.size} registered).</p>
      ${isReg && !isJoined ? '<p style="margin-top: 8px; color: var(--accent);">Click <strong>Join Tournament</strong> above to enter!</p>' : ''}
    `;
    bracketTree.append(emptyBox);
    return;
  }

  for (let rIdx = 0; rIdx < activeTourney.rounds.length; rIdx++) {
    const round = activeTourney.rounds[rIdx];
    const col = document.createElement('div');
    col.className = 'round-column';

    const rHeader = document.createElement('div');
    rHeader.className = 'round-header';
    const isFinals = rIdx === activeTourney.rounds.length - 1;
    const isSemis = rIdx === activeTourney.rounds.length - 2;
    rHeader.textContent = isFinals ? 'Grand Finals' : (isSemis ? 'Semifinals' : `Round ${rIdx + 1}`);

    const matchesWrap = document.createElement('div');
    matchesWrap.className = 'matches-container';

    for (const m of round) {
      const card = document.createElement('div');
      card.className = `match-card ${m.status}`;

      const topRow = document.createElement('div');
      topRow.className = 'match-top-row';
      const mLabel = document.createElement('span');
      mLabel.className = 'match-label';
      mLabel.textContent = m.label;
      const mTag = document.createElement('span');
      mTag.className = 'match-status-tag';
      mTag.textContent = m.status;
      topRow.append(mLabel, mTag);

      // Player 1 Slot
      const p1Slot = document.createElement('div');
      p1Slot.className = `player-slot ${m.winner?.id && m.winner.id === m.p1?.id ? 'winner' : ''}`;
      const p1Name = document.createElement('span');
      p1Name.className = 'player-name';
      p1Name.textContent = m.p1 ? m.p1.name : 'TBD';
      const p1Score = document.createElement('span');
      p1Score.className = 'player-score';
      p1Score.textContent = m.score1 !== null ? m.score1 : '-';
      p1Slot.append(p1Name, p1Score);

      // Player 2 Slot
      const p2Slot = document.createElement('div');
      p2Slot.className = `player-slot ${m.winner?.id && m.winner.id === m.p2?.id ? 'winner' : ''}`;
      const p2Name = document.createElement('span');
      p2Name.className = 'player-name';
      p2Name.textContent = m.p2 ? m.p2.name : 'TBD';
      const p2Score = document.createElement('span');
      p2Score.className = 'player-score';
      p2Score.textContent = m.score2 !== null ? m.score2 : '-';
      p2Slot.append(p2Name, p2Score);

      card.append(topRow, p1Slot, p2Slot);

      // Report Button
      const canReport = m.status === 'ready' && (canManage || m.p1?.id === me?.id || m.p2?.id === me?.id);
      if (canReport) {
        const reportBtn = document.createElement('button');
        reportBtn.type = 'button';
        reportBtn.className = 'btn-report-score';
        reportBtn.textContent = 'Report Score';
        reportBtn.addEventListener('click', () => openReportModal(m));
        card.append(reportBtn);
      }

      matchesWrap.append(card);
    }

    col.append(rHeader, matchesWrap);
    bracketTree.append(col);
  }
}

async function loadData() {
  try {
    const res = await CillhubPanel.request({
      action: 'list',
      tournament_id: activeTourney?.id
    });
    tournaments = res.tournaments || [];
    activeTourney = res.active_tournament || tournaments[0];
    canManage = !!res.can_manage;
    me = res.me;
    render();
  } catch (err) {
    showNotice(err.message || 'Failed to load tournaments', true);
  }
}

async function act(action, extra = {}) {
  try {
    const res = await CillhubPanel.request({
      action,
      tournament_id: activeTourney?.id,
      ...extra
    });
    tournaments = res.tournaments || [];
    activeTourney = res.active_tournament || tournaments[0];
    canManage = !!res.can_manage;
    me = res.me;
    render();
    if (res.notice) showNotice(res.notice);
  } catch (err) {
    showNotice(err.message || 'Action failed', true);
  }
}

function openReportModal(m) {
  reportingMatch = m;
  reportMatchLabel.textContent = `${m.label} (${m.id})`;
  labelP1.textContent = m.p1?.name || 'Player 1';
  labelP2.textContent = m.p2?.name || 'Player 2';
  inputScore1.value = 2;
  inputScore2.value = 1;
  modalReport.hidden = false;
  inputScore1.focus();
}

async function submitScore() {
  if (!reportingMatch) return;
  const s1 = parseInt(inputScore1.value, 10);
  const s2 = parseInt(inputScore2.value, 10);
  if (isNaN(s1) || isNaN(s2) || s1 < 0 || s2 < 0) {
    showNotice('Scores must be non-negative integers.', true);
    return;
  }
  if (s1 === s2) {
    showNotice('Ties are not allowed in elimination matches.', true);
    return;
  }

  btnSubmitScore.disabled = true;
  await act('report_score', {
    match_id: reportingMatch.id,
    score1: s1,
    score2: s2
  });
  btnSubmitScore.disabled = false;
  modalReport.hidden = true;
  reportingMatch = null;
}

async function createTournament() {
  const title = inputTourneyTitle.value.trim();
  const game = inputTourneyGame.value.trim();
  const size = parseInt(selectTourneySize.value, 10);
  const format = selectTourneyFormat.value;

  if (!title || !game) {
    showNotice('Title and Game name are required.', true);
    return;
  }

  btnSaveCreate.disabled = true;
  await act('create', { title, game, size, format });
  btnSaveCreate.disabled = false;
  modalCreate.hidden = true;
  inputTourneyTitle.value = '';
  inputTourneyGame.value = '';
}

// Event Listeners
selectTourneyEl.addEventListener('change', (e) => {
  const sel = tournaments.find(t => t.id === e.target.value);
  if (sel) {
    activeTourney = sel;
    render();
  }
});

btnJoin.addEventListener('click', () => act('join'));
btnLeave.addEventListener('click', () => act('leave'));
btnStart.addEventListener('click', () => act('start'));

btnOpenCreate.addEventListener('click', () => { modalCreate.hidden = false; inputTourneyTitle.focus(); });
btnCloseCreate.addEventListener('click', () => { modalCreate.hidden = true; });
btnCancelCreate.addEventListener('click', () => { modalCreate.hidden = true; });
btnSaveCreate.addEventListener('click', createTournament);

btnCloseReport.addEventListener('click', () => { modalReport.hidden = true; reportingMatch = null; });
btnCancelReport.addEventListener('click', () => { modalReport.hidden = true; reportingMatch = null; });
btnSubmitScore.addEventListener('click', submitScore);

CillhubPanel.onContext((c) => {
  ctx = c;
  document.documentElement.dataset.theme = c.theme;
  document.documentElement.lang = c.locale;
});

CillhubPanel.onEvent((evt) => {
  if (evt?.type === 'tournament_changed') {
    loadData();
  }
});

CillhubPanel.ready().then(loadData);
