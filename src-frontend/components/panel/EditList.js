import { bind, h } from '../../dom.js';
import { UNSIGNED_EDITS, listEdits } from '../../engine/types.js';
import { icon } from '../../icons.js';
import { selectedImage, store } from '../../state/store.js';
import { formatValue } from './Slider.js';

/** Readout next to an edit's name; empty for edits without a single number. */
function valueText(edit, s) {
  const v = s[edit.keys[0]];
  if (edit.id === 'masks' || edit.id === 'heal') return String(v.length);
  return typeof v === 'number' ? formatValue(v, !UNSIGNED_EDITS.has(edit.id)) : '';
}

/**
 * The edits on the selected photo, one row each: a checkbox switches the edit
 * off and on without losing its value, the red button removes it.
 */
export function EditList() {
  const st = () => store.getState();
  const count = h('span', { className: 'edit-count' });
  const list = h('ul', { className: 'edit-list', 'aria-label': 'Edits on this photo' });
  const empty = h('p', { className: 'hint' }, 'No edits yet. Try Auto enhance or move a slider.');

  bind(
    (s) => selectedImage(s)?.settings,
    (settings) => {
      const edits = settings ? listEdits(settings) : [];
      count.textContent = edits.length ? String(edits.length) : '';
      empty.hidden = edits.length > 0;
      list.replaceChildren(
        ...edits.map(({ edit, on }) => {
          const id = `edit-${edit.id}`;
          return h(
            'li',
            { className: on ? 'edit-row' : 'edit-row off' },
            h('input', {
              type: 'checkbox',
              id,
              checked: on,
              onChange: (e) => st().setEditOn(edit.id, e.target.checked),
            }),
            h('label', { htmlFor: id, className: 'edit-name' }, edit.label),
            h('span', { className: 'edit-value' }, valueText(edit, settings)),
            h(
              'button',
              {
                className: 'edit-delete',
                title: `Remove ${edit.label} from this photo`,
                'aria-label': `Remove ${edit.label}`,
                onClick: () => st().requestEditDelete(edit.id),
              },
              icon('close', 12),
            ),
          );
        }),
      );
    },
  );

  return h(
    'section',
    { className: 'group edits-box' },
    h('h3', { className: 'group-title' }, 'Edits on this photo ', count),
    list,
    empty,
  );
}
