// End-to-end test in headless Chromium (software WebGL):
//   · the app loads with no console errors
//   · the built-in demo, rendered by the browser's own audio engine, is
//     analysed correctly against its known score (tempo, beats, downbeats,
//     drums, sections)
//   · every style renders real images, and rendering is deterministic
//   · an offline WebCodecs export produces a valid, decodable file
// Requires: npm install (playwright) and ffprobe/ffmpeg on PATH.
import { chromium } from 'playwright';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { serve } from './serve.mjs';

const server = await serve(0);
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(e.message));

const step = async (name, fn) => {
  const t0 = Date.now();
  await fn();
  console.log(`✓ ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
};

try {
  await step('loads and analyses the demo', async () => {
    await page.goto(url);
    await page.waitForFunction(() => window.ragingBeat?.analysis, null, { timeout: 90000 });
    assert.deepEqual(errors, []);
  });

  await step('demo analysis matches its score', async () => {
    const r = await page.evaluate(async () => {
      const { demoTruth } = await import('/tests/demo-truth.mjs');
      const { match } = await import('/tests/synth.mjs');
      const app = window.ragingBeat, s = app.signals, T = demoTruth();
      const beats = Array.from(s.beats);
      const down = beats.filter((_, i) => i >= s.downbeatPhase && (i - s.downbeatPhase) % 4 === 0);
      const m = (det, truth) => match(Array.from(det), truth, 0.04);
      return {
        bpm: s.bpm,
        beats: m(beats, T.beats), down: m(down, T.downbeats),
        kick: m(s.byType.kick.times, T.kick), snare: m(s.byType.snare.times, T.snare), hat: m(s.byType.hat.times, T.hat),
        sections: Array.from(s.sections), truthSections: T.sections,
      };
    });
    assert.ok(Math.abs(r.bpm - 126) < 0.5, `bpm ${r.bpm}`);
    assert.ok(r.beats.recall >= 0.95 && r.beats.precision >= 0.95, `beats ${JSON.stringify(r.beats)}`);
    assert.ok(r.down.recall >= 0.9, `downbeats ${JSON.stringify(r.down)}`);
    assert.ok(r.kick.recall >= 0.95 && r.kick.precision >= 0.95, `kick ${JSON.stringify(r.kick)}`);
    assert.ok(r.snare.recall >= 0.65 && r.snare.precision >= 0.75, `snare ${JSON.stringify(r.snare)}`);
    assert.ok(r.hat.recall >= 0.6 && r.hat.precision >= 0.8, `hat ${JSON.stringify(r.hat)}`);
    for (const t of r.truthSections) assert.ok(r.sections.some(s => Math.abs(s - t) < 0.15), `section at ${t} missing: ${r.sections}`);
  });

  await step('every style renders an image', async () => {
    const stats = await page.evaluate(async () => {
      const { STYLES } = await import('/js/state.js');
      const app = window.ragingBeat;
      app.store.set('actions.cell.on', 'off');
      app.store.set('look.cell', 8);
      const probe = document.createElement('canvas');
      probe.width = 54; probe.height = 68;
      const g = probe.getContext('2d', { willReadFrequently: true });
      const out = {};
      for (const { id } of STYLES) {
        app.store.set('look.style', id);
        app.renderAt(20, 1 / 30);
        g.drawImage(app.canvas, 0, 0, probe.width, probe.height);
        const d = g.getImageData(0, 0, probe.width, probe.height).data;
        let sum = 0, sum2 = 0;
        for (let i = 0; i < d.length; i += 4) { const l = d[i] + d[i + 1] + d[i + 2]; sum += l; sum2 += l * l; }
        const n = d.length / 4, mean = sum / n;
        out[id] = { mean, sd: Math.sqrt(sum2 / n - mean * mean) };
      }
      const gl = app.renderer.gl;
      out.glError = gl.getError();
      return out;
    });
    assert.equal(stats.glError, 0, 'WebGL error');
    for (const [id, s] of Object.entries(stats)) if (id !== 'glError') assert.ok(s.sd > 20, `${id} looks blank (sd ${s.sd.toFixed(1)})`);
  });

  await step('rendering is deterministic', async () => {
    const same = await page.evaluate(() => {
      const app = window.ragingBeat;
      app.engine.pause();
      app.store.set('fx.trails.amt', 0);
      const grab = () => { const c = document.createElement('canvas'); c.width = 80; c.height = 100; c.getContext('2d').drawImage(app.canvas, 0, 0, 80, 100); return c.toDataURL(); };
      app.renderAt(31.4, 1 / 30); const a = grab();
      app.renderAt(44, 1 / 30); app.renderAt(2, 1 / 30);
      app.renderAt(31.4, 1 / 30);
      return a === grab();
    });
    assert.ok(same, 'same time should give the same frame');
  });

  await step('offline export produces a valid video', async () => {
    const res = await page.evaluate(async () => {
      const app = window.ragingBeat;
      const { negotiate, exportOffline } = await import('/js/export/exporter.js');
      app.store.set('format', '1080x1080');
      const config = await negotiate({ width: app.W, height: app.H, fps: 30, quality: 'standard', container: 'auto' });
      app.exporting = true;
      app.director.reset();
      const { blob, ext } = await exportOffline({
        canvas: app.canvas, audioBuffer: app.engine.buffer, duration: 1, fps: 30, config,
        renderFrame: (t, dt) => app.renderAt(t + 30, dt),
      });
      app.exporting = false;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { ext, b64: btoa(s), codec: config.video.codec };
    });
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rb-export-')), `out.${res.ext}`);
    fs.writeFileSync(file, Buffer.from(res.b64, 'base64'));
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', file]).toString());
    const v = probe.streams.find(s => s.codec_type === 'video');
    const a = probe.streams.find(s => s.codec_type === 'audio');
    assert.equal(+v.nb_read_frames, 30, 'frame count');
    assert.equal(v.width, 1080);
    assert.ok(a, 'audio stream');
    const dec = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' });
    assert.equal(dec.stderr.trim(), '', 'decode errors');
    console.log(`  ${res.ext} · ${res.codec} · ${v.nb_read_frames} frames · ${a.codec_name}`);
  });

  assert.deepEqual(errors, [], 'console errors');
  console.log('browser ok');
} finally {
  await browser.close();
  server.close();
}
