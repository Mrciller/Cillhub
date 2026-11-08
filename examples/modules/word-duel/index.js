// Word Duel (CONTRACT-v8): multiplayer 5-letter word game with Daily Word and Live Speed Duels.

const WORD_BANK = [
  'ABOUT', 'ABOVE', 'ACTOR', 'ACUTE', 'ADMIT', 'ADOPT', 'ADULT', 'AFTER', 'AGAIN', 'AGENT',
  'AGREE', 'AHEAD', 'ALARM', 'ALBUM', 'ALERT', 'ALIKE', 'ALIVE', 'ALLOW', 'ALONE', 'ALONG',
  'ALTER', 'AMONG', 'ANGER', 'ANGLE', 'ANGRY', 'APART', 'APPLE', 'APPLY', 'ARENA', 'ARGUE',
  'ARISE', 'ARRAY', 'ASIDE', 'ASSET', 'AUDIO', 'AUDIT', 'AVOID', 'AWARD', 'AWARE', 'BADLY',
  'BAKER', 'BASES', 'BASIC', 'BASIS', 'BEACH', 'BEGAN', 'BEGIN', 'BEGUN', 'BEING', 'BELOW',
  'BENCH', 'BILLY', 'BIRTH', 'BLACK', 'BLAME', 'BLIND', 'BLOCK', 'BLOOD', 'BOARD', 'BOOST',
  'BOOTH', 'BOUND', 'BRAIN', 'BRAND', 'BREAD', 'BREAK', 'BREED', 'BRIEF', 'BRING', 'BROAD',
  'BROKE', 'BROWN', 'BUILD', 'BUILT', 'BUYER', 'CABLE', 'CALIF', 'CARRY', 'CATCH', 'CAUSE',
  'CHAIN', 'CHAIR', 'CHART', 'CHASE', 'CHEAP', 'CHECK', 'CHEST', 'CHIEF', 'CHILD', 'CHINA',
  'CHOSE', 'CIVIL', 'CLAIM', 'CLASS', 'CLEAN', 'CLEAR', 'CLICK', 'CLOCK', 'CLOSE', 'COACH',
  'COAST', 'COULD', 'COUNT', 'COURT', 'COVER', 'CRAFT', 'CRANE', 'CRASH', 'CRAZY', 'CREAM',
  'CRIME', 'CROSS', 'CROWD', 'CROWN', 'CRUDE', 'CYCLE', 'DAILY', 'DANCE', 'DATED', 'DEALT',
  'DEATH', 'DEBUT', 'DELAY', 'DEPTH', 'DOING', 'DOUBT', 'DOZEN', 'DRAFT', 'DRAMA', 'DRAWN',
  'DREAM', 'DRESS', 'DRILL', 'DRINK', 'DRIVE', 'DROVE', 'DYING', 'EAGER', 'EARLY', 'EARTH',
  'EIGHT', 'ELITE', 'EMPTY', 'ENEMY', 'ENJOY', 'ENTER', 'ENTRY', 'EQUAL', 'ERROR', 'EVENT',
  'EVERY', 'EXACT', 'EXIST', 'EXTRA', 'FAITH', 'FALSE', 'FAULT', 'FIBER', 'FIELD', 'FIFTH',
  'FIFTY', 'FIGHT', 'FINAL', 'FIRST', 'FIXED', 'FLASH', 'FLEET', 'FLOOR', 'FLUID', 'FOCUS',
  'FORCE', 'FORTH', 'FORTY', 'FORUM', 'FOUND', 'FRAME', 'FRANK', 'FRAUD', 'FRESH', 'FRONT',
  'FRUIT', 'FULLY', 'FUNNY', 'GIANT', 'GIVEN', 'GLASS', 'GLOBE', 'GOING', 'GRACE', 'GRADE',
  'GRAND', 'GRANT', 'GRASS', 'GREAT', 'GREEN', 'GROSS', 'GROUP', 'GROWN', 'GUARD', 'GUESS',
  'GUEST', 'GUIDE', 'HAPPY', 'HARRY', 'HEART', 'HEAVY', 'HENCE', 'HORSE', 'HOTEL', 'HOUSE',
  'HUMAN', 'IDEAL', 'IMAGE', 'INDEX', 'INNER', 'INPUT', 'ISSUE', 'JAPAN', 'JIMMY', 'JOINT',
  'JONES', 'JUDGE', 'KNOWN', 'LABEL', 'LARGE', 'LASER', 'LATER', 'LAUGH', 'LAYER', 'LEARN',
  'LEASE', 'LEAST', 'LEAVE', 'LEGAL', 'LEVEL', 'LIGHT', 'LIMIT', 'LOCAL', 'LOGIC', 'LOOSE',
  'LOWER', 'LUCKY', 'LUNCH', 'MAGIC', 'MAJOR', 'MAKER', 'MARCH', 'MATCH', 'MAYBE', 'MAYOR',
  'MEANT', 'MEDIA', 'METAL', 'MIGHT', 'MINOR', 'MINUS', 'MIXED', 'MODEL', 'MONEY', 'MONTH',
  'MORAL', 'MOTOR', 'MOUNT', 'MOUSE', 'MOUTH', 'MOVIE', 'MUSIC', 'NEEDS', 'NEVER', 'NEWLY',
  'NIGHT', 'NOISE', 'NORTH', 'NOTED', 'NOVEL', 'NURSE', 'OCCUR', 'OCEAN', 'OFFER', 'OFTEN',
  'ORDER', 'OTHER', 'OUGHT', 'PAINT', 'PANEL', 'PAPER', 'PARTY', 'PEACE', 'PETER', 'PHASE',
  'PHONE', 'PHOTO', 'PIECE', 'PILOT', 'PITCH', 'PLACE', 'PLAIN', 'PLANE', 'PLANT', 'PLATE',
  'POINT', 'POUND', 'POWER', 'PRESS', 'PRICE', 'PRIDE', 'PRIME', 'PRINT', 'PRIOR', 'PRIZE',
  'PROOF', 'PROUD', 'PROVE', 'QUEEN', 'QUICK', 'QUIET', 'QUITE', 'RADIO', 'RAISE', 'RANGE',
  'RAPID', 'RATIO', 'REACH', 'READY', 'REFER', 'RIGHT', 'RIVAL', 'RIVER', 'ROBIN', 'ROGER',
  'ROMAN', 'ROUGH', 'ROUND', 'ROUTE', 'ROYAL', 'RURAL', 'SCALE', 'SCENE', 'SCOPE', 'SCORE',
  'SENSE', 'SERVE', 'SEVEN', 'SHALL', 'SHAPE', 'SHARE', 'SHARP', 'SHEET', 'SHELF', 'SHELL',
  'SHIFT', 'SHINE', 'SHIRT', 'SHOCK', 'SHOOT', 'SHORT', 'SHOWN', 'SIGHT', 'SINCE', 'SIXTH',
  'SIXTY', 'SIZED', 'SKILL', 'SLEEP', 'SLIDE', 'SMALL', 'SMART', 'SMILE', 'SMITH', 'SMOKE',
  'SOLID', 'SOLVE', 'SORRY', 'SOUND', 'SOUTH', 'SPACE', 'SPARE', 'SPEAK', 'SPEED', 'SPEND',
  'SPENT', 'SPLIT', 'SPOKE', 'SPORT', 'STAFF', 'STAGE', 'STAKE', 'STAND', 'START', 'STATE',
  'STEAM', 'STEEL', 'STICK', 'STILL', 'STOCK', 'STONE', 'STOOD', 'STORE', 'STORM', 'STORY',
  'STRIP', 'STUDY', 'STUFF', 'STYLE', 'SUGAR', 'SUITE', 'SUPER', 'SWEET', 'TABLE', 'TAKEN',
  'TASTE', 'TAXES', 'TEACH', 'TEETH', 'TERRY', 'TEXAS', 'THANK', 'THEFT', 'THEIR', 'THEME',
  'THERE', 'THESE', 'THICK', 'THING', 'THINK', 'THIRD', 'THOSE', 'THREE', 'THREW', 'THROW',
  'TIGHT', 'TIMES', 'TIRED', 'TITLE', 'TODAY', 'TOPIC', 'TOTAL', 'TOUCH', 'TOUGH', 'TOWER',
  'TRACK', 'TRADE', 'TRAIN', 'TREAT', 'TREND', 'TRIAL', 'TRIED', 'TRIES', 'TRUCK', 'TRULY',
  'TRUST', 'TRUTH', 'TWICE', 'UNDER', 'UNDUE', 'UNION', 'UNITY', 'UNTIL', 'UPPER', 'UPSET',
  'URBAN', 'USAGE', 'USUAL', 'VALID', 'VALUE', 'VIDEO', 'VIRUS', 'VISIT', 'VITAL', 'VOICE',
  'WASTE', 'WATCH', 'WATER', 'WHEEL', 'WHERE', 'WHICH', 'WHILE', 'WHITE', 'WHOLE', 'WHOSE',
  'WOMAN', 'WOMEN', 'WORLD', 'WORRY', 'WORSE', 'WORST', 'WORTH', 'WOULD', 'WOUND', 'WRITE',
  'WRONG', 'WROTE', 'YIELD', 'YOUNG', 'YOUTH', 'SLATE', 'ADIEU', 'STARE', 'AROSE', 'IRATE',
  'TRACE', 'CRATE', 'ROAST', 'REACT', 'GHOST', 'FLAME', 'SWORD', 'QUEST', 'PIXEL', 'CHESS',
];

const WORD_SET = new Set(WORD_BANK);
const isValidGuess = (w) => WORD_SET.has(w) || (/^[A-Z]{5}$/.test(w) && /[AEIOUY]/.test(w) && !/(.)\1\1/.test(w));

const MAX_GUESSES = 6;
const storageKey = (guildId) => `wordduel:${guildId}:data`;

function getUtcDateStr() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getDailyTargetWord(dateStr, guildId) {
  let hash = 0;
  const str = `${dateStr}:${guildId}`;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % WORD_BANK.length;
  return WORD_BANK[idx];
}

function evaluateGuess(guess, target) {
  const result = Array(5).fill('absent');
  const targetChars = target.split('');
  const guessChars = guess.toUpperCase().split('');
  const remaining = {};

  // 1st pass: correct letters in correct spots
  for (let i = 0; i < 5; i++) {
    const t = targetChars[i];
    if (guessChars[i] === t) {
      result[i] = 'correct';
    } else {
      remaining[t] = (remaining[t] || 0) + 1;
    }
  }

  // 2nd pass: letters in target but wrong position
  for (let i = 0; i < 5; i++) {
    if (result[i] === 'correct') continue;
    const g = guessChars[i];
    if (remaining[g] > 0) {
      result[i] = 'present';
      remaining[g]--;
    }
  }

  return result;
}

async function loadStore(guildId) {
  const data = await cillhub.call('storage.get', { key: storageKey(guildId) });
  return (
    data || {
      daily: {},      // dateStr -> { targetWord, players: { [userId]: { guesses, evaluations, finished, won } } }
      duels: [],      // active & recent live speed duels
      stats: {},      // userId -> { name, wins, currentStreak, maxStreak, totalGames, fastestTimeMs, guessDist }
    }
  );
}

async function saveStore(guildId, store) {
  await cillhub.call('storage.set', { key: storageKey(guildId), value: store });
  try {
    await cillhub.call('ui.publish', { guild_id: guildId, data: { type: 'word_duel_update' } });
  } catch (err) {
    console.warn(`ui.publish failed: ${err.message}`);
  }
}

function getUserStats(statsMap, userId, defaultName) {
  if (!statsMap[userId]) {
    statsMap[userId] = {
      name: defaultName || 'Player',
      wins: 0,
      currentStreak: 0,
      maxStreak: 0,
      totalGames: 0,
      fastestTimeMs: null,
      guessDist: [0, 0, 0, 0, 0, 0],
    };
  } else if (defaultName) {
    statsMap[userId].name = defaultName;
  }
  return statsMap[userId];
}

// Builds client-safe view of a live speed duel
function buildClientDuelView(duel, viewerId) {
  if (!duel) return null;
  const isParticipant = !!duel.players[viewerId];
  const myPlayer = duel.players[viewerId];
  const myFinished = myPlayer?.finished;

  const opponentGrids = [];
  for (const [id, p] of Object.entries(duel.players)) {
    if (id === viewerId) continue;
    // Broadcast opponent tile color grids WITHOUT revealing their guessed letters until they finish or viewer finishes!
    const canSeeLetters = myFinished || p.finished || duel.status === 'finished';
    opponentGrids.push({
      userId: id,
      name: p.name,
      evaluations: p.evaluations,
      guesses: canSeeLetters ? p.guesses : null, // Masked while in progress!
      guessCount: p.guesses.length,
      finished: p.finished,
      won: p.won,
      solveTimeMs: p.solveTimeMs,
    });
  }

  return {
    id: duel.id,
    creator: duel.creator,
    status: duel.status, // 'waiting', 'active', 'finished'
    startedAt: duel.startedAt,
    finishedAt: duel.finishedAt,
    winner: duel.winner,
    isParticipant,
    myGuesses: myPlayer?.guesses || [],
    myEvaluations: myPlayer?.evaluations || [],
    myFinished: !!myFinished,
    myWon: !!myPlayer?.won,
    opponentGrids,
    // Reveal target word only once duel is finished or viewer finished!
    targetWord: (duel.status === 'finished' || myFinished) ? duel.targetWord : null,
  };
}

// UI_REQUEST handler
cillhub.on('UI_REQUEST', async (req) => {
  const guildId = req.guild_id;
  const data = (req.data && typeof req.data === 'object') ? req.data : {};
  const me = { id: req.user.id, name: req.user.global_name || req.user.username };

  const store = await loadStore(guildId);
  store.daily = store.daily || {};
  store.duels = store.duels || [];
  store.stats = store.stats || {};

  const today = getUtcDateStr();
  if (!store.daily[today]) {
    store.daily[today] = {
      targetWord: getDailyTargetWord(today, guildId),
      players: {},
    };
  }

  const dailyRound = store.daily[today];
  if (!dailyRound.players[me.id]) {
    dailyRound.players[me.id] = {
      guesses: [],
      evaluations: [],
      finished: false,
      won: false,
    };
  }

  getUserStats(store.stats, me.id, me.name);

  const getLeaderboard = () => {
    return Object.entries(store.stats)
      .map(([id, s]) => ({ id, ...s }))
      .sort((a, b) => b.currentStreak - a.currentStreak || b.wins - a.wins)
      .slice(0, 20);
  };

  const buildResponse = (activeDuelId) => {
    const myDaily = dailyRound.players[me.id];
    let selectedDuel = null;
    if (activeDuelId) {
      selectedDuel = store.duels.find((d) => d.id === activeDuelId);
    }
    if (!selectedDuel) {
      selectedDuel = store.duels.find((d) => d.players[me.id] && d.status === 'active');
    }
    if (!selectedDuel && store.duels.length > 0) {
      selectedDuel = store.duels[0];
    }

    return {
      today,
      daily: {
        guesses: myDaily.guesses,
        evaluations: myDaily.evaluations,
        finished: myDaily.finished,
        won: myDaily.won,
        targetWord: myDaily.finished ? dailyRound.targetWord : null,
      },
      duel: buildClientDuelView(selectedDuel, me.id),
      openDuels: store.duels.filter((d) => d.status === 'waiting').map((d) => ({
        id: d.id,
        creator: d.creator,
        playerCount: Object.keys(d.players).length,
      })),
      leaderboard: getLeaderboard(),
      myStats: store.stats[me.id],
    };
  };

  if (!data.action || data.action === 'state') {
    return buildResponse(data.duel_id);
  }

  // Action: Submit a guess in Daily Word
  if (data.action === 'guess_daily') {
    const rawGuess = String(data.word || '').trim().toUpperCase();
    if (rawGuess.length !== 5 || !/^[A-Z]{5}$/.test(rawGuess)) {
      throw new Error('Guess must be a valid 5-letter English word.');
    }
    if (!isValidGuess(rawGuess)) {
      throw new Error('Word not found in dictionary.');
    }

    const myDaily = dailyRound.players[me.id];
    if (myDaily.finished) {
      throw new Error("You have already completed today's Daily Word.");
    }
    if (myDaily.guesses.includes(rawGuess)) {
      throw new Error('You already guessed that word.');
    }

    const ev = evaluateGuess(rawGuess, dailyRound.targetWord);
    myDaily.guesses.push(rawGuess);
    myDaily.evaluations.push(ev);

    const isWin = rawGuess === dailyRound.targetWord;
    const isOver = isWin || myDaily.guesses.length >= MAX_GUESSES;

    if (isOver) {
      myDaily.finished = true;
      myDaily.won = isWin;

      const userStats = getUserStats(store.stats, me.id, me.name);
      userStats.totalGames++;
      if (isWin) {
        userStats.wins++;
        userStats.currentStreak++;
        userStats.maxStreak = Math.max(userStats.maxStreak, userStats.currentStreak);
        const guessCount = myDaily.guesses.length;
        if (guessCount >= 1 && guessCount <= 6) {
          userStats.guessDist[guessCount - 1]++;
        }
      } else {
        userStats.currentStreak = 0;
      }
    }

    await saveStore(guildId, store);
    return buildResponse();
  }

  // Action: Create Speed Duel lobby
  if (data.action === 'create_duel') {
    const duelId = await cillhub.call('crypto.random', { bytes: 6 });
    const targetWord = WORD_BANK[Math.floor(Math.random() * WORD_BANK.length)];
    const duel = {
      id: duelId,
      creator: me,
      targetWord,
      status: 'waiting', // 'waiting' -> 'active' -> 'finished'
      players: {
        [me.id]: {
          id: me.id,
          name: me.name,
          guesses: [],
          evaluations: [],
          finished: false,
          won: false,
          solveTimeMs: null,
        },
      },
      startedAt: null,
      finishedAt: null,
      winner: null,
    };
    store.duels.unshift(duel);
    if (store.duels.length > 15) store.duels.pop();

    await saveStore(guildId, store);
    return buildResponse(duelId);
  }

  // Action: Join Speed Duel lobby
  if (data.action === 'join_duel') {
    const duel = store.duels.find((d) => d.id === data.duel_id);
    if (!duel) throw new Error('Duel not found.');
    if (duel.status !== 'waiting') throw new Error('Duel has already started.');

    if (!duel.players[me.id]) {
      duel.players[me.id] = {
        id: me.id,
        name: me.name,
        guesses: [],
        evaluations: [],
        finished: false,
        won: false,
        solveTimeMs: null,
      };
    }

    await saveStore(guildId, store);
    return buildResponse(duel.id);
  }

  // Action: Start Speed Duel (host clicks start)
  if (data.action === 'start_duel') {
    const duel = store.duels.find((d) => d.id === data.duel_id);
    if (!duel) throw new Error('Duel not found.');
    if (duel.creator.id !== me.id) throw new Error('Only the lobby host can start the duel.');
    if (duel.status !== 'waiting') throw new Error('Duel is already in progress.');
    if (Object.keys(duel.players).length < 2) throw new Error('Need at least 2 players to start a speed duel.');

    duel.status = 'active';
    duel.startedAt = Date.now();

    await saveStore(guildId, store);
    return buildResponse(duel.id);
  }

  // Action: Submit Guess in Speed Duel
  if (data.action === 'guess_duel') {
    const duel = store.duels.find((d) => d.id === data.duel_id);
    if (!duel) throw new Error('Duel not found.');
    if (duel.status !== 'active') throw new Error('Duel is not active.');

    const p = duel.players[me.id];
    if (!p) throw new Error('You are not in this duel.');
    if (p.finished) throw new Error('You have already finished this duel.');

    const rawGuess = String(data.word || '').trim().toUpperCase();
    if (rawGuess.length !== 5 || !/^[A-Z]{5}$/.test(rawGuess)) {
      throw new Error('Guess must be a valid 5-letter word.');
    }
    if (!isValidGuess(rawGuess)) {
      throw new Error('Word not found in dictionary.');
    }
    if (p.guesses.includes(rawGuess)) {
      throw new Error('You already guessed that word.');
    }

    const ev = evaluateGuess(rawGuess, duel.targetWord);
    p.guesses.push(rawGuess);
    p.evaluations.push(ev);

    const isWin = rawGuess === duel.targetWord;
    const isExhausted = p.guesses.length >= MAX_GUESSES;

    if (isWin || isExhausted) {
      p.finished = true;
      p.won = isWin;
      p.solveTimeMs = Date.now() - duel.startedAt;

      if (isWin && !duel.winner) {
        duel.winner = { id: me.id, name: me.name, solveTimeMs: p.solveTimeMs };
        const userStats = getUserStats(store.stats, me.id, me.name);
        userStats.wins++;
        userStats.totalGames++;
        if (!userStats.fastestTimeMs || p.solveTimeMs < userStats.fastestTimeMs) {
          userStats.fastestTimeMs = p.solveTimeMs;
        }
      }
    }

    // Check if duel is fully completed (all players finished or someone won)
    const allPlayers = Object.values(duel.players);
    if (duel.winner || allPlayers.every((pl) => pl.finished)) {
      duel.status = 'finished';
      duel.finishedAt = Date.now();
    }

    await saveStore(guildId, store);
    return buildResponse(duel.id);
  }

  throw new Error(`Unknown action: ${data.action}`);
});

// /wordduel command
cillhub.on('INTERACTION_CREATE', async (interaction) => {
  if (interaction.type !== 2 || interaction.data?.name !== 'wordduel') return;
  if (!interaction.guild_id) {
    return { type: 4, data: { content: 'Word Duel can only be played in a server.', flags: 64 } };
  }

  const store = await loadStore(interaction.guild_id);
  const today = getUtcDateStr();
  const daily = store.daily[today];
  const participants = daily ? Object.values(daily.players) : [];
  const solvedCount = participants.filter((p) => p.won).length;

  const topStreaks = Object.entries(store.stats || {})
    .map(([id, s]) => ({ id, ...s }))
    .sort((a, b) => b.currentStreak - a.currentStreak || b.wins - a.wins)
    .slice(0, 5);

  const speedLeaders = Object.entries(store.stats || {})
    .map(([id, s]) => ({ id, ...s }))
    .filter((s) => s.fastestTimeMs != null)
    .sort((a, b) => a.fastestTimeMs - b.fastestTimeMs)
    .slice(0, 5);

  const openDuels = (store.duels || []).filter((d) => d.status === 'waiting');

  let content = '## 🔤 Word Duel\n\n';

  content += `### 📅 Daily Word (${today})\n`;
  content += `• **${participants.length}** participant(s), **${solvedCount}** solved today's word!\n`;

  content += '\n### 🔥 Top Streaks\n';
  if (topStreaks.length === 0) {
    content += '_No streaks recorded yet._\n';
  } else {
    topStreaks.forEach((p, idx) => {
      content += `${idx + 1}. **${p.name}** — **${p.currentStreak}** day streak (Best: ${p.maxStreak}, ${p.wins} wins)\n`;
    });
  }

  content += '\n### ⚡ Fastest Speed Duelists\n';
  if (speedLeaders.length === 0) {
    content += '_No speed duels completed yet._\n';
  } else {
    speedLeaders.forEach((p, idx) => {
      const sec = (p.fastestTimeMs / 1000).toFixed(1);
      content += `${idx + 1}. **${p.name}** — **${sec}s** solve time\n`;
    });
  }

  if (openDuels.length > 0) {
    content += `\n**Open Duels:** ${openDuels.length} speed duel lobby waiting for opponents!\n`;
  }

  content += '\n_Open the **Word Duel** channel panel to play today\'s word or race your friends!_';

  return {
    type: 4,
    data: {
      content,
      allowed_mentions: { parse: [] },
    },
  };
});
