// Leaderboard & XP client panel script
let ctx = null;
let state = {
  my_card: null,
  leaderboard: [],
  total_users: 0,
};
let searchQuery = '';

const statusMsg = document.getElementById('status-msg');
const totalBadge = document.getElementById('total-badge');
const searchInput = document.getElementById('search-input');
const leaderboardList = document.getElementById('leaderboard-list');

// Personal Card Elements
const myAvatar = document.getElementById('my-avatar');
const myName = document.getElementById('my-name');
const myRankPill = document.getElementById('my-rank-pill');
const myMsgs = document.getElementById('my-msgs');
const myVoice = document.getElementById('my-voice');
const myLevel = document.getElementById('my-level');
const myXpNums = document.getElementById('my-xp-nums');
const myXpPct = document.getElementById('my-xp-pct');
const myProgressFill = document.getElementById('my-progress-fill');

function setStatus(text, isError = false) {
  statusMsg.textContent = text;
  statusMsg.className = isError ? 'status-msg error' : 'status-msg';
}

function formatVoice(mins) {
  if (!mins) return '0m';
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return hrs > 0 ? `${hrs}h ${rem}m` : `${rem}m`;
}

function renderPersonalCard(card) {
  if (!card) return;
  myName.textContent = card.name || 'Member';
  myAvatar.textContent = (card.name || 'M').charAt(0).toUpperCase();
  myRankPill.textContent = `Rank #${card.rank} of ${card.total_users || 1}`;
  myMsgs.textContent = `💬 ${(card.messages || 0).toLocaleString()} msgs`;
  myVoice.textContent = `🎙️ ${formatVoice(card.voice_mins)}`;
  myLevel.textContent = card.level;

  const curProg = (card.progress_xp || 0).toLocaleString();
  const needed = (card.needed_xp || 100).toLocaleString();
  myXpNums.textContent = `${curProg} / ${needed} XP`;
  myXpPct.textContent = `${card.progress_pct || 0}%`;
  myProgressFill.style.width = `${Math.min(100, Math.max(0, card.progress_pct || 0))}%`;
}

function renderLeaderboard() {
  leaderboardList.replaceChildren();

  let list = state.leaderboard || [];
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    list = list.filter((u) => u.name && u.name.toLowerCase().includes(q));
  }

  totalBadge.textContent = `${state.total_users || list.length} Members`;

  if (!list.length) {
    const emptyLi = document.createElement('li');
    emptyLi.className = 'empty-row';
    emptyLi.textContent = searchQuery ? 'No members found matching search.' : 'No members ranked yet.';
    leaderboardList.appendChild(emptyLi);
    return;
  }

  for (const u of list) {
    const li = document.createElement('li');
    li.className = `table-row rank-${u.rank}`;

    // Rank Medal / Number
    const rankCol = document.createElement('div');
    rankCol.className = 'col-rank';
    if (u.rank === 1) rankCol.innerHTML = '<span class="medal gold">🥇</span>';
    else if (u.rank === 2) rankCol.innerHTML = '<span class="medal silver">🥈</span>';
    else if (u.rank === 3) rankCol.innerHTML = '<span class="medal bronze">🥉</span>';
    else rankCol.textContent = `#${u.rank}`;

    // Member Avatar & Name
    const nameCol = document.createElement('div');
    nameCol.className = 'col-name';

    const avatar = document.createElement('span');
    avatar.className = 'mini-avatar';
    avatar.textContent = (u.name || 'M').charAt(0).toUpperCase();

    const nameSpan = document.createElement('span');
    nameSpan.className = 'name-text';
    nameSpan.textContent = u.name;

    nameCol.append(avatar, nameSpan);

    // Level
    const lvlCol = document.createElement('div');
    lvlCol.className = 'col-lvl';
    lvlCol.innerHTML = `<span class="lvl-chip">${u.level}</span>`;

    // XP
    const xpCol = document.createElement('div');
    xpCol.className = 'col-xp';
    xpCol.textContent = u.xp.toLocaleString();

    // Messages
    const msgsCol = document.createElement('div');
    msgsCol.className = 'col-msgs';
    msgsCol.textContent = (u.messages || 0).toLocaleString();

    // Voice
    const voiceCol = document.createElement('div');
    voiceCol.className = 'col-voice';
    voiceCol.textContent = formatVoice(u.voice_mins);

    li.append(rankCol, nameCol, lvlCol, xpCol, msgsCol, voiceCol);

    // Click on row to inspect rank card
    li.addEventListener('click', () => {
      renderPersonalCard(u);
    });

    leaderboardList.appendChild(li);
  }
}

async function refresh() {
  try {
    const res = await CillhubPanel.request({ action: 'list' });
    state = res;
    renderPersonalCard(state.my_card);
    renderLeaderboard();
  } catch (err) {
    setStatus(err.message, true);
  }
}

// Search input
searchInput.addEventListener('input', (e) => {
  searchQuery = e.target.value.trim();
  renderLeaderboard();
});

// Bridge events
CillhubPanel.onContext((c) => {
  ctx = c;
  document.documentElement.dataset.theme = c.theme;
  document.documentElement.lang = c.locale;
});

CillhubPanel.onEvent((data) => {
  if (data && data.type === 'xp_updated') {
    refresh();
  }
});

CillhubPanel.ready().then(refresh);
