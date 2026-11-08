// Updates of a self-hosted node through selfhost's updater sidecar (selfhost/README.md "Updater"): status, the daily check,
// automatic updates in a maintenance window and the update report the heartbeat sends to the hub. Routes in routes/node.js.
// CILLCORD_UPDATER_URL (e.g. http://updater:8787) and CILLCORD_UPDATER_SECRET come from the host's .env, so this is a
// trusted local address and does not go through the SSRF guard. Kept free of federation.js (which imports this).
import { HttpError } from './errors.js';
import { setting, setSetting } from './instance.js';

const UPDATER_URL = (process.env.CILLCORD_UPDATER_URL ?? '').replace(/\/+$/, '');
const UPDATER_SECRET = process.env.CILLCORD_UPDATER_SECRET ?? '';
export const hasUpdater = !!UPDATER_URL;
export const AUTO_MODES = ['off', 'patch', 'all'];
const cut = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);

export const autoCheck = () => setting('update_check') ?? process.env.CILLCORD_UPDATE_CHECK !== '0';
// automatic updates: off | patch (patch and security releases) | all, once a day in the hour `hour` (UTC); install.sh
// --auto-update writes the defaults into .env, the setup wizard and the Updates page store them as settings
const envMode = AUTO_MODES.includes(process.env.CILLCORD_AUTO_UPDATE) ? process.env.CILLCORD_AUTO_UPDATE : 'off';
const envHour = /^([01]?\d|2[0-3])$/.test(process.env.CILLCORD_AUTO_UPDATE_HOUR ?? '') ? Number(process.env.CILLCORD_AUTO_UPDATE_HOUR) : 4;
export const autoUpdate = () => ({ mode: setting('auto_update') ?? envMode, hour: setting('auto_update_hour') ?? envHour });
// may the hub ask this node to update now (signed request, routes/node.js)? The node admin can turn it off.
export const remoteUpdate = () => setting('remote_update') ?? true;

export async function callUpdater(method, path, body, timeout = 30_000) {
  if (!UPDATER_URL) throw new HttpError(400, 0, 'No updater is configured on this host (CILLCORD_UPDATER_URL).');
  let res;
  try {
    res = await fetch(UPDATER_URL + path, {
      method, signal: AbortSignal.timeout(timeout), headers: { Authorization: `Bearer ${UPDATER_SECRET}`, ...(body && { 'Content-Type': 'application/json' }) },
      body: body && JSON.stringify(body),
    });
  } catch (e) {
    throw new HttpError(502, 0, `The updater is unreachable: ${e.message}`);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new HttpError(res.status === 409 || res.status === 422 ? 400 : 502, 0, `Updater: ${cut(data?.error, 300) || `HTTP ${res.status}`}`);
  return data;
}

// GET /check of the updater (it reads the hub's signed latest.json); the result is kept for the dashboard
export async function checkNow() {
  try {
    setSetting('update_last_check', { at: new Date().toISOString(), ...await callUpdater('GET', '/check'), error: null });
  } catch (e) {
    setSetting('update_last_check', { at: new Date().toISOString(), error: e.message });
    throw e;
  }
  return setting('update_last_check');
}

// a patch release keeps major.minor; with mode patch only those and releases marked security are applied automatically
const minor = v => String(v ?? '').split('.').slice(0, 2).join('.');
export const autoAllowed = (mode, current, latest) => mode === 'all' || (mode === 'patch' && (!!latest?.security || minor(latest?.version) === minor(current)));

// one automatic attempt per window: in the configured hour, check the feed and, when the mode allows the offered release,
// ask the updater (backup, swap, health check, automatic rollback). `auto: true` makes the updater refuse a version that
// failed or was rolled back before, so a broken release is not retried every night.
export async function autoTick(now = new Date()) {
  const { mode, hour } = autoUpdate();
  if (mode === 'off' || !UPDATER_URL || now.getUTCHours() !== hour) return null;
  const last = setting('update_last_auto');
  if (last && now - Date.parse(last.at) < 2 * 3600e3) return null;
  const c = await checkNow();
  const v = c.latest?.version ?? null;
  const record = decision => (setSetting('update_last_auto', { at: now.toISOString(), version: v, decision }), console.log(`auto-update: ${decision}`), decision);
  if (!c.update_available) return record('up to date');
  if (!c.can_update) return record(`${v} needs a manual update first`);
  if (!autoAllowed(mode, c.current_version, c.latest)) return record(`${v} is not a patch or security release (mode ${mode}); update by hand`);
  record(`updating to ${v}`); // stored before the updater stops the app, so the database snapshot has it
  try {
    await callUpdater('POST', '/update', { version: v, auto: true });
  } catch (e) {
    return record(`not updated to ${v}: ${e.body?.message ?? e.message}`);
  }
  return `updating to ${v}`;
}

// check daily (unless turned off) and look for the maintenance window every 5 minutes
export function startUpdates() {
  if (!UPDATER_URL) return;
  const check = () => autoCheck() && checkNow().catch(() => {});
  const auto = () => autoTick().catch(e => console.error(`auto-update failed: ${e.message}`));
  setTimeout(check, 60_000).unref();
  setInterval(check, 24 * 3600e3).unref();
  setTimeout(auto, 30_000).unref();
  setInterval(auto, 5 * 60_000).unref();
}

// what the heartbeat tells the hub (and its Nodes page shows): settings, the latest version seen, the last operation
export async function updateReport() {
  const { mode, hour } = autoUpdate();
  const out = {
    updater: hasUpdater, auto_update: mode, auto_update_hour: hour, remote_update: remoteUpdate(),
    latest_version: setting('update_last_check')?.latest?.version ?? null, last_result: null, last_auto: setting('update_last_auto'),
  };
  if (!hasUpdater) return out;
  try {
    const s = await callUpdater('GET', '/status', undefined, 5000);
    if (s?.action) {
      out.last_result = {
        action: s.action, version: cut(s.target_version, 40), state: s.state, rolled_back: s.rolled_back ?? null,
        error: cut(s.error, 300), at: s.finished_at ?? s.started_at ?? null,
      };
    }
  } catch { /* updater down: the report says nothing about it */ }
  return out;
}
