// Encrypted DMs in this browser: the account key (non-extractable, in IndexedDB), channel keys in memory, decrypted
// messages in memory, pinned contact keys and the highest key epoch seen per DM in localStorage. DMs live on the hub
// only, so every call here goes to the hub.
import { useEffect, useSyncExternalStore } from 'react'
import { api, ApiError } from '../api'
import { t } from '../i18n'
import { apply, getState } from '../store'
import type { Channel, Message } from '../types'
import * as C from './crypto'
import { acceptMember, checkMembers, sendPlan, trustedMaker, type Memory } from './members'

export type FileRef = { id: string; k: string; n: string; name: string; type: string; size: number | null; w?: number; h?: number }
export type Plain = { state: 'ok'; content: string; files: FileRef[] } | { state: 'pending' | 'locked' | 'fail' }
// lost: the server has no key for this account, but this device still holds one (kept, never deleted on the server's word)
type Status = 'unknown' | 'off' | 'locked' | 'ready' | 'lost'
// unverified: this device holds a wrap of the current key that no current member provably made (or that does not open)
// stale: members whose current-epoch wrap is a tombstone (they reset their key): the epoch is renewed before sending
type Keys = { epoch: number; keys: Map<number, Uint8Array<ArrayBuffer>>; wrapped: string[]; stale: string[]; unverified: boolean }

let owner = '' // the account everything below belongs to
let status: Status = 'unknown'
let priv: CryptoKey | null = null
let myPub = ''
let loading: Promise<void> | null = null
const channels = new Map<string, Keys>()
const pubs = new Map<string, string | null>() // user id -> raw public key, null = none
const plains = new Map<string, Plain>()
const inflight = new Map<string, Promise<Plain>>()

let version = 0
const listeners = new Set<() => void>()
const changed = () => (version++, listeners.forEach((l) => l()))
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l))
/** Re-renders the caller whenever keys, statuses or decrypted messages change. */
export const useE2ee = () => useSyncExternalStore(subscribe, () => version)

// --- local key storage ----------------------------------------------------------------------------------------------------
function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('cillhub-e2ee', 1)
    open.onupgradeneeded = () => open.result.createObjectStore('keys')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const r = fn(open.result.transaction('keys', mode).objectStore('keys'))
      r.onsuccess = () => (resolve(r.result), open.result.close())
      r.onerror = () => (reject(r.error), open.result.close())
    }
  })
}
type Stored = { priv: CryptoKey; pub: string }
const loadLocal = (userId: string) => idb<Stored | undefined>('readonly', (s) => s.get(userId))
const saveLocal = (userId: string, v: Stored) => idb('readwrite', (s) => s.put(v, userId))
const dropLocal = (userId: string) => idb('readwrite', (s) => s.delete(userId))

// --- account --------------------------------------------------------------------------------------------------------------
const meId = () => getState().me?.id ?? ''
const notFound = (e: unknown) => e instanceof ApiError && e.status === 404
function forget() {
  status = 'unknown'; priv = null; myPub = ''; loading = null
  channels.clear(); pubs.clear(); plains.clear(); inflight.clear()
}
/** Loads this account's state once per sign-in (again after `refresh`). */
export function ready(): Promise<void> {
  if (owner !== meId()) (forget(), (owner = meId()))
  if (!owner) return Promise.resolve()
  return (loading ??= (async () => {
    const server = await api<{ public_key: string; backup: string }>('/users/@me/e2ee/keys').catch((e) => (notFound(e) ? null : Promise.reject(e)))
    let local = await loadLocal(owner).catch(() => undefined)
    if (server && local?.pub !== server.public_key) { // a reset whose answer got lost: the new key waits under :next
      const next = await loadLocal(`${owner}:next`).catch(() => undefined)
      if (next?.pub === server.public_key) await saveLocal(owner, (local = next))
    }
    if (!server) status = local ? 'lost' : 'off'
    else if (local && local.pub === server.public_key) (status = 'ready'), (priv = local.priv), (myPub = local.pub)
    else status = 'locked'
    changed()
  })().catch((e) => {
    loading = null
    throw e
  }))
}
export const useStatus = () => {
  useE2ee()
  useEffect(() => void ready().catch(() => {}), [])
  return status
}
const settle = (pub: string, key: CryptoKey) => {
  priv = key; myPub = pub; status = 'ready'
  channels.clear(); plains.clear(); inflight.clear()
  pubs.set(owner, pub)
  changed()
}

/** Turns encryption on (or resets it): a new account key, its backup, and the recovery key text to show once. */
export async function enable(): Promise<string> {
  await ready()
  const k = await C.newAccountKey()
  const recovery = C.random(20)
  const backup = await C.sealBackup(recovery, owner, k.pkcs8)
  // stored aside before the server knows it (never lost if the answer is), and in use only once the server took it,
  // so a failed reset leaves the old key working on this device
  await saveLocal(`${owner}:next`, { priv: k.priv, pub: k.pub })
  await api('/users/@me/e2ee/keys', { method: 'PUT', body: { public_key: k.pub, backup } })
  await saveLocal(owner, { priv: k.priv, pub: k.pub })
  await dropLocal(`${owner}:next`).catch(() => {})
  settle(k.pub, k.priv)
  return C.recoveryText(recovery)
}

/** A new device: the recovery key opens the backup; the private key must match the public key on the server. */
export async function recover(text: string) {
  await ready()
  const rk = C.parseRecovery(text)
  if (!rk) throw new Error(t('That is not a recovery key. It has 32 letters and digits.'))
  const server = await api<{ public_key: string; backup: string }>('/users/@me/e2ee/keys')
  let key: CryptoKey
  try {
    key = await C.importPrivate(await C.openBackup(rk, owner, server.backup))
    const probe = C.random(32)
    const back = await C.unwrap(key, await C.wrap(probe, server.public_key, 'probe', 1, owner, { id: owner, priv: key }), 'probe', 1, owner, server.public_key)
    if (C.b64(back) !== C.b64(probe)) throw new Error('mismatch')
  } catch {
    throw new Error(t('This recovery key does not match your account.'))
  }
  await saveLocal(owner, { priv: key, pub: server.public_key })
  settle(server.public_key, key)
}

export const myPublicKey = () => myPub

// --- contacts: public keys and pins -----------------------------------------------------------------------------------------
const PINS = () => `e2ee-pins:${owner}`
const store = <T,>(key: string, fallback: T): T => {
  try { return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback } catch { return fallback }
}
const keep = (key: string, v: unknown) => {
  try { localStorage.setItem(key, JSON.stringify(v)) } catch { /* private mode: nothing kept */ }
}
/** Every key pinned or accepted for a contact on this device, newest last (an old single-string pin reads as a list of one). */
function pinsOf(id: string): string[] {
  const v = store<Record<string, string | string[]>>(PINS(), {})[id]
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : typeof v === 'string' ? [v] : []
}
const pin = (id: string, pub: string) => keep(PINS(), { ...store(PINS(), {}), [id]: [...pinsOf(id).filter((x) => x !== pub), pub] })
/** Someone's public key, fresh from the server (pinned on first sight). */
async function publicKeyOf(id: string): Promise<string | null> {
  if (id === owner && myPub) return (pubs.set(id, myPub), myPub)
  const pub = await api<{ public_key: string }>(`/users/${id}/e2ee/keys`).then((r) => r.public_key, (e) => (notFound(e) ? null : Promise.reject(e)))
  pubs.set(id, pub)
  if (pub && !pinsOf(id).length) pin(id, pub)
  return pub
}
/** Members whose key differs from the newest one pinned or accepted here. */
export const keyChanged = (id: string) => {
  const p = pinsOf(id)
  return !!pubs.get(id) && !!p.length && p[p.length - 1] !== pubs.get(id)
}
let retries = 0 // bumped when keys change: messages that failed for want of a key are tried again
const soft = new Set<string>() // cache keys of those messages (no channel, no key for the epoch, network error)
function retrySoft() {
  for (const k of soft) plains.delete(k)
  soft.clear()
  retries++
}
/** Pins the member's current key; channel keys load again so wraps made with it open. */
export function acceptKey(id: string) {
  if (pubs.get(id)) pin(id, pubs.get(id)!)
  channels.clear()
  retrySoft()
  changed()
}
/** Refuses while a member's key differs from the newest one pinned here: nothing is wrapped for or opened with it. */
function refuseChanged(ch: Channel) {
  const id = members(ch).find((x) => x !== owner && keyChanged(x))
  if (id) throw new Error(t("{name}'s security key changed. Check it and accept it before you send.", { name: nameOf(ch, id) }))
}
/** The key to wrap for: this account's own, else the member's newest pinned key once the server shows no other (null: none). */
async function wrapPub(ch: Channel, id: string) {
  if (id === owner) return myPub
  if (!(await publicKeyOf(id))) return null // pinned here on first sight
  refuseChanged(ch)
  return pinsOf(id).at(-1) ?? null
}
export const publicKey = (id: string) => pubs.get(id)

const members = (ch: Channel) => [owner, ...(ch.recipients ?? []).map((u) => u.id).filter((id) => id !== owner)]
export const isDm = (ch?: Channel) => !!ch && !ch.guild_id && (ch.type === 1 || ch.type === 3)
export const isEncrypted = (ch?: Channel) => isDm(ch) && (ch!.e2ee_epoch ?? 0) > 0

// --- local memory: the members this device accepted per DM. The server's list alone never decides who gets the key
const MEMBERS = () => `e2ee-members:${owner}`
const memoryOf = (id: string): Memory | undefined => {
  const m = store<Record<string, Memory>>(MEMBERS(), {})[id]
  return Array.isArray(m?.ids) ? m : undefined
}
const keepMemory = (id: string, m: Memory) => keep(MEMBERS(), { ...store(MEMBERS(), {}), [id]: m })
/** The server's member list against the accepted one; stores it on first use (a 1:1 DM only with exactly one other member). */
function memberCheck(ch: Channel) {
  const r = checkMembers(ch.type, memoryOf(ch.id), members(ch).slice(1))
  if (r.next) keepMemory(ch.id, r.next)
  return r
}
/** Members the server lists in a group DM that this device has not accepted (nothing is wrapped for them until Accept). */
export const addedMembers = (ch: Channel) => (isEncrypted(ch) && ch.type === 3 && !!memoryOf(ch.id) ? memberCheck(ch).added : [])
/** Accepts a member added to a group DM; the next send makes a new key for everyone (theirs never opens older messages). */
export function acceptAdded(ch: Channel, id: string) {
  const mem = memoryOf(ch.id)
  if (mem) keepMemory(ch.id, acceptMember(mem, id, ch.e2ee_epoch ?? 0))
  channels.clear() // wraps they made open now
  retrySoft()
  changed()
}
/** Throws while the member list cannot be used to send: a 1:1 DM with other members than accepted, or unaccepted additions. */
function refuseMembers(ch: Channel) {
  const r = memberCheck(ch)
  if (r.bad) throw new Error(t('The key of this conversation could not be verified. Nothing was sent.'))
  if (r.added.length) throw new Error(t('{name} was added to this conversation. Accept to let them read what you send from now on.', { name: nameOf(ch, r.added[0]) }))
}

// --- local memory: the highest epoch this device saw per DM. A DM once seen encrypted never sends plain text from here again
const EPOCHS = () => `e2ee-epochs:${owner}`
const seenEpoch = (id: string) => store<Record<string, number>>(EPOCHS(), {})[id] ?? 0
const see = (id: string, epoch: number) => epoch > seenEpoch(id) && keep(EPOCHS(), { ...store(EPOCHS(), {}), [id]: epoch })
/** A user message without encryption in a DM this device saw encrypted (sent before, or put there by the server). */
export const plainInEncrypted = (ch: Channel | undefined, m: Message) =>
  isDm(ch) && !m.e2ee_envelope && (m.type === 0 || m.type === 19) && !m.author.system && !!owner && seenEpoch(ch!.id) > 0
/** The server reports a lower epoch (or none) for a DM this device saw encrypted: someone turned it back. */
const rolledBack = (ch: Channel) => !!owner && owner === meId() && seenEpoch(ch.id) > (ch.e2ee_epoch ?? 0)
/** The key of this DM cannot be trusted right now: turned back, a 1:1 DM whose members changed, or a current key no accepted
 * member provably made ('unverified': the user may renew it after comparing security codes). */
export function keyProblem(ch: Channel): 'rollback' | 'members' | 'unverified' | null {
  if (!isDm(ch)) return null
  if (rolledBack(ch)) return 'rollback'
  if (isEncrypted(ch) && status === 'ready' && memberCheck(ch).bad) return 'members'
  return channels.get(ch.id)?.unverified ? 'unverified' : null
}
const notSent = () => t('The key of this conversation could not be verified. Nothing was sent.')
const statusText = () => status === 'locked' ? t('Enter your recovery key to send messages here.') : status === 'lost' ? LOST_TEXT() : t('Set up encrypted messages to send messages here.')
export const LOST_TEXT = () => t('The server lost your encryption key data. Your key is still on this device and was not deleted.')
/** Why this device cannot send in a DM right now (shown in place of the message box), or null. */
export function sendHint(ch: Channel) {
  if (!isDm(ch)) return null
  const verify = t('The key of this conversation could not be verified.')
  if (rolledBack(ch)) return verify
  if (!isEncrypted(ch) || status === 'unknown') return null
  if (status !== 'ready') return statusText()
  try { refuseChanged(ch) } catch (e) { return (e as Error).message }
  if (keyProblem(ch) === 'members') return verify
  try { refuseMembers(ch) } catch (e) { return (e as Error).message }
  return keyProblem(ch) ? verify : null
}
const guard = (ch: Channel) => {
  if (isDm(ch) && rolledBack(ch)) throw new Error(notSent())
}
/** Throws when plain text must not go to this channel from here (it was encrypted before). Every plain send calls it. */
export async function refusePlain(ch?: Channel) {
  if (!ch || !isDm(ch)) return
  await ready().catch(() => {}) // sets the account the memory belongs to
  guard(getState().channels[ch.id] ?? ch)
}

/** Opening a DM: fresh member keys; a DM whose members all have keys is encrypted right away. */
export async function openChannel(ch: Channel) {
  await ready()
  if (!isDm(ch)) return
  if (rolledBack(ch)) return changed() // never set up again over an epoch this device saw: the warning shows instead
  see(ch.id, ch.e2ee_epoch ?? 0)
  await Promise.all(members(ch).map(publicKeyOf))
  const all = members(ch).every((id) => pubs.get(id)) && !(ch.recipients ?? []).some((u) => u.bot || u.system)
  if (status === 'ready' && all && !(ch.e2ee_epoch ?? 0)) await newEpoch(ch, 1).catch((e) => console.warn('encrypted DM: could not set up the key', e))
  else if (status === 'ready' && (ch.e2ee_epoch ?? 0)) await channelKeys(ch).catch(() => {}) // so a key that cannot be verified shows
  changed()
}

// --- channel keys -----------------------------------------------------------------------------------------------------------
async function channelKeys(ch: Channel, fresh = false): Promise<Keys> {
  const have = channels.get(ch.id)
  if (have && !fresh && have.epoch === (ch.e2ee_epoch ?? 0)) return have
  const r = await api<{ epoch: number; keys: { epoch: number; wrapped: string }[]; wrapped_users: string[]; stale_users?: string[] }>(`/channels/${ch.id}/e2ee/keys`)
  const keys = new Map(have?.keys)
  let unverified = false
  const mem = (memberCheck(ch), memoryOf(ch.id))
  for (const k of r.keys) {
    if (keys.has(k.epoch) || !priv || !k.wrapped) continue // '' = tombstone after this account's reset: no key for that epoch
    // a wrap counts only when this account or a member accepted on this device made it (older epochs: also one who left
    // since). A wrap made for an older account key (after a reset) does not open: those messages stay unreadable here.
    const by = C.wrapper(k.wrapped)
    const key = by && trustedMaker(mem, owner, by, k.epoch === r.epoch) ? await openWrap(k.wrapped, ch.id, k.epoch, by) : null
    if (key) keys.set(k.epoch, key)
    else if (k.epoch === r.epoch) unverified = true
  }
  const out = { epoch: r.epoch, keys, wrapped: r.wrapped_users, stale: r.stale_users ?? [], unverified }
  channels.set(ch.id, out)
  if (keys.size > (have?.keys.size ?? 0)) retrySoft()
  see(ch.id, r.epoch)
  if (r.epoch !== (ch.e2ee_epoch ?? 0)) apply('CHANNEL_UPDATE', { id: ch.id, e2ee_epoch: r.epoch })
  return out
}

/** A wrap opened with this account's key and a key of its maker: own key, then every key pinned for them (newest first), then the server's. */
async function openWrap(wrapped: string, channelId: string, epoch: number, by: string) {
  // the server's key counts only on first sight (publicKeyOf pins it then); once pinned, only pinned or accepted keys
  if (by !== owner && !pinsOf(by).length) await publicKeyOf(by).catch(() => null)
  const candidates = by === owner ? [myPub] : pinsOf(by).reverse()
  for (const pub of new Set(candidates)) {
    if (!pub) continue
    try { return await C.unwrap(priv!, wrapped, channelId, epoch, owner, pub) } catch { /* not this key */ }
  }
  return null
}

async function newEpoch(ch: Channel, epoch: number, retried = false): Promise<unknown> {
  refuseMembers(ch) // stores the list on the first key of a DM
  const ids = members(ch)
  const key = C.random(32)
  const wraps: Record<string, string> = {}
  for (const id of ids) {
    const pub = await wrapPub(ch, id)
    if (!pub) throw new Error(t('{name} has not set up encrypted messages.', { name: nameOf(ch, id) }))
    wraps[id] = await C.wrap(key, pub, ch.id, epoch, id, { id: owner, priv: priv! })
  }
  try {
    await api(`/channels/${ch.id}/e2ee/epoch`, { method: 'PUT', body: { epoch, wraps } })
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) return channelKeys({ ...ch, e2ee_epoch: epoch }, true) // someone else was first
    if (e instanceof ApiError && e.status === 400 && !retried) { // members changed (or one just set up a key): load them, try once more
      const fresh = await api<Channel>(`/channels/${ch.id}`)
      apply('CHANNEL_UPDATE', fresh)
      return newEpoch(getState().channels[ch.id] ?? fresh, epoch, true)
    }
    throw e
  }
  const prev = channels.get(ch.id)
  channels.set(ch.id, { epoch, keys: new Map(prev?.keys).set(epoch, key), wrapped: ids, stale: [], unverified: false })
  see(ch.id, epoch)
  apply('CHANNEL_UPDATE', { id: ch.id, e2ee_epoch: epoch })
}
const nameOf = (ch: Channel, id: string) => {
  const u = ch.recipients?.find((x) => x.id === id) ?? getState().users[id]
  return u?.global_name || u?.username || t('A member')
}

/** The key to send with, or null when the DM stays plain. Renews the key after a member left, wraps for new members. */
export async function sendKey(chIn: Channel, fresh = false): Promise<{ key: Uint8Array<ArrayBuffer>; epoch: number } | null> {
  if (!isDm(chIn)) return null
  await ready()
  let ch = getState().channels[chIn.id] ?? chIn
  guard(ch) // epoch 0 or lower than seen here: neither plain text nor that key
  see(ch.id, ch.e2ee_epoch ?? 0)
  if (!(ch.e2ee_epoch ?? 0)) {
    if (status !== 'ready') return null
    await openChannel(ch)
    ch = getState().channels[ch.id] ?? ch
    if (!(ch.e2ee_epoch ?? 0)) return (refuseChanged(ch), null)
  }
  if (status !== 'ready') throw new Error(statusText())
  refuseChanged(ch)
  refuseMembers(ch)
  let c = await channelKeys(ch, fresh)
  const ids = members(ch)
  const plan = sendPlan({ ...c, haveKey: c.keys.has(c.epoch) }, ids, memoryOf(ch.id)?.renew)
  if (plan === 'refuse') throw new Error(notSent())
  if (plan === 'renew') {
    await newEpoch(ch, c.epoch + 1)
    c = await channelKeys(getState().channels[ch.id] ?? ch)
  } else {
    const lacking = ids.filter((id) => !c.wrapped.includes(id))
    if (lacking.length) {
      const key = c.keys.get(c.epoch)!
      const wraps: Record<string, string> = {}
      for (const id of lacking) {
        const pub = await wrapPub(ch, id)
        if (pub) wraps[id] = await C.wrap(key, pub, ch.id, c.epoch, id, { id: owner, priv: priv! })
      }
      if (Object.keys(wraps).length) {
        const r = await api<{ wrapped_users: string[] }>(`/channels/${ch.id}/e2ee/wraps`, { method: 'PUT', body: { epoch: c.epoch, wraps } }).catch(() => null)
        if (r) c.wrapped = r.wrapped_users
      }
    }
  }
  const key = c.keys.get(c.epoch)
  if (!key) throw new Error(t('Cannot encrypt for this conversation right now. Try again.'))
  return { key, epoch: c.epoch }
}

/** The user compared security codes and renews the key of a DM whose current key could not be verified. */
export async function renewKey(ch: Channel) {
  await ready()
  if (status !== 'ready') throw new Error(statusText())
  ch = getState().channels[ch.id] ?? ch
  guard(ch)
  refuseChanged(ch)
  refuseMembers(ch)
  await newEpoch(ch, (await channelKeys(ch, true)).epoch + 1)
  changed()
}

/** Seals a payload for a channel with a send key. */
export const sealPayload = async (ch: Channel, k: { key: Uint8Array<ArrayBuffer>; epoch: number }, content: string, files: FileRef[] = []) =>
  (await C.seal(k.key, ch.id, owner, k.epoch, JSON.stringify({ content, files }))).envelope

// --- reading --------------------------------------------------------------------------------------------------------------
const cacheKey = (m: Message) => `${m.id}:${m.e2ee_envelope?.kc}`
/** Remembers what we just sent, so our own message shows without a decrypt round. */
export const remember = (m: Message, content: string, files: FileRef[]) => (plains.set(cacheKey(m), { state: 'ok', content, files }), changed())

function payload(text: string): Plain {
  const p = JSON.parse(text)
  const str = (v: unknown, max: number) => typeof v === 'string' && v.length <= max
  if (!p || typeof p !== 'object' || !str(p.content ?? '', 2000) || !Array.isArray(p.files ?? []) || (p.files ?? []).length > 10) return { state: 'fail' }
  const files: FileRef[] = []
  for (const f of p.files ?? []) {
    if (!str(f?.id, 20) || !str(f.k, 64) || !str(f.n, 32)) return { state: 'fail' }
    files.push({ id: f.id, k: f.k, n: f.n, name: str(f.name, 256) ? f.name : 'file', type: str(f.type, 128) ? f.type : '', size: Number.isSafeInteger(f.size) ? f.size : null,
      ...(Number.isSafeInteger(f.w) && Number.isSafeInteger(f.h) && { w: f.w, h: f.h }) })
  }
  return { state: 'ok', content: p.content ?? '', files }
}

/** Opens a message (cached per message and envelope). */
export function decrypt(m: Message): Promise<Plain> {
  const k = cacheKey(m)
  const hit = plains.get(k)
  if (hit && hit.state !== 'pending') return Promise.resolve(hit)
  let p = inflight.get(k)
  if (p) return p
  const noKey = { state: 'fail', soft: true } as const // shown as failed, tried again when keys change
  p = (async (): Promise<Plain & { soft?: true }> => {
    await ready()
    if (status === 'lost') return noKey
    if (status !== 'ready') return { state: 'locked' }
    const ch = getState().channels[m.channel_id]
    const env = m.e2ee_envelope!
    if (!ch) return noKey
    let keys = await channelKeys(ch)
    if (!keys.keys.has(env.e)) keys = await channelKeys(ch, true) // a key that arrived after we loaded
    const key = keys.keys.get(env.e)
    if (!key) return noKey
    try { return payload((await C.open(key, m.channel_id, m.author.id, env)).text) } catch { return { state: 'fail' } }
  })().catch(() => noKey).then(({ soft: isSoft, ...r }) => {
    inflight.delete(k)
    if (r.state !== 'locked') plains.set(k, r) // locked ones are tried again once the key is there
    if (isSoft) soft.add(k)
    else soft.delete(k)
    changed()
    return r as Plain
  })
  inflight.set(k, p)
  return p
}

/** The decrypted view of a message for rendering (null when it is not encrypted). */
export function usePlain(m?: Message | null): Plain | null {
  useE2ee()
  const env = m?.e2ee_envelope
  const k = m && env ? cacheKey(m) : ''
  useEffect(() => void (k && m && decrypt(m)), [k, status, retries]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!m || !env) return null
  return plains.get(k) ?? (status === 'locked' || status === 'off' ? { state: 'locked' } : { state: 'pending' })
}

/** The message keys a report reveals: the message itself and the given older ones that open here. */
export async function revealKeys(list: Message[]) {
  const out: { id: string; mk: string }[] = []
  for (const m of list) {
    const ch = getState().channels[m.channel_id]
    const key = ch && m.e2ee_envelope && (await channelKeys(ch)).keys.get(m.e2ee_envelope.e)
    if (!key) continue
    try { out.push({ id: m.id, mk: C.b64((await C.open(key, m.channel_id, m.author.id, m.e2ee_envelope!)).mk) }) } catch { /* not readable: not revealed */ }
  }
  return out
}

// --- files -----------------------------------------------------------------------------------------------------------------
const SAFE = /^(image\/(png|jpeg|gif|webp)|video\/(mp4|webm)|audio\/(mpeg|ogg|wav|webm|mp4|flac|x-m4a))$/
/** Only media types render from a blob URL (it has our origin); anything else is a download. */
export const safeType = (type: string) => (SAFE.test(type) ? type : 'application/octet-stream')
export async function encryptUpload(file: Blob, name: string, index: number) {
  const f = await C.encryptFile(new Uint8Array(await file.arrayBuffer()))
  const ref: FileRef = { id: String(index), k: f.k, n: f.n, name, type: file.type, size: file.size }
  return { ref, blob: new Blob([f.data], { type: 'application/octet-stream' }) }
}
export async function decryptDownload(url: string, f: { k: string; n: string; type: string }) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(t('Could not load the file.'))
  return new Blob([await C.decryptFile(new Uint8Array(await res.arrayBuffer()), f.k, f.n)], { type: safeType(f.type) })
}
