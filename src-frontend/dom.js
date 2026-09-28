import { store } from './state/store.js';

/**
 * Create an element. Props starting with "on" become event listeners
 * (onClick → click, onPointerDown → pointerdown, onDblClick → dblclick),
 * `style` is merged into el.style, known DOM properties are assigned, and
 * anything else becomes an attribute. null/false props and children are skipped.
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'style') Object.assign(el.style, value);
    else if (key in el) el[key] = value;
    else el.setAttribute(key, value);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

const same = (a, b) =>
  Object.is(a, b) ||
  (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i])));

/**
 * Call `fn(value)` now and whenever `select(state)` changes. Arrays are
 * compared element-wise, so a selector can return a tuple of values.
 */
export function bind(select, fn) {
  let last = select(store.getState());
  fn(last);
  return store.subscribe((st) => {
    const next = select(st);
    if (same(next, last)) return;
    last = next;
    fn(next);
  });
}

/** Track a pointer drag on window until release. */
export function drag(onMove, onUp) {
  const up = (e) => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', up);
    onUp?.(e);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', up);
}
