// Bridge helper for module panel pages (docs/CONTRACT-v8.md §6.4).
// Copy this file into your module's ui/ folder and load it with <script src="cillhub-panel.js"></script>.
// It only talks to window.parent (the client); the panel's own origin is opaque, hence targetOrigin '*'.
(() => {
  const pending = new Map();
  const eventFns = [];
  const contextFns = [];
  let readyWaiters = [];
  let context = null;
  let seq = 0;

  function post(action, data) {
    const id = String(++seq);
    window.parent.postMessage({ cillhub: 1, type: 'request', id, action, data }, '*');
    return id;
  }

  function send(action, data) {
    return new Promise((resolve, reject) => pending.set(post(action, data), { resolve, reject }));
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window.parent) return;
    const m = e.data;
    if (!m || typeof m !== 'object' || m.cillhub !== 1) return;
    if (m.type === 'context') {
      context = m.context;
      for (const fn of contextFns) fn(context);
      for (const resolve of readyWaiters) resolve(context);
      readyWaiters = [];
    } else if (m.type === 'response') {
      const p = pending.get(m.id);
      if (!p) return; // e.g. the response to "ready": ready() resolves on the context message before it
      pending.delete(m.id);
      if (m.ok) p.resolve(m.data);
      else {
        const err = new Error((m.error && m.error.message) || 'Request failed');
        err.code = m.error && m.error.code;
        p.reject(err);
      }
    } else if (m.type === 'event') {
      for (const fn of eventFns) fn(m.data);
    }
  });

  window.CillhubPanel = {
    /** Resolves with the context ({module_id, panel_id, slot, guild_id, channel_id, message_id, user, locale, theme}). */
    ready() {
      if (context) return Promise.resolve(context);
      return new Promise((resolve) => { readyWaiters.push(resolve); post('ready'); });
    },
    /** Sends data to the module's UI_REQUEST handler; resolves with its return value. */
    request: (data) => send('request', data),
    resize: (height) => send('resize', { height }),
    close: () => send('close'),
    openUrl: (url) => send('open_url', { url }),
    /** Called with the data of every ui.publish of this module in this server. */
    onEvent(fn) { eventFns.push(fn); },
    /** Called with every context message (theme or locale changes, a new channel). */
    onContext(fn) { contextFns.push(fn); if (context) fn(context); },
  };
})();
