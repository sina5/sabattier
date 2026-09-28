import { bind, h } from '../../dom.js';
import { MASK_ADJUSTMENTS, MAX_MASKS, isFaceMask, maskLabel } from '../../engine/types.js';
import { icon } from '../../icons.js';
import { getFaces, getThumbBitmap, selectedImage, store } from '../../state/store.js';
import { Slider } from './Slider.js';

const ADD = [
  { type: 'subject', label: 'Subject', title: 'Select the main subject (runs the segmentation model once per photo)' },
  { type: 'background', label: 'Background', title: 'Everything except the main subject' },
  { type: 'linear', label: 'Linear', title: 'A straight gradient, e.g. to darken a sky' },
  { type: 'radial', label: 'Radial', title: 'An ellipse, e.g. to lift a face' },
];

/** Masks from the face analysis (every face in the photo). */
const ADD_FACE = [
  { type: 'skin', label: 'Face skin', title: 'Skin of every face, without eyes, brows and lips' },
  { type: 'eyes', label: 'Eyes', title: 'The eyes of every face' },
  { type: 'lips', label: 'Lips', title: 'The lips of every face' },
  { type: 'teeth', label: 'Teeth', title: 'The mouth opening of every face' },
];

/**
 * Local adjustments: add masks, pick one to edit, and move its sliders.
 * Returns { el, update(settings) } like the other panel fields.
 */
export function MaskPanel() {
  const st = () => store.getState();
  let masks = [];
  let activeId = null;

  const addBtn = (a) =>
    h('button', { className: 'btn mask-add', title: a.title, onClick: () => void st().addMask(a.type) }, icon('plus', 14), a.label);
  const addBtns = [...ADD.map(addBtn), ...ADD_FACE.map(addBtn)];
  const list = h('ul', { className: 'mask-list', 'aria-label': 'Masks on this photo' });
  const empty = h('p', { className: 'hint' }, 'Masks apply edits to one part of the photo. Add one to start.');

  // Editor for the active mask.
  const title = h('span', { className: 'mask-title' });
  const overlay = h('input', { type: 'checkbox', id: 'mask-overlay', onChange: () => st().setMaskOverlay(overlay.checked) });
  const outline = h('input', { type: 'checkbox', id: 'mask-outline', onChange: () => st().setMaskOutline(outline.checked) });
  const outlineLabel = h('span');
  const invert = h('input', {
    type: 'checkbox',
    id: 'mask-invert',
    onChange: () => activeId && st().updateMask(activeId, { invert: invert.checked }),
  });
  const feather = Slider({
    label: 'Feather',
    min: 0,
    max: 1,
    onChange: (v) => activeId && st().updateMask(activeId, { geo: { feather: v } }),
  });
  const sliders = MASK_ADJUSTMENTS.map((a) => ({
    key: a.key,
    slider: Slider({
      label: a.label,
      gradient: a.gradient,
      onChange: (v) => activeId && st().updateMask(activeId, { adj: { [a.key]: v } }),
    }),
  }));
  const gradientHint = h('p', { className: 'hint' }, 'Drag the handles on the photo to place it.');

  // Face masks: all faces, or some — chips with each face's thumbnail.
  const facesRow = h('div', { className: 'face-picks', role: 'group', 'aria-label': 'Faces this mask applies to' });
  const facesBox = h('div', { className: 'face-picker' }, h('div', { className: 'mask-adds-label' }, 'Faces'), facesRow);
  /** A small square crop of face `box` (normalized) from the photo's thumbnail. */
  const faceThumb = (box) => {
    const c = h('canvas', { className: 'face-thumb', width: 64, height: 64 });
    const bmp = getThumbBitmap(st().selectedId);
    if (!bmp) return c;
    const cx = ((box.x0 + box.x1) / 2) * bmp.width;
    const cy = ((box.y0 + box.y1) / 2) * bmp.height;
    const side = Math.max((box.x1 - box.x0) * bmp.width, (box.y1 - box.y0) * bmp.height) * 1.35;
    c.getContext('2d').drawImage(bmp, cx - side / 2, cy - side / 2, side, side, 0, 0, 64, 64);
    return c;
  };
  const renderFaces = (mask) => {
    const faces = getFaces(st().selectedId);
    facesBox.hidden = !isFaceMask(mask.type);
    if (facesBox.hidden) return;
    if (!faces) {
      facesRow.replaceChildren(h('span', { className: 'hint' }, faces === false ? 'No faces in this photo.' : 'Finding faces…'));
      return;
    }
    const picked = mask.faces;
    const all = picked == null;
    const chip = (label, on, title, onClick, thumb = null) =>
      h('button', { className: on ? 'face-chip on' : 'face-chip', title, 'aria-pressed': String(on), onClick }, thumb, h('span', {}, label));
    facesRow.replaceChildren(
      chip(faces.faces === 1 ? 'The face' : `All ${faces.faces} faces`, all, 'Apply to every face', () => st().setMaskFaces(mask.id, null)),
      ...(faces.faces > 1
        ? faces.boxes.map((box, i) => {
            const on = !all && picked.includes(i);
            return chip(
              String(i + 1),
              on,
              on ? `Face ${i + 1}: click to leave it out` : `Face ${i + 1}: click to include it`,
              () => {
                // From "all", picking a face means "just this one"; removing the last pick goes back to all.
                const next = all ? [i] : on ? picked.filter((f) => f !== i) : [...picked, i];
                st().setMaskFaces(mask.id, next.length ? next : null);
              },
              faceThumb(box),
            );
          })
        : []),
    );
  };
  const editor = h(
    'div',
    { className: 'mask-editor' },
    h('div', { className: 'mask-editor-head' }, title),
    h(
      'div',
      { className: 'mask-checks' },
      h('label', { htmlFor: 'mask-outline' }, outline, outlineLabel),
      h('label', { htmlFor: 'mask-overlay' }, overlay, ' Tint red'),
      h('label', { htmlFor: 'mask-invert' }, invert, ' Invert'),
    ),
    gradientHint,
    facesBox,
    feather.el,
    sliders.map((s) => s.slider.el),
  );

  const render = () => {
    const current = masks.find((m) => m.id === activeId) ?? null;
    empty.hidden = masks.length > 0;
    for (const b of addBtns) b.disabled = masks.length >= MAX_MASKS || !!st().busy;
    list.replaceChildren(
      ...masks.map((m, i) =>
        h(
          'li',
          { className: m.id === activeId ? 'mask-row active' : 'mask-row' },
          h(
            'button',
            { className: 'mask-pick', onClick: () => st().setActiveMask(m.id === activeId ? null : m.id), 'aria-pressed': String(m.id === activeId) },
            icon('mask', 14),
            `${i + 1}. ${maskLabel(m)}`,
          ),
          h(
            'button',
            { className: 'edit-delete', title: 'Delete this mask', 'aria-label': `Delete mask ${i + 1}`, onClick: () => st().removeMask(m.id) },
            icon('close', 12),
          ),
        ),
      ),
    );
    editor.hidden = !current;
    if (!current) return;
    title.textContent = `Editing: ${maskLabel(current)}`;
    overlay.checked = st().maskOverlay;
    outline.checked = st().maskOutline;
    const gradientMask = current.type === 'linear' || current.type === 'radial';
    outlineLabel.textContent = gradientMask ? ' Show handles' : ' Show outline';
    outline.parentElement.title = gradientMask
      ? 'Show or hide the gradient lines and handles on the photo'
      : 'Show or hide the traced edge of the selection on the photo';
    invert.checked = current.invert;
    gradientHint.hidden = !gradientMask || !outline.checked;
    feather.el.hidden = current.type !== 'radial';
    if (current.type === 'radial') feather.set(current.geo.feather);
    for (const { key, slider } of sliders) slider.set(current.adj[key] ?? 0);
    renderFaces(current);
  };

  bind(
    (s) => [s.activeMaskId, s.maskOverlay, s.maskOutline, s.busy, s.matteVersion],
    ([id]) => {
      activeId = id;
      render();
    },
  );

  const el = h(
    'div',
    { className: 'mask-panel' },
    h('div', { className: 'mask-adds' }, addBtns.slice(0, ADD.length)),
    h('div', { className: 'mask-adds-label' }, 'People'),
    h('div', { className: 'mask-adds' }, addBtns.slice(ADD.length)),
    list,
    empty,
    editor,
  );
  const update = (settings) => {
    const next = settings.masks ?? [];
    if (next === masks) return;
    masks = next;
    activeId = selectedImage(st())?.id ? st().activeMaskId : null;
    render();
  };
  return { el, update };
}
