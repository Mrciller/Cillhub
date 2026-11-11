// No browser: the real src/instances/registry.ts under Node's type stripping (its Vite-only DEV self-check switched off).
// Regression for the 2026-11-09 audit H-01: a linked node names hub ids in a payload and must not take them over.
const assert = require('node:assert/strict')
const path = require('node:path')
const { registerHooks } = require('node:module')

const FILE = path.join(__dirname, '../src/instances/registry.ts')
registerHooks({
  load(url, ctx, next) {
    const r = next(url, ctx)
    return url.endsWith('/src/instances/registry.ts') ? { ...r, source: String(r.source).replace('import.meta.env.DEV', 'false') } : r
  },
})

exports.run = async () => {
  const mem = {}
  globalThis.localStorage = { getItem: (k) => mem[k] ?? null, setItem: (k, v) => void (mem[k] = String(v)), removeItem: (k) => void delete mem[k] }
  const R = await import(FILE)
  const DM = '1300000000000000001', GUILD = '1300000000000000002', FRIEND = '1300000000000000003', MSG = '1300000000000000004', ME = '1300000000000000009'
  R.setView({ channel: () => undefined, user: () => undefined, interaction: () => undefined, voiceGuild: () => null })
  R.setHubIdentity(ME, 'hubsess')
  R.hubSaw('READY', { user: { id: ME }, users: [{ id: FRIEND }], guilds: [{ id: GUILD, channels: [] }], private_channels: [{ id: DM }] })
  for (const n of ['evil', 'other']) (R.saveInstance({ id: n, name: n, url: `https://${n}.example` }, 't'), R.setLive(n, { meId: n === 'evil' ? '42' : '43', status: 'ready' }))
  assert.ok(R.admit('other', 'GUILD_CREATE', { id: '902', channels: [{ id: '901' }] })) // the other node's own server and channel
  assert.ok(R.admit('evil', 'GUILD_CREATE', { id: '779', channels: [{ id: '778' }] }))

  // a message in its own channel naming hub ids and the other node's channel: nothing of those is taken
  assert.ok(R.admit('evil', 'MESSAGE_CREATE', { id: '777', channel_id: '778', message_reference: { channel_id: DM, guild_id: GUILD, message_id: MSG }, author: { id: '42' }, mentions: [{ id: ME }] }))
  assert.equal(R.admit('evil', 'MESSAGE_CREATE', { id: '776', channel_id: '778', author: { id: FRIEND } }), null, 'a hub user as author is refused')
  for (const p of [`/channels/${DM}/messages`, `/channels/${DM}/messages/${MSG}`, `/guilds/${GUILD}/members/@me`, `/users/${FRIEND}/profile`, `/users/${ME}/profile`])
    assert.equal(R.route(p), undefined, `${p} stays on the hub`)
  assert.equal(R.nodeOf(GUILD), undefined, 'hub guild is not the node\'s')
  assert.equal(R.nodeOf('901'), 'other', 'first node keeps its ids')
  assert.equal(R.route('/channels/778/messages'), 'evil', 'the node still owns its own ids')
  assert.equal(R.route(`/users/${ME}/profile?guild_id=778`), 'evil', 'own profile in a node server goes to the node')

  const e = R.admitRest('evil', { embeds: [{ thumbnail: { url: 'https://x.example/a.png', proxy_url: 'https://tracker.example/a.png' }, image: { proxy_url: '/external/1' } }] }).embeds[0]
  assert.deepEqual([e.thumbnail.proxy_url, e.thumbnail.url, e.image.proxy_url], [undefined, 'https://x.example/a.png', 'https://evil.example/external/1'], 'node media proxy only on its own origin')

  // A hub server the node named before we joined it: the hub's GUILD_CREATE takes it back.
  assert.ok(R.admit('evil', 'GUILD_CREATE', { id: '555', channels: [] }))
  R.hubSaw('GUILD_CREATE', { id: '555', channels: [] })
  assert.equal(R.route('/guilds/555/channels'), undefined, 'hub wins')
  console.log('ok 0 - a linked node cannot take over hub ids (registry ownership)')
}
