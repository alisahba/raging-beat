// GLSL ES 3.00 programs for the render pipeline:
//   source → style → post → screen

export const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const COMMON = `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
mat2 rot2(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
`;

// ─── Source: media → framed, transformed, tone-mapped RGB + luminance ──────

export const SOURCE = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_tex;
uniform vec2 u_texSize, u_outSize;
uniform int u_fit;          // 0 cover, 1 contain
uniform float u_zoom, u_rot;
uniform vec2 u_offset;      // in output-height units
uniform int u_mirror;       // 0 none, 1 horizontal, 2 vertical, 3 quad, 4 kaleido
uniform float u_warp, u_time;
uniform float u_glitch, u_seed;
uniform vec3 u_tone;        // black, white, gamma
uniform float u_frameZoom;  // per-media crop zoom (>= 1)
uniform vec2 u_pan;         // per-media pan, -1..1 across the cropped overflow
${COMMON}

vec2 mirrorUv(vec2 uv) {
  if (u_mirror == 1 || u_mirror == 3) uv.x = uv.x > 0.5 ? 1.0 - uv.x : uv.x;
  if (u_mirror == 2 || u_mirror == 3) uv.y = uv.y > 0.5 ? 1.0 - uv.y : uv.y;
  if (u_mirror == 4) {
    vec2 p = (uv - 0.5) * vec2(u_outSize.x / u_outSize.y, 1.0);
    float r = length(p), a = atan(p.y, p.x);
    float seg = 6.2831853 / 6.0;
    a = mod(a, seg);
    a = abs(a - seg * 0.5);
    p = r * vec2(cos(a), sin(a));
    uv = p / vec2(u_outSize.x / u_outSize.y, 1.0) + 0.5;
  }
  return uv;
}

void main() {
  vec2 uv = mirrorUv(v_uv);

  // Wave warp
  if (u_warp > 0.0) {
    uv.x += sin(uv.y * 11.0 + u_time * 2.7) * 0.025 * u_warp;
    uv.y += sin(uv.x * 7.0 - u_time * 1.9) * 0.018 * u_warp;
  }

  // Glitch: displaced horizontal bands and blocks
  if (u_glitch > 0.0) {
    float bands = 8.0 + floor(hash12(vec2(u_seed, 1.0)) * 40.0);
    float b = floor(uv.y * bands);
    float r = hash12(vec2(b, u_seed));
    if (r < u_glitch * 0.55) uv.x += (hash12(vec2(b, u_seed + 7.0)) - 0.5) * 0.35 * u_glitch;
    vec2 blk = floor(uv * vec2(6.0, 10.0));
    float rb = hash12(blk + u_seed * 3.1);
    if (rb < u_glitch * 0.15) uv += (vec2(hash12(blk + 11.0 + u_seed), hash12(blk + 23.0 + u_seed)) - 0.5) * 0.2;
  }

  // Output pixel space, centred, then camera transform
  vec2 p = (uv - 0.5) * u_outSize;
  p = rot2(-u_rot) * p / u_zoom - u_offset * u_outSize.y;

  // Fit media into the frame
  float sx = u_outSize.x / u_texSize.x, sy = u_outSize.y / u_texSize.y;
  float s = (u_fit == 0 ? max(sx, sy) : min(sx, sy)) * u_frameZoom;
  vec2 visible = u_outSize / (u_texSize * s);
  vec2 tuv = p / (u_texSize * s) + 0.5 + u_pan * max(vec2(0.0), 1.0 - visible) * 0.5;

  vec3 c;
  if (u_fit == 1 && (tuv.x < 0.0 || tuv.x > 1.0 || tuv.y < 0.0 || tuv.y > 1.0)) c = vec3(0.0);
  else c = texture(u_tex, tuv).rgb;

  // Levels + gamma
  float range = max(u_tone.y - u_tone.x, 0.004);
  vec3 t = pow(clamp((c - u_tone.x) / range, 0.0, 1.0), vec3(u_tone.z));
  float l = pow(clamp((luma(c) - u_tone.x) / range, 0.0, 1.0), u_tone.z);
  o = vec4(t, l);
}`;

// ─── Style: stylise luminance through the palette ──────────────────────────

export const STYLE = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_src;      // rgb + luminance in alpha, mipmapped
uniform sampler2D u_glyphs;
uniform vec2 u_outSize;
uniform float u_cell;
uniform int u_style;          // 0 pixel 1 dither 2 halftone 3 lines 4 ascii 5 edge
uniform int u_levels;
uniform vec3 u_pal[8];
uniform int u_palCount;
uniform bool u_srcColor;
uniform int u_dither;         // 0 bayer, 1 noise, 2 cluster
uniform float u_angle;
uniform int u_shape;          // 0 circle 1 square 2 diamond 3 line
uniform bool u_inkDark;
uniform int u_glyphCount, u_glyphCols;
uniform vec2 u_glyphGrid;     // cols, rows
uniform bool u_flip;
${COMMON}

vec3 gradient(float v) {
  float x = clamp(v, 0.0, 1.0) * float(u_palCount - 1);
  int i = min(int(floor(x)), u_palCount - 2);
  return mix(u_pal[i], u_pal[i + 1], x - float(i));
}

float L() { return float(max(u_levels, 2) - 1); }
float quant(float v, float thr) { return clamp(floor(v * L() + thr) / L(), 0.0, 1.0); }

vec3 colorize(float q, vec3 rgb, float thr) {
  if (u_srcColor) return clamp(floor(rgb * L() + thr) / L(), 0.0, 1.0);
  return gradient(q);
}

vec4 sampleAt(vec2 px, float cell) {
  float lod = cell > 1.0 ? log2(cell) : 0.0;
  vec4 s = textureLod(u_src, px / u_outSize, lod);
  if (u_flip) s = vec4(1.0 - s.rgb, 1.0 - s.a);
  return s;
}

float bayer8(vec2 p) {
  ivec2 i = ivec2(mod(p, 8.0));
  int x = i.x, y = i.y;
  int v = 0;
  // Bit-interleave construction of the 8x8 Bayer matrix
  for (int b = 0; b < 3; b++) {
    int xb = (x >> b) & 1, yb = (y >> b) & 1;
    v |= ((xb ^ yb) << (5 - 2 * b)) | (yb << (4 - 2 * b));
  }
  return (float(v) + 0.5) / 64.0;
}

float cluster4(vec2 p) {
  ivec2 i = ivec2(mod(p, 4.0));
  int m[16] = int[16](12, 5, 6, 13, 4, 0, 1, 7, 11, 3, 2, 8, 15, 10, 9, 14);
  return (float(m[i.y * 4 + i.x]) + 0.5) / 16.0;
}

float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

// Coverage mask of a mark of the given size in a cell (local in -0.5..0.5)
float mark(vec2 local, float cov, float cell) {
  float aa = 1.0 / max(cell, 1.0);
  if (u_shape == 1) { float r = 0.5 * sqrt(cov); float d = max(abs(local.x), abs(local.y)); return smoothstep(r + aa, r - aa, d); }
  if (u_shape == 2) { float r = 0.5 * sqrt(2.0 * cov); float d = (abs(local.x) + abs(local.y)) * 0.7071; return smoothstep(r * 0.7071 + aa, r * 0.7071 - aa, d); }
  if (u_shape == 3) { float r = 0.5 * cov; return smoothstep(r + aa, r - aa, abs(local.y)); }
  float r = 0.7072 * sqrt(cov);
  return smoothstep(r + aa, r - aa, length(local));
}

void main() {
  vec2 px = v_uv * u_outSize;
  float c = max(u_cell, 1.0);
  vec3 col;

  if (u_style == 0 || u_style == 1) {
    vec2 cell = floor(px / c);
    vec4 s = sampleAt((cell + 0.5) * c, c);
    float thr = 0.5;
    if (u_style == 1) thr = u_dither == 0 ? bayer8(cell) : u_dither == 1 ? ign(cell) : cluster4(cell);
    col = colorize(quant(s.a, thr), s.rgb, thr);
  }
  else if (u_style == 2 || u_style == 3) {
    float a = radians(u_angle);
    vec2 rp = rot2(a) * (px - 0.5 * u_outSize);
    vec2 cell = floor(rp / c);
    vec2 local = rp / c - cell - 0.5;
    vec2 centre = transpose(rot2(a)) * ((cell + 0.5) * c) + 0.5 * u_outSize;
    if (u_style == 3) {
      // lines: sample along the line at pixel resolution for smooth width
      centre = transpose(rot2(a)) * vec2(rp.x, (cell.y + 0.5) * c) + 0.5 * u_outSize;
    }
    vec4 s = sampleAt(centre, c);
    float v = s.a;
    // Two inks: light marks on the shadow colour or dark marks on the highlight
    vec3 lo = u_srcColor ? vec3(0.0) : gradient(0.0);
    vec3 hi = u_srcColor ? s.rgb : gradient(1.0);
    if (u_levels > 2 && !u_srcColor) hi = gradient(max(quant(v, 0.5), 1.0 / L()));
    float cov = u_inkDark ? 1.0 - v : v;
    float m = u_style == 3
      ? smoothstep(0.5 * cov + 0.75 / c, 0.5 * cov - 0.75 / c, abs(local.y))
      : mark(local, cov, c);
    if (u_inkDark) {
      vec3 dark = u_levels > 2 && !u_srcColor ? gradient(min(quant(v, 0.5), 1.0 - 1.0 / L())) : lo;
      col = mix(gradient(1.0), dark, m);
      if (u_srcColor) col = mix(vec3(1.0), s.rgb * 0.6, m);
    } else {
      col = mix(lo, hi, m);
    }
  }
  else if (u_style == 4) {
    float cc = max(c, 6.0);
    vec2 cell = floor(px / cc);
    vec2 local = px / cc - cell;
    vec4 s = sampleAt((cell + 0.5) * cc, cc);
    // Glyphs cover at most ~half a cell, so lift the tones to compensate
    float v = pow(u_inkDark ? 1.0 - s.a : s.a, 0.7);
    float gi = min(floor(v * float(u_glyphCount)), float(u_glyphCount - 1));
    vec2 g = vec2(mod(gi, u_glyphGrid.x), floor(gi / u_glyphGrid.x));
    vec2 guv = (g + vec2(local.x, 1.0 - local.y)) / u_glyphGrid;
    float m = texture(u_glyphs, guv).r;
    if (u_inkDark) {
      col = mix(gradient(1.0), u_srcColor ? s.rgb * 0.6 : gradient(min(quant(s.a, 0.5), 1.0 - 1.0 / L())), m);
    } else {
      vec3 fg = u_srcColor ? s.rgb : gradient(max(quant(s.a, 0.5), 1.0 / L()));
      col = mix(u_srcColor ? vec3(0.0) : gradient(0.0), fg, m);
    }
  }
  else {
    // Edge: Sobel on cell-averaged luminance, over a dim posterised fill
    vec2 cell = floor(px / c);
    vec2 ctr = (cell + 0.5) * c;
    float lod = c;
    float tl = sampleAt(ctr + vec2(-c,  c), lod).a, tc = sampleAt(ctr + vec2(0.0,  c), lod).a, tr = sampleAt(ctr + vec2(c,  c), lod).a;
    float ml = sampleAt(ctr + vec2(-c, 0.0), lod).a,                                          mr = sampleAt(ctr + vec2(c, 0.0), lod).a;
    float bl = sampleAt(ctr + vec2(-c, -c), lod).a, bc = sampleAt(ctr + vec2(0.0, -c), lod).a, br = sampleAt(ctr + vec2(c, -c), lod).a;
    float gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
    float gy = (tl + 2.0 * tc + tr) - (bl + 2.0 * bc + br);
    float e = smoothstep(0.18, 0.45, length(vec2(gx, gy)));
    vec4 s = sampleAt(ctr, c);
    float q = quant(s.a, 0.5);
    vec3 fill, ink;
    if (u_inkDark) {
      // dark linework over a pale posterised wash
      fill = u_srcColor ? 1.0 - (1.0 - floor(s.rgb * L() + 0.5) / L()) * 0.35 : gradient(1.0 - (1.0 - q) * 0.35);
      ink = u_srcColor ? vec3(0.0) : gradient(0.0);
    } else {
      fill = u_srcColor ? floor(s.rgb * L() + 0.5) / L() * 0.35 : gradient(q * 0.35);
      ink = u_srcColor ? vec3(1.0) : gradient(1.0);
    }
    col = mix(fill, ink, e);
  }

  o = vec4(col, 1.0);
}`;

// ─── Post: chromatic split, trails, flash, scanlines, grain ────────────────

export const POST = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_cur, u_prev;
uniform vec2 u_outSize;
uniform vec2 u_rgb;           // channel offset in uv
uniform float u_trails;       // per-frame persistence 0..1
uniform int u_trailMode;      // 0 lighten, 1 darken
uniform float u_flash;
uniform vec3 u_flashColor;
uniform float u_scan, u_grain, u_seed;
${COMMON}

void main() {
  vec2 uv = v_uv;
  vec3 c = vec3(
    texture(u_cur, uv + u_rgb).r,
    texture(u_cur, uv).g,
    texture(u_cur, uv - u_rgb).b
  );
  if (u_trails > 0.001) {
    vec2 puv = (uv - 0.5) * 0.985 + 0.5;
    vec3 p = texture(u_prev, puv).rgb;
    c = u_trailMode == 0 ? max(c, p * u_trails) : min(c, 1.0 - (1.0 - p) * u_trails);
  }
  c = mix(c, u_flashColor, clamp(u_flash, 0.0, 1.0));
  if (u_scan > 0.0) {
    float period = max(3.0, floor(u_outSize.y / 360.0));
    float row = mod(gl_FragCoord.y, period) / period;
    c *= 1.0 - u_scan * 0.55 * smoothstep(0.35, 0.65, row);
  }
  if (u_grain > 0.0) c += (hash12(gl_FragCoord.xy + u_seed * 17.0) - 0.5) * u_grain * 0.35;
  o = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

export const BLIT = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_tex;
void main() { o = texture(u_tex, v_uv); }`;
