/**
 * A point on a color-balance wheel: x/y in [-1, 1], lum in [-1, 1].
 * @typedef {{ x: number, y: number, lum: number }} WheelValue
 */

/**
 * Crop rectangle, normalized to the source image: x/y/w/h in [0, 1].
 * @typedef {{ x: number, y: number, w: number, h: number }} CropRect
 */

/**
 * All adjustment values. Sliders are normalized to [-1, 1], 0 = neutral.
 * `bgRemoved` only selects the cached cutout bitmap (kept outside the store);
 * `crop` is null for the full frame. See defaultSettings() for every field.
 * @typedef {ReturnType<typeof defaultSettings>} Settings
 */

import { IDENTITY_CURVE } from './curve.js';

/** Stops of exposure at the slider's ends (value ±1). */
export const EXPOSURE_STOPS = 5;

export const FULL_CROP = { x: 0, y: 0, w: 1, h: 1 };

export function isFullCrop(c) {
  return !c || (c.x <= 0 && c.y <= 0 && c.w >= 1 && c.h >= 1);
}

export const NEUTRAL_WHEEL = { x: 0, y: 0, lum: 0 };

/** The color mixer's hue bands, in order; centers are in degrees. */
export const MIXER_BANDS = [
  { id: 'red', label: 'Red', center: 0 },
  { id: 'orange', label: 'Orange', center: 30 },
  { id: 'yellow', label: 'Yellow', center: 60 },
  { id: 'green', label: 'Green', center: 120 },
  { id: 'aqua', label: 'Aqua', center: 180 },
  { id: 'blue', label: 'Blue', center: 240 },
  { id: 'purple', label: 'Purple', center: 270 },
  { id: 'magenta', label: 'Magenta', center: 300 },
];

/**
 * What a mask can change. Each value adds to the global slider of the same
 * name inside the mask, so a mask moves the same sliders, just in one area.
 */
export const MASK_ADJUSTMENTS = [
  { key: 'exposure', label: 'Exposure' },
  { key: 'contrast', label: 'Contrast' },
  { key: 'highlights', label: 'Highlights' },
  { key: 'shadows', label: 'Shadows' },
  { key: 'temperature', label: 'Temperature', gradient: 'temperature' },
  { key: 'tint', label: 'Tint', gradient: 'tint' },
  { key: 'saturation', label: 'Saturation' },
  { key: 'clarity', label: 'Clarity' },
  { key: 'texture', label: 'Texture' },
];

/** Masks drawn from the face analysis, and the channel of the face texture each reads. */
export const FACE_MASKS = { skin: 'Face skin', eyes: 'Eyes', lips: 'Lips', teeth: 'Teeth' };
export const isFaceMask = (type) => type in FACE_MASKS;

/** Most masks one photo can carry (the shader's uniform array size). */
export const MAX_MASKS = 8;

const neutralCurve = () => ({
  rgb: structuredClone(IDENTITY_CURVE),
  r: structuredClone(IDENTITY_CURVE),
  g: structuredClone(IDENTITY_CURVE),
  b: structuredClone(IDENTITY_CURVE),
});

const zeros = () => MIXER_BANDS.map(() => 0);

/**
 * A new mask. Geometry is in full-image coordinates ([0, 1] on each axis), so
 * it stays put when the crop changes. `subject` uses the segmentation matte;
 * `background` is the same matte inverted.
 */
export function newMask(type, id) {
  const adj = Object.fromEntries(MASK_ADJUSTMENTS.map((a) => [a.key, 0]));
  const base = { id, type, invert: false, adj };
  // Face masks: `faces` is null for every face, or the 0-based indices (left to right) picked.
  if (isFaceMask(type)) return { ...base, faces: null };
  if (type === 'background') return { ...base, type: 'subject', invert: true };
  if (type === 'linear') return { ...base, geo: { x0: 0.5, y0: 0.15, x1: 0.5, y1: 0.55 } };
  if (type === 'radial') return { ...base, geo: { cx: 0.5, cy: 0.5, rx: 0.3, ry: 0.3, feather: 0.5 } };
  return base;
}

/**
 * A healing brush stroke: `points` in full-image uv, `r` the brush radius as
 * a fraction of the image width. The area it covers is filled in by the
 * inpainting model.
 */
export function newHealStroke(id, points, r) {
  return { id, points, r };
}

export function maskLabel(m) {
  if (m.type === 'subject') return m.invert ? 'Background' : 'Subject';
  if (isFaceMask(m.type)) {
    const which = Array.isArray(m.faces)
      ? m.faces.length
        ? ` · face${m.faces.length > 1 ? 's' : ''} ${[...m.faces].sort((a, b) => a - b).map((i) => i + 1).join(', ')}`
        : ' · no faces'
      : '';
    return `${FACE_MASKS[m.type]}${which}${m.invert ? ' (inverted)' : ''}`;
  }
  const name = m.type === 'linear' ? 'Linear gradient' : 'Radial gradient';
  return m.invert ? `${name} (inverted)` : name;
}

export function defaultSettings() {
  return {
    wbEnabled: true,
    temperature: 0,
    tint: 0,

    basicEnabled: true,
    exposure: 0,
    highlights: 0,
    shadows: 0,
    brightness: 0,
    contrast: 0,
    whites: 0,
    blackPoint: 0,

    curveEnabled: true,
    /** Tone curve points per channel; see engine/curve.js. */
    curve: neutralCurve(),

    hslEnabled: true,
    hue: 0,
    saturation: 0,
    vibrance: 0,

    mixerEnabled: true,
    /** Per-band shifts, indexed like MIXER_BANDS, each in [-1, 1]. */
    mixer: { hue: zeros(), sat: zeros(), lum: zeros() },

    cbEnabled: false,
    cbShadows: { ...NEUTRAL_WHEEL },
    cbMidtones: { ...NEUTRAL_WHEEL },
    cbHighlights: { ...NEUTRAL_WHEEL },

    fxEnabled: false,
    texture: 0,
    clarity: 0,
    dehaze: 0,
    vignette: 0,
    grain: 0,
    grainSize: 0,

    detailEnabled: true,
    sharpen: 0,

    lensEnabled: true,
    /** Lens blur: amount 0..1; focus depth 0 (far) .. 1 (near), null = auto; range 0..1. */
    lensBlur: 0,
    lensFocus: null,
    lensRange: 0.15,

    /** Healing strokes; see newHealStroke(). Per photo, like the crop. */
    heal: [],

    masksEnabled: true,
    /** Local adjustments; see newMask(). Per photo, like the crop. */
    masks: [],

    bgRemoved: false,
    crop: null,

    /** Ids of edits (see EDITS) switched off in the edit list; their values are kept. */
    muted: [],
  };
}

/**
 * Every edit a photo can carry, as listed in the panel's edit list. `keys` are
 * the settings it owns (reset when the edit is deleted); `section` is the
 * on/off switch of the panel section it belongs to, if any.
 */
export const EDITS = [
  { id: 'exposure', label: 'Exposure', keys: ['exposure'], section: 'basicEnabled' },
  { id: 'highlights', label: 'Highlights', keys: ['highlights'], section: 'basicEnabled' },
  { id: 'shadows', label: 'Shadows', keys: ['shadows'], section: 'basicEnabled' },
  { id: 'brightness', label: 'Brightness', keys: ['brightness'], section: 'basicEnabled' },
  { id: 'contrast', label: 'Contrast', keys: ['contrast'], section: 'basicEnabled' },
  { id: 'whites', label: 'Whites', keys: ['whites'], section: 'basicEnabled' },
  { id: 'blackPoint', label: 'Black point', keys: ['blackPoint'], section: 'basicEnabled' },
  { id: 'curve', label: 'Tone curve', keys: ['curve'], section: 'curveEnabled' },
  { id: 'temperature', label: 'Temperature', keys: ['temperature'], section: 'wbEnabled' },
  { id: 'tint', label: 'Tint', keys: ['tint'], section: 'wbEnabled' },
  { id: 'saturation', label: 'Saturation', keys: ['saturation'], section: 'hslEnabled' },
  { id: 'vibrance', label: 'Vibrance', keys: ['vibrance'], section: 'hslEnabled' },
  { id: 'hue', label: 'Hue', keys: ['hue'], section: 'hslEnabled' },
  { id: 'mixer', label: 'Color mixer', keys: ['mixer'], section: 'mixerEnabled' },
  { id: 'cbShadows', label: 'Color balance: shadows', keys: ['cbShadows'], section: 'cbEnabled' },
  { id: 'cbMidtones', label: 'Color balance: midtones', keys: ['cbMidtones'], section: 'cbEnabled' },
  { id: 'cbHighlights', label: 'Color balance: highlights', keys: ['cbHighlights'], section: 'cbEnabled' },
  { id: 'texture', label: 'Texture', keys: ['texture'], section: 'fxEnabled' },
  { id: 'clarity', label: 'Clarity', keys: ['clarity'], section: 'fxEnabled' },
  { id: 'dehaze', label: 'Dehaze', keys: ['dehaze'], section: 'fxEnabled' },
  { id: 'vignette', label: 'Vignette', keys: ['vignette'], section: 'fxEnabled' },
  { id: 'grain', label: 'Grain', keys: ['grain', 'grainSize'], section: 'fxEnabled' },
  { id: 'sharpen', label: 'Sharpening', keys: ['sharpen'], section: 'detailEnabled' },
  { id: 'masks', label: 'Masks', keys: ['masks'], section: 'masksEnabled' },
  { id: 'lens', label: 'Lens blur', keys: ['lensBlur', 'lensFocus', 'lensRange'], section: 'lensEnabled' },
  { id: 'crop', label: 'Crop', keys: ['crop'] },
  { id: 'heal', label: 'Healing', keys: ['heal'] },
  { id: 'bgRemoved', label: 'Background removed', keys: ['bgRemoved'] },
];

const DEFAULTS = defaultSettings();
const differs = (a, b) => JSON.stringify(a) !== JSON.stringify(b);

/**
 * The edits a photo carries (any owned setting away from its default), each
 * with `on`: false when it is switched off in the list or its section is off.
 */
export function listEdits(s) {
  const muted = s.muted ?? [];
  return EDITS.filter((e) => e.keys.some((k) => differs(s[k], DEFAULTS[k]))).map((e) => ({
    edit: e,
    on: !muted.includes(e.id) && (!e.section || s[e.section]),
  }));
}

/** Settings as rendered: switched-off edits fall back to their defaults. */
export function effectiveSettings(s) {
  if (!s.muted?.length) return s;
  const out = { ...s };
  for (const e of EDITS) {
    if (!s.muted.includes(e.id)) continue;
    for (const k of e.keys) out[k] = structuredClone(DEFAULTS[k]);
  }
  return out;
}

/** Edits whose readout is a 0..1 amount rather than a signed shift. */
export const UNSIGNED_EDITS = new Set(['vignette', 'grain', 'sharpen', 'lens']);

const DEFAULTS_JSON = JSON.stringify(DEFAULTS);

export function isNeutral(s) {
  return JSON.stringify(s) === DEFAULTS_JSON;
}

/** RGB offset (each in roughly [-0.35, 0.35]) for a color wheel position. */
export function wheelToOffset(w) {
  const r = Math.min(1, Math.hypot(w.x, w.y));
  if (r === 0) return [0, 0, 0];
  const angle = Math.atan2(w.y, w.x); // 0 = +x axis
  // Map angle to a hue in degrees; wheel drawn with red at the top (90°).
  const hue = ((90 - (angle * 180) / Math.PI) % 360 + 360) % 360;
  const [cr, cg, cb] = hslToRgb(hue / 360, 1, 0.5);
  const strength = 0.35 * r;
  return [(cr - 0.5) * strength, (cg - 0.5) * strength, (cb - 0.5) * strength];
}

export function hslToRgb(h, s, l) {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue2rgb = (t0) => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [hue2rgb(h + 1 / 3), hue2rgb(h), hue2rgb(h - 1 / 3)];
}
