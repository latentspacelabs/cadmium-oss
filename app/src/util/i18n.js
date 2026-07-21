import { app } from 'electron';
import path from 'path';

const { I18n } = require('i18n');

let localesPath;
const isPackaged = app.getAppPath().includes('app.asar');
if (isPackaged) {
  localesPath = path.join(process.resourcesPath, 'locales');
} else {
  localesPath = path.join(app.getAppPath(), '..', 'locales');
}

export const i18n = new I18n({
  locales: ['en', 'ja'],
  directory: localesPath,
});

export function menuSetLocale() {
  // Set locale consistently with the main i18n instance
  const currentLocale = app.getLocale();
  i18n.setLocale(currentLocale.startsWith('ja') ? 'ja' : 'en');
}

export const foo = 123;
