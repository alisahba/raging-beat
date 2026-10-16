// Export: offline, frame-exact rendering through WebCodecs (preferred) or
// realtime capture through MediaRecorder (fallback / live performances).

import { MP4Muxer, WebMMuxer } from './mux.js';

const BITRATES = { standard: 8e6, high: 16e6, max: 32e6 };

export function canExportOffline() {
  return typeof VideoEncoder === 'function' && typeof VideoFrame === 'function';
}

async function supportedVideo(codecs, w, h, fps, bitrate) {
  for (const codec of codecs) {
    const cfg = { codec, width: w, height: h, bitrate, framerate: fps };
    if (codec.startsWith('avc1')) cfg.avc = { format: 'avc' };
    try {
      const r = await VideoEncoder.isConfigSupported(cfg);
      if (r.supported) return r.config;
    } catch {}
  }
  return null;
}

async function supportedAudio(codecs, sampleRate) {
  if (typeof AudioEncoder !== 'function') return null;
  for (const codec of codecs) {
    const cfg = { codec, sampleRate, numberOfChannels: 2, bitrate: codec === 'opus' ? 160000 : 192000 };
    try {
      const r = await AudioEncoder.isConfigSupported(cfg);
      if (r.supported) return r.config;
    } catch {}
  }
  return null;
}

// Choose container + codecs. container: 'auto' | 'mp4' | 'webm'
export async function negotiate({ width, height, fps, quality, container = 'auto' }) {
  const bitrate = Math.round(BITRATES[quality] * (fps > 30 ? 1.5 : 1));
  const H264 = ['avc1.640033', 'avc1.4d0033', 'avc1.42003e'];
  const options = [];
  if (container !== 'webm') {
    options.push({ container: 'mp4', video: H264, audio: ['mp4a.40.2', 'opus'] });
    options.push({ container: 'mp4', video: ['vp09.00.41.08'], audio: ['opus', 'mp4a.40.2'] });
  }
  if (container !== 'mp4') options.push({ container: 'webm', video: ['vp09.00.41.08', 'vp8'], audio: ['opus'] });

  for (const o of options) {
    const video = await supportedVideo(o.video, width, height, fps, bitrate);
    if (!video) continue;
    const audio = await supportedAudio(o.audio, 48000);
    return { container: o.container, video, audio };
  }
  return null;
}

async function resample(buffer, rate) {
  if (buffer.sampleRate === rate && buffer.numberOfChannels === 2) return buffer;
  const ctx = new OfflineAudioContext(2, Math.ceil(buffer.duration * rate), rate);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start();
  return ctx.startRendering();
}

const tick = () => new Promise(r => setTimeout(r, 0));

/**
 * Offline export.
 *   renderFrame(t, dt) must draw the frame for time t onto `canvas`.
 *   prepareFrame(t) (async) lets media (videos) seek before drawing.
 */
export async function exportOffline({ canvas, audioBuffer, duration, fps, config, renderFrame, prepareFrame, onProgress, signal }) {
  const { container, video, audio } = config;
  const Muxer = container === 'mp4' ? MP4Muxer : WebMMuxer;
  const muxer = new Muxer({
    video: { codec: video.codec, width: video.width, height: video.height, fps },
    audio: audio && audioBuffer ? { codec: audio.codec, sampleRate: audio.sampleRate, channels: 2, bitrate: audio.bitrate } : null,
  });

  let failure = null;
  const venc = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideo(chunk, meta),
    error: e => { failure = e; },
  });
  venc.configure({ ...video, latencyMode: 'quality' });

  const total = Math.max(1, Math.round(duration * fps));
  const gop = fps * 2;
  const started = performance.now();

  for (let f = 0; f < total; f++) {
    if (signal?.aborted) { venc.close(); throw new DOMException('Export cancelled', 'AbortError'); }
    if (failure) throw failure;
    const t = f / fps;
    if (prepareFrame) await prepareFrame(t);
    renderFrame(t, 1 / fps);
    const frame = new VideoFrame(canvas, { timestamp: Math.round(t * 1e6), duration: Math.round(1e6 / fps) });
    venc.encode(frame, { keyFrame: f % gop === 0 });
    frame.close();
    while (venc.encodeQueueSize > 6) await new Promise(r => venc.addEventListener('dequeue', r, { once: true }));
    if (f % 4 === 0) {
      const elapsed = (performance.now() - started) / 1000;
      onProgress?.({ phase: 'video', progress: (f + 1) / total, eta: (elapsed / (f + 1)) * (total - f - 1) });
      await tick();
    }
  }
  await venc.flush();
  venc.close();
  if (failure) throw failure;

  if (audio && audioBuffer) {
    onProgress?.({ phase: 'audio', progress: 1, eta: 0 });
    const buf = await resample(audioBuffer, audio.sampleRate);
    const aenc = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudio(chunk, meta),
      error: e => { failure = e; },
    });
    aenc.configure(audio);
    const L = buf.getChannelData(0), R = buf.getChannelData(1);
    const frames = Math.min(buf.length, Math.round(duration * audio.sampleRate));
    const block = 4800;
    for (let i = 0; i < frames; i += block) {
      const n = Math.min(block, frames - i);
      const data = new Float32Array(n * 2);
      data.set(L.subarray(i, i + n), 0);
      data.set(R.subarray(i, i + n), n);
      const ad = new AudioData({
        format: 'f32-planar', sampleRate: audio.sampleRate, numberOfFrames: n, numberOfChannels: 2,
        timestamp: Math.round((i / audio.sampleRate) * 1e6), data,
      });
      aenc.encode(ad);
      ad.close();
      if (aenc.encodeQueueSize > 20) await tick();
    }
    await aenc.flush();
    aenc.close();
    if (failure) throw failure;
  }

  onProgress?.({ phase: 'mux', progress: 1, eta: 0 });
  const blob = muxer.finalize();
  return { blob, ext: container };
}

// ─── Realtime capture ─────────────────────────────────────────────────────

export function startRealtimeRecording(canvas, audioStream, fps = 30) {
  const tracks = [...canvas.captureStream(fps).getVideoTracks()];
  if (audioStream) tracks.push(...audioStream.getAudioTracks());
  const types = [
    ['video/mp4;codecs=avc1.640033,mp4a.40.2', 'mp4'],
    ['video/mp4', 'mp4'],
    ['video/webm;codecs=vp9,opus', 'webm'],
    ['video/webm;codecs=vp8,opus', 'webm'],
    ['video/webm', 'webm'],
  ];
  const [mimeType, ext] = types.find(([t]) => MediaRecorder.isTypeSupported(t)) || ['', 'webm'];
  const rec = new MediaRecorder(new MediaStream(tracks), { mimeType, videoBitsPerSecond: 20e6, audioBitsPerSecond: 256000 });
  const chunks = [];
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise(resolve => {
    rec.onstop = () => resolve({ blob: new Blob(chunks, { type: mimeType.split(';')[0] || 'video/webm' }), ext });
  });
  rec.start(250);
  return { stop: () => { if (rec.state !== 'inactive') rec.stop(); return done; }, recorder: rec };
}

export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
