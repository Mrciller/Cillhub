// Encrypted DMs in this browser: the account key (non-extractable, in IndexedDB), channel keys in memory, decrypted
// messages in memory, pinned contact keys in localStorage. DMs live on the hub only, so every call here goes to the hub.
import { useEffect, useSyncExternalStore } from 'react'
import { api, ApiError } from '../api'
import { t } from '../i18n'
import { apply, getState } from '../store'
import type { Channel, Message } from '../types'
import * as C from './crypto'

export type FileRef = { id: string; k: string; n: string; name: string; type: string; size: number | null; w?: number; h?: number }
export type Plain = { state: 'ok'; content: string; files: FileRef[] } | { state: 'pending' | 'locked' | 'fail' }
type Status = 'unknown' | 'off' | 'locked' | 'ready'
type Keys = { epoch: number; keys: Map<number, Uint8Array<ArrayBuffer>>; wrapped: string[] }

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
    const local = await loadLocal(owner).catch(() => undefined)
    if (!server) {
      status = 'off'
      if (local) await dropLocal(owner).catch(() => {})
    } else if (local && local.pub === server.public_key) (status = 'ready'), (priv = local.priv), (myPub = local.pub)
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
  await saveLocal(owner, { priv: k.priv, pub: k.pub }) // stored before the server knows it, so a stored key is never lost
  await api('/users/@me/e2ee/keys', { method: 'PUT', body: { public_key: k.pub, backup } })
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
    const back = await C.unwrap(key, await C.wrap(probe, server.public_key, 'probe', 1, owner), 'probe', 1, owner)
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
function pins(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(PINS()) ?? '{}') ?? {} } catch { return {} }
}
const pin = (id: string, pub: string) => {
  try { localStorage.setItem(PINS(), JSON.stringify({ ...pins(), [id]: pub })) } catch { /* private mode: no pins */ }
}
/** Someone's public key, fresh from the server (pinned on first sight). */
async function publicKeyOf(id: string): Promise<string | null> {
  if (id === owner && myPub) return (pubs.set(id, myPub), myPub)
  const pub = await api<{ public_key: string }>(`/users/${id}/e2ee/keys`).then((r) => r.public_key, (e) => (notFound(e) ? null : Promise.reject(e)))
  pubs.set(id, pub)
  if (pub && !pins()[id]) pin(id, pub)
  return pub
}
/** Members whose key differs from the one first seen here. */
export const keyChanged = (id: string) => !!pubs.get(id) && !!pins()[id] && pins()[id] !== pubs.get(id)
export const acceptKey = (id: string) => (pubs.get(id) && pin(id, pubs.get(id)!), changed())
export const publicKey = (id: string) => pubs.get(id)

const members = (ch: Channel) => [owner, ...(ch.recipients ?? []).map((u) => u.id).filter((id) => id !== owner)]
export const isDm = (ch?: Channel) => !!ch && !ch.guild_id && (ch.type === 1 || ch.type === 3)
export const isEncrypted = (ch?: Channel) => isDm(ch) && (ch!.e2ee_epoch ?? 0) > 0

/** Opening a DM: fresh member keys; a DM whose members all have keys is encrypted right away. */
export async function openChannel(ch: Channel) {
  await ready()
  if (!isDm(ch)) return
  await Promise.all(members(ch).map(publicKeyOf))
  const all = members(ch).every((id) => pubs.get(id)) && !(ch.recipients ?? []).some((u) => u.bot || u.system)
  if (status === 'ready' && all && !(ch.e2ee_epoch ?? 0)) await newEpoch(ch, 1).catch((e) => console.warn('encrypted DM: could not set up the key', e))
  changed()
}

// --- channel keys -----------------------------------------------------------------------------------------------------------
async function channelKeys(ch: Channel, fresh = false): Promise<Keys> {
  const have = channels.get(ch.id)
  if (have && !fresh && have.epoch === (ch.e2ee_epoch ?? 0)) return have
  const r = await api<{ epoch: number; keys: { epoch: number; wrapped: string }[]; wrapped_users: string[] }>(`/channels/${ch.id}/e2ee/keys`)
  const keys = new Map(have?.keys)
  for (const k of r.keys) {
    if (keys.has(k.epoch) || !priv) continue
    // a wrap made for an older account key (after a reset) does not open: those messages stay unreadable here
    await C.unwrap(priv, k.wrapped, ch.id, k.epoch, owner).then((key) => keys.set(k.epoch, key), () => {})
  }
  const out = { epoch: r.epoch, keys, wrapped: r.wrapped_users }
  channels.set(ch.id, out)
  if (r.epoch !== (ch.e2ee_epoch ?? 0)) apply('CHANNEL_UPDATE', { id: ch.id, e2ee_epoch: r.epoch })
  return out
}

async function newEpoch(ch: Channel, epoch: number) {
  const ids = members(ch)
  const key = C.random(32)
  const wraps: Record<string, string> = {}
  for (const id of ids) {
    const pub = pubs.get(id) ?? (await publicKeyOf(id))
    if (!pub) throw new Error(t('{name} has not set up encrypted messages.', { name: nameOf(ch, id) }))
    wraps[id] = await C.wrap(key, pub, ch.id, epoch, id)
  }
  try {
    await api(`/channels/${ch.id}/e2ee/epoch`, { method: 'PUT', body: { epoch, wraps } })
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) return channelKeys({ ...ch, e2ee_epoch: epoch }, true) // someone else was first
    throw e
  }
  const prev = channels.get(ch.id)
  channels.set(ch.id, { epoch, keys: new Map(prev?.keys).set(epoch, key), wrapped: ids })
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
  if (!(ch.e2ee_epoch ?? 0)) {
    if (status !== 'ready') return null
    await openChannel(ch)
    ch = getState().channels[ch.id] ?? ch
    if (!(ch.e2ee_epoch ?? 0)) return null
  }
  if (status !== 'ready') throw new Error(status === 'locked' ? t('Enter your recovery key to send messages here.') : t('Set up encrypted messages to send messages here.'))
  let c = await channelKeys(ch, fresh)
  const ids = members(ch)
  if (c.wrapped.some((id) => !ids.includes(id)) || !c.keys.has(c.epoch)) {
    await newEpoch(ch, c.epoch + 1)
    c = await channelKeys(getState().channels[ch.id] ?? ch)
  } else {
    const lacking = ids.filter((id) => !c.wrapped.includes(id))
    if (lacking.length) {
      const key = c.keys.get(c.epoch)!
      const wraps: Record<string, string> = {}
      for (const id of lacking) {
        const pub = await publicKeyOf(id).catch(() => null)
        if (pub) wraps[id] = await C.wrap(key, pub, ch.id, c.epoch, id)
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
  p = (async (): Promise<Plain> => {
    await ready()
    if (status !== 'ready') return { state: 'locked' }
    const ch = getState().channels[m.channel_id]
    const env = m.e2ee_envelope!
    if (!ch) return { state: 'fail' }
    let keys = await channelKeys(ch)
    if (!keys.keys.has(env.e)) keys = await channelKeys(ch, true) // a key that arrived after we loaded
    const key = keys.keys.get(env.e)
    if (!key) return { state: 'fail' }
    try { return payload((await C.open(key, m.channel_id, m.author.id, env)).text) } catch { return { state: 'fail' } }
  })().catch((): Plain => ({ state: 'fail' })).then((r) => {
    inflight.delete(k)
    if (r.state !== 'locked') plains.set(k, r) // locked ones are tried again once the key is there
    changed()
    return r
  })
  inflight.set(k, p)
  return p
}

/** The decrypted view of a message for rendering (null when it is not encrypted). */
export function usePlain(m?: Message | null): Plain | null {
  useE2ee()
  const env = m?.e2ee_envelope
  const k = m && env ? cacheKey(m) : ''
  useEffect(() => void (k && m && decrypt(m)), [k, status]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!m || !env) return null
  return plains.get(k) ?? (status === 'locked' || status === 'off' ? { state: 'locked' } : { state: 'pending' })
}
export const plainOf = (m: Message) => plains.get(cacheKey(m))

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
