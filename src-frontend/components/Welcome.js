import { h } from '../dom.js';
import { icon } from '../icons.js';
import { store } from '../state/store.js';

/** First screen, shown while no photos are loaded. */
export function Welcome() {
  const st = () => store.getState();
  const step = (n, title, text) =>
    h(
      'div',
      { className: 'welcome-step' },
      h('span', { className: 'welcome-step-n' }, String(n)),
      h('div', {}, h('div', { className: 'welcome-step-title' }, title), h('div', { className: 'welcome-step-text' }, text)),
    );

  return h(
    'main',
    { className: 'welcome' },
    h(
      'div',
      { className: 'dropzone' },
      h('div', { className: 'dropzone-icon' }, icon('image', 36)),
      h('div', { className: 'dropzone-title' }, 'Drag photos or a folder here'),
      h(
        'div',
        { className: 'dropzone-actions' },
        h('button', { className: 'btn primary large', onClick: () => st().importFiles() }, 'Choose photos'),
        h('button', { className: 'btn large', onClick: () => st().importFolder() }, 'Choose a folder'),
      ),
      h(
        'div',
        { className: 'dropzone-formats' },
        'JPEG, PNG, TIFF and RAW files from most cameras (CR2, CR3, NEF, ARW, DNG and more)',
      ),
    ),
    h(
      'section',
      { className: 'welcome-steps', 'aria-label': 'How it works' },
      step(1, 'Add your photos', 'Bring in a few shots or a whole folder.'),
      step(2, 'Fix light and color', 'One click with Auto enhance, or adjust by hand.'),
      step(3, 'Save them all', 'Save every photo at once. Originals are never touched.'),
    ),
    h(
      'footer',
      { className: 'welcome-privacy' },
      icon('lock', 16),
      'Everything happens on your computer — your photos are never uploaded.',
    ),
  );
}
