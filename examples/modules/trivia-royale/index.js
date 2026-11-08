// Trivia Royale (CONTRACT-v8): multiplayer trivia battle royale with categories, speed bonus, and champion role.

const MANAGE = 0x8n | 0x20n; // ADMINISTRATOR | MANAGE_GUILD
const QUESTION_DURATION_MS = 15000;
const storageKey = (guildId) => `trivia:${guildId}:data`;

const BUILTIN_QUESTIONS = [
  // Science
  {
    category: 'Science',
    question: 'What is the most abundant gas in Earth’s atmosphere?',
    choices: ['Oxygen', 'Nitrogen', 'Carbon Dioxide', 'Argon'],
    correctIndex: 1,
    explanation: 'Nitrogen makes up approximately 78% of Earth’s atmosphere.',
  },
  {
    category: 'Science',
    question: 'Which chemical element has the symbol "Au"?',
    choices: ['Silver', 'Gold', 'Copper', 'Aluminum'],
    correctIndex: 1,
    explanation: 'Au comes from the Latin word "aurum", meaning gold.',
  },
  {
    category: 'Science',
    question: 'What organelle is famously known as the powerhouse of the cell?',
    choices: ['Nucleus', 'Ribosome', 'Mitochondria', 'Endoplasmic Reticulum'],
    correctIndex: 2,
    explanation: 'Mitochondria generate most of the cell’s supply of adenosine triphosphate (ATP).',
  },
  {
    category: 'Science',
    question: 'At what temperature Celsius does liquid water achieve its maximum density?',
    choices: ['0°C', '4°C', '100°C', '-4°C'],
    correctIndex: 1,
    explanation: 'Liquid water reaches its peak density of 1.000 g/cm³ at approximately 4°C.',
  },
  {
    category: 'Science',
    question: 'Which planet in our solar system has the highest number of confirmed moons?',
    choices: ['Jupiter', 'Saturn', 'Uranus', 'Neptune'],
    correctIndex: 1,
    explanation: 'Saturn leads the solar system with over 140 confirmed moons.',
  },
  {
    category: 'Science',
    question: 'What subatomic particle carries a negative electric charge?',
    choices: ['Proton', 'Neutron', 'Electron', 'Positron'],
    correctIndex: 2,
    explanation: 'Electrons have a negative elementary charge (-1e).',
  },
  {
    category: 'Science',
    question: 'Approximately how fast does light travel in a vacuum?',
    choices: ['150,000 km/s', '300,000 km/s', '500,000 km/s', '1,000,000 km/s'],
    correctIndex: 1,
    explanation: 'The speed of light in vacuum is defined as exactly 299,792,458 m/s (~300,000 km/s).',
  },

  // Gaming
  {
    category: 'Gaming',
    question: 'In what year was the original Super Mario Bros. released on the Famicom / NES?',
    choices: ['1983', '1985', '1987', '1989'],
    correctIndex: 1,
    explanation: 'Super Mario Bros. was created by Shigeru Miyamoto and released in 1985.',
  },
  {
    category: 'Gaming',
    question: 'In Minecraft, what item is required to craft an Enchanting Table alongside Obsidian and Diamonds?',
    choices: ['Book', 'Ender Pearl', 'Emerald', 'Glass Bottle'],
    correctIndex: 0,
    explanation: 'An enchanting table recipe requires 1 Book, 2 Diamonds, and 4 Obsidian blocks.',
  },
  {
    category: 'Gaming',
    question: 'What is the name of Link’s legendary blade in The Legend of Zelda?',
    choices: ['Excalibur', 'Master Sword', 'Buster Sword', 'Falchion'],
    correctIndex: 1,
    explanation: 'The Master Sword, also known as the Blade of Evil’s Bane, is Link’s signature weapon.',
  },
  {
    category: 'Gaming',
    question: 'In the game Portal, what are the primary colors of the two portals created by the portal gun?',
    choices: ['Red and Green', 'Blue and Orange', 'Purple and Yellow', 'Cyan and Magenta'],
    correctIndex: 1,
    explanation: 'Aperture Science Handheld Portal Devices fire Blue and Orange portals.',
  },
  {
    category: 'Gaming',
    question: 'What is the designation / rank of Master Chief in the Halo universe?',
    choices: ['Sergeant Major', 'Master Chief Petty Officer', 'Lieutenant Commander', 'General'],
    correctIndex: 1,
    explanation: 'Master Chief John-117 holds the naval rank of Master Chief Petty Officer.',
  },
  {
    category: 'Gaming',
    question: 'What company developed the original PlayStation console after a Nintendo partnership dissolved?',
    choices: ['Sega', 'Sony', 'Microsoft', 'Bandai'],
    correctIndex: 1,
    explanation: 'Sony originally collaborated with Nintendo on an SNES CD-ROM before creating PlayStation.',
  },
  {
    category: 'Gaming',
    question: 'Which popular battle royale game features the island location "Tilted Towers"?',
    choices: ['Apex Legends', 'Fortnite', 'PUBG', 'Warzone'],
    correctIndex: 1,
    explanation: 'Tilted Towers became one of the most famous drop locations in Fortnite Battle Royale.',
  },

  // Computing
  {
    category: 'Computing',
    question: 'Who is widely regarded as the father of modern computer science and broke the Enigma cipher?',
    choices: ['Charles Babbage', 'Alan Turing', 'John von Neumann', 'Claude Shannon'],
    correctIndex: 1,
    explanation: 'Alan Turing formulated the Turing machine concept and led codebreaking at Bletchley Park.',
  },
  {
    category: 'Computing',
    question: 'What does the acronym "HTTP" stand for in computer networking?',
    choices: [
      'High Tech Transfer Program',
      'HyperText Transfer Protocol',
      'HyperText Transmission Parser',
      'Host Terminal Transport Port',
    ],
    correctIndex: 1,
    explanation: 'HTTP stands for HyperText Transfer Protocol, the foundation of data communication on the Web.',
  },
  {
    category: 'Computing',
    question: 'What year did Linus Torvalds first announce the Linux kernel project?',
    choices: ['1987', '1991', '1995', '1998'],
    correctIndex: 1,
    explanation: 'Linus Torvalds posted his famous announcement about Linux on comp.os.minix in August 1991.',
  },
  {
    category: 'Computing',
    question: 'What is the default TCP port used for secure HTTPS connections?',
    choices: ['22', '80', '443', '8080'],
    correctIndex: 2,
    explanation: 'Port 80 is used for unencrypted HTTP, while port 443 is assigned for HTTPS (TLS/SSL).',
  },
  {
    category: 'Computing',
    question: 'Which programming language was originally given the project code name "Oak"?',
    choices: ['Python', 'Ruby', 'Java', 'C#'],
    correctIndex: 2,
    explanation: 'James Gosling originally called Java "Oak" after an oak tree outside his office window.',
  },
  {
    category: 'Computing',
    question: 'Which fundamental data structure operates strictly on a FIFO (First In, First Out) principle?',
    choices: ['Stack', 'Queue', 'Binary Heap', 'Hash Table'],
    correctIndex: 1,
    explanation: 'Queues maintain FIFO ordering, whereas stacks operate on LIFO (Last In, First Out).',
  },
  {
    category: 'Computing',
    question: 'In Git, which command creates and switches to a new branch in a single step?',
    choices: ['git branch -n', 'git checkout -b', 'git switch -m', 'git commit -b'],
    correctIndex: 1,
    explanation: '`git checkout -b <branch>` (and `git switch -c`) creates and checks out a new branch.',
  },

  // History
  {
    category: 'History',
    question: 'In what year did the Apollo 11 mission land the first humans on the Moon?',
    choices: ['1965', '1969', '1971', '1975'],
    correctIndex: 1,
    explanation: 'Neil Armstrong and Buzz Aldrin landed the Apollo 11 Lunar Module Eagle on July 20, 1969.',
  },
  {
    category: 'History',
    question: 'Which ancient wonder of the world is the only one still largely intact today?',
    choices: ['Colossus of Rhodes', 'Great Pyramid of Giza', 'Lighthouse of Alexandria', 'Hanging Gardens of Babylon'],
    correctIndex: 1,
    explanation: 'The Great Pyramid of Giza is both the oldest of the Seven Wonders and the only one standing.',
  },
  {
    category: 'History',
    question: 'What was the name of the ship that brought the English Pilgrims to Plymouth in 1620?',
    choices: ['Mayflower', 'Santa Maria', 'Endeavour', 'Beagle'],
    correctIndex: 0,
    explanation: 'The Mayflower transported 102 passengers across the Atlantic in 1620.',
  },
  {
    category: 'History',
    question: 'Who was the very first Emperor of the Roman Empire, ruling from 27 BC to 14 AD?',
    choices: ['Julius Caesar', 'Augustus', 'Nero', 'Marcus Aurelius'],
    correctIndex: 1,
    explanation: 'Born Gaius Octavius, Augustus became Rome’s first Princeps and emperor in 27 BC.',
  },
  {
    category: 'History',
    question: 'In which year did the Berlin Wall fall, signaling the impending reunification of Germany?',
    choices: ['1985', '1989', '1991', '1993'],
    correctIndex: 1,
    explanation: 'The Berlin Wall fell on November 9, 1989, leading to German reunification in 1990.',
  },
  {
    category: 'History',
    question: 'Which peace treaty signed in 1919 officially brought an end to World War I?',
    choices: ['Treaty of Ghent', 'Treaty of Versailles', 'Treaty of Paris', 'Treaty of Westphalia'],
    correctIndex: 1,
    explanation: 'The Treaty of Versailles was signed in the Hall of Mirrors at the Palace of Versailles.',
  },
  {
    category: 'History',
    question: 'Who was the last active ruler of the Ptolemaic Kingdom of Egypt?',
    choices: ['Nefertiti', 'Hatshepsut', 'Cleopatra VII', 'Sobekneferu'],
    correctIndex: 2,
    explanation: 'Cleopatra VII Philopator was the final Ptolemaic monarch of Hellenistic Egypt.',
  },

  // Geography
  {
    category: 'Geography',
    question: 'What is the deepest known oceanic trench on the surface of Earth?',
    choices: ['Java Trench', 'Puerto Rico Trench', 'Mariana Trench', 'Tonga Trench'],
    correctIndex: 2,
    explanation: 'The Challenger Deep in the Mariana Trench reaches approximately 10,994 meters below sea level.',
  },
  {
    category: 'Geography',
    question: 'Which country contains the largest number of natural freshwater lakes in the world?',
    choices: ['United States', 'Russia', 'Canada', 'Finland'],
    correctIndex: 2,
    explanation: 'Canada contains more than half of all natural lakes on Earth.',
  },
  {
    category: 'Geography',
    question: 'What is the national capital of Australia?',
    choices: ['Sydney', 'Melbourne', 'Canberra', 'Brisbane'],
    correctIndex: 2,
    explanation: 'Canberra was chosen as a compromise site between Sydney and Melbourne in 1908.',
  },
  {
    category: 'Geography',
    question: 'Mount Everest sits directly on the international border between Nepal and which territory?',
    choices: ['India', 'Bhutan', 'Tibet (China)', 'Myanmar'],
    correctIndex: 2,
    explanation: 'Mount Everest’s summit ridge forms the border between Nepal and the Tibet Autonomous Region.',
  },
  {
    category: 'Geography',
    question: 'Which is traditionally recognized as the longest river on Earth?',
    choices: ['Amazon River', 'Nile River', 'Yangtze River', 'Mississippi River'],
    correctIndex: 1,
    explanation: 'The Nile River in northeast Africa flows approximately 6,650 kilometers (4,130 miles).',
  },
  {
    category: 'Geography',
    question: 'What is the smallest independent sovereign state in the world by both area and population?',
    choices: ['Monaco', 'San Marino', 'Vatican City', 'Liechtenstein'],
    correctIndex: 2,
    explanation: 'Vatican City covers roughly 0.49 square kilometers (121 acres) completely surrounded by Rome.',
  },
  {
    category: 'Geography',
    question: 'What is the largest hot desert in the world?',
    choices: ['Gobi Desert', 'Kalahari Desert', 'Sahara Desert', 'Arabian Desert'],
    correctIndex: 2,
    explanation: 'The Sahara spans over 9.2 million square kilometers across Northern Africa.',
  },

  // Pop Culture
  {
    category: 'Pop Culture',
    question: 'In The Lord of the Rings lore, what type of creature was Sméagol before acquiring the One Ring?',
    choices: ['Elf', 'Stoor Hobbit', 'Dwarf', 'Goblin'],
    correctIndex: 1,
    explanation: 'Sméagol was a Stoor Hobbit of the River-folk living near the Gladden Fields.',
  },
  {
    category: 'Pop Culture',
    question: 'What is the name of the Scandinavian-inspired fictional kingdom in Disney’s Frozen?',
    choices: ['Corona', 'Arendelle', 'Genovia', 'DunBroch'],
    correctIndex: 1,
    explanation: 'Sisters Elsa and Anna rule over the kingdom of Arendelle.',
  },
  {
    category: 'Pop Culture',
    question: 'Who portrayed Tony Stark / Iron Man in the Marvel Cinematic Universe starting in 2008?',
    choices: ['Chris Evans', 'Mark Ruffalo', 'Robert Downey Jr.', 'Christian Bale'],
    correctIndex: 2,
    explanation: 'Robert Downey Jr. launched the Marvel Cinematic Universe with his iconic portrayal of Tony Stark.',
  },
  {
    category: 'Pop Culture',
    question: 'What is the highest-grossing film of all time at the worldwide box office (unadjusted)?',
    choices: ['Titanic', 'Avengers: Endgame', 'Avatar', 'Star Wars: The Force Awakens'],
    correctIndex: 2,
    explanation: 'James Cameron’s Avatar (2009) grossed over $2.9 billion worldwide.',
  },
  {
    category: 'Pop Culture',
    question: 'What was the title of J.K. Rowling’s debut novel published in the UK in 1997?',
    choices: [
      'Harry Potter and the Chamber of Secrets',
      'Harry Potter and the Sorcerer’s Stone',
      'Harry Potter and the Philosopher’s Stone',
      'Harry Potter and the Goblet of Fire',
    ],
    correctIndex: 2,
    explanation: 'The original UK title was "Philosopher’s Stone", later published as "Sorcerer’s Stone" in the US.',
  },
  {
    category: 'Pop Culture',
    question: 'In the Netflix television series Stranger Things, what is the name of the dark parallel dimension?',
    choices: ['The Nether', 'The Upside Down', 'The Twilight Realm', 'The Void'],
    correctIndex: 1,
    explanation: 'The kids refer to the shadow reflection of Hawkins as "The Upside Down".',
  },
  {
    category: 'Pop Culture',
    question: 'Which legendary British rock band recorded the acclaimed 1973 concept album "The Dark Side of the Moon"?',
    choices: ['The Beatles', 'Led Zeppelin', 'Pink Floyd', 'The Who'],
    correctIndex: 2,
    explanation: 'Pink Floyd’s The Dark Side of the Moon remained on the Billboard charts for a record 900+ weeks.',
  },
];

function canManageServer(permissions) {
  try {
    return (BigInt(permissions) & MANAGE) !== 0n;
  } catch {
    return false;
  }
}

async function loadStore(guildId) {
  const data = await cillhub.call('storage.get', { key: storageKey(guildId) });
  return (
    data || {
      lobbies: [],
      customQuestions: [],
      leaderboard: {}, // userId -> { name, totalPoints, matchesWon, matchesPlayed }
      champion: null,  // { id, name, wonAt }
    }
  );
}

async function saveStore(guildId, store) {
  await cillhub.call('storage.set', { key: storageKey(guildId), value: store });
  try {
    await cillhub.call('ui.publish', { guild_id: guildId, data: { type: 'trivia_update' } });
  } catch (err) {
    console.warn(`ui.publish failed: ${err.message}`);
  }
}

function getUserStats(leaderboard, userId, defaultName) {
  if (!leaderboard[userId]) {
    leaderboard[userId] = {
      name: defaultName || 'Player',
      totalPoints: 0,
      matchesWon: 0,
      matchesPlayed: 0,
    };
  } else if (defaultName) {
    leaderboard[userId].name = defaultName;
  }
  return leaderboard[userId];
}

function shuffle(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Client-safe projection of a lobby
function buildClientLobbyView(lobby, viewerId) {
  if (!lobby) return null;
  const currentQ = lobby.questions[lobby.currentQuestionIndex];
  const isHost = lobby.creator.id === viewerId;
  const isParticipant = !!lobby.players[viewerId];

  // In active question phase, hide correctIndex from client!
  const showReveal = lobby.phase === 'reveal' || lobby.phase === 'finished';

  const safeQuestion = currentQ
    ? {
        category: currentQ.category,
        question: currentQ.question,
        choices: currentQ.choices,
        correctIndex: showReveal ? currentQ.correctIndex : null,
        explanation: showReveal ? currentQ.explanation : null,
      }
    : null;

  // Build participants scoreboard
  const scoreboard = Object.values(lobby.players).map((p) => {
    const hasAnsweredCurrent = p.answers[lobby.currentQuestionIndex] !== undefined;
    const answerObj = p.answers[lobby.currentQuestionIndex];
    return {
      id: p.id,
      name: p.name,
      score: p.score,
      hasAnswered: hasAnsweredCurrent,
      selectedChoice: (showReveal || p.id === viewerId) ? answerObj?.choiceIndex : null,
      earnedPoints: showReveal ? answerObj?.points : null,
    };
  }).sort((a, b) => b.score - a.score);

  return {
    id: lobby.id,
    creator: lobby.creator,
    status: lobby.status, // 'waiting', 'active', 'finished'
    phase: lobby.phase,   // 'question', 'reveal', 'finished'
    currentQuestionIndex: lobby.currentQuestionIndex,
    totalQuestions: lobby.questions.length,
    questionStartTime: lobby.questionStartTime,
    questionDurationMs: QUESTION_DURATION_MS,
    question: safeQuestion,
    scoreboard,
    winner: lobby.winner,
    isHost,
    isParticipant,
    myAnswer: lobby.players[viewerId]?.answers[lobby.currentQuestionIndex] || null,
  };
}

cillhub.on('UI_REQUEST', async (req) => {
  const guildId = req.guild_id;
  const data = (req.data && typeof req.data === 'object') ? req.data : {};
  const me = { id: req.user.id, name: req.user.global_name || req.user.username };
  const canManage = canManageServer(req.member.permissions);

  const store = await loadStore(guildId);
  store.lobbies = store.lobbies || [];
  store.customQuestions = store.customQuestions || [];
  store.leaderboard = store.leaderboard || {};

  getUserStats(store.leaderboard, me.id, me.name);

  const getSortedLeaderboard = () => {
    return Object.entries(store.leaderboard)
      .map(([id, s]) => ({ id, ...s }))
      .sort((a, b) => b.totalPoints - a.totalPoints || b.matchesWon - a.matchesWon)
      .slice(0, 20);
  };

  const buildResponse = (activeLobbyId) => {
    let currentLobby = null;
    if (activeLobbyId) {
      currentLobby = store.lobbies.find((l) => l.id === activeLobbyId);
    }
    if (!currentLobby) {
      currentLobby = store.lobbies.find((l) => l.players[me.id] && l.status === 'active');
    }
    if (!currentLobby && store.lobbies.length > 0) {
      currentLobby = store.lobbies[0];
    }

    return {
      lobby: buildClientLobbyView(currentLobby, me.id),
      openLobbies: store.lobbies.filter((l) => l.status === 'waiting').map((l) => ({
        id: l.id,
        creator: l.creator,
        category: l.category,
        questionCount: l.questionCount,
        playerCount: Object.keys(l.players).length,
      })),
      leaderboard: getSortedLeaderboard(),
      champion: store.champion,
      canManage,
      customQuestionsCount: store.customQuestions.length,
      myStats: store.leaderboard[me.id],
    };
  };

  if (!data.action || data.action === 'state') {
    return buildResponse(data.lobby_id);
  }

  // Action: Create Lobby
  if (data.action === 'create_lobby') {
    const questionCount = [5, 8, 10].includes(Number(data.count)) ? Number(data.count) : 5;
    const categoryFilter = String(data.category || 'all');

    const lobbyId = await cillhub.call('crypto.random', { bytes: 6 });
    const lobby = {
      id: lobbyId,
      creator: me,
      category: categoryFilter,
      questionCount,
      status: 'waiting', // 'waiting' -> 'active' -> 'finished'
      phase: 'question', // 'question' -> 'reveal'
      currentQuestionIndex: 0,
      questionStartTime: null,
      questions: [],
      players: {
        [me.id]: {
          id: me.id,
          name: me.name,
          score: 0,
          answers: {}, // questionIdx -> { choiceIndex, points, answeredAt }
        },
      },
      winner: null,
      channelId: req.channel_id,
      createdAt: Date.now(),
    };

    store.lobbies.unshift(lobby);
    if (store.lobbies.length > 15) store.lobbies.pop();

    await saveStore(guildId, store);
    return buildResponse(lobby.id);
  }

  // Action: Join Lobby
  if (data.action === 'join_lobby') {
    const lobby = store.lobbies.find((l) => l.id === data.lobby_id);
    if (!lobby) throw new Error('Lobby not found.');
    if (lobby.status !== 'waiting') throw new Error('Match has already started.');

    if (!lobby.players[me.id]) {
      lobby.players[me.id] = {
        id: me.id,
        name: me.name,
        score: 0,
        answers: {},
      };
    }

    await saveStore(guildId, store);
    return buildResponse(lobby.id);
  }

  // Action: Start Match
  if (data.action === 'start_match') {
    const lobby = store.lobbies.find((l) => l.id === data.lobby_id);
    if (!lobby) throw new Error('Lobby not found.');
    if (lobby.creator.id !== me.id && !canManage) throw new Error('Only the lobby host can start the match.');
    if (lobby.status !== 'waiting') throw new Error('Match has already started.');

    // Pool questions: built-in + server custom
    let pool = [...BUILTIN_QUESTIONS, ...store.customQuestions];
    if (lobby.category !== 'all') {
      pool = pool.filter((q) => q.category.toLowerCase() === lobby.category.toLowerCase());
    }
    if (pool.length < lobby.questionCount) {
      pool = [...BUILTIN_QUESTIONS, ...store.customQuestions]; // fallback to all
    }

    const shuffled = shuffle(pool).slice(0, lobby.questionCount);
    lobby.questions = shuffled;
    lobby.status = 'active';
    lobby.phase = 'question';
    lobby.currentQuestionIndex = 0;
    lobby.questionStartTime = Date.now();

    await saveStore(guildId, store);
    return buildResponse(lobby.id);
  }

  // Action: Submit Answer
  if (data.action === 'answer') {
    const lobby = store.lobbies.find((l) => l.id === data.lobby_id);
    if (!lobby) throw new Error('Lobby not found.');
    if (lobby.status !== 'active') throw new Error('Match is not active.');
    if (lobby.phase !== 'question') throw new Error('Question round has closed.');

    const player = lobby.players[me.id];
    if (!player) throw new Error('You are not in this match.');

    const qIdx = lobby.currentQuestionIndex;
    if (player.answers[qIdx] !== undefined) {
      throw new Error('You already answered this question.');
    }

    const choiceIdx = Number(data.choice);
    if (!Number.isInteger(choiceIdx) || choiceIdx < 0 || choiceIdx > 3) {
      throw new Error('Invalid choice index.');
    }

    const currentQ = lobby.questions[qIdx];
    const elapsed = Date.now() - lobby.questionStartTime;
    const isCorrect = choiceIdx === currentQ.correctIndex;

    let points = 0;
    if (isCorrect) {
      // Speed bonus: 100 base + up to 100 bonus based on remaining time
      const remainingRatio = Math.max(0, Math.min(1, (QUESTION_DURATION_MS - elapsed) / QUESTION_DURATION_MS));
      points = 100 + Math.round(100 * remainingRatio);
      player.score += points;
    }

    player.answers[qIdx] = {
      choiceIndex: choiceIdx,
      isCorrect,
      points,
      answeredAt: Date.now(),
    };

    // Auto-advance to reveal if all players have answered
    const totalPlayers = Object.keys(lobby.players).length;
    const answeredCount = Object.values(lobby.players).filter((p) => p.answers[qIdx] !== undefined).length;
    if (answeredCount >= totalPlayers) {
      lobby.phase = 'reveal';
    }

    await saveStore(guildId, store);
    return buildResponse(lobby.id);
  }

  // Action: Next Round / Advance Question
  if (data.action === 'next_round') {
    const lobby = store.lobbies.find((l) => l.id === data.lobby_id);
    if (!lobby) throw new Error('Lobby not found.');
    if (lobby.status !== 'active') throw new Error('Match is not active.');

    if (lobby.phase === 'question') {
      // Force reveal
      lobby.phase = 'reveal';
    } else if (lobby.phase === 'reveal') {
      // Move to next question or end game
      const nextQIdx = lobby.currentQuestionIndex + 1;
      if (nextQIdx < lobby.questions.length) {
        lobby.currentQuestionIndex = nextQIdx;
        lobby.phase = 'question';
        lobby.questionStartTime = Date.now();
      } else {
        // MATCH FINISHED!
        lobby.status = 'finished';
        lobby.phase = 'finished';

        // Determine winner
        const rankedPlayers = Object.values(lobby.players).sort((a, b) => b.score - a.score);
        const winner = rankedPlayers[0];
        lobby.winner = winner;

        // Update all participants stats
        for (const p of rankedPlayers) {
          const stats = getUserStats(store.leaderboard, p.id, p.name);
          stats.matchesPlayed++;
          stats.totalPoints += p.score;
          if (winner && p.id === winner.id && p.score > 0) {
            stats.matchesWon++;
          }
        }

        // Automatic Champion role assignment if configured
        if (winner && winner.score > 0) {
          try {
            const settings = await cillhub.call('settings.get', { guild_id: guildId });
            const champRoleId = settings?.champion_role;
            if (champRoleId) {
              const previousChamp = store.champion;
              if (previousChamp && previousChamp.id !== winner.id) {
                try {
                  await cillhub.call('members.remove_role', {
                    guild_id: guildId,
                    user_id: previousChamp.id,
                    role_id: champRoleId,
                  });
                } catch (roleErr) {
                  console.warn(`Could not remove previous champion role: ${roleErr.message}`);
                }
              }
              try {
                await cillhub.call('members.add_role', {
                  guild_id: guildId,
                  user_id: winner.id,
                  role_id: champRoleId,
                });
              } catch (roleErr) {
                console.warn(`Could not add champion role: ${roleErr.message}`);
              }
            }
          } catch (settErr) {
            console.warn(`Failed reading champion_role setting: ${settErr.message}`);
          }

          store.champion = {
            id: winner.id,
            name: winner.name,
            score: winner.score,
            wonAt: Date.now(),
          };

          // Chat announcement
          if (lobby.channelId) {
            try {
              await cillhub.call('messages.send', {
                channel_id: lobby.channelId,
                content: `👑 **${winner.name}** has won the Trivia Royale match with **${winner.score}** points and is crowned the Server Trivia Champion!`,
              });
            } catch (msgErr) {
              console.warn(`Could not send champion announcement: ${msgErr.message}`);
            }
          }
        }
      }
    }

    await saveStore(guildId, store);
    return buildResponse(lobby.id);
  }

  // Action: Add Custom Server Question (Server Managers only)
  if (data.action === 'add_custom_question') {
    if (!canManage) throw new Error('Only server managers can add custom questions.');
    const category = String(data.category || '').trim();
    const question = String(data.question || '').trim();
    const choices = Array.isArray(data.choices) ? data.choices.map((c) => String(c).trim()) : [];
    const correctIndex = Number(data.correctIndex);
    const explanation = String(data.explanation || '').trim();

    if (!category || category.length > 30) throw new Error('Category must be 1-30 characters.');
    if (!question || question.length > 200) throw new Error('Question must be 1-200 characters.');
    if (choices.length !== 4 || choices.some((c) => !c || c.length > 100)) {
      throw new Error('Must provide exactly 4 choices (each up to 100 characters).');
    }
    if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex > 3) {
      throw new Error('Correct choice must be between 1 and 4.');
    }

    store.customQuestions.push({
      category,
      question,
      choices,
      correctIndex,
      explanation: explanation.slice(0, 300),
      addedBy: me.name,
      addedAt: Date.now(),
    });

    await saveStore(guildId, store);
    return buildResponse();
  }

  throw new Error(`Unknown action: ${data.action}`);
});

// /trivia application command
cillhub.on('INTERACTION_CREATE', async (interaction) => {
  if (interaction.type !== 2 || interaction.data?.name !== 'trivia') return;
  if (!interaction.guild_id) {
    return { type: 4, data: { content: 'Trivia Royale can only be played in a server.', flags: 64 } };
  }

  const store = await loadStore(interaction.guild_id);
  const champion = store.champion;
  const openLobbies = (store.lobbies || []).filter((l) => l.status === 'waiting');
  const leaders = Object.entries(store.leaderboard || {})
    .map(([id, s]) => ({ id, ...s }))
    .sort((a, b) => b.totalPoints - a.totalPoints || b.matchesWon - a.matchesWon)
    .slice(0, 5);

  let content = '## 🧠 Trivia Royale\n\n';

  if (champion) {
    content += `### 👑 Reigning Champion: **${champion.name}** (${champion.score} pts)\n\n`;
  } else {
    content += '### 👑 Reigning Champion: _None yet! Win a match to claim the crown._\n\n';
  }

  content += '### 🏆 All-Time Scorer Leaderboard\n';
  if (leaders.length === 0) {
    content += '_No trivia matches played yet._\n';
  } else {
    leaders.forEach((p, idx) => {
      content += `${idx + 1}. **${p.name}** — **${p.totalPoints}** pts (${p.matchesWon} wins / ${p.matchesPlayed} matches)\n`;
    });
  }

  if (openLobbies.length > 0) {
    content += `\n**Open Lobbies:** ${openLobbies.length} match lobby waiting for players!\n`;
  }

  content += '\n_Open the **Trivia Royale** channel panel in the header to jump into a game!_';

  return {
    type: 4,
    data: {
      content,
      allowed_mentions: { parse: [] },
    },
  };
});
