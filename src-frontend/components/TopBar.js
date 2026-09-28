import { bind, h } from '../dom.js';
import { isNeutral } from '../engine/types.js';
import { icon } from '../icons.js';
import { store } from '../state/store.js';
import { showAbout } from './AboutDialog.js';

export function TopBar() {
  const s = () => store.getState();
  const btn = (iconName, label, onClick, props = {}) =>
    h('button', { className: 'btn', onClick, ...props }, icon(iconName), label);

  const addPhotos = btn('plus', 'Add photos', () => s().importFiles());
  const addFolder = btn('folder', 'Add folder', () => s().importFolder());
  const undo = btn('undo', 'Undo', () => s().undo(), { className: 'btn ghost', title: 'Undo (Ctrl+Z)' });
  const redo = btn('redo', 'Redo', () => s().redo(), { className: 'btn ghost', title: 'Redo (Ctrl+Shift+Z)' });
  const status = h('div', { className: 'topbar-status', role: 'status' });
  const autoAll = btn('sparkle', 'Auto enhance all', () => s().autoEnhanceAll(), {
    title: 'Fix light and color on every photo, each based on its own histogram',
  });
  const exportAll = btn('save', '', () => s().setExportDialogOpen(true), { className: 'btn primary' });
  const exportLabel = h('span');
  exportAll.append(exportLabel);

  const workspaceOnly = h(
    'div',
    { className: 'topbar-tools' },
    addPhotos,
    addFolder,
    h('div', { className: 'vsep' }),
    undo,
    redo,
    status,
    autoAll,
    exportAll,
  );

  bind(
    (st) => [st.canUndo, st.canRedo, st.busy, st.images],
    ([canUndo, canRedo, busyText, images]) => {
      const count = images.length;
      workspaceOnly.hidden = count === 0;
      undo.disabled = !canUndo;
      redo.disabled = !canRedo;
      const edited = images.filter((i) => !isNeutral(i.settings)).length;
      status.textContent = busyText ?? `${count} photo${count === 1 ? '' : 's'} · ${edited} edited`;
      status.classList.toggle('busy', !!busyText);
      autoAll.disabled = !count || !!busyText;
      exportAll.disabled = !count || !!busyText;
      exportLabel.textContent = `Save ${count} photo${count === 1 ? '' : 's'}`;
    },
  );

  const settingsBtn = h(
    'button',
    { className: 'icon-btn', title: 'Settings', 'aria-label': 'Settings', onClick: () => s().setSettingsOpen(true) },
    icon('settings', 20),
  );

  const aboutBtn = h(
    'button',
    { className: 'icon-btn', title: 'About Sabattier', 'aria-label': 'About Sabattier', 'data-action': 'about', onClick: showAbout },
    icon('info', 20),
  );

  return h(
    'header',
    { className: 'topbar' },
    h('div', { className: 'brand' }, h('img', { className: 'brand-mark', src: 'app-icon.png', alt: '' }), 'Sabattier'),
    workspaceOnly,
    h('div', { className: 'topbar-end' }, aboutBtn, settingsBtn),
  );
}
