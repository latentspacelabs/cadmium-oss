import path from 'path';
import { getAppPath, getLocale } from '@/platform';

const { I18n } = require('i18n');

let localesPath;
try {
  const isPackaged = getAppPath().includes('app.asar');
  if (isPackaged) {
    localesPath = path.join(process.resourcesPath, 'locales');
  } else {
    localesPath = path.join(getAppPath(), '..', 'locales');
  }
} catch (e) {
  // Fallback in unusual dev contexts
  localesPath = path.join(process.cwd(), 'locales');
}

export const i18n = new I18n({
  locales: ['en', 'ja'],
  directory: localesPath,
});

// Set locale consistently with the main i18n instance
const currentLocale = getLocale();
i18n.setLocale(currentLocale.startsWith('ja') ? 'ja' : 'en');
// i18n.setLocale('ja');

export const foo = 123;
