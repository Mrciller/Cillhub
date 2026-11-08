// STUN (RFC 5389) as far as ICE-lite needs it: parse a Binding request, check MESSAGE-INTEGRITY and FINGERPRINT,
// answer with XOR-MAPPED-ADDRESS (RFC 8445 section 7.3).
import { createHmac, timingSafeEqual } from 'node:crypto';

const MAGIC = 0x2112a442;
export const ATTR = { USERNAME: 0x0006, MESSAGE_INTEGRITY: 0x0008, ERROR_CODE: 0x0009, XOR_MAPPED_ADDRESS: 0x0020, PRIORITY: 0x0024, USE_CANDIDATE: 0x0025, FINGERPRINT: 0x8028, ICE_CONTROLLED: 0x8029, ICE_CONTROLLING: 0x802a };

const CRC_TABLE = Int32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
export function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

export const isStun = buf => buf.length >= 20 && buf[0] < 4 && buf.readUInt32BE(4) === MAGIC;

/** {type, txid, attrs: [{type, value, offset}], buf} or null when malformed. */
export function parse(buf) {
  if (!isStun(buf) || buf.readUInt16BE(2) + 20 !== buf.length) return null;
  const attrs = [];
  for (let o = 20; o + 4 <= buf.length;) {
    const type = buf.readUInt16BE(o), len = buf.readUInt16BE(o + 2);
    if (o + 4 + len > buf.length) return null;
    attrs.push({ type, value: buf.subarray(o + 4, o + 4 + len), offset: o });
    o += 4 + len + ((4 - (len % 4)) % 4);
  }
  return { type: buf.readUInt16BE(0), txid: buf.subarray(8, 20), attrs, buf };
}
export const attr = (msg, type) => msg.attrs.find(a => a.type === type)?.value;

// the hashed part: everything before the attribute, with the header length pretending the message ends right after it
function upTo(buf, offset, attrLen) {
  const part = Buffer.from(buf.subarray(0, offset));
  part.writeUInt16BE(offset - 20 + 4 + attrLen, 2);
  return part;
}

export function checkIntegrity(msg, password) {
  const a = msg.attrs.find(x => x.type === ATTR.MESSAGE_INTEGRITY);
  if (!a || a.value.length !== 20) return false;
  const mac = createHmac('sha1', password).update(upTo(msg.buf, a.offset, 20)).digest();
  return timingSafeEqual(mac, a.value);
}
export function checkFingerprint(msg) {
  const a = msg.attrs.find(x => x.type === ATTR.FINGERPRINT);
  return !!a && a.value.length === 4 && ((crc32(upTo(msg.buf, a.offset, 4)) ^ 0x5354554e) >>> 0) === a.value.readUInt32BE(0);
}

function tlv(type, value) {
  const b = Buffer.alloc(4 + value.length + ((4 - (value.length % 4)) % 4));
  b.writeUInt16BE(type, 0);
  b.writeUInt16BE(value.length, 2);
  value.copy(b, 4);
  return b;
}

/** A message with the given attributes, then MESSAGE-INTEGRITY (when password is set) and FINGERPRINT. */
export function build(type, txid, attrs, password) {
  let body = Buffer.concat([Buffer.alloc(20), ...attrs.map(([t, v]) => tlv(t, v))]);
  body.writeUInt16BE(type, 0);
  body.writeUInt32BE(MAGIC, 4);
  txid.copy(body, 8);
  if (password) {
    const mac = createHmac('sha1', password).update(upTo(body, body.length, 20)).digest();
    body = Buffer.concat([body, tlv(ATTR.MESSAGE_INTEGRITY, mac)]);
  }
  const fp = Buffer.alloc(4);
  fp.writeUInt32BE((crc32(upTo(body, body.length, 4)) ^ 0x5354554e) >>> 0);
  body = Buffer.concat([body, tlv(ATTR.FINGERPRINT, fp)]);
  body.writeUInt16BE(body.length - 20, 2);
  return body;
}

export function xorAddress(address, port, txid) {
  const v6 = address.includes(':');
  const b = Buffer.alloc(v6 ? 20 : 8);
  b[1] = v6 ? 2 : 1;
  b.writeUInt16BE(port ^ (MAGIC >>> 16), 2);
  const raw = v6 ? ipv6Bytes(address) : Buffer.from(address.split('.').map(Number));
  const key = Buffer.concat([Buffer.from([0x21, 0x12, 0xa4, 0x42]), txid]);
  for (let i = 0; i < raw.length; i++) b[4 + i] = raw[i] ^ key[i];
  return b;
}
function ipv6Bytes(a) {
  const [head, tail = ''] = a.split('::');
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
  const groups = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  return Buffer.from(groups.flatMap(g => [parseInt(g, 16) >> 8, parseInt(g, 16) & 0xff]));
}
export function readXorAddress(v, txid) {
  const key = Buffer.concat([Buffer.from([0x21, 0x12, 0xa4, 0x42]), txid]);
  const port = v.readUInt16BE(2) ^ (MAGIC >>> 16);
  const raw = [...v.subarray(4)].map((b, i) => b ^ key[i]);
  return { port, address: v[1] === 1 ? raw.join('.') : raw.reduce((s, b, i) => s + (i % 2 ? '' : i ? ':' : '') + b.toString(16).padStart(2, '0'), '') };
}

/**
 * ICE-lite answer to a Binding request. `lookup(localUfrag)` returns {pwd, remoteUfrag} or null.
 * Returns {response, username, useCandidate, ...} for a valid request, {response: 400/401 error} for a bad one, null to drop.
 */
export function handleBinding(buf, rinfo, lookup) {
  const msg = parse(buf);
  if (!msg || msg.type !== 0x0001) return null;
  if (attr(msg, ATTR.FINGERPRINT) && !checkFingerprint(msg)) return null;
  const user = attr(msg, ATTR.USERNAME)?.toString();
  const [local, remote] = (user ?? '').split(':');
  const cred = local && lookup(local);
  const error = code => ({ response: build(0x0111, msg.txid, [[ATTR.ERROR_CODE, Buffer.concat([Buffer.from([0, 0, code / 100, code % 100]), Buffer.from(code === 401 ? 'Unauthorized' : 'Bad Request')])]]) });
  if (!cred || (cred.remoteUfrag && remote !== cred.remoteUfrag)) return error(401);
  if (!checkIntegrity(msg, cred.pwd)) return error(401);
  return {
    response: build(0x0101, msg.txid, [[ATTR.XOR_MAPPED_ADDRESS, xorAddress(rinfo.address, rinfo.port, msg.txid)]], cred.pwd),
    localUfrag: local, useCandidate: !!attr(msg, ATTR.USE_CANDIDATE),
  };
}

/** A plain STUN server answer (RFC 5389 without credentials) to a Binding request that carries no USERNAME, else null. */
export function plainBinding(buf, rinfo) {
  const msg = parse(buf);
  if (!msg || msg.type !== 0x0001 || attr(msg, ATTR.USERNAME)) return null;
  return build(0x0101, msg.txid, [[ATTR.XOR_MAPPED_ADDRESS, xorAddress(rinfo.address, rinfo.port, msg.txid)]]);
}
