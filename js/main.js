import { Store, FORMATS, PALETTES, STYLES, CELL_STEPS } from './state.js';
import { AudioEngine } from './audio/engine.js';
import { TrackSignals, LiveSignals } from './audio/signals.js';
import { mixdown } from './audio/analyzer.js';
import { renderDemo } from './audio/demo.js';
import { Renderer } from './render/renderer.js';
import { Director } from './render/director.js';
import { compose } from './render/compose.js';
import { MediaLibrary } from './render/media.js';
import { Timeline } from './ui/timeline.js';
import { Panel } from './ui/panel.js';
import { h, row, segmented } from './ui/controls.js';
import { canExportOffline, negotiate, exportOffline, startRealtimeRecording, download } from './export/exporter.js';

const $ = id => document.getElementById(id);
const fmt = sec => {
  if (!Number.isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};
const AUDIO_EXT = /\.(mp3|wav|ogg|oga|flac|m4a|aac|opus|weba|aif|aiff)$/i;

class App {
  constructor() {
    this.store = new Store();
    this.engine = new AudioEngine();
    this.lib = new MediaLibrary();
    this.director = new Director();
    this.signals = null;
    this.analysis = null;
    this.sourceKind = 'demo';
    this.sourceName = '';
    this.selectedSlot = null;
    this.currentMedia = null;
    this.exporting = false;
    this.recording = null;
    this.lastTs = 0;
    this.jobId = 0;
    this.worker = null;
  }

  async init() {
    const canvas = $('canvas');
    this.canvas = canvas;
    try {
      this.renderer = new Renderer(canvas);
    } catch (e) {
      console.error(e);
      $('glError').hidden = false;
      return;
    }

    this.panel = new Panel($('panel'), this);
    this.timeline = new Timeline($('timeline'), { onSeek: t => this.seek(t) });

    this.buildFormatSelect();
    this.applyFormat();
    new ResizeObserver(() => this.fitCanvas()).observe($('stage'));

    this.store.addEventListener('change', e => this.onStoreChange(e.detail.paths));
    this.lib.addEventListener('change', () => {
      this.director.reset();
      this.panel.refresh('media');
    });
    this.engine.addEventListener('change', () => this.syncTransport());

    this.bindTransport();
    this.bindFiles();
    this.bindKeys();
    this.bindExport();

    this.panel.render();
    this.engine.setVolume(this.store.data.audio.volume);
    this.engine.setLoop(this.store.data.audio.loop);

    this.lib.setFallback('assets/default.jpg').catch(e => console.warn('Default image failed', e));
    requestAnimationFrame(ts => this.loop(ts));
    this.loadDemo();
  }

  // ─── Store ──────────────────────────────────────────────────────────────
  onStoreChange(paths) {
    const any = p => paths.some(x => x === '*' || x.startsWith(p));
    if (any('format')) this.applyFormat();
    if (any('actions') || any('seed')) this.director.reset();
    if (any('audio.sens') && this.signals) {
      this.signals.rebuild({ sens: this.store.data.audio.sens });
      this.director.reset();
      this.timeline.invalidate();
    }
    if (any('audio.loop')) this.engine.setLoop(this.store.data.audio.loop);
    if (any('audio.volume')) this.engine.setVolume(this.store.data.audio.volume);
    if (paths.includes('*')) {
      $('formatSelect').value = this.store.data.format;
      if (this.signals && this.signals.mode === 'track') {
        this.signals.rebuild({ sens: this.store.data.audio.sens, bpm: this.store.data.audio.bpm, shift: this.store.data.audio.shift });
        this.timeline.invalidate();
      }
      this.panel.render();
    }
  }

  requestRender() {}

  // ─── Canvas / format ────────────────────────────────────────────────────
  buildFormatSelect() {
    const sel = $('formatSelect');
    for (const [id, f] of Object.entries(FORMATS)) sel.append(h('option', { value: id }, f.label));
    sel.value = this.store.data.format;
    sel.addEventListener('change', () => this.store.set('format', sel.value));
  }

  applyFormat() {
    const f = FORMATS[this.store.data.format] || FORMATS['1080x1350'];
    this.W = f.w; this.H = f.h;
    this.renderer.resize(f.w, f.h);
    this.fitCanvas();
  }

  fitCanvas() {
    const stage = $('stage'), wrap = $('canvasWrap');
    const cs = getComputedStyle(stage);
    const aw = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const ah = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    if (aw <= 0 || ah <= 0) return;
    let w, hh;
    if (aw / ah > this.W / this.H) { hh = ah; w = Math.round(ah * this.W / this.H); }
    else { w = aw; hh = Math.round(aw * this.H / this.W); }
    wrap.style.width = w + 'px';
    wrap.style.height = hh + 'px';
  }

  // ─── Audio sources ──────────────────────────────────────────────────────
  analyzeBuffer(buffer) {
    if (!this.worker) this.worker = new Worker(new URL('./audio/analysis-worker.js', import.meta.url), { type: 'module' });
    const id = ++this.jobId;
    const channels = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
    const mono = mixdown(channels);
    return new Promise((resolve, reject) => {
      const onMsg = e => {
        if (e.data.id !== id) return;
        if (e.data.progress != null) { this.setStatus(`Analysing ${Math.round(e.data.progress * 100)}%`); return; }
        this.worker.removeEventListener('message', onMsg);
        if (e.data.error) reject(new Error(e.data.error)); else resolve(e.data.result);
      };
      this.worker.addEventListener('message', onMsg);
      this.worker.postMessage({ id, mono, sampleRate: buffer.sampleRate }, [mono.buffer]);
    });
  }

  async loadDemo() {
    this.sourceKind = 'demo';
    this.setStatus('Building demo…');
    try {
      const buffer = await renderDemo(44100);
      const result = await this.analyzeBuffer(buffer);
      this.setTrack(buffer, result, 'Built-in demo · 126 BPM house groove');
    } catch (e) {
      console.error(e);
      this.toast('Demo failed: ' + e.message);
      this.setStatus('Ready');
    }
  }

  async loadAudioFile(file) {
    this.setStatus('Decoding…');
    try {
      const buffer = await this.engine.decode(await file.arrayBuffer());
      const result = await this.analyzeBuffer(buffer);
      this.sourceKind = 'file';
      this.setTrack(buffer, result, file.name);
      this.toast(`${result.bpm.toFixed(1)} BPM · ${result.beats.length} beats`);
    } catch (e) {
      console.error(e);
      this.toast("Couldn't read that audio file");
      this.setStatus('Ready');
      this.panel.refresh('audio');
    }
  }

  setTrack(buffer, analysis, name) {
    this.engine.setBuffer(buffer);
    this.engine.setLoop(this.store.data.audio.loop);
    this.analysis = analysis;
    const A = this.store.data.audio;
    A.bpm = 0; A.shift = 0;
    this.signals = new TrackSignals(analysis);
    this.signals.rebuild({ sens: A.sens, bpm: 0, shift: 0 });
    this.director.reset();
    this.sourceName = name;
    this.timeline.setTrack(analysis, this.signals);
    $('totTime').textContent = fmt(buffer.duration);
    this.panel.refresh('audio');
    this.syncTransport();
  }

  async startMic() {
    try {
      const node = await this.engine.startMic();
      this.signals = new LiveSignals(this.engine.ctx, node);
      this.signals.rebuild({ sens: this.store.data.audio.sens });
      this.analysis = null;
      this.sourceKind = 'mic';
      this.sourceName = 'Microphone · live beat tracking';
      this.director.reset();
      this.timeline.setTrack(null, this.signals);
      $('totTime').textContent = 'LIVE';
      this.panel.refresh('audio');
      this.syncTransport();
    } catch (e) {
      console.error(e);
      this.toast('Microphone unavailable');
      this.panel.refresh('audio');
    }
  }

  chooseSource(kind) {
    if (kind === 'demo') this.loadDemo();
    else if (kind === 'file') { $('audioInput').click(); this.panel.refresh('audio'); }
    else if (kind === 'mic') this.startMic();
  }

  setTempo(bpm) {
    if (!this.signals) return;
    if (bpm && (bpm < 40 || bpm > 260)) return;
    if (this.signals.mode === 'live') { if (bpm) this.signals.bpm = bpm; }
    else {
      this.store.data.audio.bpm = bpm;
      this.signals.rebuild({ bpm });
      this.director.reset();
      this.timeline.invalidate();
    }
    this.panel.refresh('audio');
  }

  shiftDownbeat(d) {
    if (!this.signals || this.signals.mode !== 'track') return;
    const A = this.store.data.audio;
    A.shift = (((A.shift + d) % 4) + 4) % 4;
    this.signals.rebuild({ shift: A.shift });
    this.director.reset();
    this.timeline.invalidate();
  }

  // ─── Transport ──────────────────────────────────────────────────────────
  bindTransport() {
    $('playBtn').addEventListener('click', () => this.togglePlay());
    $('recBtn').addEventListener('click', () => this.toggleRecord());
  }

  async togglePlay() {
    if (this.sourceKind === 'mic') { this.toast('Live input is always on'); return; }
    if (!this.engine.buffer) return;
    await this.engine.toggle();
    this.lib.setPlaying(this.engine.playing || this.lib.hasVideo());
  }

  seek(t) {
    if (this.signals?.mode === 'live') return;
    this.engine.seek(t);
  }

  syncTransport() {
    const playing = this.engine.playing;
    $('playIcon').innerHTML = playing
      ? '<rect x="2" y="1" width="4" height="12"/><rect x="8" y="1" width="4" height="12"/>'
      : '<polygon points="3,1 13,7 3,13"/>';
    $('playBtn').setAttribute('aria-label', playing ? 'Pause' : 'Play');
    if (!this.exporting && !this.statusLocked) this.setStatus(this.sourceKind === 'mic' ? 'Live' : playing ? 'Playing' : 'Paused');
  }

  async toggleRecord() {
    if (this.exporting) return;
    if (this.recording) {
      const rec = this.recording;
      this.recording = null;
      $('recBtn').classList.remove('on');
      const { blob, ext } = await rec.stop();
      download(blob, `raging-beat-live.${ext}`);
      this.toast('Recording saved');
      return;
    }
    if (typeof MediaRecorder !== 'function') { this.toast('Recording is not supported in this browser'); return; }
    await this.engine.resume();
    this.recording = startRealtimeRecording(this.canvas, this.engine.recordStream(), 30);
    $('recBtn').classList.add('on');
    if (this.sourceKind !== 'mic' && !this.engine.playing) this.togglePlay();
    this.toast('Recording · press R to stop');
  }

  // ─── Media ──────────────────────────────────────────────────────────────
  pickMedia() { $('mediaInput').click(); }

  async addMedia(files) {
    const wasEmpty = !this.lib.slots.length;
    const added = await this.lib.addFiles(files);
    if (!added.length) { this.toast('No usable images or videos'); return; }
    if (wasEmpty) this.selectSlot(added[0].id);
    this.toast(`${added.length} added`);
  }

  selectSlot(id) {
    const i = this.lib.slots.findIndex(s => s.id === id);
    if (i < 0) return;
    this.selectedSlot = id;
    this.director.setMedia(i);
    this.panel.refresh('media');
  }

  removeSlot(id) {
    const slot = this.lib.slots.find(s => s.id === id);
    if (!slot) return;
    this.renderer.forget(slot);
    this.lib.remove(id);
    if (this.selectedSlot === id) this.selectedSlot = this.lib.slots[0]?.id ?? null;
    this.panel.refresh('media');
  }

  bindFiles() {
    $('mediaInput').addEventListener('change', e => { this.addMedia([...e.target.files]); e.target.value = ''; });
    $('audioInput').addEventListener('change', e => {
      const f = e.target.files[0];
      e.target.value = '';
      if (f) this.loadAudioFile(f);
    });

    const overlay = $('dropOverlay');
    let depth = 0;
    window.addEventListener('dragenter', e => { if (e.dataTransfer?.types.includes('Files')) { depth++; overlay.classList.add('show'); e.preventDefault(); } });
    window.addEventListener('dragover', e => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
    window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) overlay.classList.remove('show'); });
    window.addEventListener('drop', e => {
      e.preventDefault();
      depth = 0;
      overlay.classList.remove('show');
      const files = [...(e.dataTransfer?.files || [])];
      const audio = files.find(f => f.type.startsWith('audio/') || AUDIO_EXT.test(f.name));
      const visual = files.filter(f => f !== audio && (f.type.startsWith('image/') || f.type.startsWith('video/')));
      if (audio) this.loadAudioFile(audio);
      if (visual.length) this.addMedia(visual);
    });
    $('canvasWrap').addEventListener('click', () => { if (!this.lib.slots.length) this.pickMedia(); });
  }

  // ─── Looks ──────────────────────────────────────────────────────────────
  applyLook(look) {
    this.store.patch(look.patch);
    this.toast(look.name);
  }

  shuffle() {
    const r = n => Math.floor(Math.random() * n);
    const pick = a => a[r(a.length)];
    const pal = pick(PALETTES);
    const style = pick(STYLES).id;
    const srcs = ['kick', 'snare', 'hat', 'beat', 'bar', 'low', 'mid', 'none'];
    const fx = {};
    for (const id of ['zoom', 'shake', 'rgb', 'glitch', 'warp', 'trails', 'flash', 'scan', 'grain', 'cellmod']) {
      const on = Math.random() < (id === 'zoom' || id === 'rgb' ? 0.7 : 0.3);
      fx[id] = { amt: on ? Math.round((0.15 + Math.random() * 0.55) * 100) / 100 : 0, src: pick(srcs) };
    }
    if (fx.flash.src === 'none') fx.flash.src = 'bar';
    const minI = r(6), maxI = minI + 3 + r(CELL_STEPS.length - minI - 3);
    this.store.patch({
      look: {
        style, palette: [...pal.colors], sourceColor: Math.random() < 0.12,
        levels: Math.max(pal.colors.length, 2 + r(3)), cell: pick([2, 3, 4, 6, 8, 12, 16]),
        dither: pick(['bayer', 'noise', 'cluster']), angle: pick([0, 15, 30, 45, 60, 90]),
        shape: pick(['circle', 'square', 'diamond', 'line']), ink: pick(['light', 'dark']),
        glyphs: pick(['classic', 'blocks', 'dense', 'binary', 'slash']),
        mirror: Math.random() < 0.2 ? pick(['horizontal', 'quad', 'kaleido']) : 'none',
      },
      fx,
      actions: {
        cell: { on: pick(['beat', 'bar', 'kick', 'snare', 'off']), min: CELL_STEPS[minI], max: CELL_STEPS[Math.min(maxI, CELL_STEPS.length - 1)], mode: pick(['random', 'random', 'up', 'pingpong']) },
        palette: { on: Math.random() < 0.3 ? pick(['bar', 'bar2', 'section']) : 'off', pool: PALETTES.filter(() => Math.random() < 0.4).map(p => p.id).concat(pal.id) },
        style: { on: Math.random() < 0.25 ? pick(['bar2', 'bar4', 'section']) : 'off', pool: STYLES.filter(() => Math.random() < 0.5).map(s => s.id).concat(style) },
        flip: { on: Math.random() < 0.15 ? pick(['snare', 'bar']) : 'off' },
      },
      seed: r(100000),
    });
    this.toast('Shuffled');
  }

  resetSettings() {
    const format = this.store.data.format;
    this.store.reset();
    this.store.set('format', format);
    this.toast('Reset');
  }

  newSeed() {
    this.store.set('seed', Math.floor(Math.random() * 100000));
    this.toast('New seed');
  }

  // ─── Render ─────────────────────────────────────────────────────────────
  directorAt(t) {
    const s = this.store.data;
    const list = this.lib.playlist;
    const dir = this.signals
      ? this.director.advance(this.signals.stream, t, { mediaCount: list.length, settings: s, seed: s.seed, live: this.signals.mode === 'live' })
      : this.director.s;
    const media = list.length ? list[((dir.media % list.length) + list.length) % list.length] : null;
    return { dir, media };
  }

  renderAt(t, dt) {
    const s = this.store.data;
    const tt = t + s.audio.sync / 1000;
    const frame = this.signals ? this.signals.sample(tt) : null;
    const { dir, media } = this.directorAt(tt);
    this.currentMedia = media;
    this.renderer.render(compose({ settings: s, frame, dir, media, t: tt, dt, W: this.W, H: this.H }));
    return frame;
  }

  loop(ts) {
    requestAnimationFrame(t => this.loop(t));
    if (this.exporting) return;
    const dt = this.lastTs ? Math.min(0.1, (ts - this.lastTs) / 1000) : 1 / 60;
    this.lastTs = ts;

    let t;
    if (this.signals?.mode === 'live') {
      t = this.engine.ctx.currentTime;
      this.signals.update(t);
    } else t = this.engine.time;

    const frame = this.renderAt(t, dt);
    this.updateHud(t, frame);
  }

  updateHud(t, frame) {
    if (this.signals?.mode !== 'live') $('curTime').textContent = fmt(t);
    this.timeline.draw(t);
    const leds = document.querySelectorAll('.led');
    leds.forEach(l => { l.firstChild.style.opacity = 0.12 + 0.88 * (frame?.pulse[l.dataset.k] ?? 0); });
    const dots = $('barDots').children;
    const k = frame ? Math.floor(frame.barPhase * 4) : -1;
    for (let i = 0; i < 4; i++) dots[i].classList.toggle('on', i === k);
    const bpm = frame ? frame.bpm.toFixed(1) : '—';
    if ($('bpmValue').textContent !== bpm) $('bpmValue').textContent = bpm;
    if (this.signals?.mode === 'live') {
      const big = $('bpmBig');
      if (big && big.textContent !== bpm) big.textContent = bpm;
    }

    // Mark the slot currently on screen
    if (this._shownMedia !== this.currentMedia) {
      this._shownMedia = this.currentMedia;
      const idx = this.lib.slots.indexOf(this.currentMedia);
      document.querySelectorAll('.slots .slot:not(.add)').forEach((el, i) => el.classList.toggle('live', i === idx));
    }
  }

  // ─── Export ─────────────────────────────────────────────────────────────
  bindExport() {
    const dlg = $('exportDialog');
    const opts = { fps: this.store.data.export.fps, quality: this.store.data.export.quality, container: this.store.data.export.container };
    $('exportBtn').addEventListener('click', () => this.openExport());
    $('exportCancel').addEventListener('click', () => {
      if (this.exportAbort) this.exportAbort.abort();
      else dlg.close();
    });
    $('exportStart').addEventListener('click', () => this.runExport());
    dlg.addEventListener('cancel', e => { if (this.exporting) e.preventDefault(); });
    this.exportOpts = opts;
  }

  openExport() {
    if (this.exporting) return;
    const dlg = $('exportDialog');
    const o = this.exportOpts;
    const offline = canExportOffline() && this.sourceKind !== 'mic' && this.engine.buffer;
    $('exportNote').textContent = offline
      ? `Renders every frame offline, perfectly in sync, faster or slower than realtime depending on your machine. ${fmt(this.engine.duration)} of audio at ${this.W}×${this.H}.`
      : this.sourceKind === 'mic'
        ? 'Live input can’t be rendered offline. Use Record (R) to capture a live performance instead.'
        : 'This browser can’t encode video offline. Use Record (R) to capture in realtime instead.';
    const set = (k, v) => { o[k] = v; this.store.data.export[k] = v; this.store.changed(['export']); };
    $('exportOptions').replaceChildren(...(offline ? [
      row('Frame rate', segmented([{ id: 30, label: '30 fps' }, { id: 60, label: '60 fps' }], o.fps, v => set('fps', v), { full: true })),
      row('Quality', segmented([{ id: 'standard', label: 'Standard' }, { id: 'high', label: 'High' }, { id: 'max', label: 'Max' }], o.quality, v => set('quality', v), { full: true })),
      row('Container', segmented([{ id: 'auto', label: 'Auto' }, { id: 'mp4', label: 'MP4' }, { id: 'webm', label: 'WebM' }], o.container, v => set('container', v), { full: true })),
    ] : []));
    $('exportStart').hidden = !offline;
    $('exportProgress').hidden = true;
    $('exportStatus').textContent = '';
    $('exportCancel').textContent = 'Close';
    dlg.showModal();
  }

  async runExport() {
    if (this.exporting) return;
    const o = this.exportOpts;
    const status = $('exportStatus');
    const config = await negotiate({ width: this.W, height: this.H, fps: o.fps, quality: o.quality, container: o.container });
    if (!config) { status.textContent = 'No supported video encoder found. Use Record instead.'; return; }

    this.exporting = true;
    this.engine.pause();
    if (this.recording) await this.toggleRecord();
    this.lib.setPlaying(false);
    this.exportAbort = new AbortController();
    $('exportStart').hidden = true;
    $('exportCancel').textContent = 'Cancel';
    $('exportProgress').hidden = false;
    $('exportOptions').querySelectorAll('button').forEach(b => { b.disabled = true; });
    this.director.reset();
    this.renderer.clearHistory();
    const codecName = `${config.container.toUpperCase()} · ${config.video.codec.split('.')[0]}${config.audio ? ' + ' + config.audio.codec.split('.')[0] : ' · video only (no audio encoder in this browser)'}`;
    status.textContent = codecName;
    const started = performance.now();

    try {
      const { blob, ext } = await exportOffline({
        canvas: this.canvas,
        audioBuffer: this.engine.buffer,
        duration: this.engine.duration,
        fps: o.fps,
        config,
        signal: this.exportAbort.signal,
        prepareFrame: async t => {
          const { media } = this.directorAt(t + this.store.data.audio.sync / 1000);
          if (media?.type === 'video') await this.lib.seekVideo(media, t);
        },
        renderFrame: (t, dt) => this.renderAt(t, dt),
        onProgress: ({ phase, progress, eta }) => {
          $('exportFill').style.width = (progress * 100).toFixed(1) + '%';
          status.textContent = phase === 'video'
            ? `${codecName} · ${Math.round(progress * 100)}% · ${Math.ceil(eta)} s left`
            : phase === 'audio' ? `${codecName} · encoding audio…` : `${codecName} · writing file…`;
          this.setStatus(`Export ${Math.round(progress * 100)}%`);
        },
      });
      const base = (this.sourceName || 'track').replace(/\.[^.]+$/, '').replace(/[^\w\-]+/g, '-').slice(0, 40);
      download(blob, `raging-beat-${base}.${ext}`);
      const secs = ((performance.now() - started) / 1000).toFixed(1);
      status.textContent = `Done in ${secs} s · ${(blob.size / 1e6).toFixed(1)} MB`;
      this.toast('Export saved');
    } catch (e) {
      console.error(e);
      status.textContent = e.name === 'AbortError' ? 'Cancelled' : 'Export failed: ' + e.message;
    } finally {
      this.exporting = false;
      this.exportAbort = null;
      this.director.reset();
      this.lib.setPlaying(this.lib.hasVideo());
      $('exportCancel').textContent = 'Close';
      $('exportStart').hidden = false;
      $('exportOptions').querySelectorAll('button').forEach(b => { b.disabled = false; });
      this.syncTransport();
    }
  }

  // ─── Keyboard ───────────────────────────────────────────────────────────
  bindKeys() {
    $('helpBtn').addEventListener('click', () => $('helpDialog').showModal());
    // Space always means play/pause: stop a focused button from also firing
    window.addEventListener('keyup', e => {
      if (e.key === ' ' && e.target.closest?.('button') && !document.querySelector('dialog[open]')) e.preventDefault();
    });
    window.addEventListener('keydown', e => {
      if (e.target.closest('input, select, textarea') && e.target.type !== 'range') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector('dialog[open]')) return;
      const k = e.key;
      if (k === ' ') { e.preventDefault(); if (!e.repeat) this.togglePlay(); }
      else if (k === 'ArrowRight' || k === 'ArrowLeft') {
        if (e.target.type === 'range') return;
        e.preventDefault();
        const bar = this.signals ? 240 / this.signals.bpm : 2;
        this.seek(this.engine.time + (k === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 10 : bar));
      }
      else if (/^[1-9]$/.test(k)) { const slot = this.lib.slots[+k - 1]; if (slot) this.selectSlot(slot.id); }
      else if (k === 'r' || k === 'R') this.toggleRecord();
      else if (k === 'e' || k === 'E') this.openExport();
      else if (k === 'f' || k === 'F') this.toggleFullscreen();
      else if (k === 's' || k === 'S') this.shuffle();
      else if (k === '?') $('helpDialog').showModal();
    });
  }

  toggleFullscreen() {
    const stage = $('stage');
    if (document.fullscreenElement) document.exitFullscreen();
    else stage.requestFullscreen?.().catch(() => {});
  }

  // ─── Status ─────────────────────────────────────────────────────────────
  setStatus(text) { $('status').textContent = text; }

  toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
  }
}

const app = new App();
window.ragingBeat = app;
app.init();
