// The Director turns musical events into discrete visual decisions: which
// media is up, the current cell size, palette, style, and whether the image
// is flipped. It is a pure fold over the time-ordered event stream with
// hashed randomness, so the state at any time t is reproducible — scrubbing
// back and forth or exporting gives exactly what the preview showed.

import { hash } from '../prng.js';
import { CELL_STEPS, PALETTES } from '../state.js';

const ACTION_IDS = { media: 1, cell: 2, palette: 3, style: 4, flip: 5 };

// Random pick in [0, n) that differs from prev when n > 1
function pickOther(n, prev, r) {
  if (n <= 1) return 0;
  if (prev < 0 || prev >= n) return Math.floor(r * n);
  return (prev + 1 + Math.floor(r * (n - 1))) % n;
}

export class Director {
  constructor() {
    this.base = { media: 0 };
    this.reset();
  }

  reset() {
    this.cursor = 0;
    this.lastT = -Infinity;
    this.s = {
      media: this.base.media,
      lastMediaSwitch: -Infinity,
      cell: null,
      palette: null,
      style: null,
      flip: false,
      n: { media: 0, cell: 0, palette: 0, style: 0, flip: 0 },
    };
  }

  // Jump to a specific media index (manual selection) from now on
  setMedia(i) {
    this.base.media = i;
    this.s.media = i;
  }

  // ctx: { mediaCount, settings, seed, live }
  advance(stream, t, ctx) {
    if (!ctx.live && t < this.lastT - 1e-6) this.reset();
    if (ctx.live && this.cursor > stream.length) this.cursor = stream.length;
    while (this.cursor < stream.length && stream[this.cursor].t <= t) {
      this.apply(stream[this.cursor], ctx);
      this.cursor++;
    }
    this.lastT = t;
    return this.s;
  }

  apply(ev, { mediaCount, settings, seed }) {
    const A = settings.actions, s = this.s;
    const rnd = (id, k) => hash(seed, ACTION_IDS[id], k);

    if (A.media.on === ev.type && mediaCount > 1 && ev.t - s.lastMediaSwitch >= A.media.dwell) {
      const k = s.n.media++;
      s.media = A.media.order === 'sequence'
        ? (s.media + 1) % mediaCount
        : pickOther(mediaCount, s.media % mediaCount, rnd('media', k));
      s.lastMediaSwitch = ev.t;
    }

    if (A.cell.on === ev.type) {
      const steps = CELL_STEPS.filter(c => c >= A.cell.min && c <= A.cell.max);
      if (steps.length) {
        const k = s.n.cell++;
        const cur = steps.indexOf(s.cell);
        let i;
        if (A.cell.mode === 'up') i = (cur + 1) % steps.length;
        else if (A.cell.mode === 'down') i = cur <= 0 ? steps.length - 1 : cur - 1;
        else if (A.cell.mode === 'pingpong') {
          const span = Math.max(1, steps.length - 1), p = k % (2 * span);
          i = p <= span ? p : 2 * span - p;
        } else i = pickOther(steps.length, cur, rnd('cell', k));
        s.cell = steps[i];
      }
    }

    if (A.palette.on === ev.type) {
      const pool = (A.palette.pool || []).filter(id => PALETTES.some(p => p.id === id));
      if (pool.length) {
        const k = s.n.palette++;
        const cur = pool.indexOf(s.palette);
        s.palette = pool[pickOther(pool.length, cur, rnd('palette', k))];
      }
    }

    if (A.style.on === ev.type) {
      const pool = A.style.pool || [];
      if (pool.length) {
        const k = s.n.style++;
        const cur = pool.indexOf(s.style);
        s.style = pool[pickOther(pool.length, cur, rnd('style', k))];
      }
    }

    if (A.flip.on === ev.type) {
      s.n.flip++;
      s.flip = !s.flip;
    }
  }
}
