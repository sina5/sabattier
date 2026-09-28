// Turns a face analysis (landmarks + face-skin probabilities from the backend)
// into the face texture the shader reads: skin (r), eyes (g), lips (b),
// teeth (a), one byte each, in full-image coordinates — plus a face-id map
// (which face each pixel belongs to, 1-based, 0 = none) so a mask can apply
// to some faces only. Faces are numbered left to right.

// MediaPipe face-mesh contours (landmark indices), in drawing order.
const RIGHT_EYE = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
const LEFT_EYE = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466];
const RIGHT_BROW = [70, 63, 105, 66, 107, 55, 65, 52, 53, 46];
const LEFT_BROW = [300, 293, 334, 296, 336, 285, 295, 282, 283, 276];
const LIPS_OUTER = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185];
const LIPS_INNER = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191];

/** Longest edge the face texture is built at. */
export const FACE_TEXTURE_EDGE = 1024;
/** Most faces a mask can pick from (bits of the shader's face mask). */
export const MAX_FACES = 24;

function polygon(ctx, pts, indices) {
  ctx.moveTo(pts[indices[0]][0], pts[indices[0]][1]);
  for (const i of indices.slice(1)) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
}

/** Face size in analyzed-image pixels: the distance between the outer eye corners. */
const eyeSpan = (pts) => Math.hypot(pts[263][0] - pts[33][0], pts[263][1] - pts[33][1]);

/** A grayscale layer, filled black. */
function layer(w, h) {
  const ctx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  return ctx;
}

/** Soft edges: draw the layer small and back up, a cheap blur that works in every webview. */
function soften(ctx, amount) {
  const { width: w, height: h } = ctx.canvas;
  const sw = Math.max(1, Math.round(w / amount));
  const sh = Math.max(1, Math.round(h / amount));
  const small = new OffscreenCanvas(sw, sh).getContext('2d');
  small.imageSmoothingQuality = 'high';
  small.drawImage(ctx.canvas, 0, 0, sw, sh);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(small.canvas, 0, 0, w, h);
}

/**
 * Build the face texture from `analysis` ({ width, height, crop_size, faces }).
 * Returns { data, width, height, faces } or null when no face was found.
 */
export async function buildFaceTexture(analysis) {
  if (!analysis.faces.length) return null;
  // Left to right, so "Face 1" is the leftmost person; at most MAX_FACES.
  const centerX = (f) => f.landmarks.reduce((a, p) => a + p[0], 0) / f.landmarks.length;
  const faceList = [...analysis.faces].sort((a, b) => centerX(a) - centerX(b)).slice(0, MAX_FACES);
  const k = Math.min(1, FACE_TEXTURE_EDGE / Math.max(analysis.width, analysis.height));
  const w = Math.max(1, Math.round(analysis.width * k));
  const h = Math.max(1, Math.round(analysis.height * k));
  const n = analysis.crop_size;
  const skin = layer(w, h);
  const eyes = layer(w, h);
  const lips = layer(w, h);
  const teeth = layer(w, h);
  for (const ctx of [skin, eyes, lips, teeth]) {
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#fff';
    ctx.lineJoin = 'round';
  }

  const boxes = [];
  for (const face of faceList) {
    const pts = face.landmarks.map(([x, y]) => [x * k, y * k]);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    boxes.push({ x0: Math.min(...xs) / w, y0: Math.min(...ys) / h, x1: Math.max(...xs) / w, y1: Math.max(...ys) / h });
    const span = eyeSpan(pts);

    // Skin: the segmenter's probabilities, drawn through the crop's transform.
    const probs = new ImageData(n, n);
    for (let i = 0; i < face.skin.length; i++) {
      const v = face.skin[i];
      probs.data.set([v, v, v, 255], i * 4);
    }
    const bmp = await createImageBitmap(probs);
    const c = face.skin_crop;
    skin.save();
    skin.globalCompositeOperation = 'lighten'; // union across faces
    skin.translate(c.cx * k, c.cy * k);
    skin.rotate(c.angle);
    skin.scale((c.size * k) / n, (c.size * k) / n);
    skin.imageSmoothingQuality = 'high';
    skin.drawImage(bmp, -n / 2, -n / 2);
    skin.restore();
    bmp.close();

    // Features cut out of the skin, a little wider than drawn so no lash or
    // lip edge gets smoothed.
    skin.save();
    skin.fillStyle = skin.strokeStyle = '#000';
    skin.lineWidth = span * 0.06;
    for (const part of [RIGHT_EYE, LEFT_EYE, RIGHT_BROW, LEFT_BROW, LIPS_OUTER]) {
      skin.beginPath();
      polygon(skin, pts, part);
      skin.fill();
      skin.stroke();
    }
    skin.restore();

    // Eyes (with irises), lips (outer minus the mouth opening), teeth (the opening).
    eyes.beginPath();
    polygon(eyes, pts, RIGHT_EYE);
    polygon(eyes, pts, LEFT_EYE);
    eyes.fill();
    lips.beginPath();
    polygon(lips, pts, LIPS_OUTER);
    polygon(lips, pts, LIPS_INNER);
    lips.fill('evenodd');
    teeth.beginPath();
    polygon(teeth, pts, LIPS_INNER);
    teeth.fill();
  }

  const soft = Math.max(2, Math.round(w / 400));
  for (const ctx of [skin, eyes, lips, teeth]) soften(ctx, soft);

  const data = new Uint8Array(w * h * 4);
  const planes = [skin, eyes, lips, teeth].map((ctx) => ctx.getImageData(0, 0, w, h).data);
  for (let i = 0; i < w * h; i++) {
    for (let ch = 0; ch < 4; ch++) data[i * 4 + ch] = planes[ch][i * 4];
  }

  // Face ids: every covered pixel goes to the nearest face, distance measured
  // in units of that face's size, so a small face next to a large one keeps
  // its own skin.
  const centers = boxes.map((b) => ({
    x: ((b.x0 + b.x1) / 2) * w,
    y: ((b.y0 + b.y1) / 2) * h,
    r: Math.max((b.x1 - b.x0) * w, (b.y1 - b.y0) * h) / 2,
  }));
  const ids = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!(data[i * 4] | data[i * 4 + 1] | data[i * 4 + 2] | data[i * 4 + 3])) continue;
      let best = 0;
      let bestD = Infinity;
      centers.forEach((c, f) => {
        const d = Math.hypot(x - c.x, y - c.y) / c.r;
        if (d < bestD) {
          bestD = d;
          best = f + 1;
        }
      });
      ids[i] = best;
    }
  }
  return { data, ids, width: w, height: h, faces: faceList.length, boxes };
}
