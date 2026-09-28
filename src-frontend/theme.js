// App theme: the user's choice ('dark' | 'light' | 'system') is remembered in
// localStorage; the resolved theme is set as <html data-theme="…"> for styles.css.
const KEY = 'sabattier.theme';
export const THEMES = ['dark', 'light', 'system'];

const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set();

function load() {
  try {
    const saved = localStorage.getItem(KEY);
    return THEMES.includes(saved) ? saved : 'system';
  } catch {
    return 'system';
  }
}

let choice = load();

function apply() {
  const dark = choice === 'dark' || (choice === 'system' && systemDark.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

/** The stored choice, not the resolved theme. */
export function getTheme() {
  return choice;
}

export function setTheme(next) {
  if (!THEMES.includes(next)) return;
  choice = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // the choice still applies for this session
  }
  apply();
  for (const fn of listeners) fn(choice);
}

export function onThemeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

systemDark.addEventListener('change', () => {
  if (choice === 'system') apply();
});

apply();
