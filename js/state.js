// Settings model, built-in palettes/looks, and persistence.

export const FORMATS = {
  '1080x1350': { w: 1080, h: 1350, label: '4:5 · 1080×1350' },
  '1080x1440': { w: 1080, h: 1440, label: '3:4 · 1080×1440' },
  '1080x1920': { w: 1080, h: 1920, label: '9:16 · 1080×1920' },
  '1080x1080': { w: 1080, h: 1080, label: '1:1 · 1080×1080' },
  '1920x1080': { w: 1920, h: 1080, label: '16:9 · 1920×1080' },
};

export const STYLES = [
  { id: 'pixel',    label: 'Pixel' },
  { id: 'dither',   label: 'Dither' },
  { id: 'halftone', label: 'Halftone' },
  { id: 'lines',    label: 'Lines' },
  { id: 'ascii',    label: 'ASCII' },
  { id: 'edge',     label: 'Edge' },
];

// Palettes run shadows → highlights.
export const PALETTES = [
  { id: 'raging',    name: 'Raging',    colors: ['#000000', '#ff1a1a'] },
  { id: 'mono',      name: 'Mono',      colors: ['#000000', '#ffffff'] },
  { id: 'newsprint', name: 'Newsprint', colors: ['#1b1b1b', '#f2ede4'] },
  { id: 'acid',      name: 'Acid',      colors: ['#0018ff', '#d4ff00'] },
  { id: 'terminal',  name: 'Terminal',  colors: ['#000000', '#00ff66'] },
  { id: 'riso',      name: 'Riso',      colors: ['#1d3fbb', '#ff48b0', '#f5efe0'] },
  { id: 'ember',     name: 'Ember',     colors: ['#000000', '#9e0000', '#ff6a00', '#ffe14d'] },
  { id: 'infra',     name: 'Infra',     colors: ['#05001a', '#7a00ff', '#ff2e63', '#ffd166'] },
  { id: 'blueprint', name: 'Blueprint', colors: ['#0b2a6b', '#e6f0ff'] },
  { id: 'gameboy',   name: 'Gameboy',   colors: ['#0f380f', '#306230', '#8bac0f', '#9bbc0f'] },
  { id: 'vapor',     name: 'Vapor',     colors: ['#1a0033', '#ff00aa', '#00e5ff'] },
  { id: 'bone',      name: 'Bone',      colors: ['#111111', '#8a8170', '#e8e2d0'] },
];

export const GLYPH_SETS = {
  classic: ' .:-=+*#%@',
  blocks:  ' ░▒▓█',
  dense:   " .'`^\",:;Il!i><~+_-?][}{1)(|/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$",
  binary:  ' 01',
  slash:   ' ./\\|X',
};

export const CELL_STEPS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128];

export const FX = [
  { id: 'zoom',    label: 'Zoom punch' },
  { id: 'shake',   label: 'Shake' },
  { id: 'rgb',     label: 'RGB split' },
  { id: 'glitch',  label: 'Glitch' },
  { id: 'warp',    label: 'Warp' },
  { id: 'trails',  label: 'Trails' },
  { id: 'flash',   label: 'Flash' },
  { id: 'scan',    label: 'Scanlines' },
  { id: 'grain',   label: 'Grain' },
  { id: 'cellmod', label: 'Cell pump' },
];

export const DEFAULTS = {
  format: '1080x1350',
  seed: 7,
  look: {
    style: 'pixel',
    palette: ['#000000', '#ff1a1a'],
    sourceColor: false,
    levels: 2,
    cell: 4,
    dither: 'bayer',
    angle: 45,
    shape: 'circle',
    ink: 'light',      // halftone/lines/ascii: draw marks in the light or dark colour
    glyphs: 'classic',
    mirror: 'none',
  },
  fx: {
    zoom:    { amt: 0.35, src: 'kick' },
    shake:   { amt: 0,    src: 'snare' },
    rgb:     { amt: 0.2,  src: 'snare' },
    glitch:  { amt: 0,    src: 'hat' },
    warp:    { amt: 0,    src: 'low' },
    trails:  { amt: 0,    src: 'none' },
    flash:   { amt: 0,    src: 'bar4' },
    scan:    { amt: 0,    src: 'none' },
    grain:   { amt: 0.1,  src: 'none' },
    cellmod: { amt: 0,    src: 'low' },
  },
  actions: {
    media:   { on: 'bar',  order: 'random', dwell: 0 },
    cell:    { on: 'beat', min: 2, max: 64, mode: 'random' },
    palette: { on: 'off',  pool: ['raging', 'mono', 'acid', 'terminal'] },
    style:   { on: 'off',  pool: ['pixel', 'dither', 'halftone'] },
    flip:    { on: 'off' },
  },
  audio: {
    sync: 0,
    sens: { kick: 0.5, snare: 0.5, hat: 0.5 },
    bpm: 0,
    shift: 0,
    loop: true,
    volume: 1,
  },
  export: { fps: 30, quality: 'high', container: 'auto' },
};

export const LOOKS = [
  {
    id: 'raging', name: 'Raging',
    patch: {
      look: { style: 'pixel', palette: ['#000000', '#ff1a1a'], sourceColor: false, levels: 2, cell: 4, ink: 'light', mirror: 'none' },
      fx: { zoom: { amt: 0.35, src: 'kick' }, rgb: { amt: 0.2, src: 'snare' }, shake: { amt: 0 }, glitch: { amt: 0 }, warp: { amt: 0 }, trails: { amt: 0 }, flash: { amt: 0 }, scan: { amt: 0 }, grain: { amt: 0.1, src: 'none' }, cellmod: { amt: 0 } },
      actions: { cell: { on: 'beat', min: 2, max: 64, mode: 'random' }, palette: { on: 'off' }, style: { on: 'off' }, flip: { on: 'off' } },
    },
  },
  {
    id: 'newsprint', name: 'Newsprint',
    patch: {
      look: { style: 'halftone', palette: ['#1b1b1b', '#f2ede4'], sourceColor: false, levels: 2, cell: 12, angle: 45, shape: 'circle', ink: 'dark', mirror: 'none' },
      fx: { zoom: { amt: 0.2, src: 'kick' }, rgb: { amt: 0 }, shake: { amt: 0.15, src: 'snare' }, glitch: { amt: 0 }, warp: { amt: 0 }, trails: { amt: 0 }, flash: { amt: 0 }, scan: { amt: 0 }, grain: { amt: 0.25, src: 'none' }, cellmod: { amt: 0.4, src: 'low' } },
      actions: { cell: { on: 'bar', min: 8, max: 32, mode: 'random' }, palette: { on: 'off' }, style: { on: 'off' }, flip: { on: 'off' } },
    },
  },
  {
    id: 'terminal', name: 'Terminal',
    patch: {
      look: { style: 'ascii', palette: ['#000000', '#00ff66'], sourceColor: false, levels: 4, cell: 12, glyphs: 'classic', ink: 'light', mirror: 'none' },
      fx: { zoom: { amt: 0.15, src: 'kick' }, rgb: { amt: 0.3, src: 'snare' }, shake: { amt: 0 }, glitch: { amt: 0.5, src: 'snare' }, warp: { amt: 0 }, trails: { amt: 0.4, src: 'none' }, flash: { amt: 0 }, scan: { amt: 0.5, src: 'none' }, grain: { amt: 0.1, src: 'none' }, cellmod: { amt: 0 } },
      actions: { cell: { on: 'bar', min: 8, max: 24, mode: 'random' }, palette: { on: 'off' }, style: { on: 'off' }, flip: { on: 'off' } },
    },
  },
  {
    id: 'riso', name: 'Riso',
    patch: {
      look: { style: 'dither', palette: ['#1d3fbb', '#ff48b0', '#f5efe0'], sourceColor: false, levels: 3, cell: 3, dither: 'bayer', mirror: 'none' },
      fx: { zoom: { amt: 0.25, src: 'kick' }, rgb: { amt: 0.35, src: 'kick' }, shake: { amt: 0 }, glitch: { amt: 0 }, warp: { amt: 0.2, src: 'mid' }, trails: { amt: 0 }, flash: { amt: 0 }, scan: { amt: 0 }, grain: { amt: 0.15, src: 'none' }, cellmod: { amt: 0 } },
      actions: { cell: { on: 'bar', min: 2, max: 8, mode: 'random' }, palette: { on: 'off' }, style: { on: 'off' }, flip: { on: 'off' } },
    },
  },
  {
    id: 'engrave', name: 'Engrave',
    patch: {
      look: { style: 'lines', palette: ['#111111', '#e8e2d0'], sourceColor: false, levels: 2, cell: 8, angle: 0, ink: 'dark', mirror: 'none' },
      fx: { zoom: { amt: 0.2, src: 'kick' }, rgb: { amt: 0 }, shake: { amt: 0 }, glitch: { amt: 0 }, warp: { amt: 0.35, src: 'low' }, trails: { amt: 0 }, flash: { amt: 0 }, scan: { amt: 0 }, grain: { amt: 0.15, src: 'none' }, cellmod: { amt: 0.5, src: 'kick' } },
      actions: { cell: { on: 'off' }, palette: { on: 'off' }, style: { on: 'section', pool: ['lines', 'edge', 'halftone'] }, flip: { on: 'off' } },
    },
  },
  {
    id: 'rave', name: 'Rave',
    patch: {
      look: { style: 'pixel', palette: ['#0018ff', '#d4ff00'], sourceColor: false, levels: 2, cell: 8, ink: 'light', mirror: 'quad' },
      fx: { zoom: { amt: 0.5, src: 'kick' }, rgb: { amt: 0.5, src: 'snare' }, shake: { amt: 0.3, src: 'snare' }, glitch: { amt: 0.4, src: 'hat' }, warp: { amt: 0 }, trails: { amt: 0.5, src: 'none' }, flash: { amt: 0.6, src: 'bar' }, scan: { amt: 0 }, grain: { amt: 0.1, src: 'none' }, cellmod: { amt: 0 } },
      actions: { cell: { on: 'beat', min: 4, max: 64, mode: 'random' }, palette: { on: 'bar', pool: ['acid', 'raging', 'vapor', 'infra', 'terminal'] }, style: { on: 'bar4', pool: ['pixel', 'dither', 'halftone', 'ascii'] }, flip: { on: 'snare' } },
    },
  },
  {
    id: 'colour', name: 'Colour',
    patch: {
      look: { style: 'dither', sourceColor: true, levels: 3, cell: 2, dither: 'noise', mirror: 'none' },
      fx: { zoom: { amt: 0.3, src: 'kick' }, rgb: { amt: 0.25, src: 'snare' }, shake: { amt: 0 }, glitch: { amt: 0.2, src: 'hat' }, warp: { amt: 0 }, trails: { amt: 0 }, flash: { amt: 0 }, scan: { amt: 0 }, grain: { amt: 0.1, src: 'none' }, cellmod: { amt: 0 } },
      actions: { cell: { on: 'beat', min: 1, max: 16, mode: 'random' }, palette: { on: 'off' }, style: { on: 'off' }, flip: { on: 'off' } },
    },
  },
];

// ─── Store ────────────────────────────────────────────────────────────────

const KEY = 'raging-beat:v2';

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

export function deepMerge(base, patch) {
  const out = structuredClone(base);
  for (const k in patch) {
    if (isObj(patch[k]) && isObj(out[k])) out[k] = deepMerge(out[k], patch[k]);
    else out[k] = structuredClone(patch[k]);
  }
  return out;
}

export class Store extends EventTarget {
  constructor() {
    super();
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch {}
    this.data = saved ? deepMerge(DEFAULTS, saved) : structuredClone(DEFAULTS);
    this._saveTimer = 0;
  }

  get(path) {
    return path.split('.').reduce((o, k) => (o == null ? o : o[k]), this.data);
  }

  set(path, value) {
    const keys = path.split('.');
    let o = this.data;
    for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]] ??= {};
    o[keys[keys.length - 1]] = value;
    this.changed([path]);
  }

  patch(p) {
    this.data = deepMerge(this.data, p);
    this.changed(['*']);
  }

  reset() {
    this.data = structuredClone(DEFAULTS);
    this.changed(['*']);
  }

  changed(paths) {
    this.dispatchEvent(new CustomEvent('change', { detail: { paths } }));
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      try { localStorage.setItem(KEY, JSON.stringify(this.data)); } catch {}
    }, 300);
  }
}
