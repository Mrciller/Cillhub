const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseTasklist, listLinux, detect, createTracker, cleanCustomGame } = require('../src/games');

test('parseTasklist: plain and /v CSV, quotes, CRLF', () => {
  const csv = '"System Idle Process","0","Services","0","8 K"\r\n"cs2.exe","4242","Console","1","1,234,567 K"\r\n'
    + '"League of Legends.exe","77","Console","1","900 K"\r\n\r\n';
  assert.deepStrictEqual(parseTasklist(csv).map((p) => p.names[0]), ['System Idle Process', 'cs2.exe', 'League of Legends.exe']);
  const v = '"javaw.exe","5","Console","1","500,000 K","Running","PC\\me","0:01:02","Minecraft* 1.21.1 - ""Multiplayer"""\r\n';
  assert.deepStrictEqual(parseTasklist(v), [{ names: ['javaw.exe'], info: 'Minecraft* 1.21.1 - "Multiplayer"' }]);
  assert.deepStrictEqual(parseTasklist('INFO: No tasks are running which match the specified criteria.'), []);
});

test('listLinux: comm + argv[0] basename (also Wine paths), skips non-pids and vanished processes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proc-'));
  const proc = (pid, comm, argv) => {
    fs.mkdirSync(path.join(dir, pid));
    fs.writeFileSync(path.join(dir, pid, 'comm'), `${comm}\n`);
    if (argv) fs.writeFileSync(path.join(dir, pid, 'cmdline'), `${argv.join('\0')}\0`);
  };
  proc('1', 'systemd', ['/sbin/init']);
  proc('20', 'VALORANT-Win64-', ['Z:\\Riot Games\\VALORANT\\live\\ShooterGame\\Binaries\\Win64\\VALORANT-Win64-Shipping.exe', '-x']);
  proc('21', 'kworker/0:1', []);
  proc('22', 'gone'); // no cmdline: exited mid-scan
  fs.mkdirSync(path.join(dir, 'self'));
  const out = listLinux(dir).sort((a, b) => a.names[0].localeCompare(b.names[0]));
  assert.deepStrictEqual(out, [
    { names: ['kworker/0:1'], info: '' },
    { names: ['systemd', 'init'], info: '/sbin/init' },
    { names: ['VALORANT-Win64-', 'VALORANT-Win64-Shipping.exe'], info: 'Z:\\Riot Games\\VALORANT\\live\\ShooterGame\\Binaries\\Win64\\VALORANT-Win64-Shipping.exe -x' },
  ]);
  fs.rmSync(dir, { recursive: true });
  assert.ok(listLinux().length > 0); // the real /proc
});

const p = (name, info = '') => ({ names: [name], info });

test('detect: case-insensitive, with or without .exe, null when nothing matches', () => {
  assert.equal(detect([p('explorer.exe'), p('CS2.EXE')]), 'Counter-Strike 2');
  assert.equal(detect([p('cs2')]), 'Counter-Strike 2');
  assert.equal(detect([p('valorant-win64-shipping.exe')]), 'VALORANT');
  assert.equal(detect([p('league of legends.exe')]), 'League of Legends');
  assert.equal(detect([p('Marvel-Win64-Shipping.exe')]), 'Marvel Rivals');
  assert.equal(detect([p('cs2.exe.bak'), p('notcs2.exe')]), null);
  assert.equal(detect([]), null);
});

test('detect: Minecraft only for a JVM whose title/cmdline mentions minecraft', () => {
  assert.equal(detect([p('javaw.exe', 'Minecraft* 1.21.1')]), 'Minecraft');
  assert.equal(detect([p('java', '/usr/bin/java -cp x net.minecraft.client.main.Main')]), 'Minecraft');
  assert.equal(detect([p('javaw.exe', 'IntelliJ IDEA')]), null);
  assert.equal(detect([p('javaw.exe')]), null);
  assert.equal(detect([p('notepad.exe', 'minecraft notes.txt')]), null);
});

test('detect: user-added games, overriding built-ins; current game stays while still running', () => {
  const custom = [{ exe: 'MyGame.exe', name: 'My Game' }, { exe: 'cs2.exe', name: 'CS2 (beta)' }];
  assert.equal(detect([p('mygame.EXE')], custom), 'My Game');
  assert.equal(detect([p('cs2.exe')], custom), 'CS2 (beta)');
  const both = [p('dota2.exe'), p('RocketLeague.exe')];
  assert.equal(detect(both), 'Dota 2');
  assert.equal(detect(both, [], 'Rocket League'), 'Rocket League');
  assert.equal(detect(both, [], 'Fortnite'), 'Dota 2');
});

test('cleanCustomGame: bare file names only, name defaults to the exe', () => {
  assert.deepStrictEqual(cleanCustomGame({ exe: ' Game.exe ', name: '' }), { exe: 'Game.exe', name: 'Game' });
  assert.deepStrictEqual(cleanCustomGame({ exe: 'game', name: 'A\u0000B' }), { exe: 'game', name: 'AB' });
  for (const exe of ['', '   ', 'C:\\Games\\x.exe', '../x', 'a/b', 'x'.repeat(65), '.exe', 'a"b']) assert.equal(cleanCustomGame({ exe }), null, exe);
  assert.equal(cleanCustomGame(null), null);
});

test('tracker: start, stop, switch, no duplicate events', () => {
  const events = [];
  const t = createTracker((e) => events.push(e));
  t.update(null, 1);
  t.update('Dota 2', 100);
  t.update('Dota 2', 200);
  t.update('Dota 2', 300);
  assert.deepStrictEqual(t.current(), { name: 'Dota 2', start: 100 });
  t.update('Fortnite', 400);
  t.update(null, 500);
  t.update(null, 600);
  assert.deepStrictEqual(events, [{ name: 'Dota 2', start: 100 }, { name: 'Fortnite', start: 400 }, null]);
});
