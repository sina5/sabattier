import { drag, h } from '../../dom.js';

const GRADIENTS = {
  temperature:
    'linear-gradient(90deg, #3d7bf5, #8fb6e8 35%, #b9b7ab 50%, #e8c76f 65%, #f5a623)',
  tint: 'linear-gradient(90deg, #35c759, #9fd2a4 35%, #c9b9c4 50%, #e88fd0 65%, #f542c8)',
};

/** Signed readout for centered scales: +35, −20, 0 (true minus sign). */
export function formatValue(v, signed = true) {
  const n = Math.round(v * 100);
  if (!signed || n === 0) return String(n);
  return n > 0 ? `+${n}` : `−${-n}`;
}

/**
 * Labeled slider with a percentage readout. `gradient` is 'temperature',
 * 'tint', any CSS background, or omitted; `ends` optionally names the two ends of the scale in
 * plain words (['Darker', 'Brighter']); `onReset` replaces the double-click
 * reset to 0. Returns the element plus set(value, disabled).
 */
export function Slider({ label, onChange, onReset, min = -1, max = 1, gradient, ends }) {
  const value = h('span', { className: 'value' });
  const dot = h('div', { className: 'thumb-dot' });
  // Filled span of the scale, from its neutral point to the current value.
  const fill = h('div', { className: 'fill' });
  const rail = h('div', { className: 'rail' });
  if (gradient) rail.style.background = GRADIENTS[gradient] ?? gradient;

  const setFromX = (clientX) => {
    const rect = track.getBoundingClientRect();
    const t = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const raw = min + t * (max - min);
    // snap to neutral near the middle
    const snapped = Math.abs(raw) < 0.015 && min < 0 ? 0 : raw;
    onChange(Math.round(snapped * 200) / 200);
  };

  const track = h(
    'div',
    {
      className: 'slider-track',
      title: 'Double-click to reset',
      onPointerDown: (e) => {
        e.target.setPointerCapture?.(e.pointerId);
        setFromX(e.clientX);
        drag((ev) => setFromX(ev.clientX));
      },
      onDblClick: () => (onReset ? onReset() : onChange(0)),
    },
    rail,
    fill,
    dot,
  );

  const el = h(
    'div',
    { className: 'sliderRow' },
    h('div', { className: 'labels' }, h('span', {}, label), value),
    track,
    ends && h('div', { className: 'ends' }, h('span', {}, ends[0]), h('span', {}, ends[1])),
  );

  const pos = (v) => ((v - min) / (max - min)) * 100;
  const zero = pos(Math.min(max, Math.max(min, 0)));
  if (min < 0) track.classList.add('centered');

  const set = (v, disabled = false) => {
    const at = pos(v);
    dot.style.left = `${at}%`;
    fill.style.left = `${Math.min(at, zero)}%`;
    fill.style.width = `${Math.abs(at - zero)}%`;
    value.textContent = formatValue(v, min < 0);
    value.classList.toggle('neutral', Math.round(v * 100) === 0);
    el.style.opacity = disabled ? '0.45' : '';
    el.style.pointerEvents = disabled ? 'none' : '';
  };
  return { el, set };
}
