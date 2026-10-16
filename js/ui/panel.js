// Control panel. Sections are rebuilt from the store; controls write back
// through store.set(), and the render loop reads the store every frame.

import { h, section, row, slider, dual, segmented, select, chips, paletteSwatch } from './controls.js';
import { STYLES, PALETTES, LOOKS, FX, CELL_STEPS, GLYPH_SETS } from '../state.js';
import { SOURCES } from '../audio/signals.js';
import { autoTone } from '../render/media.js';

const SOURCE_LABELS = {
  none: 'Constant', kick: 'Kick', snare: 'Snare', hat: 'Hat', beat: 'Beat', half: 'Off-beat',
  bar: 'Bar', bar2: '2 bars', bar4: '4 bars', section: 'Section', low: 'Bass level', mid: 'Mid level',
  high: 'High level', level: 'Loudness', phase: 'Beat ramp', barphase: 'Bar ramp',
};
const TRIGGER_OPTS = [
  ['off', 'Off'], ['beat', 'Every beat'], ['half', 'Off-beats'], ['bar', 'Every bar'], ['bar2', 'Every 2 bars'],
  ['bar4', 'Every 4 bars'], ['kick', 'Kick'], ['snare', 'Snare'], ['hat', 'Hat'], ['section', 'Section change'],
].map(([id, label]) => ({ id, label }));

const pct = v => Math.round(v * 100) + '%';
const cellIndex = v => {
  let best = 0;
  CELL_STEPS.forEach((c, i) => { if (Math.abs(c - v) < Math.abs(CELL_STEPS[best] - v)) best = i; });
  return best;
};

export class Panel {
  constructor(el, app) {
    this.el = el;
    this.app = app;
    this.open = new Set(['looks', 'media', 'audio', 'look', 'react', 'beat']);
    el.addEventListener('toggle', e => {
      if (e.detail.open) this.open.add(e.detail.id); else this.open.delete(e.detail.id);
    });
  }

  get s() { return this.app.store.data; }
  set(path, v) { this.app.store.set(path, v); }

  render() {
    const top = this.el.scrollTop;
    this.el.replaceChildren(
      this.looksSection(), this.mediaSection(), this.audioSection(),
      this.lookSection(), this.reactSection(), this.beatSection(),
    );
    this.el.scrollTop = top;
  }

  refresh(id) {
    const old = this.el.querySelector(`[data-sec="${id}"]`);
    if (!old) return;
    const fresh = this[id + 'Section']();
    old.replaceWith(fresh);
  }

  sec(id, title, extra, ...content) {
    return section(id, title, { open: this.open.has(id), extra }, ...content);
  }

  // ─── Looks ──────────────────────────────────────────────────────────────
  looksSection() {
    const grid = h('div', { class: 'looks' }, LOOKS.map(l =>
      h('button', { type: 'button', class: 'chip', onclick: () => this.app.applyLook(l) }, l.name)));
    grid.append(h('button', { type: 'button', class: 'chip', title: 'Shuffle (S)', onclick: () => this.app.shuffle() }, 'Shuffle'));
    return this.sec('looks', 'Looks', null,
      grid,
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn', onclick: () => this.app.resetSettings() }, 'Reset all'),
        h('button', { type: 'button', class: 'btn', onclick: () => this.app.newSeed() }, 'New seed')));
  }

  // ─── Media ──────────────────────────────────────────────────────────────
  mediaSection() {
    const lib = this.app.lib;
    const shown = this.app.currentMedia;
    const sel = lib.slots.find(s => s.id === this.app.selectedSlot) || null;
    const slots = h('div', { class: 'slots' });
    lib.slots.forEach((slot, i) => {
      const el = h('button', {
        type: 'button',
        class: 'slot' + (sel === slot ? ' sel' : '') + (shown === slot ? ' live' : ''),
        title: slot.name,
        style: { backgroundImage: `url("${slot.thumb}")` },
        onclick: () => this.app.selectSlot(slot.id),
      }, slot.type === 'video' ? h('span', { class: 'vid' }, 'VID') : null, String(i + 1));
      slots.append(el);
    });
    if (lib.slots.length < 12) slots.append(h('button', { type: 'button', class: 'slot add', title: 'Add images or videos', onclick: () => this.app.pickMedia() }, '+'));

    const body = [slots];
    if (sel) {
      const levels = dual({
        min: 0, max: 255, lo: sel.tone.black, hi: sel.tone.white, label: 'Levels',
        onInput: (lo, hi) => { sel.tone.black = lo; sel.tone.white = hi; this.app.requestRender(); },
      });
      const gamma = slider({
        min: 0.3, max: 3, step: 0.05, value: sel.tone.gamma, format: v => v.toFixed(2), label: 'Gamma',
        onInput: v => { sel.tone.gamma = v; this.app.requestRender(); },
      });
      const fr = sel.frame;
      const frameSlider = (key, min, max, label, fmt) => {
        const sl = slider({ min, max, step: 0.01, value: fr[key], format: fmt, label, onInput: v => { fr[key] = v; } });
        return row(label, sl, { value: sl.valueEl });
      };
      const signed = v => (v > 0 ? '+' : '') + Math.round(v * 100);
      const auto = h('button', { type: 'button', class: 'btn', title: 'Auto levels', onclick: () => { sel.tone = autoTone(sel.el); this.refresh('media'); } }, 'Auto');
      body.push(
        row('Levels', levels, { value: h('span', { style: { display: 'flex', gap: '10px', alignItems: 'baseline' } }, levels.valueEl, auto) }),
        row('Gamma', gamma, { value: gamma.valueEl }),
        h('div', { class: 'grid3' },
          frameSlider('zoom', 1, 3, 'Zoom', v => v.toFixed(2) + '×'),
          frameSlider('x', -1, 1, 'Pan X', signed),
          frameSlider('y', -1, 1, 'Pan Y', signed)),
        h('div', { class: 'grid2' },
          row('Fit', segmented(['cover', 'contain'], sel.fit, v => { sel.fit = v; this.app.requestRender(); })),
          row('Order', h('div', { class: 'btn-row' },
            h('button', { type: 'button', class: 'btn', title: 'Move earlier', onclick: () => lib.move(sel.id, -1) }, '←'),
            h('button', { type: 'button', class: 'btn', title: 'Move later', onclick: () => lib.move(sel.id, 1) }, '→'),
            h('button', { type: 'button', class: 'btn', onclick: () => this.app.removeSlot(sel.id) }, 'Remove')))),
      );
    } else if (!lib.slots.length) {
      body.push(h('div', { class: 'hint' }, 'Add up to 12 images or videos. Drop them anywhere on the page. They rotate on the beat (see “On the beat”).'));
    } else {
      body.push(h('div', { class: 'hint' }, 'Select a slot to adjust its levels.'));
    }
    return this.sec('media', 'Media', lib.slots.length ? `${lib.slots.length}/12` : null, ...body);
  }

  // ─── Audio ──────────────────────────────────────────────────────────────
  audioSection() {
    const app = this.app, A = this.s.audio;
    const src = segmented([{ id: 'demo', label: 'Demo' }, { id: 'file', label: 'File…' }, { id: 'mic', label: 'Mic' }], app.sourceKind, v => app.chooseSource(v), { full: true });
    const sig = app.signals;
    const live = sig && sig.mode === 'live';
    const bpm = sig ? sig.bpm : 0;

    const readout = h('div', { class: 'readout' },
      h('span', { class: 'big', id: 'bpmBig' }, bpm ? bpm.toFixed(1) : '—'),
      h('span', { class: 'small' }, 'BPM'),
      !live && app.analysis ? h('span', { class: 'small' }, `conf ${pct(app.analysis.bpmConfidence)}`) : null,
      !live && sig ? h('span', { class: 'small' }, `${sig.beats.length} beats · ${Math.max(0, sig.sections.length - 1)} sections`) : null);

    const tempoBtns = h('div', { class: 'btn-row' },
      h('button', { type: 'button', class: 'btn', title: 'Half tempo', onclick: () => app.setTempo(bpm / 2) }, '½×'),
      h('button', { type: 'button', class: 'btn', title: 'Double tempo', onclick: () => app.setTempo(bpm * 2) }, '2×'),
      h('button', { type: 'button', class: 'btn' + (A.bpm ? '' : ' on'), title: 'Use detected tempo', onclick: () => app.setTempo(0) }, 'Auto'),
      !live ? h('button', { type: 'button', class: 'btn', title: 'Move bar line one beat earlier', onclick: () => app.shiftDownbeat(-1) }, '◀ Bar') : null,
      !live ? h('button', { type: 'button', class: 'btn', title: 'Move bar line one beat later', onclick: () => app.shiftDownbeat(1) }, 'Bar ▶') : null);

    const sync = slider({ min: -150, max: 150, step: 5, value: A.sync, format: v => (v > 0 ? '+' : '') + v + ' ms', label: 'Sync',
      onInput: v => this.set('audio.sync', v) });
    const sens = ['kick', 'snare', 'hat'].map(k => {
      const sl = slider({ min: 0, max: 1, step: 0.05, value: A.sens[k], format: pct, label: k,
        onInput: v => { A.sens[k] = v; app.store.changed(['audio.sens']); } });
      return row(k, sl, { value: sl.valueEl });
    });
    const vol = slider({ min: 0, max: 1, step: 0.01, value: A.volume, format: pct, label: 'Volume', onInput: v => this.set('audio.volume', v) });

    return this.sec('audio', 'Audio', null,
      src,
      h('div', { class: 'source-name', id: 'sourceName' }, app.sourceName || ''),
      readout,
      tempoBtns,
      row('Sync offset', sync, { value: sync.valueEl, hint: 'Shift visuals against the sound. Positive = visuals earlier.' }),
      h('div', { class: 'row' }, h('span', { class: 'label' }, 'Hit sensitivity'), ...sens),
      h('div', { class: 'grid2' },
        row('Loop', segmented([{ id: 'on', label: 'On' }, { id: 'off', label: 'Off' }], A.loop ? 'on' : 'off', v => this.set('audio.loop', v === 'on'))),
        row('Volume', vol, { value: vol.valueEl })),
    );
  }

  // ─── Look ───────────────────────────────────────────────────────────────
  lookSection() {
    const L = this.s.look;
    const styleOpts = h('div', { class: 'row', style: { gap: '14px' } });
    const renderStyleOpts = () => styleOpts.replaceChildren(...this.styleOptions());

    const style = segmented(STYLES, L.style, v => { this.set('look.style', v); renderStyleOpts(); }, { full: true });
    renderStyleOpts();

    const cell = slider({ min: 0, max: CELL_STEPS.length - 1, step: 1, value: cellIndex(L.cell), format: i => CELL_STEPS[i] + ' px', label: 'Cell size',
      onInput: i => this.set('look.cell', CELL_STEPS[i]) });
    const levels = slider({ min: 2, max: 8, step: 1, value: L.levels, label: 'Levels', onInput: v => this.set('look.levels', v) });

    // Palette editor
    const editor = h('div', { class: 'palette-edit' });
    const renderEditor = () => {
      editor.replaceChildren(
        ...L.palette.map((c, i) => {
          const input = h('input', { type: 'color', value: c, 'aria-label': `Colour ${i + 1}` });
          input.addEventListener('input', () => { L.palette[i] = input.value; this.app.store.changed(['look.palette']); });
          return h('label', { class: 'swatch', title: c }, input);
        }),
        L.palette.length < 8 ? h('button', { type: 'button', class: 'swatch-btn', title: 'Add colour', onclick: () => {
          L.palette.push(L.palette[L.palette.length - 1]); this.app.store.changed(['look.palette']); renderEditor();
        } }, '+') : null,
        L.palette.length > 2 ? h('button', { type: 'button', class: 'swatch-btn', title: 'Remove colour', onclick: () => {
          L.palette.pop(); this.app.store.changed(['look.palette']); renderEditor();
        } }, '−') : null,
        h('button', { type: 'button', class: 'swatch-btn', title: 'Reverse', onclick: () => {
          L.palette.reverse(); this.app.store.changed(['look.palette']); renderEditor();
        } }, '⇄'),
      );
    };
    renderEditor();
    const presets = h('div', { class: 'pal-presets' }, PALETTES.map(p =>
      h('button', { type: 'button', class: 'pal-preset', title: p.name, onclick: () => {
        L.palette = [...p.colors]; L.sourceColor = false;
        if (L.levels < p.colors.length) L.levels = p.colors.length;
        this.app.store.changed(['look.palette']); this.refresh('look');
      } }, p.colors.map(c => h('i', { style: { background: c } })))));

    return this.sec('look', 'Look', null,
      style,
      styleOpts,
      h('div', { class: 'grid2' },
        row('Cell', cell, { value: cell.valueEl }),
        row('Levels', levels, { value: levels.valueEl })),
      row('Palette', editor),
      presets,
      h('div', { class: 'grid2' },
        row('Colour', segmented([{ id: 'pal', label: 'Palette' }, { id: 'src', label: 'Source' }], L.sourceColor ? 'src' : 'pal', v => this.set('look.sourceColor', v === 'src'))),
        row('Mirror', select(['none', 'horizontal', 'vertical', 'quad', 'kaleido'], L.mirror, v => this.set('look.mirror', v), { label: 'Mirror' }))),
    );
  }

  styleOptions() {
    const L = this.s.look;
    const ink = () => row('Ink', segmented([{ id: 'light', label: 'Light on dark' }, { id: 'dark', label: 'Dark on light' }], L.ink, v => this.set('look.ink', v)));
    const angle = () => {
      const sl = slider({ min: 0, max: 180, step: 5, value: L.angle, format: v => v + '°', label: 'Angle', onInput: v => this.set('look.angle', v) });
      return row('Angle', sl, { value: sl.valueEl });
    };
    switch (L.style) {
      case 'dither': return [row('Pattern', segmented(['bayer', 'noise', 'cluster'], L.dither, v => this.set('look.dither', v)))];
      case 'halftone': return [row('Shape', segmented(['circle', 'square', 'diamond', 'line'], L.shape, v => this.set('look.shape', v))), angle(), ink()];
      case 'lines': return [angle(), ink()];
      case 'ascii': return [row('Glyphs', segmented(Object.keys(GLYPH_SETS), L.glyphs, v => this.set('look.glyphs', v))), ink()];
      case 'edge': return [ink(), h('div', { class: 'hint' }, 'Sobel edges over a faint posterised wash. Cell size sets line weight.')];
      default: return [];
    }
  }

  // ─── React (modulation matrix) ──────────────────────────────────────────
  reactSection() {
    const F = this.s.fx;
    const srcOpts = SOURCES.map(id => ({ id, label: SOURCE_LABELS[id] }));
    const rows = FX.map(fx => {
      const r = h('div', { class: 'mod' + (F[fx.id].amt ? '' : ' zero') });
      const sl = slider({ min: 0, max: 1, step: 0.01, value: F[fx.id].amt, format: pct, label: fx.label,
        onInput: v => { F[fx.id].amt = v; r.classList.toggle('zero', !v); this.app.store.changed(['fx']); } });
      sl.title = 'Amount';
      r.append(h('span', { class: 'label', title: fx.label }, fx.label), sl,
        select(srcOpts, F[fx.id].src, v => { F[fx.id].src = v; this.app.store.changed(['fx']); }, { label: fx.label + ' source' }));
      return r;
    });
    return this.sec('react', 'React', 'amount · driven by', ...rows);
  }

  // ─── On the beat (director actions) ─────────────────────────────────────
  beatSection() {
    const A = this.s.actions;
    const trig = (key, label, ...extra) => {
      const extraEl = h('div', { class: 'action-extra' }, ...extra);
      extraEl.hidden = A[key].on === 'off';
      return [
        h('div', { class: 'action' },
          h('span', { class: 'label' }, label),
          h('div', { class: 'ctl' }, select(TRIGGER_OPTS, A[key].on, v => {
            A[key].on = v; extraEl.hidden = v === 'off'; this.app.store.changed(['actions']);
          }, { label: label + ' trigger' }))),
        extra.length ? extraEl : null,
      ];
    };

    const dwell = slider({ min: 0, max: 8, step: 0.5, value: A.media.dwell, format: v => v ? v + ' s min' : 'no minimum', label: 'Dwell',
      onInput: v => { A.media.dwell = v; this.app.store.changed(['actions']); } });
    const cellRange = dual({ min: 0, max: CELL_STEPS.length - 1, lo: cellIndex(A.cell.min), hi: cellIndex(A.cell.max), label: 'Cell range',
      toValue: i => CELL_STEPS[i], format: v => v + 'px',
      onInput: (lo, hi) => { A.cell.min = lo; A.cell.max = hi; this.app.store.changed(['actions']); } });

    return this.sec('beat', 'On the beat', null,
      ...trig('media', 'Media',
        segmented(['random', 'sequence'], A.media.order, v => { A.media.order = v; this.app.store.changed(['actions']); }, { full: true }),
        h('div', { class: 'row-head' }, h('span', { class: 'label' }, 'Dwell'), dwell.valueEl), dwell),
      ...trig('cell', 'Cell jump',
        h('div', { class: 'row-head' }, h('span', { class: 'label' }, 'Range'), cellRange.valueEl), cellRange,
        segmented([{ id: 'random', label: 'Random' }, { id: 'up', label: 'Up' }, { id: 'down', label: 'Down' }, { id: 'pingpong', label: 'Bounce' }], A.cell.mode, v => { A.cell.mode = v; this.app.store.changed(['actions']); }, { full: true })),
      ...trig('palette', 'Palette',
        chips(PALETTES.map(p => ({ id: p.id, label: p.name, swatch: paletteSwatch(p.colors) })), A.palette.pool, v => { A.palette.pool = v; this.app.store.changed(['actions']); })),
      ...trig('style', 'Style',
        chips(STYLES, A.style.pool, v => { A.style.pool = v; this.app.store.changed(['actions']); })),
      ...trig('flip', 'Invert'),
      h('div', { class: 'hint' }, 'Decisions are seeded, so a preview and its export always match.'),
    );
  }
}
