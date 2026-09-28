// Bridge to the Rust backend (src-backend/src). Everything that touches the
// disk, develops RAW files, or runs the segmentation model lives there.
// The Tauri API comes from the global Tauri injects (app.withGlobalTauri).
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { open, save } = window.__TAURI__.dialog;

const IMAGE_EXTS = [
  'jpg', 'jpeg', 'png', 'webp', 'tif', 'tiff', 'bmp', 'avif',
  'cr2', 'cr3', 'nef', 'arw', 'dng', 'raf', 'orf', 'rw2', 'pef', 'srw',
];

/** Input and matte resolution of the background-removal model. */
export const BG_MODEL_SIZE = 1024;
/** Fixed input/output resolution of the healing (inpainting) model. */
export const INPAINT_SIZE = 512;
/** Long edge of depth maps (sides are multiples of 14, the model's patch size). */
export const DEPTH_LONG_EDGE = 518;

/** Decodes the backend's `[width u32][height u32][RGBA8…]` pixel payload. */
function toImageData(buf) {
  const header = new DataView(buf, 0, 8);
  const width = header.getUint32(0, true);
  const height = header.getUint32(4, true);
  return new ImageData(new Uint8ClampedArray(buf, 8), width, height);
}

export const backend = {
  async openImages() {
    const picked = await open({
      title: 'Import images',
      multiple: true,
      filters: [
        { name: 'Images & RAW', extensions: IMAGE_EXTS },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    return picked ?? [];
  },

  /** One image file (PNG keeps a logo's transparency), or null. */
  async openImage(title = 'Choose image') {
    const picked = await open({
      title,
      multiple: false,
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    });
    return picked ?? null;
  },

  /** Any single file matching `filters`, or null. */
  async openFile(title, filters) {
    return (await open({ title, multiple: false, filters })) ?? null;
  },

  /** Where to save a new file (a save dialog), or null. */
  async saveDialog(title, defaultPath) {
    return (
      (await save({ title, defaultPath, filters: [{ name: 'Sabattier backup', extensions: ['json'] }] })) ?? null
    );
  },

  async openFolder(title = 'Choose folder') {
    return (await open({ title, directory: true, canCreateDirectories: true })) ?? null;
  },

  listImages: (dir) => invoke('list_images', { dir }),

  readFile: (path) => invoke('read_file', { path }),

  writeFile: (path, data) =>
    invoke('write_file', data instanceof Uint8Array ? data : new Uint8Array(data), {
      headers: { path: encodeURIComponent(path) },
    }),

  /** Encode RGBA8 pixels as `format` ('tiff' | 'webp', lossless) and write them to `path`. */
  savePixels: (path, format, { width, height, data }) =>
    invoke('save_pixels', data instanceof Uint8Array ? data : new Uint8Array(data.buffer), {
      headers: {
        path: encodeURIComponent(path),
        format,
        width: String(width),
        height: String(height),
      },
    }),

  /**
   * Upscale RGBA8 pixels 2× or 4× with the AI upscaler and save them to
   * `path` as `format` ('jpeg' | 'png' | 'webp' | 'tiff'); encoding happens in
   * the backend so the large result never crosses the bridge.
   */
  upscaleSave: (path, format, quality, factor, { width, height, data }) =>
    invoke('upscale_save', data instanceof Uint8Array ? data : new Uint8Array(data.buffer), {
      headers: {
        path: encodeURIComponent(path),
        format,
        quality: String(quality),
        factor: String(factor),
        width: String(width),
        height: String(height),
      },
    }),

  /** Stop the running upscale (true), or allow upscaling again (false). */
  upscaleSetCancelled: (cancelled) => invoke('upscale_set_cancelled', { cancelled }),

  /** Tile progress of an upscale: cb(done, total). */
  onUpscaleProgress(cb) {
    return listen('upscale-progress', (e) => cb(e.payload.done, e.payload.total));
  },

  uniquePath: (path) => invoke('unique_path', { path }),

  /** Fully developed RAW, optionally downscaled to fit `maxSize`. */
  async decodeRaw(path, maxSize) {
    return toImageData(await invoke('decode_raw', { path, maxSize }));
  },

  /** The camera's embedded preview fitted to `size`, or null if it has none. */
  async rawPreview(path, size) {
    const buf = await invoke('raw_preview', { path, size });
    return buf.byteLength ? toImageData(buf) : null;
  },

  /** RGBA at BG_MODEL_SIZE² in, one-byte-per-pixel alpha matte out. */
  async removeBackground(rgba) {
    return new Uint8Array(await invoke('remove_background', rgba));
  },

  /** INPAINT_SIZE² RGBA + INPAINT_SIZE² mask (≥128 = fill) in, filled RGBA out. */
  async inpaint(rgba, mask) {
    const body = new Uint8Array(rgba.length + mask.length);
    body.set(rgba);
    body.set(mask, rgba.length);
    return new Uint8Array(await invoke('inpaint', body));
  },

  /** RGBA at w×h (multiples of 14) in, relative depth (255 = near) out. */
  async estimateDepth(rgba, width, height) {
    return new Uint8Array(
      await invoke('estimate_depth', rgba, { headers: { width: String(width), height: String(height) } }),
    );
  },

  /** Progress of a model's one-time download: cb(received, total, modelName). */
  onModelDownload(cb) {
    return listen('model-progress', (e) => cb(e.payload.received, e.payload.total, e.payload.name));
  },

  /** Faces in RGBA at w×h: { width, height, crop_size, faces: [{ score, landmarks, skin_crop, skin }] }. */
  analyzeFaces: (rgba, width, height) =>
    invoke('analyze_faces', rgba, { headers: { width: String(width), height: String(height) } }),

  /** Stage frame `index` (RGBA8, the photo as edited) for mergeHdr; index 0 starts a new set. */
  hdrAddFrame: (index, { width, height, data }) =>
    invoke('hdr_add_frame', data instanceof Uint8Array ? data : new Uint8Array(data.buffer), {
      headers: { width: String(width), height: String(height), index: String(index) },
    }),

  /** Merge the staged frames into one photo saved next to firstPath; resolves to its path. */
  mergeHdr: (firstPath) => invoke('merge_hdr', { firstPath }),

  /** Heavy work (HDR merge, RAW development, AI models) on every CPU core, or on one. */
  setMulticore: (on) => invoke('set_multicore', { on }),

  /** Opens the project or sponsor page in the default browser (allowlisted in links.rs). */
  openLink: (url) => invoke('open_link', { url }),
  /** Whether this OS's app store lists Sabattier, and opening its write-a-review page. */
  reviewAvailable: () => invoke('review_available'),
  openReview: () => invoke('open_review'),
  /** The app version from tauri.conf.json. */
  appVersion: () => window.__TAURI__.app.getVersion(),

  /** Every ML model with its size and whether it is downloaded. */
  modelsList: () => invoke('models_list'),
  modelDelete: (id) => invoke('model_delete', { id }),

  /** Every saved rating/flag, and replacing them all (backup and restore). */
  catalogExport: () => invoke('catalog_export'),
  catalogImport: (entries) => invoke('catalog_import', { entries }),

  /** Saved ratings/flags for these paths (only photos that have any). */
  catalogGet: (paths) => invoke('catalog_get', { paths }),
  /** Save ratings/flags; entries back at 0 stars and no flag are removed. */
  catalogSet: (entries) => invoke('catalog_set', { entries }),

  /** `dir` is the user's presets folder, or null for the default one. */
  loadPresets: (dir) => invoke('load_presets', { dir }),
  savePresets: (presets, dir) => invoke('save_presets', { presets, dir }),
  presetsExist: (dir) => invoke('presets_exist', { dir }),
  defaultPresetsLocation: () => invoke('default_presets_location'),

  smokeConfig: () =>
    invoke('smoke_config'),
  smokeReady: (report) =>
    invoke('smoke_ready', { report }),
};
