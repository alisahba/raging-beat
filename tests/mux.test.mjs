// Validates the MP4/WebM muxers against ffprobe/ffmpeg, using real H.264 and
// AAC streams produced by ffmpeg (Chrome/Safari's WebCodecs output has the
// same shape: AVCC samples + avcC description, raw AAC + AudioSpecificConfig).
// Requires ffmpeg/ffprobe on PATH.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { MP4Muxer } from '../js/export/mux.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-mux-'));
const ff = (...args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
ff('-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30', '-t', '3', '-c:v', 'libx264', '-profile:v', 'high', '-bf', '0', '-g', '30', '-pix_fmt', 'yuv420p', '-f', 'h264', path.join(dir, 'v.h264'));
ff('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '3', '-ac', '2', '-c:a', 'aac', '-b:a', '128k', '-f', 'adts', path.join(dir, 'a.aac'));

// ── H.264 Annex B → AVCC access units + avcC ──
const es = fs.readFileSync(path.join(dir, 'v.h264'));
const nals = [];
for (let i = 0, start = -1; i <= es.length; i++) {
  const sc = i + 3 <= es.length && es[i] === 0 && es[i + 1] === 0 && (es[i + 2] === 1 || (es[i + 2] === 0 && es[i + 3] === 1));
  if (sc || i === es.length) {
    if (start >= 0) { let end = i; while (end > start && es[end - 1] === 0) end--; nals.push(es.subarray(start, end)); }
    if (sc) { i += es[i + 2] === 1 ? 2 : 3; start = i + 1; }
  }
}
let sps, pps;
const frames = [];
let cur = null;
for (const n of nals) {
  const type = n[0] & 0x1f;
  if (type === 7) { sps = n; continue; }
  if (type === 8) { pps = n; continue; }
  if (type === 9) continue;
  const isSlice = type === 1 || type === 5;
  // A new access unit starts at an SEI or first slice once the current one has a picture
  if (!cur || (cur.hasSlice && (type === 6 || (isSlice && (n[1] & 0x80))))) { cur = { key: false, hasSlice: false, nals: [] }; frames.push(cur); }
  if (type === 5) cur.key = true;
  if (isSlice) cur.hasSlice = true;
  cur.nals.push(n);
}
const avcC = Uint8Array.from([1, sps[1], sps[2], sps[3], 0xff, 0xe1, sps.length >> 8, sps.length & 255, ...sps, 1, pps.length >> 8, pps.length & 255, ...pps, 0xfd, 0xf8, 0xf8, 0]);
const chunk = (data, ts, dur, key) => ({ timestamp: ts, duration: dur, type: key ? 'key' : 'delta', byteLength: data.length, copyTo: d => d.set(data) });

// ── AAC ADTS → raw frames + AudioSpecificConfig ──
const aac = fs.readFileSync(path.join(dir, 'a.aac'));
const aframes = [];
let asc;
for (let i = 0; i + 7 <= aac.length;) {
  const prot = aac[i + 1] & 1, len = ((aac[i + 3] & 3) << 11) | (aac[i + 4] << 3) | (aac[i + 5] >> 5);
  const hl = prot ? 7 : 9;
  if (!asc) {
    const aot = (aac[i + 2] >> 6) + 1, fi = (aac[i + 2] >> 2) & 15, ch = ((aac[i + 2] & 1) << 2) | (aac[i + 3] >> 6);
    asc = Uint8Array.of((aot << 3) | (fi >> 1), ((fi & 1) << 7) | (ch << 3));
  }
  aframes.push(aac.subarray(i + hl, i + len));
  i += len;
}

const mux = new MP4Muxer({ video: { codec: 'avc1.640015', width: 320, height: 240, fps: 30 }, audio: { codec: 'mp4a.40.2', sampleRate: 48000, channels: 2, bitrate: 128000 } });
frames.forEach((f, i) => {
  const body = [];
  for (const n of f.nals) body.push(Uint8Array.of(n.length >>> 24, (n.length >> 16) & 255, (n.length >> 8) & 255, n.length & 255), n);
  const data = Uint8Array.from(Buffer.concat(body));
  mux.addVideo(chunk(data, Math.round((i * 1e6) / 30), Math.round(1e6 / 30), f.key), i === 0 ? { decoderConfig: { description: avcC, codec: 'avc1.640015' } } : undefined);
});
aframes.forEach((f, i) => mux.addAudio(chunk(f, Math.round((i * 1024 * 1e6) / 48000), Math.round((1024 * 1e6) / 48000), true), i === 0 ? { decoderConfig: { description: asc } } : undefined));

const out = path.join(dir, 'out.mp4');
fs.writeFileSync(out, Buffer.from(await mux.finalize().arrayBuffer()));
const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', out]).toString());
const v = probe.streams.find(s => s.codec_type === 'video'), a = probe.streams.find(s => s.codec_type === 'audio');
assert.equal(v.codec_name, 'h264');
assert.equal(frames.length, 90);
assert.equal(+v.nb_frames, frames.length);
assert.equal(v.width, 320);
assert.equal(a.codec_name, 'aac');
assert.equal(+a.sample_rate, 48000);
assert.ok(Math.abs(+probe.format.duration - 3) < 0.1, 'duration ' + probe.format.duration);
const dec = spawnSync('ffmpeg', ['-v', 'error', '-i', out, '-f', 'null', '-'], { encoding: 'utf8' });
assert.equal(dec.status, 0);
assert.equal(dec.stderr.trim(), '', 'decode errors: ' + dec.stderr);
// moov before mdat (streamable)
const buf = fs.readFileSync(out);
assert.ok(buf.indexOf('moov') < buf.indexOf('mdat'), 'moov should precede mdat');
console.log(`mux ok · h264 ${frames.length} frames + aac ${aframes.length} frames · ${probe.format.duration}s`);
fs.rmSync(dir, { recursive: true });
