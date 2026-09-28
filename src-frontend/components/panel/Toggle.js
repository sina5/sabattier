import { h } from '../../dom.js';

/** iOS-style switch. Returns the element plus a setter for its state. */
export function Toggle(onChange) {
  let on = false;
  const el = h('button', { className: 'toggle', role: 'switch', onClick: () => onChange(!on) });
  const set = (value) => {
    on = value;
    el.classList.toggle('on', on);
    el.setAttribute('aria-checked', String(on));
  };
  set(false);
  return { el, set };
}
