import { snowflake } from '../snowflake.js';
import { get, memberIds } from '../db.js';
import { HttpError, str, int, bool, snowflakeField, notFound, missingPermissions } from '../errors.js';
import { P, has, need, channelPerms, requireAbove, viewersOf } from '../permissions.js';
import { sendToUsers, guildParts } from '../gateway.js';
import { audit, A, diff } from '../audit.js';
import { voiceState, voiceStateObj, statesIn, setStageState, leaveHooks } from '../voice.js';
import { getChannel } from '../message.js';
import { loadChannel } from './channels.js';
import { loadGuild } from './guilds.js';
import { setEventStatus } from './events.js';

// live stages: channel id -> instance. In memory like voice states: a stage closes when its last listener leaves.
const instances = new Map();

// stage moderators, as the contract defines them
const MODERATOR = P.MUTE_MEMBERS | P.MOVE_MEMBERS;
// an instance whose channel was deleted is dropped the next time someone looks
// only members who can view the stage channel learn its topic
guildParts.push((g, userId) => ({
  stage_instances: [...instances.values()].filter(i => {
    if (i.guild_id !== g.id) return false;
    const ch = getChannel(i.channel_id);
    if (!ch) return !instances.delete(i.channel_id);
    return !!userId && has(channelPerms(ch, userId), P.VIEW_CHANNEL);
  }),
}));

function loadStage(channelId, user) {
  const ch = loadChannel(channelId, user);
  if (ch.type !== 13) throw new HttpError(400, 50024, 'Cannot execute action on this channel type');
  return ch;
}

function loadInstance(ctx) {
  const ch = loadStage(ctx.params.channel_id, ctx.user);
  const inst = instances.get(ch.id);
  if (!inst) throw notFound(10067, 'Stage Instance');
  return [ch, inst];
}

const privacy = body => (body.privacy_level === undefined ? 2 : int(body, 'privacy_level', 2, 2));
const announce = (inst, t) => { const ch = getChannel(inst.channel_id); sendToUsers(ch ? viewersOf(ch) : memberIds(inst.guild_id), t, inst); };

function close(ctx, inst) {
  instances.delete(inst.channel_id);
  announce(inst, 'STAGE_INSTANCE_DELETE');
  audit(ctx, inst.guild_id, A.STAGE_INSTANCE_DELETE, inst.id, { changes: diff({ topic: inst.topic }, {}, ['topic']), options: { channel_id: inst.channel_id } });
  // a stage event ends with its stage
  if (inst.guild_scheduled_event_id) setEventStatus(inst.guild_scheduled_event_id, 2, 3);
}

leaveHooks.push(old => {
  const inst = instances.get(old.channel_id);
  if (inst && !statesIn(old.channel_id).length) close(null, inst);
});

function create(ctx) {
  const body = ctx.body ?? {};
  const ch = loadStage(snowflakeField(body, 'channel_id'), ctx.user);
  need(ch.perms, MODERATOR);
  if (instances.has(ch.id)) throw new HttpError(400, 150006, 'A stage instance already exists for this channel');
  const eventId = body.guild_scheduled_event_id == null ? null : snowflakeField(body, 'guild_scheduled_event_id');
  if (eventId && !get('SELECT 1 FROM scheduled_events WHERE id = ? AND guild_id = ?', eventId, ch.guild_id)) throw notFound(10070, 'Guild Scheduled Event');
  const inst = {
    id: snowflake(), guild_id: ch.guild_id, channel_id: ch.id, topic: str(body, 'topic', 1, 120), privacy_level: privacy(body),
    discoverable_disabled: true, guild_scheduled_event_id: eventId,
  };
  instances.set(ch.id, inst);
  if (eventId) setEventStatus(eventId, 1, 2);
  announce(inst, 'STAGE_INSTANCE_CREATE');
  audit(ctx, ch.guild_id, A.STAGE_INSTANCE_CREATE, inst.id, { changes: diff({}, { topic: inst.topic, privacy_level: inst.privacy_level }), options: { channel_id: ch.id } });
  return inst;
}

function update(ctx) {
  const [ch, inst] = loadInstance(ctx);
  need(ch.perms, MODERATOR);
  const body = ctx.body ?? {};
  const before = { ...inst };
  if (body.topic !== undefined) inst.topic = str(body, 'topic', 1, 120);
  if (body.privacy_level !== undefined) inst.privacy_level = privacy(body);
  announce(inst, 'STAGE_INSTANCE_UPDATE');
  audit(ctx, ch.guild_id, A.STAGE_INSTANCE_UPDATE, inst.id, { changes: diff(before, inst, ['topic', 'privacy_level']), options: { channel_id: ch.id } });
  return inst;
}

function remove(ctx) {
  const [ch, inst] = loadInstance(ctx);
  need(ch.perms, MODERATOR);
  close(ctx, inst);
}

function stateOf(guildId, userId) {
  const v = voiceState(guildId, userId);
  if (!v) throw notFound(10065, 'Voice State');
  return v;
}

function rtsField(body) {
  const v = body.request_to_speak_timestamp;
  if (v === null) return null;
  const t = Date.parse(v);
  if (typeof v !== 'string' || Number.isNaN(t)) throw new HttpError(400, 50035, 'Invalid Form Body');
  return new Date(Math.max(t, Date.now())).toISOString();
}

// PATCH /guilds/:id/voice-states/@me: suppress yourself any time, unsuppress with MUTE_MEMBERS, raise or lower your hand
function patchMe(ctx) {
  const g = loadGuild(ctx.params.id, ctx.user);
  const body = ctx.body ?? {};
  const v = stateOf(g.id, ctx.user.id);
  const ch = getChannel(v.channel_id);
  if (ch.type !== 13 || (body.channel_id != null && String(body.channel_id) !== ch.id)) throw new HttpError(400, 50024, 'Cannot execute action on this channel type');
  const perms = channelPerms(ch, ctx.user.id);
  const changes = {};
  if (body.suppress !== undefined) {
    changes.suppress = bool(body, 'suppress');
    if (!changes.suppress) need(perms, P.MUTE_MEMBERS);
  }
  if (body.request_to_speak_timestamp !== undefined) {
    changes.request_to_speak_timestamp = rtsField(body);
    if (changes.request_to_speak_timestamp) need(perms, P.REQUEST_TO_SPEAK);
  }
  setStageState(v, changes);
}

// PATCH /guilds/:id/voice-states/:user_id: moderators move people between audience and speakers
function patchUser(ctx) {
  const g = loadGuild(ctx.params.id, ctx.user);
  const body = ctx.body ?? {};
  const v = stateOf(g.id, ctx.params.user_id);
  const ch = getChannel(v.channel_id);
  if (ch.type !== 13 || String(body.channel_id ?? ch.id) !== ch.id) throw new HttpError(400, 50024, 'Cannot execute action on this channel type');
  need(channelPerms(ch, ctx.user.id), P.MUTE_MEMBERS);
  if (body.suppress === undefined) return;
  const suppress = bool(body, 'suppress');
  if (suppress && ctx.params.user_id !== ctx.user.id) requireAbove(g.id, ctx.user.id, ctx.params.user_id);
  // being invited to speak sets the timestamp, per the docs
  setStageState(v, { suppress, request_to_speak_timestamp: suppress ? null : new Date().toISOString() });
}

function getState(ctx, userId) {
  const g = loadGuild(ctx.params.id, ctx.user);
  const v = stateOf(g.id, userId);
  if (userId !== ctx.user.id && !has(channelPerms(getChannel(v.channel_id), ctx.user.id), P.CONNECT)) throw missingPermissions();
  return voiceStateObj(v);
}

export default [
  ['POST', '/stage-instances', create],
  ['GET', '/stage-instances/:channel_id', ctx => loadInstance(ctx)[1]],
  ['PATCH', '/stage-instances/:channel_id', update],
  ['DELETE', '/stage-instances/:channel_id', remove],
  ['GET', '/guilds/:id/voice-states/@me', ctx => getState(ctx, ctx.user.id)],
  ['PATCH', '/guilds/:id/voice-states/@me', patchMe],
  ['GET', '/guilds/:id/voice-states/:user_id', ctx => getState(ctx, ctx.params.user_id)],
  ['PATCH', '/guilds/:id/voice-states/:user_id', patchUser],
];
