import { bind, h } from '../dom.js';
import { backend } from '../backend.js';
import { icon } from '../icons.js';
import { decodeImage } from '../decode/decode.js';
import { FORMATS, drawWatermark } from '../engine/export.js';
import { getThumbBitmap, store, visibleImages } from '../state/store.js';
import { Toggle } from './panel/Toggle.js';

const SIZES = [
  { label: 'Original size', value: null },
  { label: 'Long edge 4096 px', value: 4096 },
  { label: 'Long edge 2048 px', value: 2048 },
  { label: 'Long edge 1600 px', value: 1600 },
  { label: 'Long edge 1024 px', value: 1024 },
];

/** What the photos are for; `custom` reveals the quality and size pickers. */
const PURPOSES = [
  {
    id: 'best',
    title: 'Best quality',
    sub: 'Full size, excellent quality. Great for printing and keeping.',
    detail: 'Full size',
    quality: 0.95,
    maxDim: null,
  },
  {
    id: 'share',
    title: 'Sharing online',
    sub: 'Smaller files for email, chat and social media.',
    detail: '2048 px',
    quality: 0.9,
    maxDim: 2048,
  },
  { id: 'custom', title: 'Custom', sub: 'Choose the quality and size yourself.', detail: '' },
];

const plural = (n) => `${n} photo${n === 1 ? '' : 's'}`;

const FORMAT_NOTES = {
  jpeg: 'Smallest files, works everywhere.',
  png: 'Lossless and keeps transparency. Large files.',
  webp: 'Small files for the web; keeps transparency.',
  tiff: 'Lossless, for printing and further editing. Largest files.',
};

const POSITIONS = [
  { id: 'tl', label: '↖', title: 'Top left' },
  { id: 'tr', label: '↗', title: 'Top right' },
  { id: 'c', label: '●', title: 'Center' },
  { id: 'bl', label: '↙', title: 'Bottom left' },
  { id: 'br', label: '↘', title: 'Bottom right' },
];

/** Segmented control: one button per option, `value` marks the active one. */
function Segmented(options, onPick, label) {
  const btns = options.map((o) =>
    h('button', { className: 'seg-btn', title: o.title ?? '', onClick: () => onPick(o.id) }, o.label),
  );
  const el = h('div', { className: 'seg', role: 'group', 'aria-label': label }, btns);
  const set = (value) =>
    options.forEach((o, i) => {
      btns[i].classList.toggle('active', o.id === value);
      btns[i].setAttribute('aria-pressed', String(o.id === value));
    });
  return { el, set };
}

/** Range input bound to a 0..1 watermark setting. */
function Range(label, onInput) {
  const input = h('input', { type: 'range', min: '0', max: '1', step: '0.01', className: 'range', onInput: () => onInput(Number(input.value)) });
  const el = h('label', { className: 'range-row' }, h('span', {}, label), input);
  return { el, set: (v) => (input.value = String(v)) };
}

export function ExportDialog() {
  const st = () => store.getState();
  let dir = '';
  let purpose = 'best';

  const close = () => st().setExportDialogOpen(false);

  const title = h('h2', { id: 'export-title' });
  const cards = PURPOSES.map((p) =>
    h(
      'button',
      {
        className: 'purpose',
        onClick: () => {
          purpose = p.id;
          syncPurpose();
        },
      },
      h('span', { className: 'radio' }),
      h('span', { className: 'fix-text' }, h('span', { className: 'fix-title' }, p.title), h('span', { className: 'fix-sub' }, p.sub)),
      h('span', { className: 'purpose-detail' }, p.detail),
    ),
  );

  const quality = h(
    'select',
    { className: 'select', id: 'export-quality', onChange: () => st().setQuality(Number(quality.value)) },
    h('option', { value: '1' }, '100 · Maximum'),
    h('option', { value: '0.95' }, '95 · Excellent (recommended)'),
    h('option', { value: '0.9' }, '90 · Very good'),
    h('option', { value: '0.85' }, '85 · Good, smaller files'),
  );
  const size = h(
    'select',
    { className: 'select', id: 'export-size' },
    SIZES.map((s) => h('option', { value: s.value === null ? '' : String(s.value) }, s.label)),
  );
  const custom = h(
    'div',
    { className: 'custom-grid' },
    h('div', { className: 'field' }, h('label', { htmlFor: 'export-quality' }, 'Quality'), quality),
    h('div', { className: 'field' }, h('label', { htmlFor: 'export-size' }, 'Size'), size),
  );

  // AI upscale applies with any purpose; it replaces the size limit.
  const upscaleSel = h(
    'select',
    {
      className: 'select',
      id: 'export-upscale',
      onChange: () => st().setExportPrefs({ upscale: Number(upscaleSel.value) }),
    },
    h('option', { value: '0' }, 'Off'),
    h('option', { value: '2' }, '2× (AI)'),
    h('option', { value: '4' }, '4× (AI)'),
  );
  const upscaleNote = h('p', { className: 'hint' });
  const upscaleRow = h(
    'div',
    { className: 'upscale-row' },
    h('div', { className: 'field' }, h('label', { htmlFor: 'export-upscale' }, 'Upscale'), upscaleSel),
    upscaleNote,
  );

  const syncPurpose = () => {
    PURPOSES.forEach((p, i) => {
      cards[i].classList.toggle('selected', p.id === purpose);
      cards[i].setAttribute('aria-pressed', String(p.id === purpose));
    });
    custom.hidden = purpose !== 'custom';
  };
  syncPurpose();

  const folderPath = h('span', { className: 'row-value folder-path' });
  const folderBtn = h(
    'button',
    {
      className: 'btn',
      onClick: async () => {
        const chosen = await backend.openFolder('Choose where to save');
        if (chosen) setDir(chosen);
      },
    },
    'Choose…',
  );

  // ---- Format ----
  const prefs = () => st().exportPrefs;
  const formatSeg = Segmented(
    Object.entries(FORMATS).map(([id, f]) => ({ id, label: f.label })),
    (format) => st().setExportPrefs({ format }),
    'File format',
  );
  const formatNote = h('p', { className: 'hint' });

  // ---- Watermark ----
  const wm = () => prefs().watermark;
  const setWm = (patch) => st().setExportPrefs({ watermark: patch });
  const wmToggle = Toggle((on) => setWm({ enabled: on }));
  wmToggle.el.setAttribute('aria-label', 'Add a watermark');
  const kindSeg = Segmented(
    [
      { id: 'text', label: 'Text' },
      { id: 'image', label: 'Logo image' },
    ],
    (kind) => setWm({ kind }),
    'Watermark type',
  );
  const wmText = h('input', {
    className: 'text-input',
    placeholder: '© Your name',
    'aria-label': 'Watermark text',
    onInput: () => setWm({ text: wmText.value }),
  });
  const logoName = h('span', { className: 'row-value folder-path' });
  const logoBtn = h(
    'button',
    {
      className: 'btn',
      onClick: async () => {
        const path = await backend.openImage('Choose a logo');
        if (path) setWm({ imagePath: path });
      },
    },
    'Choose…',
  );
  const logoRow = h('div', { className: 'wm-logo' }, logoName, logoBtn);
  const colorSeg = Segmented(
    [
      { id: 'white', label: 'White' },
      { id: 'black', label: 'Black' },
    ],
    (color) => setWm({ color }),
    'Text color',
  );
  const posSeg = Segmented(POSITIONS, (position) => setWm({ position }), 'Position');
  const sizeRange = Range('Size', (size) => setWm({ size }));
  const opacityRange = Range('Opacity', (opacity) => setWm({ opacity }));
  const wmPreview = h('canvas', { className: 'wm-preview', width: 240, height: 160 });
  const wmBody = h(
    'div',
    { className: 'wm-body' },
    h(
      'div',
      { className: 'wm-controls' },
      kindSeg.el,
      wmText,
      logoRow,
      h('div', { className: 'wm-line' }, posSeg.el, colorSeg.el),
      sizeRange.el,
      opacityRange.el,
    ),
    wmPreview,
  );

  // Preview the mark on the selected photo's thumbnail. The logo is decoded
  // once per path.
  let logo = null;
  let logoPath = '';
  const drawPreview = async () => {
    const w = wm();
    if (!w.enabled) return;
    if (w.kind === 'image' && w.imagePath && w.imagePath !== logoPath) {
      logoPath = w.imagePath;
      logo = await decodeImage(w.imagePath).catch(() => null);
    }
    // Fit the photo inside a 240×180 box, so portrait photos stay short.
    const thumb = getThumbBitmap(st().selectedId);
    const k = thumb ? Math.min(240 / thumb.width, 180 / thumb.height) : 1;
    const cw = thumb ? Math.max(1, Math.round(thumb.width * k)) : 240;
    const chh = thumb ? Math.max(1, Math.round(thumb.height * k)) : 160;
    if (wmPreview.width !== cw) wmPreview.width = cw;
    if (wmPreview.height !== chh) wmPreview.height = chh;
    const ctx = wmPreview.getContext('2d');
    ctx.fillStyle = '#555';
    ctx.fillRect(0, 0, cw, chh);
    if (thumb) ctx.drawImage(thumb, 0, 0, cw, chh);
    drawWatermark(ctx, cw, chh, w, w.kind === 'image' ? logo : null);
  };

  const syncPrefs = () => {
    const p = prefs();
    const w = p.watermark;
    formatSeg.set(p.format);
    upscaleSel.value = String(p.upscale);
    upscaleNote.textContent = p.upscale
      ? `Enlarges each photo ${p.upscale}× with detail rebuilt by AI, up to 8192 px. Runs on this computer and is slow: roughly a minute per megapixel. Replaces the size setting.`
      : 'Make photos larger with detail rebuilt by AI, e.g. small or cropped photos for print.';
    formatNote.textContent = FORMAT_NOTES[p.format];
    custom.querySelector('#export-quality').closest('.field').hidden = !FORMATS[p.format].lossy;
    wmToggle.set(w.enabled);
    wmBody.hidden = !w.enabled;
    kindSeg.set(w.kind);
    if (document.activeElement !== wmText) wmText.value = w.text;
    wmText.hidden = w.kind !== 'text';
    colorSeg.el.hidden = w.kind !== 'text';
    logoRow.hidden = w.kind !== 'image';
    logoName.textContent = w.imagePath ? w.imagePath.split(/[\\/]/).pop() : 'No image chosen';
    posSeg.set(w.position);
    sizeRange.set(w.size);
    opacityRange.set(w.opacity);
    void drawPreview();
    syncExample();
  };

  // ---- Which photos ----
  const onlyShown = h('input', { type: 'checkbox', id: 'export-only-shown', onChange: () => syncCounts() });
  const onlyShownLabel = h('label', { htmlFor: 'export-only-shown' });
  const scopeRow = h('div', { className: 'scope-row' }, onlyShown, onlyShownLabel);

  let sampleStem = 'IMG_0001';
  const exampleSuffix = h('span', { className: 'accent-text' });
  const exampleName = h('span', { className: 'row-value' });
  const suffix = h('input', {
    className: 'text-input narrow',
    id: 'export-suffix',
    value: '-edited',
    placeholder: 'optional',
    onInput: () => {
      suffix.value = suffix.value.replace(/[\\/:*?"<>|]/g, '');
      syncExample();
    },
  });
  const syncExample = () => {
    exampleSuffix.textContent = suffix.value;
    exampleName.replaceChildren(sampleStem, exampleSuffix, `.${FORMATS[prefs().format].ext}`);
  };

  const saveBtn = h('button', {
    className: 'btn primary large',
    onClick: () => {
      const p = PURPOSES.find((x) => x.id === purpose);
      const custom = purpose === 'custom';
      void st().exportAll({
        dir,
        quality: custom ? st().quality : p.quality,
        maxDim: custom ? (size.value ? Number(size.value) : null) : p.maxDim,
        suffix: suffix.value,
        onlyShown: !scopeRow.hidden && onlyShown.checked,
      });
    },
  });
  const saveLabel = h('span');
  saveBtn.append(icon('save'), saveLabel);

  const setDir = (d) => {
    dir = d;
    folderPath.textContent = dir || 'No folder chosen yet';
    folderPath.title = dir;
    folderBtn.textContent = dir ? 'Change…' : 'Choose…';
    saveBtn.disabled = !dir;
    saveBtn.title = dir ? '' : 'Choose a folder first';
  };
  setDir('');

  const card = h(
    'div',
    { className: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'export-title', onClick: (e) => e.stopPropagation() },
    h(
      'div',
      { className: 'dialog-head' },
      h('div', {}, title, h('p', { className: 'dialog-sub' }, 'Your originals stay exactly as they are. Sabattier saves new copies.')),
      h('button', { className: 'icon-btn', 'aria-label': 'Close', onClick: close }, icon('close', 20)),
    ),
    h('div', { className: 'dialog-label' }, 'What are they for?'),
    h('div', { className: 'purposes' }, cards),
    h('div', { className: 'dialog-label' }, 'File format'),
    formatSeg.el,
    formatNote,
    custom,
    upscaleRow,
    scopeRow,
    h(
      'div',
      { className: 'dialog-rows' },
      h(
        'div',
        { className: 'dialog-row' },
        icon('folder', 22),
        h('div', { className: 'row-text' }, h('span', { className: 'row-label' }, 'Save to'), folderPath),
        folderBtn,
      ),
      h(
        'div',
        { className: 'dialog-row' },
        icon('file', 22),
        h('div', { className: 'row-text' }, h('label', { className: 'row-label', htmlFor: 'export-suffix' }, 'File names'), exampleName),
        suffix,
      ),
      h(
        'div',
        { className: 'dialog-row wm-row' },
        icon('image', 22),
        h('div', { className: 'row-text' }, h('span', { className: 'row-label' }, 'Watermark'), h('span', { className: 'row-value' }, 'Text or a logo on every photo')),
        wmToggle.el,
      ),
      wmBody,
    ),
    h(
      'div',
      { className: 'note' },
      icon('shield', 18),
      h(
        'span',
        {},
        'Nothing gets overwritten — if a file already exists, the new one gets a number. ' +
          'Photos with the background removed are saved as PNG when JPEG is chosen, to keep them transparent.',
      ),
    ),
    h('div', { className: 'dialog-actions' }, h('button', { className: 'btn ghost large', onClick: close }, 'Cancel'), saveBtn),
  );
  const el = h('div', { className: 'overlay', onClick: close }, card);

  window.addEventListener('keydown', (e) => {
    if (!el.hidden && e.key === 'Escape') close();
  });

  const syncCounts = () => {
    const s = st();
    const filtered = s.filter !== 'all';
    const shown = visibleImages(s).filter((i) => i.status !== 'error');
    const all = s.images.filter((i) => i.status !== 'error');
    scopeRow.hidden = !filtered;
    onlyShownLabel.textContent = `Only the ${plural(shown.length)} the filmstrip filter shows`;
    const ready = filtered && onlyShown.checked ? shown : all;
    title.textContent = `Save ${plural(ready.length)}`;
    saveLabel.textContent = `Save ${plural(ready.length)}`;
    sampleStem = (ready[0]?.name ?? 'IMG_0001.jpg').replace(/\.[^.]+$/, '');
    syncExample();
  };

  bind(
    (s) => [s.exportDialogOpen, s.images, s.quality, s.filter],
    ([open, , q, filter]) => {
      const opening = open && el.hidden;
      el.hidden = !open;
      // A filter in use is a good hint for what to save; default to it on open.
      if (opening) onlyShown.checked = filter !== 'all';
      syncCounts();
      quality.value = String(q);
      if (opening) syncPrefs();
    },
  );
  bind((s) => s.exportPrefs, syncPrefs);
  return el;
}

/** Progress card shown while saving, and briefly once it completes. */
export function ExportOverlay() {
  const heading = h('h2');
  const file = h('div', { className: 'file' });
  const bar = h('div');
  const el = h(
    'div',
    { className: 'overlay' },
    h('div', { className: 'dialog progress-card', role: 'status' }, heading, file, h('div', { className: 'progress' }, bar)),
  );
  bind(
    (s) => s.exporting,
    (exporting) => {
      el.hidden = !exporting;
      if (!exporting) return;
      const done = exporting.done >= exporting.total;
      heading.textContent = done ? 'All done' : `Saving ${exporting.done + 1} of ${exporting.total}`;
      file.textContent = done
        ? `${plural(exporting.total)} saved`
        : exporting.detail
          ? `${exporting.current} · ${exporting.detail}`
          : exporting.current;
      bar.style.width = `${(exporting.done / Math.max(1, exporting.total)) * 100}%`;
    },
  );
  return el;
}
