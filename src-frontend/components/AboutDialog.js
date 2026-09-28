import { h } from '../dom.js';
import { icon } from '../icons.js';
import { backend } from '../backend.js';
import { mountDialog } from './LicenseViewer.js';
import { showOpenSource } from './OpenSourceLicenses.js';

const REPO_URL = 'https://github.com/sina5/Sabattier';
export const SPONSOR_URL = 'https://github.com/sponsors/sina5';

/** The red heart that marks every sponsor link. */
export function heartIcon(size) {
  const el = icon('heart', size);
  el.classList.add('heart-icon');
  return el;
}

const linkRow = (iconEl, label, url, action) =>
  h(
    'div',
    { className: 'dialog-row' },
    iconEl,
    h('div', { className: 'row-text' }, h('span', { className: 'model-name' }, label), h('span', { className: 'model-desc about-url' }, url)),
    h('button', { className: 'btn', 'data-action': action, onClick: () => void backend.openLink(url) }, 'Open'),
  );

/** Top bar → About: who makes Sabattier, where the code lives, and how to support it. */
export function showAbout() {
  const version = h('span', {}, '');
  backend
    .appVersion()
    .then((v) => (version.textContent = v))
    .catch(() => {});

  mountDialog({
    title: 'Sabattier',
    subtitle: 'A fast, batch photo color editor for macOS and Windows.',
    className: 'about-dialog',
    body: [
      h(
        'div',
        { className: 'about-hero' },
        h('img', { className: 'about-icon', src: 'app-icon.png', alt: '' }),
        h(
          'dl',
          { className: 'license-meta' },
          h('dt', {}, 'Version'),
          h('dd', {}, version),
          h('dt', {}, 'Author'),
          h('dd', {}, 'Sina Fathi-Kazerooni'),
          h('dt', {}, 'License'),
          h('dd', {}, 'Apache License 2.0'),
        ),
      ),
      h(
        'div',
        { className: 'model-list' },
        linkRow(icon('file', 22), 'Source code', REPO_URL, 'open-repo'),
        linkRow(heartIcon(22), 'Support this project', SPONSOR_URL, 'open-sponsor'),
      ),
      h(
        'p',
        { className: 'hint' },
        'Sabattier is built on open-source software. ',
        h('button', { className: 'license-link', onClick: () => void showOpenSource() }, 'See the licenses'),
      ),
    ],
  });
}
