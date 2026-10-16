// Ground truth for js/audio/demo.js (mirrors its schedule)
export function demoTruth() {
  const bpm = 126, beat = 60 / bpm, bar = beat * 4, t0 = 0.25, BARS = 24;
  const T = { beats: [], downbeats: [], kick: [], snare: [], hat: [], bass: [], sections: [t0 + 4 * bar, t0 + 12 * bar, t0 + 16 * bar] };
  for (let b = 0; b < BARS; b++) {
    const bt = t0 + b * bar;
    const groove = b >= 4 && b < 12, brk = b >= 12 && b < 16, drop = b >= 16;
    T.downbeats.push(bt);
    for (let q = 0; q < 4; q++) {
      const t = bt + q * beat;
      T.beats.push(t);
      if (groove || drop) T.kick.push(t);
      if ((groove || drop) && (q === 1 || q === 3)) T.snare.push(t);
      T.hat.push(t + beat / 2);
      if (drop) T.hat.push(t + beat / 4, t + 3 * beat / 4);
      if (groove || drop) T.bass.push(t + beat / 2);
    }
    if (brk) { const div = b < 14 ? 2 : b < 15 ? 4 : 8; for (let i = 0; i < 4 * div; i++) T.snare.push(bt + i * beat / div); }
  }
  T.kick.push(t0 + BARS * bar);
  for (const k in T) T[k].sort((a, b) => a - b);
  return T;
}
