// Synthetic drum patterns with known ground truth, for analyzer tests.
export function rng(seed) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296); }

export function drumTrack({ bpm = 128, bars = 16, sr = 44100, intro = 0.37, swing = 0, seed = 1, kickPattern = [0, 2], noise = 0.01, pad = 0, bassline = true } = {}) {
  const rand = rng(seed);
  const beat = 60 / bpm;
  const dur = intro + bars * 4 * beat + 1;
  const x = new Float32Array(Math.ceil(dur * sr));
  const truth = { beats: [], downbeats: [], kick: [], snare: [], hat: [] };
  const add = (t, fn, len) => { const s = Math.round(t * sr); for (let i = 0; i < len * sr && s + i < x.length; i++) x[s + i] += fn(i / sr); };
  const kick = t => { let ph = 0; add(t, tt => { ph += 2 * Math.PI * (50 + 100 * Math.exp(-tt * 30)) / sr; return Math.sin(ph) * Math.exp(-tt * 9) * 0.9; }, 0.4); truth.kick.push(t); };
  const snare = t => { add(t, tt => ((rand() * 2 - 1) * 0.5 + Math.sin(2 * Math.PI * 190 * tt) * 0.4) * Math.exp(-tt * 18), 0.25); truth.snare.push(t); };
  let hp = 0;
  const hat = t => { add(t, tt => { const n = rand() * 2 - 1; const y = n - hp; hp = n; return y * 0.25 * Math.exp(-tt * 60); }, 0.08); truth.hat.push(t); };
  for (let b = 0; b < bars * 4; b++) {
    const t = intro + b * beat;
    truth.beats.push(t);
    if (b % 4 === 0) truth.downbeats.push(t);
    if (kickPattern.includes(b % 4) || kickPattern === 'all') kick(t);
    if (b % 4 === 1 || b % 4 === 3) snare(t);
    hat(t + beat / 2 + swing * beat / 6);
  }
  if (bassline) {
    // Sustained bass + chord tones, one root per bar (bar lines carry harmony)
    const roots = [55, 43.65, 49, 41.2];
    let ph = 0, ph2 = 0, ph3 = 0;
    for (let i = 0; i < x.length; i++) {
      const t = i / sr - intro;
      if (t < 0 || t > bars * 4 * beat) continue;
      const bar = Math.floor(t / (4 * beat));
      const f0 = roots[bar % 4];
      ph += 2 * Math.PI * f0 / sr; ph2 += 2 * Math.PI * f0 * 4 / sr; ph3 += 2 * Math.PI * f0 * 5 / sr;
      x[i] += 0.25 * Math.sin(ph) + 0.06 * Math.sin(ph2) + 0.05 * Math.sin(ph3);
    }
  }
  if (pad) { let ph = 0; for (let i = 0; i < x.length; i++) { ph += 2 * Math.PI * 220 / sr; x[i] += Math.sin(ph) * pad * (0.6 + 0.4 * Math.sin(i / sr * 0.7)); } }
  for (let i = 0; i < x.length; i++) x[i] += (rand() * 2 - 1) * noise;
  return { x, sr, truth };
}

// Fraction of truth events matched by a detection within tol seconds; plus mean signed error
export function match(det, truth, tol = 0.05) {
  let hits = 0, err = 0; const used = new Set();
  for (const t of truth) {
    let bi = -1, bd = Infinity;
    det.forEach((d, i) => { const e = Math.abs(d - t); if (e < bd && !used.has(i)) { bd = e; bi = i; } });
    if (bd <= tol) { hits++; used.add(bi); err += det[bi] - t; }
  }
  return { recall: hits / truth.length, precision: hits / Math.max(1, det.length), bias: hits ? err / hits : 0 };
}
