import { GLEngine } from './gl.js';
import { effectiveSettings, isFullCrop } from './types.js';

// One reusable offscreen engine for full-resolution exports.
let exportEngine = null;

const MAX_DIM = 8192; // stay under common GPU texture limits

/** Output formats. `alpha`: keeps transparency; `rust`: encoded by the backend. */
export const FORMATS = {
  jpeg: { label: 'JPEG', ext: 'jpg', mime: 'image/jpeg', alpha: false, lossy: true },
  png: { label: 'PNG', ext: 'png', mime: 'image/png', alpha: true, lossy: false },
  webp: { label: 'WebP', ext: 'webp', mime: 'image/webp', alpha: true, lossy: true },
  tiff: { label: 'TIFF', ext: 'tif', mime: 'image/tiff', alpha: true, lossy: false, rust: true },
};

/** The format a photo is actually saved in: cutouts need alpha, so JPEG becomes PNG. */
export function formatFor(format, settings) {
  const f = FORMATS[format] ? format : 'jpeg';
  return effectiveSettings(settings).bgRemoved && !FORMATS[f].alpha ? 'png' : f;
}

/**
 * Render a photo at export size. The whole (possibly downscaled) source goes
 * to the GPU and the crop is a view window over it, exactly as in the
 * preview, so masks, clarity and grain land in the same places.
 * `maxDim` limits the longest edge of the *cropped* frame.
 * Returns the export engine's canvas, or a 2D canvas when a watermark was drawn.
 */
export async function renderFrame(bitmap, settings, { maxDim = null, matte = null, matteSize = 0, depth = null, face = null, watermark = null, logo = null } = {}) {
  const crop = effectiveSettings(settings).crop;
  const rect = isFullCrop(crop) ? { x: 0, y: 0, w: 1, h: 1 } : crop;
  const W = bitmap.width;
  const H = bitmap.height;
  const cw = rect.w * W;
  const ch = rect.h * H;
  const scale = Math.min(1, (maxDim ?? MAX_DIM) / Math.max(cw, ch), MAX_DIM / Math.max(W, H));

  let source = bitmap;
  if (scale < 1) {
    source = await createImageBitmap(bitmap, {
      resizeWidth: Math.max(1, Math.round(W * scale)),
      resizeHeight: Math.max(1, Math.round(H * scale)),
      resizeQuality: 'high',
    });
  }
  const sw = source.width;
  const sh = source.height;
  // Snap the window to whole source pixels so the render is 1:1, not resampled.
  const px = Math.min(sw - 1, Math.round(rect.x * sw));
  const py = Math.min(sh - 1, Math.round(rect.y * sh));
  const pw = Math.max(1, Math.min(sw - px, Math.round(rect.w * sw)));
  const ph = Math.max(1, Math.min(sh - py, Math.round(rect.h * sh)));
  const view = { sx: pw / sw, sy: ph / sh, ox: px / sw, oy: py / sh };

  exportEngine ??= new GLEngine(new OffscreenCanvas(pw, ph));
  const canvas = exportEngine.canvas;
  canvas.width = pw;
  canvas.height = ph;
  exportEngine.setImage(source);
  exportEngine.setMatte(matte, matteSize);
  exportEngine.setDepth(depth);
  exportEngine.setFace(face);
  exportEngine.render(settings, view, view);
  if (source !== bitmap) source.close();

  if (!watermark?.enabled) return canvas;
  const out = new OffscreenCanvas(pw, ph);
  const ctx = out.getContext('2d');
  ctx.drawImage(canvas, 0, 0);
  drawWatermark(ctx, pw, ph, watermark, logo);
  return out;
}

/**
 * Watermark: text or a logo image, placed in a corner or the center.
 * `size` (0..1) scales with the photo's short edge, so a batch of different
 * sizes gets the same-looking mark.
 */
export function drawWatermark(ctx, w, h, wm, logo) {
  const short = Math.min(w, h);
  const margin = short * 0.035;
  let bw;
  let bh;
  let draw;
  if (wm.kind === 'image') {
    if (!logo) return;
    const long = short * (0.06 + wm.size * 0.44);
    const k = long / Math.max(logo.width, logo.height);
    bw = logo.width * k;
    bh = logo.height * k;
    draw = (x, y) => ctx.drawImage(logo, x, y, bw, bh);
  } else {
    const text = (wm.text ?? '').trim();
    if (!text) return;
    const px = Math.max(8, short * (0.015 + wm.size * 0.085));
    ctx.font = `600 ${px}px Barlow, "Helvetica Neue", Arial, sans-serif`;
    ctx.textBaseline = 'top';
    bw = ctx.measureText(text).width;
    bh = px;
    const dark = wm.color === 'black';
    draw = (x, y) => {
      ctx.fillStyle = dark ? '#000' : '#fff';
      ctx.shadowColor = dark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.45)';
      ctx.shadowBlur = px * 0.12;
      ctx.fillText(text, x, y);
    };
  }
  const pos = wm.position ?? 'br';
  const x = pos === 'c' ? (w - bw) / 2 : pos.endsWith('l') ? margin : w - bw - margin;
  const y = pos === 'c' ? (h - bh) / 2 : pos.startsWith('t') ? margin : h - bh - margin;
  ctx.save();
  ctx.globalAlpha = Math.min(1, Math.max(0, wm.opacity ?? 0.7));
  draw(x, y);
  ctx.restore();
}

/** Longest edge an AI-upscaled photo may have (matches the backend). */
export const UPSCALE_MAX = 8192;

/** RGBA8 pixels of a rendered frame, top row first. */
export function pixelsOf(canvas) {
  if (exportEngine && canvas === exportEngine.canvas) return exportEngine.readPixels();
  const ctx = canvas.getContext('2d');
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/**
 * Encode a rendered frame. Returns `{ blob }` for formats the webview encodes,
 * or `{ pixels }` (RGBA8) for the backend to encode.
 */
export async function encodeFrame(canvas, format, quality) {
  const f = FORMATS[format];
  if (!f.rust) {
    const blob = await canvas.convertToBlob({ type: f.mime, quality });
    // Not every webview can encode WebP; those return PNG instead. The
    // backend's lossless WebP encoder covers them.
    if (blob.type === f.mime) return { blob };
  }
  return { pixels: pixelsOf(canvas) };
}

/** Render and encode with the webview's own encoder (JPEG or PNG). */
export async function renderToBlob(bitmap, settings, quality, maxDim = null, type = 'image/jpeg', extra = {}) {
  const canvas = await renderFrame(bitmap, settings, { maxDim, ...extra });
  return canvas.convertToBlob({ type, quality });
}
