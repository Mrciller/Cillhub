// playback length in seconds of an MP3 or Ogg (Opus/Vorbis) file, or null if it cannot be read

function oggDuration(buf) {
  const head = buf.indexOf('OpusHead');
  const vorbis = buf.indexOf('\x01vorbis');
  const rate = head >= 0 ? 48000 : vorbis >= 0 ? buf.readUInt32LE(vorbis + 12) : 0;
  const last = buf.lastIndexOf('OggS');
  if (!rate || last < 0 || last + 14 > buf.length) return null;
  const granule = Number(buf.readBigUInt64LE(last + 6));
  const skip = head >= 0 ? buf.readUInt16LE(head + 10) : 0; // Opus pre-skip
  return Math.max(0, granule - skip) / rate;
}

const BITRATES = { // kbps by [MPEG-1, MPEG-2/2.5] x layer 3, 2, 1
  1: [[0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384], [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448]],
  2: [[0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256]],
};
const RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

function mp3Duration(buf) {
  let i = 0;
  if (buf.toString('latin1', 0, 3) === 'ID3') i = 10 + ((buf[6] << 21) | (buf[7] << 14) | (buf[8] << 7) | buf[9]);
  let seconds = 0, frames = 0;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) { i++; continue; }
    const version = (buf[i + 1] >> 3) & 3, layer = (buf[i + 1] >> 1) & 3;
    const bitIdx = buf[i + 2] >> 4, rateIdx = (buf[i + 2] >> 2) & 3, pad = (buf[i + 2] >> 1) & 1;
    if (version === 1 || layer === 0 || bitIdx === 0 || bitIdx === 15 || rateIdx === 3) { i++; continue; }
    const kbps = BITRATES[version === 3 ? 1 : 2][layer - 1][bitIdx];
    const rate = RATES[version][rateIdx];
    const samples = layer === 3 ? 384 : layer === 2 || version === 3 ? 1152 : 576;
    const len = layer === 3 ? Math.floor((12 * kbps * 1000) / rate + pad) * 4 : Math.floor((samples / 8) * kbps * 1000 / rate) + pad;
    if (len < 4) { i++; continue; }
    seconds += samples / rate;
    frames++;
    i += len;
  }
  return frames ? seconds : null;
}

export function audioDuration(buf, type) {
  try { return type === 'audio/ogg' ? oggDuration(buf) : type === 'audio/mpeg' ? mp3Duration(buf) : null; } catch { return null; } // truncated header
}
