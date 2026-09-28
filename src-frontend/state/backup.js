// Backup and restore of everything Sabattier keeps between sessions — app
// settings, presets, and the ratings/flags catalog — as one JSON file.
import { backend } from '../backend.js';
import { setTheme } from '../theme.js';
import { store } from './store.js';

const PREFIX = 'sabattier.';
/** Machine-specific: a folder path that may not exist on another computer. */
const NOT_BACKED_UP = new Set(['sabattier.presetsDir']);
const VERSION = 1;

function readSettings() {
  const out = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(PREFIX) && !NOT_BACKED_UP.has(key)) out[key] = localStorage.getItem(key);
    }
  } catch {
    // no stored settings to back up
  }
  return out;
}

/** Build the backup object from the current state. */
export async function createBackup() {
  return {
    app: 'Sabattier',
    kind: 'backup',
    version: VERSION,
    createdAt: new Date().toISOString(),
    settings: readSettings(),
    presets: store.getState().presets,
    catalog: await backend.catalogExport(),
  };
}

/** Ask where to save, then write the backup. Returns the path, or null if cancelled. */
export async function saveBackup() {
  const day = new Date().toISOString().slice(0, 10);
  const path = await backend.saveDialog('Save a backup', `sabattier-backup-${day}.json`);
  if (!path) return null;
  const json = JSON.stringify(await createBackup(), null, 1);
  await backend.writeFile(path, new TextEncoder().encode(json));
  return path;
}

/** Parse and check a backup file; throws a readable message if it isn't one. */
export function parseBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('This file is not a Sabattier backup (it is not valid JSON).');
  }
  if (data?.app !== 'Sabattier' || data.kind !== 'backup') throw new Error('This file is not a Sabattier backup.');
  if (data.version > VERSION) throw new Error('This backup was made by a newer version of Sabattier.');
  const ok =
    data.settings && typeof data.settings === 'object' &&
    Array.isArray(data.presets) && data.presets.every((p) => typeof p?.name === 'string' && p.settings) &&
    Array.isArray(data.catalog) && data.catalog.every((e) => typeof e?.path === 'string' && Number.isInteger(e.rating));
  if (!ok) throw new Error('This backup is damaged or incomplete.');
  return data;
}

/** Pick a backup file and read it; null if cancelled. */
export async function pickBackup() {
  const path = await backend.openFile('Restore from a backup', [{ name: 'Sabattier backup', extensions: ['json'] }]);
  if (!path) return null;
  const bytes = await backend.readFile(path);
  return { path, data: parseBackup(new TextDecoder().decode(bytes)) };
}

/**
 * Replace settings, presets and ratings with the backup's, applying them
 * right away (no restart, open photos stay). Order: catalog first — the one
 * step that can fail on disk — so a failure leaves everything else as it was.
 */
export async function restoreBackup(data) {
  const st = store.getState();
  await backend.catalogImport(data.catalog.map((e) => ({ path: e.path, rating: e.rating, flag: e.flag ?? null })));
  await st.reloadCulling();

  await st.setPresets(data.presets);

  try {
    for (const key of Object.keys(readSettings())) localStorage.removeItem(key);
    for (const [key, value] of Object.entries(data.settings)) {
      if (key.startsWith(PREFIX) && !NOT_BACKED_UP.has(key) && typeof value === 'string') localStorage.setItem(key, value);
    }
  } catch {
    // settings still apply below for this session
  }
  const get = (k) => data.settings[PREFIX + k];
  if (get('theme')) setTheme(get('theme'));
  st.setConfirmEditDelete(get('confirmEditDelete') !== 'false');
  st.setMulticore(get('multicore') !== 'false');
  st.reloadExportPrefs();
}
