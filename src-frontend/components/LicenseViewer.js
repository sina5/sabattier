import { h } from '../dom.js';
import { icon } from '../icons.js';

/**
 * A text dialog over whatever is open (Settings): a title, a subtitle, label /
 * value rows, and a text loaded by `load()`. Escape closes only this dialog.
 */
export async function showText({ title, subtitle, meta = [], load }) {
  const text = h('pre', { className: 'license-text' }, 'Loading…');
  const body = [meta.length > 0 && h('dl', { className: 'license-meta' }, meta.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])), text];
  mountDialog({ title, subtitle, body, className: 'license-dialog' });
  try {
    text.textContent = await load();
  } catch (err) {
    text.textContent = `The license text couldn't be loaded (${err.message ?? err}).`;
  }
}

/**
 * Put a dialog (title, subtitle, body nodes) over everything else. These can
 * stack — Settings, the license list, a license text — and Escape closes only
 * the topmost. Returns its close function.
 */
export function mountDialog({ title, subtitle, body, className = '' }) {
  const opener = document.activeElement;
  const close = () => {
    window.removeEventListener('keydown', onKey, true);
    el.remove();
    opener?.focus?.();
  };
  const onKey = (e) => {
    if (e.key !== 'Escape' || document.body.lastElementChild !== el) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    close();
  };
  const closeBtn = h('button', { className: 'icon-btn', 'aria-label': 'Close', onClick: close }, icon('close', 20));
  const titleId = `dlg-${Math.random().toString(36).slice(2)}`;
  const card = h(
    'div',
    { className: `dialog ${className}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, onClick: (e) => e.stopPropagation() },
    h('div', { className: 'dialog-head' }, h('div', {}, h('h2', { id: titleId }, title), subtitle && h('p', { className: 'dialog-sub' }, subtitle)), closeBtn),
    body,
  );
  const el = h('div', { className: 'overlay license-overlay', onClick: close }, card);
  window.addEventListener('keydown', onKey, true);
  document.body.append(el);
  closeBtn.focus();
  return close;
}

/** A bundled file under licenses/ (or another app path), as text. */
export async function bundledText(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(String(res.status));
  return res.text();
}

/** A model's license (a models_list entry: name, license, source, url, license_file). */
export function showLicense(model) {
  return showText({
    title: `${model.license} license`,
    subtitle: model.name,
    meta: [
      ['Project', model.source],
      ['Model file', model.url],
    ],
    load: () => bundledText(`licenses/${model.license_file}`),
  });
}
