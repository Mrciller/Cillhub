// Evaluated inside QuickJS before the module (CONTRACT-v8 §4). It defines the `cillhub` global and console, and returns
// the dispatcher the runner calls with host frames. `send` is the only host function; it takes strings only and returns
// false when a frame would be too large. Nothing here is trusted by the server: every call is checked there.
(function (send) {
  'use strict';
  const stringify = JSON.stringify, parse = JSON.parse, P = Promise, Err = Error, Str = String, keys = Object.keys;
  const handlers = Object.create(null);
  const pending = new Map();
  let nextId = 1;
  const LEVELS = ['debug', 'info', 'warn', 'error'];

  const fail = (code, message) => { const e = new Err(message); e.code = code; return e; };
  function toError(info) {
    const e = new Err(Str(info && info.message || 'Error'));
    for (const k of ['code', 'status', 'api_code', 'errors', 'retry_after']) if (info && info[k] !== undefined) e[k] = info[k];
    return e;
  }

  function call(action, args) {
    if (typeof action !== 'string' || action.length > 64) return P.reject(fail('INVALID', 'action must be a string'));
    let json;
    try { json = stringify(args === undefined ? {} : args); } catch (e) { return P.reject(fail('INVALID', 'arguments must be JSON: ' + Str(e && e.message))); }
    if (json === undefined || json[0] !== '{') return P.reject(fail('INVALID', 'arguments must be an object'));
    if (pending.size >= 100) return P.reject(fail('RATE_LIMITED', 'too many calls in flight'));
    const id = nextId++;
    return new P((resolve, reject) => {
      if (!send('call', id, action, json)) return reject(fail('TOO_LARGE', 'the call arguments are too large'));
      pending.set(id, { resolve, reject });
    });
  }

  function text(args) {
    let out = '';
    for (let i = 0; i < args.length && out.length < 2000; i++) {
      const a = args[i];
      let s;
      if (typeof a === 'string') s = a;
      else if (a instanceof Err) s = (a.name || 'Error') + ': ' + a.message;
      else { try { s = stringify(a); } catch (e) { s = undefined; } if (s === undefined) s = Str(a); }
      out += (i ? ' ' : '') + s;
    }
    return out.slice(0, 2000);
  }
  function log(level, ...args) {
    send('log', 0, LEVELS.includes(level) ? level : 'info', text(args));
  }

  // constant time for a given length of a (the computed signature), in the sandbox
  function equal(a, b) {
    a = Str(a); b = Str(b);
    let diff = a.length ^ b.length;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ (b.charCodeAt(i) | 0);
    return diff === 0;
  }

  const c = (action, args) => call(action, args);
  const obj = (first, build) => (first !== null && typeof first === 'object' ? first : build());
  const cillhub = {
    on(name, handler) {
      if (typeof name !== 'string' || typeof handler !== 'function') throw fail('INVALID', 'cillhub.on(name, handler)');
      handlers[name] = handler;
    },
    call,
    log,
    guilds: { list: () => c('guilds.list', {}), get: guildId => c('guilds.get', { guild_id: guildId }) },
    channels: {
      list: guildId => c('channels.list', { guild_id: guildId }),
      create: (guildId, data) => c('channels.create', Object.assign({}, typeof data === 'string' ? { name: data } : data, { guild_id: guildId })),
      delete: channelId => c('channels.delete', { channel_id: channelId }),
    },
    roles: { list: guildId => c('roles.list', { guild_id: guildId }) },
    settings: { get: guildId => c('settings.get', guildId == null ? {} : { guild_id: guildId }) },
    messages: {
      list: (channelId, opts) => c('messages.list', Object.assign({}, opts, { channel_id: channelId })),
      get: (channelId, messageId) => c('messages.get', { channel_id: channelId, message_id: messageId }),
      send: (channelId, message) => c('messages.send', Object.assign({}, typeof message === 'string' ? { content: message } : message, { channel_id: channelId })),
      edit: (channelId, messageId, message) => c('messages.edit', Object.assign({}, typeof message === 'string' ? { content: message } : message, { channel_id: channelId, message_id: messageId })),
      delete: (channelId, messageId) => c('messages.delete', { channel_id: channelId, message_id: messageId }),
    },
    reactions: { add: (channelId, messageId, emoji) => c('reactions.add', { channel_id: channelId, message_id: messageId, emoji }) },
    members: {
      get: (guildId, userId) => c('members.get', { guild_id: guildId, user_id: userId }),
      list: (guildId, opts) => c('members.list', Object.assign({}, opts, { guild_id: guildId })),
      addRole: (guildId, userId, roleId) => c('members.add_role', { guild_id: guildId, user_id: userId, role_id: roleId }),
      removeRole: (guildId, userId, roleId) => c('members.remove_role', { guild_id: guildId, user_id: userId, role_id: roleId }),
    },
    voice: { list: guildId => c('voice.list', { guild_id: guildId }) },
    interactions: {
      respond: (interactionId, response) => c('interactions.respond', { interaction_id: interactionId, response }),
      followup: (interactionId, message) => c('interactions.followup', { interaction_id: interactionId, message }),
      edit: (interactionId, message, messageId) => c('interactions.edit', { interaction_id: interactionId, message, message_id: messageId === undefined ? '@original' : messageId }),
    },
    storage: {
      get: key => c('storage.get', { key }),
      set: (key, value) => c('storage.set', { key, value: value === undefined ? null : value }),
      delete: key => c('storage.delete', { key }),
      list: opts => c('storage.list', Object.assign({}, opts)),
    },
    http: { fetch: (url, opts) => c('http.fetch', Object.assign({}, opts, { url })) },
    schedule: {
      every: (name, intervalMs) => c('schedule.every', obj(name, () => ({ name, interval_ms: intervalMs }))),
      at: (name, at) => c('schedule.at', obj(name, () => ({ name, at: at instanceof Date ? at.getTime() : at }))),
      cancel: name => c('schedule.cancel', obj(name, () => ({ name }))),
      list: () => c('schedule.list', {}),
    },
    ui: { publish: (guildId, data) => c('ui.publish', { guild_id: guildId, data: data === undefined ? null : data }) },
    crypto: {
      hmac: (algorithm, key, data, encoding) => c('crypto.hmac', obj(algorithm, () => ({ algorithm, key, data, encoding }))),
      sha256: (data, encoding) => c('crypto.sha256', obj(data, () => ({ data, encoding }))),
      random: bytes => c('crypto.random', obj(bytes, () => ({ bytes }))),
      equal,
    },
  };
  for (const k of keys(cillhub)) if (typeof cillhub[k] === 'object') Object.freeze(cillhub[k]);
  Object.defineProperty(globalThis, 'cillhub', { value: Object.freeze(cillhub), enumerable: true });
  const consoleObj = {};
  for (const [name, level] of [['log', 'info'], ['info', 'info'], ['warn', 'warn'], ['error', 'error'], ['debug', 'debug']]) consoleObj[name] = (...args) => log(level, ...args);
  globalThis.console = consoleObj;

  function finish(eid, ok, value) {
    let json;
    if (ok) {
      try { json = stringify(value === undefined ? null : value); } catch (e) { ok = false; value = e; }
      if (json === undefined) json = 'null';
    }
    if (!ok) {
      const message = value instanceof Err ? (value.name || 'Error') + ': ' + value.message : Str(value);
      json = stringify({ message: message.slice(0, 1000) });
    }
    if (!send('done', eid, ok ? 'ok' : 'err', json)) send('done', eid, 'err', stringify({ code: 'TOO_LARGE', message: 'The handler result is too large.' }));
  }

  // host frames: ('event', eid, name, payloadJson) and ('reply', callId, 'ok' | 'err', json)
  return function dispatch(type, id, a, b) {
    if (type === 'reply') {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      let v;
      try { v = parse(b); } catch (e) { return p.reject(e); }
      if (a === 'ok') p.resolve(v); else p.reject(toError(v));
      return;
    }
    if (type === 'event') {
      const h = handlers[a];
      let payload;
      try { payload = parse(b); } catch (e) { return finish(id, false, e); }
      P.resolve().then(() => (h ? h(payload) : null)).then(v => finish(id, true, v), e => finish(id, false, e));
    }
  };
})
