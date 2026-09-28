import { bind, drag, h } from '../../dom.js';
import { IDENTITY_CURVE, curveSampler, isIdentityCurve } from '../../engine/curve.js';

const W = 296;
const H = 220;
const PAD = 8;
/** Closest two points may get, in curve units. */
const MIN_GAP = 0.02;
const MAX_POINTS = 12;

const CHANNELS = [
  { id: 'rgb', label: 'RGB', stroke: '#ededed', hist: 'l' },
  { id: 'r', label: 'Red', stroke: '#f05046', hist: 'r' },
  { id: 'g', label: 'Green', stroke: '#64d755', hist: 'g' },
  { id: 'b', label: 'Blue', stroke: '#5587fa', hist: 'b' },
];

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/**
 * Point curve editor. Click to add a point and drag it; double-click a point
 * (or drag it off the graph) to remove it; double-click empty space to reset
 * the channel. `onChange(curve)` receives the whole four-channel curve.
 */
export function CurveEditor(onChange) {
  let curve = null;
  let channel = 'rgb';
  let hist = null;
  let active = -1;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  const canvas = h('canvas', { className: 'curve-canvas', width: W * dpr, height: H * dpr });
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;

  const toPx = ([x, y]) => [PAD + x * (W - 2 * PAD), H - PAD - y * (H - 2 * PAD)];
  const fromEvent = (e) => {
    const r = canvas.getBoundingClientRect();
    const sx = W / r.width;
    const sy = H / r.height;
    return [((e.clientX - r.left) * sx - PAD) / (W - 2 * PAD), (H - PAD - (e.clientY - r.top) * sy) / (H - 2 * PAD)];
  };
  const points = () => curve?.[channel] ?? IDENTITY_CURVE;
  const hitIndex = (e) => {
    const [x, y] = fromEvent(e);
    const tol = 9 / (W - 2 * PAD);
    let best = -1;
    let bestD = tol;
    points().forEach((p, i) => {
      const d = Math.hypot(p[0] - x, p[1] - y);
      if (d < bestD) {
        best = i;
        bestD = d;
      }
    });
    return best;
  };
  const emit = (pts) => onChange({ ...curve, [channel]: pts });

  const draw = () => {
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const ch = CHANNELS.find((c) => c.id === channel);
    const iw = W - 2 * PAD;
    const ih = H - 2 * PAD;

    // Histogram of the current render, faint, behind everything.
    if (hist) {
      const bins = hist[ch.hist];
      ctx.beginPath();
      ctx.moveTo(PAD, H - PAD);
      for (let i = 0; i < 256; i++) ctx.lineTo(PAD + (i / 255) * iw, H - PAD - Math.min(1, bins[i] / hist.maxCount) * ih * 0.9);
      ctx.lineTo(PAD + iw, H - PAD);
      ctx.fillStyle = 'rgba(160,160,165,0.16)';
      ctx.fill();
    }
    // Quarter grid and the neutral diagonal.
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo(PAD + (i / 4) * iw, PAD);
      ctx.lineTo(PAD + (i / 4) * iw, H - PAD);
      ctx.moveTo(PAD, PAD + (i / 4) * ih);
      ctx.lineTo(W - PAD, PAD + (i / 4) * ih);
      ctx.stroke();
    }
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(...toPx([0, 0]));
    ctx.lineTo(...toPx([1, 1]));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.strokeRect(PAD + 0.5, PAD + 0.5, iw - 1, ih - 1);

    // The curve.
    const pts = points();
    const f = curveSampler(pts);
    ctx.beginPath();
    for (let i = 0; i <= 128; i++) {
      const x = i / 128;
      const [px, py] = toPx([x, clamp01(f(x))]);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = ch.stroke;
    ctx.lineWidth = 2;
    ctx.stroke();

    for (let i = 0; i < pts.length; i++) {
      const [px, py] = toPx(pts[i]);
      ctx.beginPath();
      ctx.arc(px, py, i === active ? 6 : 4.5, 0, Math.PI * 2);
      ctx.fillStyle = i === active ? ch.stroke : '#1b1b1b';
      ctx.fill();
      ctx.strokeStyle = ch.stroke;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  };

  canvas.addEventListener('pointerdown', (e) => {
    if (!curve || e.button !== 0) return;
    let pts = points().map((p) => [...p]);
    let i = hitIndex(e);
    if (i < 0) {
      if (pts.length >= MAX_POINTS) return;
      const [x] = fromEvent(e);
      const cx = clamp01(x);
      // New points land on the current curve, so a click alone changes nothing.
      const y = clamp01(curveSampler(pts)(cx));
      i = pts.findIndex((p) => p[0] > cx);
      if (i <= 0) return; // outside the end points
      if (cx - pts[i - 1][0] < MIN_GAP || pts[i][0] - cx < MIN_GAP) return;
      pts.splice(i, 0, [cx, y]);
      emit(pts);
    }
    active = i;
    const index = i;
    const last = pts.length - 1;
    let removing = false;
    draw();
    drag(
      (ev) => {
        const [x, y] = fromEvent(ev);
        // Interior points dragged well off the graph are removed on release.
        removing = index > 0 && index < last && (y < -0.12 || y > 1.12);
        const lo = index === 0 ? 0 : pts[index - 1][0] + MIN_GAP;
        const hi = index === last ? 1 : pts[index + 1][0] - MIN_GAP;
        pts = pts.map((p, k) => (k === index ? [Math.min(hi, Math.max(lo, x)), clamp01(y)] : p));
        emit(removing ? pts.filter((_, k) => k !== index) : pts);
      },
      () => {
        active = -1;
        draw();
      },
    );
  });

  canvas.addEventListener('dblclick', (e) => {
    if (!curve) return;
    const i = hitIndex(e);
    const pts = points();
    if (i > 0 && i < pts.length - 1) emit(pts.filter((_, k) => k !== i));
    else if (i < 0) emit(structuredClone(IDENTITY_CURVE));
  });

  const tabs = CHANNELS.map((c) =>
    h(
      'button',
      {
        className: `seg-btn ch-${c.id}`,
        onClick: () => {
          channel = c.id;
          syncTabs();
          draw();
        },
      },
      c.label,
    ),
  );
  const syncTabs = () =>
    CHANNELS.forEach((c, i) => {
      tabs[i].classList.toggle('active', c.id === channel);
      tabs[i].setAttribute('aria-pressed', String(c.id === channel));
      // Mark channels that carry a curve.
      tabs[i].classList.toggle('edited', !!curve && !isIdentityCurve(curve[c.id]));
    });
  syncTabs();

  bind(
    (s) => s.histogram,
    (hg) => {
      hist = hg;
      draw();
    },
  );

  const el = h(
    'div',
    { className: 'curve-editor' },
    h('div', { className: 'seg', role: 'group', 'aria-label': 'Curve channel' }, tabs),
    canvas,
    h('div', { className: 'hint' }, 'Click to add a point, drag to shape. Double-click a point to remove it, or empty space to reset.'),
  );

  const update = (settings) => {
    if (settings.curve === curve) return;
    curve = settings.curve;
    syncTabs();
    draw();
  };
  return { el, update };
}
