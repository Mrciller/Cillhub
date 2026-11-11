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
  R.setView({ user: () => undefined, interaction: () => undefined, consume: () => {}, voiceGuild: () => null })
  R.setHubIdentity(ME, 'hubsess')
  for (const n of ['70', '71']) (R.saveInstance({ id: n, name: n, url: `https://n${n}.example` }, 't'), R.setLive(n, { meId: n === '70' ? '42' : '43', status: 'ready' }))

  // a node naming hub ids (and the other node's) gets its own scoped copies, never the originals
  const m = R.admit('70', 'MESSAGE_CREATE', { id: MSG, channel_id: DM, guild_id: GUILD, author: { id: FRIEND }, mentions: [{ id: '42' }], content: `<@${FRIEND}>` })
  assert.deepEqual([m.id, m.channel_id, m.guild_id, m.author.id, m.mentions[0].id, m.content], [`70:${MSG}`, `70:${DM}`, `70:${GUILD}`, `70:${FRIEND}`, ME, `<@70:${FRIEND}>`])
  for (const p of [`/channels/${DM}/messages`, `/channels/${DM}/messages/${MSG}`, `/guilds/${GUILD}/members/@me`, `/users/${FRIEND}/profile`, `/users/${ME}/profile`])
    assert.equal(R.route(p), undefined, `${p} stays on the hub`)
  assert.equal(R.route(`/channels/70:${DM}/messages`), '70', 'the node owns its scoped ids')
  assert.equal(R.route(`/channels/71:${DM}/messages`), '71', 'and the other node its own')
  assert.equal(R.route(`/users/${ME}/profile?guild_id=70:${GUILD}`), '70', 'own profile in a node server goes to the node')
  assert.equal(R.outboundPath('70', `/channels/70:${DM}/messages/70:${MSG}`), `/channels/${DM}/messages/${MSG}`)

  const e = R.admitRest('70', { embeds: [{ thumbnail: { url: 'https://x.example/a.png', proxy_url: 'https://tracker.example/a.png' }, image: { proxy_url: '/external/1' } }] }).embeds[0]
  assert.deepEqual([e.thumbnail.proxy_url, e.thumbnail.url, e.image.proxy_url], [undefined, 'https://x.example/a.png', 'https://n70.example/external/1'], 'node media proxy only on its own origin')
  console.log('ok 0 - a linked node cannot take over hub ids (node ids in their own namespace)')
}
