import { EXPOSURE_STOPS, MAX_MASKS, MIXER_BANDS } from './types.js';

export const VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const f = (n) => n.toFixed(1);

// Single-pass adjustment pipeline. Disabled sections are neutralized on the
// JS side (uniforms set to identity values). The costlier stages (curve,
// mixer, detail taps, masks, grain) sit behind uniform switches, which every
// pixel takes the same way, so a photo only pays for the tools it uses.
export const FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_image;
uniform sampler2D u_curve;  // LUT: per-channel curve with the master folded in
uniform sampler2D u_blur;   // low-res blurred color (rgb) + dark channel (a)
uniform sampler2D u_matte;  // subject matte (r), full-image coordinates
uniform sampler2D u_depth;  // relative depth (r, 1 = near), full-image coordinates
uniform sampler2D u_face;   // face regions: skin (r), eyes (g), lips (b), teeth (a)
uniform sampler2D u_faceId; // which face a pixel belongs to (r × 255, 1-based; 0 = none), nearest-sampled
uniform bool u_flipY;
// Visible window into the image, for zoom/pan: uv' = uv * scale + offset.
uniform vec2 u_uvScale;
uniform vec2 u_uvOffset;
// Cropped frame within the image, so framing effects (vignette) follow the crop.
uniform vec2 u_frameScale;
uniform vec2 u_frameOffset;
uniform vec2 u_texel;       // one source pixel, in uv
uniform float u_aspect;     // source width / height

uniform float u_temperature; // -1..1  blue <-> amber
uniform float u_tint;        // -1..1  green <-> magenta
uniform float u_exposure;    // -1..1  (+-${EXPOSURE_STOPS} stops)
uniform float u_highlights;  // -1..1
uniform float u_shadows;     // -1..1
uniform float u_whites;      // -1..1
uniform float u_brightness;  // -1..1
uniform float u_contrast;    // -1..1
uniform float u_blackPoint;  // -1..1
uniform float u_hue;         // -1..1 (+-180 deg)
uniform float u_saturation;  // -1..1
uniform float u_vibrance;    // -1..1
uniform float u_vignette;    //  0..1
uniform float u_texture;     // -1..1
uniform float u_clarity;     // -1..1
uniform float u_dehaze;      // -1..1
uniform float u_sharpen;     //  0..1
uniform float u_grain;       //  0..1
uniform float u_grainSize;   //  0..1
uniform vec3 u_cbShadows;    // rgb offsets, ~[-0.35, 0.35]
uniform vec3 u_cbMidtones;
uniform vec3 u_cbHighlights;
uniform vec3 u_cbLum;        // luminance offset per range (shadows, mids, highs)
uniform vec3 u_airlight;     // haze color, estimated per image

uniform bool u_curveOn;
uniform bool u_mixerOn;
uniform bool u_detailOn;     // sharpening / texture taps
uniform bool u_blurOn;       // clarity / dehaze (u_blur is valid)
uniform bool u_lensOn;       // lens blur (u_depth is valid)
uniform vec3 u_lens;         // max blur radius (uv of width), focus depth, focus range
uniform float u_mixHue[8];
uniform float u_mixSat[8];
uniform float u_mixLum[8];

// Masks: geo = linear (x0, y0, x1, y1) or radial (cx, cy, rx, ry);
// opt = (type 0 subject / 1 linear / 2 radial / 3 skin / 4 eyes / 5 lips / 6 teeth,
//        invert, feather, face bits: which faces a face mask applies to);
// adjA = (exposure, contrast, highlights, shadows);
// adjB = (temperature, tint, saturation, clarity);
// adjC = (texture, -, -, -).
uniform int u_maskCount;
uniform vec4 u_maskGeo[${MAX_MASKS}];
uniform vec4 u_maskOpt[${MAX_MASKS}];
uniform vec4 u_maskAdjA[${MAX_MASKS}];
uniform vec4 u_maskAdjB[${MAX_MASKS}];
uniform vec4 u_maskAdjC[${MAX_MASKS}];
uniform int u_showMask;      // mask drawn as a red overlay, or -1
uniform int u_outlineMask;   // mask whose edge is drawn as a dashed line, or -1

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
const float BANDS[8] = float[8](${MIXER_BANDS.map((b) => f(b.center)).join(', ')});

vec3 hueRotate(vec3 c, float angle) {
  float ca = cos(angle);
  float sa = sin(angle);
  mat3 m = mat3(
    0.299 + 0.701 * ca + 0.168 * sa, 0.587 - 0.587 * ca + 0.330 * sa, 0.114 - 0.114 * ca - 0.497 * sa,
    0.299 - 0.299 * ca - 0.328 * sa, 0.587 + 0.413 * ca + 0.035 * sa, 0.114 - 0.114 * ca + 0.292 * sa,
    0.299 - 0.300 * ca + 1.250 * sa, 0.587 - 0.588 * ca - 1.050 * sa, 0.114 + 0.886 * ca - 0.203 * sa
  );
  return c * m;
}

vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
}

vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}

/** Lens blur strength at p: 0 inside the focus band, 1 well outside it. */
float cocAt(vec2 p) {
  float off = abs(texture(u_depth, p).r - u_lens.y) - u_lens.z * 0.5;
  return clamp(off / 0.3, 0.0, 1.0);
}

float lumaAt(vec2 uv) {
  return dot(texture(u_image, uv).rgb, LUMA);
}

float maskWeight(int i, vec2 uv) {
  vec4 g = u_maskGeo[i];
  vec4 o = u_maskOpt[i];
  float w;
  if (o.x < 0.5) {
    w = texture(u_matte, uv).r;
  } else if (o.x < 1.5) {
    vec2 a = vec2(u_aspect, 1.0);
    vec2 d = (g.zw - g.xy) * a;
    float t = dot((uv - g.xy) * a, d) / max(dot(d, d), 1e-8);
    w = 1.0 - smoothstep(0.0, 1.0, t);
  } else if (o.x < 2.5) {
    float r = length((uv - g.xy) / max(g.zw, vec2(1e-4)));
    w = 1.0 - smoothstep(1.0 - max(o.z, 0.002), 1.0, r);
  } else {
    vec4 f = texture(u_face, uv);
    w = o.x < 3.5 ? f.r : o.x < 4.5 ? f.g : o.x < 5.5 ? f.b : f.a;
    int id = int(texture(u_faceId, uv).r * 255.0 + 0.5);
    w *= id > 0 && ((int(o.w) >> (id - 1)) & 1) == 1 ? 1.0 : 0.0;
  }
  return o.y > 0.5 ? 1.0 - w : w;
}

float hash(vec2 p) {
  uvec2 q = uvec2(ivec2(p) + 32768) * uvec2(1597334673u, 3812015801u);
  uint n = (q.x ^ q.y) * 1597334673u;
  return float(n) * (1.0 / 4294967295.0);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 fr = fract(p);
  vec2 u = fr * fr * (3.0 - 2.0 * fr);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

void main() {
  vec2 uv0 = u_flipY ? vec2(v_uv.x, 1.0 - v_uv.y) : v_uv;
  vec2 uv = uv0 * u_uvScale + u_uvOffset;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    outColor = vec4(0.0);
    return;
  }
  vec4 src = texture(u_image, uv);

  // ---- Lens blur: a depth-aware disc blur of the source ----
  // Taps on a jittered golden-angle spiral; a tap counts only if its own
  // blur reaches this pixel, so sharp subjects don't smear into the background.
  float lensMix = 0.0;
  if (u_lensOn) {
    lensMix = cocAt(uv);
    float R = lensMix * u_lens.x;
    if (R > u_texel.x * 0.75) {
      vec3 acc = src.rgb;
      float wsum = 1.0;
      float rot = hash(uv / u_texel) * 6.2831853;
      for (int k = 0; k < 40; k++) {
        float r = sqrt((float(k) + 0.5) / 40.0) * R;
        float a = float(k) * 2.39996323 + rot;
        vec2 p = uv + vec2(cos(a), sin(a) * u_aspect) * r;
        float reach = cocAt(p) * u_lens.x;
        float w = clamp((reach - r) / (u_texel.x * 2.0) + 1.0, 0.0, 1.0);
        vec3 s = texture(u_image, p).rgb;
        // Bright taps weigh more, so highlights bloom into bokeh discs.
        float boost = 1.0 + 12.0 * max(dot(s, LUMA) - 0.75, 0.0);
        acc += s * w * boost;
        wsum += w * boost;
      }
      src.rgb = acc / wsum;
    }
  }

  vec3 c = src.rgb;
  float srcL = dot(c, LUMA);

  // ---- Masks: each adds its adjustments, weighted by coverage ----
  vec4 la = vec4(0.0);
  vec4 lb = vec4(0.0);
  vec4 lc = vec4(0.0);
  float shown = 0.0;
  float outlined = 0.0;
  for (int i = 0; i < ${MAX_MASKS}; i++) {
    if (i >= u_maskCount) break;
    float w = maskWeight(i, uv);
    la += w * u_maskAdjA[i];
    lb += w * u_maskAdjB[i];
    lc += w * u_maskAdjC[i];
    if (i == u_showMask) shown = w;
    if (i == u_outlineMask) outlined = w;
  }
  float exposure = u_exposure + la.x;
  float contrast = u_contrast + la.y;
  float highlights = u_highlights + la.z;
  float shadows = u_shadows + la.w;
  float temperature = u_temperature + lb.x;
  float tint = u_tint + lb.y;
  float saturation = u_saturation + lb.z;
  float clarity = u_clarity + lb.w;
  float textureAmt = u_texture + lc.x;

  // ---- Detail bands, measured on the source luminance ----
  float detailS = 0.0; // fine edges (sharpening)
  float detailM = 0.0; // medium detail (texture)
  if (u_detailOn) {
    vec2 t = u_texel;
    float cross4 = lumaAt(uv + vec2(t.x, 0.0)) + lumaAt(uv - vec2(t.x, 0.0))
      + lumaAt(uv + vec2(0.0, t.y)) + lumaAt(uv - vec2(0.0, t.y));
    float diag4 = lumaAt(uv + t) + lumaAt(uv - t)
      + lumaAt(uv + vec2(t.x, -t.y)) + lumaAt(uv + vec2(-t.x, t.y));
    float blurS = (4.0 * srcL + 2.0 * cross4 + diag4) / 16.0;
    float ring = 0.0;
    for (int k = 0; k < 8; k++) {
      float a = float(k) * 0.785398;
      vec2 d = vec2(cos(a), sin(a)) * t;
      ring += lumaAt(uv + d * 2.5) + lumaAt(uv + d * 5.0);
    }
    float blurM = (blurS + ring) / 17.0;
    detailS = (srcL - blurS) * (1.0 - lensMix);
    detailM = (blurS - blurM) * (1.0 - lensMix);
  }
  float detailL = 0.0; // local contrast (clarity)
  vec4 blurred = vec4(0.0);
  if (u_blurOn) {
    blurred = texture(u_blur, uv);
    detailL = (srcL - dot(blurred.rgb, LUMA)) * (1.0 - lensMix);
  }

  // ---- Dehaze (dark-channel prior on the blurred image) ----
  if (u_blurOn && u_dehaze != 0.0) {
    vec3 A = u_airlight;
    if (u_dehaze > 0.0) {
      float aMax = max(A.r, max(A.g, A.b));
      float tr = max(1.0 - u_dehaze * 0.9 * blurred.a / aMax, 0.15);
      c = (c - A) / tr + A;
    } else {
      float tr = 1.0 + u_dehaze * 0.6;
      c = c * tr + A * (1.0 - tr);
    }
  }

  // ---- White balance + exposure in (approximately) linear light ----
  vec3 lin = pow(max(c, 0.0), vec3(2.2));
  float rGain = 1.0 + 0.35 * temperature;
  float bGain = 1.0 - 0.35 * temperature;
  float gGain = 1.0 - 0.25 * tint;
  lin *= vec3(rGain, gGain, bGain);
  lin *= exp2(exposure * ${f(EXPOSURE_STOPS)});
  c = pow(max(lin, 0.0), vec3(1.0 / 2.2));

  // ---- Tone: highlights / shadows (luma-masked, hue preserving) ----
  float luma = dot(c, LUMA);
  float hMask = smoothstep(0.35, 1.0, luma);
  float sMask = 1.0 - smoothstep(0.0, 0.6, luma);
  float newLuma = luma;
  newLuma += highlights * 0.45 * hMask * (1.0 - newLuma);
  newLuma += shadows * 0.45 * sMask * (1.0 - newLuma);
  if (luma > 0.0001) c *= newLuma / luma;

  // ---- Black and white points ----
  float bp = u_blackPoint * 0.25;
  float wp = 1.0 - u_whites * 0.25;
  c = (c - bp) / max(wp - bp, 0.05);

  // ---- Brightness (midtone gamma) ----
  c = pow(max(c, 0.0), vec3(1.0 / (1.0 + u_brightness * 0.75)));

  // ---- Contrast (soft, pivot 0.5) ----
  c = (c - 0.5) * (1.0 + contrast * 0.9) + 0.5;

  // ---- Sharpening, texture, clarity ----
  // Detail was measured on the source; scale it by how much the tone stages
  // brightened this pixel so it stays in proportion.
  if (u_detailOn || u_blurOn) {
    float curL = dot(c, LUMA);
    float gain = clamp(curL / max(srcL, 0.02), 0.0, 4.0);
    float mid = clamp(1.0 - pow(2.0 * clamp(curL, 0.0, 1.0) - 1.0, 2.0), 0.0, 1.0);
    c += gain * (u_sharpen * 2.5 * detailS + textureAmt * 1.6 * detailM + clarity * 1.3 * mid * detailL);
  }

  // ---- Tone curve ----
  if (u_curveOn) {
    vec3 x = clamp(c, 0.0, 1.0) * (255.0 / 256.0) + 0.5 / 256.0;
    c = vec3(
      texture(u_curve, vec2(x.r, 0.5)).r,
      texture(u_curve, vec2(x.g, 0.5)).g,
      texture(u_curve, vec2(x.b, 0.5)).b
    );
  }

  // ---- 3-way color balance ----
  float l2 = clamp(dot(c, LUMA), 0.0, 1.0);
  float cs = 1.0 - smoothstep(0.0, 0.5, l2);
  float ch = smoothstep(0.5, 1.0, l2);
  float cm = clamp(1.0 - cs - ch, 0.0, 1.0);
  c += u_cbShadows * cs + u_cbMidtones * cm + u_cbHighlights * ch;
  c *= 1.0 + 0.3 * (u_cbLum.x * cs + u_cbLum.y * cm + u_cbLum.z * ch);

  // ---- Color mixer: hue / saturation / luminance per hue band ----
  if (u_mixerOn) {
    vec3 hsv = rgb2hsv(clamp(c, 0.0, 1.0));
    float deg = hsv.x * 360.0;
    int i = 7;
    for (int k = 0; k < 7; k++) {
      if (deg < BANDS[k + 1]) {
        i = k;
        break;
      }
    }
    int j = i == 7 ? 0 : i + 1;
    float hi = i == 7 ? 360.0 : BANDS[i + 1];
    float t = smoothstep(0.0, 1.0, (deg - BANDS[i]) / (hi - BANDS[i]));
    float dh = mix(u_mixHue[i], u_mixHue[j], t);
    float ds = mix(u_mixSat[i], u_mixSat[j], t);
    float dl = mix(u_mixLum[i], u_mixLum[j], t);
    float s0 = hsv.y;
    hsv.x = fract(hsv.x + dh * (30.0 / 360.0) + 1.0);
    hsv.y = clamp(hsv.y * (1.0 + ds), 0.0, 1.0);
    c = hsv2rgb(hsv) * (1.0 + dl * 0.5 * s0);
  }

  // ---- Hue / Saturation / Vibrance ----
  c = hueRotate(c, u_hue * 3.14159265);
  float l3 = dot(c, LUMA);
  c = mix(vec3(l3), c, 1.0 + saturation);
  float satAmount = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
  c = mix(vec3(l3), c, 1.0 + u_vibrance * (1.0 - clamp(satAmount * 1.5, 0.0, 1.0)));

  // ---- Vignette (in cropped-frame space so zoomed previews match exports) ----
  vec2 fuv = (uv - u_frameOffset) / max(u_frameScale, vec2(0.0001));
  float d = distance(fuv, vec2(0.5)) * 1.41421356;
  c *= 1.0 - u_vignette * 0.85 * smoothstep(0.35, 1.1, d);

  // ---- Grain: two octaves of value noise, fixed to the image ----
  if (u_grain > 0.0) {
    vec2 p = uv * vec2(u_aspect, 1.0) * (1400.0 / (1.0 + u_grainSize * 3.0));
    float n = valueNoise(p) * 0.65 + valueNoise(p * 2.13 + 17.0) * 0.35 - 0.5;
    float l4 = clamp(dot(c, LUMA), 0.0, 1.0);
    c += u_grain * 0.25 * n * (0.35 + 2.6 * l4 * (1.0 - l4));
  }

  c = clamp(c, 0.0, 1.0);
  if (u_showMask >= 0) c = mix(c, vec3(1.0, 0.22, 0.28), 0.55 * shown);

  // Mask edge: where coverage crosses one half, as black-and-white dashes
  // with a soft dark halo. Distances are in screen pixels, so the line stays
  // thin at any zoom.
  if (u_outlineMask >= 0) {
    float dist = abs(outlined - 0.5) / max(fwidth(outlined), 1e-4);
    float core = 1.0 - smoothstep(0.6, 1.4, dist);
    float halo = 1.0 - smoothstep(1.4, 3.0, dist);
    float dash = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) / 14.0));
    c = mix(c, vec3(0.0), halo * 0.55);
    c = mix(c, vec3(dash), core);
  }

  // Alpha passes through untouched so background-removed cutouts stay cut out.
  outColor = vec4(c, src.a);
}
`;

// Downsample to the low-res detail buffer: a 4×4 grid of bilinear taps over
// each output texel's footprint; alpha carries the dark channel (min of rgb).
export const DOWNSAMPLE_SHADER = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_image;
uniform vec2 u_step;
void main() {
  vec3 acc = vec3(0.0);
  float dark = 0.0;
  for (int y = 0; y < 4; y++) {
    for (int x = 0; x < 4; x++) {
      vec3 s = texture(u_image, v_uv + (vec2(float(x), float(y)) - 1.5) * u_step).rgb;
      acc += s;
      dark += min(s.r, min(s.g, s.b));
    }
  }
  outColor = vec4(acc / 16.0, dark / 16.0);
}
`;

// One direction of a separable Gaussian (sigma ≈ 8 texels of the low-res buffer).
export const BLUR_SHADER = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_src;
uniform vec2 u_dir;
void main() {
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int k = -12; k <= 12; k++) {
    float o = float(k) * 1.5;
    float w = exp(-o * o / 128.0);
    acc += w * texture(u_src, v_uv + u_dir * o);
    wsum += w;
  }
  outColor = acc / wsum;
}
`;
