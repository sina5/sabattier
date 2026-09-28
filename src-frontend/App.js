import { bind, h } from './dom.js';
import { ExportDialog, ExportOverlay } from './components/ExportDialog.js';
import { SettingsDialog } from './components/SettingsDialog.js';
import { ConfirmEditDelete } from './components/ConfirmEditDelete.js';
import { Filmstrip } from './components/Filmstrip.js';
import { Preview } from './components/Preview.js';
import { SupportNote } from './components/SupportNote.js';
import { Toast } from './components/Toast.js';
import { TopBar } from './components/TopBar.js';
import { Welcome } from './components/Welcome.js';
import { AdjustPanel } from './components/panel/AdjustPanel.js';
import { store } from './state/store.js';

export function App() {
  const st = () => store.getState();
  void st().loadPresets();

  // Undo/redo keyboard shortcuts
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    const key = e.key.toLowerCase();
    if (key === 'z') {
      e.preventDefault();
      if (e.shiftKey) st().redo();
      else st().undo();
    } else if (key === 'y') {
      e.preventDefault();
      st().redo();
    }
  });

  // Culling keys, Lightroom-style: 0–5 rate, P pick, X reject, U unflag,
  // ←/→ step through the photos the filter shows.
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    const s = st();
    if (!s.images.length || s.exportDialogOpen || s.settingsOpen || s.pendingEditDelete) return;
    const key = e.key.toLowerCase();
    if (/^[0-5]$/.test(key)) s.setRating(Number(key));
    else if (key === 'p') s.setFlag('pick');
    else if (key === 'x') s.setFlag('reject');
    else if (key === 'u') s.setFlag(null);
    else if (key === 'arrowright') s.step(1);
    else if (key === 'arrowleft') s.step(-1);
    else return;
    e.preventDefault();
  });

  const dropHint = h('div', { className: 'drop-hint', hidden: true }, h('span', {}, 'Drop to add photos'));

  // Tauri intercepts OS file drops (HTML5 drop events carry no paths in a
  // webview) and reports them, with real file paths, as webview events.
  window.__TAURI__.webview.getCurrentWebview().onDragDropEvent(({ payload }) => {
    const over = payload.type === 'enter' || payload.type === 'over';
    dropHint.hidden = !over;
    if (payload.type === 'drop' && payload.paths.length) void st().importPaths(payload.paths);
  });

  const welcome = Welcome();
  const workspace = h(
    'div',
    { className: 'body' },
    h(
      'div',
      { className: 'stage' },
      h('div', { className: 'stage-view' }, Preview(), Toast()),
      Filmstrip(),
    ),
    AdjustPanel(),
  );

  bind(
    (s) => s.images.length > 0,
    (hasPhotos) => {
      welcome.hidden = hasPhotos;
      workspace.hidden = !hasPhotos;
    },
  );

  return h('div', { className: 'app' }, TopBar(), welcome, workspace, dropHint, ExportDialog(), ExportOverlay(), SettingsDialog(), ConfirmEditDelete(), SupportNote());
}
