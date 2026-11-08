// Pure helpers of the Cillhub Bot (no database): time phrases, dice, and the fair winner draw
import { randomInt } from 'node:crypto';

const TZ = process.env.CILLCORD_TIMEZONE || 'Europe/Berlin';
const UNITS = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 };
const YEAR = 365 * 864e5;

// how far the zone's wall clock is ahead of UTC at instant ts (ms)
function offset(ts) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(ts).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ts / 1000) * 1000;
}
// wall clock time in TZ -> instant; the second pass settles days with a DST switch
function zoned(y, mo, d, h, mi) {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  return wall - offset(wall - offset(wall));
}
const nextDay = ([y, mo, d]) => {
  const t = new Date(Date.UTC(y, mo - 1, d + 1));
  return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
};
const wallDate = ts => {
  const t = new Date(ts + offset(ts));
  return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
};

// "10m", "1h30m", "2d", "tomorrow 18:00", "today 9:30", "18:00" (next occurrence), "2026-12-24 18:00" (CILLCORD_TIMEZONE,
// default Europe/Berlin) -> unix ms in the future (at most a year ahead), else null
export function parseWhen(input, now = Date.now()) {
  const t = String(input ?? '').trim().toLowerCase();
  if (/^(\d{1,5}\s*[smhdw]\s*)+$/.test(t)) {
    const ms = [...t.matchAll(/(\d+)\s*([smhdw])/g)].reduce((a, [, n, u]) => a + Number(n) * UNITS[u], 0);
    return ms > 0 && ms <= YEAR ? now + ms : null;
  }
  const m = /^(?:(today|tomorrow|(\d{4})-(\d{2})-(\d{2}))\s+)?(\d{1,2})[:.](\d{2})$/.exec(t);
  if (!m || Number(m[5]) > 23 || Number(m[6]) > 59) return null;
  let day = m[2] ? [Number(m[2]), Number(m[3]), Number(m[4])] : wallDate(now);
  if (m[1] === 'tomorrow') day = nextDay(day);
  let at = zoned(...day, Number(m[5]), Number(m[6]));
  if (!m[1] && at <= now) at = zoned(...nextDay(day), Number(m[5]), Number(m[6]));
  return at > now && at <= now + YEAR ? at : null;
}

// "2d6", "d20", "1d100+5" -> {count, sides, mod, rolls, total} or null
export function roll(spec) {
  const m = /^(\d{0,3})d(\d{1,4})([+-]\d{1,5})?$/i.exec(String(spec).replace(/\s+/g, ''));
  if (!m) return null;
  const count = m[1] ? Number(m[1]) : 1;
  const sides = Number(m[2]);
  if (count < 1 || count > 100 || sides < 2 || sides > 1000) return null;
  const rolls = Array.from({ length: count }, () => randomInt(1, sides + 1));
  const mod = Number(m[3] ?? 0);
  return { count, sides, mod, rolls, total: rolls.reduce((a, b) => a + b, 0) + mod };
}

// n distinct winners, uniformly at random (crypto RNG, partial Fisher-Yates)
export function drawWinners(pool, n) {
  const a = [...pool];
  const k = Math.min(n, a.length);
  for (let i = 0; i < k; i++) {
    const j = randomInt(i, a.length);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, k);
}
