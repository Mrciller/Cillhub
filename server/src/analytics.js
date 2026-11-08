import { run } from './db.js';

export function recordGuildMetric(guildId, metric, amount = 1) {
  if (!guildId) return;
  const col = {
    messages_sent: 'messages_sent',
    voice_minutes: 'voice_minutes',
    joins: 'joins',
    leaves: 'leaves',
  }[metric];
  if (!col) return;

  const today = new Date().toISOString().slice(0, 10);
  run(`
    INSERT INTO guild_analytics_daily (guild_id, date, ${col})
    VALUES (?, ?, ?)
    ON CONFLICT(guild_id, date) DO UPDATE SET ${col} = ${col} + ?
  `, guildId, today, amount, amount);
}
