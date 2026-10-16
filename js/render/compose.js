// compose(): settings + signals + director state → renderer parameters.

import { hash, noise1 } from '../prng.js';
import { PALETTES } from '../state.js';
import { hexToRgb } from './renderer.js';

export function signalValue(frame, src) {
  if (src === 'none') return 1;
  if (!frame) return 0;
  if (src in frame.pulse) return frame.pulse[src];
  if (src in frame.env) return frame.env[src];
  if (src === 'phase') return 1 - frame.beatPhase;
  if (src === 'barphase') return 1 - frame.barPhase;
  return 0;
}

const lum = hex => { const [r, g, b] = hexToRgb(hex); return 0.299 * r + 0.587 * g + 0.114 * b; };

export function compose({ settings, frame, dir, media, t, dt, W, H }) {
  const L = settings.look, F = settings.fx, A = settings.actions;
  const sig = id => F[id].amt * signalValue(frame, F[id].src);
  const seed = settings.seed;

  const palette = dir.palette ? PALETTES.find(p => p.id === dir.palette)?.colors ?? L.palette : L.palette;
  const style = A.style.on !== 'off' && dir.style ? dir.style : L.style;
  let cell = A.cell.on !== 'off' && dir.cell ? dir.cell : L.cell;
  cell *= 1 + sig('cellmod') * 2;

  const zoom = 1 + sig('zoom') * 0.28;
  const sh = sig('shake');
  const beatK = frame ? frame.beatIndex : 0;
  const offset = [noise1(seed + 11, t * 9) * sh * 0.05, noise1(seed + 12, t * 9) * sh * 0.05];
  const rot = noise1(seed + 13, t * 7) * sh * 0.06;

  // RGB split direction re-rolls every beat
  const ang = hash(seed, 21, beatK) * Math.PI * 2;
  const rgbAmt = sig('rgb') * 0.012;
  const rgb = [Math.cos(ang) * rgbAmt * (H / W), Math.sin(ang) * rgbAmt];

  // Trails: persistence normalised to 30 fps so preview and export match
  const trailAmt = F.trails.amt * (F.trails.src === 'none' ? 1 : 0.3 + 0.7 * signalValue(frame, F.trails.src));
  const trails = trailAmt > 0 ? Math.pow(Math.min(0.97, 0.55 + trailAmt * 0.42), dt * 30) : 0;

  const tone = media?.tone ?? { black: 0, white: 255, gamma: 1 };
  const dark = palette[0], light = palette[palette.length - 1];

  return {
    media,
    fit: media?.fit ?? 'cover',
    frame: media?.frame ?? { zoom: 1, x: 0, y: 0 },
    tone,
    zoom, rot, offset,
    mirror: L.mirror,
    warp: sig('warp'),
    time: t,
    glitch: Math.min(1, sig('glitch')),
    glitchSeed: Math.floor(t * 18) % 997 + hash(seed, 31, beatK) * 100,
    style,
    cell: Math.max(1, cell),
    levels: L.levels,
    palette,
    sourceColor: L.sourceColor,
    dither: L.dither,
    angle: L.angle,
    shape: L.shape,
    ink: L.ink,
    glyphs: L.glyphs,
    flip: dir.flip,
    rgb,
    trails,
    trailMode: lum(dark) <= lum(light) ? 0 : 1,
    flash: sig('flash'),
    flashColor: dir.flip ? dark : light,
    scan: sig('scan'),
    grain: sig('grain'),
    grainSeed: Math.floor(t * 30) % 1000,
  };
}
