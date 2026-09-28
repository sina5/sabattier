import { backend } from '../backend.js';
import { pickBackup, restoreBackup, saveBackup } from '../state/backup.js';
import { showLicense } from './LicenseViewer.js';
import { showOpenSource } from './OpenSourceLicenses.js';
import { bind, h } from '../dom.js';
import { icon } from '../icons.js';
import { store } from '../state/store.js';
import { getTheme, onThemeChange, setTheme } from '../theme.js';

const THEME_OPTIONS = [
  { id: 'dark', label: 'Dark', icon: 'moon' },
  { id: 'light', label: 'Light', icon: 'sun' },
  { id: 'system', label: 'System', icon: 'monitor' },
];

/** Editing behaviour: for now, whether removing an edit asks first. */
function EditingSettings() {
  const st = () => store.getState();
  const box = h('input', {
    type: 'checkbox',
    id: 'setting-confirm-delete',
    onChange: (e) => st().setConfirmEditDelete(e.target.checked),
  });
  bind(
    (s) => s.confirmEditDelete,
    (on) => {
      box.checked = on;
    },
  );
  return h(
    'section',
    { className: 'settings-group' },
    h('h3', { className: 'group-title' }, 'Editing'),
    h(
      'div',
      { className: 'check-row' },
      box,
      h(
        'label',
        { htmlFor: 'setting-confirm-delete' },
        h('span', { className: 'settings-label' }, 'Ask before removing an edit'),
        h('span', { className: 'hint' }, 'Show a confirmation when you press the red button in the edit list.'),
      ),
    ),
  );
}

/** Whether heavy work (HDR merge, RAW development, AI tools) uses every CPU core. */
function PerformanceSettings() {
  const st = () => store.getState();
  const box = h('input', {
    type: 'checkbox',
    id: 'setting-multicore',
    onChange: (e) => st().setMulticore(e.target.checked),
  });
  bind(
    (s) => s.multicore,
    (on) => {
      box.checked = on;
    },
  );
  const cores = navigator.hardwareConcurrency;
  return h(
    'section',
    { className: 'settings-group' },
    h('h3', { className: 'group-title' }, 'Performance'),
    h(
      'div',
      { className: 'check-row' },
      box,
      h(
        'label',
        { htmlFor: 'setting-multicore' },
        h('span', { className: 'settings-label' }, cores ? `Use all CPU cores (${cores})` : 'Use all CPU cores'),
        h(
          'span',
          { className: 'hint' },
          'HDR merge, opening RAW photos and the AI tools run much faster. Turn off to keep other apps responsive while they work.',
        ),
      ),
    ),
  );
}

/** Where saved looks (presets) are stored: the app's own presets folder, or one the user picks. */
function PresetsLocation() {
  const st = () => store.getState();
  let defaultDir = '';
  const path = h('span', { className: 'row-value folder-path' });
  const badge = h('span', { className: 'row-label' });
  const useDefault = h('button', { className: 'btn ghost', onClick: () => void st().setPresetsDir(null) }, 'Use default');
  const change = h(
    'button',
    {
      className: 'btn',
      onClick: async () => {
        const dir = await backend.openFolder('Choose a folder for presets');
        if (dir) await st().setPresetsDir(dir);
      },
    },
    'Change…',
  );

  const sync = (dir) => {
    const shown = dir || defaultDir;
    path.textContent = shown;
    path.title = shown;
    badge.textContent = dir ? 'Save presets in (custom folder)' : 'Save presets in (app folder, default)';
    useDefault.hidden = !dir;
  };
  bind((s) => s.presetsDir, sync);
  void backend.defaultPresetsLocation().then((d) => {
    defaultDir = d;
    sync(st().presetsDir);
  });

  return h(
    'section',
    { className: 'settings-group' },
    h('h3', { className: 'group-title' }, 'Presets'),
    h(
      'div',
      { className: 'dialog-row' },
      icon('folder', 22),
      h('div', { className: 'row-text' }, badge, path),
      useDefault,
      change,
    ),
    h(
      'p',
      { className: 'hint' },
      'If the folder you pick already has Sabattier presets, those are used. Otherwise your current presets are copied there.',
    ),
  );
}

const mb = (bytes) => (bytes < 1e6 ? `${Math.max(1, Math.round(bytes / 1e3))} KB` : `${Math.round(bytes / 1e6)} MB`);

/**
 * The ML models: what each is for, its size, and whether it is downloaded.
 * Models download on first use; deleting one frees the space until then.
 */
function ModelSettings() {
  // A scrolling box, so a growing list of models doesn't stretch the dialog.
  const list = h('div', { className: 'model-list', role: 'list', 'aria-label': 'AI models' });
  const total = h('p', { className: 'hint' });
  const refresh = async () => {
    let models;
    try {
      models = await backend.modelsList();
    } catch (err) {
      list.replaceChildren(h('p', { className: 'hint' }, `Couldn't list models: ${err}`));
      return;
    }
    list.replaceChildren(
      ...models.map((m) =>
        h(
          'div',
          { className: 'dialog-row' },
          icon('sparkle', 22),
          h(
            'div',
            { className: 'row-text' },
            h('span', { className: 'model-name' }, m.name),
            h(
              'span',
              { className: 'model-desc' },
              `${m.purpose} · ${mb(m.bytes)} · `,
              h(
                'button',
                {
                  className: 'license-link',
                  title: `Read the ${m.license} license`,
                  'data-license': m.id,
                  onClick: () => void showLicense(m),
                },
                m.license,
              ),
            ),
          ),
          m.installed
            ? h(
                'button',
                {
                  className: 'btn ghost',
                  title: 'Delete the file; it downloads again the next time you use this tool',
                  onClick: async () => {
                    await backend.modelDelete(m.id).catch((err) => store.getState().notify(`Couldn't delete: ${err}`));
                    void refresh();
                  },
                },
                'Delete',
              )
            : h('span', { className: 'model-state' }, 'Downloads when first used'),
        ),
      ),
    );
    const used = models.filter((m) => m.installed).reduce((a, m) => a + m.bytes, 0);
    total.textContent = used
      ? `${mb(used)} on disk. Models run on this computer; your photos never leave it.`
      : 'Nothing downloaded yet. Models run on this computer; your photos never leave it.';
  };
  bind((s) => s.settingsOpen, (open) => open && void refresh());
  return h('section', { className: 'settings-group' }, h('h3', { className: 'group-title' }, 'AI models'), list, total);
}

/**
 * Back up settings, presets and ratings to one file, or restore them. A
 * restore shows what the backup holds and asks before replacing anything.
 */
function BackupSettings() {
  let pending = null;
  const status = h('p', { className: 'hint', role: 'status' });
  const summary = h('p', { className: 'backup-summary' });
  const confirmRow = h(
    'div',
    { className: 'backup-confirm' },
    summary,
    h(
      'div',
      { className: 'backup-actions' },
      h('button', { className: 'btn ghost', onClick: () => setPending(null) }, 'Cancel'),
      h('button', { className: 'btn primary', 'data-action': 'confirm-restore', onClick: () => void doRestore() }, 'Replace with backup'),
    ),
  );
  const setPending = (p) => {
    pending = p;
    confirmRow.hidden = !p;
    if (!p) return;
    const d = p.data;
    const when = new Date(d.createdAt).toLocaleString();
    summary.textContent =
      `Backup from ${when}: ${d.presets.length} preset${d.presets.length === 1 ? '' : 's'}, ` +
      `${d.catalog.length} rated or flagged photo${d.catalog.length === 1 ? '' : 's'}, and app settings. ` +
      'Restoring replaces your current settings, presets and ratings.';
  };
  setPending(null);

  const doBackup = async () => {
    status.textContent = 'Saving backup…';
    try {
      const path = await saveBackup();
      status.textContent = path ? `Backup saved to ${path}` : '';
    } catch (err) {
      status.textContent = `Couldn't save the backup: ${err.message ?? err}`;
    }
  };
  const doPick = async () => {
    status.textContent = '';
    try {
      setPending(await pickBackup());
    } catch (err) {
      setPending(null);
      status.textContent = err.message ?? String(err);
    }
  };
  const doRestore = async () => {
    const p = pending;
    setPending(null);
    status.textContent = 'Restoring…';
    try {
      await restoreBackup(p.data);
      status.textContent = 'Restored. Settings, presets and ratings now match the backup.';
    } catch (err) {
      status.textContent = `Couldn't restore: ${err.message ?? err}. Nothing was changed.`;
    }
  };

  // Each time Settings opens, start clean: no stale message or pending restore.
  bind(
    (s) => s.settingsOpen,
    (open) => {
      if (!open) return;
      setPending(null);
      status.textContent = '';
    },
  );

  return h(
    'section',
    { className: 'settings-group' },
    h('h3', { className: 'group-title' }, 'Backup & restore'),
    h(
      'div',
      { className: 'dialog-row' },
      icon('shield', 22),
      h(
        'div',
        { className: 'row-text' },
        h('span', { className: 'row-label' }, 'Settings, presets and ratings'),
        h('span', { className: 'row-value' }, 'Saved together in one file'),
      ),
      h('button', { className: 'btn', 'data-action': 'backup', onClick: () => void doBackup() }, 'Back up…'),
      h('button', { className: 'btn', 'data-action': 'restore', onClick: () => void doPick() }, 'Restore…'),
    ),
    confirmRow,
    status,
  );
}

/** App settings; each group goes under its own heading. */
export function SettingsDialog() {
  const st = () => store.getState();
  const close = () => st().setSettingsOpen(false);

  const themeButtons = THEME_OPTIONS.map((t) =>
    h(
      'button',
      { className: 'theme-option', role: 'radio', 'data-theme-option': t.id, onClick: () => setTheme(t.id) },
      icon(t.icon, 22),
      t.label,
    ),
  );
  const syncTheme = (choice) => {
    THEME_OPTIONS.forEach((t, i) => {
      themeButtons[i].classList.toggle('selected', t.id === choice);
      themeButtons[i].setAttribute('aria-checked', String(t.id === choice));
    });
  };
  syncTheme(getTheme());
  onThemeChange(syncTheme);

  const card = h(
    'div',
    { className: 'dialog settings', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'settings-title', onClick: (e) => e.stopPropagation() },
    h(
      'div',
      { className: 'dialog-head' },
      h('h2', { id: 'settings-title' }, 'Settings'),
      h('button', { className: 'icon-btn', 'aria-label': 'Close', onClick: close }, icon('close', 20)),
    ),
    h(
      'section',
      { className: 'settings-group' },
      h('h3', { className: 'group-title' }, 'Appearance'),
      h('div', { className: 'settings-label', id: 'theme-label' }, 'Theme'),
      h('div', { className: 'theme-options', role: 'radiogroup', 'aria-labelledby': 'theme-label' }, themeButtons),
      h('p', { className: 'hint' }, 'System follows your computer’s light or dark mode.'),
    ),
    EditingSettings(),
    PerformanceSettings(),
    PresetsLocation(),
    BackupSettings(),
    ModelSettings(),
    h(
      'section',
      { className: 'settings-group' },
      h('h3', { className: 'group-title' }, 'Open-source licenses'),
      h(
        'div',
        { className: 'dialog-row' },
        icon('file', 22),
        h(
          'div',
          { className: 'row-text' },
          h('span', { className: 'model-name' }, 'Software Sabattier is built with'),
          h('span', { className: 'model-desc' }, 'Tauri, ONNX Runtime, SQLite, the Rust crates and the Barlow font'),
        ),
        h('button', { className: 'btn', 'data-action': 'open-source', onClick: () => void showOpenSource() }, 'View…'),
      ),
    ),
  );
  const el = h('div', { className: 'overlay', onClick: close }, card);

  window.addEventListener('keydown', (e) => {
    if (!el.hidden && e.key === 'Escape') close();
  });
  bind(
    (s) => s.settingsOpen,
    (open) => {
      el.hidden = !open;
    },
  );
  return el;
}
