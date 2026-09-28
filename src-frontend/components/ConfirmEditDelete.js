import { bind, h } from '../dom.js';
import { EDITS } from '../engine/types.js';
import { store } from '../state/store.js';

/**
 * Asks before an edit is removed from a photo. "Don't ask again" turns off
 * the matching setting (Settings › Editing), which can switch it back on.
 */
export function ConfirmEditDelete() {
  const st = () => store.getState();
  const title = h('h2', { id: 'confirm-title' });
  const dontAsk = h('input', { type: 'checkbox', id: 'confirm-dont-ask' });
  const removeBtn = h(
    'button',
    {
      className: 'btn danger large',
      'data-action': 'confirm-remove',
      onClick: () => {
        const id = st().pendingEditDelete;
        if (dontAsk.checked) st().setConfirmEditDelete(false);
        if (id) st().deleteEdit(id);
      },
    },
    'Remove',
  );
  const cancel = () => st().cancelEditDelete();

  const card = h(
    'div',
    { className: 'dialog confirm', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'confirm-title', onClick: (e) => e.stopPropagation() },
    title,
    h('p', { className: 'dialog-sub' }, 'Its setting goes back to neutral. You can undo this with Ctrl+Z.'),
    h(
      'div',
      { className: 'check-row' },
      dontAsk,
      h('label', { htmlFor: 'confirm-dont-ask' }, h('span', {}, 'Don’t ask again'), h('span', { className: 'hint' }, 'You can turn this back on in Settings.')),
    ),
    h('div', { className: 'dialog-actions' }, h('button', { className: 'btn ghost large', onClick: cancel }, 'Cancel'), removeBtn),
  );
  const el = h('div', { className: 'overlay confirm-dialog', onClick: cancel }, card);

  window.addEventListener('keydown', (e) => {
    if (el.hidden) return;
    if (e.key === 'Escape') cancel();
  });

  bind(
    (s) => s.pendingEditDelete,
    (id) => {
      el.hidden = !id;
      if (!id) return;
      const label = EDITS.find((e) => e.id === id)?.label ?? 'this edit';
      title.textContent = `Remove ${label}?`;
      dontAsk.checked = false;
      removeBtn.focus();
    },
  );
  return el;
}
