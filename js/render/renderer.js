// WebGL2 render pipeline.
//
//   media texture ─source→ srcFBO (mipmapped) ─style→ styleFBO
//                 ─post (+ previous output for trails)→ outFBO[i] ─blit→ canvas

import { VERT, SOURCE, STYLE, POST, BLIT } from './shaders.js';
import { GLYPH_SETS } from '../state.js';

const STYLE_IDS = { pixel: 0, dither: 1, halftone: 2, lines: 3, ascii: 4, edge: 5 };
const MIRROR_IDS = { none: 0, horizontal: 1, vertical: 2, quad: 3, kaleido: 4 };
const DITHER_IDS = { bayer: 0, noise: 1, cluster: 2 };
const SHAPE_IDS = { circle: 0, square: 1, diamond: 2, line: 3 };

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error('Shader compile failed: ' + log);
  }
  return s;
}

function program(gl, fsSrc) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fsSrc));
  gl.bindAttribLocation(p, 0, 'a_pos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Program link failed: ' + gl.getProgramInfoLog(p));
  const uniforms = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    const name = info.name.replace(/\[0\]$/, '');
    uniforms[name] = gl.getUniformLocation(p, info.name);
  }
  return { p, u: uniforms };
}

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;

    this.progs = {
      source: program(gl, SOURCE),
      style: program(gl, STYLE),
      post: program(gl, POST),
      blit: program(gl, BLIT),
    };

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.mediaTex = new WeakMap();
    this.blank = this.makeTexture(1, 1, new Uint8Array([0, 0, 0, 255]));
    this.glyphSet = null;
    this.outIndex = 0;
    this.width = 0;
    this.height = 0;
  }

  makeTexture(w, h, data = null, { mip = false } = {}) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  makeTarget(w, h, opts) {
    const gl = this.gl;
    const tex = this.makeTexture(w, h, null, opts);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fbo };
  }

  resize(w, h) {
    if (w === this.width && h === this.height) return;
    const gl = this.gl;
    for (const t of [this.src, this.style, ...(this.out || [])]) {
      if (t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); }
    }
    this.canvas.width = w;
    this.canvas.height = h;
    this.width = w;
    this.height = h;
    this.src = this.makeTarget(w, h, { mip: true });
    this.style = this.makeTarget(w, h);
    this.out = [this.makeTarget(w, h), this.makeTarget(w, h)];
    this.clearHistory();
  }

  // Clear the feedback buffers (trails) so an export starts clean
  clearHistory() {
    const gl = this.gl;
    for (const t of this.out || []) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
  }

  // Glyph atlas for the ASCII style, ordered by ink coverage
  setGlyphs(setName) {
    if (this.glyphSet === setName) return;
    this.glyphSet = setName;
    const chars = [...(GLYPH_SETS[setName] || GLYPH_SETS.classic)];
    const size = 64;
    const meas = document.createElement('canvas');
    meas.width = meas.height = size;
    const mctx = meas.getContext('2d', { willReadFrequently: true });
    const draw = (ctx, ch, x, y) => {
      ctx.fillStyle = '#fff';
      ctx.font = `700 ${Math.round(size * 0.9)}px "DM Mono", ui-monospace, Menlo, Consolas, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(ch, x + size / 2, y + size / 2 + size * 0.04);
    };
    const coverage = chars.map(ch => {
      mctx.clearRect(0, 0, size, size);
      draw(mctx, ch, 0, 0);
      const d = mctx.getImageData(0, 0, size, size).data;
      let s = 0;
      for (let i = 0; i < d.length; i += 4) s += d[i];
      return s;
    });
    const order = chars.map((ch, i) => ({ ch, c: coverage[i] })).sort((a, b) => a.c - b.c).map(o => o.ch);
    const cols = Math.min(16, order.length), rows = Math.ceil(order.length / cols);
    const atlas = document.createElement('canvas');
    atlas.width = cols * size;
    atlas.height = rows * size;
    const actx = atlas.getContext('2d');
    actx.fillStyle = '#000';
    actx.fillRect(0, 0, atlas.width, atlas.height);
    order.forEach((ch, i) => draw(actx, ch, (i % cols) * size, Math.floor(i / cols) * size));

    const gl = this.gl;
    if (this.glyphTex) gl.deleteTexture(this.glyphTex);
    this.glyphTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.glyphTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, atlas);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.glyphInfo = { count: order.length, cols, rows };
  }

  // Upload (or refresh, for video) the texture for a media item
  textureFor(media) {
    if (!media) return { tex: this.blank, w: 1, h: 1 };
    const gl = this.gl;
    let entry = this.mediaTex.get(media);
    const el = media.el;
    const w = el.videoWidth || el.naturalWidth || el.width;
    const h = el.videoHeight || el.naturalHeight || el.height;
    if (!w || !h) return entry || { tex: this.blank, w: 1, h: 1 };
    const isVideo = media.type === 'video';
    if (!entry) {
      entry = { tex: gl.createTexture(), w, h, uploaded: false };
      gl.bindTexture(gl.TEXTURE_2D, entry.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, isVideo ? gl.LINEAR : gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
      this.mediaTex.set(media, entry);
    }
    if (!entry.uploaded || isVideo) {
      if (isVideo && el.readyState < 2) return entry.uploaded ? entry : { tex: this.blank, w: 1, h: 1 };
      gl.bindTexture(gl.TEXTURE_2D, entry.tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, el);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      if (!isVideo) gl.generateMipmap(gl.TEXTURE_2D);
      entry.uploaded = true;
      entry.w = w; entry.h = h;
    }
    return entry;
  }

  forget(media) {
    const e = this.mediaTex.get(media);
    if (e) { this.gl.deleteTexture(e.tex); this.mediaTex.delete(media); }
  }

  draw(target) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, this.width, this.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  bindTex(unit, tex) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  // p: frame parameters from compose()
  render(p) {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    const W = this.width, H = this.height;

    // 1. Source
    const m = this.textureFor(p.media);
    let u = this.progs.source.u;
    gl.useProgram(this.progs.source.p);
    this.bindTex(0, m.tex);
    gl.uniform1i(u.u_tex, 0);
    gl.uniform2f(u.u_texSize, m.w, m.h);
    gl.uniform2f(u.u_outSize, W, H);
    gl.uniform1i(u.u_fit, p.fit === 'contain' ? 1 : 0);
    gl.uniform1f(u.u_zoom, p.zoom);
    gl.uniform1f(u.u_rot, p.rot);
    gl.uniform2f(u.u_offset, p.offset[0], p.offset[1]);
    gl.uniform1i(u.u_mirror, MIRROR_IDS[p.mirror] ?? 0);
    gl.uniform1f(u.u_warp, p.warp);
    gl.uniform1f(u.u_time, p.time);
    gl.uniform1f(u.u_glitch, p.glitch);
    gl.uniform1f(u.u_seed, p.glitchSeed);
    gl.uniform3f(u.u_tone, p.tone.black / 255, p.tone.white / 255, 1 / Math.max(0.05, p.tone.gamma));
    gl.uniform1f(u.u_frameZoom, p.frame.zoom);
    gl.uniform2f(u.u_pan, p.frame.x, p.frame.y);
    this.draw(this.src);
    gl.bindTexture(gl.TEXTURE_2D, this.src.tex);
    this.bindTex(0, this.src.tex);
    gl.generateMipmap(gl.TEXTURE_2D);

    // 2. Style
    if (p.style === 'ascii') this.setGlyphs(p.glyphs);
    u = this.progs.style.u;
    gl.useProgram(this.progs.style.p);
    this.bindTex(0, this.src.tex);
    gl.uniform1i(u.u_src, 0);
    this.bindTex(1, this.glyphTex || this.blank);
    gl.uniform1i(u.u_glyphs, 1);
    gl.uniform2f(u.u_outSize, W, H);
    gl.uniform1f(u.u_cell, p.cell);
    gl.uniform1i(u.u_style, STYLE_IDS[p.style] ?? 0);
    gl.uniform1i(u.u_levels, p.levels);
    const pal = new Float32Array(24);
    p.palette.slice(0, 8).forEach((hex, i) => pal.set(hexToRgb(hex), i * 3));
    gl.uniform3fv(u.u_pal, pal);
    gl.uniform1i(u.u_palCount, Math.max(2, Math.min(8, p.palette.length)));
    gl.uniform1i(u.u_srcColor, p.sourceColor ? 1 : 0);
    gl.uniform1i(u.u_dither, DITHER_IDS[p.dither] ?? 0);
    gl.uniform1f(u.u_angle, p.angle);
    gl.uniform1i(u.u_shape, SHAPE_IDS[p.shape] ?? 0);
    gl.uniform1i(u.u_inkDark, p.ink === 'dark' ? 1 : 0);
    const gi = this.glyphInfo || { count: 1, cols: 1, rows: 1 };
    gl.uniform1i(u.u_glyphCount, gi.count);
    gl.uniform2f(u.u_glyphGrid, gi.cols, gi.rows);
    gl.uniform1i(u.u_flip, p.flip ? 1 : 0);
    this.draw(this.style);

    // 3. Post (ping-pong with the previous output for trails)
    const prev = this.out[this.outIndex];
    const next = this.out[1 - this.outIndex];
    u = this.progs.post.u;
    gl.useProgram(this.progs.post.p);
    this.bindTex(0, this.style.tex);
    gl.uniform1i(u.u_cur, 0);
    this.bindTex(1, prev.tex);
    gl.uniform1i(u.u_prev, 1);
    gl.uniform2f(u.u_outSize, W, H);
    gl.uniform2f(u.u_rgb, p.rgb[0], p.rgb[1]);
    gl.uniform1f(u.u_trails, p.trails);
    gl.uniform1i(u.u_trailMode, p.trailMode);
    gl.uniform1f(u.u_flash, p.flash);
    gl.uniform3fv(u.u_flashColor, hexToRgb(p.flashColor));
    gl.uniform1f(u.u_scan, p.scan);
    gl.uniform1f(u.u_grain, p.grain);
    gl.uniform1f(u.u_seed, p.grainSeed);
    this.draw(next);
    this.outIndex = 1 - this.outIndex;

    // 4. Present
    gl.useProgram(this.progs.blit.p);
    this.bindTex(0, next.tex);
    gl.uniform1i(this.progs.blit.u.u_tex, 0);
    this.draw(null);
  }
}
