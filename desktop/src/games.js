// Game activity: every 15 s, list running processes and match them against known games.
// Privacy: the process list stays inside this module; only a matched game name (and its start time) leaves it.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const INTERVAL = 15000;
// [display name, executables]. Matching ignores case and a trailing ".exe", so "cs2" also covers the Linux build.
const GAMES = [
  ['Counter-Strike 2', ['cs2.exe']],
  ['VALORANT', ['VALORANT-Win64-Shipping.exe']],
  ['League of Legends', ['League of Legends.exe', 'LeagueClientUx.exe']],
  ['Dota 2', ['dota2.exe']],
  ['Rocket League', ['RocketLeague.exe']],
  ['Fortnite', ['FortniteClient-Win64-Shipping.exe', 'FortniteClient-Win64-Shipping_EAC_EOS.exe']],
  ['Apex Legends', ['r5apex.exe', 'r5apex_dx12.exe']],
  ['Overwatch 2', ['Overwatch.exe']],
  ['Minecraft', ['Minecraft.Windows.exe']], // Bedrock; Java edition is the javaw special case below
  ['Grand Theft Auto V', ['GTA5.exe', 'GTA5_Enhanced.exe']],
  ["Tom Clancy's Rainbow Six Siege", ['RainbowSix.exe', 'RainbowSix_Vulkan.exe']],
  ['PUBG: BATTLEGROUNDS', ['TslGame.exe']],
  ['Deadlock', ['deadlock.exe', 'project8.exe']],
  ['Marvel Rivals', ['Marvel-Win64-Shipping.exe']],
];
const JAVA = new Set(['java', 'javaw']); // Minecraft Java edition runs in a generic JVM

const key = (exe) => String(exe).trim().toLowerCase().replace(/\.exe$/, '');
const baseName = (p) => String(p).split(/[\\/]/).pop();

// `tasklist /fo csv /nh [/v]` -> [{ names, info }]; with /v the last column is the window title.
function parseTasklist(csv) {
  const out = [];
  for (const line of String(csv).split(/\r?\n/)) {
    const f = [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, '"'));
    if (f.length >= 5) out.push({ names: [f[0]], info: f.length >= 9 ? f[f.length - 1] : '' });
  }
  return out;
}

// Linux: /proc/<pid>/comm (truncated to 15 chars) plus the basename of argv[0] (full name, also for Wine/Proton paths).
function listLinux(procDir = '/proc') {
  const out = [];
  for (const pid of fs.readdirSync(procDir)) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const comm = fs.readFileSync(path.join(procDir, pid, 'comm'), 'utf8').trim();
      const argv = fs.readFileSync(path.join(procDir, pid, 'cmdline'), 'utf8').split('\0').filter(Boolean);
      out.push({ names: [comm, argv[0] ? baseName(argv[0]) : ''].filter(Boolean), info: argv.join(' ') });
    } catch { /* process exited or not readable */ }
  }
  return out;
}

const tasklist = (args) => new Promise((resolve, reject) =>
  execFile('tasklist', args, { timeout: 10000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    (err, stdout) => (err ? reject(err) : resolve(parseTasklist(stdout)))));

async function listWindows() {
  const procs = await tasklist(['/fo', 'csv', '/nh']);
  // Window titles only for JVMs (cheap with a filter), to tell Minecraft from other Java apps.
  if (procs.some((p) => key(p.names[0]) === 'javaw')) procs.push(...await tasklist(['/v', '/fo', 'csv', '/nh', '/fi', 'IMAGENAME eq javaw.exe']));
  return procs;
}

// Valid user-added entry -> { exe, name }, else null. exe is a bare file name, never a path.
function cleanCustomGame(g) {
  const exe = String(g?.exe ?? '').trim();
  const name = String(g?.name ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 64) || exe.replace(/\.exe$/i, '');
  if (!exe || exe.length > 64 || /[\\/:*?"<>|\x00-\x1f]/.test(exe) || !key(exe)) return null;
  return { exe, name };
}

// Game name for a process list, or null. A game that is already current wins, so two running games don't flap.
function detect(procs, custom = [], current = null) {
  const table = new Map();
  for (const [name, exes] of GAMES) for (const e of exes) table.set(key(e), name);
  for (const g of custom) table.set(key(g.exe), g.name); // user entries override the built-in list
  const found = [];
  for (const p of procs) {
    for (const n of p.names) {
      const k = key(n);
      if (table.has(k)) found.push(table.get(k));
      else if (JAVA.has(k) && /minecraft/i.test(p.info)) found.push('Minecraft');
    }
  }
  return current && found.includes(current) ? current : found[0] || null;
}

// Emits only real changes: { name, start } when a game starts or switches, null when it stops.
function createTracker(emit) {
  let cur = null;
  return {
    current: () => cur,
    update(name, now = Date.now()) {
      if ((cur?.name ?? null) === (name || null)) return;
      cur = name ? { name, start: now } : null;
      emit(cur);
    },
  };
}

let tracker = createTracker(() => {});
let timer = null;
let lastProcs = [];

function start({ getCustom, onChange, onProcesses }) {
  tracker = createTracker(onChange);
  const list = process.platform === 'win32' ? listWindows : async () => listLinux();
  const scan = async () => {
    clearTimeout(timer);
    try {
      lastProcs = await list();
      if (typeof onProcesses === 'function') onProcesses(lastProcs);
      tracker.update(detect(lastProcs, getCustom(), tracker.current()?.name));
    } catch (err) {
      require('electron-log/main').warn('game scan failed', err?.message);
    }
    timer = setTimeout(scan, INTERVAL);
  };
  timer = setTimeout(scan, 2000);
}

module.exports = {
  GAMES, parseTasklist, listLinux, cleanCustomGame, detect, createTracker, start,
  current: () => tracker.current(),
  processes: () => lastProcs,
  stop: () => clearTimeout(timer),
};
