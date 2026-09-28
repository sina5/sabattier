import { bind, h } from '../dom.js';
import { isNeutral } from '../engine/types.js';
import { icon } from '../icons.js';
import { FILTERS, passesFilter, store } from '../state/store.js';

/**
 * One frame of the film strip: edge print above (file name), the picture, and
 * edge print below (frame number and the half-frame mark, like "12A" on a
 * negative). Rebuilt only when its image entry or position changes.
 */
function Thumb(id) {
  const st = () => store.getState();
  const el = h('div', {
    className: 'thumb',
    role: 'button',
    tabIndex: 0,
    onClick: (e) => st().select(id, e.shiftKey ? 'range' : e.metaKey || e.ctrlKey ? 'toggle' : 'single'),
    onKeyDown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        st().select(id);
      }
    },
  });
  let last = null;
  let frame = -1;
  const update = (img, index) => {
    if (img === last && index === frame) return;
    last = img;
    frame = index;
    const n = index + 1;
    el.title = `${img.name}\nCtrl-click or Shift-click to pick several · 1–5 to rate · P pick · X reject`;
    el.classList.toggle('rejected', img.flag === 'reject');
    el.setAttribute('aria-label', img.name);
    const picture = h(
      'div',
      { className: 'thumb-image' },
      ...[
        img.thumbUrl
          ? h('img', { src: img.thumbUrl, alt: '', draggable: false })
          : img.status === 'error'
            ? h('div', { className: 'thumb-err', title: img.error }, "Can't open")
            : h('div', { className: 'spin' }, 'Loading…'),
        img.isRaw && h('span', { className: 'badge raw' }, 'RAW'),
        !isNeutral(img.settings) && h('span', { className: 'badge edited', title: 'Edited' }, icon('check', 12)),
        h(
          'button',
          {
            className: 'thumb-x',
            title: 'Remove from Sabattier (the file stays on disk)',
            'aria-label': `Remove ${img.name}`,
            onClick: (e) => {
              e.stopPropagation();
              st().removeImage(id);
            },
          },
          icon('close', 12),
        ),
      ].filter(Boolean),
    );
    el.replaceChildren(
      h('div', { className: 'edge-print top' }, h('span', { className: 'edge-name' }, img.name)),
      picture,
      h(
        'div',
        { className: 'edge-print bottom' },
        h('span', {}, `▸ ${n}`),
        img.flag
          ? h('span', { className: `flag-mark ${img.flag}`, title: img.flag === 'pick' ? 'Pick' : 'Rejected' }, icon(img.flag === 'pick' ? 'flag' : 'close', 11))
          : null,
        img.rating
          ? h('span', { className: 'stars', 'aria-label': `${img.rating} star${img.rating === 1 ? '' : 's'}` }, '★'.repeat(img.rating))
          : h('span', {}, `${n}A`),
      ),
    );
  };
  return { el, update };
}

export function Filmstrip() {
  const st = () => store.getState();
  // Select all ⇄ Deselect all, depending on whether every shown photo is picked.
  let allPicked = false;
  const selectAll = h(
    'button',
    { className: 'link-btn', onClick: () => (allPicked ? st().deselectAll() : st().selectAll()) },
    'Select all',
  );
  const picked = h('span', { className: 'filmstrip-picked' });
  const filter = h(
    'select',
    {
      className: 'select compact',
      'aria-label': 'Show',
      title: 'Show only some photos',
      onChange: () => st().setFilter(filter.value),
    },
    FILTERS.map((f) => h('option', { value: f.id }, f.label)),
  );
  const shownCount = h('span', { className: 'filmstrip-picked' });
  const mergeBtn = h(
    'button',
    {
      className: 'btn compact',
      'data-action': 'merge-hdr',
      title: 'Combine bracketed exposures of the same scene into one photo with detail in both shadows and highlights',
      onClick: () => void st().mergeHdr(),
    },
    icon('sparkle', 14),
    'Merge to HDR',
  );
  const emptyNote = h('div', { className: 'film-empty' }, 'No photos match this filter.');
  // The frames sit in a strip wrapper so the backing only spans the film itself.
  const film = h('div', { className: 'film' });
  const list = h('div', { className: 'filmstrip-list' }, film, emptyNote);
  const el = h(
    'div',
    { className: 'filmstrip' },
    h(
      'div',
      { className: 'filmstrip-head' },
      h('span', { className: 'filmstrip-title' }, 'Filmstrip'),
      h('span', { className: 'filmstrip-hint' }, 'Click to edit · Shift-click to pick several · ← → to step'),
      h('div', { className: 'spacer' }),
      picked,
      mergeBtn,
      shownCount,
      filter,
      selectAll,
    ),
    list,
  );
  const thumbs = new Map();
  let lastNodes = [];

  bind(
    (s) => [s.images, s.selectedId, s.selectedIds, s.filter, s.busy],
    ([images, selectedId, selectedIds, filterId, busy]) => {
      const n = selectedIds.length;
      mergeBtn.hidden = n < 2;
      mergeBtn.disabled = !!busy;
      picked.textContent = n > 1 ? `${n} selected` : '';
      filter.value = filterId;
      const shown = images.filter((i) => passesFilter(i, filterId));
      shownCount.textContent = filterId === 'all' ? '' : `${shown.length} of ${images.length}`;
      emptyNote.hidden = shown.length > 0;
      const picks = new Set(selectedIds);
      allPicked = shown.length > 1 && shown.every((i) => picks.has(i.id));
      selectAll.textContent = allPicked ? 'Deselect all' : 'Select all';
      selectAll.disabled = shown.length < 2;
      const frameOf = new Map(images.map((img, i) => [img.id, i]));
      // Frame numbers stay those of the full roll, so they don't shift as the filter changes.
      const nodes = shown.map((img) => {
        let t = thumbs.get(img.id);
        if (!t) thumbs.set(img.id, (t = Thumb(img.id)));
        t.update(img, frameOf.get(img.id));
        t.el.classList.toggle('selected', img.id === selectedId);
        t.el.classList.toggle('in-selection', n > 1 && picks.has(img.id));
        return t.el;
      });
      for (const id of thumbs.keys()) if (!frameOf.has(id)) thumbs.delete(id);
      // Slider drags change `images` on every tick; only touch the DOM order when it changed.
      if (nodes.length !== lastNodes.length || nodes.some((node, i) => node !== lastNodes[i])) {
        film.replaceChildren(...nodes);
        lastNodes = nodes;
      }
    },
  );
  return el;
}
