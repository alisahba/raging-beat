// Signals: what the visuals react to at time t.
//
//   pulse.*   decaying envelopes fired by events (kick, snare, hat, beat,
//             half, bar, bar2, bar4, section), 1 at the hit → 0
//   env.*     continuous band energies (low, mid, high, level)
//   beatPhase / barPhase  0..1 position inside the current beat / bar
//   stream    time-ordered event list, folded by the Director
//
// TrackSignals derives everything from the offline analysis, so any time t
// can be sampled deterministically (scrubbing, frame-exact export).
// LiveSignals produces the same shape from the microphone in real time.

import { detectDrums, track, estimateTempo, FPS } from './analyzer.js';

export const TRIGGERS = ['beat', 'half', 'bar', 'bar2', 'bar4', 'kick', 'snare', 'hat', 'section'];
export const SOURCES = ['none', 'kick', 'snare', 'hat', 'beat', 'half', 'bar', 'bar2', 'bar4', 'section', 'low', 'mid', 'high', 'level', 'phase', 'barphase'];

export const DECAY = {
  kick: 0.16, snare: 0.2, hat: 0.07, beat: 0.22, half: 0.12,
  bar: 0.5, bar2: 0.6, bar4: 0.8, section: 1.6,
};

function lastIndexAtOrBefore(times, t) {
  let lo = 0, hi = times.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

function pulseAt(series, type, t) {
  if (!series) return 0;
  const { times, strengths } = series;
  const j = lastIndexAtOrBefore(times, t);
  if (j < 0) return 0;
  const d = DECAY[type];
  let v = strengths[j] * Math.exp(-(t - times[j]) / d);
  if (j > 0) v = Math.max(v, strengths[j - 1] * Math.exp(-(t - times[j - 1]) / d));
  return v;
}

function phaseInfo(beats, downbeatPhase, bpm, t) {
  const period = 60 / (bpm || 120);
  if (!beats.length) {
    const p = t / period;
    return { beatIndex: Math.floor(p), beatPhase: p - Math.floor(p), barPhase: ((p / 4) % 1 + 1) % 1 };
  }
  let j = lastIndexAtOrBefore(beats, t);
  let beatPhase;
  if (j < 0) {
    const p = (t - beats[0]) / period;               // before the first beat
    j = Math.floor(p);
    beatPhase = p - j;
  } else if (j >= beats.length - 1) {
    const p = (t - beats[beats.length - 1]) / period; // after the last beat
    beatPhase = p - Math.floor(p);
    j = beats.length - 1 + Math.floor(p);
  } else {
    beatPhase = (t - beats[j]) / (beats[j + 1] - beats[j]);
  }
  const inBar = (((j - downbeatPhase) % 4) + 4) % 4;
  return { beatIndex: j, beatPhase, barPhase: (inBar + beatPhase) / 4 };
}

function series(times, strengths) {
  return { times: Float64Array.from(times), strengths: Float32Array.from(strengths ?? times.map(() => 1)) };
}

function mergeStream(byType) {
  const stream = [];
  for (const type in byType) {
    const { times, strengths } = byType[type];
    for (let i = 0; i < times.length; i++) stream.push({ t: times[i], type, i, s: strengths[i] });
  }
  stream.sort((a, b) => a.t - b.t || TRIGGERS.indexOf(a.type) - TRIGGERS.indexOf(b.type));
  return stream;
}

// Beat-grid derived event series
function gridSeries(beats, downbeatPhase, sections) {
  const beat = [], half = [], bar = [], bar2 = [], bar4 = [];
  for (let i = 0; i < beats.length; i++) {
    beat.push(beats[i]);
    if (i + 1 < beats.length) half.push((beats[i] + beats[i + 1]) / 2);
    if (i >= downbeatPhase && (i - downbeatPhase) % 4 === 0) {
      const b = (i - downbeatPhase) / 4;
      bar.push(beats[i]);
      if (b % 2 === 0) bar2.push(beats[i]);
      if (b % 4 === 0) bar4.push(beats[i]);
    }
  }
  const strong = (arr, s) => series(arr, arr.map(() => s));
  return {
    beat: strong(beat, 1), half: strong(half, 0.6), bar: strong(bar, 1), bar2: strong(bar2, 1), bar4: strong(bar4, 1),
    section: strong(sections.filter(t => t > 0.05), 1),
  };
}

export class TrackSignals {
  constructor(analysis) {
    this.a = analysis;
    this.mode = 'track';
    this.opts = { sens: { kick: 0.5, snare: 0.5, hat: 0.5 }, bpm: 0, shift: 0 };
    this.rebuild();
  }

  // opts: { sens:{kick,snare,hat}, bpm: override (0 = auto), shift: downbeat shift in beats }
  rebuild(opts = {}) {
    Object.assign(this.opts, opts);
    const a = this.a;
    const grid = this.opts.bpm ? track(a, this.opts.bpm) : { beats: a.beats, downbeatPhase: a.downbeatPhase, sections: a.sections, bpm: a.bpm };
    this.bpm = grid.bpm;
    this.beats = grid.beats;
    this.downbeatPhase = (((grid.downbeatPhase + this.opts.shift) % 4) + 4) % 4;
    this.sections = grid.sections;
    const drums = detectDrums(a, this.opts.sens);
    this.byType = { ...drums, ...gridSeries(this.beats, this.downbeatPhase, this.sections) };
    this.stream = mergeStream(this.byType);
    this.version = (this.version || 0) + 1;
  }

  env(name, t) {
    const e = this.a.env[name === 'level' ? 'rms' : name];
    const x = Math.max(0, Math.min(e.length - 1, t * FPS));
    const i = Math.floor(x), f = x - i;
    return e[i] * (1 - f) + (e[Math.min(e.length - 1, i + 1)] ?? 0) * f;
  }

  sample(t) {
    const pulse = {};
    for (const type of TRIGGERS) pulse[type] = pulseAt(this.byType[type], type, t);
    const env = { low: this.env('low', t), mid: this.env('mid', t), high: this.env('high', t), level: this.env('level', t) };
    return { t, pulse, env, bpm: this.bpm, ...phaseInfo(this.beats, this.downbeatPhase, this.bpm, t) };
  }
}

// ─── Live (microphone) ────────────────────────────────────────────────────

const LIVE_BANDS = { kick: [30, 140], snare: [180, 3500], hat: [6000, 12000] };
const LIVE_ENV = { low: [20, 160], mid: [160, 2500], high: [2500, 12000] };

export class LiveSignals {
  constructor(ctx, node) {
    this.mode = 'live';
    this.ctx = ctx;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0;
    node.connect(this.analyser);
    const bins = this.analyser.frequencyBinCount;
    this.db = new Float32Array(bins);
    this.cur = new Float32Array(bins);
    this.prev = new Float32Array(bins);
    const binHz = ctx.sampleRate / this.analyser.fftSize;
    const rng = ([lo, hi]) => [Math.max(1, Math.floor(lo / binHz)), Math.min(bins - 1, Math.ceil(hi / binHz))];
    this.bandBins = Object.fromEntries(Object.entries(LIVE_BANDS).map(([k, v]) => [k, rng(v)]));
    this.envBins = Object.fromEntries(Object.entries(LIVE_ENV).map(([k, v]) => [k, rng(v)]));

    this.stats = {};
    for (const k in LIVE_BANDS) this.stats[k] = { mean: 0, dev: 0.01, peak: 0.05, last: -1, armed: true };
    this.envState = {};
    for (const k of ['low', 'mid', 'high', 'level']) this.envState[k] = { top: -40, v: 0 };

    this.byType = {};
    for (const k of TRIGGERS) this.byType[k] = { times: [], strengths: [] };
    this.stream = [];
    this.counts = Object.fromEntries(TRIGGERS.map(k => [k, 0]));

    this.hist = [];            // [t, onset] for tempo estimation
    this.bpm = 120;
    this.bpmCandidate = 0;
    this.nextBeat = 0;
    this.beatCount = 0;
    this.lastTempoAt = 0;
    this.lastT = 0;
    this.sens = { kick: 0.5, snare: 0.5, hat: 0.5 };
    this.version = 1;
  }

  rebuild(opts = {}) {
    if (opts.sens) this.sens = opts.sens;
    if (opts.bpm) this.bpm = opts.bpm;
  }

  emit(type, t, s) {
    const series = this.byType[type];
    series.times.push(t); series.strengths.push(s);
    this.stream.push({ t, type, i: this.counts[type]++, s });
  }

  prune(now) {
    const keep = now - 30;
    for (const k in this.byType) {
      const s = this.byType[k];
      let n = 0;
      while (n < s.times.length && s.times[n] < keep) n++;
      if (n) { s.times.splice(0, n); s.strengths.splice(0, n); }
    }
    if (this.stream.length > 4000) this.stream.splice(0, this.stream.length - 2000);
    if (this.hist.length && this.hist[0][0] < now - 10) this.hist.splice(0, this.hist.findIndex(h => h[0] >= now - 10));
  }

  update(now) {
    const dt = Math.min(0.1, Math.max(0.001, now - this.lastT));
    this.lastT = now;
    this.analyser.getFloatFrequencyData(this.db);
    const { db, cur, prev } = this;
    const bins = db.length;
    const eBand = { low: 0, mid: 0, high: 0 };
    let eAll = 0;
    for (let k = 0; k < bins; k++) {
      const m = Math.pow(10, (Number.isFinite(db[k]) ? db[k] : -160) / 20);
      cur[k] = Math.log1p(1000 * m);
      const p = m * m;
      eAll += p;
      for (const b in this.envBins) if (k >= this.envBins[b][0] && k <= this.envBins[b][1]) eBand[b] += p;
    }

    // Energy envelopes with a slowly decaying loudness reference (AGC)
    const levels = { ...eBand, level: eAll };
    const release = Math.exp(-dt / 0.12);
    for (const k in levels) {
      const st = this.envState[k];
      const d = 10 * Math.log10(levels[k] + 1e-12);
      st.top = Math.max(d, st.top - dt * 1.5);
      const v = Math.min(1, Math.max(0, 1 + (d - st.top) / 36)) ** 2;
      st.v = v > st.v ? v : st.v * release + v * (1 - release);
    }

    // Band flux (SuperFlux)
    const raw = {};
    for (const b in this.bandBins) {
      const [lo, hi] = this.bandBins[b];
      let s = 0;
      for (let k = lo; k <= hi; k++) {
        const pm = Math.max(prev[k], prev[k - 1] ?? 0, prev[k + 1] ?? 0);
        const d = cur[k] - pm;
        if (d > 0) s += d;
      }
      raw[b] = s / (hi - lo + 1);
    }
    prev.set(cur);

    // Adaptive thresholds: EMA mean + k·deviation, re-armed on the way down
    const a = 1 - Math.exp(-dt / 1.0);
    let combined = 0;
    const fired = {};
    for (const b in raw) {
      const st = this.stats[b], v = raw[b];
      st.peak = Math.max(v, st.peak * Math.exp(-dt / 8));
      const sens = this.sens[b] ?? 0.5;
      const thr = st.mean + (1.5 + (1 - sens) * 3) * st.dev;
      const gap = b === 'hat' ? 0.05 : 0.09;
      if (st.armed && v > thr && v > st.peak * (0.1 + (1 - sens) * 0.4) && now - st.last > gap && this.envState.level.v > 0.02) {
        fired[b] = Math.min(1, v / st.peak);
        st.last = now;
        st.armed = false;
      } else if (v < thr) st.armed = true;
      st.mean += a * (v - st.mean);
      st.dev += a * (Math.abs(v - st.mean) - st.dev);
      combined += v / (st.peak || 1);
    }
    const k = raw.kick, s = raw.snare, h = raw.hat;
    if (fired.kick && k >= 0.75 * s) this.emit('kick', now, fired.kick);
    if (fired.snare && s >= 0.75 * k && s >= 0.6 * h) this.emit('snare', now, fired.snare);
    if (fired.hat && h >= 1.8 * s) this.emit('hat', now, fired.hat);

    // Tempo: re-estimate from the last 8 s every 1.5 s
    this.hist.push([now, combined / 3]);
    if (now - this.lastTempoAt > 1.5 && this.hist.length > 50 && now - this.hist[0][0] > 5) {
      this.lastTempoAt = now;
      this.reestimateTempo(now);
    }

    // Beat clock: free-running at the estimated tempo, phase-corrected by kicks
    const period = 60 / this.bpm;
    if (!this.nextBeat || this.nextBeat < now - period) this.nextBeat = now + period;
    if (fired.kick || fired.snare) {
      const last = this.nextBeat - period;
      const err = Math.abs(now - last) < Math.abs(now - this.nextBeat) ? now - last : now - this.nextBeat;
      if (Math.abs(err) < 0.2 * period) this.nextBeat += err * 0.3;
    }
    while (now >= this.nextBeat) {
      const bt = this.nextBeat;
      this.emit('beat', bt, 1);
      if (this.beatCount % 4 === 0) {
        const bar = this.beatCount / 4;
        this.emit('bar', bt, 1);
        if (bar % 2 === 0) this.emit('bar2', bt, 1);
        if (bar % 4 === 0) this.emit('bar4', bt, 1);
      }
      this.beatCount++;
      this.pendingHalf = bt + period / 2;
      this.nextBeat += period;
    }
    if (this.pendingHalf && now >= this.pendingHalf) { this.emit('half', this.pendingHalf, 0.6); this.pendingHalf = 0; }

    this.prune(now);
  }

  reestimateTempo(now) {
    const n = 800, start = now - 8;
    const env = new Float32Array(n);
    let j = 0;
    for (let i = 0; i < n; i++) {
      const t = start + i / FPS;
      while (j + 1 < this.hist.length && this.hist[j + 1][0] <= t) j++;
      env[i] = this.hist[j] && this.hist[j][0] <= t ? this.hist[j][1] : 0;
    }
    const est = estimateTempo(env, FPS);
    if (est.confidence < 0.3) return;
    let bpm = est.bpm;
    while (bpm < 80) bpm *= 2;
    while (bpm > 175) bpm /= 2;
    if (Math.abs(bpm - this.bpm) / this.bpm < 0.04) this.bpm = this.bpm * 0.7 + bpm * 0.3;
    else if (this.bpmCandidate && Math.abs(bpm - this.bpmCandidate) / bpm < 0.04) { this.bpm = bpm; this.bpmCandidate = 0; }
    else this.bpmCandidate = bpm;
  }

  sample(t) {
    const pulse = {};
    for (const type of TRIGGERS) pulse[type] = pulseAt(this.byType[type], type, t);
    const env = {};
    for (const k in this.envState) env[k] = this.envState[k].v;
    const period = 60 / this.bpm;
    const beatPhase = Math.min(0.999, Math.max(0, 1 - (this.nextBeat - t) / period));
    const inBar = ((this.beatCount - 1) % 4 + 4) % 4;
    return { t, pulse, env, bpm: this.bpm, beatIndex: this.beatCount - 1, beatPhase, barPhase: (inBar + beatPhase) / 4 };
  }
}
