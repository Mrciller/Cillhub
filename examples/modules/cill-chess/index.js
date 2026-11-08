// Cillhub Chess Arena (CONTRACT-v8): multiplayer chess engine, ELO leaderboard, and interactive panel.

const K_FACTOR = 32;
const STARTING_ELO = 1200;
const MAX_STORED_GAMES = 20;

const storageKey = (guildId) => `chess:${guildId}:data`;

function rcToSq(r, c) {
  return 'abcdefgh'[c] + (8 - r);
}

function sqToRc(sq) {
  if (!sq || typeof sq !== 'string' || sq.length !== 2) return null;
  const c = sq.charCodeAt(0) - 97;
  const r = 8 - parseInt(sq[1], 10);
  if (r < 0 || r > 7 || c < 0 || c > 7) return null;
  return { r, c };
}

function opponentColor(color) {
  return color === 'w' ? 'b' : 'w';
}

function initialBoard() {
  return [
    ['bR', 'bN', 'bB', 'bQ', 'bK', 'bB', 'bN', 'bR'],
    ['bP', 'bP', 'bP', 'bP', 'bP', 'bP', 'bP', 'bP'],
    [null, null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null, null],
    ['wP', 'wP', 'wP', 'wP', 'wP', 'wP', 'wP', 'wP'],
    ['wR', 'wN', 'wB', 'wQ', 'wK', 'wB', 'wN', 'wR'],
  ];
}

function cloneBoard(b) {
  return b.map((row) => [...row]);
}

function isSquareAttacked(board, r, c, byColor) {
  // Knight attacks
  const knightD = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
  for (const [dr, dc] of knightD) {
    const nr = r + dr, nc = c + dc;
    if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8 && board[nr][nc] === byColor + 'N') return true;
  }

  // Pawn attacks
  const pawnDr = byColor === 'w' ? 1 : -1;
  for (const dc of [-1, 1]) {
    const pr = r + pawnDr, pc = c + dc;
    if (pr >= 0 && pr < 8 && pc >= 0 && pc < 8 && board[pr][pc] === byColor + 'P') return true;
  }

  // King attacks
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const kr = r + dr, kc = c + dc;
      if (kr >= 0 && kr < 8 && kc >= 0 && kc < 8 && board[kr][kc] === byColor + 'K') return true;
    }
  }

  // Orthogonal rays (Rook / Queen)
  const orthDirs = [[0, 1], [0, -1], [1, 0], [-1, 0]];
  for (const [dr, dc] of orthDirs) {
    let nr = r + dr, nc = c + dc;
    while (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
      const p = board[nr][nc];
      if (p) {
        if (p === byColor + 'R' || p === byColor + 'Q') return true;
        break;
      }
      nr += dr;
      nc += dc;
    }
  }

  // Diagonal rays (Bishop / Queen)
  const diagDirs = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  for (const [dr, dc] of diagDirs) {
    let nr = r + dr, nc = c + dc;
    while (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
      const p = board[nr][nc];
      if (p) {
        if (p === byColor + 'B' || p === byColor + 'Q') return true;
        break;
      }
      nr += dr;
      nc += dc;
    }
  }

  return false;
}

function findKing(board, color) {
  const target = color + 'K';
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (board[r][c] === target) return { r, c };
    }
  }
  return null;
}

function isKingInCheck(board, color) {
  const k = findKing(board, color);
  if (!k) return false;
  return isSquareAttacked(board, k.r, k.c, opponentColor(color));
}

function generatePseudoMoves(state) {
  const { board, turn, castling, enPassant } = state;
  const moves = [];
  const opp = opponentColor(turn);

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const piece = board[r][c];
      if (!piece || piece[0] !== turn) continue;
      const type = piece[1];

      if (type === 'P') {
        const dr = turn === 'w' ? -1 : 1;
        const startRow = turn === 'w' ? 6 : 1;
        const promoRow = turn === 'w' ? 0 : 7;

        // 1 square forward
        const f1r = r + dr;
        if (f1r >= 0 && f1r < 8 && !board[f1r][c]) {
          if (f1r === promoRow) {
            for (const promo of ['Q', 'R', 'B', 'N']) {
              moves.push({ from: rcToSq(r, c), to: rcToSq(f1r, c), promotion: promo });
            }
          } else {
            moves.push({ from: rcToSq(r, c), to: rcToSq(f1r, c), promotion: null });
            // 2 squares forward
            const f2r = r + 2 * dr;
            if (r === startRow && !board[f2r][c]) {
              moves.push({ from: rcToSq(r, c), to: rcToSq(f2r, c), promotion: null });
            }
          }
        }

        // Captures
        for (const dc of [-1, 1]) {
          const capC = c + dc;
          if (capC >= 0 && capC < 8) {
            const target = board[f1r]?.[capC];
            if (target && target[0] === opp) {
              if (f1r === promoRow) {
                for (const promo of ['Q', 'R', 'B', 'N']) {
                  moves.push({ from: rcToSq(r, c), to: rcToSq(f1r, capC), promotion: promo });
                }
              } else {
                moves.push({ from: rcToSq(r, c), to: rcToSq(f1r, capC), promotion: null });
              }
            } else if (enPassant && enPassant.r === f1r && enPassant.c === capC) {
              // En passant
              moves.push({ from: rcToSq(r, c), to: rcToSq(f1r, capC), promotion: null, isEnPassant: true });
            }
          }
        }
      } else if (type === 'N') {
        const knightD = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
        for (const [dr, dc] of knightD) {
          const nr = r + dr, nc = c + dc;
          if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8 && (!board[nr][nc] || board[nr][nc][0] === opp)) {
            moves.push({ from: rcToSq(r, c), to: rcToSq(nr, nc), promotion: null });
          }
        }
      } else if (type === 'B' || type === 'R' || type === 'Q') {
        const dirs = [];
        if (type === 'B' || type === 'Q') dirs.push([1, 1], [1, -1], [-1, 1], [-1, -1]);
        if (type === 'R' || type === 'Q') dirs.push([0, 1], [0, -1], [1, 0], [-1, 0]);
        for (const [dr, dc] of dirs) {
          let nr = r + dr, nc = c + dc;
          while (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
            const dest = board[nr][nc];
            if (!dest) {
              moves.push({ from: rcToSq(r, c), to: rcToSq(nr, nc), promotion: null });
            } else {
              if (dest[0] === opp) moves.push({ from: rcToSq(r, c), to: rcToSq(nr, nc), promotion: null });
              break;
            }
            nr += dr;
            nc += dc;
          }
        }
      } else if (type === 'K') {
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            const nr = r + dr, nc = c + dc;
            if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8 && (!board[nr][nc] || board[nr][nc][0] === opp)) {
              moves.push({ from: rcToSq(r, c), to: rcToSq(nr, nc), promotion: null });
            }
          }
        }

        // Castling
        if (turn === 'w' && r === 7 && c === 4) {
          if (castling.wK && !board[7][5] && !board[7][6] && board[7][7] === 'wR') {
            if (!isSquareAttacked(board, 7, 4, 'b') && !isSquareAttacked(board, 7, 5, 'b') && !isSquareAttacked(board, 7, 6, 'b')) {
              moves.push({ from: 'e1', to: 'g1', promotion: null, isCastling: 'K' });
            }
          }
          if (castling.wQ && !board[7][3] && !board[7][2] && !board[7][1] && board[7][0] === 'wR') {
            if (!isSquareAttacked(board, 7, 4, 'b') && !isSquareAttacked(board, 7, 3, 'b') && !isSquareAttacked(board, 7, 2, 'b')) {
              moves.push({ from: 'e1', to: 'c1', promotion: null, isCastling: 'Q' });
            }
          }
        } else if (turn === 'b' && r === 0 && c === 4) {
          if (castling.bK && !board[0][5] && !board[0][6] && board[0][7] === 'bR') {
            if (!isSquareAttacked(board, 0, 4, 'w') && !isSquareAttacked(board, 0, 5, 'w') && !isSquareAttacked(board, 0, 6, 'w')) {
              moves.push({ from: 'e8', to: 'g8', promotion: null, isCastling: 'K' });
            }
          }
          if (castling.bQ && !board[0][3] && !board[0][2] && !board[0][1] && board[0][0] === 'bR') {
            if (!isSquareAttacked(board, 0, 4, 'w') && !isSquareAttacked(board, 0, 3, 'w') && !isSquareAttacked(board, 0, 2, 'w')) {
              moves.push({ from: 'e8', to: 'c8', promotion: null, isCastling: 'Q' });
            }
          }
        }
      }
    }
  }

  return moves;
}

function applyMoveToBoard(state, move) {
  const { from, to, promotion, isEnPassant, isCastling } = move;
  const f = sqToRc(from);
  const t = sqToRc(to);
  const nextBoard = cloneBoard(state.board);
  const piece = nextBoard[f.r][f.c];
  const color = piece[0];
  const type = piece[1];

  let captured = nextBoard[t.r][t.c];

  nextBoard[f.r][f.c] = null;
  if (promotion) {
    nextBoard[t.r][t.c] = color + promotion;
  } else {
    nextBoard[t.r][t.c] = piece;
  }

  if (isEnPassant) {
    const capR = color === 'w' ? t.r + 1 : t.r - 1;
    captured = nextBoard[capR][t.c];
    nextBoard[capR][t.c] = null;
  }

  if (isCastling === 'K') {
    if (color === 'w') {
      nextBoard[7][7] = null;
      nextBoard[7][5] = 'wR';
    } else {
      nextBoard[0][7] = null;
      nextBoard[0][5] = 'bR';
    }
  } else if (isCastling === 'Q') {
    if (color === 'w') {
      nextBoard[7][0] = null;
      nextBoard[7][3] = 'wR';
    } else {
      nextBoard[0][0] = null;
      nextBoard[0][3] = 'bR';
    }
  }

  // Update castling rights
  const nextCastling = { ...state.castling };
  if (type === 'K') {
    if (color === 'w') { nextCastling.wK = false; nextCastling.wQ = false; }
    else { nextCastling.bK = false; nextCastling.bQ = false; }
  } else if (type === 'R') {
    if (from === 'a1') nextCastling.wQ = false;
    else if (from === 'h1') nextCastling.wK = false;
    else if (from === 'a8') nextCastling.bQ = false;
    else if (from === 'h8') nextCastling.bK = false;
  }
  if (to === 'a1') nextCastling.wQ = false;
  else if (to === 'h1') nextCastling.wK = false;
  else if (to === 'a8') nextCastling.bQ = false;
  else if (to === 'h8') nextCastling.bK = false;

  // Update enPassant
  let nextEnPassant = null;
  if (type === 'P' && Math.abs(f.r - t.r) === 2) {
    nextEnPassant = { r: (f.r + t.r) / 2, c: f.c };
  }

  const nextHalfmoveClock = (type === 'P' || captured) ? 0 : (state.halfmoveClock || 0) + 1;
  const nextFullmoveNumber = color === 'b' ? (state.fullmoveNumber || 1) + 1 : (state.fullmoveNumber || 1);

  return {
    board: nextBoard,
    turn: opponentColor(color),
    castling: nextCastling,
    enPassant: nextEnPassant,
    halfmoveClock: nextHalfmoveClock,
    fullmoveNumber: nextFullmoveNumber,
    captured,
  };
}

function getLegalMoves(state) {
  const pseudoMoves = generatePseudoMoves(state);
  const legal = [];
  for (const m of pseudoMoves) {
    const next = applyMoveToBoard(state, m);
    if (!isKingInCheck(next.board, state.turn)) {
      legal.push(m);
    }
  }
  return legal;
}

function isInsufficientMaterial(board) {
  const pieces = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (p) pieces.push({ piece: p, r, c });
    }
  }
  if (pieces.length === 2) return true; // Only K vs K
  if (pieces.length === 3) {
    const nonKing = pieces.find((p) => p.piece[1] !== 'K');
    if (nonKing && (nonKing.piece[1] === 'B' || nonKing.piece[1] === 'N')) return true; // K+B vs K or K+N vs K
  }
  return false;
}

function formatMoveNotation(state, move, isCheck, isMate) {
  if (move.isCastling === 'K') return 'O-O' + (isMate ? '#' : isCheck ? '+' : '');
  if (move.isCastling === 'Q') return 'O-O-O' + (isMate ? '#' : isCheck ? '+' : '');

  const f = sqToRc(move.from);
  const piece = state.board[f.r][f.c];
  const type = piece[1];
  let not = '';
  if (type !== 'P') {
    not += type;
  }
  const isCapture = !!state.board[sqToRc(move.to).r][sqToRc(move.to).c] || move.isEnPassant;
  if (isCapture) {
    if (type === 'P') not += move.from[0];
    not += 'x';
  }
  not += move.to;
  if (move.promotion) not += '=' + move.promotion;
  if (isMate) not += '#';
  else if (isCheck) not += '+';
  return not;
}

function createNewGame(id, whiteUser, blackUser) {
  const state = {
    id,
    white: { id: whiteUser.id, name: whiteUser.name },
    black: { id: blackUser.id, name: blackUser.name },
    board: initialBoard(),
    turn: 'w',
    castling: { wK: true, wQ: true, bK: true, bQ: true },
    enPassant: null,
    halfmoveClock: 0,
    fullmoveNumber: 1,
    status: 'active', // 'active', 'checkmate', 'stalemate', 'draw', 'resigned'
    winner: null,     // 'w', 'b', null
    winReason: null,
    moveHistory: [],
    captured: { w: [], b: [] }, // Pieces captured by White, Pieces captured by Black
    drawOfferedBy: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  return state;
}

function calculateElo(whiteRating, blackRating, scoreWhite) {
  const expectedWhite = 1 / (1 + Math.pow(10, (blackRating - whiteRating) / 400));
  const expectedBlack = 1 - expectedWhite;
  const scoreBlack = 1 - scoreWhite;
  const newWhite = Math.round(whiteRating + K_FACTOR * (scoreWhite - expectedWhite));
  const newBlack = Math.round(blackRating + K_FACTOR * (scoreBlack - expectedBlack));
  return { newWhite, newBlack };
}

async function loadData(guildId) {
  const data = await cillhub.call('storage.get', { key: storageKey(guildId) });
  return data || { games: [], challenges: [], elo: {} };
}

async function saveData(guildId, data) {
  await cillhub.call('storage.set', { key: storageKey(guildId), value: data });
  try {
    await cillhub.call('ui.publish', { guild_id: guildId, data: { type: 'chess_update' } });
  } catch (err) {
    console.warn(`ui.publish failed: ${err.message}`);
  }
}

function getUserElo(eloMap, userId, defaultName) {
  if (!eloMap[userId]) {
    eloMap[userId] = {
      rating: STARTING_ELO,
      games: 0,
      wins: 0,
      losses: 0,
      draws: 0,
      name: defaultName || 'Player',
    };
  } else if (defaultName) {
    eloMap[userId].name = defaultName;
  }
  return eloMap[userId];
}

function buildClientGameState(game, userId) {
  if (!game) return null;
  const legalMoves = game.status === 'active' ? getLegalMoves(game) : [];
  const inCheck = game.status === 'active' ? isKingInCheck(game.board, game.turn) : false;

  // Group legal moves by from-square for easy UI lookup
  const legalByFrom = {};
  for (const m of legalMoves) {
    if (!legalByFrom[m.from]) legalByFrom[m.from] = [];
    legalByFrom[m.from].push({ to: m.to, promotion: m.promotion });
  }

  const isPlayerWhite = game.white.id === userId;
  const isPlayerBlack = game.black.id === userId;
  const myColor = isPlayerWhite ? 'w' : isPlayerBlack ? 'b' : null;
  const isMyTurn = game.status === 'active' && myColor === game.turn;

  return {
    id: game.id,
    white: game.white,
    black: game.black,
    board: game.board,
    turn: game.turn,
    status: game.status,
    winner: game.winner,
    winReason: game.winReason,
    moveHistory: game.moveHistory,
    captured: game.captured,
    drawOfferedBy: game.drawOfferedBy,
    inCheck,
    legalMoves: legalByFrom,
    myColor,
    isMyTurn,
  };
}

// UI_REQUEST handler
cillhub.on('UI_REQUEST', async (req) => {
  const guildId = req.guild_id;
  const data = (req.data && typeof req.data === 'object') ? req.data : {};
  const me = { id: req.user.id, name: req.user.global_name || req.user.username };

  const store = await loadData(guildId);
  store.elo = store.elo || {};
  store.games = store.games || [];
  store.challenges = store.challenges || [];

  getUserElo(store.elo, me.id, me.name);

  const getLeaderboard = () => {
    return Object.entries(store.elo)
      .map(([id, stats]) => ({ id, ...stats }))
      .sort((a, b) => b.rating - a.rating || b.wins - a.wins)
      .slice(0, 20);
  };

  const getResponse = (activeGameId) => {
    let currentGame = null;
    if (activeGameId) {
      currentGame = store.games.find((g) => g.id === activeGameId);
    }
    if (!currentGame) {
      currentGame = store.games.find((g) => (g.white.id === me.id || g.black.id === me.id) && g.status === 'active');
    }
    if (!currentGame && store.games.length > 0) {
      currentGame = store.games[store.games.length - 1];
    }

    return {
      game: buildClientGameState(currentGame, me.id),
      activeGames: store.games.filter((g) => g.status === 'active').map((g) => ({
        id: g.id,
        white: g.white,
        black: g.black,
        turn: g.turn,
        moves: g.moveHistory.length,
      })),
      challenges: store.challenges.map((c) => ({
        id: c.id,
        creator: c.creator,
        colorPreference: c.colorPreference,
        createdAt: c.createdAt,
      })),
      leaderboard: getLeaderboard(),
      myElo: store.elo[me.id],
    };
  };

  if (!data.action || data.action === 'state') {
    return getResponse(data.game_id);
  }

  if (data.action === 'create_challenge') {
    const existing = store.challenges.find((c) => c.creator.id === me.id);
    if (existing) throw new Error('You already have an open challenge.');
    const challengeId = await cillhub.call('crypto.random', { bytes: 6 });
    if (data.color === 'white') data.color = 'w';
    else if (data.color === 'black') data.color = 'b';
    store.challenges.push({
      id: challengeId,
      creator: me,
      colorPreference: data.color === 'w' || data.color === 'b' ? data.color : 'random',
      createdAt: Date.now(),
    });
    await saveData(guildId, store);
    return getResponse();
  }

  if (data.action === 'cancel_challenge') {
    store.challenges = store.challenges.filter((c) => c.creator.id !== me.id);
    await saveData(guildId, store);
    return getResponse();
  }

  if (data.action === 'accept_challenge') {
    const challengeIndex = store.challenges.findIndex((c) => c.id === data.challenge_id);
    if (challengeIndex === -1) throw new Error('That challenge is no longer available.');
    const challenge = store.challenges[challengeIndex];
    if (challenge.creator.id === me.id) throw new Error('You cannot accept your own challenge.');
    store.challenges.splice(challengeIndex, 1);

    let whiteUser = challenge.creator;
    let blackUser = me;
    if (challenge.colorPreference === 'b') {
      whiteUser = me;
      blackUser = challenge.creator;
    } else if (challenge.colorPreference === 'random') {
      if (Math.random() < 0.5) {
        whiteUser = me;
        blackUser = challenge.creator;
      }
    }

    getUserElo(store.elo, whiteUser.id, whiteUser.name);
    getUserElo(store.elo, blackUser.id, blackUser.name);

    const gameId = await cillhub.call('crypto.random', { bytes: 6 });
    const game = createNewGame(gameId, whiteUser, blackUser);
    store.games.unshift(game);
    if (store.games.length > MAX_STORED_GAMES) store.games.pop();

    await saveData(guildId, store);
    return getResponse(gameId);
  }

  if (data.action === 'move') {
    const game = store.games.find((g) => g.id === data.game_id);
    if (!game) throw new Error('Game not found.');
    if (game.status !== 'active') throw new Error('This game has already finished.');

    const isWhite = game.white.id === me.id;
    const isBlack = game.black.id === me.id;
    if (!isWhite && !isBlack) throw new Error('You are a spectator in this game.');
    if ((game.turn === 'w' && !isWhite) || (game.turn === 'b' && !isBlack)) {
      throw new Error("It is not your turn.");
    }

    const legalMoves = getLegalMoves(game);
    const chosenMove = legalMoves.find(
      (m) => m.from === data.from && m.to === data.to && (!m.promotion || m.promotion === data.promotion)
    );
    if (!chosenMove) throw new Error('Illegal move.');

    const prevBoard = game.board;
    const nextState = applyMoveToBoard(game, chosenMove);
    game.board = nextState.board;
    game.turn = nextState.turn;
    game.castling = nextState.castling;
    game.enPassant = nextState.enPassant;
    game.halfmoveClock = nextState.halfmoveClock;
    game.fullmoveNumber = nextState.fullmoveNumber;
    game.updatedAt = Date.now();
    game.drawOfferedBy = null; // Clear draw offers on move

    if (nextState.captured) {
      if (chosenMove.from) {
        const movingColor = opponentColor(nextState.turn);
        game.captured[movingColor].push(nextState.captured);
      }
    }

    // Check game ending conditions
    const oppLegalMoves = getLegalMoves(game);
    const oppInCheck = isKingInCheck(game.board, game.turn);
    const isMate = oppInCheck && oppLegalMoves.length === 0;
    const isStale = !oppInCheck && oppLegalMoves.length === 0;
    const isInsufficient = isInsufficientMaterial(game.board);
    const is50Move = game.halfmoveClock >= 100;

    const notation = formatMoveNotation({ board: prevBoard }, chosenMove, oppInCheck, isMate);
    game.moveHistory.push({
      from: chosenMove.from,
      to: chosenMove.to,
      promotion: chosenMove.promotion,
      notation,
      by: me.id,
      at: Date.now(),
    });

    if (isMate) {
      game.status = 'checkmate';
      game.winner = opponentColor(game.turn);
      game.winReason = 'Checkmate';
    } else if (isStale) {
      game.status = 'stalemate';
      game.winner = null;
      game.winReason = 'Stalemate';
    } else if (isInsufficient) {
      game.status = 'draw';
      game.winner = null;
      game.winReason = 'Insufficient material';
    } else if (is50Move) {
      game.status = 'draw';
      game.winner = null;
      game.winReason = '50-move rule';
    }

    if (game.status !== 'active') {
      const whiteStats = getUserElo(store.elo, game.white.id, game.white.name);
      const blackStats = getUserElo(store.elo, game.black.id, game.black.name);
      const scoreWhite = game.winner === 'w' ? 1 : game.winner === 'b' ? 0 : 0.5;
      const { newWhite, newBlack } = calculateElo(whiteStats.rating, blackStats.rating, scoreWhite);

      whiteStats.rating = newWhite;
      blackStats.rating = newBlack;
      whiteStats.games++;
      blackStats.games++;
      if (scoreWhite === 1) {
        whiteStats.wins++;
        blackStats.losses++;
      } else if (scoreWhite === 0) {
        whiteStats.losses++;
        blackStats.wins++;
      } else {
        whiteStats.draws++;
        blackStats.draws++;
      }

      // Send game over notification message if channel exists
      if (req.channel_id) {
        try {
          const outcomeText = game.winner === 'w'
            ? `🏆 **${game.white.name}** won against **${game.black.name}** by ${game.winReason}!`
            : game.winner === 'b'
            ? `🏆 **${game.black.name}** won against **${game.white.name}** by ${game.winReason}!`
            : `🤝 Game between **${game.white.name}** and **${game.black.name}** ended in a Draw (${game.winReason}).`;
          await cillhub.call('messages.send', {
            channel_id: req.channel_id,
            content: `${outcomeText}\nNew Ratings: **${game.white.name}** (${newWhite}) · **${game.black.name}** (${newBlack})`,
          });
        } catch (err) {
          console.warn(`Could not send chess game-over message: ${err.message}`);
        }
      }
    }

    await saveData(guildId, store);
    return getResponse(game.id);
  }

  if (data.action === 'resign') {
    const game = store.games.find((g) => g.id === data.game_id);
    if (!game || game.status !== 'active') throw new Error('Game not active.');
    const isWhite = game.white.id === me.id;
    const isBlack = game.black.id === me.id;
    if (!isWhite && !isBlack) throw new Error('You are not a player in this game.');

    game.status = 'resigned';
    game.winner = isWhite ? 'b' : 'w';
    game.winReason = `${me.name} resigned`;
    game.updatedAt = Date.now();

    const whiteStats = getUserElo(store.elo, game.white.id, game.white.name);
    const blackStats = getUserElo(store.elo, game.black.id, game.black.name);
    const scoreWhite = game.winner === 'w' ? 1 : 0;
    const { newWhite, newBlack } = calculateElo(whiteStats.rating, blackStats.rating, scoreWhite);
    whiteStats.rating = newWhite;
    blackStats.rating = newBlack;
    whiteStats.games++;
    blackStats.games++;
    if (scoreWhite === 1) { whiteStats.wins++; blackStats.losses++; }
    else { whiteStats.losses++; blackStats.wins++; }

    await saveData(guildId, store);
    return getResponse(game.id);
  }

  if (data.action === 'offer_draw') {
    const game = store.games.find((g) => g.id === data.game_id);
    if (!game || game.status !== 'active') throw new Error('Game not active.');
    const isWhite = game.white.id === me.id;
    const isBlack = game.black.id === me.id;
    if (!isWhite && !isBlack) throw new Error('You are not a player in this game.');
    game.drawOfferedBy = me.id;
    await saveData(guildId, store);
    return getResponse(game.id);
  }

  if (data.action === 'respond_draw') {
    const game = store.games.find((g) => g.id === data.game_id);
    if (!game || game.status !== 'active') throw new Error('Game not active.');
    if (!game.drawOfferedBy || game.drawOfferedBy === me.id) throw new Error('No draw offer to respond to.');
    const isWhite = game.white.id === me.id;
    const isBlack = game.black.id === me.id;
    if (!isWhite && !isBlack) throw new Error('You are not a player in this game.');

    if (data.accept) {
      game.status = 'draw';
      game.winner = null;
      game.winReason = 'Mutual agreement';
      game.updatedAt = Date.now();
      const whiteStats = getUserElo(store.elo, game.white.id, game.white.name);
      const blackStats = getUserElo(store.elo, game.black.id, game.black.name);
      const { newWhite, newBlack } = calculateElo(whiteStats.rating, blackStats.rating, 0.5);
      whiteStats.rating = newWhite;
      blackStats.rating = newBlack;
      whiteStats.games++;
      blackStats.games++;
      whiteStats.draws++;
      blackStats.draws++;
    } else {
      game.drawOfferedBy = null;
    }

    await saveData(guildId, store);
    return getResponse(game.id);
  }

  throw new Error(`Unknown action: ${data.action}`);
});

// /chess slash command
cillhub.on('INTERACTION_CREATE', async (interaction) => {
  if (interaction.type !== 2 || interaction.data?.name !== 'chess') return;
  if (!interaction.guild_id) {
    return { type: 4, data: { content: 'Chess Arena can only be used inside a server.', flags: 64 } };
  }

  const store = await loadData(interaction.guild_id);
  const activeGames = (store.games || []).filter((g) => g.status === 'active');
  const challenges = store.challenges || [];
  const eloList = Object.entries(store.elo || {})
    .map(([id, s]) => ({ id, ...s }))
    .sort((a, b) => b.rating - a.rating)
    .slice(0, 5);

  let content = '## ♟️ Chess Arena\n\n';

  content += '### 🏆 ELO Leaderboard\n';
  if (eloList.length === 0) {
    content += '_No rated games played yet._\n';
  } else {
    eloList.forEach((p, idx) => {
      content += `${idx + 1}. **${p.name}** — **${p.rating}** ELO (${p.wins}W / ${p.losses}L / ${p.draws}D)\n`;
    });
  }

  content += '\n### ⚔️ Active Games\n';
  if (activeGames.length === 0) {
    content += '_No ongoing games currently._\n';
  } else {
    activeGames.slice(0, 5).forEach((g) => {
      const turnName = g.turn === 'w' ? g.white.name : g.black.name;
      content += `• **${g.white.name}** (White) vs **${g.black.name}** (Black) — Turn: **${turnName}** (Move ${Math.floor(g.moveHistory.length / 2) + 1})\n`;
    });
  }

  if (challenges.length > 0) {
    content += `\n**Open Challenges:** ${challenges.length} player(s) waiting for a match!\n`;
  }

  content += '\n_Open the **Chess Arena** channel panel in the header to play!_';

  return {
    type: 4,
    data: {
      content,
      allowed_mentions: { parse: [] },
    },
  };
});
