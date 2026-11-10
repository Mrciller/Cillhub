// CDN Range requests (206/416) and streamed multipart uploads with limits enforced while the body arrives.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startServer, guildWith, png, until } from './helpers.js';

let srv, api, g, alice;
before(async () => {
  srv = await startServer();
  api = srv.api;
  g = await guildWith(srv, ['alice', 'bob']);
  ({ alice } = g.users);
});
after(() => srv.stop());

const get = (path, headers = {}, method = 'GET') => fetch(srv.origin + path, { method, headers });
const MiB = 1024 * 1024;
// an "mp4": the ftyp box proves the type, the rest is random (and contains boundary-like bytes on purpose)
const mp4 = n => {
  const b = randomBytes(n);
  Buffer.from('\0\0\0\x18ftypisom', 'latin1').copy(b);
  for (let i = 1000; i + 8 < n; i += 65521) Buffer.from('\r\n--\r\n\r\n').copy(b, i);
  return b;
};

async function expectRange(path, size, bytes) {
  const full = await get(path);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.equal(Number(full.headers.get('content-length')), size);
  if (bytes) assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
  else await full.arrayBuffer();

  const part = await get(path, { Range: 'bytes=10-19' });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 10-19/${size}`);
  assert.equal(part.headers.get('content-length'), '10');
  assert.equal(part.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(part.headers.get('content-security-policy'), "default-src 'none'; sandbox");
  const body = Buffer.from(await part.arrayBuffer());
  if (bytes) assert.deepEqual(body, bytes.subarray(10, 20));

  const open = await get(path, { Range: `bytes=${size - 5}-` });
  assert.equal(open.status, 206);
  assert.equal(open.headers.get('content-range'), `bytes ${size - 5}-${size - 1}/${size}`);
  assert.equal((await open.arrayBuffer()).byteLength, 5);

  const suffix = await get(path, { Range: 'bytes=-4' });
  assert.equal(suffix.status, 206);
  assert.equal(suffix.headers.get('content-range'), `bytes ${size - 4}-${size - 1}/${size}`);
  if (bytes) assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), bytes.subarray(size - 4));
  else await suffix.arrayBuffer();

  const past = await get(path, { Range: 'bytes=0-999999999' }); // end past the file is cut to the last byte
  assert.equal(past.status, 206);
  assert.equal(past.headers.get('content-range'), `bytes 0-${size - 1}/${size}`);
  await past.arrayBuffer();

  for (const range of [`bytes=${size}-`, `bytes=${size + 100}-${size + 200}`, 'bytes=-0']) {
    const r = await get(path, { Range: range });
    assert.equal(r.status, 416, range);
    assert.equal(r.headers.get('content-range'), `bytes */${size}`);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    await r.arrayBuffer();
  }
  // malformed, reversed and multiple ranges are ignored (RFC 9110): the whole file
  for (const range of ['bytes=abc', 'bytes=20-10', 'bytes=0-1,5-6', 'items=0-1']) {
    const r = await get(path, { Range: range });
    assert.equal(r.status, 200, range);
    assert.equal((await r.arrayBuffer()).byteLength, size);
  }
  const head = await get(path, { Range: 'bytes=0-0' }, 'HEAD');
  assert.equal(head.status, 206);
  assert.equal(head.headers.get('content-range'), `bytes 0-0/${size}`);
}

test('Range on attachments: 206 with Content-Range, 416 when unsatisfiable, security headers kept; a 3 MiB video seeks', async () => {
  const video = mp4(3 * MiB + 7);
  const r = await srv.upload(g.general.id, alice.token, {}, [['clip.mp4', video, 'video/mp4']]);
  assert.equal(r.status, 201);
  const [a] = r.body.attachments;
  assert.deepEqual([a.content_type, a.size], ['video/mp4', video.length]);
  await expectRange(a.url, video.length, video);
  // a seek in the middle, as a video element asks for it
  const mid = await get(a.url, { Range: `bytes=${2 * MiB}-` });
  assert.equal(mid.status, 206);
  assert.equal(mid.headers.get('content-type'), 'video/mp4');
  assert.match(mid.headers.get('content-disposition'), /^inline/);
  assert.deepEqual(Buffer.from(await mid.arrayBuffer()), video.subarray(2 * MiB));
});

test('Range on avatars, guild icons, emoji, stickers and sounds', async () => {
  const image = Buffer.concat([png(4, 4), randomBytes(100)]);
  const uri = (type, b) => `data:${type};base64,${b.toString('base64')}`;
  const me = (await api('PATCH', '/users/@me', alice.token, { avatar: uri('image/png', image) })).body;
  await expectRange(`/avatars/${alice.id}/${me.avatar}`, image.length, image);
  const guild = (await api('PATCH', `/guilds/${g.guild.id}`, alice.token, { icon: uri('image/png', image) })).body;
  await expectRange(`/icons/${g.guild.id}/${guild.icon}.png`, image.length, image);
  const emoji = (await api('POST', `/guilds/${g.guild.id}/emojis`, alice.token, { name: 'ranged', image: uri('image/png', image) })).body;
  await expectRange(`/emojis/${emoji.id}.png`, image.length, image);
  const sticker = await srv.form('POST', `/guilds/${g.guild.id}/stickers`, alice.token, new Map([['name', 'ranged'], ['tags', 'x']]), [['file', 's.png', image, 'image/png']]);
  assert.equal(sticker.status, 201);
  await expectRange(`/stickers/${sticker.body.id}.png`, image.length, image);
  const mp3 = Buffer.concat(Array.from({ length: 20 }, () => Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(413)])));
  const sound = await api('POST', `/guilds/${g.guild.id}/soundboard-sounds`, alice.token, { name: 'ranged', sound: uri('audio/mpeg', mp3) });
  assert.equal(sound.status, 201);
  await expectRange(`/soundboard-sounds/${sound.body.sound_id}`, mp3.length, mp3);
});

// raw multipart over node:http so the body can be paced; resolves with {status, body}
function rawUpload(path, parts, { pauseAfter, onPause } = {}) {
  const boundary = `----cillhub${randomBytes(8).toString('hex')}`;
  return new Promise((resolve, reject) => {
    const req = request(srv.base + path, { method: 'POST', headers: { Authorization: alice.token, 'Content-Type': `multipart/form-data; boundary=${boundary}` } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c)).on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks) || 'null') }));
    });
    req.on('error', reject);
    (async () => {
      let sent = 0;
      for (const [name, value, filename, type] of parts) {
        req.write(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"${filename ? `; filename="${filename}"\r\nContent-Type: ${type}` : ''}\r\n\r\n`);
        // odd chunk sizes so boundaries and CRLFs straddle chunk edges
        for (let i = 0; i < value.length; i += 65537) {
          const chunk = value.subarray(i, i + 65537);
          if (!req.write(chunk)) await new Promise(r => req.once('drain', r));
          sent += chunk.length;
          if (pauseAfter && sent >= pauseAfter && onPause) {
            await onPause();
            onPause = null;
          }
        }
        req.write('\r\n');
      }
      req.end(`--${boundary}--\r\n`);
    })().catch(reject);
  });
}
const tmpFiles = async () => {
  const root = join(srv.dataDir, 'uploads-tmp');
  const out = [];
  for (const d of await readdir(root)) for (const f of await readdir(join(root, d)).catch(() => [])) out.push((await stat(join(root, d, f))).size);
  return out;
};

test('streamed uploads: files arrive byte-exact across chunk edges; temp files are removed afterwards', async () => {
  const a = mp4(MiB + 3), b = randomBytes(200 * 1024);
  const r = await rawUpload(`/channels/${g.general.id}/messages`, [
    ['payload_json', Buffer.from(JSON.stringify({ content: 'streamed', attachments: [{ id: 0, description: 'clip' }] }))],
    ['files[0]', a, 'one.mp4', 'video/mp4'],
    ['files[1]', b, 'two.bin', 'application/octet-stream'],
  ]);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.content, 'streamed');
  const [x, y] = r.body.attachments;
  assert.deepEqual([x.filename, x.content_type, x.size, x.description], ['one.mp4', 'video/mp4', a.length, 'clip']);
  assert.deepEqual(Buffer.from(await (await get(x.url)).arrayBuffer()), a);
  assert.deepEqual(Buffer.from(await (await get(y.url)).arrayBuffer()), b);
  assert.deepEqual(await tmpFiles(), []);
  // a malformed body (no closing boundary) is 400 and leaves nothing behind
  const boundary = 'xyz';
  const bad = await fetch(`${srv.base}/channels/${g.general.id}/messages`, {
    method: 'POST', headers: { Authorization: alice.token, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: `--${boundary}\r\nContent-Disposition: form-data; name="files[0]"; filename="a.txt"\r\n\r\nhello`,
  });
  assert.equal(bad.status, 400);
  assert.deepEqual(await tmpFiles(), []);
});

// a JPEG whose SOF0 frame header (width x height) sits behind `pad` bytes of APP1 segments
const jpeg = (pad, w, h) => {
  const parts = [Buffer.from([0xff, 0xd8])];
  for (let left = pad; left > 0; left -= 65533) { const n = Math.min(left, 65533); parts.push(Buffer.from([0xff, 0xe1, (n + 2) >> 8, (n + 2) & 0xff]), Buffer.alloc(n)); }
  parts.push(Buffer.from([0xff, 0xc0, 0, 17, 8, h >> 8, h & 0xff, w >> 8, w & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]));
  return Buffer.concat(parts);
};
test('JPEG sizing looks at most 1 MiB into the upload: a frame header behind 200 KiB of metadata is found, behind 1.5 MiB it is not', async () => {
  const r = await rawUpload(`/channels/${g.general.id}/messages`, [
    ['payload_json', Buffer.from(JSON.stringify({ content: 'jpegs' }))],
    ['files[0]', jpeg(200 * 1024, 640, 480), 'near.jpg', 'image/jpeg'],
    ['files[1]', jpeg(1536 * 1024, 640, 480), 'far.jpg', 'image/jpeg'],
  ]);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const [near, far] = r.body.attachments;
  assert.deepEqual([near.content_type, near.width, near.height], ['image/jpeg', 640, 480]);
  assert.deepEqual([far.content_type, far.width], ['image/jpeg', undefined]);
});

test('multipart part names count against the field limit, and the number of parts is capped (audit M10)', async () => {
  // refused mid-stream: the 413 may lose the race with the reset of the unread rest
  const names = await rawUpload(`/channels/${g.general.id}/messages`, Array.from({ length: 150 }, (_, i) => [`${'n'.repeat(8000)}${i}`, Buffer.alloc(0)])).catch(e => ({ status: e.code }));
  assert.ok([413, 'ECONNRESET', 'EPIPE'].includes(names.status), names.status);
  const many = await rawUpload(`/channels/${g.general.id}/messages`, Array.from({ length: 201 }, (_, i) => [`f${i}`, Buffer.from('x')])).catch(e => ({ status: e.code }));
  assert.ok(['ECONNRESET', 'EPIPE'].includes(many.status) || many.body?.message === 'At most 200 form parts.', JSON.stringify(many));
  assert.deepEqual(await tmpFiles(), []);
});

test('streamed uploads: a file over 25 MiB stops being written at the limit mid-stream and answers 413; a sticker over 512 KiB 400', async () => {
  const big = randomBytes(26 * MiB);
  const stored = () => readdir(join(srv.dataDir, 'attachments', g.general.id));
  const before = (await stored()).length;
  let during;
  const r = await rawUpload(`/channels/${g.general.id}/messages`, [
    ['payload_json', Buffer.from('{}')], ['files[0]', big, 'big.bin', 'application/octet-stream'],
  ], {
    pauseAfter: 25.5 * MiB,
    // halfway past the limit: the temp file holds exactly 25 MiB, nothing more
    onPause: () => until(async () => (during = await tmpFiles()).length === 1 && during[0] === 25 * MiB, 5000),
  });
  assert.equal(r.status, 413);
  assert.equal(r.body.code, 40005);
  assert.deepEqual(during, [25 * MiB]);
  assert.deepEqual(await tmpFiles(), []);
  assert.equal((await stored()).length, before);

  const sticker = await rawUpload(`/guilds/${g.guild.id}/stickers`, [
    ['name', Buffer.from('huge')], ['tags', Buffer.from('x')], ['file', Buffer.concat([png(), randomBytes(600 * 1024)]), 'huge.png', 'image/png'],
  ]);
  assert.equal(sticker.status, 400);
  assert.equal(sticker.body.errors.file._errors[0].code, 'BINARY_TYPE_MAX_SIZE');
  assert.deepEqual(await tmpFiles(), []);

  // a declared body over the whole-request limit is refused before reading
  const res = await new Promise((resolve, reject) => {
    const req = request(`${srv.base}/channels/${g.general.id}/messages`, {
      method: 'POST', headers: { Authorization: alice.token, 'Content-Type': 'multipart/form-data; boundary=x', 'Content-Length': 300 * MiB },
    }, resolve);
    req.on('error', reject);
    req.write('--x\r\n');
  });
  assert.equal(res.statusCode, 413);
  res.destroy();
});
