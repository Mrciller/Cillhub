import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, checkIntegrity, checkFingerprint, attr, ATTR, readXorAddress, build, handleBinding, crc32 } from '../src/media/stun.js';

const hex = s => Buffer.from(s.replace(/\s+/g, ''), 'hex');
const PASSWORD = 'VOkJxbRl1RmTxUk/WvJxBt';

// RFC 5769 section 2.1
const request = hex(`000100582112a442b7e7a701bc34d686fa87dfae802200105354554e207465737420636c69656e74
  002400046e0001ff80290008932ff9b151263b36000600096576746a3a68367659202020000800149aeaa70cbfd8cb56781ef2b5b2d3f249c1b571a2
  80280004e57a3bcf`);
// RFC 5769 section 2.2
const response = hex(`0101003c2112a442b7e7a701bc34d686fa87dfae8022000b7465737420766563746f7220002000080001a147e112a643
  000800142b91f599fd9e90c38c7489f92af9ba53f06be7d780280004c07d4c96`);

test('crc32 of "123456789"', () => assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926));

test('RFC 5769 sample request: integrity, fingerprint, username', () => {
  const m = parse(request);
  assert.equal(m.type, 1);
  assert.ok(checkIntegrity(m, PASSWORD));
  assert.ok(!checkIntegrity(m, PASSWORD + 'x'));
  assert.ok(checkFingerprint(m));
  assert.equal(attr(m, ATTR.USERNAME).toString(), 'evtj:h6vY');
});

test('RFC 5769 sample IPv4 response: integrity, fingerprint, mapped address', () => {
  const m = parse(response);
  assert.ok(checkIntegrity(m, PASSWORD) && checkFingerprint(m));
  assert.deepEqual(readXorAddress(attr(m, ATTR.XOR_MAPPED_ADDRESS), m.txid), { address: '192.0.2.1', port: 32853 });
});

test('build round-trips and a tampered byte fails both checks', () => {
  const txid = Buffer.alloc(12, 7);
  const b = build(0x0001, txid, [[ATTR.USERNAME, Buffer.from('srv:cli')], [ATTR.USE_CANDIDATE, Buffer.alloc(0)]], 'secret');
  assert.ok(checkIntegrity(parse(b), 'secret') && checkFingerprint(parse(b)));
  b[25] ^= 1;
  assert.ok(!checkIntegrity(parse(b), 'secret') && !checkFingerprint(parse(b)));
});

test('ICE-lite binding: success with XOR-MAPPED-ADDRESS; wrong password, unknown ufrag or no credentials are dropped, not answered', () => {
  const txid = Buffer.alloc(12, 3);
  const req = pwd => build(0x0001, txid, [[ATTR.USERNAME, Buffer.from('srv:cli')], [ATTR.USE_CANDIDATE, Buffer.alloc(0)]], pwd);
  const lookup = u => (u === 'srv' ? { pwd: 'serverpassword', remoteUfrag: 'cli' } : null);
  const rinfo = { address: '10.1.2.3', port: 5000 };
  const ok = handleBinding(req('serverpassword'), rinfo, lookup);
  assert.ok(ok.useCandidate);
  const r = parse(ok.response);
  assert.equal(r.type, 0x0101);
  assert.ok(checkIntegrity(r, 'serverpassword'));
  assert.deepEqual(readXorAddress(attr(r, ATTR.XOR_MAPPED_ADDRESS), r.txid), rinfo);
  assert.equal(handleBinding(req('wrong'), rinfo, lookup), null);
  assert.equal(handleBinding(req('serverpassword'), rinfo, () => null), null);
  assert.equal(handleBinding(build(0x0001, txid, []), rinfo, lookup), null);
});
