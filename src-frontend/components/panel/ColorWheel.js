import { drag, h } from '../../dom.js';
import { hslToRgb } from '../../engine/types.js';
import { Slider } from './Slider.js';

const SIZE = 116;

let wheelBg = null;

/** Hue/saturation disc rendered once and shared by all wheels. */
function wheelBackground() {
  if (wheelBg) return wheelBg;
  const c = document.createElement('canvas');
  c.width = SIZE;
  c.height = SIZE;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(SIZE, SIZE);
  const R = SIZE / 2;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = (x - R) / R;
      const dy = (y - R) / R;
      const r = Math.hypot(dx, dy);
      const i = (y * SIZE + x) * 4;
      if (r > 1) {
        img.data[i + 3] = 0;
        continue;
      }
      // red at the top, matching wheelToOffset()
      const hue = ((90 - (Math.atan2(-dy, dx) * 180) / Math.PI) % 360 + 360) % 360;
      const [cr, cg, cb] = hslToRgb(hue / 360, Math.min(1, r), 0.5);
      // fade toward the dark center like Pixelmator
      const mixDark = 1 - r * 0.75;
      img.data[i] = Math.round(cr * 255 * (1 - mixDark) + 40 * mixDark);
      img.data[i + 1] = Math.round(cg * 255 * (1 - mixDark) + 40 * mixDark);
      img.data[i + 2] = Math.round(cb * 255 * (1 - mixDark) + 40 * mixDark);
      img.data[i + 3] = r > 0.985 ? Math.round((1 - (r - 0.985) / 0.015) * 255) : 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  wheelBg = c;
  return c;
}

/** Color-balance wheel with a luminance slider. Returns the element plus set(value). */
export function ColorWheel(label, onChange) {
  let value = { x: 0, y: 0, lum: 0 };

  const canvas = h('canvas', {
    className: 'wheel-canvas',
    width: SIZE,
    height: SIZE,
    title: 'Double-click to reset',
    onDblClick: () => onChange({ x: 0, y: 0, lum: 0 }),
    onPointerDown: (e) => {
      canvas.setPointerCapture(e.pointerId);
      const apply = (clientX, clientY) => {
        const rect = canvas.getBoundingClientRect();
        const R = SIZE / 2;
        let x = (clientX - rect.left - R) / (R - 10);
        let y = -(clientY - rect.top - R) / (R - 10);
        const r = Math.hypot(x, y);
        if (r > 1) {
          x /= r;
          y /= r;
        }
        onChange({ ...value, x, y });
      };
      apply(e.clientX, e.clientY);
      drag((ev) => apply(ev.clientX, ev.clientY));
    },
  });

  const lum = Slider({ label: 'Luminance', onChange: (l) => onChange({ ...value, lum: l }) });

  const draw = () => {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.drawImage(wheelBackground(), 0, 0);
    const R = SIZE / 2;
    const kx = R + value.x * (R - 10);
    const ky = R - value.y * (R - 10);
    ctx.beginPath();
    ctx.arc(kx, ky, 7, 0, Math.PI * 2);
    ctx.fillStyle = '#f2f2f2';
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 4;
    ctx.fill();
    ctx.shadowBlur = 0;
    // crosshair ticks
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.moveTo(kx, ky - 10);
    ctx.lineTo(kx, ky - 13);
    ctx.moveTo(kx, ky + 10);
    ctx.lineTo(kx, ky + 13);
    ctx.moveTo(kx - 10, ky);
    ctx.lineTo(kx - 13, ky);
    ctx.moveTo(kx + 10, ky);
    ctx.lineTo(kx + 13, ky);
    ctx.stroke();
  };

  const el = h(
    'div',
    { className: 'wheel-block' },
    canvas,
    h('div', { style: { width: '100%' } }, lum.el),
    h('span', { className: 'wheel-label' }, label),
  );

  const set = (v) => {
    if (v.x !== value.x || v.y !== value.y || !canvas.dataset.drawn) {
      value = v;
      canvas.dataset.drawn = '1';
      draw();
    }
    value = v;
    lum.set(v.lum);
  };
  return { el, set };
}
