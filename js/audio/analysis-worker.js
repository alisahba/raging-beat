import { analyze } from './analyzer.js';

self.onmessage = e => {
  const { id, mono, sampleRate } = e.data;
  try {
    let last = 0;
    const result = analyze(mono, sampleRate, {
      onProgress: p => {
        if (p - last >= 0.02 || p === 1) { last = p; self.postMessage({ id, progress: p }); }
      },
    });
    const transfer = [];
    const collect = o => {
      for (const v of Object.values(o)) {
        if (ArrayBuffer.isView(v)) transfer.push(v.buffer);
        else if (v && typeof v === 'object' && !Array.isArray(v)) collect(v);
      }
    };
    collect(result);
    self.postMessage({ id, result }, transfer);
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
