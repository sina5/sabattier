import { h } from '../dom.js';
import { bundledText, mountDialog, showText } from './LicenseViewer.js';

/**
 * Components that aren't Rust crates. ONNX Runtime is a native library the
 * `ort` crate links in statically; its version follows ort-sys.
 */
const COMPONENTS = [
  {
    name: 'ONNX Runtime 1.28.0',
    by: 'Microsoft · runs the AI models',
    license: 'MIT',
    texts: [
      ['License', 'licenses/onnxruntime-LICENSE.txt'],
      ['Third-party notices', 'licenses/onnxruntime-ThirdPartyNotices.txt'],
    ],
  },
  {
    name: 'SQLite 3.53.2',
    by: 'ratings catalog',
    license: 'Public domain',
    texts: [['Notice', 'licenses/sqlite-NOTICE.txt']],
  },
  {
    name: 'Barlow typeface',
    by: 'The Barlow Project Authors',
    license: 'SIL Open Font License 1.1',
    texts: [['License', 'fonts/OFL.txt']],
  },
];

const textLink = (label, onClick, attrs = {}) => h('button', { className: 'license-link', onClick, ...attrs }, label);

/** Settings → Open-source licenses: components, then every Rust crate by license text. */
export async function showOpenSource() {
  const components = h(
    'div',
    { className: 'model-list oss-list' },
    COMPONENTS.map((c) =>
      h(
        'div',
        { className: 'dialog-row' },
        h(
          'div',
          { className: 'row-text' },
          h('span', { className: 'model-name' }, c.name),
          h('span', { className: 'model-desc' }, `${c.by} · ${c.license}`),
        ),
        h(
          'span',
          { className: 'oss-links' },
          c.texts.map(([label, path]) =>
            textLink(label, () =>
              showText({ title: `${c.name}`, subtitle: `${label} · ${c.license}`, load: () => bundledText(path) }),
            ),
          ),
        ),
      ),
    ),
  );

  const filter = h('input', { className: 'text-input', type: 'search', placeholder: 'Filter by crate or license', 'aria-label': 'Filter crates' });
  const count = h('span', { className: 'model-desc' });
  const crates = h('div', { className: 'model-list oss-list tall' }, h('p', { className: 'hint' }, 'Loading…'));
  const note = h(
    'p',
    { className: 'hint' },
    'The AI models’ licenses are listed under AI models in Settings. The app’s window uses the system web view (WebKit on macOS, WebView2 on Windows), which is part of the operating system and not shipped with Sabattier.',
  );

  mountDialog({
    title: 'Open-source licenses',
    subtitle: 'Sabattier is built with this open-source software. Thank you to its authors.',
    className: 'oss-dialog',
    body: [
      h('div', { className: 'dialog-label' }, 'Components'),
      components,
      h('div', { className: 'oss-crates-head' }, h('div', { className: 'dialog-label' }, 'Rust crates (including Tauri)'), count),
      filter,
      crates,
      note,
    ],
  });

  let data;
  try {
    data = JSON.parse(await bundledText('licenses/third-party.json'));
  } catch (err) {
    crates.replaceChildren(h('p', { className: 'hint' }, `The crate list couldn't be loaded (${err.message ?? err}).`));
    return;
  }
  const render = () => {
    const q = filter.value.trim().toLowerCase();
    const groups = data.licenses
      .map((l) => ({ l, shown: q && !l.id.toLowerCase().includes(q) ? l.crates.filter((c) => c.name.toLowerCase().includes(q)) : l.crates }))
      .filter((g) => g.shown.length);
    const n = new Set(groups.flatMap((g) => g.shown.map((c) => `${c.name}@${c.version}`))).size;
    count.textContent = q ? `${n} of ${data.crateCount} crates` : `${data.crateCount} crates`;
    crates.replaceChildren(
      ...(groups.length
        ? groups.map(({ l, shown }) =>
            h(
              'div',
              { className: 'dialog-row oss-group' },
              h(
                'div',
                { className: 'row-text' },
                h('span', { className: 'model-name' }, l.name),
                h('span', { className: 'model-desc oss-crates' }, shown.map((c) => `${c.name} ${c.version}`).join(', ')),
              ),
              textLink(
                'License text',
                () =>
                  showText({
                    title: l.name,
                    subtitle: `Used by ${l.crates.length} crate${l.crates.length === 1 ? '' : 's'}`,
                    meta: [['Crates', l.crates.map((c) => `${c.name} ${c.version}`).join(', ')]],
                    load: async () => l.text,
                  }),
                { 'data-license-group': l.id },
              ),
            ),
          )
        : [h('p', { className: 'hint' }, 'No crates match.')]),
    );
  };
  filter.addEventListener('input', render);
  render();
}
