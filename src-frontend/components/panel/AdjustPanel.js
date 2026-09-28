import { bind, h } from '../../dom.js';
import { MIXER_BANDS, defaultSettings } from '../../engine/types.js';
import { icon } from '../../icons.js';
import { selectedImage, store } from '../../state/store.js';
import { HistogramView } from '../HistogramView.js';
import { ColorWheel } from './ColorWheel.js';
import { CurveEditor } from './CurveEditor.js';
import { MaskPanel } from './MaskPanel.js';
import { EditList } from './EditList.js';
import { Slider } from './Slider.js';
import { Toggle } from './Toggle.js';

const set = (patch) => store.getState().updateSettings(patch);
const MODE_KEY = 'sabattier.panelMode';

function loadMode() {
  try {
    return localStorage.getItem(MODE_KEY) === 'fine' ? 'fine' : 'quick';
  } catch {
    return 'quick';
  }
}

function saveMode(mode) {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // remembering the tab is a convenience only
  }
}

/**
 * Fine-tune section: a header that expands/collapses it, an on/off switch and
 * a reset button. Switching a section on also opens it; while it is off the
 * body stays visible but dimmed.
 */
function Section({ title, subtitle, enabledKey, reset, open = false }, ...children) {
  let expanded = open;
  const chevron = icon('chevron', 16);
  const headBtn = h(
    'button',
    { className: 'section-toggle', onClick: () => setExpanded(!expanded) },
    chevron,
    h('span', { className: 'section-titles' }, h('span', { className: 'title' }, title), h('span', { className: 'sub' }, subtitle)),
  );
  const toggle = Toggle((v) => {
    set({ [enabledKey]: v });
    if (v) setExpanded(true);
  });
  toggle.el.setAttribute('aria-label', `${title} on or off`);
  const resetBtn = h('button', { className: 'icon-btn', title: `Reset ${title}`, 'aria-label': `Reset ${title}`, onClick: () => set(reset()) }, icon('reset', 16));
  const body = h('div', { className: 'section-body' }, children);
  const el = h('section', { className: 'section' }, h('div', { className: 'section-head' }, headBtn, resetBtn, toggle.el), body);

  const setExpanded = (v) => {
    expanded = v;
    body.hidden = !v;
    el.classList.toggle('open', v);
    headBtn.setAttribute('aria-expanded', String(v));
  };
  setExpanded(open);

  const update = (settings) => {
    const on = settings[enabledKey];
    toggle.set(on);
    body.classList.toggle('off', !on);
  };
  return { el, update };
}

/** A slider bound to one numeric setting; `enabledKey` switches its section on when it is used. */
function field(label, key, opts = {}) {
  const { enabledKey, ...sliderOpts } = opts;
  const slider = Slider({
    label,
    onChange: (v) => set(enabledKey ? { [key]: v, [enabledKey]: true } : { [key]: v }),
    ...sliderOpts,
  });
  return { el: slider.el, update: (s) => slider.set(s[key]) };
}

/** A color wheel bound to one wheel setting. */
function wheel(label, key) {
  const w = ColorWheel(label, (v) => set({ [key]: v }));
  return { el: w.el, update: (s) => w.set(s[key]) };
}

/** Large one-click action: icon, title and a plain-language subtitle. */
function FixButton(iconName, onClick) {
  const title = h('span', { className: 'fix-title' });
  const sub = h('span', { className: 'fix-sub' });
  const el = h(
    'button',
    { className: 'fix', onClick },
    h('span', { className: 'fix-icon' }, icon(iconName, 20)),
    h('span', { className: 'fix-text' }, title, sub),
  );
  const setText = (t, s) => {
    title.textContent = t;
    sub.textContent = s;
  };
  return { el, setText };
}

/** Saved presets as chips: click to apply, × to delete, plus "Save this look". */
function Looks() {
  const st = () => store.getState();
  const chips = h('div', { className: 'looks' });

  const nameInput = h('input', {
    className: 'text-input',
    placeholder: 'Name this look',
    'aria-label': 'Look name',
    onKeyDown: (e) => {
      if (e.key === 'Enter') void commit();
      if (e.key === 'Escape') setNaming(false);
    },
  });
  const commit = async () => {
    const name = nameInput.value.trim();
    if (name) await st().savePreset(name);
    setNaming(false);
  };
  const naming = h(
    'div',
    { className: 'looks-naming' },
    nameInput,
    h('button', { className: 'btn primary', onClick: commit }, 'Save'),
    h('button', { className: 'btn ghost', onClick: () => setNaming(false) }, 'Cancel'),
  );
  const addBtn = h('button', { className: 'look add', onClick: () => setNaming(true) }, '+ Save this look');
  const hint = h('div', { className: 'hint' });

  const setNaming = (on) => {
    naming.hidden = !on;
    chips.hidden = on;
    nameInput.value = '';
    if (on) nameInput.focus();
  };
  setNaming(false);

  bind(
    (s) => [s.presets, s.selectedIds.length],
    ([presets, selectedCount]) => {
      const target = selectedCount > 1 ? `the ${selectedCount} selected photos` : 'this photo';
      chips.replaceChildren(
        ...presets.map((p) =>
          h(
            'span',
            { className: 'look' },
            h('button', { className: 'look-apply', title: `Apply “${p.name}” to ${target}`, onClick: () => st().applyPreset(p.name) }, p.name),
            h(
              'button',
              { className: 'look-x', title: `Delete “${p.name}”`, 'aria-label': `Delete look ${p.name}`, onClick: () => void st().deletePreset(p.name) },
              icon('close', 12),
            ),
          ),
        ),
        addBtn,
      );
      hint.textContent = presets.length
        ? `Click a look to apply it to ${target}.`
        : 'Save your edits as a look to reuse them on other photos.';
    },
  );

  return h('div', { className: 'looks-wrap' }, chips, naming, hint);
}

/** CSS color for a hue in degrees at the given lightness (%). */
const hsl = (deg, l = 55, sat = 80) => `hsl(${((deg % 360) + 360) % 360} ${sat}% ${l}%)`;

/**
 * Color mixer: Hue / Saturation / Luminance tabs, one slider per hue band,
 * each rail painted with what the slider does to that band.
 */
function ColorMixer() {
  const MODES = [
    { id: 'hue', label: 'Hue' },
    { id: 'sat', label: 'Saturation' },
    { id: 'lum', label: 'Luminance' },
  ];
  let mode = 'hue';
  let mixer = null;
  const railFor = (m, deg) =>
    m === 'hue'
      ? `linear-gradient(90deg, ${hsl(deg - 30)}, ${hsl(deg)}, ${hsl(deg + 30)})`
      : m === 'sat'
        ? `linear-gradient(90deg, ${hsl(deg, 55, 0)}, ${hsl(deg, 55, 90)})`
        : `linear-gradient(90deg, ${hsl(deg, 20)}, ${hsl(deg, 55)}, ${hsl(deg, 85)})`;
  const sets = MODES.map((m) =>
    MIXER_BANDS.map((b, i) =>
      Slider({
        label: b.label,
        gradient: railFor(m.id, b.center),
        onChange: (v) => {
          const next = { ...mixer, [m.id]: mixer[m.id].map((x, k) => (k === i ? v : x)) };
          set({ mixer: next, mixerEnabled: true });
        },
      }),
    ),
  );
  const panes = sets.map((sliders) => h('div', { className: 'mixer-pane' }, sliders.map((sl) => sl.el)));
  const tabs = MODES.map((m) => h('button', { className: 'seg-btn', onClick: () => setMode(m.id) }, m.label));
  const setMode = (id) => {
    mode = id;
    MODES.forEach((m, i) => {
      panes[i].hidden = m.id !== mode;
      tabs[i].classList.toggle('active', m.id === mode);
      tabs[i].setAttribute('aria-pressed', String(m.id === mode));
    });
  };
  setMode('hue');
  const el = h('div', { className: 'mixer' }, h('div', { className: 'seg', role: 'group', 'aria-label': 'Mixer mode' }, tabs), panes);
  const update = (s) => {
    mixer = s.mixer;
    MODES.forEach((m, i) => sets[i].forEach((sl, k) => sl.set(mixer[m.id][k])));
    // Mark tabs whose sliders are in use.
    MODES.forEach((m, i) => tabs[i].classList.toggle('edited', mixer[m.id].some((v) => v !== 0)));
  };
  return { el, update };
}

/**
 * Lens blur: amount, focus distance (auto until picked) and focus range. The
 * depth map is measured the first time the amount goes above zero.
 */
function LensBlur() {
  const st = () => store.getState();
  const amount = Slider({
    label: 'Blur amount',
    min: 0,
    max: 1,
    onChange: (v) => {
      set({ lensBlur: v, lensEnabled: true });
      if (v > 0) st().prepareModels();
    },
  });
  const focus = Slider({
    label: 'Focus distance',
    min: 0,
    max: 1,
    ends: ['Far', 'Near'],
    onChange: (v) => set({ lensFocus: v, lensEnabled: true }),
    onReset: () => set({ lensFocus: null }),
  });
  const range = Slider({ label: 'Focus range', min: 0, max: 1, onChange: (v) => set({ lensRange: v, lensEnabled: true }) });
  const pick = h('button', { className: 'btn outline wide', onClick: () => st().requestFocusPick() }, icon('eye'), 'Pick focus on the photo');
  const autoNote = h('div', { className: 'hint' });
  const el = h('div', { className: 'lens' }, amount.el, pick, focus.el, range.el, autoNote);
  const update = (s) => {
    amount.set(s.lensBlur);
    focus.set(s.lensFocus ?? 0.5);
    range.set(s.lensRange);
    autoNote.textContent =
      s.lensFocus == null
        ? 'Focus is automatic (the nearest main subject) until you pick a point or move Focus distance.'
        : 'Double-click Focus distance to go back to automatic focus.';
  };
  return { el, update };
}

const group = (title, ...children) => h('section', { className: 'group' }, h('h3', { className: 'group-title' }, title), children.flat());

export function AdjustPanel() {
  const st = () => store.getState();
  const d = defaultSettings();
  const bound = [];

  // ---- Quick tab ----
  const autoFix = FixButton('sparkle', () => st().autoEnhanceSelected());
  autoFix.el.classList.add('primary');
  autoFix.setText('Auto enhance', 'Fixes light and color for you');
  const bgFix = FixButton('cutout', () => st().removeBackgroundSelected());
  const cropFix = FixButton('crop', () => st().requestCrop());
  cropFix.el.dataset.action = 'crop';
  const healFix = FixButton('heal', () => st().requestHeal());
  healFix.el.dataset.action = 'heal';
  healFix.setText('Remove spots', 'Paint over dust, blemishes or small objects');

  // Portrait: one-click face retouching, each adding an editable face mask.
  const portrait = [
    ['smooth', 'Smooth skin', 'Softens skin texture, keeps eyes, brows and lips sharp'],
    ['eyes', 'Brighten eyes', 'A little light and clarity in the eyes'],
    ['teeth', 'Whiten teeth', 'Takes the yellow out of teeth'],
  ].map(([kind, title, sub]) => {
    const b = FixButton('cutout', () => void st().portraitAction(kind));
    b.setText(title, sub);
    b.el.dataset.action = `portrait-${kind}`;
    return b;
  });

  const quickFields = [
    field('Brightness', 'exposure', { ends: ['Darker', 'Brighter'], enabledKey: 'basicEnabled' }),
    field('Warmth', 'temperature', { ends: ['Cooler', 'Warmer'], gradient: 'temperature', enabledKey: 'wbEnabled' }),
    field('Color intensity', 'saturation', { ends: ['Muted', 'Vivid'], enabledKey: 'hslEnabled' }),
  ];
  bound.push(...quickFields);

  const quickPane = h(
    'div',
    { className: 'pane' },
    group('One-click fixes', autoFix.el, bgFix.el, cropFix.el, healFix.el),
    group('Portrait', portrait.map((b) => b.el)),
    group('Simple adjustments', quickFields.map((f) => f.el)),
    group('Saved looks', Looks()),
    h(
      'button',
      { className: 'more-card', onClick: () => setMode('fine') },
      h(
        'span',
        { className: 'fix-text' },
        h('span', { className: 'fix-title' }, 'Want more control?'),
        h('span', { className: 'fix-sub' }, 'Fine-tune has every slider and color wheel.'),
      ),
      icon('chevron'),
    ),
  );

  // ---- Fine-tune tab ----
  const section = (opts, ...fields) => {
    const s = Section(opts, ...fields.map((f) => f.el));
    bound.push(s, ...fields);
    return s.el;
  };
  const wheels = [wheel('Shadows', 'cbShadows'), wheel('Midtones', 'cbMidtones'), wheel('Highlights', 'cbHighlights')];
  const balance = Section(
    {
      title: 'Color balance',
      subtitle: 'Tint shadows, midtones and highlights',
      enabledKey: 'cbEnabled',
      reset: () => ({ cbShadows: { ...d.cbShadows }, cbMidtones: { ...d.cbMidtones }, cbHighlights: { ...d.cbHighlights } }),
    },
    h('div', { className: 'wheels' }, wheels.map((w) => w.el)),
  );
  bound.push(balance, ...wheels);

  const finePane = h(
    'div',
    { className: 'pane' },
    h(
      'section',
      { className: 'group' },
      HistogramView(),
      h('div', { className: 'hint' }, 'Tip: drag on the graph to brighten or darken just that part of the photo.'),
    ),
    section(
      {
        title: 'Light',
        subtitle: 'Exposure, shadows and contrast',
        enabledKey: 'basicEnabled',
        open: true,
        reset: () => ({ exposure: 0, highlights: 0, shadows: 0, brightness: 0, contrast: 0, blackPoint: 0 }),
      },
      field('Exposure', 'exposure', { enabledKey: 'basicEnabled' }),
      field('Highlights', 'highlights', { enabledKey: 'basicEnabled' }),
      field('Shadows', 'shadows', { enabledKey: 'basicEnabled' }),
      field('Brightness', 'brightness', { enabledKey: 'basicEnabled' }),
      field('Contrast', 'contrast', { enabledKey: 'basicEnabled' }),
      field('Whites', 'whites', { enabledKey: 'basicEnabled' }),
      field('Black point', 'blackPoint', { enabledKey: 'basicEnabled' }),
    ),
    section(
      {
        title: 'Tone curve',
        subtitle: 'Shape brightness and each color channel',
        enabledKey: 'curveEnabled',
        reset: () => ({ curve: structuredClone(d.curve) }),
      },
      CurveEditor((curve) => set({ curve, curveEnabled: true })),
    ),
    section(
      {
        title: 'White balance',
        subtitle: 'Make colors warmer or cooler',
        enabledKey: 'wbEnabled',
        open: true,
        reset: () => ({ temperature: 0, tint: 0 }),
      },
      field('Temperature', 'temperature', { gradient: 'temperature', enabledKey: 'wbEnabled' }),
      field('Tint', 'tint', { gradient: 'tint', enabledKey: 'wbEnabled' }),
    ),
    section(
      {
        title: 'Color',
        subtitle: 'How vivid colors look',
        enabledKey: 'hslEnabled',
        open: true,
        reset: () => ({ hue: 0, saturation: 0, vibrance: 0 }),
      },
      field('Saturation', 'saturation', { enabledKey: 'hslEnabled' }),
      field('Vibrance', 'vibrance', { enabledKey: 'hslEnabled' }),
      field('Hue', 'hue', { enabledKey: 'hslEnabled' }),
    ),
    section(
      {
        title: 'Color mixer',
        subtitle: 'Shift, boost or darken single colors',
        enabledKey: 'mixerEnabled',
        reset: () => ({ mixer: structuredClone(d.mixer) }),
      },
      ColorMixer(),
    ),
    balance.el,
    section(
      {
        title: 'Effects',
        subtitle: 'Texture, clarity, dehaze, vignette, grain',
        enabledKey: 'fxEnabled',
        reset: () => ({ texture: 0, clarity: 0, dehaze: 0, vignette: 0, grain: 0, grainSize: 0 }),
      },
      field('Texture', 'texture', { enabledKey: 'fxEnabled' }),
      field('Clarity', 'clarity', { enabledKey: 'fxEnabled' }),
      field('Dehaze', 'dehaze', { enabledKey: 'fxEnabled' }),
      field('Vignette', 'vignette', { min: 0, max: 1, enabledKey: 'fxEnabled' }),
      field('Grain', 'grain', { min: 0, max: 1, enabledKey: 'fxEnabled' }),
      field('Grain size', 'grainSize', { min: 0, max: 1, enabledKey: 'fxEnabled' }),
    ),
    section(
      {
        title: 'Lens blur',
        subtitle: 'Blur the background by depth',
        enabledKey: 'lensEnabled',
        reset: () => ({ lensBlur: 0, lensFocus: null, lensRange: d.lensRange }),
      },
      LensBlur(),
    ),
    section(
      { title: 'Detail', subtitle: 'Sharpen fine edges', enabledKey: 'detailEnabled', reset: () => ({ sharpen: 0 }) },
      field('Sharpening', 'sharpen', { min: 0, max: 1, enabledKey: 'detailEnabled' }),
      { el: h('div', { className: 'hint' }, 'Judge sharpening at 100% zoom.'), update: () => {} },
    ),
    section(
      {
        title: 'Masks',
        subtitle: 'Edit just the subject, sky or one area',
        enabledKey: 'masksEnabled',
        reset: () => ({ masks: [] }),
      },
      MaskPanel(),
    ),
  );

  // ---- Tabs ----
  const tab = (mode, label) =>
    h('button', { className: 'tab', role: 'tab', 'data-mode': mode, onClick: () => setMode(mode) }, label);
  const quickTab = tab('quick', 'Quick');
  const fineTab = tab('fine', 'Fine-tune');
  const setMode = (mode) => {
    const fine = mode === 'fine';
    quickPane.hidden = fine;
    finePane.hidden = !fine;
    quickTab.setAttribute('aria-selected', String(!fine));
    fineTab.setAttribute('aria-selected', String(fine));
    saveMode(mode);
  };
  setMode(loadMode());

  const copyAll = h('button', { className: 'btn outline wide', onClick: () => st().applyToAll() }, icon('copy'), h('span'));

  const el = h(
    'aside',
    { className: 'panel' },
    h(
      'div',
      { className: 'panel-header' },
      h(
        'div',
        { className: 'panel-title-row' },
        h('h2', {}, 'Edit photo'),
        h('button', { className: 'link-btn', title: 'Undo every adjustment on this photo', onClick: () => st().resetSelected() }, 'Reset photo'),
      ),
      h('div', { className: 'tabs', role: 'tablist', 'aria-label': 'Editing mode' }, quickTab, fineTab),
    ),
    h('div', { className: 'panel-scroll' }, h('div', { className: 'pane edits-pane' }, EditList()), quickPane, finePane),
    h('div', { className: 'panel-footer' }, copyAll),
  );

  bind(
    (s) => [selectedImage(s), s.busy, s.images.length],
    ([item, busy, count]) => {
      const settings = item?.settings ?? defaultSettings();
      const disabled = !item;
      el.classList.toggle('disabled', disabled);
      autoFix.el.disabled = disabled || !!busy;
      bgFix.el.disabled = disabled || !!busy;
      cropFix.el.disabled = disabled;
      healFix.el.disabled = disabled || !!busy;
      for (const b of portrait) b.el.disabled = disabled || !!busy;
      bgFix.setText(
        settings.bgRemoved ? 'Restore background' : 'Remove background',
        settings.bgRemoved ? 'Bring back the original background' : 'Keeps the subject, saves as PNG',
      );
      cropFix.setText(settings.crop ? 'Change crop' : 'Crop', 'Square, 4:5 for social, 16:9 and more');
      copyAll.disabled = disabled || count < 2;
      copyAll.lastChild.textContent = `Copy these edits to all ${count} photos`;
      for (const b of bound) b.update(settings);
    },
  );
  return el;
}
