// Ed25519 signature of a desktop installer (<installer>.sig next to it in the feed): scripts/publish.js makes it with the
// self-host release key, updater.js refuses an update without a valid one. It covers the version as well as the file, so
// an older signed installer cannot be served as a newer version (downgrade).
const crypto = require('crypto');
const fs = require('fs');

const parseKeys = (pem) => (String(pem).match(/-----BEGIN PUBLIC KEY-----[A-Za-z0-9+/=\s]+-----END PUBLIC KEY-----/g) ?? [])
  .map((p) => crypto.createPublicKey(p)).filter((k) => k.asymmetricKeyType === 'ed25519');

/** The signed bytes: "cillhub-desktop\n<version>\n<sha512 hex of the file>\n". */
async function message(file, version) {
  const h = crypto.createHash('sha512');
  for await (const c of fs.createReadStream(file)) h.update(c);
  return Buffer.from(`cillhub-desktop\n${version}\n${h.digest('hex')}\n`);
}

/** true when sig is a signature of (file, version) by one of the pinned keys in keysPem. */
async function verify(file, version, sig, keysPem) {
  const msg = await message(file, version);
  return parseKeys(keysPem).some((k) => crypto.verify(null, msg, k, sig));
}

module.exports = { message, verify, parseKeys };
