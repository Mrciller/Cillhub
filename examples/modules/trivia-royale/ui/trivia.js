// Trivia Royale UI Controller
(() => {
  let ctx = null;
  let currentState = null;
  let timerInterval = null;

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

  function startTimer(startTime, durationMs) {
    clearInterval(timerInterval);
    const bar = el('timer-bar');

    const tick = () => {
      const elapsed = Date.now() - startTime;
      const remainingRatio = Math.max(0, (durationMs - elapsed) / durationMs);
      bar.style.width = `${(remainingRatio * 100).toFixed(1)}%`;

      bar.classList.toggle('warning', remainingRatio < 0.5 && remainingRatio >= 0.2);
      bar.classList.toggle('critical', remainingRatio < 0.2);

      if (remainingRatio <= 0) {
        clearInterval(timerInterval);
      }
    };

    tick();
    timerInterval = setInterval(tick, 50);
  }

  function renderGame() {
    const lobby = currentState?.lobby;
    const noGamePrompt = el('no-game-prompt');
    const activeArea = el('game-active-area');

    if (!lobby) {
      noGamePrompt.classList.remove('hidden');
      activeArea.classList.add('hidden');
      clearInterval(timerInterval);
      return;
    }

    noGamePrompt.classList.add('hidden');
    activeArea.classList.remove('hidden');

    const phaseWaiting = el('phase-waiting');
    const phaseQuestion = el('phase-question');
    const phaseFinished = el('phase-finished');

    phaseWaiting.classList.add('hidden');
    phaseQuestion.classList.add('hidden');
    phaseFinished.classList.add('hidden');

    if (lobby.status === 'waiting') {
      phaseWaiting.classList.remove('hidden');
      el('waiting-player-count').textContent = lobby.scoreboard.length;

      const listEl = el('waiting-players-list');
      listEl.replaceChildren();
      lobby.scoreboard.forEach((p) => {
        const li = document.createElement('li');
        li.textContent = `• ${p.name}${p.id === lobby.creator.id ? ' (Host)' : ''}`;
        listEl.appendChild(li);
      });

      const startBtn = el('host-start-btn');
      startBtn.classList.toggle('hidden', !lobby.isHost);
      return;
    }

    if (lobby.status === 'finished') {
      phaseFinished.classList.remove('hidden');
      clearInterval(timerInterval);

      const winner = lobby.winner;
      if (winner && winner.score > 0) {
        el('finished-winner-title').textContent = `👑 Winner: ${winner.name}!`;
        el('finished-winner-sub').textContent = `Victory with ${winner.score} points! Champion role awarded.`;
      } else {
        el('finished-winner-title').textContent = 'Match Over!';
        el('finished-winner-sub').textContent = 'Well played everyone!';
      }

      const podium = el('final-podium');
      podium.replaceChildren();
      lobby.scoreboard.forEach((p, idx) => {
        const row = document.createElement('div');
        row.className = `podium-row ${idx === 0 && p.score > 0 ? 'winner' : ''}`;
        row.innerHTML = `
          <span>#${idx + 1} <strong>${p.name}</strong></span>
          <span><strong>${p.score}</strong> pts</span>
        `;
        podium.appendChild(row);
      });
      return;
    }

    // Active Question Phase
    phaseQuestion.classList.remove('hidden');
    const q = lobby.question;
    if (!q) return;

    el('question-category').textContent = q.category;
    el('question-counter').textContent = `Question ${lobby.currentQuestionIndex + 1} / ${lobby.totalQuestions}`;
    el('question-text').textContent = q.question;

    const isReveal = lobby.phase === 'reveal';
    const myAnswer = lobby.myAnswer;

    // Timer bar
    if (isReveal) {
      clearInterval(timerInterval);
      el('timer-bar').style.width = '0%';
    } else if (lobby.questionStartTime) {
      startTimer(lobby.questionStartTime, lobby.questionDurationMs);
    }

    // Choices
    for (let i = 0; i < 4; i++) {
      const btn = el(`choice-${i}`);
      const textSpan = el(`choice-text-${i}`);
      textSpan.textContent = q.choices[i] || '';

      btn.className = 'choice-btn';
      btn.disabled = isReveal || myAnswer !== null;

      if (myAnswer && myAnswer.choiceIndex === i) {
        btn.classList.add('selected');
      }

      if (isReveal) {
        if (q.correctIndex === i) {
          btn.classList.add('correct');
        } else if (myAnswer && myAnswer.choiceIndex === i && !myAnswer.isCorrect) {
          btn.classList.add('incorrect');
        }
      }
    }

    // Reveal box
    const revealBox = el('reveal-box');
    if (isReveal) {
      revealBox.classList.remove('hidden');
      const resEl = el('reveal-result');
      if (myAnswer) {
        if (myAnswer.isCorrect) {
          resEl.className = 'reveal-result correct';
          resEl.textContent = `✅ Correct! +${myAnswer.points} points`;
        } else {
          resEl.className = 'reveal-result incorrect';
          resEl.textContent = '❌ Incorrect!';
        }
      } else {
        resEl.className = 'reveal-result incorrect';
        resEl.textContent = '⏱️ Time up!';
      }
      el('explanation-text').textContent = q.explanation || '';
    } else {
      revealBox.classList.add('hidden');
    }

    // Scoreboard chips
    const chipsEl = el('scoreboard-chips');
    chipsEl.replaceChildren();
    lobby.scoreboard.forEach((p) => {
      const chip = document.createElement('div');
      chip.className = `score-chip ${p.hasAnswered ? 'answered' : ''}`;
      const statusIcon = isReveal
        ? (p.selectedChoice === q.correctIndex ? '🟢' : '🔴')
        : (p.hasAnswered ? '✓' : '…');
      chip.textContent = `${p.name}: ${p.score} pts ${statusIcon}`;
      chipsEl.appendChild(chip);
    });
  }

  function renderLobbies() {
    const openLobbies = currentState?.openLobbies || [];
    el('lobby-count').textContent = openLobbies.length;

    const listEl = el('open-lobbies-list');
    listEl.replaceChildren();
    if (openLobbies.length === 0) {
      const li = document.createElement('li');
      li.className = 'item-row empty-text';
      li.textContent = 'No open match lobbies right now.';
      listEl.appendChild(li);
    } else {
      openLobbies.forEach((l) => {
        const li = document.createElement('li');
        li.className = 'item-row';
        const info = document.createElement('span');
        info.textContent = `Host: ${l.creator.name} · ${l.category} (${l.questionCount} Qs) · ${l.playerCount} players`;

        const joinBtn = document.createElement('button');
        joinBtn.type = 'button';
        joinBtn.className = 'btn small primary';
        joinBtn.textContent = 'Join Lobby';
        joinBtn.addEventListener('click', () => {
          act({ action: 'join_lobby', lobby_id: l.id }, 'Joined lobby!');
          switchTab('game');
        });

        li.append(info, joinBtn);
        listEl.appendChild(li);
      });
    }
  }

  function renderLeaderboard() {
    if (currentState?.champion) {
      el('champion-badge').textContent = `👑 ${currentState.champion.name}`;
    }

    const tbody = el('leaderboard-table-body');
    tbody.replaceChildren();
    const list = currentState?.leaderboard || [];

    if (list.length === 0) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="5" class="empty-text">No scores recorded yet.</td>';
      tbody.appendChild(tr);
    } else {
      list.forEach((p, idx) => {
        const tr = document.createElement('tr');
        if (p.id === ctx?.user?.id) tr.classList.add('current-user');
        tr.innerHTML = `
          <td>${idx + 1}</td>
          <td>${p.name || 'Player'}</td>
          <td><strong>${p.totalPoints || 0}</strong></td>
          <td>${p.matchesWon || 0}</td>
          <td>${p.matchesPlayed || 0}</td>
        `;
        tbody.appendChild(tr);
      });
    }
  }

  function updateUI(state) {
    currentState = state;
    renderGame();
    renderLobbies();
    renderLeaderboard();
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

  // Choice buttons
  for (let i = 0; i < 4; i++) {
    el(`choice-${i}`).addEventListener('click', () => {
      const lobby = currentState?.lobby;
      if (!lobby || lobby.status !== 'active' || lobby.phase !== 'question') return;
      act({ action: 'answer', lobby_id: lobby.id, choice: i });
    });
  }

  // Next Round Button
  el('next-round-btn').addEventListener('click', () => {
    const lobby = currentState?.lobby;
    if (lobby) act({ action: 'next_round', lobby_id: lobby.id });
  });

  // Host Start Match
  el('host-start-btn').addEventListener('click', () => {
    const lobby = currentState?.lobby;
    if (lobby) act({ action: 'start_match', lobby_id: lobby.id }, 'Match started!');
  });

  // Tab switching
  el('tab-btn-game').addEventListener('click', () => switchTab('game'));
  el('tab-btn-lobbies').addEventListener('click', () => switchTab('lobbies'));
  el('tab-btn-custom').addEventListener('click', () => switchTab('custom'));
  el('tab-btn-leaderboard').addEventListener('click', () => switchTab('leaderboard'));

  el('quick-create-btn').addEventListener('click', () => switchTab('lobbies'));
  el('browse-lobbies-btn').addEventListener('click', () => switchTab('lobbies'));
  el('back-to-lobbies-btn').addEventListener('click', () => switchTab('lobbies'));

  // Create Lobby
  el('create-lobby-btn').addEventListener('click', () => {
    const category = el('lobby-category').value;
    const count = el('lobby-count').value;
    act({ action: 'create_lobby', category, count }, 'Lobby created!');
    switchTab('game');
  });

  // Add Custom Question
  el('add-question-btn').addEventListener('click', () => {
    const category = el('custom-category').value;
    const question = el('custom-question').value;
    const choices = [
      el('custom-choice-0').value,
      el('custom-choice-1').value,
      el('custom-choice-2').value,
      el('custom-choice-3').value,
    ];
    const correctRadio = document.querySelector('input[name="custom-correct"]:checked');
    const correctIndex = correctRadio ? Number(correctRadio.value) : 0;
    const explanation = el('custom-explanation').value;

    act({
      action: 'add_custom_question',
      category,
      question,
      choices,
      correctIndex,
      explanation,
    }, 'Custom question added successfully!').then((ok) => {
      if (ok) {
        el('custom-question').value = '';
        el('custom-choice-0').value = '';
        el('custom-choice-1').value = '';
        el('custom-choice-2').value = '';
        el('custom-choice-3').value = '';
        el('custom-explanation').value = '';
      }
    });
  });

  // Bridge Integration
  CillhubPanel.onContext((c) => {
    ctx = c;
    document.documentElement.dataset.theme = c.theme;
    document.documentElement.lang = c.locale;
  });

  CillhubPanel.onEvent((data) => {
    if (data && data.type === 'trivia_update') {
      CillhubPanel.request({ action: 'state', lobby_id: currentState?.lobby?.id }).then(updateUI);
    }
  });

  CillhubPanel.ready().then(() => {
    CillhubPanel.request({ action: 'state' }).then(updateUI).catch((err) => setStatus(err.message, 'error'));
  });
})();
