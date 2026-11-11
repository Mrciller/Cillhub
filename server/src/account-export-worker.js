import { workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { writeSync } from 'node:fs';
import { PRIVATE_DATA } from './account-data.js';

const { dbPath, fd, user } = workerData; // the caller owns fd: a terminated worker cannot close it
const db = new DatabaseSync(dbPath, { readOnly: true });
const write = value => {
  const bytes = Buffer.from(value);
  for (let offset = 0; offset < bytes.length;) offset += writeSync(fd, bytes, offset, bytes.length - offset);
};
const section = (name, sql) => {
  write(`,${JSON.stringify(name)}:[`);
  let first = true;
  for (const row of db.prepare(sql).iterate(user.id)) {
    write(`${first ? '' : ','}${JSON.stringify(row)}`); first = false;
  }
  write(']');
};
try {
  db.exec('BEGIN');
  const current = db.prepare('SELECT deleted, disabled, settings, terms_version, terms_accepted_at FROM users WHERE id = ?').get(user.id);
  if (!current || current.deleted || current.disabled) throw new Error('Account no longer available');
  const terms = { version: current.terms_version, accepted_at: current.terms_accepted_at && new Date(current.terms_accepted_at).toISOString() };
  write(JSON.stringify({ exported_at: new Date().toISOString(), user, settings: JSON.parse(current.settings), terms_accepted: terms }).slice(0, -1));
  section('guilds', 'SELECT g.id, g.name, m.nick, m.joined_at FROM members m JOIN guilds g ON g.id = m.guild_id WHERE m.user_id = ?');
  section('relationships', 'SELECT other_id, type FROM relationships WHERE user_id = ?');
  for (const [table, column, name, columns] of PRIVATE_DATA) {
    if (name) section(name, `SELECT ${columns} FROM ${table} WHERE ${column} = ?`);
  }
  // 7.11: shared records that are still the user's own data (GDPR Art. 15)
  section('reactions', 'SELECT message_id, emoji FROM reactions WHERE user_id = ?');
  section('poll_votes', 'SELECT message_id, answer_id FROM poll_votes WHERE user_id = ?');
  section('reports_filed', "SELECT id, message_id, reason, note, status, created_at FROM reports WHERE reporter_id = ? AND source = 'user'");
  section('directory_reports_filed', 'SELECT id, reason, note, status, created_at FROM directory_reports WHERE reporter_id = ?');
  section('moderation_decisions', 'SELECT id, action, category, ground, reason, created_at, appeal, appeal_status, appeal_decision FROM moderation_decisions WHERE user_id = ?');
  // Keyset batches: every authored message is included, and attachments use one query per batch, not per message.
  write(',"messages":[');
  let before = Number.MAX_SAFE_INTEGER, first = true;
  while (true) {
    const messages = db.prepare(`SELECT rowid AS cursor, id, channel_id, content, timestamp, edited_timestamp, e2ee_envelope
      FROM messages WHERE author_id = ? AND webhook_id IS NULL AND rowid < ? ORDER BY rowid DESC LIMIT 500`).all(user.id, before);
    if (!messages.length) break;
    const ids = messages.map(m => m.id), placeholders = ids.map(() => '?').join(',');
    const attachments = new Map();
    for (const { message_id, ...attachment } of db.prepare(`SELECT message_id, id, filename, size, content_type FROM attachments WHERE message_id IN (${placeholders})`).all(...ids)) {
      if (!attachments.has(message_id)) attachments.set(message_id, []);
      attachments.get(message_id).push(attachment);
    }
    for (const { cursor, ...message } of messages) {
      write(`${first ? '' : ','}${JSON.stringify({ ...message, attachments: attachments.get(message.id) ?? [] })}`);
      first = false; before = cursor;
    }
  }
  write(']}');
  db.exec('COMMIT');
} finally { db.close(); }
