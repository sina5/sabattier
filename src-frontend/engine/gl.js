import { BLUR_SHADER, DOWNSAMPLE_SHADER, FRAGMENT_SHADER, VERTEX_SHADER } from './shader.js';
import { LUT_SIZE, bakeCurveLut, isIdentityCurveSet } from './curve.js';
import { MASK_ADJUSTMENTS, MAX_MASKS, effectiveSettings, isFaceMask, wheelToOffset } from './types.js';
import { MAX_FACES } from './faceRegions.js';

const HIST_W = 256;
const HIST_H = 144;
/** Long edge of the blurred buffer behind clarity and dehaze. */
const BLUR_LONG_EDGE = 512;

const FLOAT_UNIFORMS = [
  'u_temperature', 'u_tint', 'u_exposure', 'u_highlights', 'u_shadows', 'u_whites',
  'u_brightness', 'u_contrast', 'u_blackPoint', 'u_hue', 'u_saturation',
  'u_vibrance', 'u_vignette', 'u_texture', 'u_clarity', 'u_dehaze', 'u_sharpen',
  'u_grain', 'u_grainSize',
];

const VEC3_UNIFORMS = ['u_cbShadows', 'u_cbMidtones', 'u_cbHighlights', 'u_cbLum'];

const MASK_TYPES = { subject: 0, linear: 1, radial: 2, skin: 3, eyes: 4, lips: 5, teeth: 6 };

export const FULL_VIEW = { sx: 1, sy: 1, ox: 0, oy: 0 };

/** Effective uniform values with disabled sections neutralized. */
export function uniformsFor(s) {
  const wb = s.wbEnabled;
  const ba = s.basicEnabled;
  const hs = s.hslEnabled;
  const cb = s.cbEnabled;
  const fx = s.fxEnabled;
  const dt = s.detailEnabled;
  const zero = [0, 0, 0];
  return {
    u_temperature: wb ? s.temperature : 0,
    u_tint: wb ? s.tint : 0,
    u_exposure: ba ? s.exposure : 0,
    u_highlights: ba ? s.highlights : 0,
    u_shadows: ba ? s.shadows : 0,
    u_whites: ba ? s.whites : 0,
    u_brightness: ba ? s.brightness : 0,
    u_contrast: ba ? s.contrast : 0,
    u_blackPoint: ba ? s.blackPoint : 0,
    u_hue: hs ? s.hue : 0,
    u_saturation: hs ? s.saturation : 0,
    u_vibrance: hs ? s.vibrance : 0,
    u_vignette: fx ? Math.max(0, s.vignette) : 0,
    u_texture: fx ? s.texture : 0,
    u_clarity: fx ? s.clarity : 0,
    u_dehaze: fx ? s.dehaze : 0,
    u_grain: fx ? Math.max(0, s.grain) : 0,
    u_grainSize: s.grainSize,
    u_sharpen: dt ? Math.max(0, s.sharpen) : 0,
    u_cbShadows: cb ? wheelToOffset(s.cbShadows) : zero,
    u_cbMidtones: cb ? wheelToOffset(s.cbMidtones) : zero,
    u_cbHighlights: cb ? wheelToOffset(s.cbHighlights) : zero,
    u_cbLum: cb ? [s.cbShadows.lum, s.cbMidtones.lum, s.cbHighlights.lum] : zero,
  };
}

/**
 * A face mask's faces as bits (face n → bit n − 1); every face when it has no
 * selection. Exact in a float up to MAX_FACES (24) bits.
 */
function faceBits(m) {
  if (!Array.isArray(m.faces)) return (1 << MAX_FACES) - 1;
  return m.faces.reduce((bits, i) => (i >= 0 && i < MAX_FACES ? bits | (1 << i) : bits), 0);
}

/** The masks that render: section on, and model-based masks only once their data exists. */
function activeMasks(s, hasMatte, hasFace) {
  if (!s.masksEnabled || !s.masks?.length) return [];
  return s.masks
    .slice(0, MAX_MASKS)
    .filter((m) => (m.type === 'subject' ? hasMatte : isFaceMask(m.type) ? hasFace : true));
}

export class GLEngine {
  canvas;
  gl;
  prog;
  tex = null;
  loc = new Map();
  histFbo;
  histPixels = new Uint8Array(HIST_W * HIST_H * 4);
  imgWidth = 0;
  imgHeight = 0;
  /** Float render targets (EXT_color_buffer_float); 8-bit otherwise. */
  floatTargets = false;
  curveTex;
  curveRef = null;
  curveKey = '';
  curveIsIdentity = true;
  matteTex;
  matte = null;
  depthTex;
  depth = null;
  faceTex;
  faceIdTex;
  face = null;
  blurTex = null;
  blurTmp = null;
  blurFbo = null;
  blurReady = false;
  airlight = [1, 1, 1];
  dummyTex;

  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      preserveDrawingBuffer: true,
      premultipliedAlpha: false,
      antialias: false,
    });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    this.floatTargets = !!gl.getExtension('EXT_color_buffer_float');

    this.prog = this.buildProgram(FRAGMENT_SHADER);
    this.downProg = this.buildProgram(DOWNSAMPLE_SHADER);
    this.blurProg = this.buildProgram(BLUR_SHADER);

    // Fullscreen triangle-strip quad
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // Small offscreen target for histogram computation
    const histTex = this.makeTexture(gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, HIST_W, HIST_H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.histFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.histFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, histTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.curveTex = this.makeTexture(gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, LUT_SIZE, 1, 0, gl.RGBA, gl.FLOAT, new Float32Array(LUT_SIZE * 4));
    this.matteTex = this.makeTexture(gl.LINEAR);
    this.depthTex = this.makeTexture(gl.LINEAR);
    this.faceTex = this.makeTexture(gl.LINEAR);
    // Ids must never blend between faces: nearest sampling.
    this.faceIdTex = this.makeTexture(gl.NEAREST);
    this.dummyTex = this.makeTexture(gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  }

  buildProgram(fragment) {
    const { gl } = this;
    const compile = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error('Shader compile error: ' + gl.getShaderInfoLog(sh));
      }
      return sh;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fragment));
    gl.bindAttribLocation(prog, 0, 'a_pos');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('Program link error: ' + gl.getProgramInfoLog(prog));
    }
    return prog;
  }

  /** Cached uniform location in `prog` (the main program by default). */
  u(name, prog = this.prog) {
    const key = prog === this.prog ? name : `${name}@${prog === this.downProg ? 'd' : 'b'}`;
    if (!this.loc.has(key)) this.loc.set(key, this.gl.getUniformLocation(prog, name));
    return this.loc.get(key);
  }

  /** A new clamped texture, bound to TEXTURE_2D on the active unit. */
  makeTexture(filter) {
    const { gl } = this;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  setImage(src) {
    const { gl } = this;
    if (this.tex) gl.deleteTexture(this.tex);
    gl.activeTexture(gl.TEXTURE0);
    this.tex = this.makeTexture(gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    this.imgWidth = src.width;
    this.imgHeight = src.height;
    this.blurReady = false;
  }

  /** The subject matte (`size`² bytes, full-image coordinates), or null. */
  setMatte(matte, size) {
    if (matte === this.matte) return;
    this.matte = matte;
    if (!matte) return;
    const { gl } = this;
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.matteTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, size, size, 0, gl.RED, gl.UNSIGNED_BYTE, matte);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.activeTexture(gl.TEXTURE0);
  }

  /** The depth map ({ data, width, height, autoFocus }), or null. */
  setDepth(depth) {
    if (depth === this.depth) return;
    this.depth = depth;
    if (!depth) return;
    const { gl } = this;
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.depthTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, depth.width, depth.height, 0, gl.RED, gl.UNSIGNED_BYTE, depth.data);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.activeTexture(gl.TEXTURE0);
  }

  /** Face regions ({ data: RGBA bytes, ids: face-id bytes, width, height }), or null. */
  setFace(face) {
    if (face === this.face) return;
    this.face = face;
    if (!face) return;
    const { gl } = this;
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, this.faceTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, face.width, face.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, face.data);
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, this.faceIdTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, face.width, face.height, 0, gl.RED, gl.UNSIGNED_BYTE, face.ids);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.activeTexture(gl.TEXTURE0);
  }

  get hasImage() {
    return this.tex !== null;
  }

  /** Bake and upload the curve LUT when the curve (null = off) changed. */
  uploadCurve(curve) {
    if (curve === this.curveRef) return;
    this.curveRef = curve;
    const key = curve ? JSON.stringify(curve) : '';
    if (key === this.curveKey) return;
    this.curveKey = key;
    this.curveIsIdentity = !curve || isIdentityCurveSet(curve);
    if (this.curveIsIdentity) return; // the shader skips the lookup
    const { gl } = this;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.curveTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, LUT_SIZE, 1, 0, gl.RGBA, gl.FLOAT, bakeCurveLut(curve));
    gl.activeTexture(gl.TEXTURE0);
  }

  /**
   * Build the low-res blurred copy of the image used by clarity and dehaze,
   * and estimate the haze color from it. Once per image, only when needed.
   */
  ensureBlur() {
    if (this.blurReady || !this.tex) return;
    const { gl } = this;
    const scale = Math.min(1, BLUR_LONG_EDGE / Math.max(this.imgWidth, this.imgHeight));
    const w = Math.max(1, Math.round(this.imgWidth * scale));
    const h = Math.max(1, Math.round(this.imgHeight * scale));
    const internal = this.floatTargets ? gl.RGBA16F : gl.RGBA8;
    const type = this.floatTargets ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;

    this.blurFbo ??= gl.createFramebuffer();
    for (const k of ['blurTex', 'blurTmp']) {
      if (this[k]) gl.deleteTexture(this[k]);
      gl.activeTexture(gl.TEXTURE2);
      this[k] = this.makeTexture(gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, gl.RGBA, type, null);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.blurFbo);
    gl.viewport(0, 0, w, h);
    const target = (tex) =>
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

    // Downsample the image into blurTex (source on unit 0).
    target(this.blurTex);
    gl.useProgram(this.downProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(this.u('u_image', this.downProg), 0);
    gl.uniform2f(this.u('u_step', this.downProg), 1 / (w * 4), 1 / (h * 4));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.airlight = this.estimateAirlight(w, h);

    // Horizontal then vertical blur: blurTex → blurTmp → blurTex.
    gl.useProgram(this.blurProg);
    gl.uniform1i(this.u('u_src', this.blurProg), 2);
    gl.activeTexture(gl.TEXTURE2);
    target(this.blurTmp);
    gl.bindTexture(gl.TEXTURE_2D, this.blurTex);
    gl.uniform2f(this.u('u_dir', this.blurProg), 1 / w, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    target(this.blurTex);
    gl.bindTexture(gl.TEXTURE_2D, this.blurTmp);
    gl.uniform2f(this.u('u_dir', this.blurProg), 0, 1 / h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(gl.TEXTURE0);
    this.blurReady = true;
  }

  /** Haze color: the mean of the pixels with the brightest dark channel (top 0.2%). */
  estimateAirlight(w, h) {
    const { gl } = this;
    const n = w * h;
    let px;
    let scale = 1;
    if (this.floatTargets) {
      px = new Float32Array(n * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, px);
    } else {
      px = new Uint8Array(n * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      scale = 1 / 255;
    }
    const bins = new Uint32Array(256);
    for (let i = 3; i < px.length; i += 4) bins[Math.min(255, Math.round(px[i] * scale * 255))]++;
    let cut = 255;
    for (let acc = 0; cut > 0 && (acc += bins[cut]) < n * 0.002; cut--);
    const sum = [0, 0, 0];
    let count = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (Math.round(px[i + 3] * scale * 255) < cut) continue;
      sum[0] += px[i];
      sum[1] += px[i + 1];
      sum[2] += px[i + 2];
      count++;
    }
    return sum.map((v) => Math.min(1, Math.max(0.5, count ? (v * scale) / count : 1)));
  }

  applyUniforms(settings, view, frame, { showMask = null, outlineMask = null } = {}) {
    const { gl } = this;
    const u = uniformsFor(settings);
    const masks = activeMasks(settings, !!this.matte, !!this.face);
    const needsBlur =
      u.u_clarity !== 0 || u.u_dehaze !== 0 || masks.some((m) => m.adj.clarity !== 0);
    if (needsBlur) this.ensureBlur();
    this.uploadCurve(settings.curveEnabled ? settings.curve : null);

    gl.useProgram(this.prog);
    for (const name of FLOAT_UNIFORMS) gl.uniform1f(this.u(name), u[name]);
    for (const name of VEC3_UNIFORMS) gl.uniform3fv(this.u(name), u[name]);
    gl.uniform3fv(this.u('u_airlight'), this.airlight);

    const mixer = settings.mixer;
    const mixerOn =
      settings.mixerEnabled && [mixer.hue, mixer.sat, mixer.lum].some((a) => a.some((v) => v !== 0));
    gl.uniform1i(this.u('u_mixerOn'), mixerOn ? 1 : 0);
    if (mixerOn) {
      gl.uniform1fv(this.u('u_mixHue'), mixer.hue);
      gl.uniform1fv(this.u('u_mixSat'), mixer.sat);
      gl.uniform1fv(this.u('u_mixLum'), mixer.lum);
    }
    gl.uniform1i(this.u('u_curveOn'), settings.curveEnabled && !this.curveIsIdentity ? 1 : 0);
    const maskTexture = masks.some((m) => (m.adj.texture ?? 0) !== 0);
    gl.uniform1i(this.u('u_detailOn'), u.u_sharpen > 0 || u.u_texture !== 0 || maskTexture ? 1 : 0);
    gl.uniform1i(this.u('u_blurOn'), needsBlur ? 1 : 0);
    // Lens blur: up to 2.5% of the image width at full amount.
    const lensOn = settings.lensEnabled && settings.lensBlur > 0 && !!this.depth;
    gl.uniform1i(this.u('u_lensOn'), lensOn ? 1 : 0);
    if (lensOn) {
      const focus = settings.lensFocus ?? this.depth.autoFocus;
      gl.uniform3f(this.u('u_lens'), settings.lensBlur * 0.025, focus, settings.lensRange);
    }

    gl.uniform1i(this.u('u_maskCount'), masks.length);
    if (masks.length) {
      const geo = new Float32Array(MAX_MASKS * 4);
      const opt = new Float32Array(MAX_MASKS * 4);
      const adjA = new Float32Array(MAX_MASKS * 4);
      const adjB = new Float32Array(MAX_MASKS * 4);
      const adjC = new Float32Array(MAX_MASKS * 4);
      masks.forEach((m, i) => {
        const g = m.geo ?? {};
        geo.set(m.type === 'linear' ? [g.x0, g.y0, g.x1, g.y1] : m.type === 'radial' ? [g.cx, g.cy, g.rx, g.ry] : [0, 0, 0, 0], i * 4);
        opt.set([MASK_TYPES[m.type], m.invert ? 1 : 0, g.feather ?? 0, faceBits(m)], i * 4);
        const a = MASK_ADJUSTMENTS.map((x) => m.adj[x.key] ?? 0);
        adjA.set(a.slice(0, 4), i * 4);
        adjB.set(a.slice(4, 8), i * 4);
        adjC.set([...a.slice(8, 12), 0, 0, 0, 0].slice(0, 4), i * 4);
      });
      gl.uniform4fv(this.u('u_maskGeo'), geo);
      gl.uniform4fv(this.u('u_maskOpt'), opt);
      gl.uniform4fv(this.u('u_maskAdjA'), adjA);
      gl.uniform4fv(this.u('u_maskAdjB'), adjB);
      gl.uniform4fv(this.u('u_maskAdjC'), adjC);
    }
    gl.uniform1i(this.u('u_showMask'), masks.findIndex((m) => m.id === showMask));
    gl.uniform1i(this.u('u_outlineMask'), masks.findIndex((m) => m.id === outlineMask));

    gl.uniform1i(this.u('u_image'), 0);
    gl.uniform1i(this.u('u_curve'), 1);
    gl.uniform1i(this.u('u_blur'), 2);
    gl.uniform1i(this.u('u_matte'), 3);
    gl.uniform1i(this.u('u_depth'), 4);
    gl.uniform1i(this.u('u_face'), 5);
    gl.uniform1i(this.u('u_faceId'), 6);
    gl.uniform1i(this.u('u_flipY'), 1);
    gl.uniform2f(this.u('u_uvScale'), view.sx, view.sy);
    gl.uniform2f(this.u('u_uvOffset'), view.ox, view.oy);
    gl.uniform2f(this.u('u_frameScale'), frame.sx, frame.sy);
    gl.uniform2f(this.u('u_frameOffset'), frame.ox, frame.oy);
    gl.uniform2f(this.u('u_texel'), 1 / this.imgWidth, 1 / this.imgHeight);
    gl.uniform1f(this.u('u_aspect'), this.imgWidth / this.imgHeight);

    const bindUnit = (unit, tex) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
    };
    bindUnit(1, this.curveTex);
    bindUnit(2, needsBlur ? this.blurTex : this.dummyTex);
    bindUnit(3, this.matte ? this.matteTex : this.dummyTex);
    bindUnit(4, this.depth ? this.depthTex : this.dummyTex);
    bindUnit(5, this.face ? this.faceTex : this.dummyTex);
    bindUnit(6, this.face ? this.faceIdTex : this.dummyTex);
    bindUnit(0, this.tex);
  }

  /**
   * Render to the canvas at its current width/height.
   * `view` is the visible window; `frame` is the cropped frame the framing-aware
   * effects (vignette) are measured against — normally the crop rectangle.
   * `overlays` names masks to draw over the photo (preview only):
   * { showMask: id tinted red, outlineMask: id whose edge is outlined }.
   */
  render(settings, view = FULL_VIEW, frame = view, overlays = {}) {
    const { gl } = this;
    if (!this.tex) return;
    this.applyUniforms(effectiveSettings(settings), view, frame, overlays);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** RGBA8 pixels of the last render, top row first. */
  readPixels() {
    const { gl } = this;
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    // GL rows run bottom-up; flip in place.
    const row = w * 4;
    const tmp = new Uint8Array(row);
    for (let y = 0; y < h >> 1; y++) {
      const a = y * row;
      const b = (h - 1 - y) * row;
      tmp.set(px.subarray(a, a + row));
      px.copyWithin(a, b, b + row);
      px.set(tmp, b);
    }
    return { width: w, height: h, data: px };
  }

  /** Render into the small histogram FBO and bin the result. */
  computeHistogram(settings, frame = FULL_VIEW) {
    const { gl } = this;
    if (!this.tex) return null;
    this.applyUniforms(effectiveSettings(settings), frame, frame); // the whole cropped frame, never the zoom window
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.histFbo);
    gl.viewport(0, 0, HIST_W, HIST_H);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.readPixels(0, 0, HIST_W, HIST_H, gl.RGBA, gl.UNSIGNED_BYTE, this.histPixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const r = new Uint32Array(256);
    const g = new Uint32Array(256);
    const b = new Uint32Array(256);
    const l = new Uint32Array(256);
    const px = this.histPixels;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] < 128) continue; // ignore transparent pixels (bg-removed cutouts)
      const pr = px[i];
      const pg = px[i + 1];
      const pb = px[i + 2];
      r[pr]++;
      g[pg]++;
      b[pb]++;
      l[Math.round(0.2126 * pr + 0.7152 * pg + 0.0722 * pb)]++;
    }
    let maxCount = 1;
    // Ignore the extreme bins when scaling so clipped pixels don't flatten the curve
    for (let i = 1; i < 255; i++) {
      maxCount = Math.max(maxCount, r[i], g[i], b[i], l[i]);
    }
    return { r, g, b, l, maxCount };
  }

  dispose() {
    const { gl } = this;
    if (this.tex) gl.deleteTexture(this.tex);
    this.tex = null;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
