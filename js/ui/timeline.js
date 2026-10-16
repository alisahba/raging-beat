// Timeline: waveform, low-end energy, detected kick/snare/hat lanes, beat
// grid with bar numbers, sections, and the playhead. Click/drag to seek.

const COLORS = { kick: '#ff1a1a', snare: '#ffffff', hat: '#8a8a8a' };

export class Timeline {
  constructor(canvas, { onSeek }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onSeek = onSeek;
    this.signals = null;
    this.analysis = null;
    this.duration = 0;
    this.static = document.createElement('canvas');
    this.dirty = true;
    this.hover = -1;

    new ResizeObserver(() => { this.dirty = true; }).observe(canvas);

    let dragging = false;
    const seekAt = e => {
      const r = canvas.getBoundingClientRect();
      const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      if (this.duration) this.onSeek(x * this.duration);
    };
    canvas.addEventListener('pointerdown', e => { dragging = true; canvas.setPointerCapture(e.pointerId); seekAt(e); });
    canvas.addEventListener('pointermove', e => {
      const r = canvas.getBoundingClientRect();
      this.hover = (e.clientX - r.left) / r.width;
      if (dragging) seekAt(e);
    });
    canvas.addEventListener('pointerleave', () => { this.hover = -1; });
    canvas.addEventListener('pointerup', () => { dragging = false; });
  }

  setTrack(analysis, signals) {
    this.analysis = analysis;
    this.signals = signals;
    this.duration = analysis ? analysis.duration : 0;
    this.dirty = true;
  }

  invalidate() { this.dirty = true; }

  layout() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const hgt = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== hgt) {
      this.canvas.width = w; this.canvas.height = hgt;
      this.static.width = w; this.static.height = hgt;
    }
    return { w, h: hgt, dpr };
  }

  rows(h, dpr) {
    const ruler = Math.round(12 * dpr);
    const lanes = Math.round(Math.min(18, h / dpr * 0.28) * dpr);
    const wave = h - ruler - lanes;
    return { ruler, wave, lanes, laneY: ruler + wave };
  }

  drawStatic() {
    const { w, h, dpr } = this.layout();
    const c = this.static.getContext('2d');
    c.clearRect(0, 0, w, h);
    const a = this.analysis, s = this.signals;
    if (!a || !s) return;
    const { ruler, wave, lanes, laneY } = this.rows(h, dpr);
    const X = t => (t / this.duration) * w;

    // Sections
    const secs = s.sections || [];
    secs.forEach((t, i) => {
      const x0 = X(t), x1 = X(secs[i + 1] ?? this.duration);
      c.fillStyle = i % 2 ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0)';
      c.fillRect(x0, ruler, x1 - x0, wave);
      if (i > 0) { c.fillStyle = 'rgba(255,26,26,0.7)'; c.fillRect(Math.round(x0), ruler, Math.max(1, dpr), wave); }
    });

    // Waveform (min/max)
    const peaks = a.peaks, buckets = peaks.length / 2;
    const mid = ruler + wave / 2;
    c.fillStyle = '#3d3d3d';
    for (let x = 0; x < w; x++) {
      const b0 = Math.floor((x / w) * buckets), b1 = Math.max(b0 + 1, Math.floor(((x + 1) / w) * buckets));
      let lo = 0, hi = 0;
      for (let b = b0; b < b1 && b < buckets; b++) { lo = Math.min(lo, peaks[b * 2]); hi = Math.max(hi, peaks[b * 2 + 1]); }
      const y0 = mid - hi * wave * 0.48, y1 = mid - lo * wave * 0.48;
      c.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }

    // Low-end energy overlay
    const low = a.env.low;
    c.fillStyle = 'rgba(255,26,26,0.35)';
    for (let x = 0; x < w; x++) {
      const i = Math.floor((x / w) * low.length);
      const v = low[i] * wave * 0.48;
      c.fillRect(x, mid - v, 1, v * 2);
    }

    // Beat ruler
    const beats = s.beats || [];
    const pxPerBeat = beats.length > 1 ? w / beats.length : w;
    const barEvery = pxPerBeat * 4 < 18 * dpr ? (pxPerBeat * 16 < 18 * dpr ? 16 : 4) : 1;
    c.font = `${9 * dpr}px "DM Mono", monospace`;
    c.textBaseline = 'top';
    for (let i = 0; i < beats.length; i++) {
      const isBar = i >= s.downbeatPhase && (i - s.downbeatPhase) % 4 === 0;
      const bar = (i - s.downbeatPhase) / 4;
      const x = Math.round(X(beats[i]));
      if (isBar) {
        if (bar % barEvery === 0) {
          c.fillStyle = '#777';
          c.fillRect(x, 0, Math.max(1, dpr), ruler);
          if (bar % (barEvery * (pxPerBeat * 4 * barEvery < 40 * dpr ? 4 : 1)) === 0) {
            c.fillStyle = '#666';
            c.fillText(String(bar + 1), x + 3 * dpr, 1 * dpr);
          }
        }
      } else if (pxPerBeat > 4 * dpr) {
        c.fillStyle = '#333';
        c.fillRect(x, ruler * 0.6, Math.max(1, dpr * 0.75), ruler * 0.4);
      }
    }

    // Drum lanes
    const laneH = lanes / 3;
    ['kick', 'snare', 'hat'].forEach((k, li) => {
      const series = s.byType[k];
      if (!series) return;
      c.fillStyle = COLORS[k];
      for (let i = 0; i < series.times.length; i++) {
        const x = X(series.times[i]);
        const hh = Math.max(1, laneH * (0.35 + 0.65 * series.strengths[i]) - dpr);
        c.globalAlpha = 0.45 + 0.55 * series.strengths[i];
        c.fillRect(Math.round(x), laneY + li * laneH + (laneH - hh) / 2, Math.max(1, dpr), hh);
      }
      c.globalAlpha = 1;
    });
  }

  // Live (microphone) mode: scrolling last 8 seconds
  drawLive(now) {
    const { w, h, dpr } = this.layout();
    const c = this.ctx;
    c.clearRect(0, 0, w, h);
    const s = this.signals;
    if (!s) return;
    const span = 8;
    const X = t => w - ((now - t) / span) * w;
    const { ruler, wave, lanes, laneY } = this.rows(h, dpr);
    c.fillStyle = '#444';
    for (const t of s.byType.beat.times) if (now - t < span) c.fillRect(Math.round(X(t)), ruler * 0.5, dpr, ruler * 0.5);
    c.fillStyle = '#888';
    for (const t of s.byType.bar.times) if (now - t < span) c.fillRect(Math.round(X(t)), 0, dpr, ruler);
    const laneH = lanes / 3;
    ['kick', 'snare', 'hat'].forEach((k, li) => {
      const ser = s.byType[k];
      c.fillStyle = COLORS[k];
      for (let i = 0; i < ser.times.length; i++) {
        if (now - ser.times[i] > span) continue;
        c.fillRect(Math.round(X(ser.times[i])), laneY + li * laneH + 1, Math.max(2, dpr * 2), laneH - 2);
      }
    });
    // Level history bar
    const env = s.envState;
    const mid = ruler + wave / 2;
    c.fillStyle = 'rgba(255,26,26,0.5)';
    const v = env.low.v * wave * 0.48;
    c.fillRect(w - 6 * dpr, mid - v, 6 * dpr, v * 2);
    c.fillStyle = 'rgba(255,255,255,0.35)';
    const l = env.level.v * wave * 0.48;
    c.fillRect(w - 14 * dpr, mid - l, 6 * dpr, l * 2);
    c.fillStyle = '#555';
    c.font = `${9 * dpr}px "DM Mono", monospace`;
    c.textBaseline = 'middle';
    c.fillText('LIVE · LAST 8 S', 4 * dpr, mid);
  }

  draw(t) {
    if (this.signals && this.signals.mode === 'live') return this.drawLive(t);
    if (this.dirty) { this.drawStatic(); this.dirty = false; }
    const { w, h, dpr } = this.layout();
    const c = this.ctx;
    c.clearRect(0, 0, w, h);
    c.drawImage(this.static, 0, 0);
    if (!this.duration) return;
    const x = Math.round((t / this.duration) * w);
    c.fillStyle = 'rgba(0,0,0,0.45)';
    c.fillRect(x, 0, w - x, h);
    c.fillStyle = '#fff';
    c.fillRect(x, 0, Math.max(1, dpr), h);
    if (this.hover >= 0) {
      c.fillStyle = 'rgba(255,255,255,0.25)';
      c.fillRect(Math.round(this.hover * w), 0, Math.max(1, dpr), h);
    }
  }
}
