import { create } from './createStore.js';
import { baseName, decodeImage, decodeThumbnail, isRawPath } from '../decode/decode.js';
import { BG_MODEL_SIZE, DEPTH_LONG_EDGE, INPAINT_SIZE, backend } from '../backend.js';
import { autoEnhance, computeStats } from '../engine/autoEnhance.js';
import { FORMATS, UPSCALE_MAX, encodeFrame, formatFor, pixelsOf, renderFrame } from '../engine/export.js';
import { EDITS, MAX_MASKS, defaultSettings, effectiveSettings, isFaceMask, newHealStroke, newMask } from '../engine/types.js';
import { buildFaceTexture } from '../engine/faceRegions.js';

const UNDO_LIMIT = 100;
const PRESETS_DIR_KEY = 'sabattier.presetsDir';
const CONFIRM_DELETE_KEY = 'sabattier.confirmEditDelete';
const MULTICORE_KEY = 'sabattier.multicore';
const EXPORT_PREFS_KEY = 'sabattier.exportPrefs';

/**
 * Output format and watermark, remembered between sessions. Upscale is not:
 * it is slow, so it starts Off each time the Save dialog opens.
 */
function defaultExportPrefs() {
  return {
    format: 'jpeg',
    /** AI upscale factor when saving: 0 (off), 2 or 4. */
    upscale: 0,
    watermark: {
      enabled: false,
      kind: 'text',
      text: '',
      imagePath: '',
      position: 'br',
      size: 0.3,
      opacity: 0.7,
      color: 'white',
    },
  };
}

function loadExportPrefs() {
  const d = defaultExportPrefs();
  try {
    const saved = JSON.parse(localStorage.getItem(EXPORT_PREFS_KEY) ?? 'null');
    if (!saved) return d;
    return {
      format: FORMATS[saved.format] ? saved.format : d.format,
      upscale: 0,
      watermark: { ...d.watermark, ...saved.watermark },
    };
  } catch {
    return d;
  }
}

/**
 * Filmstrip filters: which photos a flag/rating filter lets through.
 * Ratings run 0–5; a flag is 'pick', 'reject' or null.
 */
export const FILTERS = [
  { id: 'all', label: 'All photos', test: () => true },
  { id: 'picks', label: 'Picks', test: (i) => i.flag === 'pick' },
  { id: 'no-rejects', label: 'Hide rejects', test: (i) => i.flag !== 'reject' },
  { id: 'rejects', label: 'Rejects', test: (i) => i.flag === 'reject' },
  ...[1, 2, 3, 4, 5].map((n) => ({
    id: `r${n}`,
    label: `${'★'.repeat(n)}${n < 5 ? ' or more' : ''}`,
    test: (i) => i.rating >= n,
  })),
];

export function passesFilter(img, filterId) {
  return (FILTERS.find((f) => f.id === filterId) ?? FILTERS[0]).test(img);
}

/** The photos the current filter shows, in filmstrip order. */
export function visibleImages(st) {
  return st.filter === 'all' ? st.images : st.images.filter((i) => passesFilter(i, st.filter));
}

/** Whether heavy work uses every CPU core (the default) — the Settings switch. */
function loadMulticore() {
  try {
    return localStorage.getItem(MULTICORE_KEY) !== 'false';
  } catch {
    return true;
  }
}

/** Whether removing an edit asks first (the default) — the Settings switch. */
function loadConfirmEditDelete() {
  try {
    return localStorage.getItem(CONFIRM_DELETE_KEY) !== 'false';
  } catch {
    return true;
  }
}

/** The presets folder chosen in Settings, or null for the default one. */
function loadPresetsDir() {
  try {
    return localStorage.getItem(PRESETS_DIR_KEY) || null;
  } catch {
    return null;
  }
}
/** Mutations with the same tag inside this window collapse into one undo step. */
const UNDO_COALESCE_MS = 600;
let undoStack = [];
let redoStack = [];
let lastRecordTag = '';
let lastRecordTime = 0;

// Bitmaps are kept outside the store (not serializable, large).
const thumbBitmaps = new Map();
const fullBitmaps = new Map(); // small LRU
// The pixels each photo is rendered from when it is healed or cut out:
// { key, bmp } per photo, rebuilt when the strokes or the cutout change.
const sourceBitmaps = new Map();
// Healed patches by stroke id: { x, y, side, bmp }. Kept for the session so
// undo/redo of a stroke never re-runs the model.
const healPatches = new Map();
// Subject mattes (BG_MODEL_SIZE² bytes each), shared by background removal
// and subject/background masks, so the model runs at most once per photo.
const mattes = new Map();
const FULL_CACHE_MAX = 3;

/**
 * Subject matte: the model sees a BG_MODEL_SIZE² downscale (its fixed input
 * size) and returns a matte at that size, in full-image coordinates.
 */
async function computeMatte(bmp) {
  const n = BG_MODEL_SIZE;
  const small = new OffscreenCanvas(n, n).getContext('2d', { willReadFrequently: true });
  small.imageSmoothingQuality = 'high';
  small.drawImage(bmp, 0, 0, n, n);
  const rgba = small.getImageData(0, 0, n, n).data;
  return backend.removeBackground(new Uint8Array(rgba.buffer));
}

// Depth maps for lens blur: { data, width, height, autoFocus } per photo.
const depths = new Map();
const depthJobs = new Map(); // id -> in-flight promise

/**
 * Relative depth of the photo, from a downscale whose sides are multiples of
 * 14 (the model's patch size). `autoFocus` is where lens blur focuses until
 * the user picks a point: the 90th-percentile depth, usually the subject.
 */
async function computeDepth(bmp) {
  const k = DEPTH_LONG_EDGE / Math.max(bmp.width, bmp.height);
  const snap = (v) => Math.max(14, Math.round((v * k) / 14) * 14);
  const width = Math.min(DEPTH_LONG_EDGE, snap(bmp.width));
  const height = Math.min(DEPTH_LONG_EDGE, snap(bmp.height));
  const ctx = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, width, height);
  const rgba = ctx.getImageData(0, 0, width, height).data;
  const data = await backend.estimateDepth(new Uint8Array(rgba.buffer), width, height);
  const sorted = Uint8Array.from(data).sort();
  return { data, width, height, autoFocus: sorted[Math.floor(sorted.length * 0.9)] / 255 };
}

// Face regions for portrait masks: { data, width, height, faces } per photo,
// or false when the photo was analyzed and has no face.
const faceTextures = new Map();
const faceJobs = new Map();
/** Long edge photos are analyzed at: enough for landmarks on small faces. */
const FACE_ANALYSIS_EDGE = 1536;

async function computeFaces(bmp) {
  const k = Math.min(1, FACE_ANALYSIS_EDGE / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * k));
  const h = Math.max(1, Math.round(bmp.height * k));
  const ctx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const analysis = await backend.analyzeFaces(new Uint8Array(rgba.buffer), w, h);
  return (await buildFaceTexture(analysis)) ?? false;
}

/**
 * Masks moving to another photo: a face selection names faces of the photo it
 * was made on, so there it becomes "every face".
 */
function masksForOtherPhoto(masks) {
  return (masks ?? []).map((m) => (isFaceMask(m.type) && m.faces != null ? { ...m, faces: null } : m));
}

/** The photo's face regions: the texture, false if it has no face, null if not analyzed yet. */
export function getFaces(id) {
  return faceTextures.has(id) ? faceTextures.get(id) : null;
}

/** The photo's depth map, if computed this session. */
export function getDepth(id) {
  return depths.get(id) ?? null;
}

/** The photo's subject matte, if it has been computed this session. */
export function getMatte(id) {
  return mattes.get(id) ?? null;
}

/** Background cutout: the matte stretched over the canvas as its alpha channel. */
async function applyCutout(ctx, matte) {
  const n = BG_MODEL_SIZE;
  const alpha = new ImageData(n, n);
  for (let i = 0; i < matte.length; i++) alpha.data[i * 4 + 3] = matte[i];
  const mask = await createImageBitmap(alpha);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(mask, 0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.globalCompositeOperation = 'source-over';
  mask.close();
}

/** Box-blur a one-byte-per-pixel n×n mask in place (radius r, two passes ≈ Gaussian). */
function featherMask(m, n, r) {
  let src = Float32Array.from(m);
  let dst = new Float32Array(n * n);
  const norm = 1 / (2 * r + 1);
  const at = (i) => Math.min(n - 1, Math.max(0, i));
  for (let pass = 0; pass < 4; pass++) {
    const horizontal = pass % 2 === 0;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        let acc = 0;
        for (let k = -r; k <= r; k++) acc += horizontal ? src[y * n + at(x + k)] : src[at(y + k) * n + x];
        dst[y * n + x] = acc * norm;
      }
    }
    [src, dst] = [dst, src];
  }
  for (let i = 0; i < m.length; i++) m[i] = Math.round(src[i]);
}

/**
 * Heal one stroke on `canvas` (the photo with earlier strokes applied): cut a
 * square around it with some context, scale it to the model's size, fill the
 * brushed area, and return the result as a patch whose alpha is the feathered
 * brush shape, ready to draw back over the photo.
 */
async function healStroke(canvas, stroke) {
  const n = INPAINT_SIZE;
  const W = canvas.width;
  const H = canvas.height;
  const r = stroke.r * W;
  const xs = stroke.points.map((p) => p[0] * W);
  const ys = stroke.points.map((p) => p[1] * H);
  const bx0 = Math.min(...xs) - r;
  const by0 = Math.min(...ys) - r;
  const bw = Math.max(...xs) + r - bx0;
  const bh = Math.max(...ys) + r - by0;
  // Context around the stroke helps the model match texture; about 2.5× the stroke.
  const side = Math.round(Math.min(Math.min(W, H), Math.max(96, Math.max(bw, bh) * 2.5)));
  const x = Math.round(Math.min(W - side, Math.max(0, bx0 + bw / 2 - side / 2)));
  const y = Math.round(Math.min(H - side, Math.max(0, by0 + bh / 2 - side / 2)));
  const k = n / side;

  const crop = new OffscreenCanvas(n, n).getContext('2d', { willReadFrequently: true });
  crop.imageSmoothingQuality = 'high';
  crop.drawImage(canvas, x, y, side, side, 0, 0, n, n);
  const rgba = crop.getImageData(0, 0, n, n);

  // The brush shape, a little wider than drawn so edges of the blemish go too.
  const m = new OffscreenCanvas(n, n).getContext('2d', { willReadFrequently: true });
  m.fillStyle = '#000';
  m.fillRect(0, 0, n, n);
  m.strokeStyle = m.fillStyle = '#fff';
  m.lineCap = m.lineJoin = 'round';
  m.lineWidth = 2 * (r * 1.15 + 2) * k;
  const px = stroke.points.map(([u, v]) => [(u * W - x) * k, (v * H - y) * k]);
  m.beginPath();
  m.moveTo(...px[0]);
  for (const p of px.slice(1)) m.lineTo(...p);
  if (px.length === 1) m.lineTo(px[0][0] + 0.01, px[0][1]);
  m.stroke();
  const mdata = m.getImageData(0, 0, n, n).data;
  const mask = new Uint8Array(n * n);
  for (let i = 0; i < mask.length; i++) mask[i] = mdata[i * 4];

  const filled = await backend.inpaint(new Uint8Array(rgba.data.buffer), mask);
  // Blend back only inside the (feathered) brush shape.
  featherMask(mask, n, Math.max(1, Math.round(n / 170)));
  for (let i = 0; i < mask.length; i++) filled[i * 4 + 3] = mask[i];
  const bmp = await createImageBitmap(new ImageData(new Uint8ClampedArray(filled.buffer), n, n));
  return { x, y, side, bmp };
}

/** The original photo with these strokes healed in, computing any patch not cached yet. */
async function healedCanvas(orig, strokes) {
  const canvas = new OffscreenCanvas(orig.width, orig.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(orig, 0, 0);
  ctx.imageSmoothingQuality = 'high';
  for (const stroke of strokes) {
    let patch = healPatches.get(stroke.id);
    if (!patch) {
      patch = await healStroke(canvas, stroke);
      healPatches.set(stroke.id, patch);
    }
    ctx.drawImage(patch.bmp, patch.x, patch.y, patch.side, patch.side);
  }
  return canvas;
}

/** The pixels a photo is rendered from: the original, healed, then cut out. */
export async function getFullBitmap(item) {
  const s = effectiveSettings(item.settings);
  const matte = s.bgRemoved ? mattes.get(item.id) : null;
  const strokes = s.heal ?? [];
  if (!strokes.length && !matte) return getOriginalBitmap(item);
  const key = `${strokes.map((h) => h.id).join(',')}|${matte ? 1 : 0}`;
  const cached = sourceBitmaps.get(item.id);
  if (cached?.key === key) return cached.bmp;
  const orig = await getOriginalBitmap(item);
  const canvas = await healedCanvas(orig, strokes);
  if (matte) await applyCutout(canvas.getContext('2d'), matte);
  const bmp = canvas.transferToImageBitmap();
  // Another call may have finished first with the same result; use that one.
  const now = sourceBitmaps.get(item.id);
  if (now?.key === key) {
    bmp.close();
    return now.bmp;
  }
  // A replaced version is not closed here: an export or preview load may
  // still be drawing it. Dropping the reference lets it be collected.
  sourceBitmaps.set(item.id, { key, bmp });
  return bmp;
}

/** Identifies the current source pixels of a photo, for caches (the preview's texture). */
export function sourceKeyOf(item) {
  const s = effectiveSettings(item.settings);
  return `${(s.heal ?? []).map((h) => h.id).join(',')}|${s.bgRemoved ? 1 : 0}`;
}

/** The decoded source image, ignoring any background-removal cutout. */
export async function getOriginalBitmap(item) {
  const cached = fullBitmaps.get(item.id);
  if (cached) {
    // refresh LRU position
    fullBitmaps.delete(item.id);
    fullBitmaps.set(item.id, cached);
    return cached;
  }
  const bmp = await decodeImage(item.path);
  fullBitmaps.set(item.id, bmp);
  while (fullBitmaps.size > FULL_CACHE_MAX) {
    const [oldId, oldBmp] = fullBitmaps.entries().next().value;
    fullBitmaps.delete(oldId);
    oldBmp.close();
  }
  return bmp;
}

export function getThumbBitmap(id) {
  return thumbBitmaps.get(id);
}

let nextId = 1;
let maskSeq = 0;
/** Where a Shift-click range starts: the last photo clicked without Shift. */
let rangeAnchorId = null;
let thumbQueueRunning = false;

async function bitmapToUrl(bmp) {
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  canvas.getContext('2d').drawImage(bmp, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  return URL.createObjectURL(blob);
}

export const store = create((set, get) => {
  async function runThumbQueue() {
    if (thumbQueueRunning) return;
    thumbQueueRunning = true;
    try {
      for (;;) {
        const item = get().images.find((i) => i.status === 'pending');
        if (!item) break;
        try {
          const thumb = await decodeThumbnail(item.path);
          thumbBitmaps.set(item.id, thumb);
          const url = await bitmapToUrl(thumb);
          set((st) => ({
            images: st.images.map((i) =>
              i.id === item.id ? { ...i, status: 'ready', thumbUrl: url } : i,
            ),
          }));
        } catch (err) {
          set((st) => ({
            images: st.images.map((i) =>
              i.id === item.id
                ? { ...i, status: 'error', error: String(err) }
                : i,
            ),
          }));
        }
      }
    } finally {
      thumbQueueRunning = false;
    }
  }

  /** Run `task` with a busy message; while the model downloads (first run), show its progress. */
  async function withBusy(text, task) {
    set({ busy: text });
    const stopProgress = await backend.onModelDownload((received, total, name) =>
      set({
        busy:
          total && received >= total
            ? text
            : `Downloading ${name ?? 'model'} (one time)… ${
                total ? `${Math.round((100 * received) / total)}%` : `${Math.round(received / 1e6)} MB`
              }`,
      }),
    );
    try {
      return await task();
    } finally {
      stopProgress();
      set({ busy: null });
    }
  }

  /** The photo's subject matte, running the model once if needed. */
  async function ensureMatte(item, bmp) {
    let matte = mattes.get(item.id);
    if (!matte) {
      matte = await computeMatte(bmp ?? (await getOriginalBitmap(item)));
      mattes.set(item.id, matte);
      set((st) => ({ matteVersion: st.matteVersion + 1 }));
    }
    return matte;
  }

  /** Merge ratings and flags saved in earlier sessions into the photos at `paths`. */
  async function loadCulling(paths) {
    let saved;
    try {
      saved = await backend.catalogGet(paths);
    } catch (err) {
      console.error('Loading ratings failed:', err);
      return;
    }
    if (!saved.length) return;
    const byPath = new Map(saved.map((e) => [e.path, e]));
    set((st) => ({
      images: st.images.map((i) => {
        const e = byPath.get(i.path);
        return e ? { ...i, rating: e.rating, flag: e.flag ?? null } : i;
      }),
    }));
  }

  /** Write the ratings/flags of the photos with these ids to the catalog. */
  function saveCulling(ids) {
    const entries = get()
      .images.filter((i) => ids.has(i.id))
      .map((i) => ({ path: i.path, rating: i.rating, flag: i.flag }));
    backend.catalogSet(entries).catch((err) => {
      console.error('Saving ratings failed:', err);
      get().notify("Couldn't save ratings; they will last for this session only.");
    });
  }

  /** The photo's depth map, running the depth model once if needed (one run per photo at a time). */
  async function ensureDepth(item) {
    const have = depths.get(item.id);
    if (have) return have;
    if (!depthJobs.has(item.id)) {
      const job = (async () => {
        const depth = await computeDepth(await getOriginalBitmap(item));
        depths.set(item.id, depth);
        set((st) => ({ matteVersion: st.matteVersion + 1 }));
        return depth;
      })().finally(() => depthJobs.delete(item.id));
      depthJobs.set(item.id, job);
    }
    return depthJobs.get(item.id);
  }

  /** The photo's face regions, analyzing it once if needed. */
  async function ensureFaces(item) {
    if (faceTextures.has(item.id)) return faceTextures.get(item.id);
    if (!faceJobs.has(item.id)) {
      const job = (async () => {
        const faces = await computeFaces(await getOriginalBitmap(item));
        faceTextures.set(item.id, faces);
        set((st) => ({ matteVersion: st.matteVersion + 1 }));
        return faces;
      })().finally(() => faceJobs.delete(item.id));
      faceJobs.set(item.id, job);
    }
    return faceJobs.get(item.id);
  }

  /**
   * A photo rendered with all its edits at full size (or within maxDim), as
   * export and HDR merge need it. Fetches the matte, depth and faces the edits
   * use; `extra` passes the watermark options through to renderFrame.
   */
  async function renderEdited(item, { maxDim = null, ...extra } = {}) {
    const bmp = await getFullBitmap(item);
    const s = effectiveSettings(item.settings);
    // A subject mask copied to this photo may not have its matte yet.
    const wantsMatte = s.masksEnabled && s.masks.some((m) => m.type === 'subject');
    const matte = wantsMatte ? await ensureMatte(item) : getMatte(item.id);
    const depth = s.lensEnabled && s.lensBlur > 0 ? await ensureDepth(item) : null;
    const wantsFaces = s.masksEnabled && s.masks.some((m) => isFaceMask(m.type));
    const faces = wantsFaces ? (await ensureFaces(item)) || null : null;
    return renderFrame(bmp, item.settings, { maxDim, matte, matteSize: BG_MODEL_SIZE, depth, face: faces, ...extra });
  }

  /**
   * After a rating, flag or filter change: if the photo in the preview is
   * now filtered out, move to the nearest photo that is still shown.
   */
  function keepSelectionVisible() {
    const st = get();
    const current = st.images.find((i) => i.id === st.selectedId);
    if (!current || passesFilter(current, st.filter)) return;
    const index = st.images.indexOf(current);
    const after = st.images.slice(index + 1).find((i) => passesFilter(i, st.filter));
    const before = st.images.slice(0, index).reverse().find((i) => passesFilter(i, st.filter));
    const next = after ?? before;
    if (next) get().select(next.id);
  }

  function snapshot() {
    return {
      settingsById: Object.fromEntries(
        get().images.map((i) => [i.id, structuredClone(i.settings)]),
      ),
    };
  }

  /**
   * Push the *current* state onto the undo stack before a mutation.
   * Repeated mutations with the same tag in quick succession (slider drags)
   * collapse into the single entry captured at the start of the gesture.
   */
  function recordHistory(tag) {
    const now = Date.now();
    if (tag === lastRecordTag && now - lastRecordTime < UNDO_COALESCE_MS) {
      lastRecordTime = now;
      return;
    }
    undoStack.push(snapshot());
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    redoStack = [];
    lastRecordTag = tag;
    lastRecordTime = now;
    set({ canUndo: true, canRedo: false });
  }

  function applyEntry(entry) {
    set((st) => ({
      images: st.images.map((i) =>
        entry.settingsById[i.id]
          ? { ...i, settings: structuredClone(entry.settingsById[i.id]) }
          : i,
      ),
    }));
  }

  /** Settings write that intentionally bypasses history (callers record once). */
  function putSettings(id, settings) {
    set((st) => ({
      images: st.images.map((i) => (i.id === id ? { ...i, settings } : i)),
    }));
  }

  /** Apply a preset to the given photos (null = all), as one undo step. */
  function applyPresetTo(name, ids, historyTag) {
    const preset = get().presets.find((p) => p.name === name);
    if (!preset) return;
    recordHistory(historyTag);
    set((st) => ({
      images: st.images.map((i) =>
        ids && !ids.has(i.id)
          ? i
          : {
              ...i,
              settings: {
                ...defaultSettings(),
                ...structuredClone(preset.settings),
                masks: masksForOtherPhoto(structuredClone(preset.settings.masks)),
                // per-photo edits survive preset application
                bgRemoved: i.settings.bgRemoved,
                crop: i.settings.crop,
                heal: i.settings.heal,
              },
            },
      ),
    }));
    void prepareModels();
  }

  /**
   * Some edits need a per-photo model result: subject masks a matte, lens
   * blur a depth map. Edits travel with copies and looks, so after any change
   * run the models, one photo at a time, for every photo that needs a result
   * it doesn't have yet. Until then that edit simply doesn't render there.
   */
  let preparing = false;
  const needsMatte = (i) => !mattes.has(i.id) && i.settings.masks?.some((m) => m.type === 'subject');
  const needsDepth = (i) => !depths.has(i.id) && i.settings.lensBlur > 0;
  const needsFaces = (i) => !faceTextures.has(i.id) && i.settings.masks?.some((m) => isFaceMask(m.type));
  async function prepareModels() {
    if (preparing) return;
    preparing = true;
    try {
      for (;;) {
        const todo = get().images.filter((i) => i.status !== 'error' && (needsMatte(i) || needsDepth(i) || needsFaces(i)));
        if (!todo.length) break;
        const item = todo[0];
        const n = todo.length > 1 ? ` (${todo.length} photos to go)` : '';
        try {
          if (needsMatte(item)) await withBusy(`Finding the subject…${n}`, () => ensureMatte(item));
          if (needsDepth(item)) await withBusy(`Measuring depth…${n}`, () => ensureDepth(item));
          if (needsFaces(item)) await withBusy(`Finding faces…${n}`, () => ensureFaces(item));
        } catch (err) {
          get().notify(`Couldn't prepare ${item.name}: ${err}`);
          break;
        }
      }
    } finally {
      preparing = false;
    }
  }

  async function statsFor(item) {
    let thumb = thumbBitmaps.get(item.id);
    if (!thumb) {
      thumb = await decodeThumbnail(item.path);
      thumbBitmaps.set(item.id, thumb);
    }
    return computeStats(thumb);
  }

  return {
    images: [],
    selectedId: null,
    selectedIds: [],
    histogram: null,
    quality: 0.95,
    busy: null,
    exporting: null,
    /** Set by Cancel on the saving card; exportAll stops at the next step. */
    exportCancelled: false,
    exportDialogOpen: false,
    settingsOpen: false,
    presets: [],
    presetsDir: loadPresetsDir(),
    confirmEditDelete: loadConfirmEditDelete(),
    multicore: loadMulticore(),
    /** The edit waiting for confirmation in the remove dialog, or null. */
    pendingEditDelete: null,
    canUndo: false,
    canRedo: false,
    /** Bumped to ask the preview to enter crop mode. */
    cropRequest: 0,
    /** Bumped to ask the preview to enter heal (brush) mode. */
    healRequest: 0,
    /** Bumped to ask the preview to pick the lens-blur focus point. */
    focusPickRequest: 0,
    /** Short confirmation shown over the preview after a batch action: { id, text }. */
    toast: null,
    /** Filmstrip filter id (see FILTERS). */
    filter: 'all',
    /** The mask being edited in the panel, and whether it is tinted on the preview. */
    activeMaskId: null,
    maskOverlay: false,
    /** Outline the active mask on the photo (subject edge, gradient handles). */
    maskOutline: true,
    /** Bumped when a subject matte is computed, so the preview picks it up. */
    matteVersion: 0,
    /** Output format and watermark for saving. */
    exportPrefs: loadExportPrefs(),

    /** Re-read the saved export prefs (after restoring a backup). */
    reloadExportPrefs() {
      set({ exportPrefs: loadExportPrefs() });
    },

    /** Replace all presets (restoring a backup) and save them to the presets folder. */
    async setPresets(presets) {
      set({ presets });
      await backend.savePresets(presets, get().presetsDir);
    },

    /** Re-read ratings and flags of the open photos from the catalog. */
    async reloadCulling() {
      const paths = get().images.map((i) => i.path);
      set((st) => ({ images: st.images.map((i) => ({ ...i, rating: 0, flag: null })) }));
      await loadCulling(paths);
    },

    setExportPrefs(patch) {
      const cur = get().exportPrefs;
      const next = { ...cur, ...patch, watermark: { ...cur.watermark, ...patch.watermark } };
      set({ exportPrefs: next });
      try {
        const { upscale: _notSaved, ...remembered } = next;
        localStorage.setItem(EXPORT_PREFS_KEY, JSON.stringify(remembered));
      } catch {
        // the choice still applies for this session
      }
    },

    requestCrop() {
      set((st) => ({ cropRequest: st.cropRequest + 1 }));
    },

    notify(text) {
      const id = Date.now();
      set({ toast: { id, text } });
      setTimeout(() => {
        if (get().toast?.id === id) set({ toast: null });
      }, 6000);
    },

    dismissToast() {
      set({ toast: null });
    },

    async importFiles() {
      const paths = await backend.openImages();
      await get().importPaths(paths);
    },

    async importFolder() {
      const dir = await backend.openFolder('Import folder');
      if (!dir) return;
      const paths = await backend.listImages(dir);
      await get().importPaths(paths);
    },

    async importPaths(paths) {
      if (!paths.length) return;
      const existing = new Set(get().images.map((i) => i.path));
      const items = paths
        .filter((p) => !existing.has(p))
        .map((p) => ({
          id: String(nextId++),
          path: p,
          name: baseName(p),
          isRaw: isRawPath(p),
          status: 'pending',
          thumbUrl: null,
          settings: defaultSettings(),
          rating: 0,
          flag: null,
        }));
      if (!items.length) return;
      set((st) => ({
        images: [...st.images, ...items],
        selectedId: st.selectedId ?? items[0].id,
        selectedIds: st.selectedId ? st.selectedIds : [items[0].id],
      }));
      void runThumbQueue();
      await loadCulling(items.map((i) => i.path));
    },

    select(id, mode = 'single') {
      const { images, selectedIds, selectedId } = get();
      if (id !== selectedId) set({ activeMaskId: null });
      if (mode === 'range') {
        // Without a clicked anchor (e.g. the auto-selected first import, or an
        // anchor photo that was removed), range from the photo in the preview.
        const indexOf = (anchorId) => images.findIndex((i) => i.id === anchorId);
        let anchor = indexOf(rangeAnchorId);
        if (anchor < 0) anchor = indexOf(selectedId ?? id);
        const target = indexOf(id);
        if (anchor < 0 || target < 0) return;
        const [a, b] = anchor < target ? [anchor, target] : [target, anchor];
        set({ selectedId: id, selectedIds: images.slice(a, b + 1).map((i) => i.id) });
        return;
      }
      rangeAnchorId = id;
      if (mode === 'toggle' && selectedIds.includes(id)) {
        if (selectedIds.length === 1) return; // keep at least one photo selected
        const rest = selectedIds.filter((s) => s !== id);
        set((st) => ({
          selectedIds: rest,
          selectedId: st.selectedId === id ? rest[rest.length - 1] : st.selectedId,
        }));
        return;
      }
      set({ selectedId: id, selectedIds: mode === 'toggle' ? [...selectedIds, id] : [id] });
    },

    /** Select every photo the filter shows. */
    selectAll() {
      const images = visibleImages(get());
      if (!images.length) return;
      const { selectedId } = get();
      const keep = images.some((i) => i.id === selectedId);
      set({ selectedId: keep ? selectedId : images[0].id, selectedIds: images.map((i) => i.id) });
    },

    /** Back to just the photo in the preview. */
    deselectAll() {
      const { selectedId } = get();
      set({ selectedIds: selectedId ? [selectedId] : [] });
    },

    removeImage(id) {
      thumbBitmaps.get(id)?.close();
      thumbBitmaps.delete(id);
      fullBitmaps.get(id)?.close();
      fullBitmaps.delete(id);
      sourceBitmaps.get(id)?.bmp.close();
      sourceBitmaps.delete(id);
      for (const stroke of get().images.find((i) => i.id === id)?.settings.heal ?? []) {
        healPatches.get(stroke.id)?.bmp.close();
        healPatches.delete(stroke.id);
      }
      mattes.delete(id);
      depths.delete(id);
      faceTextures.delete(id);
      set((st) => {
        const images = st.images.filter((i) => i.id !== id);
        const selectedId = st.selectedId === id ? (images[0]?.id ?? null) : st.selectedId;
        const kept = st.selectedIds.filter((s) => s !== id);
        return {
          images,
          selectedId,
          selectedIds: kept.length ? kept : selectedId ? [selectedId] : [],
        };
      });
    },

    updateSettings(patch) {
      const { selectedId } = get();
      if (!selectedId) return;
      recordHistory(`set:${selectedId}:${Object.keys(patch).sort().join(',')}`);
      set((st) => ({
        images: st.images.map((i) => {
          if (i.id !== selectedId) return i;
          const settings = { ...i.settings, ...patch };
          // Adjusting a switched-off edit switches it back on, so the change shows.
          if (!('muted' in patch) && settings.muted?.length) {
            const touched = (id) => EDITS.find((e) => e.id === id)?.keys.some((k) => k in patch);
            settings.muted = settings.muted.filter((id) => !touched(id));
          }
          return { ...i, settings };
        }),
      }));
    },

    /** Switch one edit of the selected photo on or off; its value is kept. */
    setEditOn(editId, on) {
      const item = get().images.find((i) => i.id === get().selectedId);
      const edit = EDITS.find((e) => e.id === editId);
      if (!item || !edit) return;
      const muted = (item.settings.muted ?? []).filter((id) => id !== editId);
      const patch = { muted: on ? muted : [...muted, editId] };
      // Switching on an edit whose whole section is off turns the section on.
      if (on && edit.section && !item.settings[edit.section]) patch[edit.section] = true;
      get().updateSettings(patch);
    },

    setMulticore(on) {
      set({ multicore: on });
      try {
        localStorage.setItem(MULTICORE_KEY, String(on));
      } catch {
        // the choice still applies for this session
      }
      void backend.setMulticore(on).catch((err) => console.error('set_multicore:', err));
    },

    setConfirmEditDelete(on) {
      set({ confirmEditDelete: on });
      try {
        localStorage.setItem(CONFIRM_DELETE_KEY, String(on));
      } catch {
        // the choice still applies for this session
      }
    },

    /** The red button: remove right away, or ask first when the setting is on. */
    requestEditDelete(editId) {
      if (get().confirmEditDelete) set({ pendingEditDelete: editId });
      else get().deleteEdit(editId);
    },

    cancelEditDelete() {
      set({ pendingEditDelete: null });
    },

    /** Remove one edit from the selected photo: its settings go back to their defaults. */
    deleteEdit(editId) {
      const item = get().images.find((i) => i.id === get().selectedId);
      const edit = EDITS.find((e) => e.id === editId);
      if (!item || !edit) return;
      const d = defaultSettings();
      const patch = { muted: (item.settings.muted ?? []).filter((id) => id !== editId) };
      for (const k of edit.keys) patch[k] = d[k];
      get().updateSettings(patch);
      set({ pendingEditDelete: null });
    },

    setSettings(id, settings) {
      recordHistory(`replace:${id}`);
      putSettings(id, settings);
    },

    resetSelected() {
      const { selectedId } = get();
      if (!selectedId) return;
      recordHistory(`reset:${selectedId}`);
      putSettings(selectedId, defaultSettings());
    },

    applyToAll() {
      const { images, selectedId } = get();
      const src = images.find((i) => i.id === selectedId);
      if (!src) return;
      recordHistory('apply-all');
      set((st) => ({
        images: st.images.map((i) => ({
          ...i,
          // bgRemoved, crop and healing stay per-photo: other photos have no
          // cutout to show, and a crop or heal stroke only makes sense on the
          // frame it was drawn on. Masks travel: gradients as placed, subject masks re-run
          // the model on each photo (see prepareModels), face picks become "every face".
          settings: {
            ...structuredClone(src.settings),
            masks: i.id === src.id ? structuredClone(src.settings.masks) : masksForOtherPhoto(structuredClone(src.settings.masks)),
            bgRemoved: i.settings.bgRemoved,
            crop: i.settings.crop,
            heal: i.settings.heal,
          },
        })),
      }));
      get().notify(`Copied these edits to all ${images.length} photos.`);
      void prepareModels();
    },

    async autoEnhanceSelected() {
      const { images, selectedId } = get();
      const item = images.find((i) => i.id === selectedId);
      if (!item) return;
      set({ busy: 'Analyzing…' });
      try {
        const stats = await statsFor(item);
        recordHistory(`auto:${item.id}`);
        putSettings(item.id, autoEnhance(stats, item.settings));
      } finally {
        set({ busy: null });
      }
    },

    async autoEnhanceAll() {
      const { images } = get();
      if (!images.length) return;
      recordHistory('auto-all');
      for (let i = 0; i < images.length; i++) {
        const item = images[i];
        set({ busy: `Auto enhancing ${i + 1}/${images.length}…` });
        try {
          const stats = await statsFor(item);
          putSettings(item.id, autoEnhance(stats, item.settings));
        } catch {
          // skip unreadable images; their status already reflects the error
        }
      }
      set({ busy: null });
      get().notify(`Auto enhance finished for ${images.length} photo${images.length === 1 ? '' : 's'}.`);
    },

    async removeBackgroundSelected() {
      const { images, selectedId } = get();
      const item = images.find((i) => i.id === selectedId);
      if (!item) return;
      if (item.settings.bgRemoved) {
        recordHistory(`bg:${item.id}`);
        putSettings(item.id, { ...item.settings, bgRemoved: false });
        return;
      }
      await withBusy('Removing background…', async () => {
        await ensureMatte(item);
        recordHistory(`bg:${item.id}`);
        putSettings(item.id, { ...get().images.find((i) => i.id === item.id).settings, bgRemoved: true });
      });
    },

    // ---- Masks (local adjustments) ----

    /**
     * Add a mask to the selected photo; subject and face masks run their
     * models first. `adj` presets the mask's adjustments (portrait actions).
     * Resolves to the new mask, or null.
     */
    async addMask(type, adj = null) {
      const item = selectedImage(get());
      if (!item || (item.settings.masks?.length ?? 0) >= MAX_MASKS) return null;
      if (isFaceMask(type)) {
        const faces = await withBusy('Finding faces…', () => ensureFaces(item)).catch((err) => {
          get().notify(`Couldn't analyze faces: ${err}`);
          return null;
        });
        if (faces === null) return null;
        if (faces === false) {
          get().notify('No faces found in this photo.');
          return null;
        }
      }
      if (type === 'subject' || type === 'background') {
        const ok = await withBusy('Finding the subject…', () => ensureMatte(item)).then(
          () => true,
          (err) => {
            get().notify(`Couldn't find the subject: ${err}`);
            return false;
          },
        );
        if (!ok) return null;
      }
      const base = newMask(type, `m${Date.now().toString(36)}${maskSeq++}`);
      const mask = adj ? { ...base, adj: { ...base.adj, ...adj } } : base;
      const current = get().images.find((i) => i.id === item.id)?.settings;
      if (!current || get().selectedId !== item.id) return null;
      get().updateSettings({ masks: [...(current.masks ?? []), mask], masksEnabled: true });
      set({ activeMaskId: mask.id });
      return mask;
    },

    /** Portrait quick actions: a face mask with a ready-made adjustment, one undo step. */
    async portraitAction(kind) {
      const actions = {
        smooth: { type: 'skin', adj: { texture: -0.65, clarity: -0.3 }, done: 'Smoothed skin' },
        eyes: { type: 'eyes', adj: { exposure: 0.06, clarity: 0.25, saturation: 0.1 }, done: 'Brightened eyes' },
        teeth: { type: 'teeth', adj: { saturation: -0.55, exposure: 0.08 }, done: 'Whitened teeth' },
      };
      const a = actions[kind];
      if (!a) return;
      const mask = await get().addMask(a.type, a.adj);
      if (mask) get().notify(`${a.done}. Fine-tune it under Masks.`);
    },

    /** Change one mask of the selected photo: `patch` merges into it (`adj`/`geo` merge too). */
    updateMask(id, patch) {
      const item = selectedImage(get());
      if (!item) return;
      const masks = item.settings.masks.map((m) =>
        m.id !== id
          ? m
          : {
              ...m,
              ...patch,
              adj: patch.adj ? { ...m.adj, ...patch.adj } : m.adj,
              geo: patch.geo ? { ...m.geo, ...patch.geo } : m.geo,
            },
      );
      get().updateSettings({ masks, masksEnabled: true });
    },

    removeMask(id) {
      const item = selectedImage(get());
      if (!item) return;
      get().updateSettings({ masks: item.settings.masks.filter((m) => m.id !== id) });
      if (get().activeMaskId === id) set({ activeMaskId: null });
    },

    /** Which faces a face mask applies to: null for every face, or 0-based indices. */
    setMaskFaces(id, faces) {
      get().updateMask(id, { faces: faces == null ? null : [...new Set(faces)].sort((a, b) => a - b) });
    },

    setActiveMask(id) {
      set({ activeMaskId: id });
    },

    setMaskOverlay(on) {
      set({ maskOverlay: on });
    },

    setMaskOutline(on) {
      set({ maskOutline: on });
    },

    // ---- Culling: ratings, flags, filter ----

    /** Star rating (0–5) for every selected photo. */
    setRating(n) {
      const ids = new Set(get().selectedIds);
      set((st) => ({ images: st.images.map((i) => (ids.has(i.id) ? { ...i, rating: n } : i)) }));
      saveCulling(ids);
      keepSelectionVisible();
    },

    /** 'pick', 'reject' or null for every selected photo; setting the same flag again clears it. */
    setFlag(flag) {
      const { selectedIds, images } = get();
      const ids = new Set(selectedIds);
      const all = images.filter((i) => ids.has(i.id)).every((i) => i.flag === flag);
      const next = all ? null : flag;
      set((st) => ({ images: st.images.map((i) => (ids.has(i.id) ? { ...i, flag: next } : i)) }));
      saveCulling(ids);
      keepSelectionVisible();
    },

    setFilter(filter) {
      set({ filter });
      keepSelectionVisible();
    },

    // ---- Merge ----

    /**
     * Merge the selected photos (bracketed exposures of one scene) into an
     * HDR photo saved next to the first one, then add it and select it. Each
     * photo goes in as edited, so exposure changes made first count.
     */
    async mergeHdr() {
      const { images, selectedIds } = get();
      const picked = images.filter((i) => selectedIds.includes(i.id));
      if (picked.length < 2) return;
      let path;
      try {
        path = await withBusy(`Preparing photo 1 of ${picked.length}…`, async () => {
          for (let i = 0; i < picked.length; i++) {
            set({ busy: `Preparing photo ${i + 1} of ${picked.length}…` });
            await backend.hdrAddFrame(i, pixelsOf(await renderEdited(picked[i])));
          }
          set({ busy: `Merging ${picked.length} photos to HDR…` });
          return backend.mergeHdr(picked[0].path);
        });
      } catch (err) {
        get().notify(`HDR merge failed: ${err}`);
        return;
      }
      await get().importPaths([path]);
      const added = get().images.find((i) => i.path === path);
      if (added) get().select(added.id);
      get().notify(`Merged ${picked.length} photos into ${added?.name ?? 'a new photo'}, saved next to the originals.`);
    },

    // ---- Lens blur ----

    /** Run whatever models the current edits need (depth for lens blur, mattes for subject masks). */
    prepareModels() {
      void prepareModels();
    },

    /** Ask the preview to pick the lens-blur focus with the next click. */
    requestFocusPick() {
      set((st) => ({ focusPickRequest: st.focusPickRequest + 1 }));
    },

    // ---- Healing ----

    /** Ask the preview to enter heal (brush) mode. */
    requestHeal() {
      set((st) => ({ healRequest: st.healRequest + 1 }));
    },

    /**
     * Heal a brush stroke on the selected photo (points in image uv, radius
     * as a fraction of the image width). The model runs first; the stroke
     * then lands as one undo step.
     */
    async addHealStroke(points, r) {
      const item = selectedImage(get());
      if (!item || !points.length) return;
      const stroke = newHealStroke(`h${Date.now().toString(36)}${maskSeq++}`, points, r);
      const ok = await withBusy('Healing…', async () => {
        const orig = await getOriginalBitmap(item);
        const existing = effectiveSettings(item.settings).heal ?? [];
        const canvas = await healedCanvas(orig, existing);
        healPatches.set(stroke.id, await healStroke(canvas, stroke));
      }).then(
        () => true,
        (err) => {
          get().notify(`Healing failed: ${err}`);
          return false;
        },
      );
      if (!ok) return;
      const current = get().images.find((i) => i.id === item.id);
      if (!current) return;
      recordHistory(`heal:${item.id}:${stroke.id}`);
      putSettings(item.id, { ...current.settings, heal: [...(current.settings.heal ?? []), stroke] });
    },

    /** Move the selection to the next (+1) or previous (−1) photo the filter shows. */
    step(delta) {
      const visible = visibleImages(get());
      if (!visible.length) return;
      const at = visible.findIndex((i) => i.id === get().selectedId);
      const next = visible[Math.min(visible.length - 1, Math.max(0, at < 0 ? 0 : at + delta))];
      get().select(next.id);
    },

    undo() {
      const entry = undoStack.pop();
      if (!entry) return;
      redoStack.push(snapshot());
      applyEntry(entry);
      lastRecordTag = '';
      lastRecordTime = 0;
      set({ canUndo: undoStack.length > 0, canRedo: true });
    },

    redo() {
      const entry = redoStack.pop();
      if (!entry) return;
      undoStack.push(snapshot());
      applyEntry(entry);
      lastRecordTag = '';
      lastRecordTime = 0;
      set({ canUndo: true, canRedo: redoStack.length > 0 });
    },

    /**
     * Stop saving after the current photo; a running upscale stops at its
     * next tile. Photos already saved stay on disk.
     */
    cancelExport() {
      if (!get().exporting || get().exportCancelled) return;
      set((st) => ({ exportCancelled: true, exporting: { ...st.exporting, detail: 'Canceling…' } }));
      void backend.upscaleSetCancelled(true);
    },

    setExportDialogOpen(open) {
      set((st) => ({
        exportDialogOpen: open,
        exportPrefs: open ? { ...st.exportPrefs, upscale: 0 } : st.exportPrefs,
      }));
    },

    setSettingsOpen(open) {
      set({ settingsOpen: open });
    },

    /**
     * Save photos with opts { dir, quality, maxDim, suffix, onlyShown }; an
     * empty `dir` saves each photo next to its original. The
     * format and watermark come from exportPrefs. `onlyShown` limits the save
     * to the photos the filmstrip filter shows.
     */
    async exportAll(opts) {
      const { format, watermark, upscale } = get().exportPrefs;
      const pool = opts.onlyShown ? visibleImages(get()) : get().images;
      const ready = pool.filter((i) => i.status !== 'error');
      if (!ready.length) return;
      const skippedUpscale = [];
      let stopUpscaleProgress = () => {};
      if (upscale) {
        await backend.upscaleSetCancelled(false);
        stopUpscaleProgress = await backend.onUpscaleProgress((done, total) =>
          set((st) => ({
            exporting: st.exporting && { ...st.exporting, detail: `Upscaling… ${Math.round((100 * done) / total)}%` },
          })),
        );
      }
      set({ exporting: { done: 0, total: ready.length, current: '' }, exportDialogOpen: false, exportCancelled: false });
      let logo = null;
      const failed = [];
      let saved = 0;
      try {
        if (watermark.enabled && watermark.kind === 'image' && watermark.imagePath) {
          logo = await decodeImage(watermark.imagePath).catch((err) => {
            failed.push(`watermark image: ${err}`);
            return null;
          });
        }
        for (let i = 0; i < ready.length; i++) {
          if (get().exportCancelled) break;
          const item = ready[i];
          set({ exporting: { done: i, total: ready.length, current: item.name } });
          try {
            const canvas = await renderEdited(item, {
              // Upscaled photos render at full size; the upscaler sets their size.
              maxDim: upscale ? null : opts.maxDim,
              watermark,
              logo,
            });
            // Cutouts need alpha: JPEG falls back to PNG for them.
            const fmt = formatFor(format, item.settings);
            const stem = item.name.replace(/\.[^.]+$/, '') + opts.suffix;
            const dir = opts.dir || item.path.replace(/[\\/][^\\/]*$/, '');
            const outPath = await backend.uniquePath(`${dir}/${stem}.${FORMATS[fmt].ext}`);
            // Largest factor that stays within the upscaler's size limit.
            const long = Math.max(canvas.width, canvas.height);
            const factor = upscale ? ([upscale, 2].find((f) => long * f <= UPSCALE_MAX) ?? 0) : 0;
            if (upscale && factor !== upscale) skippedUpscale.push(item.name);
            if (factor) {
              set((st) => ({ exporting: { ...st.exporting, detail: 'Upscaling…' } }));
              await backend.upscaleSave(outPath, fmt, opts.quality, factor, pixelsOf(canvas));
              set((st) => ({ exporting: { ...st.exporting, detail: '' } }));
            } else {
              const encoded = await encodeFrame(canvas, fmt, opts.quality);
              if (encoded.blob) await backend.writeFile(outPath, await encoded.blob.arrayBuffer());
              else await backend.savePixels(outPath, fmt, encoded.pixels);
            }
            saved++;
          } catch (err) {
            // Cancel stops an upscale mid-photo; that photo isn't a failure.
            if (get().exportCancelled) break;
            console.error(`Export failed for ${item.name}:`, err);
            failed.push(item.name);
          }
        }
      } finally {
        stopUpscaleProgress();
        logo?.close();
        if (get().exportCancelled) set({ exporting: null });
        else {
          set({ exporting: { done: ready.length, total: ready.length, current: '' } });
          setTimeout(() => set({ exporting: null }), 1500);
        }
      }
      if (get().exportCancelled) {
        set({ exportCancelled: false });
        get().notify(`Saving canceled. ${saved} of ${ready.length} photos saved.`);
      } else if (failed.length) get().notify(`Couldn't save ${failed.join(', ')}.`);
      else if (skippedUpscale.length) {
        get().notify(`Too large to upscale fully (max ${UPSCALE_MAX} px): ${skippedUpscale.join(', ')} saved at a smaller factor or original size.`);
      }
    },

    setQuality(q) {
      set({ quality: q });
    },

    setHistogram(h) {
      set({ histogram: h });
    },

    async loadPresets() {
      try {
        const presets = await backend.loadPresets(get().presetsDir);
        if (Array.isArray(presets)) set({ presets });
      } catch {
        // presets are optional; ignore load failures
      }
    },

    async savePreset(name) {
      const { images, selectedId, presets } = get();
      const item = images.find((i) => i.id === selectedId);
      if (!item || !name.trim()) return;
      const next = [
        ...presets.filter((p) => p.name !== name),
        // bgRemoved and crop are per-photo (framing, not a look); a preset
        // stores the look as seen, so switched-off edits are left out.
        {
          name,
          settings: {
            ...effectiveSettings(item.settings),
            bgRemoved: false,
            crop: null,
            heal: [],
            masks: masksForOtherPhoto(effectiveSettings(item.settings).masks),
            muted: [],
          },
        },
      ];
      set({ presets: next });
      await backend.savePresets(next, get().presetsDir);
    },

    /**
     * Move the presets library to `dir` (null = the default folder). A folder
     * that already has presets is used as is; otherwise the current presets
     * are copied into it, so nothing is lost by switching.
     */
    async setPresetsDir(dir) {
      const target = dir || null;
      if (target === get().presetsDir) return;
      if (await backend.presetsExist(target)) {
        set({ presetsDir: target, presets: [] });
        await get().loadPresets();
      } else {
        await backend.savePresets(get().presets, target);
        set({ presetsDir: target });
      }
      try {
        if (target) localStorage.setItem(PRESETS_DIR_KEY, target);
        else localStorage.removeItem(PRESETS_DIR_KEY);
      } catch {
        // the folder still applies for this session
      }
    },

    applyPreset(name) {
      const ids = get().selectedIds;
      if (!ids.length) return;
      applyPresetTo(name, new Set(ids), `preset:${name}:${ids.join(',')}`);
      if (ids.length > 1) get().notify(`Applied “${name}” to ${ids.length} photos.`);
    },

    applyPresetToAll(name) {
      applyPresetTo(name, null, `preset-all:${name}`);
    },

    async deletePreset(name) {
      const next = get().presets.filter((p) => p.name !== name);
      set({ presets: next });
      await backend.savePresets(next, get().presetsDir);
    },
  };
});

// The backend starts with every core in use; tell it if Settings turned that off.
if (!store.getState().multicore) void backend.setMulticore(false).catch((err) => console.error('set_multicore:', err));

export function selectedImage(st) {
  return st.images.find((i) => i.id === st.selectedId);
}
