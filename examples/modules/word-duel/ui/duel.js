// Word Duel UI Controller
(() => {
  let ctx = null;
  let currentState = null;
  let currentTab = 'daily'; // 'daily', 'duel', 'leaderboard'

  // Input state
  let dailyInput = '';
  let duelInput = '';
  let duelTimerInterval = null;

  const KEYBOARD_ROWS = [
    ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
    ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'],
    ['ENTER', 'Z', 'X', 'C', 'V', 'B', 'N', 'M', '⌫'],
  ];

  const el = (id) => document.getElementById(id);

  function setStatus(text, type = 'info') {
    const sb = el('status-bar');
    if (!text) {
      sb.classList.add('hidden');
      return;
    }
    sb.textContent = text;
    sb.className = `status-bar ${type}`;
    sb.classList.remove('hidden');
    if (type !== 'error') {
      setTimeout(() => {
        if (sb.textContent === text) sb.classList.add('hidden');
      }, 4000);
    }
  }

  function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll('.tab-btn').forEach((b) => {
      const active = b.id === `tab-btn-${tab}`;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', active);
    });
    document.querySelectorAll('.tab-view').forEach((v) => {
      v.classList.toggle('hidden', v.id !== `view-${tab}`);
      v.classList.toggle('active', v.id === `view-${tab}`);
    });
  }

  // Key state color priority: correct > present > absent > unused
  function computeKeyStates(guesses, evaluations) {
    const map = {};
    if (!guesses || !evaluations) return map;
    for (let r = 0; r < guesses.length; r++) {
      const word = guesses[r];
      const ev = evaluations[r];
      if (!word || !ev) continue;
      for (let i = 0; i < 5; i++) {
        const char = word[i];
        const status = ev[i];
        if (status === 'correct') {
          map[char] = 'correct';
        } else if (status === 'present' && map[char] !== 'correct') {
          map[char] = 'present';
        } else if (status === 'absent' && !map[char]) {
          map[char] = 'absent';
        }
      }
    }
    return map;
  }

  function renderKeyboard(containerId, guesses, evaluations, onKey) {
    const container = el(containerId);
    container.replaceChildren();
    const keyStates = computeKeyStates(guesses, evaluations);

    KEYBOARD_ROWS.forEach((row) => {
      const rowEl = document.createElement('div');
      rowEl.className = 'keyboard-row';

      row.forEach((k) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'key-btn';
        btn.textContent = k;
        if (k === 'ENTER' || k === '⌫') btn.classList.add('wide');

        const state = keyStates[k];
        if (state) btn.classList.add(state);

        btn.addEventListener('click', () => onKey(k));
        rowEl.appendChild(btn);
      });
      container.appendChild(rowEl);
    });
  }

  function renderGrid(containerId, guesses, evaluations, currentInput, isFinished) {
    const container = el(containerId);
    container.replaceChildren();

    for (let rowIdx = 0; rowIdx < 6; rowIdx++) {
      const rowEl = document.createElement('div');
      rowEl.className = 'grid-row';

      const guessedWord = guesses && guesses[rowIdx];
      const rowEval = evaluations && evaluations[rowIdx];
      const isCurrentRow = !isFinished && rowIdx === (guesses ? guesses.length : 0);

      for (let colIdx = 0; colIdx < 5; colIdx++) {
        const tile = document.createElement('div');
        tile.className = 'tile';

        if (guessedWord) {
          tile.textContent = guessedWord[colIdx];
          tile.classList.add('filled');
          if (rowEval && rowEval[colIdx]) {
            tile.classList.add(rowEval[colIdx]);
          }
        } else if (isCurrentRow && currentInput[colIdx]) {
          tile.textContent = currentInput[colIdx];
          tile.classList.add('filled');
        }

        rowEl.appendChild(tile);
      }
      container.appendChild(rowEl);
    }
  }

  function renderDaily() {
    const daily = currentState?.daily;
    if (!daily) return;

    el('daily-date-label').textContent = currentState.today || 'UTC';
    renderGrid('daily-grid', daily.guesses, daily.evaluations, dailyInput, daily.finished);
    renderKeyboard('daily-keyboard', daily.guesses, daily.evaluations, (k) => handleInputKey(k, 'daily'));

    const banner = el('daily-game-over-banner');
    if (daily.finished) {
      banner.classList.remove('hidden');
      if (daily.won) {
        el('daily-banner-title').textContent = `🎉 Brilliant! Solved in ${daily.guesses.length}/6`;
        el('daily-banner-sub').textContent = 'Your streak continues. See you tomorrow!';
      } else {
        el('daily-banner-title').textContent = 'Defeat!';
        el('daily-banner-sub').textContent = `The target word was: ${daily.targetWord || '???'}`;
      }
    } else {
      banner.classList.add('hidden');
    }
  }

  function renderSpeedDuel() {
    const duel = currentState?.duel;
    const lobbyView = el('duel-lobby-view');
    const gameView = el('duel-game-view');

    // Open lobbies list
    const openDuels = currentState?.openDuels || [];
    el('open-duel-count').textContent = openDuels.length;

    const listEl = el('open-duels-list');
    listEl.replaceChildren();
    if (openDuels.length === 0) {
      const li = document.createElement('li');
      li.className = 'item-row empty-text';
      li.textContent = 'No open lobbies right now.';
      listEl.appendChild(li);
    } else {
      openDuels.forEach((d) => {
        const li = document.createElement('li');
        li.className = 'item-row';
        const info = document.createElement('span');
        info.textContent = `Host: ${d.creator.name} (${d.playerCount} players)`;

        const joinBtn = document.createElement('button');
        joinBtn.type = 'button';
        joinBtn.className = 'btn small primary';
        joinBtn.textContent = 'Join Duel';
        joinBtn.addEventListener('click', () => act({ action: 'join_duel', duel_id: d.id }, 'Joined duel lobby!'));

        li.append(info, joinBtn);
        listEl.appendChild(li);
      });
    }

    if (!duel) {
      lobbyView.classList.remove('hidden');
      gameView.classList.add('hidden');
      clearInterval(duelTimerInterval);
      return;
    }

    lobbyView.classList.add('hidden');
    gameView.classList.remove('hidden');

    // Timer handling
    if (duel.status === 'active' && duel.startedAt) {
      if (!duelTimerInterval) {
        duelTimerInterval = setInterval(() => {
          const sec = ((Date.now() - duel.startedAt) / 1000).toFixed(1);
          el('duel-timer').textContent = `⏱️ ${sec}s`;
        }, 100);
      }
    } else if (duel.status === 'finished') {
      clearInterval(duelTimerInterval);
      duelTimerInterval = null;
      if (duel.startedAt && duel.finishedAt) {
        const sec = ((duel.finishedAt - duel.startedAt) / 1000).toFixed(1);
        el('duel-timer').textContent = `🏁 ${sec}s`;
      }
    } else {
      clearInterval(duelTimerInterval);
      duelTimerInterval = null;
      el('duel-timer').textContent = '⏱️ Waiting';
    }

    // Duel top status
    const startBtn = el('start-duel-btn');
    if (duel.status === 'waiting') {
      el('duel-status-info').textContent = 'Waiting for players...';
      const isHost = duel.creator.id === ctx?.user?.id;
      startBtn.classList.toggle('hidden', !isHost);
    } else if (duel.status === 'active') {
      el('duel-status-info').textContent = 'RACE IN PROGRESS!';
      startBtn.classList.add('hidden');
    } else {
      el('duel-status-info').textContent = 'Duel Finished';
      startBtn.classList.add('hidden');
    }

    // Render my duel grid & keyboard
    renderGrid('duel-grid', duel.myGuesses, duel.myEvaluations, duelInput, duel.myFinished || duel.status === 'finished');
    renderKeyboard('duel-keyboard', duel.myGuesses, duel.myEvaluations, (k) => handleInputKey(k, 'duel'));

    // Render opponent mini-grids
    const oppList = el('opponents-list');
    oppList.replaceChildren();
    if (duel.opponentGrids && duel.opponentGrids.length > 0) {
      duel.opponentGrids.forEach((opp) => {
        const card = document.createElement('div');
        card.className = 'opponent-card';

        const nameEl = document.createElement('div');
        nameEl.className = 'opponent-name';
        nameEl.textContent = `${opp.name}${opp.won ? ' 🏆' : opp.finished ? ' ❌' : ''}`;

        const miniGrid = document.createElement('div');
        miniGrid.className = 'mini-grid';

        for (let r = 0; r < 6; r++) {
          const miniRow = document.createElement('div');
          miniRow.className = 'mini-row';
          const rowEval = opp.evaluations && opp.evaluations[r];
          for (let c = 0; c < 5; c++) {
            const tile = document.createElement('div');
            tile.className = 'mini-tile';
            if (rowEval && rowEval[c]) {
              tile.classList.add(rowEval[c]);
            }
            miniRow.appendChild(tile);
          }
          miniGrid.appendChild(miniRow);
        }

        card.append(nameEl, miniGrid);
        oppList.appendChild(card);
      });
    } else {
      const empty = document.createElement('div');
      empty.className = 'empty-text';
      empty.textContent = 'No other opponents yet.';
      oppList.appendChild(empty);
    }

    // Banner on finish
    const banner = el('duel-game-over-banner');
    if (duel.status === 'finished') {
      banner.classList.remove('hidden');
      if (duel.winner) {
        el('duel-banner-title').textContent = `🏆 Winner: ${duel.winner.name}!`;
        const sec = (duel.winner.solveTimeMs / 1000).toFixed(1);
        el('duel-banner-sub').textContent = `Solved in ${sec}s! Target word: ${duel.targetWord}`;
      } else {
        el('duel-banner-title').textContent = 'Duel Finished!';
        el('duel-banner-sub').textContent = `No winner. Target word: ${duel.targetWord}`;
      }
    } else {
      banner.classList.add('hidden');
    }
  }

  function renderLeaderboards() {
    const list = currentState?.leaderboard || [];

    if (currentState?.myStats) {
      el('my-streak-badge').textContent = `🔥 ${currentState.myStats.currentStreak} streak`;
    }

    const streakTbody = el('streak-table-body');
    streakTbody.replaceChildren();

    if (list.length === 0) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="5" class="empty-text">No stats recorded yet.</td>';
      streakTbody.appendChild(tr);
    } else {
      list.forEach((p, idx) => {
        const tr = document.createElement('tr');
        if (p.id === ctx?.user?.id) tr.classList.add('current-user');
        tr.innerHTML = `
          <td>${idx + 1}</td>
          <td>${p.name || 'Player'}</td>
          <td><strong>🔥 ${p.currentStreak || 0}</strong></td>
          <td>${p.maxStreak || 0}</td>
          <td>${p.wins || 0}</td>
        `;
        streakTbody.appendChild(tr);
      });
    }

    // Speed duels leaderboard
    const speedTbody = el('speed-table-body');
    speedTbody.replaceChildren();
    const speedList = list
      .filter((p) => p.fastestTimeMs != null)
      .sort((a, b) => a.fastestTimeMs - b.fastestTimeMs);

    if (speedList.length === 0) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="4" class="empty-text">No speed duel records yet.</td>';
      speedTbody.appendChild(tr);
    } else {
      speedList.forEach((p, idx) => {
        const tr = document.createElement('tr');
        if (p.id === ctx?.user?.id) tr.classList.add('current-user');
        const sec = (p.fastestTimeMs / 1000).toFixed(1);
        tr.innerHTML = `
          <td>${idx + 1}</td>
          <td>${p.name || 'Player'}</td>
          <td><strong>⚡ ${sec}s</strong></td>
          <td>${p.wins || 0}</td>
        `;
        speedTbody.appendChild(tr);
      });
    }
  }

  function updateUI(state) {
    currentState = state;
    renderDaily();
    renderSpeedDuel();
    renderLeaderboards();
  }

  async function act(data, successMsg) {
    try {
      const res = await CillhubPanel.request(data);
      updateUI(res);
      if (successMsg) setStatus(successMsg, 'success');
      return true;
    } catch (err) {
      setStatus(err.message, 'error');
      return false;
    }
  }

  function handleInputKey(key, mode) {
    const isDaily = mode === 'daily';
    const isDuel = mode === 'duel';

    if (isDaily && currentState?.daily?.finished) return;
    if (isDuel && (currentState?.duel?.myFinished || currentState?.duel?.status !== 'active')) return;

    let input = isDaily ? dailyInput : duelInput;

    if (key === 'ENTER') {
      if (input.length !== 5) {
        setStatus('Word must be 5 letters long.', 'error');
        return;
      }
      const word = input;
      if (isDaily) {
        dailyInput = '';
        act({ action: 'guess_daily', word });
      } else {
        duelInput = '';
        act({ action: 'guess_duel', duel_id: currentState.duel.id, word });
      }
      return;
    }

    if (key === '⌫' || key === 'BACKSPACE') {
      input = input.slice(0, -1);
    } else if (/^[A-Z]$/.test(key) && input.length < 5) {
      input += key;
    }

    if (isDaily) {
      dailyInput = input;
      renderDaily();
    } else {
      duelInput = input;
      renderSpeedDuel();
    }
  }

  // Physical keyboard listener
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    const key = e.key.toUpperCase();
    if (key === 'ENTER' || key === 'BACKSPACE' || /^[A-Z]$/.test(key)) {
      if (currentTab === 'daily') {
        handleInputKey(key === 'BACKSPACE' ? '⌫' : key, 'daily');
      } else if (currentTab === 'duel') {
        handleInputKey(key === 'BACKSPACE' ? '⌫' : key, 'duel');
      }
    }
  });

  // Tab switching
  el('tab-btn-daily').addEventListener('click', () => switchTab('daily'));
  el('tab-btn-duel').addEventListener('click', () => switchTab('duel'));
  el('tab-btn-leaderboard').addEventListener('click', () => switchTab('leaderboard'));

  // Duel buttons
  el('create-duel-btn').addEventListener('click', () => act({ action: 'create_duel' }, 'Lobby created! Waiting for players...'));
  el('start-duel-btn').addEventListener('click', () => {
    if (currentState?.duel) act({ action: 'start_duel', duel_id: currentState.duel.id }, 'Race started!');
  });
  el('leave-duel-btn').addEventListener('click', () => {
    act({ action: 'state' });
  });

  // Bridge Integration
  CillhubPanel.onContext((c) => {
    ctx = c;
    document.documentElement.dataset.theme = c.theme;
    document.documentElement.lang = c.locale;
  });

  CillhubPanel.onEvent((data) => {
    if (data && data.type === 'word_duel_update') {
      CillhubPanel.request({ action: 'state', duel_id: currentState?.duel?.id }).then(updateUI);
    }
  });

  CillhubPanel.ready().then(() => {
    CillhubPanel.request({ action: 'state' }).then(updateUI).catch((err) => setStatus(err.message, 'error'));
  });
})();
