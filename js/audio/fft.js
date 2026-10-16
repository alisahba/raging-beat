// Radix-2 FFT for real input. Computes the magnitude spectrum of a real frame
// of length N (power of two) using one complex FFT of length N/2.

export class RealFFT {
  constructor(n) {
    if (n & (n - 1)) throw new Error('FFT size must be a power of two');
    this.n = n;
    const h = n >> 1;
    this.h = h;
    this.re = new Float64Array(h);
    this.im = new Float64Array(h);

    // Bit-reversal table for the half-size complex transform
    this.rev = new Uint32Array(h);
    const bits = Math.log2(h);
    for (let i = 0; i < h; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }

    // Twiddles for the half-size transform
    this.cos = new Float64Array(h >> 1);
    this.sin = new Float64Array(h >> 1);
    for (let i = 0; i < h >> 1; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / h);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / h);
    }

    // Twiddles for the real-split post-processing step
    this.splitCos = new Float64Array(h);
    this.splitSin = new Float64Array(h);
    for (let k = 0; k < h; k++) {
      this.splitCos[k] = Math.cos((-2 * Math.PI * k) / n);
      this.splitSin[k] = Math.sin((-2 * Math.PI * k) / n);
    }
  }

  // input: Float32Array|Float64Array length n (already windowed)
  // out:   Float32Array length n/2 + 1, receives |X[k]|
  magnitude(input, out) {
    const { h, re, im, rev } = this;

    // Pack even/odd samples into a complex sequence, bit-reversed
    for (let i = 0; i < h; i++) {
      const r = rev[i];
      re[r] = input[2 * i];
      im[r] = input[2 * i + 1];
    }

    // Iterative Cooley–Tukey
    for (let size = 2; size <= h; size <<= 1) {
      const half = size >> 1;
      const step = h / size;
      for (let start = 0; start < h; start += size) {
        for (let j = 0; j < half; j++) {
          const tw = j * step;
          const wr = this.cos[tw], wi = this.sin[tw];
          const a = start + j, b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr;        im[a] += xi;
        }
      }
    }

    // Split into the spectrum of the real signal
    out[0] = Math.abs(re[0] + im[0]);
    out[h] = Math.abs(re[0] - im[0]);
    for (let k = 1; k < h; k++) {
      const ar = re[k], ai = im[k];
      const br = re[h - k], bi = -im[h - k];
      const er = 0.5 * (ar + br), ei = 0.5 * (ai + bi);   // even part
      const or = 0.5 * (ai - bi), oi = -0.5 * (ar - br);  // odd part (×-i)
      const wr = this.splitCos[k], wi = this.splitSin[k];
      const xr = er + (or * wr - oi * wi);
      const xi = ei + (or * wi + oi * wr);
      out[k] = Math.hypot(xr, xi);
    }
    return out;
  }
}

export function hann(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}
