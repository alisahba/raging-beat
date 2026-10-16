// Media library: up to 12 images/videos, each with its own tone and fit.

export const MAX_SLOTS = 12;

let nextId = 1;

function thumbCanvas(el, w, h, size = 96) {
  const c = document.createElement('canvas');
  const s = size / Math.max(w, h);
  c.width = Math.max(1, Math.round(w * s));
  c.height = Math.max(1, Math.round(h * s));
  c.getContext('2d', { willReadFrequently: true }).drawImage(el, 0, 0, c.width, c.height);
  return c;
}

// Auto levels: black/white points at the 1st/99th luminance percentiles,
// plus half (in log terms) of the gamma that would put the median at
// mid-grey — enough to rescue a dark or flat photo without flattening the
// subject when a big background dominates the histogram.
export function autoTone(el) {
  const w = el.videoWidth || el.naturalWidth || el.width, h = el.videoHeight || el.naturalHeight || el.height;
  const c = thumbCanvas(el, w, h, 160);
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) hist[Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2])]++;
  const n = d.length / 4;
  const pct = p => { let acc = 0; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= p * n) return v; } return 255; };
  let black = pct(0.01), white = pct(0.99);
  if (white - black < 24) { black = Math.max(0, black - 12); white = Math.min(255, white + 12); }
  const x = Math.min(0.95, Math.max(0.05, (pct(0.5) - black) / (white - black)));
  const gamma = Math.min(1.8, Math.max(0.55, Math.sqrt(Math.log(x) / Math.log(0.5))));
  return { black, white, gamma: Math.round(gamma * 100) / 100 };
}

export async function loadImage(src) {
  const img = new Image();
  img.decoding = 'async';
  img.src = src;
  await img.decode();
  return img;
}

async function loadVideo(url) {
  const v = document.createElement('video');
  v.src = url;
  v.muted = true;
  v.loop = true;
  v.playsInline = true;
  v.preload = 'auto';
  await new Promise((resolve, reject) => {
    v.addEventListener('loadeddata', resolve, { once: true });
    v.addEventListener('error', () => reject(new Error('Could not decode video')), { once: true });
  });
  return v;
}

export class MediaLibrary extends EventTarget {
  constructor() {
    super();
    this.slots = [];
    this.fallback = null;   // built-in default image
  }

  async setFallback(src) {
    const el = await loadImage(src);
    this.fallback = {
      id: 0, type: 'image', name: 'Default', el,
      tone: { black: 0, white: 165, gamma: 1 }, fit: 'cover', frame: { zoom: 1, x: 0, y: 0 }, builtin: true,
    };
    this.dispatchEvent(new Event('change'));
  }

  get playlist() { return this.slots.length ? this.slots : this.fallback ? [this.fallback] : []; }

  async addFiles(files) {
    const added = [];
    for (const file of files) {
      if (this.slots.length >= MAX_SLOTS) break;
      const isVideo = file.type.startsWith('video/');
      if (!isVideo && !file.type.startsWith('image/')) continue;
      const url = URL.createObjectURL(file);
      try {
        let slot;
        if (isVideo) {
          const el = await loadVideo(url);
          el.play().catch(() => {});
          slot = { type: 'video', el, thumb: thumbCanvas(el, el.videoWidth, el.videoHeight).toDataURL('image/jpeg', 0.7) };
        } else {
          const el = await loadImage(url);
          slot = { type: 'image', el, thumb: thumbCanvas(el, el.naturalWidth, el.naturalHeight).toDataURL('image/jpeg', 0.7) };
        }
        Object.assign(slot, { id: nextId++, name: file.name, url, tone: autoTone(slot.el), fit: 'cover', frame: { zoom: 1, x: 0, y: 0 } });
        this.slots.push(slot);
        added.push(slot);
      } catch (e) {
        URL.revokeObjectURL(url);
        console.warn('Skipping', file.name, e);
      }
    }
    if (added.length) this.dispatchEvent(new Event('change'));
    return added;
  }

  remove(id) {
    const i = this.slots.findIndex(s => s.id === id);
    if (i < 0) return null;
    const [slot] = this.slots.splice(i, 1);
    if (slot.type === 'video') { slot.el.pause(); slot.el.removeAttribute('src'); slot.el.load(); }
    URL.revokeObjectURL(slot.url);
    this.dispatchEvent(new Event('change'));
    return slot;
  }

  move(id, delta) {
    const i = this.slots.findIndex(s => s.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= this.slots.length) return;
    [this.slots[i], this.slots[j]] = [this.slots[j], this.slots[i]];
    this.dispatchEvent(new Event('change'));
  }

  hasVideo() { return this.slots.some(s => s.type === 'video'); }

  setPlaying(on) {
    for (const s of this.slots) if (s.type === 'video') on ? s.el.play().catch(() => {}) : s.el.pause();
  }

  // Export: put a video exactly on the frame for time t
  async seekVideo(slot, t) {
    if (!slot || slot.type !== 'video') return;
    const v = slot.el;
    const target = v.duration ? t % v.duration : 0;
    if (!v.paused) v.pause();
    if (Math.abs(v.currentTime - target) < 1e-3 && v.readyState >= 2) return;
    await new Promise(resolve => {
      const done = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(done, 2000);
      v.addEventListener('seeked', done, { once: true });
      v.currentTime = target;
    });
  }
}
