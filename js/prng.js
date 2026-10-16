// Deterministic hashing → [0, 1). Everything random in the visuals goes
// through this so a preview and an export of the same moment are identical.
export function hash(...nums) {
  let h = 0x811c9dc5;
  for (const n of nums) {
    let v = Math.floor(n * 1000) | 0;
    for (let i = 0; i < 4; i++) {
      h ^= v & 0xff;
      h = Math.imul(h, 0x01000193);
      v >>>= 8;
    }
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Smooth 1-D value noise in [-1, 1]
export function noise1(seed, x) {
  const i = Math.floor(x), f = x - i;
  const u = f * f * (3 - 2 * f);
  const a = hash(seed, i) * 2 - 1, b = hash(seed, i + 1) * 2 - 1;
  return a + (b - a) * u;
}
