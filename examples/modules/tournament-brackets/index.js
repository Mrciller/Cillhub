// Tournament Brackets: Single-Elimination & Round-Robin Tournament Manager for Cillhub.
// Features bracket tree progression, live score reporting, BYE handling, and champion role assignment.

const ADMINISTRATOR = 0x8n;
const MANAGE_GUILD = 0x20n;

function canManage(member, creatorId) {
  if (!member) return false;
  if (creatorId && member.user?.id === creatorId) return true;
  try {
    const bits = BigInt(member.permissions || '0');
    return (bits & (ADMINISTRATOR | MANAGE_GUILD)) !== 0n;
  } catch {
    return false;
  }
}

function storageKey(guildId) { return `tournaments:${guildId}`; }

function createDefaultTournament() {
  const tId = 'tourney-demo-01';
  const participants = [
    { id: 'usr-1', name: 'AceStriker' },
    { id: 'usr-2', name: 'BlazeViper' },
    { id: 'usr-3', name: 'CyberKnight' },
    { id: 'usr-4', name: 'DriftMaster' },
    { id: 'usr-5', name: 'EchoPilot' },
    { id: 'usr-6', name: 'FrostBite' },
    { id: 'usr-7', name: 'GhostRider' },
    { id: 'usr-8', name: 'HyperNova' }
  ];

  const round1 = [
    { id: 'M-1-1', label: 'Quarterfinal 1', round: 1, p1: participants[0], p2: participants[7], score1: 2, score2: 0, winner: participants[0], status: 'completed', nextMatchId: 'M-2-1', nextSlot: 1 },
    { id: 'M-1-2', label: 'Quarterfinal 2', round: 1, p1: participants[3], p2: participants[4], score1: 2, score2: 1, winner: participants[3], status: 'completed', nextMatchId: 'M-2-1', nextSlot: 2 },
    { id: 'M-1-3', label: 'Quarterfinal 3', round: 1, p1: participants[1], p2: participants[6], score1: null, score2: null, winner: null, status: 'ready', nextMatchId: 'M-2-2', nextSlot: 1 },
    { id: 'M-1-4', label: 'Quarterfinal 4', round: 1, p1: participants[2], p2: participants[5], score1: null, score2: null, winner: null, status: 'ready', nextMatchId: 'M-2-2', nextSlot: 2 }
  ];

  const round2 = [
    { id: 'M-2-1', label: 'Semifinal 1', round: 2, p1: participants[0], p2: participants[3], score1: null, score2: null, winner: null, status: 'ready', nextMatchId: 'M-3-1', nextSlot: 1 },
    { id: 'M-2-2', label: 'Semifinal 2', round: 2, p1: null, p2: null, score1: null, score2: null, winner: null, status: 'pending', nextMatchId: 'M-3-1', nextSlot: 2 }
  ];

  const round3 = [
    { id: 'M-3-1', label: 'Grand Finals', round: 3, p1: null, p2: null, score1: null, score2: null, winner: null, status: 'pending', nextMatchId: null, nextSlot: null }
  ];

  return {
    id: tId,
    title: 'Cillhub Community Championship',
    game: 'Rocket League 1v1',
    format: 'single_elim',
    size: 8,
    status: 'in_progress',
    created_at: Date.now() - 3600 * 1000,
    creator_id: 'system',
    participants,
    rounds: [round1, round2, round3],
    champion: null
  };
}

async function loadTournaments(guildId) {
  let list = await cillhub.call('storage.get', { key: storageKey(guildId) });
  if (!list || !Array.isArray(list) || list.length === 0) {
    list = [createDefaultTournament()];
    await cillhub.call('storage.set', { key: storageKey(guildId), value: list });
  }
  return list;
}

async function saveTournaments(guildId, tournaments) {
  await cillhub.call('storage.set', { key: storageKey(guildId), value: tournaments });
  try {
    await cillhub.call('ui.publish', { guild_id: guildId, data: { type: 'tournament_changed' } });
  } catch (err) {
    console.warn(`ui.publish failed: ${err.message}`);
  }
}

async function sendAnnouncement(guildId, settings, title, description, color = 0xf59e0b) {
  const channelId = settings?.announce_channel;
  if (!channelId) return;
  try {
    await cillhub.call('messages.send', {
      channel_id: channelId,
      embeds: [{
        title,
        description,
        color,
        timestamp: new Date().toISOString(),
        footer: { text: 'Tournament Brackets' }
      }]
    });
  } catch (err) {
    console.warn(`Failed to post announcement: ${err.message}`);
  }
}

function buildBracket(participants, size) {
  const roundCount = Math.log2(size);
  const rounds = [];
  const totalSlots = size;

  // Pad participants with BYE if necessary
  const seeded = [...participants];
  while (seeded.length < totalSlots) {
    seeded.push({ id: `bye-${seeded.length}`, name: 'BYE', is_bye: true });
  }

  // Generate Round 1 pairings
  const r1Matches = [];
  const matchCount = totalSlots / 2;

  // Standard seeding pairing order
  const seedPairs = [];
  if (totalSlots === 4) {
    seedPairs.push([0, 3], [1, 2]);
  } else if (totalSlots === 8) {
    seedPairs.push([0, 7], [3, 4], [1, 6], [2, 5]);
  } else {
    // 16 players
    seedPairs.push([0, 15], [7, 8], [3, 12], [4, 11], [1, 14], [6, 9], [2, 13], [5, 10]);
  }

  for (let i = 0; i < matchCount; i++) {
    const pair = seedPairs[i] || [i * 2, i * 2 + 1];
    const p1 = seeded[pair[0]];
    const p2 = seeded[pair[1]];

    const match = {
      id: `M-1-${i + 1}`,
      label: totalSlots === 4 ? `Semifinal ${i + 1}` : (totalSlots === 8 ? `Quarterfinal ${i + 1}` : `Round 1 Match ${i + 1}`),
      round: 1,
      p1,
      p2,
      score1: null,
      score2: null,
      winner: null,
      status: 'ready',
      nextMatchId: `M-2-${Math.floor(i / 2) + 1}`,
      nextSlot: (i % 2) + 1
    };

    // Auto-advance if BYE opponent
    if (p2.is_bye) {
      match.score1 = 1;
      match.score2 = 0;
      match.winner = p1;
      match.status = 'completed';
    } else if (p1.is_bye) {
      match.score1 = 0;
      match.score2 = 1;
      match.winner = p2;
      match.status = 'completed';
    }

    r1Matches.push(match);
  }
  rounds.push(r1Matches);

  // Subsequent rounds
  for (let r = 2; r <= roundCount; r++) {
    const prevMatches = rounds[r - 2];
    const rMatches = [];
    const count = prevMatches.length / 2;
    const isFinals = r === roundCount;
    const isSemis = r === roundCount - 1;

    for (let i = 0; i < count; i++) {
      const match = {
        id: `M-${r}-${i + 1}`,
        label: isFinals ? 'Grand Finals' : (isSemis ? `Semifinal ${i + 1}` : `Round ${r} Match ${i + 1}`),
        round: r,
        p1: null,
        p2: null,
        score1: null,
        score2: null,
        winner: null,
        status: 'pending',
        nextMatchId: isFinals ? null : `M-${r + 1}-${Math.floor(i / 2) + 1}`,
        nextSlot: isFinals ? null : (i % 2) + 1
      };

      // Propagate previous round auto-advanced BYE winners if any
      const m1 = prevMatches[i * 2];
      const m2 = prevMatches[i * 2 + 1];
      if (m1?.winner) match.p1 = m1.winner;
      if (m2?.winner) match.p2 = m2.winner;
      if (match.p1 && match.p2) match.status = 'ready';

      rMatches.push(match);
    }
    rounds.push(rMatches);
  }

  return rounds;
}

// UI Request handler
cillhub.on('UI_REQUEST', async (req) => {
  const guildId = req.guild_id;
  const settings = (await cillhub.call('settings.get', { guild_id: guildId })) || {};
  const tournaments = await loadTournaments(guildId);
  const action = req.data?.action || 'list';

  let currentTourney = tournaments.find(t => t.id === req.data?.tournament_id) || tournaments[0];
  const isManager = canManage(req.member, currentTourney?.creator_id);
  const me = { id: req.user.id, name: req.user.global_name || req.user.username };

  if (action === 'list') {
    return {
      tournaments,
      active_tournament: currentTourney,
      can_manage: isManager,
      me
    };
  }

  if (action === 'create') {
    if (!canManage(req.member)) {
      throw new Error('Manage Server permission required to create tournaments.');
    }
    const title = String(req.data?.title || '').trim();
    const game = String(req.data?.game || '').trim();
    const size = Number(req.data?.size) || 8;
    const format = req.data?.format === 'round_robin' ? 'round_robin' : 'single_elim';

    if (!title || title.length > 50) throw new Error('Tournament title must be 1 to 50 characters.');
    if (!game || game.length > 50) throw new Error('Game name must be 1 to 50 characters.');
    if (![4, 8, 16].includes(size)) throw new Error('Size must be 4, 8, or 16 players.');

    const newTourney = {
      id: 'tourney-' + Date.now(),
      title,
      game,
      format,
      size,
      status: 'registration',
      created_at: Date.now(),
      creator_id: req.user.id,
      participants: [me], // creator joins by default
      rounds: [],
      champion: null
    };

    tournaments.unshift(newTourney);
    await saveTournaments(guildId, tournaments);
    await sendAnnouncement(guildId, settings, `🏆 New Tournament: ${title}`, `**Game**: ${game}\n**Bracket Size**: ${size} slots\nRegistration is now OPEN! Click **Join** in the Tournaments panel or use \`/tournament join\`.`, 0x3b82f6);

    return {
      tournaments,
      active_tournament: newTourney,
      can_manage: true,
      me,
      notice: 'Tournament created! Registration is now open.'
    };
  }

  if (!currentTourney) throw new Error('No tournament found.');

  if (action === 'join') {
    if (currentTourney.status !== 'registration') {
      throw new Error('Registration is closed for this tournament.');
    }
    if (currentTourney.participants.some(p => p.id === me.id)) {
      return { tournaments, active_tournament: currentTourney, can_manage: isManager, me };
    }
    if (currentTourney.participants.length >= currentTourney.size) {
      throw new Error('Tournament bracket is already full.');
    }
    currentTourney.participants.push(me);
    await saveTournaments(guildId, tournaments);
    return {
      tournaments,
      active_tournament: currentTourney,
      can_manage: isManager,
      me,
      notice: `You joined ${currentTourney.title}!`
    };
  }

  if (action === 'leave') {
    if (currentTourney.status !== 'registration') {
      throw new Error('Cannot leave a tournament that has already started.');
    }
    currentTourney.participants = currentTourney.participants.filter(p => p.id !== me.id);
    await saveTournaments(guildId, tournaments);
    return {
      tournaments,
      active_tournament: currentTourney,
      can_manage: isManager,
      me,
      notice: 'Left tournament registration.'
    };
  }

  if (action === 'start') {
    if (!isManager) throw new Error('Organizer access required to start bracket.');
    if (currentTourney.status !== 'registration') throw new Error('Tournament has already started.');
    if (currentTourney.participants.length < 2) throw new Error('Need at least 2 participants to start bracket.');

    currentTourney.rounds = buildBracket(currentTourney.participants, currentTourney.size);
    currentTourney.status = 'in_progress';
    await saveTournaments(guildId, tournaments);

    const matchupLines = currentTourney.rounds[0].map(m => `• **${m.label}**: ${m.p1.name} vs ${m.p2.name}`).join('\n');
    await sendAnnouncement(guildId, settings, `⚔️ Bracket Started: ${currentTourney.title}`, `The bracket has been seeded and matches are live!\n\n${matchupLines}\n\nReport match scores in the Tournaments panel or via \`/tournament report\`.`, 0x10b981);

    return {
      tournaments,
      active_tournament: currentTourney,
      can_manage: isManager,
      me,
      notice: 'Bracket seeded and matches started!'
    };
  }

  if (action === 'report_score') {
    const matchId = req.data?.match_id;
    const score1 = Number(req.data?.score1);
    const score2 = Number(req.data?.score2);

    if (!Number.isInteger(score1) || !Number.isInteger(score2) || score1 < 0 || score2 < 0) {
      throw new Error('Scores must be non-negative whole numbers.');
    }
    if (score1 === score2) {
      throw new Error('Ties are not allowed in single-elimination matches.');
    }

    // Locate match in tournament rounds
    let targetMatch = null;
    let roundIndex = -1;
    for (let r = 0; r < currentTourney.rounds.length; r++) {
      const found = currentTourney.rounds[r].find(m => m.id === matchId);
      if (found) {
        targetMatch = found;
        roundIndex = r;
        break;
      }
    }

    if (!targetMatch) throw new Error('Match not found.');
    if (targetMatch.status === 'completed') throw new Error('Match score has already been confirmed.');

    // Only players in match or organizers can report
    const isPlayerInMatch = targetMatch.p1?.id === me.id || targetMatch.p2?.id === me.id;
    if (!isPlayerInMatch && !isManager) {
      throw new Error('Only the participating players or an organizer can report scores.');
    }

    targetMatch.score1 = score1;
    targetMatch.score2 = score2;
    const winner = score1 > score2 ? targetMatch.p1 : targetMatch.p2;
    targetMatch.winner = winner;
    targetMatch.status = 'completed';

    // Advance winner to next match if exists
    if (targetMatch.nextMatchId) {
      for (const round of currentTourney.rounds) {
        const nextM = round.find(m => m.id === targetMatch.nextMatchId);
        if (nextM) {
          if (targetMatch.nextSlot === 1) nextM.p1 = winner;
          else if (targetMatch.nextSlot === 2) nextM.p2 = winner;
          if (nextM.p1 && nextM.p2) nextM.status = 'ready';
          break;
        }
      }
    } else {
      // Grand Finals Completed!
      currentTourney.status = 'completed';
      currentTourney.champion = winner;

      // Celebrate champion
      await sendAnnouncement(
        guildId,
        settings,
        `👑 Tournament Champion: ${winner.name}!`,
        `🎉 Congratulations to **${winner.name}** for winning the **${currentTourney.title}** (${currentTourney.game})!\nFinal Match Score: **${score1}-${score2}**`,
        0xffd700
      );

      // Grant winner_role if configured
      const championRole = settings?.winner_role;
      if (championRole && !winner.is_bye && winner.id) {
        try {
          await cillhub.call('members.add_role', {
            guild_id: guildId,
            user_id: winner.id,
            role_id: championRole
          });
          console.info(`Granted winner role ${championRole} to champion ${winner.name} (${winner.id})`);
        } catch (err) {
          console.warn(`Failed to assign champion role: ${err.message}`);
        }
      }
    }

    await saveTournaments(guildId, tournaments);
    return {
      tournaments,
      active_tournament: currentTourney,
      can_manage: isManager,
      me,
      notice: `Match ${targetMatch.label} decided: ${winner.name} wins (${score1}-${score2})!`
    };
  }

  throw new Error(`Unknown action: ${action}`);
});

// Slash Command handler
cillhub.on('INTERACTION_CREATE', async (interaction) => {
  if (interaction.type !== 2 || interaction.data?.name !== 'tournament') return;

  const guildId = interaction.guild_id;
  if (!guildId) {
    return { type: 4, data: { content: 'Tournament commands can only be used in a server.', flags: 64 } };
  }

  const settings = (await cillhub.call('settings.get', { guild_id: guildId })) || {};
  const tournaments = await loadTournaments(guildId);
  const currentTourney = tournaments[0];
  const user = interaction.member?.user || interaction.user;
  const me = { id: user.id, name: user.global_name || user.username };
  const isManager = canManage(interaction.member, currentTourney?.creator_id);

  const subcommand = interaction.data.options?.[0];
  const subName = subcommand?.name;
  const subOpts = subcommand?.options || [];
  const getOpt = (name) => subOpts.find(o => o.name === name)?.value;

  if (subName === 'view') {
    if (!currentTourney) {
      return { type: 4, data: { content: 'No tournaments configured.', flags: 64 } };
    }
    const partCount = currentTourney.participants.length;
    let desc = `**Game**: ${currentTourney.game}\n**Status**: ${currentTourney.status.toUpperCase()}\n**Players**: ${partCount}/${currentTourney.size}\n\n`;

    if (currentTourney.champion) {
      desc += `👑 **Champion**: ${currentTourney.champion.name}\n\n`;
    }

    if (currentTourney.rounds.length > 0) {
      for (const round of currentTourney.rounds) {
        const roundTitle = round[0]?.label.split(' ')[0] || `Round ${round[0]?.round}`;
        desc += `__**${roundTitle}**__\n`;
        for (const m of round) {
          const p1Name = m.p1?.name || 'TBD';
          const p2Name = m.p2?.name || 'TBD';
          const score = m.status === 'completed' ? ` (${m.score1}-${m.score2})` : '';
          const check = m.winner ? ` 🏆 ${m.winner.name}` : '';
          desc += `• \`${m.id}\`: ${p1Name} vs ${p2Name}${score}${check}\n`;
        }
        desc += '\n';
      }
    } else {
      desc += 'Bracket not yet seeded. Use `/tournament join` to enter!';
    }

    return {
      type: 4,
      data: {
        embeds: [{
          title: `🏆 ${currentTourney.title}`,
          description: desc,
          color: 0xf59e0b,
          footer: { text: 'Open the Tournaments panel in the guild sidebar to view the interactive bracket.' }
        }]
      }
    };
  }

  if (subName === 'join') {
    if (!currentTourney || currentTourney.status !== 'registration') {
      return { type: 4, data: { content: 'No tournament is currently open for registration.', flags: 64 } };
    }
    if (currentTourney.participants.some(p => p.id === me.id)) {
      return { type: 4, data: { content: `You are already registered for **${currentTourney.title}**!`, flags: 64 } };
    }
    if (currentTourney.participants.length >= currentTourney.size) {
      return { type: 4, data: { content: `Registration is full (${currentTourney.size}/${currentTourney.size}).`, flags: 64 } };
    }
    currentTourney.participants.push(me);
    await saveTournaments(guildId, tournaments);
    return {
      type: 4,
      data: { content: `🎮 You joined **${currentTourney.title}**! (${currentTourney.participants.length}/${currentTourney.size} players registered)` }
    };
  }

  if (subName === 'leave') {
    if (!currentTourney || currentTourney.status !== 'registration') {
      return { type: 4, data: { content: 'Cannot leave: registration is not open.', flags: 64 } };
    }
    currentTourney.participants = currentTourney.participants.filter(p => p.id !== me.id);
    await saveTournaments(guildId, tournaments);
    return {
      type: 4,
      data: { content: `Left registration for **${currentTourney.title}**.` }
    };
  }

  if (subName === 'create') {
    if (!canManage(interaction.member)) {
      return { type: 4, data: { content: 'Manage Server permission required to create tournaments.', flags: 64 } };
    }
    const title = String(getOpt('title') || '').trim();
    const game = String(getOpt('game') || '').trim();
    const size = Number(getOpt('size')) || 8;
    const format = getOpt('format') === 'round_robin' ? 'round_robin' : 'single_elim';

    const newTourney = {
      id: 'tourney-' + Date.now(),
      title,
      game,
      format,
      size,
      status: 'registration',
      created_at: Date.now(),
      creator_id: user.id,
      participants: [me],
      rounds: [],
      champion: null
    };

    tournaments.unshift(newTourney);
    await saveTournaments(guildId, tournaments);
    await sendAnnouncement(guildId, settings, `🏆 New Tournament: ${title}`, `**Game**: ${game}\n**Size**: ${size} slots\nRegistration is OPEN! Join via \`/tournament join\`.`, 0x3b82f6);

    return {
      type: 4,
      data: { content: `🏆 Created tournament **${title}**! Bracket size: **${size}** players.` }
    };
  }

  if (subName === 'report') {
    const matchId = String(getOpt('match_id') || '').toUpperCase().trim();
    const scoreStr = String(getOpt('score') || '').trim();
    const matchParts = scoreStr.split(/[-:]/);
    if (matchParts.length !== 2) {
      return { type: 4, data: { content: 'Score must be in format X-Y (e.g. 2-1).', flags: 64 } };
    }
    const s1 = parseInt(matchParts[0], 10);
    const s2 = parseInt(matchParts[1], 10);
    if (isNaN(s1) || isNaN(s2) || s1 < 0 || s2 < 0 || s1 === s2) {
      return { type: 4, data: { content: 'Invalid scores. Scores must be non-tied positive whole numbers.', flags: 64 } };
    }

    let targetMatch = null;
    for (const round of currentTourney.rounds) {
      const found = round.find(m => m.id.toUpperCase() === matchId);
      if (found) { targetMatch = found; break; }
    }

    if (!targetMatch) {
      return { type: 4, data: { content: `Could not find match with ID "${matchId}".`, flags: 64 } };
    }

    const isPlayerInMatch = targetMatch.p1?.id === me.id || targetMatch.p2?.id === me.id;
    if (!isPlayerInMatch && !isManager) {
      return { type: 4, data: { content: 'Only players in the match or organizers can report scores.', flags: 64 } };
    }

    targetMatch.score1 = s1;
    targetMatch.score2 = s2;
    const winner = s1 > s2 ? targetMatch.p1 : targetMatch.p2;
    targetMatch.winner = winner;
    targetMatch.status = 'completed';

    if (targetMatch.nextMatchId) {
      for (const round of currentTourney.rounds) {
        const nextM = round.find(m => m.id === targetMatch.nextMatchId);
        if (nextM) {
          if (targetMatch.nextSlot === 1) nextM.p1 = winner;
          else if (targetMatch.nextSlot === 2) nextM.p2 = winner;
          if (nextM.p1 && nextM.p2) nextM.status = 'ready';
          break;
        }
      }
    } else {
      currentTourney.status = 'completed';
      currentTourney.champion = winner;
      await sendAnnouncement(guildId, settings, `👑 Champion Crowned: ${winner.name}!`, `**${winner.name}** won **${currentTourney.title}** with final score ${s1}-${s2}!`, 0xffd700);

      const champRole = settings?.winner_role;
      if (champRole && winner.id && !winner.is_bye) {
        try {
          await cillhub.call('members.add_role', { guild_id: guildId, user_id: winner.id, role_id: champRole });
        } catch (e) {
          console.warn(`Role grant failed: ${e.message}`);
        }
      }
    }

    await saveTournaments(guildId, tournaments);
    return {
      type: 4,
      data: { content: `✅ Match **${targetMatch.id}** recorded: **${winner.name}** wins (${s1}-${s2})!` }
    };
  }

  return { type: 4, data: { content: 'Unknown subcommand.', flags: 64 } };
});

cillhub.on('READY', () => {
  console.info('Tournament Brackets module ready.');
});
