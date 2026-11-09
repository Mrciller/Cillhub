// v7 with two real instances: a hub (port 3400) and a node (3401) linked through the first-run wizard, sign-in with a hub
// account (PKCE + EdDSA ID token), the server directory, NOTIFY through the hub's push, suspend, ban and unlink; plus a
// standalone node (3404) that never contacts its configured hub (a recorder on 3402). cillvoice self-check on UDP 3403,
// a fake push service on 3405, fake updater sidecars on 3406 (solo) and 3407 (node). Test-only flag
// CILLCORD_FEDERATION_DEV_HTTP lets the instances use http://127.0.0.1. The network key is a test key (NODE_ENV=test with
// CILLCORD_TEST_HUB_KEY), held by the hub; 3408/3409 are a hub under another key and a node that must refuse it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createHmac, createECDH, createPrivateKey, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import dgram from 'node:dgram';
import { DatabaseSync } from 'node:sqlite';
import { startServer, until, png, tempDir } from './helpers.js';
import { signRequest, pkceChallenge, newKeyPair, publicKeyText } from '../src/fedcrypto.js';

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
function totp(at = Date.now()) {
  const key = Buffer.from('48656c6c6f21deadbeef48656c6c6f21deadbeef', 'hex'); // = SECRET
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac('sha1', key).update(msg).digest();
  return String((h.readUInt32BE(h[19] & 0xf) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
const HUB = 'http://127.0.0.1:3400';
const NODE = 'http://127.0.0.1:3401';
const CALLBACK = `${NODE}/api/v9/federation/hub-callback`;
const SETUP = 'node-setup-code-1234';
// the network key for these tests, pinned by test/hub-key.mjs (helpers.js loads it only with NODE_ENV=test)
const hubKey = newKeyPair().privateKey;
const otherKey = newKeyPair().privateKey;
const dev = { CILLCORD_FEDERATION_DEV_HTTP: '1', NODE_ENV: 'test', CILLCORD_TEST_HUB_KEY: publicKeyText(hubKey) };
// a data dir that already holds this key as its federation key
async function keyedDir(key) {
  const dir = await tempDir();
  writeFileSync(join(dir, 'federation.key'), key.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  return dir;
}

let hub, node, solo, recorder, pushService, updaterService, nodeUpdater, soloAdmin;
const updaterCalls = []; // a fake updater sidecar on 3406 (solo instance)
const nodeUpdaterCalls = []; // and one on 3407 (the linked node)
const recorded = [];
const pushed = [];
let hubAdmin, hubBackup, alice, nodeAdmin, nodeBackup, nodeId;

const grant = (srv, name) => execFileSync(process.execPath, ['src/admin-cli.js', 'grant', name], { cwd: new URL('..', import.meta.url), env: { ...process.env, DATA_DIR: srv.dataDir }, stdio: 'ignore' });
const sql = (srv, query, ...args) => { const db = new DatabaseSync(join(srv.dataDir, 'cillcord.sqlite')); try { return db.prepare(query).all(...args); } finally { db.close(); } };
const listen = (handler, port) => new Promise(resolve => { const s = createServer(handler); s.listen(port, '127.0.0.1', () => resolve(s)); });
const pkce = () => { const verifier = randomBytes(32).toString('base64url'); return { verifier, challenge: pkceChallenge(verifier) }; };

async function hubCode(token = hubAdmin.token) {
  const r = await hub.api('POST', '/admin/federation/link-codes', token, { note: 'test' });
  assert.equal(r.status, 201);
  return r.body;
}
const consentQuery = over => `?${new URLSearchParams({ client_id: nodeId, redirect_uri: CALLBACK, response_type: 'code', code_challenge: pkce().challenge, code_challenge_method: 'S256', scope: 'identify', state: 's1', ...over })}`;
// the hub consent answer (user API: POST /oauth2/authorize?<query> {authorize}) -> {location}
const authorize = (user, over = {}, yes = true) => hub.api('POST', `/oauth2/authorize${consentQuery(over)}`, user.token, { authorize: yes });
const location = r => r.headers.get('location');
// the whole browser flow: node hub-login -> hub consent -> node hub-callback -> return_to#token=…
async function nodeSignIn(user, returnTo = `${HUB}/instances/callback`) {
  const start = await fetch(`${NODE}/api/v9/federation/hub-login?${new URLSearchParams({ return_to: returnTo, state: 'mine' })}`, { redirect: 'manual' });
  assert.equal(start.status, 302);
  const consent = new URL(location(start));
  if (consent.pathname !== '/oauth2/authorize') return new URLSearchParams(consent.hash.slice(1)); // refused at once (#error=…)
  const yes = await hub.api('POST', `/oauth2/authorize${consent.search}`, user.token, { authorize: true });
  if (yes.status !== 200) return new URLSearchParams({ error: `consent ${yes.status}` });
  const back = await fetch(yes.body.location, { redirect: 'manual' });
  assert.equal(back.status, 302);
  const to = new URL(location(back));
  assert.equal(to.origin + to.pathname, returnTo);
  return new URLSearchParams(to.hash.slice(1));
}

before(async () => {
  recorder = await listen((req, res) => { recorded.push(`${req.method} ${req.url}`); res.writeHead(404); res.end(); }, 3402);
  pushService = await listen((req, res) => { req.resume(); req.on('end', () => { pushed.push(req.url); res.writeHead(201); res.end(); }); }, 3405);
  hub = await startServer({ dataDir: await keyedDir(hubKey), env: { ...dev, PORT: '3400', CILLCORD_ROLE: 'hub', CILLCORD_UNFURL_ALLOW: '127.0.0.1:3401,127.0.0.1:3405' } });
  nodeUpdater = await listen((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      nodeUpdaterCalls.push({ method: req.method, url: req.url, body: body && JSON.parse(body) });
      const status = { state: 'done', action: 'update', target_version: '7.0.1', rolled_back: false, error: null, finished_at: '2026-11-05T04:03:00.000Z', current_version: '7.0.1' };
      res.writeHead(req.method === 'POST' ? 202 : 200, { 'Content-Type': 'application/json' });
      const check = { current_version: '7.0.0', latest: { version: '7.0.1', notes: 'fixes' }, update_available: true, can_update: true };
      res.end(JSON.stringify(req.method === 'POST' ? { ...status, state: 'updating' } : req.url === '/check' ? check : status));
    });
  }, 3407);
  node = await startServer({ env: {
    ...dev, PORT: '3401', CILLCORD_HUB_URL: HUB, CILLCORD_SETUP_CODE: SETUP,
    VOICE_BACKEND: 'cillvoice', CILLVOICE_UDP_PORT: '3403', CILLVOICE_PUBLIC_IP: '127.0.0.1',
    CILLCORD_UPDATER_URL: 'http://127.0.0.1:3407', CILLCORD_UPDATER_SECRET: 'node-updater-secret',
  } });
  updaterService = await listen((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      updaterCalls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body && JSON.parse(body) });
      const ok = req.headers.authorization === 'Bearer updater-secret';
      const out = { '/status': { state: 'idle', current_version: '7.0.0' }, '/check': { current_version: '7.0.0', latest: { version: '7.0.1', notes: 'fixes' }, update_available: true, can_update: true } };
      res.writeHead(!ok ? 401 : req.method === 'POST' ? 202 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out[req.url] ?? { state: 'updating' }));
    });
  }, 3406);
  solo = await startServer({ env: {
    ...dev, PORT: '3404', CILLCORD_HUB_URL: 'http://127.0.0.1:3402', CILLCORD_SETUP_CODE: 'solo-setup-code-99',
    CILLCORD_UPDATER_URL: 'http://127.0.0.1:3406', CILLCORD_UPDATER_SECRET: 'updater-secret',
  } });
  hubAdmin = await hub.register('hubroot');
  grant(hub, 'hubroot');
  const on = await hub.api('POST', '/users/@me/mfa/totp/enable', hubAdmin.token, { password: 'hunter2hunter2', secret: SECRET, code: totp() });
  hubBackup = on.body.backup_codes.map(c => c.code);
  alice = await hub.register('alice');
});
after(async () => {
  await Promise.all([hub.stop(), node.stop(), solo.stop()]);
  recorder.close();
  updaterService.close();
  nodeUpdater.close();
  pushService.close();
});

test('hub link codes: admins create them, users only when allowed and with 2FA, unknown and expired codes are refused', async () => {
  assert.equal((await hub.api('POST', '/admin/federation/link-codes', alice.token, {})).status, 403);
  const c = await hubCode();
  assert.match(c.code, /^CCL-[\w-]{24}$/);
  assert.equal(c.status, 'valid');
  assert.ok(Date.parse(c.expires_at) - Date.now() > 23.9 * 3600e3);
  const listed = (await hub.api('GET', '/admin/federation/link-codes', hubAdmin.token)).body;
  assert.ok(listed.some(x => x.id === c.id && !('code' in x)), 'the code itself is shown only once');
  // users: off by default; once allowed, 2FA is required
  assert.equal((await hub.api('POST', '/federation/link-codes', alice.token, {})).status, 403);
  assert.equal((await hub.api('PATCH', '/admin/federation', hubAdmin.token, { user_link_codes: true })).body.user_link_codes, true);
  assert.equal((await hub.api('POST', '/federation/link-codes', alice.token, {})).body.code, 60003);
  // linking: bad URL, unknown code, expired code
  const link = body => hub.api('POST', '/federation/link', null, { node_public_key: 'A'.repeat(43), ...body });
  for (const url of ['https://10.0.0.1', 'http://example.com', 'https://example.com/path', 'https://user:pw@example.com', 'https://example.com:8443']) {
    assert.equal((await link({ code: c.code, node_url: url })).status, 400, url);
  }
  assert.equal((await link({ code: 'CCL-nope', node_url: NODE })).body.errors.code._errors[0].code, 'FED_LINK_CODE_INVALID');
  const old = await hubCode();
  sql(hub, 'UPDATE fed_link_codes SET expires_at = 1 WHERE id = ?', old.id);
  const wk = (await (await fetch(`${NODE}/.well-known/cillhub`)).json());
  assert.equal((await link({ code: old.code, node_url: NODE, node_public_key: wk.public_key })).body.errors.code._errors[0].code, 'FED_LINK_CODE_INVALID');
  // a URL that does not serve the key it claims
  const other = await hubCode();
  assert.match((await link({ code: other.code, node_url: NODE })).body.message, /does not serve this public key/);
  // the key must be served at that exact URL: a redirect (even to another path on the same host) is not proof
  const redirector = await listen((req, res) => {
    if (req.url === '/.well-known/cillhub') { res.writeHead(302, { Location: '/.well-known/real' }); return res.end(); }
    if (req.url === '/.well-known/real') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ public_key: wk.public_key })); }
    res.writeHead(404); res.end();
  }, 3410);
  try {
    const bounced = await link({ code: (await hubCode()).code, node_url: 'http://127.0.0.1:3410', node_public_key: wk.public_key });
    assert.equal(bounced.status, 400);
    assert.match(bounced.body.message, /redirect/i);
  } finally { redirector.close(); }
});

test('first-run wizard on the node: setup code, first admin with mandatory 2FA, voice self-check, link with a code', async () => {
  assert.deepEqual((await node.api('GET', '/setup')).body, {
    required: true, role: 'node', version: 'dev', hub_url: HUB, mode_hint: null, updater: true, auto_update: 'off', auto_update_hour: 4,
    admin_created: false, admin_mfa_enabled: false,
  });
  assert.equal((await node.api('GET', '/server/version')).body.setup_required, true);
  assert.equal((await node.api('POST', '/setup/verify', null, { setup_code: 'wrong-code-123' })).status, 401);
  assert.equal((await node.api('POST', '/setup/verify', null, { setup_code: SETUP })).status, 204);
  assert.equal((await node.api('POST', '/auth/register', null, { email: 'x@example.com', username: 'early', password: 'hunter2hunter2' })).status, 403, 'no sign-ups before setup');
  const admin = await node.api('POST', '/setup/admin', null, { setup_code: SETUP, email: 'admin@node.example', username: 'nodeadmin', password: 'hunter2hunter2' });
  assert.equal(admin.status, 201);
  nodeAdmin = { token: admin.body.token, id: admin.body.user_id };
  assert.equal((await node.api('POST', '/setup/admin', null, { setup_code: SETUP, email: 'b@node.example', username: 'second', password: 'hunter2hunter2' })).status, 400, 'once');
  const c = await hubCode();
  const finish = body => node.api('POST', '/setup/complete', nodeAdmin.token, { setup_code: SETUP, instance_name: 'Node One', registration_mode: 'open', mode: 'connected', link_code: c.code, ...body });
  assert.equal((await finish()).body.code, 60003, '2FA first');
  const nodeOn = await node.api('POST', '/users/@me/mfa/totp/enable', nodeAdmin.token, { password: 'hunter2hunter2', secret: SECRET, code: totp() });
  assert.equal(nodeOn.status, 200);
  nodeBackup = nodeOn.body.backup_codes.map(c => c.code);

  // voice self-check: the UDP port answers a plain STUN Binding request while the check runs
  const vc = (await node.api('POST', '/setup/voice-check', null, { setup_code: SETUP })).body;
  assert.deepEqual([vc.configured, vc.cillvoice.stun_url, vc.cillvoice.listening], [['cillvoice'], 'stun:127.0.0.1:3403', true]);
  const sock = dgram.createSocket('udp4');
  const req = Buffer.alloc(20);
  req.writeUInt16BE(0x0001, 0);
  req.writeUInt32BE(0x2112a442, 4);
  randomBytes(12).copy(req, 8);
  const answer = await new Promise(resolve => { sock.once('message', resolve); sock.send(req, 3403, '127.0.0.1'); });
  sock.close();
  assert.equal(answer.readUInt16BE(0), 0x0101, 'Binding success');

  assert.equal((await finish({ mode: 'sideways' })).status, 400);
  assert.equal((await finish({ auto_update: 'sometimes' })).status, 400);
  assert.equal((await finish({ auto_update_hour: 24 })).status, 400);
  const done = await finish({ auto_update: 'patch', auto_update_hour: 3 });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual([done.body.completed, done.body.instance.name, done.body.federation.mode, done.body.federation.status, done.body.federation.hub_status], [true, 'Node One', 'connected', 'active', 'linked']);
  const inst = (await node.api('GET', '/instance')).body;
  assert.deepEqual([inst.setup_pending, inst.federation], [false, { role: 'node', mode: 'connected', hub_url: HUB }]);
  assert.deepEqual((await hub.api('GET', '/instance')).body.federation, { role: 'hub', mode: null, hub_url: null });
  nodeId = done.body.federation.node_id;
  assert.match(nodeId, /^\d+$/);
  // setup is gone for good
  assert.equal((await node.api('GET', '/setup')).body.required, false);
  assert.equal((await node.api('POST', '/setup/admin', null, { setup_code: SETUP, email: 'c@node.example', username: 'third', password: 'hunter2hunter2' })).status, 404);
  assert.equal((await node.api('GET', '/server/version')).body.mode, 'connected');
  // the code is spent
  const wk = await (await fetch(`${NODE}/.well-known/cillhub`)).json();
  assert.deepEqual(await (await fetch(`${NODE}/.well-known/cillcord`)).json(), wk); // the old path is served too
  assert.deepEqual([wk.role, wk.mode, wk.node_id], ['node', 'connected', nodeId]);
  assert.equal((await hub.api('POST', '/federation/link', null, { code: c.code, node_url: NODE, node_public_key: wk.public_key })).status, 400);
  // the hub's record, refreshed by the heartbeat
  const n = (await hub.api('GET', `/admin/federation/nodes/${nodeId}`, hubAdmin.token)).body;
  assert.deepEqual([n.name, n.url, n.status, n.online, n.mode, n.link_codes[0].status], ['Node One', NODE, 'active', true, 'connected', 'used']);
  assert.ok(n.audit_log.length === 0 || n.audit_log.every(e => e.target_id === nodeId));
});

test('signed hub calls: a valid signature is accepted once; tampered, unsigned, foreign-key and replayed calls are refused', async () => {
  const key = createPrivateKey(readFileSync(join(node.dataDir, 'federation.key')));
  const path = '/api/v9/federation/heartbeat';
  const body = JSON.stringify({ name: 'Node One', servers: [] });
  const post = (headers, b = body) => fetch(HUB + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: b });
  const h = signRequest(key, nodeId, 'POST', path, body);
  assert.equal((await post({})).status, 401);
  assert.equal((await post(h, body.replace('One', 'Two'))).status, 401);
  assert.equal((await post(signRequest(createPrivateKey(readFileSync(join(solo.dataDir, 'federation.key'))), nodeId, 'POST', path, body))).status, 401);
  assert.equal((await post(signRequest(key, nodeId, 'POST', path, body, Date.now() - 400_000))).status, 401);
  assert.equal((await post(h)).status, 200);
  const again = await post(h);
  assert.equal(again.status, 401);
  assert.match((await again.json()).message, /replayed/);
  // the node checks the hub's signature the same way, against the network key only
  const event = (k, b = '{"type":"status","status":"banned"}') => fetch(`${NODE}/api/v9/federation/hub/events`, { method: 'POST', headers: signRequest(k, 'hub', 'POST', '/api/v9/federation/hub/events', b), body: b });
  assert.equal((await event(key)).status, 401);
  assert.equal((await event(otherKey)).status, 401);
  // the signature covers the target node: a hub event for another node is not applied here, even inside the time window
  const foreign = JSON.stringify({ type: 'user_update', node_id: '999', user: { id: '1', username: 'stolen' } });
  assert.equal((await event(hubKey, foreign)).status, 401);
  const ours = JSON.stringify({ type: 'user_update', node_id: nodeId, user: { id: '1' } });
  assert.equal((await event(hubKey, ours)).status, 204);
  // the hub signs its answers to calls that bring a challenge; others get none
  const answer = await fetch(HUB + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Cillhub-Challenge': 'abcdefghijklmnop' }, body });
  assert.equal(answer.status, 401);
  assert.match(answer.headers.get('cillhub-response-signature') ?? '', /^created=\d+, signature="[\w-]{86}"$/);
  assert.equal((await fetch(HUB + path, { method: 'POST', body })).headers.get('cillhub-response-signature'), null);
});

test('the hub role needs the network key: another key or env alone starts a node; nodes refuse a hub signing with another key', async () => {
  // CILLCORD_ROLE=hub with a key that is not the network key
  const wrong = await startServer({ env: { ...dev, CILLCORD_ROLE: 'hub' } });
  // the network key, but not a test run: CILLCORD_TEST_HUB_KEY is ignored, so the pinned production key applies
  const prodlike = await startServer({ dataDir: await keyedDir(hubKey), env: { ...dev, NODE_ENV: 'production', CILLCORD_ROLE: 'hub' } });
  // a hub of its own (pins its own test key) and a fresh node that trusts our network key
  const other = await startServer({ dataDir: await keyedDir(otherKey), env: { ...dev, PORT: '3408', CILLCORD_ROLE: 'hub', CILLCORD_TEST_HUB_KEY: publicKeyText(otherKey) } });
  const fresh = await startServer({ env: { ...dev, PORT: '3409', CILLCORD_HUB_URL: 'http://127.0.0.1:3408', CILLCORD_SETUP_CODE: 'fresh-setup-code-1' } });
  try {
    for (const srv of [wrong, prodlike]) {
      const wk = await (await fetch(`${srv.origin}/.well-known/cillhub`)).json();
      assert.deepEqual([wk.role, wk.mode], ['node', 'standalone']);
      assert.equal((await srv.api('POST', '/federation/link', null, {})).status, 404, 'no hub routes');
      assert.equal((await srv.api('GET', '/server/releases/latest')).status, 404);
    }
    assert.equal((await (await fetch(`${other.origin}/.well-known/cillhub`)).json()).role, 'hub');
    // the other hub accepts the link, but its answer is not signed with the network key, so the node refuses it
    const root = await other.register('otherroot');
    grant(other, 'otherroot');
    await other.api('POST', '/users/@me/mfa/totp/enable', root.token, { password: 'hunter2hunter2', secret: SECRET, code: totp() });
    const code = (await other.api('POST', '/admin/federation/link-codes', root.token, {})).body.code;
    const admin = (await fresh.api('POST', '/setup/admin', null, { setup_code: 'fresh-setup-code-1', email: 'f@fresh.example', username: 'freshadmin', password: 'hunter2hunter2' })).body;
    await fresh.api('POST', '/users/@me/mfa/totp/enable', admin.token, { password: 'hunter2hunter2', secret: SECRET, code: totp() });
    const r = await fresh.api('POST', '/setup/complete', admin.token, { setup_code: 'fresh-setup-code-1', instance_name: 'Fresh', registration_mode: 'open', mode: 'connected', link_code: code });
    assert.equal(r.status, 400);
    assert.equal(r.body.errors.hub_url._errors[0].code, 'FED_HUB_UNREACHABLE');
    assert.match(r.body.errors.hub_url._errors[0].message, /not the network hub \(bad answer signature\)/);
    assert.deepEqual([(await fresh.api('GET', '/setup')).body.required, (await fresh.api('GET', '/server/version')).body.mode], [true, 'standalone']);
  } finally {
    await Promise.all([wrong.stop(), prodlike.stop(), other.stop(), fresh.stop()]);
  }
});

test('update reports reach the hub with the heartbeat; the hub admin can ask a node to update only when the node opted in', async () => {
  const u = (await node.api('GET', '/admin/updates', nodeAdmin.token)).body;
  assert.deepEqual([u.auto_update, u.auto_update_hour, u.remote_update, u.updater, u.reachable], ['patch', 3, false, true, true]);
  assert.equal((await node.api('PATCH', '/admin/updates', nodeAdmin.token, { remote_update: true })).body.remote_update, true);
  assert.equal((await node.api('PATCH', '/admin/updates', nodeAdmin.token, { auto_update: 'nightly' })).status, 400);
  assert.equal((await node.api('PATCH', '/admin/updates', nodeAdmin.token, { auto_update_hour: 2.5 })).status, 400);
  assert.equal((await node.api('PATCH', '/admin/updates', nodeAdmin.token, { remote_update: 'yes' })).status, 400);
  assert.equal((await node.api('PATCH', '/admin/updates', nodeAdmin.token, { auto_update: 'all', auto_update_hour: 5 })).body.auto_update, 'all');
  await node.api('POST', '/admin/federation/heartbeat', nodeAdmin.token);
  const report = (await hub.api('GET', `/admin/federation/nodes/${nodeId}`, hubAdmin.token)).body.update;
  assert.deepEqual([report.updater, report.auto_update, report.auto_update_hour, report.remote_update], [true, 'all', 5, true]);
  assert.deepEqual(report.last_result, { action: 'update', version: '7.0.1', state: 'done', rolled_back: false, error: null, at: '2026-11-05T04:03:00.000Z' });
  assert.ok((await hub.api('GET', '/admin/federation/nodes', hubAdmin.token)).body.find(n => n.node_id === nodeId).update.reported_at);

  const ask = code => hub.api('POST', `/admin/federation/nodes/${nodeId}/update`, hubAdmin.token, code ? { code } : {});
  assert.equal((await ask()).status, 401, '2FA per request');
  const before = nodeUpdaterCalls.length;
  const yes = (await ask(hubBackup.shift())).body;
  assert.deepEqual([yes.result.status, yes.result.accepted, yes.node.node_id], [202, true, nodeId]);
  assert.deepEqual(nodeUpdaterCalls.slice(before).filter(c => c.method === 'POST').map(c => [c.url, c.body]), [['/update', { version: '7.0.1', auto: true }]]);
  // automatic updates off on the node: the hub cannot push an update even with remote requests allowed
  await node.api('PATCH', '/admin/updates', nodeAdmin.token, { auto_update: 'off' });
  const off = (await ask(hubBackup.shift())).body.result;
  assert.deepEqual([off.status, off.accepted], [403, false]);
  await node.api('POST', '/admin/federation/heartbeat', nodeAdmin.token);
  assert.equal((await hub.api('GET', `/admin/federation/nodes/${nodeId}`, hubAdmin.token)).body.update.remote_update, false, 'reported as not allowed');
  await node.api('PATCH', '/admin/updates', nodeAdmin.token, { auto_update: 'all' });
  assert.equal((await node.api('PATCH', '/admin/updates', nodeAdmin.token, { remote_update: false })).body.remote_update, false);
  const no = (await ask(hubBackup.shift())).body.result;
  assert.deepEqual([no.status, no.accepted], [403, false]);
  assert.match(no.message, /turned off/);
  assert.equal(nodeUpdaterCalls.filter(c => c.method === 'POST').length, 1);
  await node.api('POST', '/admin/federation/heartbeat', nodeAdmin.token);
  assert.equal((await hub.api('GET', `/admin/federation/nodes/${nodeId}`, hubAdmin.token)).body.update.remote_update, false);
  const audit = (await hub.api('GET', `/admin/federation/nodes/${nodeId}`, hubAdmin.token)).body.audit_log;
  assert.equal(audit.filter(e => e.action === 'node.update_request').length, 3);
});

test('sign in on the node with a hub account: consent, PKCE, audience-bound ID token, linked account, profile updates', async () => {
  const info = await hub.api('GET', `/oauth2/authorize${consentQuery({})}`, alice.token);
  assert.deepEqual([info.body.node.name, info.body.node.node_id, info.body.user.username, info.body.scope], ['Node One', nodeId, 'alice', ['identify']]);
  assert.equal((await authorize(alice, { redirect_uri: 'https://evil.example/cb' })).status, 400);
  assert.equal((await authorize(alice, { code_challenge_method: 'plain' })).status, 400);
  assert.equal((await hub.api('GET', '/oauth2/authorize?client_id=123&scope=identify', alice.token)).status, 404, 'not a node: an unknown application');
  const methods = (await node.api('GET', '/auth/methods')).body;
  assert.deepEqual([methods.local, methods.hub, methods.hub_info.url, methods.hub_info.node_id], [true, true, HUB, nodeId]);

  const a = await authorize(alice);
  assert.ok(a.body.location.startsWith(`${CALLBACK}?code=`) && a.body.location.endsWith('&state=s1'));
  assert.equal(new URL((await authorize(alice, {}, false)).body.location).searchParams.get('error'), 'access_denied');
  // the node only sends tokens back to itself or its hub, and only answers its own sign-ins (state)
  assert.equal((await fetch(`${NODE}/api/v9/federation/hub-login?return_to=${encodeURIComponent('https://evil.example/cb')}`, { redirect: 'manual' })).status, 400);
  // Host / X-Forwarded-Proto are not a return target: the token may only go to this node's pinned URL or its hub
  assert.equal(await new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: 3401, path: `/api/v9/federation/hub-login?return_to=${encodeURIComponent('https://evil.example/steal')}`, headers: { Host: 'evil.example', 'X-Forwarded-Proto': 'https' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  }), 400, 'a spoofed Host cannot choose where the node token is sent');
  assert.equal((await authorize(alice, { redirect_uri: `${NODE}/own-callback` })).status, 400, 'only the federation callback');
  assert.equal((await authorize(alice, { redirect_uri: `${CALLBACK}/extra` })).status, 400);
  assert.equal((await authorize(alice, { redirect_uri: `${CALLBACK}?next=https://evil.example` })).status, 400);
  assert.equal((await fetch(`${a.body.location.replace('state=s1', 'state=forged')}`, { redirect: 'manual' })).status, 400);

  // CORS: a linked node answers cross-origin calls only for its hub
  assert.equal((await fetch(`${NODE}/api/v9/users/@me`, { method: 'OPTIONS', headers: { Origin: HUB } })).headers.get('access-control-allow-origin'), HUB);
  assert.equal((await fetch(`${HUB}/api/v9/users/@me`, { method: 'OPTIONS' })).headers.get('access-control-allow-origin'), '*');
  // the desktop app runs the hub's client from app://cillhub; other origins still only see the hub
  const corsFor = async origin => (await fetch(`${NODE}/api/v9/users/@me`, { method: 'OPTIONS', headers: { Origin: origin } })).headers;
  assert.equal((await corsFor('app://cillhub')).get('access-control-allow-origin'), 'app://cillhub');
  assert.equal((await corsFor('app://cillhub')).get('vary'), 'Origin');
  assert.equal((await corsFor('https://evil.example')).get('access-control-allow-origin'), HUB);
  assert.equal((await fetch(`${NODE}/api/v9/gateway`, { headers: { Origin: 'app://cillhub' } })).headers.get('access-control-allow-origin'), 'app://cillhub');
  assert.equal((await node.api('GET', '/gateway')).body.url, 'ws://127.0.0.1:3401/gateway');
  const s = await nodeSignIn(alice);
  assert.deepEqual([s.get('state'), s.get('node_id'), s.get('error')], ['mine', nodeId, null]);
  alice.node = s.get('token');
  const me = (await node.api('GET', '/users/@me', alice.node)).body;
  assert.equal(me.username, 'alice');
  const [row] = sql(node, 'SELECT home, hub_user_id, email FROM users WHERE id = ?', me.id);
  assert.deepEqual({ ...row }, { home: 'hub', hub_user_id: alice.id, email: `hub-${alice.id}@hub.invalid` });
  assert.equal((await node.api('POST', '/auth/login', null, { login: 'alice', password: 'hunter2hunter2' })).status, 401, 'the hub password never reaches the node');
  const again = await nodeSignIn(alice, `${NODE}/instances/callback`); // the node's own login page
  assert.equal((await node.api('GET', '/users/@me', again.get('token'))).body.id, me.id);
  // the hub pushes profile changes to nodes where the user has an account
  assert.equal((await hub.api('PATCH', '/users/@me', alice.token, { global_name: 'Alice from the hub' })).status, 200);
  await until(async () => (await node.api('GET', '/users/@me', alice.node)).body.global_name === 'Alice from the hub');
  // sign-in policy: hub only keeps local users (but not the admin) out
  await node.register('localbob');
  assert.equal((await node.api('PATCH', '/admin/federation', nodeAdmin.token, { sign_in: 'hub' })).body.sign_in, 'hub');
  assert.equal((await node.api('POST', '/auth/login', null, { login: 'localbob', password: 'hunter2hunter2' })).status, 403);
  assert.equal((await node.api('POST', '/auth/register', null, { email: 'c@example.com', username: 'carol', password: 'hunter2hunter2' })).status, 403);
  assert.equal((await node.api('POST', '/auth/login', null, { login: 'nodeadmin', password: 'hunter2hunter2' })).status, 200);
  assert.equal((await node.api('PATCH', '/admin/federation', nodeAdmin.token, { sign_in: 'local' })).body.sign_in, 'local');
  assert.equal((await nodeSignIn(alice)).get('error'), 'unavailable');
  await node.api('PATCH', '/admin/federation', nodeAdmin.token, { sign_in: 'both' });
});

let nodeGuild;
test('server directory: Manage Server lists hub and node servers, hub users browse and search, text is cleaned, node icons are proxied', async () => {
  nodeGuild = (await node.api('POST', '/guilds', nodeAdmin.token, { name: 'Node Esports' })).body;
  assert.equal((await node.api('PATCH', `/guilds/${nodeGuild.id}`, nodeAdmin.token, { icon: `data:image/png;base64,${png(16, 16).toString('base64')}`, description: 'Scrims ‮every\u0007 night <b>' })).status, 200);
  const list = body => node.api('PATCH', `/guilds/${nodeGuild.id}/discovery-metadata`, nodeAdmin.token, { listed: true, primary_category_id: 1, preferred_locale: 'en', keywords: ['CS2', 'Valorant'], ...body });
  assert.equal((await node.api('GET', `/guilds/${nodeGuild.id}/discovery-metadata`, nodeAdmin.token)).status, 404, 'never listed');
  assert.equal((await list({ primary_category_id: 99 })).status, 400);
  assert.equal((await list({ keywords: ['a', 'b', 'c', 'd', 'e', 'f'] })).status, 400);
  assert.equal((await node.api('PATCH', `/guilds/${nodeGuild.id}/discovery-metadata`, alice.node, { listed: true, primary_category_id: 1 })).status, 403, 'Manage Server only');
  const l = await list({});
  assert.equal(l.status, 200, JSON.stringify(l.body));
  assert.deepEqual([l.body.listed, l.body.primary_category_id, l.body.keywords, l.body.preferred_locale, l.body.hub_status, l.body.sync_error], [true, 1, ['cs2', 'valorant'], 'en', 'active', null]);

  const hubGuild = (await hub.api('POST', '/guilds', alice.token, { name: 'Hub Community' })).body;
  await hub.api('PATCH', `/guilds/${hubGuild.id}`, alice.token, { description: 'hello' });
  assert.equal((await hub.api('PATCH', `/guilds/${hubGuild.id}/discovery-metadata`, alice.token, { listed: true, primary_category_id: 3 })).status, 200);
  assert.equal((await hub.api('PATCH', `/guilds/${hubGuild.id}/discovery-metadata`, hubAdmin.token, { listed: true, primary_category_id: 3 })).status, 403, 'not a member');

  const all = (await hub.api('GET', '/discoverable-guilds', hubAdmin.token)).body;
  assert.deepEqual([all.total, all.limit, all.offset], [2, 24, 0]);
  const e = all.guilds.find(x => x.id === nodeGuild.id);
  assert.deepEqual([e.name, e.description, e.keywords, e.primary_category_id, e.preferred_locale, e.approximate_member_count, e.node.node_id, e.node.status, e.node.online],
    ['Node Esports', 'Scrims  every  night <b>', ['cs2', 'valorant'], 1, 'en', 1, nodeId, 'active', true]);
  assert.match(e.icon_url, /^\/external\//, 'node icons only through the media proxy');
  const icon = await fetch(HUB + e.icon_url);
  assert.deepEqual([icon.status, icon.headers.get('content-type')], [200, 'image/png']);
  const h = all.guilds.find(x => x.id === hubGuild.id);
  assert.deepEqual([h.node, h.description, h.approximate_member_count], [null, 'hello', 1]);
  assert.deepEqual((await hub.api('GET', '/discoverable-guilds?category_id=1', alice.token)).body.guilds.map(x => x.id), [nodeGuild.id]);
  assert.deepEqual((await hub.api('GET', '/discoverable-guilds?query=valorant', alice.token)).body.guilds.map(x => x.id), [nodeGuild.id]);
  assert.deepEqual((await hub.api('GET', '/discoverable-guilds?query=hello', alice.token)).body.guilds.map(x => x.id), [hubGuild.id]);
  assert.deepEqual((await hub.api('GET', '/discovery/categories', alice.token)).body[0], { id: 1, name: 'Esports', is_primary: true });
  assert.equal((await hub.api('GET', '/discoverable-guilds', null)).status, 401);
  assert.equal((await node.api('GET', '/discoverable-guilds', nodeAdmin.token)).status, 404, 'the directory lives on the hub');

  // Join Guild: a hub user joins the node server on the node, the hub admin the hub server; unlisted servers refuse
  const joined = await node.api('PUT', `/guilds/${nodeGuild.id}/members/@me`, alice.node);
  assert.deepEqual([joined.status, joined.body.id], [200, nodeGuild.id]);
  assert.equal((await node.api('PUT', `/guilds/${nodeGuild.id}/members/@me`, alice.node)).status, 204, 'already a member');
  assert.equal((await hub.api('PUT', `/guilds/${hubGuild.id}/members/@me`, hubAdmin.token)).status, 200);
  const unlisted = (await hub.api('POST', '/guilds', alice.token, { name: 'Private' })).body;
  assert.equal((await hub.api('PUT', `/guilds/${unlisted.id}/members/@me`, hubAdmin.token)).status, 404);

  // reports and moderation
  assert.equal((await hub.api('POST', `/discoverable-guilds/${nodeGuild.id}/report`, alice.token, { reason: 'It is spam' })).status, 201);
  assert.equal((await hub.api('POST', `/discoverable-guilds/${nodeGuild.id}/report`, alice.token, { reason: 'spam' })).status, 400, 'once per user');
  const [rep] = (await hub.api('GET', '/admin/directory?filter=reported', hubAdmin.token)).body;
  assert.deepEqual([rep.guild.id, rep.hidden, rep.reports[0].reason, rep.reports[0].note, rep.reports[0].reporter_id], [nodeGuild.id, false, 'other', 'It is spam', alice.id]);
  const hidden = await hub.api('PATCH', `/admin/directory/${nodeGuild.id}`, hubAdmin.token, { hidden: true, reason: 'spam' });
  assert.deepEqual([hidden.body.hidden, hidden.body.hidden_reason, hidden.body.reports], [true, 'spam', []]);
  assert.equal((await hub.api('GET', '/discoverable-guilds', alice.token)).body.total, 1);
  await node.api('POST', '/admin/federation/heartbeat', nodeAdmin.token);
  assert.equal((await hub.api('GET', '/discoverable-guilds', alice.token)).body.total, 1, 'a heartbeat does not un-hide');
  // unlisting and listing again must not clear a hub hide
  assert.equal((await node.api('PATCH', `/guilds/${nodeGuild.id}/discovery-metadata`, nodeAdmin.token, { listed: false })).status, 200);
  const relisted = await node.api('PATCH', `/guilds/${nodeGuild.id}/discovery-metadata`, nodeAdmin.token, { listed: true, primary_category_id: 1, preferred_locale: 'en', keywords: ['CS2', 'Valorant'] });
  assert.equal(relisted.status, 200, JSON.stringify(relisted.body));
  assert.equal(relisted.body.hidden, true, 'a hide survives unlist and relist');
  assert.equal((await hub.api('GET', '/discoverable-guilds', alice.token)).body.guilds.some(x => x.id === nodeGuild.id), false);
  assert.equal((await hub.api('PATCH', `/admin/directory/${nodeGuild.id}`, hubAdmin.token, { hidden: false })).body.hidden, false);
  assert.equal((await hub.api('GET', '/discoverable-guilds', alice.token)).body.total, 2);
  // the same for a hub server: the owner cannot clear a hide by unlisting
  assert.equal((await hub.api('PATCH', `/admin/directory/${hubGuild.id}`, hubAdmin.token, { hidden: true, reason: 'review' })).body.hidden, true);
  assert.equal((await hub.api('PATCH', `/guilds/${hubGuild.id}/discovery-metadata`, alice.token, { listed: false })).status, 200);
  const hubAgain = await hub.api('PATCH', `/guilds/${hubGuild.id}/discovery-metadata`, alice.token, { listed: true, primary_category_id: 3 });
  assert.equal(hubAgain.body.hidden, true);
  assert.equal((await hub.api('GET', '/discoverable-guilds?query=hello', alice.token)).body.guilds.length, 0);
  assert.equal((await hub.api('PATCH', `/admin/directory/${hubGuild.id}`, hubAdmin.token, { hidden: false })).body.hidden, false);
  assert.equal((await hub.api('POST', `/discoverable-guilds/${hubGuild.id}/report`, hubAdmin.token, { reason: 'other' })).status, 201);
  assert.equal((await hub.api('DELETE', `/admin/directory/${hubGuild.id}/reports`, hubAdmin.token)).status, 204);
  assert.deepEqual((await hub.api('GET', '/admin/directory?filter=reported', hubAdmin.token)).body, []);
  assert.equal((await hub.api('GET', '/admin/directory', alice.token)).status, 403);
});

test('NOTIFY: a mention on the node reaches the hub user through the hub\'s Web Push', async () => {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const sub = { endpoint: 'http://127.0.0.1:3405/push/alice', keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
  assert.equal((await hub.api('POST', '/users/@me/push-subscriptions', alice.token, sub)).status, 204);
  const me = (await node.api('GET', '/users/@me', alice.node)).body;
  const general = nodeGuild.channels.find(c => c.name === 'general');
  await node.api('POST', `/channels/${general.id}/messages`, nodeAdmin.token, { content: `<@${me.id}> scrim at 8` });
  await until(() => pushed.includes('/push/alice'));
  // a node cannot notify hub users that never signed in there
  const key = createPrivateKey(readFileSync(join(node.dataDir, 'federation.key')));
  const body = JSON.stringify({ user_id: hubAdmin.id, title: 'x', body: 'y' });
  const r = await fetch(`${HUB}/api/v9/federation/notify`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...signRequest(key, nodeId, 'POST', '/api/v9/federation/notify', body) }, body });
  assert.equal(r.status, 404);
});

test('suspend: the node\'s servers leave the directory and hub sign-in stops; unsuspend restores both', async () => {
  const s = await hub.api('POST', `/admin/federation/nodes/${nodeId}/suspend`, hubAdmin.token, { reason: 'test' });
  assert.equal(s.body.status, 'suspended');
  await until(async () => (await node.api('GET', '/admin/federation', nodeAdmin.token)).body.status === 'suspended');
  assert.deepEqual((await hub.api('GET', '/discoverable-guilds', alice.token)).body.guilds.map(x => x.node), [null]);
  assert.equal((await authorize(alice)).status, 400, 'no consent for a suspended node');
  assert.equal((await node.api('GET', '/auth/methods')).body.hub, false);
  assert.equal((await nodeSignIn(alice)).get('error'), 'unavailable');
  assert.equal((await node.api('GET', '/users/@me', alice.node)).status, 401, 'sessions of hub accounts ended');
  assert.equal((await node.api('GET', '/users/@me', nodeAdmin.token)).status, 200, 'local accounts keep theirs');
  assert.equal((await hub.api('GET', '/federation/nodes', alice.token)).body.find(n => n.node_id === nodeId).status, 'suspended');
  assert.equal((await hub.api('POST', `/admin/federation/nodes/${nodeId}/unsuspend`, hubAdmin.token)).body.status, 'active');
  await until(async () => (await node.api('GET', '/admin/federation', nodeAdmin.token)).body.status === 'active');
  alice.node = (await nodeSignIn(alice)).get('token');
  assert.equal((await node.api('GET', '/users/@me', alice.node)).status, 200);
  assert.equal((await hub.api('GET', '/discoverable-guilds', alice.token)).body.total, 2);
  const audit = (await hub.api('GET', `/admin/federation/nodes/${nodeId}`, hubAdmin.token)).body.audit_log.map(x => x.action);
  assert.ok(audit.includes('node.suspend') && audit.includes('node.unsuspend'));
});

test('a suspension outlasts unlink and a new link code', async () => {
  assert.equal((await hub.api('POST', `/admin/federation/nodes/${nodeId}/suspend`, hubAdmin.token, { reason: 'review' })).body.status, 'suspended');
  await until(async () => (await node.api('GET', '/admin/federation', nodeAdmin.token)).body.status === 'suspended');
  const u = await node.api('POST', '/admin/federation/unlink', nodeAdmin.token, { code: nodeBackup.shift() });
  assert.equal(u.body.linked, false);
  const relink = await node.api('POST', '/admin/federation/link', nodeAdmin.token, { hub_url: HUB, link_code: (await hubCode()).code });
  assert.equal(relink.status, 200, JSON.stringify(relink.body));
  assert.equal(relink.body.status, 'suspended', 'a new link code does not lift a suspension');
  assert.equal((await hub.api('GET', `/admin/federation/nodes/${nodeId}`, hubAdmin.token)).body.status, 'suspended');
  assert.equal((await node.api('GET', '/auth/methods')).body.hub, false);
  assert.equal((await hub.api('GET', '/discoverable-guilds', alice.token)).body.guilds.some(g => g.node), false);
  assert.equal((await hub.api('POST', `/admin/federation/nodes/${nodeId}/unsuspend`, hubAdmin.token)).body.status, 'active');
  await until(async () => (await node.api('GET', '/admin/federation', nodeAdmin.token)).body.status === 'active');
});

test('unlink from the node, re-link with a new code, then a ban: refused for good', async () => {
  assert.equal((await node.api('POST', '/admin/federation/unlink', nodeAdmin.token)).status, 401, 'unlink needs 2FA');
  const u = await node.api('POST', '/admin/federation/unlink', nodeAdmin.token, { code: nodeBackup.shift() });
  assert.deepEqual([u.body.mode, u.body.linked, u.body.hub_status], ['standalone', false, 'unlinked']);
  assert.equal((await node.api('GET', '/users/@me', alice.node)).status, 401, 'the node ends hub sessions when it unlinks');
  assert.equal((await hub.api('GET', `/admin/federation/nodes/${nodeId}`, hubAdmin.token)).body.status, 'unlinked');
  assert.equal((await hub.api('GET', '/discoverable-guilds', alice.token)).body.total, 1);
  assert.equal((await node.api('GET', '/auth/methods')).body.hub, false);
  assert.equal((await node.api('PATCH', `/guilds/${nodeGuild.id}/discovery-metadata`, nodeAdmin.token, { listed: true, primary_category_id: 1 })).status, 400, 'standalone: no directory');
  // re-link keeps the node id ({hub_url, link_code} as the dashboard sends it)
  const relink = await node.api('POST', '/admin/federation/link', nodeAdmin.token, { hub_url: HUB, link_code: (await hubCode()).code });
  assert.deepEqual([relink.status, relink.body.node_id, relink.body.status], [200, nodeId, 'active']);
  assert.equal((await hub.api('POST', `/admin/federation/nodes/${nodeId}/ban`, hubAdmin.token, {})).status, 401, 'ban needs 2FA');
  assert.equal((await hub.api('POST', `/admin/federation/nodes/${nodeId}/ban`, hubAdmin.token, { code: hubBackup.shift(), reason: 'abuse' })).body.status, 'banned');
  await until(async () => (await node.api('GET', '/admin/federation', nodeAdmin.token)).body.status === 'banned');
  assert.equal((await hub.api('POST', `/admin/federation/nodes/${nodeId}/unsuspend`, hubAdmin.token)).status, 400);
  await node.api('POST', '/admin/federation/unlink', nodeAdmin.token, { code: nodeBackup.shift() });
  assert.equal((await hub.api('GET', `/admin/federation/nodes/${nodeId}`, hubAdmin.token)).body.status, 'banned', 'leaving does not lift a ban');
  const refused = await node.api('POST', '/admin/federation/link', nodeAdmin.token, { link_code: (await hubCode()).code });
  assert.deepEqual([refused.status, refused.body.message, refused.body.errors.link_code._errors[0].code], [400, 'The hub refused the link: This node is banned from the hub.', 'FED_LINK_REFUSED'], 'a banned node cannot link again');
});

test('a standalone node never contacts its configured hub', async () => {
  const code = 'solo-setup-code-99';
  const admin = (await solo.api('POST', '/setup/admin', null, { setup_code: code, email: 'a@solo.example', username: 'soloadmin', password: 'hunter2hunter2' })).body;
  const on = await solo.api('POST', '/users/@me/mfa/totp/enable', admin.token, { password: 'hunter2hunter2', secret: SECRET, code: totp() });
  soloAdmin = { token: admin.token, backup: on.body.backup_codes.map(c => c.code) };
  const done = await solo.api('POST', '/setup/complete', admin.token, { setup_code: code, instance_name: 'Solo', registration_mode: 'closed', mode: 'standalone' });
  assert.deepEqual([done.status, done.body.federation.mode], [200, 'standalone']);
  const g = (await solo.api('POST', '/guilds', admin.token, { name: 'Private' })).body;
  assert.equal((await solo.api('PATCH', `/guilds/${g.id}/discovery-metadata`, admin.token, { listed: true, primary_category_id: 2 })).status, 400);
  assert.equal((await solo.api('GET', '/auth/methods')).body.hub, false);
  assert.equal((await solo.api('POST', '/auth/register', null, { email: 'z@example.com', username: 'zed', password: 'hunter2hunter2' })).status, 403, 'closed');
  await solo.api('POST', '/channels/' + g.channels.find(c => c.type === 0).id + '/messages', admin.token, { content: 'hello' });
  await new Promise(r => setTimeout(r, 2500)); // past the first heartbeat slot
  assert.deepEqual(recorded, []);
});

test('hub release channel and node update API without an updater', async () => {
  assert.equal((await hub.api('GET', '/server/releases/latest')).status, 404);
  assert.equal((await hub.api('PUT', '/admin/federation/release', hubAdmin.token, { version: 'v7' })).status, 400);
  assert.equal((await hub.api('PUT', '/admin/federation/release', hubAdmin.token, { version: '7.0.0', notes: 'Hub network' })).status, 200);
  const latest = (await hub.api('GET', '/server/releases/latest')).body;
  assert.deepEqual([latest.version, latest.notes, latest.download_base], ['7.0.0', 'Hub network', `${HUB}/download/server/`]);
  assert.equal((await node.api('GET', '/server/releases/latest')).status, 404, 'nodes have no release channel');
  assert.deepEqual((await hub.api('GET', '/admin/updates', hubAdmin.token)).body, {
    updater: false, current_version: 'dev', auto_check: true, last_check: null, auto_update: 'off', auto_update_hour: 4, remote_update: false, last_auto: null,
  });
  assert.equal((await hub.api('POST', '/admin/updates/check', hubAdmin.token)).status, 400);
});

test('node updates go to the updater sidecar with the shared secret; apply and rollback need 2FA', async () => {
  const status = (await solo.api('GET', '/admin/updates', soloAdmin.token)).body;
  assert.deepEqual([status.updater, status.reachable, status.current_version, status.state, status.auto_check, status.last_check], [true, true, '7.0.0', 'idle', true, null]);
  const check = (await solo.api('POST', '/admin/updates/check', soloAdmin.token)).body;
  assert.deepEqual([check.update_available, check.latest.version, check.error], [true, '7.0.1', null]);
  assert.equal((await solo.api('GET', '/admin/updates', soloAdmin.token)).body.last_check.latest.version, '7.0.1');
  assert.equal((await solo.api('POST', '/admin/updates/apply', soloAdmin.token, { version: '7.0.1' })).status, 401);
  const applied = await solo.api('POST', '/admin/updates/apply', soloAdmin.token, { version: '7.0.1', code: soloAdmin.backup.shift() });
  assert.deepEqual([applied.status, applied.body.state], [200, 'updating']);
  assert.equal((await solo.api('PATCH', '/admin/updates', soloAdmin.token, { auto_check: false })).body.auto_check, false);
  assert.equal((await solo.api('POST', '/admin/updates/rollback', soloAdmin.token, { code: soloAdmin.backup.shift() })).status, 200);
  assert.deepEqual(updaterCalls.map(c => [c.method, c.url, c.auth, c.body]), [
    ['GET', '/status', 'Bearer updater-secret', ''], ['GET', '/check', 'Bearer updater-secret', ''], ['GET', '/status', 'Bearer updater-secret', ''],
    ['POST', '/update', 'Bearer updater-secret', { version: '7.0.1' }], ['GET', '/status', 'Bearer updater-secret', ''], ['POST', '/rollback', 'Bearer updater-secret', {}],
  ]);
  assert.equal((await solo.api('GET', '/admin/updates')).status, 401);
});

test('every new v7 admin route refuses non-admins and anonymous callers', async () => {
  const files = ['hub', 'node', 'directory', 'setup'].map(f => readFileSync(new URL(`../src/routes/${f}.js`, import.meta.url), 'utf8'));
  const routes = files.flatMap(src => [...src.matchAll(/\['(GET|POST|PUT|PATCH|DELETE)', '(\/admin[^']*)'/g)].map(m => [m[1], m[2].replace(/:\w+/g, '1')]));
  assert.ok(routes.length >= 20, `${routes.length} admin routes found`);
  for (const [method, path] of routes) {
    const body = method === 'GET' ? undefined : {};
    assert.equal((await hub.api(method, path, alice.token, body)).status, 403, `${method} ${path}`);
    assert.equal((await hub.api(method, path, null, body)).status, 401, `${method} ${path}`);
  }
});
