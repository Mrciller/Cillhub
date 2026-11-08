// Jukebox Queue client panel script
let ctx = null;
let state = {
  now_playing: null,
  items: [],
  history: [],
  can_manage: false,
  user_id: null,
};

// DOM Elements
const statusBar = document.getElementById('status-bar');
const queueCount = document.getElementById('queue-count');
const toggleAddBtn = document.getElementById('toggle-add-btn');
const addPanel = document.getElementById('add-panel');
const cancelAddBtn = document.getElementById('cancel-add-btn');
const submitTrackBtn = document.getElementById('submit-track-btn');
const trackTitle = document.getElementById('track-title');
const trackUrl = document.getElementById('track-url');
const trackDuration = document.getElementById('track-duration');

// Now Playing Elements
const nowPlayingCard = document.getElementById('now-playing-card');
const npTitle = document.getElementById('np-title');
const npMeta = document.getElementById('np-meta');
const npActions = document.getElementById('np-actions');
const npLinkBtn = document.getElementById('np-link-btn');
const btnSkip = document.getElementById('btn-skip');

// Mod Toolbar
const modToolbar = document.getElementById('mod-toolbar');
const btnPlayNext = document.getElementById('btn-play-next');
const btnClear = document.getElementById('btn-clear');

const queueList = document.getElementById('queue-list');

function setStatus(text, isError = false) {
  statusBar.textContent = text;
  statusBar.className = isError ? 'status-bar error' : 'status-bar';
  if (text) {
    setTimeout(() => {
      if (statusBar.textContent === text) statusBar.textContent = '';
    }, 4000);
  }
}

function renderNowPlaying() {
  const np = state.now_playing;
  if (!np) {
    nowPlayingCard.className = 'now-playing-card empty';
    npTitle.textContent = 'Nothing playing right now';
    npMeta.textContent = 'Submit a track to get the party started!';
    npActions.classList.add('hidden');
    return;
  }

  nowPlayingCard.className = 'now-playing-card playing';
  npTitle.textContent = np.title;

  const durStr = np.duration_label ? ` · ${np.duration_label}` : '';
  const reqStr = np.submitted_by ? `Requested by ${np.submitted_by.name}` : '';
  npMeta.textContent = `${reqStr}${durStr}`;

  npActions.classList.remove('hidden');

  if (np.url) {
    npLinkBtn.classList.remove('hidden');
    npLinkBtn.onclick = () => CillhubPanel.openUrl(np.url);
  } else {
    npLinkBtn.classList.add('hidden');
  }

  const isOwner = np.submitted_by && np.submitted_by.id === state.user_id;
  btnSkip.classList.toggle('hidden', !state.can_manage && !isOwner);
}

function renderQueue() {
  queueCount.textContent = `${state.items.length} in queue`;
  modToolbar.classList.toggle('hidden', !state.can_manage);

  queueList.replaceChildren();

  if (!state.items.length) {
    const emptyLi = document.createElement('li');
    emptyLi.className = 'empty-queue';
    emptyLi.textContent = 'The queue is currently empty. Add a song or video above!';
    queueList.appendChild(emptyLi);
    return;
  }

  for (let idx = 0; idx < state.items.length; idx++) {
    const item = state.items[idx];
    const li = document.createElement('li');
    li.className = 'queue-item';

    // Upvote Button
    const voteBtn = document.createElement('button');
    voteBtn.type = 'button';
    voteBtn.className = `vote-btn ${item.has_voted ? 'voted' : ''}`;
    voteBtn.setAttribute('aria-label', `Upvote ${item.title}. Current votes: ${item.vote_count}`);
    voteBtn.innerHTML = `<span class="arrow">▲</span><span class="count">${item.vote_count}</span>`;
    voteBtn.addEventListener('click', () => {
      doAction({ action: 'vote', id: item.id });
    });

    // Content
    const contentDiv = document.createElement('div');
    contentDiv.className = 'item-content';

    const titleRow = document.createElement('div');
    titleRow.className = 'title-row';

    const posSpan = document.createElement('span');
    posSpan.className = 'pos-num';
    posSpan.textContent = `#${idx + 1}`;

    const titleSpan = document.createElement('span');
    titleSpan.className = 'item-title';
    titleSpan.textContent = item.title;

    titleRow.append(posSpan, titleSpan);

    if (item.duration_label) {
      const durSpan = document.createElement('span');
      durSpan.className = 'dur-pill';
      durSpan.textContent = item.duration_label;
      titleRow.appendChild(durSpan);
    }

    const metaRow = document.createElement('div');
    metaRow.className = 'item-meta';
    metaRow.textContent = `Requested by ${item.submitted_by ? item.submitted_by.name : 'Member'}`;

    contentDiv.append(titleRow, metaRow);

    // Actions
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'item-actions';

    if (item.url) {
      const linkBtn = document.createElement('button');
      linkBtn.type = 'button';
      linkBtn.className = 'icon-btn';
      linkBtn.textContent = '🔗';
      linkBtn.title = 'Open link';
      linkBtn.addEventListener('click', () => CillhubPanel.openUrl(item.url));
      actionsDiv.appendChild(linkBtn);
    }

    if (item.can_delete) {
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'icon-btn danger';
      delBtn.textContent = '✕';
      delBtn.title = 'Remove from queue';
      delBtn.addEventListener('click', () => {
        doAction({ action: 'remove', id: item.id }, 'Removed item.');
      });
      actionsDiv.appendChild(delBtn);
    }

    li.append(voteBtn, contentDiv, actionsDiv);
    queueList.appendChild(li);
  }
}

async function doAction(data, successMsg) {
  try {
    const res = await CillhubPanel.request(data);
    state = res;
    renderNowPlaying();
    renderQueue();
    if (successMsg) setStatus(successMsg);
    return true;
  } catch (err) {
    setStatus(err.message, true);
    return false;
  }
}

async function refresh() {
  await doAction({ action: 'list' });
}

// Add Track Toggle
toggleAddBtn.addEventListener('click', () => {
  const isHidden = addPanel.classList.toggle('hidden');
  toggleAddBtn.textContent = isHidden ? '+ Add Track' : 'Close';
  if (!isHidden) trackTitle.focus();
});

cancelAddBtn.addEventListener('click', () => {
  addPanel.classList.add('hidden');
  toggleAddBtn.textContent = '+ Add Track';
});

// Submit Track
submitTrackBtn.addEventListener('click', async () => {
  const title = trackTitle.value.trim();
  if (!title) {
    setStatus('Please enter a track or topic title.', true);
    trackTitle.focus();
    return;
  }

  submitTrackBtn.disabled = true;
  const ok = await doAction(
    {
      action: 'add',
      title,
      url: trackUrl.value.trim(),
      duration: trackDuration.value.trim(),
    },
    'Added to queue!'
  );
  submitTrackBtn.disabled = false;

  if (ok) {
    trackTitle.value = '';
    trackUrl.value = '';
    trackDuration.value = '';
    addPanel.classList.add('hidden');
    toggleAddBtn.textContent = '+ Add Track';
  }
});

// Host Actions
btnPlayNext.addEventListener('click', () => {
  doAction({ action: 'play_next' }, 'Playing next track.');
});

btnSkip.addEventListener('click', () => {
  doAction({ action: 'skip' }, 'Skipped track.');
});

btnClear.addEventListener('click', () => {
  doAction({ action: 'clear' }, 'Queue cleared.');
});

// Bridge events
CillhubPanel.onContext((c) => {
  ctx = c;
  document.documentElement.dataset.theme = c.theme;
  document.documentElement.lang = c.locale;
});

CillhubPanel.onEvent((data) => {
  if (data && data.type === 'queue_updated') {
    refresh();
  }
});

CillhubPanel.ready().then(refresh);
