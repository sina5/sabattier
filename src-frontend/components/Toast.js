import { bind, h } from '../dom.js';
import { icon } from '../icons.js';
import { store } from '../state/store.js';

/** Confirmation after a batch action, with a one-click undo. */
export function Toast() {
  const st = () => store.getState();
  const text = h('span');
  const el = h(
    'div',
    { className: 'toast', role: 'status' },
    icon('check', 18),
    text,
    h(
      'button',
      {
        className: 'toast-undo',
        onClick: () => {
          st().undo();
          st().dismissToast();
        },
      },
      'Undo',
    ),
  );
  bind(
    (s) => s.toast,
    (toast) => {
      el.hidden = !toast;
      text.textContent = toast?.text ?? '';
    },
  );
  return el;
}
