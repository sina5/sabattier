import { bind, drag, h } from '../dom.js';
import { selectedImage, store } from '../state/store.js';
import { formatValue } from './panel/Slider.js';

const W = 296;
const H = 110;

// Tonal zones, Lightroom-style: dragging any zone to the right brightens
// that part of the image. `from`/`to` span 0..1 across the x-axis; `invert`
// marks bands where "drag right = brighter image" means decreasing the value.
const BANDS = [
  { key: 'blackPoint', label: 'Black point', from: 0, to: 0.2, invert: true },
  { key: 'shadows', label: 'Shadows', from: 0.2, to: 0.45 },
  { key: 'exposure', label: 'Exposure', from: 0.45, to: 0.75 },
  { key: 'highlights', label: 'Highlights', from: 0.75, to: 0.92 },
  { key: 'whites', label: 'Whites', from: 0.92, to: 1 },
];

function drawChannel(ctx, bins, maxCount, fill, stroke) {
  ctx.beginPath();
  ctx.moveTo(0, H);
  for (let i = 0; i < 256; i++) {
    const v = Math.min(1, bins[i] / maxCount);
    ctx.lineTo((i / 255) * W, H - v * (H - 6));
  }
  ctx.lineTo(W, H);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1;
  ctx.stroke();
}

export function HistogramView() {
  const st = () => store.getState();
  let data = null;
  let settings = null;
  let hoverKey = null;
  let lockedKey = null;
  let dragKey = null;

  const draw = () => {
    const ctx = canvas.getContext('2d');
    const activeKey = dragKey ?? lockedKey ?? hoverKey;
    const activeBand = BANDS.find((b) => b.key === activeKey) ?? null;
    ctx.clearRect(0, 0, W, H);
    if (data) {
      ctx.globalCompositeOperation = 'source-over';
      drawChannel(ctx, data.l, data.maxCount, 'rgba(170,170,175,0.28)', 'rgba(190,190,195,0.5)');
      ctx.globalCompositeOperation = 'lighter';
      drawChannel(ctx, data.r, data.maxCount, 'rgba(225,60,55,0.34)', 'rgba(240,80,70,0.75)');
      drawChannel(ctx, data.g, data.maxCount, 'rgba(80,200,70,0.32)', 'rgba(100,215,85,0.75)');
      drawChannel(ctx, data.b, data.maxCount, 'rgba(60,110,235,0.36)', 'rgba(85,135,250,0.8)');
    }
    ctx.globalCompositeOperation = 'source-over';
    if (activeBand && settings) {
      // Highlight the active tonal zone + separators
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      ctx.fillRect(activeBand.from * W, 0, (activeBand.to - activeBand.from) * W, H);
      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx.setLineDash([3, 3]);
      for (const b of BANDS.slice(1)) {
        ctx.beginPath();
        ctx.moveTo(b.from * W, 0);
        ctx.lineTo(b.from * W, H);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.font = '500 12px "Barlow Semi Condensed", sans-serif';
      ctx.fillStyle = 'rgba(237,237,237,0.95)';
      ctx.fillText(`${activeBand.label}  ${formatValue(settings[activeBand.key])}`, 7, 14);
    }
  };

  const bandAtX = (clientX) => {
    const rect = canvas.getBoundingClientRect();
    const t = Math.min(0.999, Math.max(0, (clientX - rect.left) / rect.width));
    return BANDS.find((b) => t >= b.from && t < b.to) ?? BANDS[BANDS.length - 1];
  };
  const lockedOr = (clientX) => (lockedKey ? BANDS.find((b) => b.key === lockedKey) : bandAtX(clientX));

  const canvas = h('canvas', {
    className: 'hist-canvas interactive',
    width: W,
    height: H,
    title: 'Drag a zone to adjust it (right = brighter) · double-click to reset',
    onPointerDown: (e) => {
      if (!settings) return;
      const band = lockedOr(e.clientX);
      const startX = e.clientX;
      const startVal = settings[band.key];
      dragKey = band.key;
      // Adjusting a tonal zone implies the Basic section is in use
      if (!settings.basicEnabled) st().updateSettings({ basicEnabled: true });
      const rect = canvas.getBoundingClientRect();
      drag(
        (ev) => {
          const delta = ((ev.clientX - startX) / rect.width) * 2.2 * (band.invert ? -1 : 1);
          const v = Math.min(1, Math.max(-1, startVal + delta));
          st().updateSettings({ [band.key]: Math.round(v * 200) / 200 });
        },
        () => {
          dragKey = null;
          draw();
        },
      );
      draw();
    },
    onPointerMove: (e) => {
      if (dragKey) return;
      hoverKey = bandAtX(e.clientX).key;
      draw();
    },
    onPointerLeave: () => {
      hoverKey = null;
      draw();
    },
    onDblClick: (e) => st().updateSettings({ [lockedOr(e.clientX).key]: 0 }),
  });

  const chips = BANDS.map((b) =>
    h(
      'button',
      {
        className: 'hist-chip',
        onClick: () => {
          lockedKey = lockedKey === b.key ? null : b.key;
          syncChips();
          draw();
        },
      },
      b.label,
    ),
  );
  const syncChips = () => {
    BANDS.forEach((b, i) => {
      chips[i].classList.toggle('active', lockedKey === b.key);
      chips[i].title = lockedKey === b.key ? 'Unlock — zones follow the cursor again' : `Lock drags to ${b.label} only`;
    });
  };
  syncChips();

  bind(
    (s) => [s.histogram, selectedImage(s)?.settings],
    ([hist, s]) => {
      data = hist;
      settings = s ?? null;
      draw();
    },
  );

  return h('div', { className: 'hist-wrap' }, canvas, h('div', { className: 'hist-chips' }, chips));
}
