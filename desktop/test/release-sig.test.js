// The update signature check (H-5): only an installer signed for that version by a pinned key passes.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { message, verify } = require('../src/release-sig');

test('update signature: pinned key, same file, same version', async () => {
  const [pinned, other, evil] = [0, 1, 2].map(() => crypto.generateKeyPairSync('ed25519'));
  const pem = (k) => k.publicKey.export({ type: 'spki', format: 'pem' });
  const keys = pem(other) + pem(pinned);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sig-test-')), 'Cillhub-Setup-2.2.2.exe');
  fs.writeFileSync(file, 'installer bytes');
  const sig = crypto.sign(null, await message(file, '2.2.2'), pinned.privateKey);

  assert.equal(await verify(file, '2.2.2', sig, keys), true);
  assert.equal(await verify(file, '2.3.0', sig, keys), false, 'an old signed installer offered as a newer version');
  assert.equal(await verify(file, '2.2.2', crypto.sign(null, await message(file, '2.2.2'), evil.privateKey), keys), false);
  assert.equal(await verify(file, '2.2.2', sig, ''), false, 'no pinned keys');
  assert.equal(await verify(file, '2.2.2', sig, fs.readFileSync(path.join(__dirname, '../../selfhost/release-public-key.pem'), 'utf8')), false);
  fs.writeFileSync(file, 'installer bytes!');
  assert.equal(await verify(file, '2.2.2', sig, keys), false, 'tampered file');
});
