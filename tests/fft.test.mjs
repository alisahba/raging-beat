import { RealFFT } from '../js/audio/fft.js';
import assert from 'node:assert/strict';
for (const n of [8, 64, 1024]) {
  const x = Float64Array.from({ length: n }, () => Math.random() * 2 - 1);
  const out = new Float32Array(n / 2 + 1);
  new RealFFT(n).magnitude(x, out);
  for (let k = 0; k <= n / 2; k++) {
    let r = 0, i = 0;
    for (let t = 0; t < n; t++) { r += x[t] * Math.cos(-2 * Math.PI * k * t / n); i += x[t] * Math.sin(-2 * Math.PI * k * t / n); }
    assert.ok(Math.abs(Math.hypot(r, i) - out[k]) < 1e-3 * Math.max(1, Math.hypot(r, i)), `n=${n} k=${k}: ${Math.hypot(r,i)} vs ${out[k]}`);
  }
}
console.log('fft ok');
