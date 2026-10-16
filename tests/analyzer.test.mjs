import { analyze, detectDrums, FPS } from '../js/audio/analyzer.js';
import { drumTrack, match } from './synth.mjs';
import assert from 'node:assert/strict';

const cases = [
  { bpm: 128, kickPattern: 'all' },
  { bpm: 70,  kickPattern: [0, 2] },
  { bpm: 160, kickPattern: 'all' },
  { bpm: 150, kickPattern: [0] },
  { bpm: 85,  kickPattern: [0, 2] },
  { bpm: 128, kickPattern: [0, 2], pad: 0.15 },
  { bpm: 90,  kickPattern: [0, 2] },
  { bpm: 140, kickPattern: 'all', swing: 1 },
  { bpm: 174, kickPattern: [0, 2] },
  { bpm: 100, kickPattern: [0, 2], sr: 48000, intro: 2.1 },
];
let fails = 0;
for (const c of cases) {
  const { x, sr, truth } = drumTrack({ bars: 16, ...c });
  const t0 = performance.now();
  const a = analyze(x, sr);
  const ms = performance.now() - t0;
  const beats = Array.from(a.beats);
  const bm = match(beats, truth.beats, 0.04);
  const down = beats.filter((_, i) => i % 4 === a.downbeatPhase);
  const dm = match(down, truth.downbeats, 0.04);
  const ev = {};
  const drums = detectDrums(a);
  for (const k of ['kick', 'snare', 'hat']) ev[k] = match(Array.from(drums[k].times), truth[k], 0.04);
  const line = `${String(c.bpm).padStart(3)}bpm ${JSON.stringify(c.kickPattern).padEnd(6)} → bpm ${a.bpm.toFixed(2)} conf ${a.bpmConfidence.toFixed(2)} | beats R${bm.recall.toFixed(2)} P${bm.precision.toFixed(2)} bias ${(bm.bias*1000).toFixed(1)}ms | down R${dm.recall.toFixed(2)} | ` +
    ['kick','snare','hat'].map(k => `${k} R${ev[k].recall.toFixed(2)} P${ev[k].precision.toFixed(2)} ${(ev[k].bias*1000).toFixed(0)}ms`).join(' ') + ` | sections ${a.sections.length} | ${ms.toFixed(0)}ms`;
  console.log(line);
  const ok = a.sections.length === 1 && Math.abs(a.bpm - c.bpm) < 1 && bm.recall > 0.95 && bm.precision > 0.95 && dm.recall > 0.9 && ['kick','snare','hat'].every(k => ev[k].recall > 0.9 && ev[k].precision > 0.85) && Math.abs(bm.bias) < 0.010;
  if (!ok) { fails++; console.log('   ^ FAIL'); }
}
assert.equal(fails, 0, `${fails} analyzer cases failed`);
console.log('analyzer ok');
