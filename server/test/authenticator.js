import { generateKeyPairSync, sign, createHash, randomBytes } from 'node:crypto';

// Tiny CBOR encoder (ints, byte/text strings, maps) to build attestationObjects like an authenticator.
function cbor(v) {
  const head = (mt, n) => n < 24 ? Buffer.from([mt << 5 | n]) : n < 256 ? Buffer.from([mt << 5 | 24, n]) : Buffer.from([mt << 5 | 25, n >> 8, n & 255]);
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
}

export function authenticator(type, origin) {
  const { publicKey, privateKey } = type === 'rsa' ? generateKeyPairSync('rsa', { modulusLength: 2048 })
    : type === 'ec' ? generateKeyPairSync('ec', { namedCurve: 'P-256' }) : generateKeyPairSync('ed25519');
  const j = publicKey.export({ format: 'jwk' });
  const b = s => Buffer.from(s, 'base64url');
  const cose = type === 'ec' ? new Map([[1, 2], [3, -7], [-1, 1], [-2, b(j.x)], [-3, b(j.y)]])
    : type === 'rsa' ? new Map([[1, 3], [3, -257], [-1, b(j.n)], [-2, b(j.e)]])
    : new Map([[1, 1], [3, -8], [-1, 6], [-2, b(j.x)]]);
  const id = randomBytes(16);
  let count = 0;
  const authData = (rpId, extra = Buffer.alloc(0), flags = 0x05) => { // UP + UV
    const c = Buffer.alloc(4); c.writeUInt32BE(count++);
    return Buffer.concat([createHash('sha256').update(rpId).digest(), Buffer.from([flags]), c, extra]);
  };
  const clientData = (type, challenge, rpId) => Buffer.from(JSON.stringify({ type, challenge, origin })).toString('base64url');
  return {
    id: id.toString('base64url'),
    register(opts) {
      const len = Buffer.from([0, id.length]);
      const ad = authData(opts.rp.id, Buffer.concat([Buffer.alloc(16), len, id, cbor(cose)]), 0x45);
      return { id: id.toString('base64url'), response: { clientDataJSON: clientData('webauthn.create', opts.challenge, opts.rp.id), attestationObject: cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', ad]])).toString('base64url') } };
    },
    sign(opts, key = privateKey, flags, overrides = {}) {
      const ad = authData(opts.rpId, undefined, flags);
      if (overrides.counter !== undefined) ad.writeUInt32BE(overrides.counter, 33);
      const cd = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: opts.challenge, origin, ...overrides })).toString('base64url');
      const sig = sign(type === 'ed25519' ? null : 'sha256', Buffer.concat([ad, createHash('sha256').update(b(cd)).digest()]), key);
      return { id: id.toString('base64url'), response: { clientDataJSON: cd, authenticatorData: ad.toString('base64url'), signature: sig.toString('base64url') } };
    },
  };
}

