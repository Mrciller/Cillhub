import { all } from '../db.js';
import { P, need } from '../permissions.js';
import { int } from '../errors.js';
import { loadGuild } from './guilds.js';

function getAnalytics(ctx) {
  const g = loadGuild(ctx.params.id, ctx.user, P.MANAGE_GUILD);
  const daysParam = ctx.query?.get('days');
  const days = daysParam ? Math.max(1, Math.min(90, parseInt(daysParam, 10) || 30)) : 30;

  const rows = all(`
    SELECT date, messages_sent, voice_minutes, joins, leaves
    FROM guild_analytics_daily
    WHERE guild_id = ?
      AND date >= date('now', '-' || ? || ' days')
    ORDER BY date ASC
  `, g.id, days);

  return {
    guild_id: g.id,
    daily: rows.map(r => ({
      date: r.date,
      messages_sent: r.messages_sent ?? 0,
      voice_minutes: r.voice_minutes ?? 0,
      joins: r.joins ?? 0,
      leaves: r.leaves ?? 0,
    })),
  };
}

export default [
  ['GET', '/guilds/:id/analytics', getAnalytics],
];
