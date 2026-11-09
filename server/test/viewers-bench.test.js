import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './helpers.js';

const VIEW = 1n << 10n, ADMIN = 1n << 3n, MANAGE_THREADS = 1n << 34n;

test('viewersOf matches channelPerms and stays fast at 10k members', async () => {
  process.env.DATA_DIR = await tempDir();
  const { db, run } = await import('../src/db.js');
  const { channelPerms, viewersOf, has } = await import('../src/permissions.js');
  const N = 10_000;
  db.exec('BEGIN');
  run("INSERT INTO users (id, email, username, password_hash, salt) VALUES ('0', '0@x', 'u0', 'x', 'x')");
  run("INSERT INTO guilds (id, name, owner_id) VALUES ('g', 'g', '0')");
  run("INSERT INTO members (guild_id, user_id, joined_at) VALUES ('g', '0', 'now')");
  run("INSERT INTO roles (id, guild_id, name, position, permissions) VALUES ('g', 'g', '@everyone', 0, ?)", String(VIEW));
  run("INSERT INTO roles (id, guild_id, name, position, permissions) VALUES ('mod', 'g', 'mod', 1, ?)", String(MANAGE_THREADS));
  run("INSERT INTO roles (id, guild_id, name, position, permissions) VALUES ('adm', 'g', 'adm', 2, ?)", String(ADMIN));
  run("INSERT INTO roles (id, guild_id, name, position, permissions) VALUES ('vip', 'g', 'vip', 3, '0')");
  for (let i = 1; i <= N; i++) {
    const id = String(i);
    run("INSERT INTO users (id, email, username, password_hash, salt) VALUES (?, ?, ?, 'x', 'x')", id, `${id}@x`, `u${id}`);
    run("INSERT INTO members (guild_id, user_id, joined_at, pending, communication_disabled_until) VALUES ('g', ?, 'now', ?, ?)",
      id, i % 7 === 0 ? 1 : 0, i % 11 === 0 ? '2999-01-01T00:00:00Z' : null);
    if (i % 3 === 0) run("INSERT INTO member_roles VALUES ('g', ?, 'vip')", id);
    if (i % 50 === 0) run("INSERT INTO member_roles VALUES ('g', ?, 'mod')", id);
    if (i % 97 === 0) run("INSERT INTO member_roles VALUES ('g', ?, 'adm')", id);
  }
  // open, @everyone denied + vip allowed + one member denied, and a private thread in the second
  run("INSERT INTO channels (id, type, guild_id, name) VALUES ('open', 0, 'g', 'a'), ('vip', 2, 'g', 'b')");
  run("INSERT INTO overwrites VALUES ('vip', 'g', 0, '0', ?), ('vip', 'vip', 0, ?, '0'), ('vip', '3', 1, '0', ?)", String(VIEW), String(VIEW), String(VIEW));
  run("INSERT INTO channels (id, type, guild_id, name, parent_id) VALUES ('pt', 12, 'g', 't', 'vip')");
  for (const id of ['6', '7', '9']) run("INSERT INTO thread_members (channel_id, user_id, join_timestamp) VALUES ('pt', ?, 'now')", id);
  db.exec('COMMIT');

  const chans = ['open', 'vip', 'pt'].map(id => db.prepare('SELECT * FROM channels WHERE id = ?').get(id));
  for (const ch of chans) {
    const got = new Set(viewersOf(ch));
    // the slow per-member path is the reference; a sample keeps the test quick
    for (let i = 0; i <= N; i += 13) assert.equal(got.has(String(i)), has(channelPerms(ch, String(i)), VIEW), `${ch.id} member ${i}`);
  }
  assert.equal(viewersOf(chans[0]).length, N + 1);
  assert.ok(viewersOf(chans[2]).includes('9') && !viewersOf(chans[2]).includes('7') && !viewersOf(chans[2]).includes('12'), 'private thread: member and parent VIEW');

  const t = performance.now();
  for (let k = 0; k < 10; k++) for (const ch of chans) viewersOf(ch);
  const ms = (performance.now() - t) / 30;
  console.log(`viewersOf ${ms.toFixed(1)} ms/call`); assert.ok(ms < 60, `viewersOf took ${ms.toFixed(1)} ms per call`);
});
