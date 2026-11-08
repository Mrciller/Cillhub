// League of Legends LCU (League Client Update) local API bridge
// Communicates with the local League client via HTTPS on 127.0.0.1 using the lockfile.
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');

const COMMON_DIRS = [
  'C:\\Riot Games\\League of Legends',
  'D:\\Riot Games\\League of Legends',
  'E:\\Riot Games\\League of Legends',
  'F:\\Riot Games\\League of Legends',
  '/c/Riot Games/League of Legends',
  '/d/Riot Games/League of Legends',
];

// Parses the lockfile content: "process_name:pid:port:password:protocol"
function parseLockfile(content) {
  if (!content || typeof content !== 'string') return null;
  const parts = content.trim().split(':');
  if (parts.length < 5) return null;
  const [procName, pid, port, password, protocol] = parts;
  if (!port || isNaN(Number(port)) || !password) return null;
  return {
    procName,
    pid: Number(pid),
    port: Number(port),
    password,
    protocol: protocol || 'https',
  };
}

// Searches running processes on Linux/Wine or Windows for the LeagueClientUx directory
function findLockfilePath(procs = []) {
  // Check process command line for --install-directory
  for (const p of procs) {
    const info = p.info || '';
    const match = info.match(/--install-directory=([^\s"]+|"[^"]+")/);
    if (match) {
      let dir = match[1].replace(/^"|"$/g, '');
      const candidate = path.join(dir, 'lockfile');
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  // Check common install locations
  for (const dir of COMMON_DIRS) {
    try {
      const candidate = path.join(dir, 'lockfile');
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // Ignore filesystem access errors
    }
  }
  return null;
}

// Low-level helper to make an HTTPS request to the local LCU server
function lcuRequest(credentials, method, endpoint, body = null) {
  return new Promise((resolve, reject) => {
    if (!credentials || !credentials.port || !credentials.password) {
      return reject(new Error('LCU not connected'));
    }
    const auth = Buffer.from(`riot:${credentials.password}`).toString('base64');
    const options = {
      hostname: '127.0.0.1',
      port: credentials.port,
      path: endpoint,
      method,
      rejectUnauthorized: false, // Local Riot self-signed certificate
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      timeout: 5000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(data ? JSON.parse(data) : null);
          } catch {
            resolve(data);
          }
        } else {
          reject(new Error(`LCU error HTTP ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('LCU request timed out'));
    });

    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

// Queue ID mapping to readable game modes
const QUEUE_MAP = {
  400: 'Normal Draft (5v5)',
  420: 'Ranked Solo/Duo (5v5)',
  430: 'Normal Blind (5v5)',
  440: 'Ranked Flex (5v5)',
  450: 'ARAM',
  700: 'Clash',
  720: 'ARAM Clash',
  830: 'Co-op vs. AI',
  840: 'Co-op vs. AI',
  850: 'Co-op vs. AI',
  900: 'URF',
  1020: 'One for All',
  1300: 'Nexus Blitz',
  1700: 'Arena (2v2v2v2)',
  1900: 'Pick URF',
};

function queueName(queueId) {
  return QUEUE_MAP[queueId] || 'Custom / Special Mode';
}

class LeagueClientManager {
  constructor() {
    this.credentials = null;
    this.currentLobby = null;
    this.summoner = null;
    this.pollTimer = null;
    this.listeners = new Set();
  }

  onChange(cb) {
    if (typeof cb !== 'function') return () => {};
    this.listeners.add(cb);
    if (this.currentLobby) cb(this.currentLobby);
    return () => this.listeners.delete(cb);
  }

  notify() {
    for (const cb of this.listeners) {
      try { cb(this.currentLobby); } catch {}
    }
  }

  async check(procs = []) {
    const lockfilePath = findLockfilePath(procs);
    if (!lockfilePath) {
      if (this.credentials || this.currentLobby) {
        this.credentials = null;
        this.currentLobby = null;
        this.summoner = null;
        this.notify();
      }
      return null;
    }

    try {
      const content = fs.readFileSync(lockfilePath, 'utf8');
      const creds = parseLockfile(content);
      if (!creds) throw new Error('Invalid lockfile');
      this.credentials = creds;

      // Fetch current summoner if not cached
      if (!this.summoner) {
        try {
          this.summoner = await lcuRequest(creds, 'GET', '/lol-summoner/v1/current-summoner');
        } catch {
          // May not be logged in yet
        }
      }

      // Fetch active lobby
      try {
        const lobby = await lcuRequest(creds, 'GET', '/lol-lobby/v2/lobby');
        if (lobby && lobby.partyId) {
          const queueId = lobby.gameConfig?.queueId;
          const maxMembers = lobby.gameConfig?.maxPartySize || 5;
          const members = Array.isArray(lobby.members) ? lobby.members.length : 1;
          const host = lobby.members?.find((m) => m.isLeader) || lobby.members?.[0];
          const hostName = host?.summonerName || host?.gameName || this.summoner?.displayName || 'Party Host';
          const hostPuuid = host?.puuid || this.summoner?.puuid || '';

          const lobbyData = {
            active: true,
            partyId: lobby.partyId,
            queueId,
            queueName: queueName(queueId),
            members,
            maxMembers,
            hostName,
            hostPuuid,
            game: 'League of Legends',
          };

          const changed = JSON.stringify(lobbyData) !== JSON.stringify(this.currentLobby);
          this.currentLobby = lobbyData;
          if (changed) this.notify();
          return lobbyData;
        }
      } catch {
        // Not currently in a lobby
      }

      if (this.currentLobby) {
        this.currentLobby = null;
        this.notify();
      }
      return null;
    } catch {
      if (this.currentLobby) {
        this.currentLobby = null;
        this.notify();
      }
      return null;
    }
  }

  // Sends an in-game invite to a target player (by summonerName or PUUID)
  async sendInvite(target) {
    if (!this.credentials) throw new Error('League client is not running');
    const payload = [];
    if (typeof target === 'string') {
      if (target.includes('-') && target.length > 30) {
        payload.push({ toPuuid: target });
      } else {
        payload.push({ toSummonerName: target });
      }
    } else if (target && typeof target === 'object') {
      payload.push(target);
    }
    return lcuRequest(this.credentials, 'POST', '/lol-lobby/v2/lobby/invitations', payload);
  }

  // Accepts an invitation or attempts to join the party
  async acceptInvite(invitationId) {
    if (!this.credentials) throw new Error('League client is not running');
    if (invitationId) {
      return lcuRequest(this.credentials, 'POST', `/lol-lobby/v2/received-invitations/${invitationId}/accept`);
    }
    // Check pending received invitations
    const received = await lcuRequest(this.credentials, 'GET', '/lol-lobby/v2/received-invitations');
    if (Array.isArray(received) && received.length > 0) {
      const latest = received[received.length - 1];
      return lcuRequest(this.credentials, 'POST', `/lol-lobby/v2/received-invitations/${latest.invitationId}/accept`);
    }
    throw new Error('No pending League invitation found');
  }

  getLobby() {
    return this.currentLobby;
  }
}

module.exports = {
  parseLockfile,
  findLockfilePath,
  queueName,
  LeagueClientManager,
  lcuRequest,
};
