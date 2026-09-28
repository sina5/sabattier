import { backend } from '../backend.js';

const RAW_EXTS = new Set([
  'cr2', 'cr3', 'nef', 'arw', 'dng', 'raf', 'orf', 'rw2', 'pef', 'srw',
]);

export function extOf(path) {
  const i = path.lastIndexOf('.');
  return i >= 0 ? path.slice(i + 1).toLowerCase() : '';
}

export function isRawPath(path) {
  return RAW_EXTS.has(extOf(path));
}

export function baseName(path) {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Decode any supported file at full resolution. */
export async function decodeImage(path) {
  if (isRawPath(path)) return createImageBitmap(await backend.decodeRaw(path));
  return createImageBitmap(new Blob([await backend.readFile(path)]));
}

/** Decode a small thumbnail (roughly `size` px wide). */
export async function decodeThumbnail(path, size = 320) {
  let full;
  if (isRawPath(path)) {
    // Embedded camera preview when there is one; otherwise develop the RAW,
    // downscaled in Rust so only thumbnail-sized pixels cross the bridge.
    const pixels = (await backend.rawPreview(path, size)) ?? (await backend.decodeRaw(path, size));
    full = await createImageBitmap(pixels);
  } else {
    full = await createImageBitmap(new Blob([await backend.readFile(path)]));
  }
  if (full.width <= size) return full;
  const thumb = await createImageBitmap(full, {
    resizeWidth: size,
    resizeHeight: Math.max(1, Math.round((size / full.width) * full.height)),
    resizeQuality: 'medium',
  });
  full.close();
  return thumb;
}
