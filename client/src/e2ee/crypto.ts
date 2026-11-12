// Encrypted DMs, the primitives: P-256 ECDH, HKDF-SHA256, AES-256-GCM, SHA-256 through WebCrypto only. Every binary
// value is base64url without padding. No imports, so `npm test` (node, types stripped) checks it against the server's
// test vectors (scripts/e2ee-vectors.test.mjs); the Android client must produce the same bytes.

const subtle = globalThis.crypto.subtle
const EC = { name: 'ECDH', namedCurve: 'P-256' } as const
const enc = new TextEncoder()
const dec = new TextDecoder('utf-8', { fatal: true })
type Bytes = Uint8Array<ArrayBuffer>

export const b64 = (b: ArrayBuffer | Uint8Array) => {
  let s = ''
  for (const x of new Uint8Array(b)) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
/** Decodes canonical base64url; throws on anything else or on a length other than `len` (when given). */
export function unb64(s: unknown, len?: number): Bytes {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) throw new Error('bad base64url')
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  if ((len !== undefined && out.length !== len) || b64(out) !== s) throw new Error('bad base64url')
  return out
}
export const random = (n: number): Bytes => globalThis.crypto.getRandomValues(new Uint8Array(n))
const utf8 = (s: string): Bytes => enc.encode(s) as Bytes
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let i = 0
  for (const p of parts) (out.set(p, i), (i += p.length))
  return out
}

export async function hkdf(ikm: Bytes, salt: Bytes, info: string): Promise<Bytes> {
  const k = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: utf8(info) }, k, 256))
}
const aes = (key: Bytes, use: KeyUsage) => subtle.importKey('raw', key, 'AES-GCM', false, [use])
async function gcmEncrypt(key: Bytes, iv: Bytes, data: Bytes, aad?: Bytes): Promise<Bytes> {
  return new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, ...(aad && { additionalData: aad }) }, await aes(key, 'encrypt'), data))
}
async function gcmDecrypt(key: Bytes, iv: Bytes, data: Bytes, aad?: Bytes): Promise<Bytes> {
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv, ...(aad && { additionalData: aad }) }, await aes(key, 'decrypt'), data))
}
const sha256 = async (...parts: Uint8Array[]) => new Uint8Array(await subtle.digest('SHA-256', concat(...parts)))

// --- account key ------------------------------------------------------------------------------------------------------------
/** A non-extractable private key from PKCS8 (local storage keeps only this). */
export const importPrivate = (pkcs8: Bytes) => subtle.importKey('pkcs8', pkcs8, EC, false, ['deriveBits'])
const importPublic = (raw: string) => subtle.importKey('raw', unb64(raw, 65), EC, true, [])

/** A new account key: the private key extractable only here, to write the backup. */
export async function newAccountKey() {
  const pair = await subtle.generateKey(EC, true, ['deriveBits'])
  const pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey))
  return { priv: await importPrivate(pkcs8), pub: b64(await subtle.exportKey('raw', pair.publicKey)), pkcs8 }
}

// --- recovery key: 20 random bytes, shown as base32 in groups of 4 -------------------------------------------------------------
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
export function recoveryText(key: Uint8Array) {
  let bits = 0, value = 0, out = ''
  for (const byte of key) {
    value = ((value << 8) | byte) & 0xffff
    bits += 8
    while (bits >= 5) (out += BASE32[(value >>> (bits - 5)) & 31]), (bits -= 5)
  }
  if (bits) out += BASE32[(value << (5 - bits)) & 31]
  return out.match(/.{1,4}/g)!.join('-')
}
/** The 20 bytes from what the user typed (case, spaces and dashes do not matter), or null. */
export function parseRecovery(text: string): Bytes | null {
  const s = text.toUpperCase().replace(/[\s-]/g, '')
  if (!/^[A-Z2-7]{32}$/.test(s)) return null
  const out = new Uint8Array(20)
  let bits = 0, value = 0, i = 0
  for (const c of s) {
    value = ((value << 5) | BASE32.indexOf(c)) & 0xffff
    bits += 5
    if (bits >= 8) (out[i++] = (value >>> (bits - 8)) & 255), (bits -= 8)
  }
  return out
}
const backupKey = (recovery: Bytes, userId: string) => hkdf(recovery, utf8(userId), 'cillhub-e2ee-backup-v1')
export async function sealBackup(recovery: Bytes, userId: string, pkcs8: Bytes, n = random(12)) {
  return JSON.stringify({ v: 1, n: b64(n), c: b64(await gcmEncrypt(await backupKey(recovery, userId), n, pkcs8)) })
}
/** The PKCS8 private key in a backup; throws when the recovery key is wrong. */
export async function openBackup(recovery: Bytes, userId: string, backup: string): Promise<Bytes> {
  const o = JSON.parse(backup)
  if (o?.v !== 1) throw new Error('unknown backup version')
  return gcmDecrypt(await backupKey(recovery, userId), unb64(o.n, 12), unb64(o.c))
}

// --- channel key, wrapped per member (v2) ------------------------------------------------------------------------------------
// ikm = ECDH(eph, member) || ECDH(wrapper's account key, member): only someone holding `by`'s account key makes a wrap that opens
// with `by`'s public key, so a wrap inserted into the database by anyone else does not open.
const ecdh = async (priv: CryptoKey, pub: string) => new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: await importPublic(pub) }, priv, 256))
const wrapKey = (ikm: Bytes, channelId: string, epoch: number, userId: string, by: string) =>
  hkdf(ikm, utf8(channelId), `cillhub-e2ee-wrap-v2|${epoch}|${userId}|${by}`)
/** The channel key wrapped for one member by `by` (an ephemeral key per wrap unless a fixed one is given, for test vectors). */
export async function wrap(channelKey: Bytes, memberPub: string, channelId: string, epoch: number, userId: string, by: { id: string; priv: CryptoKey }, eph?: { priv: CryptoKey; pub: string }, n = random(12)) {
  if (!eph) {
    const pair = await subtle.generateKey(EC, false, ['deriveBits'])
    eph = { priv: pair.privateKey, pub: b64(await subtle.exportKey('raw', pair.publicKey)) }
  }
  const ikm = concat(await ecdh(eph.priv, memberPub), await ecdh(by.priv, memberPub))
  const wk = await wrapKey(ikm, channelId, epoch, userId, by.id)
  return JSON.stringify({ by: by.id, eph: eph.pub, n: b64(n), c: b64(await gcmEncrypt(wk, n, channelKey)) })
}
/** Who made a wrap (its `by`), or null for anything that is not a v2 wrap. */
export function wrapper(wrapped: string): string | null {
  try {
    const by = JSON.parse(wrapped)?.by
    return typeof by === 'string' && /^\d{1,20}$/.test(by) ? by : null
  } catch { return null }
}
/** Opens a wrap with this member's key and a candidate public key of its `by`; throws when that is not the key that made it. */
export async function unwrap(priv: CryptoKey, wrapped: string, channelId: string, epoch: number, userId: string, byPub: string): Promise<Bytes> {
  const o = JSON.parse(wrapped)
  const by = wrapper(wrapped)
  if (!by) throw new Error('not a v2 wrap')
  const ikm = concat(await ecdh(priv, o.eph), await ecdh(priv, byPub))
  const key = await gcmDecrypt(await wrapKey(ikm, channelId, epoch, userId, by), unb64(o.n, 12), unb64(o.c))
  if (key.length !== 32) throw new Error('bad channel key')
  return key
}

// --- messages ---------------------------------------------------------------------------------------------------------------
export type Envelope = { v: 1; e: number; n: string; c: string; kc: string }
export const messageKey = (channelKey: Bytes, nonce24: Bytes) => hkdf(channelKey, nonce24, 'cillhub-e2ee-msg-v1')
const aad = (channelId: string, authorId: string) => utf8(`${channelId}|${authorId}`)
export async function seal(channelKey: Bytes, channelId: string, authorId: string, epoch: number, plaintext: string, nonce = random(24)) {
  const mk = await messageKey(channelKey, nonce)
  const c = await gcmEncrypt(mk, nonce.slice(0, 12), utf8(plaintext), aad(channelId, authorId))
  const envelope: Envelope = { v: 1, e: epoch, n: b64(nonce), c: b64(c), kc: b64(await sha256(mk, nonce)) }
  return { envelope, mk }
}
/** The plaintext of an envelope, after checking the key commitment (a message that fails it could not be reported). */
export async function open(channelKey: Bytes, channelId: string, authorId: string, env: Envelope) {
  const nonce = unb64(env.n, 24)
  const mk = await messageKey(channelKey, nonce)
  if (b64(await sha256(mk, nonce)) !== env.kc) throw new Error('key commitment does not match')
  return { text: dec.decode(await gcmDecrypt(mk, nonce.slice(0, 12), unb64(env.c), aad(channelId, authorId))), mk }
}

// --- attachments: each file its own key ---------------------------------------------------------------------------------------
export async function encryptFile(data: Bytes, k = random(32), n = random(12)) {
  return { k: b64(k), n: b64(n), data: await gcmEncrypt(k, n, data) }
}
export const decryptFile = (data: Bytes, k: string, n: string) => gcmDecrypt(unb64(k, 32), unb64(n, 12), data)

/** 60 digits from SHA-256 of both raw public keys, sorted bytewise: the big-endian number mod 10^60, in groups of 5. */
export async function securityCode(a: string, b: string) {
  const [x, y] = [unb64(a, 65), unb64(b, 65)].sort((p, q) => {
    for (let i = 0; i < p.length; i++) if (p[i] !== q[i]) return p[i] - q[i]
    return 0
  })
  const hex = [...(await sha256(x, y))].map((v) => v.toString(16).padStart(2, '0')).join('')
  return (BigInt(`0x${hex}`) % 10n ** 60n).toString().padStart(60, '0').match(/.{5}/g)!.join(' ')
}
