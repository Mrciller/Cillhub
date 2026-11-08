// TOTP secret generation (RFC 6238 / RFC 4648 base32) and the otpauth:// URI for authenticator apps.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** 20 random bytes as 32 base32 characters (CONTRACT-v4 / user docs: a 32-character secret). */
export function newSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(20))
  let bits = 0
  let value = 0
  let out = ''
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  return out
}
export const otpauthUri = (secret: string, account: string) =>
  `otpauth://totp/${encodeURIComponent(`Cillhub:${account}`)}?secret=${secret}&issuer=Cillhub&algorithm=SHA1&digits=6&period=30`
/** The secret in groups of four, as authenticator apps show it. */
export const grouped = (secret: string) => secret.match(/.{1,4}/g)!.join(' ')

if (import.meta.env.DEV) console.assert(/^[A-Z2-7]{32}$/.test(newSecret()), 'TOTP secret is 32 base32 characters')
