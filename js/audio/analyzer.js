// Offline music analysis. Pure functions, no DOM: runs in a Worker, on the
// main thread (for cheap re-tracking) and in Node (tests).
//
// Pipeline
//   mono PCM → decimate to ~22–24 kHz → STFT (Hann, 100 frames/s)
//   → log-compressed magnitude → per-band SuperFlux onset envelopes
//   → band energy envelopes → tempo (autocorrelation + log-Gaussian prior)
//   → beat tracking (dynamic programming, Ellis 2007) → downbeat phase
//   → section boundaries (bar-level novelty).

import { RealFFT, hann } from './fft.js';

export const FPS = 100;

// Flux peaks fire on the first frame whose window catches the attack, a
// little before the attack itself. Measured on synthetic drums: ~9 ms.
export const ONSET_LATENCY = 0.009;

// Spectral bands used for onset detection (drum classes)
export const ONSET_BANDS = {
  kick:  [30, 120],
  snare: [1000, 4500],   // the crack/clap region, clear of kick body and bass
  hat:   [6000, 12000],
};

// Spectral bands used for continuous energy envelopes
export const ENV_BANDS = {
  low:  [20, 160],
  mid:  [160, 2500],
  high: [2500, 12000],
};

// ─── Pre-processing ───────────────────────────────────────────────────────

export function mixdown(channels) {
  if (channels.length === 1) return Float32Array.from(channels[0]);
  const n = channels[0].length, out = new Float32Array(n), g = 1 / channels.length;
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i] * g;
  return out;
}

// Halve the sample rate with a windowed-sinc low-pass (cutoff 0.45·fs/2)
export function decimate2(x) {
  const taps = 31, mid = (taps - 1) / 2, fc = 0.225;
  const h = new Float32Array(taps);
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const k = i - mid;
    const sinc = k === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * k) / (Math.PI * k);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (taps - 1));
    h[i] = sinc * w; sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;

  const n = Math.floor(x.length / 2), y = new Float32Array(n);
  for (let o = 0; o < n; o++) {
    const c = o * 2;
    let acc = 0;
    for (let i = 0; i < taps; i++) {
      const j = c + i - mid;
      if (j >= 0 && j < x.length) acc += x[j] * h[i];
    }
    y[o] = acc;
  }
  return y;
}

// ─── Statistics helpers ───────────────────────────────────────────────────

export function percentile(arr, p) {
  const s = Float32Array.from(arr).sort();
  if (!s.length) return 0;
  const idx = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return s[idx];
}

function movingAverage(x, radius) {
  const n = x.length, out = new Float32Array(n);
  let acc = 0, count = 0, lo = 0, hi = -1;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - radius), b = Math.min(n - 1, i + radius);
    while (hi < b) { hi++; acc += x[hi]; count++; }
    while (lo < a) { acc -= x[lo]; lo++; count--; }
    out[i] = acc / count;
  }
  return out;
}

function std(x) {
  let m = 0;
  for (let i = 0; i < x.length; i++) m += x[i];
  m /= x.length || 1;
  let v = 0;
  for (let i = 0; i < x.length; i++) v += (x[i] - m) ** 2;
  return Math.sqrt(v / (x.length || 1));
}

// ─── Spectral analysis ────────────────────────────────────────────────────

export function analyze(mono, sampleRate, { onProgress } = {}) {
  const duration = mono.length / sampleRate;
  const peaks = waveformPeaks(mono, 4096);

  let x = mono, sr = sampleRate;
  while (sr > 30000) { x = decimate2(x); sr /= 2; }

  const N = 1024;
  const fft = new RealFFT(N);
  const win = hann(N);
  const bins = N / 2 + 1;
  const binHz = sr / N;
  const frames = Math.max(1, Math.floor((x.length / sr) * FPS) + 1);
  const norm = 4 / N; // full-scale sine → ~1

  const bandBins = (lo, hi) => [Math.max(1, Math.floor(lo / binHz)), Math.min(bins - 1, Math.ceil(hi / binHz))];
  const onsetBins = Object.fromEntries(Object.entries(ONSET_BANDS).map(([k, [lo, hi]]) => [k, bandBins(lo, hi)]));
  const envBins   = Object.fromEntries(Object.entries(ENV_BANDS).map(([k, [lo, hi]]) => [k, bandBins(lo, hi)]));

  const onset = { kick: new Float32Array(frames), snare: new Float32Array(frames), hat: new Float32Array(frames) };
  // Linear band power per onset band, for energy-based hit classification
  const bandPow = { kick: new Float32Array(frames), snare: new Float32Array(frames), hat: new Float32Array(frames) };

  // Per-bin band lookups (bands don't overlap), so the hot loop stays flat
  const envKeys = Object.keys(envBins), onsetKeys = Object.keys(onsetBins);
  const envOf = new Int8Array(bins).fill(-1), onsetOf = new Int8Array(bins).fill(-1);
  envKeys.forEach((b, i) => { for (let k = envBins[b][0]; k <= envBins[b][1]; k++) if (envOf[k] < 0) envOf[k] = i; });
  onsetKeys.forEach((b, i) => { for (let k = onsetBins[b][0]; k <= onsetBins[b][1]; k++) if (onsetOf[k] < 0) onsetOf[k] = i; });
  const powArr = onsetKeys.map(b => bandPow[b]);
  const eBand = new Float64Array(envKeys.length);

  // 16 log-spaced bands (60 Hz – 4 kHz) of log magnitude: a compact timbre /
  // harmony fingerprint used for downbeat and section detection.
  const TB = 16;
  const timbre = new Float32Array(frames * TB);
  const tbEdges = [];
  for (let b = 0; b <= TB; b++) tbEdges.push(Math.round((60 * Math.pow(4000 / 60, b / TB)) / binHz));
  const energyDb = { low: new Float32Array(frames), mid: new Float32Array(frames), high: new Float32Array(frames), rms: new Float32Array(frames) };

  const buf = new Float32Array(N);
  const mag = new Float32Array(bins);
  let prev = new Float32Array(bins), cur = new Float32Array(bins);
  const prevMax = new Float32Array(bins);

  const progressEvery = Math.max(1, Math.floor(frames / 50));

  for (let f = 0; f < frames; f++) {
    const center = Math.round((f * sr) / FPS);
    const start = center - N / 2;
    for (let i = 0; i < N; i++) {
      const j = start + i;
      buf[i] = j >= 0 && j < x.length ? x[j] * win[i] : 0;
    }
    fft.magnitude(buf, mag);

    let eAll = 0;
    eBand.fill(0);
    for (let k = 0; k < bins; k++) {
      const m = mag[k] * norm;
      cur[k] = Math.log1p(1000 * m);
      const p = m * m;
      eAll += p;
      if (envOf[k] >= 0) eBand[envOf[k]] += p;
      if (onsetOf[k] >= 0) powArr[onsetOf[k]][f] += p;
    }
    for (let i = 0; i < envKeys.length; i++) energyDb[envKeys[i]][f] = 10 * Math.log10(eBand[i] + 1e-10);
    for (let b = 0; b < TB; b++) {
      const lo = tbEdges[b], hi = Math.max(lo, tbEdges[b + 1] - 1);
      let acc = 0;
      for (let k = lo; k <= hi; k++) acc += cur[k];
      timbre[f * TB + b] = acc / (hi - lo + 1);
    }
    energyDb.rms[f] = 10 * Math.log10(eAll + 1e-10);

    if (f > 0) {
      // SuperFlux: compare against a frequency-max-filtered previous frame,
      // which suppresses vibrato and slow pitch glides.
      for (let k = 0; k < bins; k++) {
        prevMax[k] = Math.max(prev[k], k > 0 ? prev[k - 1] : 0, k < bins - 1 ? prev[k + 1] : 0);
      }
      for (const b in onsetBins) {
        const [lo, hi] = onsetBins[b];
        let s = 0;
        for (let k = lo; k <= hi; k++) { const d = cur[k] - prevMax[k]; if (d > 0) s += d; }
        onset[b][f] = s / (hi - lo + 1);
      }
    }
    [prev, cur] = [cur, prev];

    if (onProgress && f % progressEvery === 0) onProgress(f / frames);
  }

  // Normalise onset envelopes to a robust 0..1 scale
  for (const b in onset) {
    const ref = percentile(onset[b].filter(v => v > 1e-4), 99) || 1;
    const o = onset[b];
    for (let i = 0; i < o.length; i++) o[i] = Math.min(1.5, o[i] / ref);
  }

  // Combined onset envelope: equal-weight sum of the drum bands (a plain
  // broadband flux is dominated by the many high-frequency bins), lightly
  // smoothed so autocorrelation tolerates fractional-frame beat spacing.
  const all = new Float32Array(frames);
  for (let i = 0; i < frames; i++) all[i] = (onset.kick[i] + onset.snare[i] + onset.hat[i]) / 3;
  onset.all = new Float32Array(frames);
  for (let i = 0; i < frames; i++) onset.all[i] = 0.25 * (all[i - 1] ?? 0) + 0.5 * all[i] + 0.25 * (all[i + 1] ?? 0);

  // Energy envelopes: dB → 0..1 over a 36 dB window under the loud peaks,
  // then a fast-attack / slow-release follower for visual smoothness.
  const env = {};
  const release = Math.exp(-1 / (0.12 * FPS));
  for (const b in energyDb) {
    const db = energyDb[b];
    const top = percentile(db, 99.5);
    const e = new Float32Array(frames);
    let y = 0;
    for (let i = 0; i < frames; i++) {
      const v = Math.min(1, Math.max(0, 1 + (db[i] - top) / 36));
      const shaped = v * v;
      y = shaped > y ? shaped : y * release + shaped * (1 - release);
      e[i] = y;
    }
    env[b] = e;
  }

  if (onProgress) onProgress(1);

  const base = { duration, fps: FPS, frames, onset, env, peaks, timbre, timbreBands: TB, rise: powerRise(bandPow) };
  const tempo = estimateTempo(onset.all, FPS);
  const bpm = resolveOctave(base, tempo.bpm);
  return { ...base, ...track(base, bpm), bpmConfidence: tempo.confidence };
}

// Beat grid, downbeats and sections for a given tempo. Cheap enough to rerun
// on the main thread when the user overrides the BPM.
export function track(base, bpm) {
  const period = (60 * FPS) / bpm;
  const beatFrames = alignPhaseJumps(trackBeats(base.onset.all, period, { activity: base.env.rms }), base);
  const beats = Float64Array.from(beatFrames, f => f / FPS + ONSET_LATENCY);
  const refinedBpm = refineBpm(beats) || bpm;
  const downbeatPhase = estimateDownbeatPhase(base, beatFrames);
  const sections = detectSections(base, beatFrames, downbeatPhase);
  return { bpm: refinedBpm, beats, downbeatPhase, sections };
}

// ─── Waveform overview ────────────────────────────────────────────────────

export function waveformPeaks(x, buckets) {
  const out = new Float32Array(buckets * 2);
  const per = x.length / buckets;
  for (let b = 0; b < buckets; b++) {
    const a = Math.floor(b * per), e = Math.min(x.length, Math.floor((b + 1) * per));
    let lo = 0, hi = 0;
    for (let i = a; i < e; i++) { const v = x[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    out[b * 2] = lo; out[b * 2 + 1] = hi;
  }
  return out;
}

// ─── Onset peak picking ───────────────────────────────────────────────────

// sensitivity 0..1 (higher → more onsets). minGap in seconds.
export function pickOnsets(env, fps, { sensitivity = 0.5, minGap = 0.08 } = {}) {
  const n = env.length;
  const localMean = movingAverage(env, Math.round(0.1 * fps));
  const delta = 0.06 + (1 - sensitivity) * 0.3;
  const floor = 0.1 + (1 - sensitivity) * 0.4;
  const gap = Math.round(minGap * fps);
  const times = [], strengths = [];
  let last = -Infinity;
  for (let i = 1; i < n - 1; i++) {
    const v = env[i];
    if (v < floor || v < localMean[i] + delta) continue;
    let isMax = true;
    for (let j = Math.max(0, i - 3); j <= Math.min(n - 1, i + 3); j++) {
      if (env[j] > v || (env[j] === v && j < i)) { isMax = false; break; }
    }
    if (!isMax) continue;
    if (i - last < gap) {
      // keep the stronger of two close peaks
      if (strengths.length && v > strengths[strengths.length - 1]) {
        times[times.length - 1] = i / fps + ONSET_LATENCY;
        strengths[strengths.length - 1] = Math.min(1, v);
        last = i;
      }
      continue;
    }
    times.push(i / fps + ONSET_LATENCY);
    strengths.push(Math.min(1, v));
    last = i;
  }
  return { times: Float64Array.from(times), strengths: Float32Array.from(strengths) };
}

// Linear-power rise per band over ~20 ms, scaled so the band's biggest
// typical jumps are ~1. Log-flux is great for timing but measures *relative*
// change — a faint leak going from -80 to -50 dB looks like a hit. Power
// rises measure how much energy actually arrived, so they classify hits.
function powerRise(bandPow) {
  const out = {};
  for (const b in bandPow) {
    const P = bandPow[b], r = new Float32Array(P.length);
    for (let i = 2; i < P.length; i++) r[i] = Math.max(0, Math.max(P[i], P[i + 1] ?? 0) - P[i - 2]);
    const ref = percentile(r, 99.5) || 1;
    for (let i = 0; i < r.length; i++) r[i] = Math.min(2, r[i] / ref);
    out[b] = r;
  }
  return out;
}

// Drum hits per class. Candidates come from log-flux peaks (precise timing,
// catches quiet hits); each is then classified on the power rises:
//   kick  — the low band gained real energy (bass notes rise ~0.1, kicks ~1)
//   snare — the 1–4.5 kHz band gained energy, not just leakage from a hat
//   hat   — the top band rose and the mid band didn't (else it's a snare)
export function detectDrums(base, sens = {}) {
  const { onset, rise, fps } = base;
  const near = (env, t) => {
    const f = Math.round((t - ONSET_LATENCY) * fps);
    let m = 0;
    for (let j = Math.max(0, f - 2); j <= Math.min(env.length - 1, f + 2); j++) m = Math.max(m, env[j]);
    return m;
  };
  const classify = (picked, keep) => {
    const times = [], strengths = [];
    for (let i = 0; i < picked.times.length; i++) {
      const t = picked.times[i];
      // Gate: log compression lifts the noise floor, so ignore near-silence
      if (near(base.env.rms, t) < 0.03) continue;
      if (keep(near(rise.kick, t), near(rise.snare, t), near(rise.hat, t))) { times.push(t); strengths.push(picked.strengths[i]); }
    }
    return { times: Float64Array.from(times), strengths: Float32Array.from(strengths) };
  };
  const kick  = pickOnsets(onset.kick,  fps, { sensitivity: sens.kick  ?? 0.5, minGap: 0.09 });
  const snare = pickOnsets(onset.snare, fps, { sensitivity: sens.snare ?? 0.5, minGap: 0.09 });
  const hat   = pickOnsets(onset.hat,   fps, { sensitivity: sens.hat   ?? 0.5, minGap: 0.05 });
  return {
    kick:  classify(kick,  k => k >= 0.25),
    snare: classify(snare, (k, s, h) => s >= 0.15 && s >= 0.5 * h),
    hat:   classify(hat,   (k, s, h) => h >= 0.04 && s < 0.5 * h),
  };
}

// ─── Tempo estimation ─────────────────────────────────────────────────────

export function estimateTempo(onset, fps, { minBpm = 60, maxBpm = 200, prior = 120, priorOctaves = 1.0 } = {}) {
  const n = onset.length;
  const mean = movingAverage(onset, Math.round(0.5 * fps));
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) o[i] = Math.max(0, onset[i] - mean[i]);

  const minLag = Math.floor((60 * fps) / maxBpm);
  const maxLag = Math.ceil((60 * fps) / minBpm);
  const harmLag = Math.min(n - 1, maxLag * 2 + 2);

  const xcr = new Float64Array(harmLag + 1);
  for (let lag = 1; lag <= harmLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += o[i] * o[i + lag];
    xcr[lag] = s / (n - lag);
  }
  const xc = l => (l <= harmLag ? xcr[l] : 0);
  const xcHalf = l => { const h = l / 2, a = Math.floor(h), f = h - a; return xc(a) * (1 - f) + xc(a + 1) * f; };

  const priorLag = (60 * fps) / prior;
  const curve = [];
  let best = -Infinity, bestLag = minLag;
  const score = new Float64Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag; lag++) {
    const w = Math.exp(-0.5 * (Math.log2(lag / priorLag) / priorOctaves) ** 2);
    const s = w * (xc(lag) + 0.5 * xc(2 * lag) + 0.5 * xcHalf(lag));
    score[lag] = s;
    curve.push([(60 * fps) / lag, s]);
    if (s > best) { best = s; bestLag = lag; }
  }

  // Parabolic interpolation around the peak
  let lag = bestLag;
  if (bestLag > minLag && bestLag < maxLag) {
    const a = score[bestLag - 1], b = score[bestLag], c = score[bestLag + 1];
    const d = a - 2 * b + c;
    if (d < 0) lag = bestLag + (0.5 * (a - c)) / d;
  }

  // Confidence: peak prominence over the median of the curve
  const vals = curve.map(c => c[1]).sort((p, q) => p - q);
  const med = vals[Math.floor(vals.length / 2)] || 1e-9;
  const confidence = best > 0 ? Math.max(0, Math.min(1, 1 - med / best)) : 0;

  return { bpm: (60 * fps) / lag, period: lag, confidence, curve };
}

// ─── Beat tracking (dynamic programming) ──────────────────────────────────

export function trackBeats(onset, period, { tightness = 100, activity = null } = {}) {
  const n = onset.length;
  if (n < period * 2) return [];

  const sd = std(onset) || 1;
  // Smooth the onset envelope with a short Gaussian (±period/32) — gives
  // the DP a little slack around each true onset.
  const radius = Math.max(1, Math.round(period / 16));
  const g = [];
  for (let k = -radius; k <= radius; k++) g.push(Math.exp(-0.5 * ((k * 32) / period) ** 2));
  const local = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = -radius; k <= radius; k++) {
      const j = i + k;
      if (j >= 0 && j < n) s += (onset[j] / sd) * g[k + radius];
    }
    local[i] = s;
  }

  const dMin = Math.max(1, Math.round(period / 2));
  const dMax = Math.round(period * 2);
  const txcost = new Float64Array(dMax + 1);
  for (let d = dMin; d <= dMax; d++) txcost[d] = -tightness * Math.log(d / period) ** 2;

  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  for (let t = 0; t < n; t++) {
    let best = -Infinity, bi = -1;
    for (let d = dMin; d <= dMax; d++) {
      const tau = t - d;
      if (tau < 0) break;
      const v = score[tau] + txcost[d];
      if (v > best) { best = v; bi = tau; }
    }
    // Start a fresh chain when no predecessor helps (keeps the first beat
    // on the first real onset instead of dragging it toward silence)
    score[t] = local[t] + (bi >= 0 && best > 0 ? best : 0);
    back[t] = bi >= 0 && best > 0 ? bi : -1;
  }

  // Last beat: the last local maximum of the cumulative score that is
  // reasonably strong (avoids ending on a weak tail frame).
  const maxima = [];
  for (let t = 1; t < n - 1; t++) if (score[t] > score[t - 1] && score[t] >= score[t + 1]) maxima.push(t);
  if (!maxima.length) return [];
  const medMax = maxima.map(t => score[t]).sort((a, b) => a - b)[Math.floor(maxima.length / 2)];
  let end = maxima[maxima.length - 1];
  for (let k = maxima.length - 1; k >= 0; k--) {
    if (score[maxima[k]] >= 0.5 * medMax) { end = maxima[k]; break; }
  }

  const beats = [];
  for (let t = end; t >= 0; t = back[t]) {
    beats.push(t);
    if (back[t] < 0) break;
  }
  beats.reverse();

  // Trim beats in silent intro/outro
  if (activity) {
    const active = i => activity[Math.min(activity.length - 1, i)] > 0.02;
    while (beats.length && !active(beats[0])) beats.shift();
    while (beats.length && !active(beats[beats.length - 1])) beats.pop();
  }
  return beats;
}

// The DP may lock a sparse passage (e.g. an intro of off-beat hats) out of
// phase with the main groove, drifting back over a few beats. Take the
// longest steady run of beats as the anchor and project its grid outward;
// a same-tempo region that is mostly out of phase with it is re-gridded
// (snapping to nearby onsets). Once the kick lands, that's how a listener
// re-hears the intro. Regions in phase, or at a different tempo, are kept.
export function alignPhaseJumps(beats, base) {
  if (beats.length < 12) return beats;
  const ioi = [];
  for (let i = 1; i < beats.length; i++) ioi.push(beats[i] - beats[i - 1]);
  const P = [...ioi].sort((a, b) => a - b)[Math.floor(ioi.length / 2)];

  // Longest run of steady spacing
  let best = [0, 0], cur = 0;
  for (let i = 1; i < beats.length; i++) {
    if (Math.abs(ioi[i - 1] - P) / P < 0.06) {
      if (i - cur > best[1] - best[0]) best = [cur, i];
    } else cur = i;
  }
  const [s0, s1] = best;
  if (s1 - s0 < 8) return beats;

  // Anchor grid by least squares over the run
  const n = s1 - s0 + 1;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = s0; i <= s1; i++) { const k = i - s0; sx += k; sy += beats[i]; sxx += k * k; sxy += k * beats[i]; }
  const period = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const origin = (sy - period * sx) / n;
  const phaseErr = f => { const p = ((((f - origin) / period) % 1) + 1) % 1; return Math.min(p, 1 - p); };

  // Snap to a real onset near the grid position, if there is one
  const snap = f => {
    let bi = f, bv = 0.2;
    for (let j = Math.max(0, f - 3); j <= Math.min(base.frames - 1, f + 3); j++) {
      if (base.onset.all[j] > bv) { bv = base.onset.all[j]; bi = j; }
    }
    return bi;
  };
  const sameTempo = idx => {
    if (idx.length < 3) return true;
    const d = [];
    for (let k = 1; k < idx.length; k++) d.push(beats[idx[k]] - beats[idx[k - 1]]);
    const med = d.sort((a, b) => a - b)[Math.floor(d.length / 2)];
    return Math.abs(med - period) / period < 0.06;
  };
  const regrid = (idx, from, to) => {
    if (!idx.length) return idx.map(i => beats[i]);
    const off = idx.filter(i => phaseErr(beats[i]) > 0.2).length;
    if (off / idx.length <= 0.5 || !sameTempo(idx)) return idx.map(i => beats[i]);
    const out = [];
    const k0 = Math.ceil((from - origin) / period), k1 = Math.floor((to - origin) / period);
    for (let k = k0; k <= k1; k++) out.push(snap(Math.round(origin + k * period)));
    return out;
  };

  const before = [], after = [];
  for (let i = 0; i < s0; i++) before.push(i);
  for (let i = s1 + 1; i < beats.length; i++) after.push(i);
  const pre = before.length ? regrid(before, beats[0] - period * 0.75, beats[s0] - period / 2) : [];
  const post = after.length ? regrid(after, beats[s1] + period / 2, beats[beats.length - 1] + period * 0.75) : [];
  const res = [];
  for (const f of [...pre, ...beats.slice(s0, s1 + 1), ...post]) {
    if (f < 0 || f >= base.frames) continue;
    if (res.length && f - res[res.length - 1] < period * 0.6) continue;
    res.push(f);
  }
  return res;
}

// Autocorrelation can't tell a backbeat groove at tempo T from a pattern at
// T/2. Track at the candidate tempo, then look between the beats: if kicks
// and snares land on the midpoints about as hard as on the beats, the true
// beat is twice as fast. Hats are excluded so 8th-note hats don't double.
export function resolveOctave(base, bpm, maxBpm = 190) {
  if (bpm * 2 > maxBpm) return bpm;
  const beats = trackBeats(base.onset.all, (60 * FPS) / bpm, { activity: base.env.rms });
  if (beats.length < 8) return bpm;
  const hit = f => {
    let m = 0;
    for (let j = Math.max(0, f - 3); j <= Math.min(base.frames - 1, f + 3); j++) m = Math.max(m, base.rise.kick[j], base.rise.snare[j]);
    return m;
  };
  let onBeat = 0, between = 0;
  for (let i = 0; i + 1 < beats.length; i++) {
    onBeat += hit(beats[i]);
    between += hit(Math.round((beats[i] + beats[i + 1]) / 2));
  }
  return between >= 0.4 * onBeat ? bpm * 2 : bpm;
}

// Tempo from the beat grid: the mean of inter-beat intervals within 6% of
// the median (robust to phase jumps, e.g. an intro locked to off-beats).
export function refineBpm(beats) {
  if (beats.length < 4) return 0;
  const ioi = [];
  for (let i = 1; i < beats.length; i++) ioi.push(beats[i] - beats[i - 1]);
  const med = [...ioi].sort((a, b) => a - b)[Math.floor(ioi.length / 2)];
  const good = ioi.filter(d => Math.abs(d - med) / med < 0.06);
  const mean = good.reduce((a, b) => a + b, 0) / good.length;
  return mean > 0 ? 60 / mean : 0;
}

// ─── Downbeats ────────────────────────────────────────────────────────────

// Returns k ∈ {0,1,2,3}: beats with index ≡ k (mod 4) are downbeats.
// Template: kick-heavy on 1 (and 3), backbeat (snare) on 2 and 4, and
// low-end energy rising into the bar line.
export function estimateDownbeatPhase(base, beatFrames) {
  if (beatFrames.length < 8) return 0;
  const near = (env, f) => {
    let m = 0;
    for (let j = Math.max(0, f - 4); j <= Math.min(env.length - 1, f + 4); j++) m = Math.max(m, env[j]);
    return m;
  };
  const kick = beatFrames.map(f => near(base.onset.kick, f));
  const snare = beatFrames.map(f => near(base.onset.snare, f));
  const low = beatFrames.map(f => base.env.low[Math.min(base.env.low.length - 1, f + 2)]);
  const harm = harmonicChange(base, beatFrames);
  const center = a => {
    const m = a.reduce((x, y) => x + y, 0) / a.length;
    const sd = Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length) || 1;
    return a.map(v => (v - m) / sd);
  };
  const K = center(kick), S = center(snare), L = center(low), H = center(harm);
  const kickW  = [1, -0.3, 0.4, -0.3];
  const snareW = [-0.5, 1, -0.5, 1];
  const lowW   = [0.6, -0.2, 0, -0.2];
  const harmW  = [1.5, -0.5, 0.2, -0.5];
  let best = -Infinity, bestK = 0;
  for (let k = 0; k < 4; k++) {
    let s = 0;
    for (let i = 0; i < beatFrames.length; i++) {
      const pos = (((i - k) % 4) + 4) % 4;
      s += kickW[pos] * K[i] + snareW[pos] * S[i] + lowW[pos] * L[i] + harmW[pos] * H[i];
    }
    if (s > best) { best = s; bestK = k; }
  }
  return bestK;
}

// Timbre/harmony change across each beat: distance between the mean timbre
// vector of the beat before and the beat after. Chord and bass changes tend
// to land on bar lines.
function harmonicChange(base, beatFrames) {
  const TB = base.timbreBands, T = base.timbre;
  const mean = (a, b) => {
    const v = new Float64Array(TB);
    const n = Math.max(1, b - a);
    for (let f = a; f < b; f++) for (let k = 0; k < TB; k++) v[k] += T[f * TB + k];
    for (let k = 0; k < TB; k++) v[k] /= n;
    return v;
  };
  const out = new Array(beatFrames.length).fill(0);
  for (let i = 1; i + 1 < beatFrames.length; i++) {
    // skip the attack region so drum transients don't dominate
    const a = mean(beatFrames[i - 1] + 6, beatFrames[i] - 1);
    const b = mean(beatFrames[i] + 6, beatFrames[i + 1] - 1);
    let d = 0;
    for (let k = 0; k < TB; k++) d += (a[k] - b[k]) ** 2;
    out[i] = Math.sqrt(d);
  }
  return out;
}

// ─── Sections ─────────────────────────────────────────────────────────────

// Bar-level novelty on band energies; boundaries snap to downbeats.
export function detectSections(base, beatFrames, downbeatPhase) {
  const bars = [];
  for (let i = downbeatPhase; i + 4 <= beatFrames.length; i += 4) bars.push([beatFrames[i], beatFrames[i + 4] ?? beatFrames[i + 3]]);
  if (bars.length < 12) return [0];

  const keys = ['low', 'mid', 'high', 'rms'];
  const feats = bars.map(([a, b]) => keys.map(k => {
    let s = 0;
    for (let f = a; f < b; f++) s += base.env[k][f];
    return s / Math.max(1, b - a);
  }).concat(['kick', 'snare', 'hat'].map(k => {
    let s = 0;
    for (let f = a; f < b; f++) s += base.onset[k][f];
    return (s / Math.max(1, b - a)) * 4;
  })));

  const W = 4;
  const nov = new Float64Array(bars.length);
  for (let b = W; b <= bars.length - W; b++) {
    let d = 0;
    for (let j = 0; j < feats[0].length; j++) {
      let pre = 0, post = 0;
      for (let k = 0; k < W; k++) { pre += feats[b - 1 - k][j]; post += feats[b + k][j]; }
      d += ((post - pre) / W) ** 2;
    }
    nov[b] = Math.sqrt(d);
  }
  // Peaks relative to the strongest change (a spread-based threshold gets
  // swamped when one boundary, typically intro→groove, dwarfs the rest),
  // plus an absolute floor so a steady loop doesn't sprout sections.
  let max = 0;
  for (const v of nov) max = Math.max(max, v);
  const thr = Math.max(0.3 * max, 0.12);

  const out = [0];
  for (let b = W; b <= bars.length - W; b++) {
    let isMax = nov[b] >= thr;
    for (let k = -2; k <= 2 && isMax; k++) if (k && nov[b + k] > nov[b]) isMax = false;
    if (isMax) out.push(bars[b][0] / FPS + ONSET_LATENCY);
  }
  return out;
}
