// Configuration for `npm run i18n:extract` (i18next-parser).
//
// Scans every static t('...') call in src/ (JS and Vue SFCs, script and
// template sections) and rewrites locales/{en,ja}.json in place: en maps each
// key to itself, ja keeps its existing translations and gains '' for new /
// untranslated keys (harmless at runtime — the i18n module sets
// returnEmptyString: false, so '' falls back to English).
//
// keepRemoved is deliberate: dynamic keys (e.g. t(action) in util/modal.js,
// where action is 'colorizing' / 'preprocessing' / 'analyzing', and the text
// props RoundButton passes through t()) are invisible to static extraction
// and must survive a re-run. Don't hand-prune "unused" keys without checking.
const path = require('path');

// i18next-parser v9 dropped its VueLexer, and its JavascriptLexer, while
// error-tolerant enough to chew through a whole SFC, silently loses keys in
// the process (e.g. text inside a nested <template v-if>). So: compose a Vue
// lexer from the parts — parse the <script> block as plain JS, and compile
// the <template> block (vue-template-compiler, already a devDependency of
// this Vue 2 app) into render code, which turns every mustache/binding
// expression into real JS the JavascriptLexer can walk.
//
// The parser's dist is ESM-only; this config is CJS. Node >= 20.19 supports
// require(esm) for synchronous graphs, and loading by absolute file path
// sidesteps the package's exports map.
// eslint-disable-next-line import/no-dynamic-require
const JavascriptLexer = require(path.join(
  __dirname,
  'node_modules/i18next-parser/dist/lexers/javascript-lexer.js',
)).default;
// eslint-disable-next-line import/no-extraneous-dependencies
const vueCompiler = require('vue-template-compiler');

class Vue2SfcLexer extends JavascriptLexer {
  extract(content, filename) {
    let keys = [];
    const script = content.match(/<script[^>]*>([\s\S]*?)<\/script>/);
    if (script) {
      keys = keys.concat(super.extract(script[1], filename));
    }
    const template = content.match(/<template[^>]*>([\s\S]*)<\/template>/);
    if (template) {
      keys = keys.concat(super.extract(vueCompiler.compile(template[1]).render, filename));
    }
    return keys;
  }
}

module.exports = {
  locales: ['en', 'ja'],
  input: ['src/**/*.{js,vue}'],
  output: 'locales/$LOCALE.json',
  // Natural-sentence keys: '.' and ':' are literal text, not separators.
  keySeparator: false,
  namespaceSeparator: false,
  // No plural keys in this app — and the download-progress key passes a
  // `count` interpolation variable (as a string, so i18next does no plural
  // resolution at runtime either). Without this the parser would emit
  // key_one/key_other variants instead of the bare key.
  pluralSeparator: false,
  defaultValue: (locale, namespace, key) => (locale === 'en' ? key : ''),
  keepRemoved: true,
  createOldCatalogs: false,
  sort: true,
  lexers: {
    js: ['JavascriptLexer'],
    vue: [Vue2SfcLexer],
  },
};
