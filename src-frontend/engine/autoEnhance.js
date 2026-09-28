import { defaultSettings, EXPOSURE_STOPS } from './types.js';

/** Gather histogram statistics from a (downscaled) copy of the image. */
export function computeStats(bitmap, maxSize = 512) {
  const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;

  const hist = new Uint32Array(256);
  let sumSat = 0;
  let nR = 0;
  let nG = 0;
  let nB = 0;
  let nCount = 0;
  const n = w * h;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i];
    const g = px[i + 1];
    const b = px[i + 2];
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const sat = mx > 0 ? (mx - mn) / mx : 0;
    sumSat += sat;
    const luma = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
    hist[luma]++;
    // near-neutral, mid-tone pixels are the trustworthy white-balance evidence
    if (sat < 0.25 && luma > 26 && luma < 242) {
      nR += r;
      nG += g;
      nB += b;
      nCount++;
    }
  }

  const percentile = (p) => {
    const target = p * n;
    let acc = 0;
    for (let i = 0; i < 256; i++) {
      acc += hist[i];
      if (acc >= target) return i / 255;
    }
    return 1;
  };

  let black = 0;
  let white = 0;
  for (let i = 0; i <= 2; i++) black += hist[i];
  for (let i = 253; i <= 255; i++) white += hist[i];

  return {
    hist,
    pixelCount: n,
    meanSat: sumSat / n,
    neutralR: nCount ? nR / nCount / 255 : 0,
    neutralG: nCount ? nG / nCount / 255 : 0,
    neutralB: nCount ? nB / nCount / 255 : 0,
    neutralFrac: nCount / n,
    p001: percentile(0.001),
    p05: percentile(0.05),
    p50: percentile(0.5),
    p95: percentile(0.95),
    p999: percentile(0.999),
    blackClip: black / n,
    whiteClip: white / n,
  };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
/** Zero-out negligible corrections so "auto" doesn't fiddle every slider. */
const deadband = (v, band = 0.03) => (Math.abs(v) < band ? 0 : v);
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * Fraction of pixels that would clip after applying `stops` of exposure.
 * The shader applies exposure in linear light; on the gamma-encoded luma
 * histogram that is a multiplication by 2^(stops/2.2).
 */
function clipFracAfter(stats, stops) {
  const gain = Math.pow(2, stops / 2.2);
  const threshold = Math.floor((0.985 * 255) / gain);
  let clipped = 0;
  for (let i = Math.max(0, threshold); i < 256; i++) clipped += stats.hist[i];
  return clipped / stats.pixelCount;
}

/**
 * Histogram-driven auto enhancer, v2.
 *
 * Design rules learned from real photos:
 * - Never wash out an image to hit a target brightness: exposure is capped by
 *   simulating its effect on the histogram and keeping highlight clipping flat.
 *   Any remaining midtone deficit is applied as brightness (gamma — cannot
 *   clip) and masked shadow lift instead.
 * - A dominant color mood (sunset, stage light, neon) is not a white-balance
 *   error: the cast is measured on near-neutral pixels only and the correction
 *   is scaled by how much neutral evidence exists.
 */
export function autoEnhance(stats, base) {
  const s = { ...(base ?? defaultSettings()) };
  s.wbEnabled = true;
  s.basicEnabled = true;
  s.hslEnabled = true;

  // ---- White balance: neutral-pixel gray world, confidence-scaled ----
  const { neutralR, neutralG, neutralB, neutralFrac } = stats;
  const nMean = (neutralR + neutralG + neutralB) / 3;
  // Confidence: needs real neutral evidence (2% → none, 20%+ → full) and a
  // mostly-desaturated scene. A saturated scene (sunset, neon, stage light)
  // is a color *mood*, not a cast — leave it alone.
  const wbConfidence =
    smoothstep(0.02, 0.2, neutralFrac) * (1 - smoothstep(0.25, 0.45, stats.meanSat));
  if (nMean > 0.02 && wbConfidence > 0) {
    // Positive temperature warms (boosts R, cuts B); correct a blue cast.
    s.temperature = deadband(
      clamp(((neutralB - neutralR) / nMean) * 0.5 * wbConfidence, -0.25, 0.25),
    );
    // Positive tint adds magenta (cuts G); correct a green cast.
    s.tint = deadband(
      clamp(((neutralG - (neutralR + neutralB) / 2) / nMean) * 0.55 * wbConfidence, -0.12, 0.12),
      0.04,
    );
  } else {
    s.temperature = 0;
    s.tint = 0;
  }

  // ---- Exposure: histogram-simulated, highlight-protected ----
  // Asymmetric comfort band: brighten only clearly dark images, darken only
  // clearly bright ones, and aim for the band edge, not a fixed center.
  const median = clamp(stats.p50, 0.01, 0.98);
  let stopsNeeded = 0;
  if (median < 0.3) stopsNeeded = 2.2 * Math.log2(0.38 / median);
  else if (median > 0.62) stopsNeeded = 2.2 * Math.log2(0.55 / median) * 0.6;
  let stops = 0;
  if (stopsNeeded > 0.1) {
    // Brighten only as far as the highlights allow: keep the fraction of
    // clipped pixels no higher than it already is (plus a small tolerance).
    const clipBudget = Math.max(stats.whiteClip * 1.15, 0.004);
    for (let cand = Math.min(stopsNeeded * 0.85, 1.5); cand > 0.05; cand -= 0.05) {
      if (clipFracAfter(stats, cand) <= clipBudget) {
        stops = cand;
        break;
      }
    }
  } else if (stopsNeeded < -0.15) {
    stops = Math.max(stopsNeeded, -1.0);
  }
  s.exposure = deadband(clamp(stops / EXPOSURE_STOPS, -1.25 / EXPOSURE_STOPS, 1.25 / EXPOSURE_STOPS), 0.015);

  // ---- Brightness: gamma lift for the midtone deficit exposure couldn't cover ----
  const medianAfter = clamp(median * Math.pow(2, stops / 2.2), 0.02, 0.95);
  let brightness = 0;
  if (stopsNeeded > 0 && medianAfter < 0.33) {
    // Solve pow(m, 1/(1+0.75b)) = target for b, then damp.
    brightness = ((Math.log(medianAfter) / Math.log(0.38) - 1) / 0.75) * 0.6;
  }
  s.brightness = deadband(clamp(brightness, 0, 0.3));

  // The tone sliders below act on the image *after* exposure and brightness,
  // so evaluate the percentiles through that lift first.
  const gain = Math.pow(2, stops / 2.2);
  const gamma = 1 / (1 + 0.75 * s.brightness);
  const lift = (x) => Math.pow(clamp(x * gain, 0, 1), gamma);

  // ---- Black point: gently anchor true blacks near the 0.1% percentile ----
  const black = lift(stats.p001);
  if (black > 0.03) {
    s.blackPoint = clamp((black - 0.02) * 1.3, 0, 0.22);
  } else if (stats.blackClip > 0.05) {
    s.blackPoint = -clamp(stats.blackClip * 2, 0, 0.2); // lift crushed blacks
  } else {
    s.blackPoint = 0;
  }

  // ---- Highlight recovery for whatever still clips ----
  const clipAfter = clipFracAfter(stats, stops);
  s.highlights = clipAfter > 0.004 ? -clamp(0.1 + clipAfter * 18, 0.1, 0.5) : 0;

  // ---- Shadow lift when shadows are crushed (or exposure was capped) ----
  const shadowPoint = lift(stats.p05);
  let shadows = shadowPoint < 0.045 ? clamp((0.045 - shadowPoint) * 12, 0.05, 0.4) : 0;
  if (stopsNeeded - stops > 0.4 && stops > 0) shadows = Math.max(shadows, 0.12);
  s.shadows = shadows;

  // ---- Contrast from usable dynamic range ----
  const range = lift(stats.p95) - shadowPoint;
  s.contrast = range < 0.55 ? clamp((0.62 - range) * 0.9, 0, 0.25) : 0;

  // ---- Gentle vibrance for flat colors; never touch rich ones ----
  s.vibrance = stats.meanSat < 0.18 ? 0.12 : stats.meanSat < 0.3 ? 0.06 : 0;

  s.saturation = 0;
  s.hue = 0;
  return s;
}
