// Shared i18next setup for BOTH Electron processes (main + renderer share
// modules in this app: nodeIntegration is on and both bundles include src/).
//
// The catalogs are bundled (require'd) into each bundle, so init is fully
// synchronous (initImmediate: false) and nothing reads locale files from disk
// at runtime. `npm run i18n:extract` (i18next-parser) is the only writer of
// locales/*.json, and only at development time.
//
// Locale selection:
// - Renderer: adopts the OS locale immediately via getLocale() from
//   '@/platform' (lazy require + try/catch so jest, which has no Electron
//   host, falls back to English).
// - Main process: starts as 'en'; background.js calls menuSetLocale() on app
//   'ready' (app.getLocale() only has a real value after ready) — the same
//   contract as the previous i18n module.
import i18next from 'i18next';

const resources = {
  // eslint-disable-next-line global-require
  en: { translation: require('../../locales/en.json') },
  // eslint-disable-next-line global-require
  ja: { translation: require('../../locales/ja.json') },
};

function normalizeLocale(locale) {
  return String(locale || '').startsWith('ja') ? 'ja' : 'en';
}

function detectInitialLocale() {
  if (typeof process !== 'undefined' && process.type === 'browser') {
    // Main process: locale is adopted later via menuSetLocale().
    return 'en';
  }
  try {
    // eslint-disable-next-line global-require
    const { getLocale } = require('@/platform');
    return normalizeLocale(getLocale());
  } catch (e) {
    // No Electron host (unit tests) — English.
    return 'en';
  }
}

i18next.init({
  // Resources are bundled and no async backend is involved, so make init
  // (and changeLanguage) synchronous.
  initImmediate: false,
  lng: detectInitialLocale(),
  fallbackLng: 'en',
  resources,
  // Keys are natural-English sentences; '.' and ':' are literal text, never
  // nesting or namespace separators.
  keySeparator: false,
  nsSeparator: false,
  // ja.json carries '' for untranslated keys — fall back to en/the key
  // instead of rendering an empty string.
  returnEmptyString: false,
  // Translations go into native menus/dialogs and Vue text interpolation,
  // never into raw HTML, so HTML-escaping would only corrupt them.
  interpolation: { escapeValue: false },
});

// Bound translate function — safe to import anywhere and to expose to Vue
// templates (components put `t` on their data/computed surface).
export const t = i18next.t.bind(i18next);

// Adopt the OS locale in the main process. Must be called after app 'ready'
// (background.js does so), when app.getLocale() has a real value.
export function menuSetLocale() {
  // eslint-disable-next-line global-require
  const { app } = require('electron');
  i18next.changeLanguage(normalizeLocale(app.getLocale()));
}

export default i18next;
