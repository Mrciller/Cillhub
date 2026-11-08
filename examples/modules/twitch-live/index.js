// Twitch Live: receives Twitch EventSub webhooks at /modules/twitch-live/http/twitch
// and announces stream.online events (see README.md).

const MAX_AGE_MS = 10 * 60 * 1000;
const SEEN_KEY = 'seen-message-ids';
const SEEN_CAP = 200;

const text = (status, body = '') => ({ status, headers: { 'content-type': 'text/plain; charset=utf-8' }, body });

cillhub.on('HTTP_REQUEST', async (req) => {
  if (req.path !== '/twitch') return text(404, 'not found');
  if (req.method !== 'POST') return text(405, 'POST only');
  if (req.body_encoding !== 'utf8') return text(400, 'body must be UTF-8 JSON');

  const settings = await cillhub.call('settings.get', {});
  if (!settings.secret) {
    console.warn('Webhook refused: the EventSub secret is not set.');
    return text(503, 'not configured');
  }

  const h = req.headers;
  const id = h['twitch-eventsub-message-id'];
  const ts = h['twitch-eventsub-message-timestamp'];
  const sig = h['twitch-eventsub-message-signature'];
  if (!id || !ts || !sig) return text(400, 'missing EventSub headers');

  const expected = 'sha256=' + await cillhub.call('crypto.hmac', {
    algorithm: 'sha256', key: settings.secret, data: id + ts + req.body, encoding: 'hex',
  });
  if (!cillhub.crypto.equal(expected, sig)) {
    console.warn(`Webhook with a bad signature refused (message ${id}).`);
    return text(403, 'bad signature');
  }

  // Twitch sends nanoseconds; trim to milliseconds so Date.parse accepts it everywhere.
  const sent = Date.parse(ts.replace(/(\.\d{3})\d+/, '$1'));
  if (!Number.isFinite(sent) || Math.abs(Date.now() - sent) > MAX_AGE_MS) return text(403, 'stale timestamp');

  // Handlers run one at a time, so this read-modify-write cannot race.
  const seen = (await cillhub.call('storage.get', { key: SEEN_KEY })) || [];
  if (seen.includes(id)) return text(204); // a retry of something we already handled
  seen.push(id);
  await cillhub.call('storage.set', { key: SEEN_KEY, value: seen.slice(-SEEN_CAP) });

  let msg;
  try { msg = JSON.parse(req.body); } catch { return text(400, 'invalid JSON'); }

  const type = h['twitch-eventsub-message-type'];
  if (type === 'webhook_callback_verification') {
    console.info(`Subscription ${msg.subscription?.id} (${msg.subscription?.type}) verified.`);
    return text(200, String(msg.challenge));
  }
  if (type === 'revocation') {
    console.warn(`Twitch revoked subscription ${msg.subscription?.id}: ${msg.subscription?.status}.`);
    return text(204);
  }
  if (type !== 'notification' || msg.subscription?.type !== 'stream.online') return text(204);

  await announce(settings, msg.event || {});
  return text(204);
});

async function announce(settings, ev) {
  if (!settings.channel) {
    console.warn('stream.online received, but no announcement channel is set.');
    return;
  }
  const login = String(ev.broadcaster_user_login || '');
  const name = String(ev.broadcaster_user_name || login);
  const url = `https://twitch.tv/${encodeURIComponent(login)}`;
  const content = String(settings.message || '{name} is live: {url}')
    .replaceAll('{name}', () => name)
    .replaceAll('{login}', () => login)
    .replaceAll('{url}', () => url);
  try {
    await cillhub.messages.send(settings.channel, {
      content,
      embeds: [{ title: `${name} is live on Twitch`, url, color: 0x9146ff, timestamp: ev.started_at }],
      allowed_mentions: { parse: [] },
    });
  } catch (err) {
    // Still answer 204: the id is already recorded, so a Twitch retry would be skipped anyway.
    console.error(`Announcement in ${settings.channel} failed: ${err.code || ''} ${err.message}`);
  }
}
