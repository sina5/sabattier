/**
 * Tone curves: control points [x, y] in [0, 1], sorted by x, joined by a
 * monotone cubic (Fritsch–Carlson), so the curve never overshoots its points.
 * Beyond the first and last point the curve is flat.
 * @typedef {[number, number][]} CurvePoints
 */

export const IDENTITY_CURVE = [
  [0, 0],
  [1, 1],
];

/** The four curves a photo carries; `rgb` is the master curve. */
export const CURVE_CHANNELS = ['rgb', 'r', 'g', 'b'];

export const LUT_SIZE = 256;

export function isIdentityCurve(points) {
  return points.length === 2 && points[0][0] === 0 && points[0][1] === 0 && points[1][0] === 1 && points[1][1] === 1;
}

export function isIdentityCurveSet(curve) {
  return CURVE_CHANNELS.every((ch) => isIdentityCurve(curve[ch]));
}

/** A function x → y through `points`. */
export function curveSampler(points) {
  const n = points.length;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  if (n < 2) return () => ys[0] ?? 0;

  const d = []; // secant slopes
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(1e-6, xs[i + 1] - xs[i]));
  const m = new Array(n); // tangents
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }

  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    const hgt = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / hgt;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * ys[i] +
      (t3 - 2 * t2 + t) * hgt * m[i] +
      (-2 * t3 + 3 * t2) * ys[i + 1] +
      (t3 - t2) * hgt * m[i + 1]
    );
  };
}

/**
 * Bake the curve set into an RGBA float LUT (LUT_SIZE texels). Each channel
 * holds its own curve applied after the master one, so the shader needs one
 * lookup per channel.
 */
export function bakeCurveLut(curve) {
  const master = curveSampler(curve.rgb);
  const per = [curveSampler(curve.r), curveSampler(curve.g), curveSampler(curve.b)];
  const out = new Float32Array(LUT_SIZE * 4);
  for (let i = 0; i < LUT_SIZE; i++) {
    const m = Math.min(1, Math.max(0, master(i / (LUT_SIZE - 1))));
    for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.min(1, Math.max(0, per[c](m)));
    out[i * 4 + 3] = 1;
  }
  return out;
}
