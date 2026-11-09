import vm from 'node:vm';
import { get, all, run, json, memberIds, memberRow, memberObj } from './db.js';
import { HttpError } from './errors.js';
import { P, holders, guildPerms, isThread, viewersOf } from './permissions.js';
import { sendToUsers } from './gateway.js';
import { audit, A } from './audit.js';
import { insertMessage, broadcastMessage, getChannel } from './message.js';
import { recheck } from './voice.js';

// one budget for all regex patterns of all rules on one message (the main thread waits for it)
const BUDGET_MS = 50;
const COOLDOWN_MS = 60_000;
const MAX_INPUT = 4096;
const WORD = '[\\p{L}\\p{N}_]';
const slowPatterns = new Map(); // rule id + pattern -> when it last ran out of budget; skipped for COOLDOWN_MS

// rule regexes run inside a vm context with a timeout, which interrupts runaway backtracking; undefined on timeout
const sandbox = vm.createContext({ re: null, s: '' });
function timedExec(re, s, ms) {
  sandbox.re = re;
  sandbox.s = s;
  try {
    return vm.runInContext('re.exec(s)', sandbox, { timeout: Math.max(1, Math.ceil(ms)) });
  } catch (e) {
    if (e.code !== 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw e;
    console.warn(`automod: /${re.source}/ ran out of the ${BUDGET_MS} ms budget, skipped for a minute`);
    return undefined;
  } finally {
    sandbox.re = null;
    sandbox.s = '';
  }
}

// nested quantifiers like (a+)+ backtrack exponentially; refused up front, the time budget covers the rest
function nestedQuantifier(p) {
  const stack = [false]; // per open group: does its body hold a quantifier?
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '\\') { i++; continue; }
    if (c === '[') {
      for (i++; i < p.length && p[i] !== ']'; i++) if (p[i] === '\\') i++;
      continue;
    }
    if (c === '(') { stack.push(false); continue; }
    if (c === ')' && stack.length > 1) {
      const inner = stack.pop();
      const q = '*+{'.includes(p[i + 1] ?? '');
      if (inner && q) return true;
      if (inner || q || p[i + 1] === '?') stack[stack.length - 1] = true;
      continue;
    }
    if ('*+?{'.includes(c)) stack[stack.length - 1] = true;
  }
  return false;
}

// null if the pattern is acceptable, else why not. The reference engine (Rust regex) has no backreferences or lookaround either.
export function patternProblem(p) {
  if (typeof p !== 'string' || !p.length || p.length > 2048) return 'Patterns are 1-2048 characters.';
  try { new RegExp(p, 'iu'); } catch { return 'Not a valid regular expression.'; }
  if (/\\[1-9]|\\k</.test(p)) return 'Backreferences are not supported.';
  if (/\(\?<?[=!]/.test(p)) return 'Lookaround is not supported.';
  if (nestedQuantifier(p)) return 'Nested quantifiers are not supported.';
  return null;
}

// keyword wildcards (docs): cat = the word, cat* = words starting with it, *cat = ending with it, *cat* = anywhere
function keywordRegex(k, flags = 'giu') {
  const start = k.startsWith('*'), end = k.endsWith('*');
  const core = k.replace(/^\*|\*$/g, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${start ? '' : `(?<!${WORD})`}${core}${end ? '' : `(?!${WORD})`}`, flags);
}

// the whole word around a match, for allow_list checks
function wordAt(s, index, length) {
  const w = new RegExp(`${WORD}`, 'u');
  let a = index, b = index + length;
  while (a > 0 && w.test(s[a - 1])) a--;
  while (b < s.length && w.test(s[b])) b++;
  return s.slice(a, b);
}

function keywordHit(meta, content, ruleId, deadline) {
  const allowed = (meta.allow_list ?? []).map(k => keywordRegex(k, 'iu'));
  const ok = (word, matched) => !allowed.some(re => re.test(word) || re.test(matched));
  for (const k of meta.keyword_filter ?? []) {
    for (const m of content.matchAll(keywordRegex(k))) {
      if (ok(wordAt(content, m.index, m[0].length), m[0])) return { keyword: k, matched: m[0] };
    }
  }
  for (const p of meta.regex_patterns ?? []) {
    const key = `${ruleId}\0${p}`;
    if (Date.now() - (slowPatterns.get(key) ?? -Infinity) < COOLDOWN_MS || deadline - Date.now() <= 0) continue;
    const m = timedExec(new RegExp(p, 'iu'), content, deadline - Date.now());
    if (m === undefined) slowPatterns.set(key, Date.now());
    if (m && ok(wordAt(content, m.index, m[0].length), m[0])) return { keyword: p, matched: m[0] };
  }
  return null;
}

function mentionHit(meta, content) {
  const ids = new Set([...content.matchAll(/<@[!&]?(\d+)>/g)].map(m => m[0].replace('!', '')));
  return ids.size > meta.mention_total_limit ? { keyword: null, matched: null } : null;
}

function exempt(rule, guildId, userId, ch) {
  if (guildPerms(guildId, userId) & P.ADMINISTRATOR) return true; // owner and administrators
  const channels = json(rule.exempt_channels, []);
  if (ch && (channels.includes(ch.id) || (isThread(ch) && channels.includes(ch.parent_id)))) return true;
  const roles = json(rule.exempt_roles, []);
  return roles.length > 0 && !!get('SELECT 1 FROM member_roles WHERE guild_id = ? AND user_id = ? AND role_id IN (SELECT value FROM json_each(?))', guildId, userId, rule.exempt_roles);
}

function check(guildId, eventType, ch, userId, content) {
  const text = content.slice(0, MAX_INPUT);
  const hits = [];
  const deadline = Date.now() + BUDGET_MS;
  for (const rule of all('SELECT * FROM automod_rules WHERE guild_id = ? AND enabled = 1 AND event_type = ?', guildId, eventType)) {
    if (exempt(rule, guildId, userId, ch)) continue;
    const meta = json(rule.trigger_metadata, {});
    const hit = rule.trigger_type === 5 ? mentionHit(meta, text) : keywordHit(meta, text, rule.id, deadline);
    if (hit) hits.push({ rule: { ...rule, actions: json(rule.actions) }, ...hit });
  }
  return hits;
}

function timeout(guildId, userId, seconds) {
  const m = memberRow(guildId, userId);
  if (!m || guildPerms(guildId, userId) & P.ADMINISTRATOR) return;
  run('UPDATE members SET communication_disabled_until = ? WHERE guild_id = ? AND user_id = ?', new Date(Date.now() + seconds * 1000).toISOString(), guildId, userId);
  sendToUsers(memberIds(guildId), 'GUILD_MEMBER_UPDATE', { guild_id: guildId, ...memberObj(memberRow(guildId, userId)) });
  recheck(guildId, userId);
}

function alert(hit, a, { guildId, ch, userId, content, messageId, blocked }) {
  const target = getChannel(a.metadata?.channel_id);
  if (!target || target.guild_id !== guildId) return undefined;
  const field = (name, value) => value != null && { name, value: String(value), inline: false };
  // M6: the content only goes where nobody reads it who could not read the source channel
  const source = ch && new Set(viewersOf(ch));
  const hide = source && !viewersOf(target).every(id => source.has(id));
  const embed = {
    type: 'auto_moderation_message', description: hide ? null : content,
    fields: [
      field('rule_name', hit.rule.name), field('decision_id', hit.rule.id), field('decision_outcome', blocked ? 'blocked' : 'flagged'),
      field('channel_id', ch?.id), field('flagged_message_id', messageId), field('keyword', hit.keyword),
      field('keyword_matched_content', hide ? null : hit.matched),
      field('timeout_duration', hit.rule.actions.find(x => x.type === 3)?.metadata?.duration_seconds),
    ].filter(Boolean),
  };
  const m = insertMessage({ ch: target, authorId: userId, type: 24, embeds: [embed] });
  broadcastMessage(target, 'MESSAGE_CREATE', m);
  return m.id;
}

// runs every action of every matching rule; blocked: the content was refused (BLOCK actions only count then)
function execute(hits, ctx, blocked) {
  for (const hit of hits) {
    const options = { auto_moderation_rule_name: hit.rule.name, auto_moderation_rule_trigger_type: String(hit.rule.trigger_type), ...(ctx.ch && { channel_id: ctx.ch.id }) };
    for (const a of hit.rule.actions) {
      let alertId;
      if (a.type === 1 && !blocked) continue;
      if (a.type === 1) audit({ user: { id: ctx.userId } }, ctx.guildId, A.AUTO_MODERATION_BLOCK_MESSAGE, ctx.userId, { options });
      if (a.type === 2) {
        alertId = alert(hit, a, { ...ctx, blocked });
        audit({ user: { id: ctx.userId } }, ctx.guildId, A.AUTO_MODERATION_FLAG_TO_CHANNEL, ctx.userId, { options });
      }
      if (a.type === 3) {
        timeout(ctx.guildId, ctx.userId, a.metadata.duration_seconds);
        audit({ user: { id: ctx.userId } }, ctx.guildId, A.AUTO_MODERATION_USER_COMMUNICATION_DISABLED, ctx.userId, { options });
      }
      sendToUsers(holders(ctx.guildId, P.MANAGE_GUILD), 'AUTO_MODERATION_ACTION_EXECUTION', {
        guild_id: ctx.guildId, action: a, rule_id: hit.rule.id, rule_trigger_type: hit.rule.trigger_type, user_id: ctx.userId,
        ...(ctx.ch && { channel_id: ctx.ch.id }), ...(ctx.messageId && { message_id: ctx.messageId }),
        ...(alertId && { alert_system_message_id: alertId }),
        content: ctx.content, matched_keyword: hit.keyword, matched_content: hit.matched,
      });
    }
  }
}

function verdict(hits, ctx) {
  if (!hits.length) return null;
  const block = hits.flatMap(h => h.rule.actions).find(a => a.type === 1);
  return {
    blocked: !!block,
    // BLOCK: nothing is stored; the other actions still run, then the caller throws this
    reject() {
      execute(hits, { ...ctx, messageId: null }, true);
      return new HttpError(400, 200000, block.metadata?.custom_message || 'Message was blocked by automatic moderation');
    },
    execute: messageId => execute(hits, { ...ctx, messageId }, false),
  };
}

// MESSAGE_SEND rules for a message about to be sent (or edited) in a guild channel
export function moderateMessage(ch, userId, content) {
  if (!ch.guild_id) return null;
  return verdict(check(ch.guild_id, 1, ch, userId, content), { guildId: ch.guild_id, ch, userId, content });
}

// MEMBER_UPDATE rules (MEMBER_PROFILE) for a nickname about to be set
export function moderateProfile(guildId, userId, nick) {
  if (!nick) return null;
  return verdict(check(guildId, 2, null, userId, nick), { guildId, ch: null, userId, content: nick });
}

