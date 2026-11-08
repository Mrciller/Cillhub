const EPOCH = 1420070400000n;
let last = 0n;
let seq = 0n;

export function snowflake() {
  let now = BigInt(Date.now());
  if (now > last) seq = 0n;
  else if (++seq > 4095n) { seq = 0n; now = last + 1n; } // sequence exhausted: borrow the next millisecond
  else now = last; // same ms, or the clock went back: stay monotonic
  last = now;
  return String(((now - EPOCH) << 22n) | seq);
}
