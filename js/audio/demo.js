// Built-in demo track, synthesised with an OfflineAudioContext so it can be
// analysed and played exactly like an uploaded file.
//
// 126 BPM, 24 bars:  intro (hats + pad) → groove → break/build → drop.

export const DEMO_BPM = 126;
const BARS = 24;

export async function renderDemo(sampleRate = 44100) {
  const beat = 60 / DEMO_BPM;
  const bar = beat * 4;
  const duration = BARS * bar + 1.5;
  const ctx = new OfflineAudioContext(2, Math.ceil(duration * sampleRate), sampleRate);

  const master = ctx.createDynamicsCompressor();
  master.threshold.value = -14;
  master.ratio.value = 4;
  master.attack.value = 0.003;
  master.release.value = 0.15;
  const out = ctx.createGain();
  out.gain.value = 0.9;
  master.connect(out).connect(ctx.destination);

  // Shared white-noise buffer
  const noise = ctx.createBuffer(1, sampleRate * 2, sampleRate);
  {
    const d = noise.getChannelData(0);
    let s = 1234567;
    for (let i = 0; i < d.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; d[i] = s / 2147483648 - 1; }
  }
  let seed = 99;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const noiseSrc = (t, dur) => {
    const n = ctx.createBufferSource();
    n.buffer = noise;
    n.start(t, rand() * 1.5, dur + 0.05);
    return n;
  };

  const kick = (t, vel = 1) => {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(48, t + 0.11);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vel, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.42);
    o.connect(g).connect(master);
    o.start(t); o.stop(t + 0.45);
    // beater click
    const c = noiseSrc(t, 0.02), hp = ctx.createBiquadFilter(), cg = ctx.createGain();
    hp.type = 'highpass'; hp.frequency.value = 2500;
    cg.gain.setValueAtTime(0.25 * vel, t);
    cg.gain.exponentialRampToValueAtTime(0.001, t + 0.015);
    c.connect(hp).connect(cg).connect(master);
  };

  const clap = (t, vel = 1) => {
    const n = noiseSrc(t, 0.3), bp = ctx.createBiquadFilter(), g = ctx.createGain();
    bp.type = 'bandpass'; bp.frequency.value = 1400; bp.Q.value = 0.7;
    g.gain.setValueAtTime(0.0001, t);
    for (const [dt, a] of [[0, 0.8], [0.011, 0.6], [0.022, 0.9]]) {
      g.gain.setValueAtTime(a * vel, t + dt);
      g.gain.exponentialRampToValueAtTime(0.15 * vel, t + dt + 0.009);
    }
    g.gain.setValueAtTime(0.7 * vel, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.26);
    n.connect(bp).connect(g).connect(master);
    const o = ctx.createOscillator(), og = ctx.createGain();
    o.type = 'triangle'; o.frequency.value = 185;
    og.gain.setValueAtTime(0.35 * vel, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    o.connect(og).connect(master);
    o.start(t); o.stop(t + 0.1);
  };

  const hat = (t, open = false, vel = 1) => {
    const len = open ? 0.28 : 0.05;
    const n = noiseSrc(t, len), hp = ctx.createBiquadFilter(), g = ctx.createGain();
    hp.type = 'highpass'; hp.frequency.value = 7500;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.32 * vel, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.001, t + len);
    n.connect(hp).connect(g).connect(master);
  };

  const chords = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]; // Am F C G
  const mtof = m => 440 * Math.pow(2, (m - 69) / 12);

  const bassNote = (t, midi, len) => {
    const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    o.type = 'sawtooth'; o.frequency.value = mtof(midi);
    f.type = 'lowpass'; f.Q.value = 6;
    f.frequency.setValueAtTime(900, t);
    f.frequency.exponentialRampToValueAtTime(140, t + len);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.42, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.001, t + len);
    o.connect(f).connect(g).connect(master);
    o.start(t); o.stop(t + len + 0.02);
  };

  const pad = (t, notes, len, level, cutoff) => {
    const f = ctx.createBiquadFilter(), g = ctx.createGain();
    f.type = 'lowpass'; f.frequency.value = cutoff; f.Q.value = 0.5;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(level, t + 0.25);
    g.gain.setValueAtTime(level, t + len - 0.2);
    g.gain.linearRampToValueAtTime(0.0001, t + len);
    f.connect(g).connect(master);
    for (const m of notes) for (const det of [-7, 7]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = mtof(m); o.detune.value = det;
      o.connect(f); o.start(t); o.stop(t + len + 0.05);
    }
  };

  const stab = (t, notes) => {
    const f = ctx.createBiquadFilter(), g = ctx.createGain();
    f.type = 'lowpass'; f.frequency.setValueAtTime(3000, t); f.frequency.exponentialRampToValueAtTime(400, t + 0.18);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.09, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    f.connect(g).connect(master);
    for (const m of notes) {
      const o = ctx.createOscillator();
      o.type = 'square'; o.frequency.value = mtof(m + 12);
      o.connect(f); o.start(t); o.stop(t + 0.22);
    }
  };

  const riser = (t, len) => {
    const n = noiseSrc(t, len), bp = ctx.createBiquadFilter(), g = ctx.createGain();
    bp.type = 'bandpass'; bp.Q.value = 2;
    bp.frequency.setValueAtTime(300, t);
    bp.frequency.exponentialRampToValueAtTime(9000, t + len);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + len);
    n.connect(bp).connect(g).connect(master);
  };

  const t0 = 0.25;
  for (let b = 0; b < BARS; b++) {
    const bt = t0 + b * bar;
    const chord = chords[Math.floor(b / 2) % 4];
    const root = chord[0] - 24;
    const intro = b < 4, groove = b >= 4 && b < 12, brk = b >= 12 && b < 16, drop = b >= 16;

    if (b % 2 === 0) pad(bt, chord, bar * 2, brk ? 0.05 : 0.03, intro ? 900 : brk ? 2200 : 1400);

    for (let q = 0; q < 4; q++) {
      const t = bt + q * beat;
      if (groove || drop) kick(t);
      if ((groove || drop) && (q === 1 || q === 3)) clap(t);
      hat(t + beat / 2, groove || drop, intro ? 0.7 : 1);
      if (drop) { hat(t + beat / 4, false, 0.5); hat(t + (3 * beat) / 4, false, 0.5); }
      if (groove || drop) bassNote(t + beat / 2, root, beat * 0.45);
      if (drop && (q === 1 || q === 3)) stab(t + beat * 0.75, chord);
    }

    if (brk) {
      // snare roll that tightens toward the drop
      const div = b < 14 ? 2 : b < 15 ? 4 : 8;
      for (let i = 0; i < 4 * div; i++) clap(bt + (i * beat) / div, 0.35 + 0.65 * ((b - 12) * 4 * div + i) / (16 * div));
      if (b === 12) riser(bt, bar * 4);
    }
  }
  kick(t0 + BARS * bar);

  return ctx.startRendering();
}
