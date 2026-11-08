// Chess Arena UI Controller
(() => {
  let ctx = null;
  let currentState = null;
  let selectedSquare = null;
  let currentLegalMovesForSelected = [];
  let boardFlipped = false;
  let pendingPromotionMove = null;

  const PIECE_SYMBOLS = {
    wK: '♔', wQ: '♕', wR: '♖', wB: '♗', wN: '♘', wP: '♙',
    bK: '♚', bQ: '♛', bR: '♜', bB: '♝', bN: '♞', bP: '♟',
  };

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
      }, 5000);
    }
  }

  function switchTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach((b) => {
      const active = b.id === `tab-btn-${tabName}`;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', active);
    });
    document.querySelectorAll('.tab-view').forEach((v) => {
      v.classList.toggle('hidden', v.id !== `view-${tabName}`);
      v.classList.toggle('active', v.id === `view-${tabName}`);
    });
  }

  function renderBoard() {
    const boardEl = el('chessboard');
    boardEl.replaceChildren();

    const game = currentState?.game;
    if (!game) return;

    const board = game.board;
    const isFlipped = boardFlipped;

    // Last move from/to squares
    const lastMove = game.moveHistory && game.moveHistory.length > 0 ? game.moveHistory[game.moveHistory.length - 1] : null;

    for (let rowIdx = 0; rowIdx < 8; rowIdx++) {
      for (let colIdx = 0; colIdx < 8; colIdx++) {
        const r = isFlipped ? 7 - rowIdx : rowIdx;
        const c = isFlipped ? 7 - colIdx : colIdx;
        const sqName = 'abcdefgh'[c] + (8 - r);
        const piece = board[r][c];

        const sqEl = document.createElement('div');
        const isLight = (r + c) % 2 === 0;
        sqEl.className = `square ${isLight ? 'light' : 'dark'}`;
        sqEl.dataset.square = sqName;
        sqEl.dataset.r = r;
        sqEl.dataset.c = c;

        // Rank and File labels on edge squares
        if (colIdx === 0) {
          const rankLabel = document.createElement('span');
          rankLabel.className = 'coord-rank';
          rankLabel.textContent = 8 - r;
          sqEl.appendChild(rankLabel);
        }
        if (rowIdx === 7) {
          const fileLabel = document.createElement('span');
          fileLabel.className = 'coord-file';
          fileLabel.textContent = 'abcdefgh'[c];
          sqEl.appendChild(fileLabel);
        }

        // Selection highlight
        if (selectedSquare === sqName) {
          sqEl.classList.add('selected');
        }

        // Last move highlight
        if (lastMove && (lastMove.from === sqName || lastMove.to === sqName)) {
          sqEl.classList.add('last-move');
        }

        // Check highlight on king
        if (game.inCheck && piece && piece === game.turn + 'K') {
          sqEl.classList.add('check');
        }

        // Legal move indicators
        const legalDest = currentLegalMovesForSelected.find((m) => m.to === sqName);
        if (legalDest) {
          if (piece) {
            sqEl.classList.add('legal-capture');
          } else {
            sqEl.classList.add('legal-move');
          }
        }

        // Piece symbol
        if (piece) {
          const pEl = document.createElement('span');
          pEl.className = `piece ${piece[0]}`;
          pEl.textContent = PIECE_SYMBOLS[piece] || piece;
          sqEl.appendChild(pEl);
        }

        sqEl.addEventListener('click', () => onSquareClick(sqName, r, c, piece));
        boardEl.appendChild(sqEl);
      }
    }
  }

  function renderGame() {
    const game = currentState?.game;
    const noGamePrompt = el('no-game-prompt');
    const gameContainer = el('game-container');

    if (!game) {
      noGamePrompt.classList.remove('hidden');
      gameContainer.classList.add('hidden');
      return;
    }

    noGamePrompt.classList.add('hidden');
    gameContainer.classList.remove('hidden');

    // Auto flip board orientation if user plays black
    if (game.myColor === 'b' && !boardFlipped) {
      boardFlipped = true;
    } else if (game.myColor === 'w' && boardFlipped) {
      boardFlipped = false;
    }

    const topIsWhite = boardFlipped;
    const topPlayer = topIsWhite ? game.white : game.black;
    const bottomPlayer = topIsWhite ? game.black : game.white;
    const topColor = topIsWhite ? 'w' : 'b';
    const bottomColor = topIsWhite ? 'b' : 'w';

    el('top-player-name').textContent = `${topPlayer.name} (${topIsWhite ? 'White' : 'Black'})`;
    el('bottom-player-name').textContent = `${bottomPlayer.name} (${topIsWhite ? 'Black' : 'White'})`;

    el('top-color-indicator').className = `player-color-indicator ${topIsWhite ? 'white' : 'black'}`;
    el('bottom-color-indicator').className = `player-color-indicator ${topIsWhite ? 'black' : 'white'}`;

    // Render captured pieces
    const topCapturedPieces = (game.captured && game.captured[topColor]) || [];
    const bottomCapturedPieces = (game.captured && game.captured[bottomColor]) || [];
    el('top-captured').textContent = topCapturedPieces.map((p) => PIECE_SYMBOLS[p] || p).join(' ');
    el('bottom-captured').textContent = bottomCapturedPieces.map((p) => PIECE_SYMBOLS[p] || p).join(' ');

    // Turn / Status
    const turnEl = el('game-turn-indicator');
    if (game.status === 'active') {
      const turnName = game.turn === 'w' ? game.white.name : game.black.name;
      const isMyTurn = game.isMyTurn;
      let text = isMyTurn ? `Your turn (${game.turn === 'w' ? 'White' : 'Black'})` : `${turnName}'s turn`;
      if (game.inCheck) text += ' — CHECK!';
      turnEl.textContent = text;
      turnEl.style.color = game.inCheck ? 'var(--danger)' : 'var(--accent)';
    } else {
      let resultText = 'Game Over: ';
      if (game.status === 'checkmate') {
        const winnerName = game.winner === 'w' ? game.white.name : game.black.name;
        resultText += `Checkmate! ${winnerName} won! 🏆`;
      } else if (game.status === 'resigned') {
        const winnerName = game.winner === 'w' ? game.white.name : game.black.name;
        resultText += `${winnerName} won by resignation!`;
      } else {
        resultText += `Draw (${game.winReason || 'Agreement'}) 🤝`;
      }
      turnEl.textContent = resultText;
      turnEl.style.color = 'var(--text-main)';
    }

    // Draw offer box
    const drawBox = el('draw-offer-box');
    if (game.status === 'active' && game.drawOfferedBy && game.drawOfferedBy !== ctx?.user?.id) {
      drawBox.classList.remove('hidden');
    } else {
      drawBox.classList.add('hidden');
    }

    // Move Log
    const logEl = el('move-log');
    logEl.replaceChildren();
    if (game.moveHistory && game.moveHistory.length > 0) {
      game.moveHistory.forEach((m, i) => {
        const moveSpan = document.createElement('span');
        moveSpan.className = 'move-entry';
        const moveNum = Math.floor(i / 2) + 1;
        if (i % 2 === 0) {
          moveSpan.innerHTML = `<span class="move-num">${moveNum}.</span>${m.notation}`;
        } else {
          moveSpan.textContent = m.notation;
        }
        logEl.appendChild(moveSpan);
      });
      logEl.scrollTop = logEl.scrollHeight;
    } else {
      logEl.textContent = 'No moves yet.';
    }

    renderBoard();
  }

  function renderMatches() {
    const challengesList = el('challenges-list');
    challengesList.replaceChildren();
    const challenges = currentState?.challenges || [];

    el('match-count').textContent = challenges.length;

    if (challenges.length === 0) {
      const li = document.createElement('li');
      li.className = 'item-row empty-text';
      li.textContent = 'No open challenges right now.';
      challengesList.appendChild(li);
    } else {
      challenges.forEach((c) => {
        const li = document.createElement('li');
        li.className = 'item-row';

        const info = document.createElement('span');
        const colorLabel = c.colorPreference === 'w' ? 'Plays White' : c.colorPreference === 'b' ? 'Plays Black' : 'Random Color';
        info.textContent = `${c.creator.name} (${colorLabel})`;

        const action = document.createElement('button');
        action.type = 'button';
        if (c.creator.id === ctx?.user?.id) {
          action.className = 'btn small danger';
          action.textContent = 'Cancel';
          action.addEventListener('click', () => act({ action: 'cancel_challenge' }, 'Challenge cancelled.'));
        } else {
          action.className = 'btn small primary';
          action.textContent = 'Accept Match';
          action.addEventListener('click', () => act({ action: 'accept_challenge', challenge_id: c.id }, 'Match started!'));
        }

        li.append(info, action);
        challengesList.appendChild(li);
      });
    }

    // Active Games list
    const activeGamesList = el('active-games-list');
    activeGamesList.replaceChildren();
    const activeGames = currentState?.activeGames || [];

    if (activeGames.length === 0) {
      const li = document.createElement('li');
      li.className = 'item-row empty-text';
      li.textContent = 'No active games in progress.';
      activeGamesList.appendChild(li);
    } else {
      activeGames.forEach((g) => {
        const li = document.createElement('li');
        li.className = 'item-row';

        const info = document.createElement('span');
        info.textContent = `${g.white.name} (W) vs ${g.black.name} (B) · ${g.moves} moves`;

        const action = document.createElement('button');
        action.type = 'button';
        action.className = 'btn small';
        action.textContent = 'View';
        action.addEventListener('click', () => {
          act({ action: 'state', game_id: g.id }, '');
          switchTab('board');
        });

        li.append(info, action);
        activeGamesList.appendChild(li);
      });
    }
  }

  function renderLeaderboard() {
    const tbody = el('leaderboard-body');
    tbody.replaceChildren();
    const list = currentState?.leaderboard || [];

    if (currentState?.myElo) {
      el('my-elo-badge').textContent = `${currentState.myElo.rating} ELO`;
    }

    if (list.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 6;
      td.className = 'empty-text';
      td.textContent = 'No rated players yet.';
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    list.forEach((p, idx) => {
      const tr = document.createElement('tr');
      if (p.id === ctx?.user?.id) tr.classList.add('current-user');

      tr.innerHTML = `
        <td>${idx + 1}</td>
        <td>${p.name || 'Player'}</td>
        <td><strong>${p.rating}</strong></td>
        <td>${p.wins || 0}</td>
        <td>${p.losses || 0}</td>
        <td>${p.draws || 0}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  function updateUI(state) {
    currentState = state;
    renderGame();
    renderMatches();
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

  function onSquareClick(sqName, r, c, piece) {
    const game = currentState?.game;
    if (!game || game.status !== 'active') return;

    // If destination square is a valid legal move for selected piece
    const legalMove = currentLegalMovesForSelected.find((m) => m.to === sqName);
    if (selectedSquare && legalMove) {
      const fromSq = selectedSquare;
      const toSq = sqName;

      // Check if this move requires pawn promotion
      const fromRc = { r: 8 - parseInt(fromSq[1], 10), c: fromSq.charCodeAt(0) - 97 };
      const pieceAtFrom = game.board[fromRc.r][fromRc.c];
      const isPawnPromo = pieceAtFrom && pieceAtFrom[1] === 'P' && (toSq[1] === '8' || toSq[1] === '1');

      if (isPawnPromo) {
        pendingPromotionMove = { from: fromSq, to: toSq };
        el('promo-modal').classList.remove('hidden');
        return;
      }

      selectedSquare = null;
      currentLegalMovesForSelected = [];
      renderBoard();
      act({ action: 'move', game_id: game.id, from: fromSq, to: toSq });
      return;
    }

    // Select piece if it belongs to current player whose turn it is
    if (piece && piece[0] === game.turn && (game.myColor === game.turn || !game.myColor)) {
      if (selectedSquare === sqName) {
        selectedSquare = null;
        currentLegalMovesForSelected = [];
      } else {
        selectedSquare = sqName;
        currentLegalMovesForSelected = (game.legalMoves && game.legalMoves[sqName]) || [];
      }
      renderBoard();
      return;
    }

    // Clicked elsewhere
    if (selectedSquare) {
      selectedSquare = null;
      currentLegalMovesForSelected = [];
      renderBoard();
    }
  }

  // Promotion choice
  document.querySelectorAll('.promo-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const promoPiece = btn.dataset.piece;
      el('promo-modal').classList.add('hidden');
      if (pendingPromotionMove && currentState?.game) {
        const { from, to } = pendingPromotionMove;
        pendingPromotionMove = null;
        selectedSquare = null;
        currentLegalMovesForSelected = [];
        renderBoard();
        act({ action: 'move', game_id: currentState.game.id, from, to, promotion: promoPiece });
      }
    });
  });

  // Tab switching
  el('tab-btn-board').addEventListener('click', () => switchTab('board'));
  el('tab-btn-matches').addEventListener('click', () => switchTab('matches'));
  el('tab-btn-leaderboard').addEventListener('click', () => switchTab('leaderboard'));

  // Quick challenge buttons
  el('quick-challenge-btn').addEventListener('click', () => switchTab('matches'));
  el('browse-matches-btn').addEventListener('click', () => switchTab('matches'));

  // Create Challenge
  el('create-challenge-btn').addEventListener('click', () => {
    const color = el('color-preference').value;
    act({ action: 'create_challenge', color }, 'Challenge created! Waiting for opponent...');
  });

  // Flip board
  el('flip-board-btn').addEventListener('click', () => {
    boardFlipped = !boardFlipped;
    renderGame();
  });

  // Resign
  el('resign-btn').addEventListener('click', () => {
    if (!currentState?.game) return;
    act({ action: 'resign', game_id: currentState.game.id }, 'You resigned.');
  });

  // Draw offer & response
  el('draw-btn').addEventListener('click', () => {
    if (!currentState?.game) return;
    act({ action: 'offer_draw', game_id: currentState.game.id }, 'Draw offered to opponent.');
  });
  el('accept-draw-btn').addEventListener('click', () => {
    if (!currentState?.game) return;
    act({ action: 'respond_draw', game_id: currentState.game.id, accept: true }, 'Draw accepted.');
  });
  el('decline-draw-btn').addEventListener('click', () => {
    if (!currentState?.game) return;
    act({ action: 'respond_draw', game_id: currentState.game.id, accept: false }, 'Draw declined.');
  });

  // Cillhub Bridge integration
  CillhubPanel.onContext((c) => {
    ctx = c;
    document.documentElement.dataset.theme = c.theme;
    document.documentElement.lang = c.locale;
  });

  CillhubPanel.onEvent((data) => {
    if (data && data.type === 'chess_update') {
      CillhubPanel.request({ action: 'state', game_id: currentState?.game?.id }).then(updateUI);
    }
  });

  CillhubPanel.ready().then(() => {
    CillhubPanel.request({ action: 'state' }).then(updateUI).catch((err) => setStatus(err.message, 'error'));
  });
})();
