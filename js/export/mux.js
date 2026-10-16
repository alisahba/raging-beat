// Minimal in-memory muxers for WebCodecs output.
//   WebMMuxer: VP9/VP8/AV1 + Opus
//   MP4Muxer:  H.264/VP9/AV1 + AAC/Opus (moov first, so it streams)
//
// Usage: new XMuxer({ video: {codec, width, height}, audio: {codec, sampleRate, channels} })
//        .addVideo(chunk, meta) / .addAudio(chunk, meta) → .finalize() → Blob

function chunkData(chunk) {
  const data = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);
  return data;
}

function toBytes(desc) {
  if (!desc) return null;
  if (desc instanceof Uint8Array) return desc;
  if (ArrayBuffer.isView(desc)) return new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength);
  return new Uint8Array(desc);
}

function opusHead(channels, sampleRate, preSkip = 312) {
  const b = new Uint8Array(19);
  const dv = new DataView(b.buffer);
  b.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]); // "OpusHead"
  b[8] = 1;
  b[9] = channels;
  dv.setUint16(10, preSkip, true);
  dv.setUint32(12, sampleRate, true);
  dv.setInt16(16, 0, true);
  b[18] = 0;
  return b;
}

function opusPreSkip(head) {
  if (head && head.length >= 12 && head[0] === 0x4f) return new DataView(head.buffer, head.byteOffset).getUint16(10, true);
  return 312;
}

class BaseMuxer {
  constructor({ video, audio }) {
    this.video = video;
    this.audio = audio || null;
    this.vSamples = [];
    this.aSamples = [];
  }
  addVideo(chunk, meta) {
    if (meta?.decoderConfig?.description && !this.video.description) this.video.description = toBytes(meta.decoderConfig.description);
    if (meta?.decoderConfig?.codec) this.video.codecString = meta.decoderConfig.codec;
    this.vSamples.push({ ts: chunk.timestamp, dur: chunk.duration || 0, key: chunk.type === 'key', data: chunkData(chunk) });
  }
  addAudio(chunk, meta) {
    if (meta?.decoderConfig?.description && !this.audio.description) this.audio.description = toBytes(meta.decoderConfig.description);
    this.aSamples.push({ ts: chunk.timestamp, dur: chunk.duration || 0, key: true, data: chunkData(chunk) });
  }
}

// ─── WebM (Matroska) ──────────────────────────────────────────────────────

const E = {
  EBML: 0x1a45dfa3, EBMLVersion: 0x4286, EBMLReadVersion: 0x42f7, EBMLMaxIDLength: 0x42f2, EBMLMaxSizeLength: 0x42f3,
  DocType: 0x4282, DocTypeVersion: 0x4287, DocTypeReadVersion: 0x4285,
  Segment: 0x18538067, SeekHead: 0x114d9b74, Seek: 0x4dbb, SeekID: 0x53ab, SeekPosition: 0x53ac,
  Info: 0x1549a966, TimecodeScale: 0x2ad7b1, MuxingApp: 0x4d80, WritingApp: 0x5741, Duration: 0x4489,
  Tracks: 0x1654ae6b, TrackEntry: 0xae, TrackNumber: 0xd7, TrackUID: 0x73c5, TrackType: 0x83, FlagLacing: 0x9c,
  CodecID: 0x86, CodecPrivate: 0x63a2, CodecDelay: 0x56aa, SeekPreRoll: 0x56bb,
  Video: 0xe0, PixelWidth: 0xb0, PixelHeight: 0xba, Audio: 0xe1, SamplingFrequency: 0xb5, Channels: 0x9f,
  Cluster: 0x1f43b675, Timecode: 0xe7, SimpleBlock: 0xa3,
  Cues: 0x1c53bb6b, CuePoint: 0xbb, CueTime: 0xb3, CueTrackPositions: 0xb7, CueTrack: 0xf7, CueClusterPosition: 0xf1,
};

function idBytes(id) {
  const out = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff);
  return Uint8Array.from(out);
}

function vint(n) {
  for (let len = 1; len <= 8; len++) {
    if (n < 2 ** (7 * len) - 1) {
      const b = new Uint8Array(len);
      let v = n;
      for (let i = len - 1; i >= 0; i--) { b[i] = v & 0xff; v = Math.floor(v / 256); }
      b[0] |= 1 << (8 - len);
      return b;
    }
  }
  throw new Error('EBML size too large');
}

function uintBytes(v, fixed = 0) {
  const out = [];
  let x = v;
  do { out.unshift(x & 0xff); x = Math.floor(x / 256); } while (x > 0);
  while (out.length < fixed) out.unshift(0);
  return Uint8Array.from(out);
}

const f64 = v => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v); return b; };
const str = s => new TextEncoder().encode(s);

// Element node: { id, data: Uint8Array } or { id, kids: [...] }
const el = (id, x) => (Array.isArray(x) ? { id: E[id], kids: x } : { id: E[id], data: x });
const u = (id, v, fixed) => el(id, uintBytes(v, fixed));

function size(node) {
  if (node.size != null) return node.size;
  const body = node.data ? node.data.length : node.kids.reduce((s, k) => s + size(k), 0);
  node.body = body;
  node.size = idBytes(node.id).length + vint(body).length + body;
  return node.size;
}

function serialize(node, parts) {
  size(node);
  parts.push(idBytes(node.id), vint(node.body));
  if (node.data) parts.push(node.data);
  else for (const k of node.kids) serialize(k, parts);
}

export class WebMMuxer extends BaseMuxer {
  finalize() {
    const v = this.video, a = this.audio;
    const vCodec = v.codec.startsWith('vp09') ? 'V_VP9' : v.codec.startsWith('av01') ? 'V_AV1' : 'V_VP8';

    const lastV = this.vSamples[this.vSamples.length - 1];
    const durationMs = lastV ? (lastV.ts + (lastV.dur || 0)) / 1000 : 0;

    const videoTrack = el('TrackEntry', [
      u('TrackNumber', 1), u('TrackUID', 1), u('TrackType', 1), u('FlagLacing', 0),
      el('CodecID', str(vCodec)),
      ...(vCodec === 'V_AV1' && v.description ? [el('CodecPrivate', v.description)] : []),
      el('Video', [u('PixelWidth', v.width), u('PixelHeight', v.height)]),
    ]);
    const tracks = [videoTrack];
    if (a) {
      const head = a.description && a.description[0] === 0x4f ? a.description : opusHead(a.channels, a.sampleRate);
      a.head = head;
      tracks.push(el('TrackEntry', [
        u('TrackNumber', 2), u('TrackUID', 2), u('TrackType', 2), u('FlagLacing', 0),
        el('CodecID', str('A_OPUS')),
        el('CodecPrivate', head),
        u('CodecDelay', Math.round((opusPreSkip(head) / 48000) * 1e9)),
        u('SeekPreRoll', 80000000),
        el('Audio', [el('SamplingFrequency', f64(a.sampleRate)), u('Channels', a.channels)]),
      ]));
    }

    const info = el('Info', [
      u('TimecodeScale', 1000000),
      el('MuxingApp', str('raging-beat')),
      el('WritingApp', str('raging-beat')),
      el('Duration', f64(durationMs)),
    ]);
    const tracksEl = el('Tracks', tracks);

    // Interleave blocks by time; start a cluster at each video keyframe
    const blocks = [
      ...this.vSamples.map(s => ({ ...s, track: 1 })),
      ...this.aSamples.map(s => ({ ...s, track: 2 })),
    ].sort((p, q) => p.ts - q.ts || p.track - q.track);

    const clusters = [];
    let cur = null;
    for (const b of blocks) {
      const ms = Math.round(b.ts / 1000);
      if (!cur || (b.track === 1 && b.key) || ms - cur.tc > 30000) {
        cur = { tc: ms, blocks: [], key: b.track === 1 && b.key };
        clusters.push(cur);
      }
      const head = new Uint8Array(4);
      head[0] = 0x80 | b.track;
      new DataView(head.buffer).setInt16(1, ms - cur.tc);
      head[3] = b.key ? 0x80 : 0;
      const data = new Uint8Array(4 + b.data.length);
      data.set(head);
      data.set(b.data, 4);
      cur.blocks.push(el('SimpleBlock', data));
    }
    const clusterEls = clusters.map(c => ({ c, node: el('Cluster', [u('Timecode', c.tc), ...c.blocks]) }));

    // Layout with fixed-width positions so sizes don't depend on offsets
    const seekEntry = (id, pos) => el('Seek', [el('SeekID', idBytes(E[id])), u('SeekPosition', pos, 8)]);
    const mkSeekHead = (pInfo, pTracks, pCues) => el('SeekHead', [seekEntry('Info', pInfo), seekEntry('Tracks', pTracks), seekEntry('Cues', pCues)]);
    const seekSize = size(mkSeekHead(0, 0, 0));
    const pInfo = seekSize;
    const pTracks = pInfo + size(info);
    let pos = pTracks + size(tracksEl);
    const cuePoints = [];
    for (const { c, node } of clusterEls) {
      if (c.key) cuePoints.push(el('CuePoint', [u('CueTime', c.tc), el('CueTrackPositions', [u('CueTrack', 1), u('CueClusterPosition', pos, 8)])]));
      pos += size(node);
    }
    const cues = el('Cues', cuePoints.length ? cuePoints : [el('CuePoint', [u('CueTime', 0), el('CueTrackPositions', [u('CueTrack', 1), u('CueClusterPosition', pTracks + size(tracksEl), 8)])])]);
    const seekHead = mkSeekHead(pInfo, pTracks, pos);

    const ebml = el('EBML', [
      u('EBMLVersion', 1), u('EBMLReadVersion', 1), u('EBMLMaxIDLength', 4), u('EBMLMaxSizeLength', 8),
      el('DocType', str('webm')), u('DocTypeVersion', 4), u('DocTypeReadVersion', 2),
    ]);
    const segment = el('Segment', [seekHead, info, tracksEl, ...clusterEls.map(x => x.node), cues]);

    const parts = [];
    serialize(ebml, parts);
    serialize(segment, parts);
    return new Blob(parts, { type: a ? 'video/webm' : 'video/webm' });
  }
}

// ─── MP4 (ISO BMFF) ───────────────────────────────────────────────────────

function concat(arrs) {
  const n = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
const u8 = v => Uint8Array.of(v & 0xff);
const u16 = v => Uint8Array.of((v >> 8) & 0xff, v & 0xff);
const u24 = v => Uint8Array.of((v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
const u32 = v => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0); return b; };
const i16 = v => { const b = new Uint8Array(2); new DataView(b.buffer).setInt16(0, v); return b; };
const fourcc = s => str(s);
const zeros = n => new Uint8Array(n);

function box(type, ...payload) {
  const body = concat(payload.flat());
  return concat([u32(8 + body.length), fourcc(type), body]);
}
const fullbox = (type, version, flags, ...payload) => box(type, u8(version), u24(flags), ...payload);

const MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000].map(u32);

// esds descriptor with 1-byte length when small, 4-byte otherwise
function descr(tag, body) {
  const len = body.length;
  const lenBytes = len < 128 ? [len] : [0x80 | ((len >> 21) & 0x7f), 0x80 | ((len >> 14) & 0x7f), 0x80 | ((len >> 7) & 0x7f), len & 0x7f];
  return concat([Uint8Array.of(tag, ...lenBytes), body]);
}

export class MP4Muxer extends BaseMuxer {
  finalize() {
    const v = this.video, a = this.audio;
    const VTS = 90000;
    const ATS = a ? a.sampleRate : 1;
    const MTS = 1000;

    const vs = this.vSamples, as = this.aSamples;
    const toTS = (samples, ts, fallbackDur) => samples.map((s, i) => {
      const next = samples[i + 1];
      const durUs = next ? next.ts - s.ts : (s.dur || fallbackDur);
      return Math.max(1, Math.round((durUs * ts) / 1e6));
    });
    const vDur = toTS(vs, VTS, 1e6 / (v.fps || 30));
    const aDur = a ? toTS(as, ATS, 1e6 * (a.codec === 'opus' ? 960 / 48000 : 1024 / a.sampleRate)) : [];
    const vTotal = vDur.reduce((p, q) => p + q, 0);
    const aTotal = aDur.reduce((p, q) => p + q, 0);
    const movieDur = Math.max(Math.round((vTotal / VTS) * MTS), a ? Math.round((aTotal / ATS) * MTS) : 0);

    // Interleave samples in mdat by time
    const order = [
      ...vs.map((s, i) => ({ t: s.ts, track: 'v', i })),
      ...as.map((s, i) => ({ t: s.ts, track: 'a', i })),
    ].sort((p, q) => p.t - q.t || (p.track === 'v' ? -1 : 1));

    const stts = durs => {
      const runs = [];
      for (const d of durs) {
        const last = runs[runs.length - 1];
        if (last && last[1] === d) last[0]++; else runs.push([1, d]);
      }
      return fullbox('stts', 0, 0, u32(runs.length), ...runs.map(([c, d]) => [u32(c), u32(d)]));
    };
    const stsz = samples => fullbox('stsz', 0, 0, u32(0), u32(samples.length), ...samples.map(s => u32(s.data.length)));
    const stsc = () => fullbox('stsc', 0, 0, u32(1), u32(1), u32(1), u32(1));

    const videoEntry = () => {
      const visual = (type, ...extra) => box(type,
        zeros(6), u16(1),                       // reserved, data_reference_index
        zeros(16),                              // pre_defined / reserved
        u16(v.width), u16(v.height),
        u32(0x00480000), u32(0x00480000),       // 72 dpi
        u32(0), u16(1),                         // reserved, frame_count
        zeros(32),                              // compressorname
        u16(0x0018), i16(-1),
        ...extra);
      if (v.codec.startsWith('avc1')) return visual('avc1', box('avcC', v.description));
      if (v.codec.startsWith('av01')) return visual('av01', box('av1C', v.description || Uint8Array.of(0x81, 0, 0, 0)));
      // vp09.PP.LL.DD
      const [, prof, lvl, depth] = v.codec.split('.').map(Number);
      const vpcC = fullbox('vpcC', 1, 0, u8(prof || 0), u8(lvl || 10), u8(((depth || 8) << 4) | (1 << 1) | 0), u8(1), u8(1), u8(1), u16(0));
      return visual('vp09', vpcC);
    };

    const audioEntry = () => {
      const opus = a.codec === 'opus';
      const sound = (type, ...extra) => box(type,
        zeros(6), u16(1), zeros(8),
        u16(a.channels), u16(16), u16(0), u16(0),
        u32((opus ? 48000 : a.sampleRate) * 65536),
        ...extra);
      if (opus) {
        const preSkip = opusPreSkip(a.description);
        const dOps = box('dOps', u8(0), u8(a.channels), u16(preSkip), u32(a.sampleRate), i16(0), u8(0));
        return sound('Opus', dOps);
      }
      const asc = a.description || Uint8Array.of(0x12, 0x10);
      const dcd = descr(0x04, concat([
        Uint8Array.of(0x40, 0x15), u24(0), u32(a.bitrate || 192000), u32(a.bitrate || 192000),
        descr(0x05, asc),
      ]));
      const esd = descr(0x03, concat([u16(1), u8(0), dcd, descr(0x06, Uint8Array.of(0x02))]));
      return sound('mp4a', fullbox('esds', 0, 0, esd));
    };

    const trak = (id, kind, samples, durs, timescale, entry, offsets) => {
      const total = durs.reduce((p, q) => p + q, 0);
      const isV = kind === 'vide';
      const stbl = box('stbl',
        fullbox('stsd', 0, 0, u32(1), entry),
        stts(durs),
        ...(isV ? [fullbox('stss', 0, 0, u32(samples.filter(s => s.key).length), ...samples.map((s, i) => (s.key ? u32(i + 1) : null)).filter(Boolean))] : []),
        stsc(),
        stsz(samples),
        fullbox('stco', 0, 0, u32(offsets.length), ...offsets.map(o => u32(o))),
      );
      const minf = box('minf',
        isV ? fullbox('vmhd', 0, 1, zeros(8)) : fullbox('smhd', 0, 0, zeros(4)),
        box('dinf', fullbox('dref', 0, 0, u32(1), fullbox('url ', 0, 1))),
        stbl);
      return box('trak',
        fullbox('tkhd', 0, 3, u32(0), u32(0), u32(id), u32(0), u32(Math.round((total / timescale) * MTS)),
          zeros(8), u16(0), u16(0), u16(isV ? 0 : 0x0100), u16(0), ...MATRIX,
          u32(isV ? v.width * 65536 : 0), u32(isV ? v.height * 65536 : 0)),
        box('mdia',
          fullbox('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(total), u16(0x55c4), u16(0)),
          fullbox('hdlr', 0, 0, u32(0), fourcc(kind), zeros(12), str(isV ? 'VideoHandler\0' : 'SoundHandler\0')),
          minf));
    };

    const buildMoov = (vOff, aOff) => box('moov',
      fullbox('mvhd', 0, 0, u32(0), u32(0), u32(MTS), u32(movieDur), u32(0x00010000), u16(0x0100), zeros(10), ...MATRIX, zeros(24), u32(a ? 3 : 2)),
      trak(1, 'vide', vs, vDur, VTS, videoEntry(), vOff),
      ...(a ? [trak(2, 'soun', as, aDur, ATS, audioEntry(), aOff)] : []));

    const brand = v.codec.startsWith('avc1') ? 'avc1' : 'iso6';
    const ftyp = box('ftyp', fourcc('isom'), u32(0x200), fourcc('isom'), fourcc('iso2'), fourcc(brand), fourcc('mp41'));

    // Offsets are fixed-width, so moov's size doesn't depend on their values
    const moovSize = buildMoov(vs.map(() => 0), as.map(() => 0)).length;
    const mdatData = order.reduce((s, o) => s + (o.track === 'v' ? vs : as)[o.i].data.length, 0);
    const mdatHeader = concat([u32(8 + mdatData), fourcc('mdat')]);
    let pos = ftyp.length + moovSize + mdatHeader.length;
    const vOff = new Array(vs.length), aOff = new Array(as.length);
    const parts = [];
    for (const o of order) {
      const s = (o.track === 'v' ? vs : as)[o.i];
      (o.track === 'v' ? vOff : aOff)[o.i] = pos;
      pos += s.data.length;
      parts.push(s.data);
    }
    const moov = buildMoov(vOff, aOff);
    return new Blob([ftyp, moov, mdatHeader, ...parts], { type: 'video/mp4' });
  }
}
