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
  const hubIds = new Set([DM, GUILD, FRIEND, ME])
  R.setHubHas((id) => hubIds.has(id))
  R.setHubIdentity(ME, 'hubsess')
  for (const n of ['evil', 'other']) (R.saveInstance({ id: n, name: n, url: `https://${n}.example` }, 't'), R.setLive(n, { meId: n === 'evil' ? '42' : '43', status: 'ready' }))
  R.inbound('other', { id: '900', channel_id: '901' }) // the other node's own message and channel

  R.inbound('evil', { id: '777', channel_id: '778', referenced: { channel_id: DM, guild_id: GUILD, message_id: MSG, other: '901' }, author: { id: FRIEND }, mentions: [{ id: ME }] })
  for (const p of [`/channels/${DM}/messages`, `/channels/${DM}/messages/${MSG}`, `/guilds/${GUILD}/members/@me`, `/users/${FRIEND}/profile`, `/users/${ME}/profile`])
    assert.equal(R.route(p), undefined, `${p} stays on the hub`)
  assert.equal(R.nodeOf(GUILD), undefined, 'hub guild is not the node\'s')
  assert.equal(R.nodeOf('901'), 'other', 'first node keeps its ids')
  assert.equal(R.route('/channels/778/messages'), 'evil', 'the node still owns its own ids')
  assert.equal(R.route(`/users/${ME}/profile?guild_id=778`), 'evil', 'own profile in a node server goes to the node')

  const e = R.inbound('evil', { embeds: [{ thumbnail: { url: 'https://x.example/a.png', proxy_url: 'https://tracker.example/a.png' }, image: { proxy_url: '/external/1' } }] }).embeds[0]
  assert.deepEqual([e.thumbnail.proxy_url, e.thumbnail.url, e.image.proxy_url], [undefined, 'https://x.example/a.png', 'https://evil.example/external/1'], 'node media proxy only on its own origin')

  // A hub server the node named before we joined it: the hub's GUILD_CREATE takes it back.
  R.inbound('evil', { id: '555' })
  R.hubTakes('555')
  assert.equal(R.route('/guilds/555/channels'), undefined, 'hub wins')
  console.log('ok 0 - a linked node cannot take over hub ids (registry ownership)')
}
