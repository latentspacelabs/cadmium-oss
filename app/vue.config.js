module.exports = {
  lintOnSave: false,
  configureWebpack: {
    // me need to make sure to deactivate this on builds
    devtool: 'source-map',
    externals: {
      'node-fetch': "require('node-fetch')",
    },
  },
  pluginOptions: {
    electronBuilder: {
      // The following prevents an error being printed to the console:
      // GET http://localhost:8080/ net::ERR_INVALID_ARGUMENT
      // Solution, recommended by plugin author, taken from:
      // see https://github.com/nklayman/vue-cli-plugin-electron-builder/issues/546#issuecomment-554791747
      chainWebpackRendererProcess: (config) => {
        if (process.env.NODE_ENV === 'development') {
          config.plugins.delete('prefetch');
        }
        // Disable built-in progress plugin to avoid incompat with webpack 5/progress-webpack-plugin
        try { config.plugins.delete('progress'); } catch (e) {}
        config.externals({
          'node:child_process': 'require("child_process")',
          'node:util': 'require("util")',
        });

        config.module
          .rule('mjs')
          .test(/\.mjs$/)
          .include.add(/node_modules/)
          .end()
          .type('javascript/auto');
      },
      // The main process is bundled by the plugin's own webpack 4, whose
      // parser predates optional chaining — and i18next ships `?.` in its
      // published dist. Transpile JUST i18next for the main bundle (chrome 79
      // target = last Chrome without `?.`/`??`). The webpack 5 renderer needs
      // nothing.
      chainWebpackMainProcess: (config) => {
        config.module
          .rule('i18next-compat')
          .test(/\.js$/)
          .include.add(/node_modules[\\/]i18next[\\/]/)
          .end()
          .use('babel-loader')
          .loader('babel-loader')
          .options({
            presets: [['@babel/preset-env', { targets: { chrome: '79' } }]],
          });
      },
      // when removeElectronJunk is set to true, the console output will be cleaned,
      // see https://nklayman.github.io/vue-cli-plugin-electron-builder/guide/configuration.html#electron-s-junk-terminal-output
      removeElectronJunk: false,
      nodeIntegration: true,
      builderOptions: {
        // options placed here will be merged with default configuration
        // and passed to electron-builder
        //
        // Explicit bundle/app identity (defaults to com.electron.cadmium
        // otherwise). Must match the appBundleId in notarize.js; set BEFORE
        // the first signed/notarized release — signing ties the app's
        // Gatekeeper/notarization identity to this id, and changing it later
        // makes updates look like a different application.
        appId: 'com.latentspacelabs.cadmium',
        //
        // Auto-update feed: electron-builder bakes this into the packaged
        // app's app-update.yml, which electron-updater reads at runtime to
        // poll GitHub releases (latest.yml / latest-mac.yml + the dmg/zip/
        // exe assets CI uploads). CI builds with `--publish never` — this
        // block only configures the FEED; publishing stays the manual
        // review-then-publish step (electron-updater only sees published,
        // non-draft releases). Keep the models-v1 release un-"latest" so the
        // updater never mistakes it for an app release.
        publish: {
          provider: 'github',
          owner: 'latentspacelabs',
          repo: 'cadmium-oss',
        },
        nsis: {
          // Uninstall = forget me: wipe userData (prefs, setup ledger,
          // models, caches) so a reinstall is a true fresh user
          // (docs/serving-setup-design.md, Phase 3). macOS has no uninstall
          // hook; the setup ledger emulates this at next launch.
          deleteAppDataOnUninstall: true,
        },
        // locales/ is no longer shipped as extra files: the i18next catalogs
        // are require'd into the bundles at build time (src/util/i18n.js) and
        // nothing reads Resources/locales at runtime anymore.
        extraFiles: [
          {
            from: 'src/assets/cdm/',
            to: 'Resources/assets/cdm/',
            filter: ['**/*'],
          },
        ],
        // The embedded serving sidecar (serving/sidecar). Lands at
        // <resources>/sidecar/cadmium-sidecar[.exe], which is exactly where
        // src/util/sidecar-core.js resolveSidecarPaths() looks in packaged
        // builds (process.resourcesPath + 'sidecar/...'). Per-platform:
        // mac ships the arm64 cargo release build, win the x64 MSVC build.
        // (No CI builds these yet — the binary must exist before packaging.)
        mac: {
          extraResources: [
            {
              from: '../serving/sidecar/target/release/cadmium-sidecar',
              to: 'sidecar/cadmium-sidecar',
            },
            {
              // ONNX Runtime dylib the sidecar dlopens (ort load-dynamic):
              // the ort crate's static binary is 1.24 but ORT >= 1.25 runs
              // CoreML ~3x faster. Fetched into serving/sidecar/vendor/ by
              // scripts/fetch-ort-dylib.sh, which keeps only the current
              // version there. Glob it (rather than naming the version) so the
              // ORT version lives in exactly one place — that script. The
              // sidecar finds libonnxruntime*.dylib next to its own binary at
              // runtime (src/ort_dylib.rs), so the exact filename is unimportant.
              from: '../serving/sidecar/vendor',
              to: 'sidecar',
              filter: ['libonnxruntime.*.dylib'],
            },
          ],
          // Ad-hoc-signed local builds (no Developer ID cert in the env)
          // cannot use the hardened runtime: library validation rejects the
          // teamless main-binary/framework pairing at dyld time on current
          // macOS. Production builds (real cert + notarization) keep it on.
          ...(process.env.CADMIUM_UNSIGNED_LOCAL_BUILD === '1'
            ? { hardenedRuntime: false }
            : {}),
        },
        win: {
          extraResources: [
            {
              from: '../serving/sidecar/target/x86_64-pc-windows-msvc/release/cadmium-sidecar.exe',
              to: 'sidecar/cadmium-sidecar.exe',
            },
          ],
          // Windows signing goes through SSL.com eSigner CKA: the cert never
          // leaves SSL.com's HSM; CKA exposes it in the machine's cert store
          // and the signer selects it by thumbprint. CI loads the cert and
          // exports the thumbprint as CADMIUM_WIN_SIGN_SHA1 (see
          // .github/workflows/ci.yml); on a dev machine with eSigner CKA
          // installed, set it to the cert's thumbprint yourself. Configured
          // here, not via -c. CLI overrides, which break the vue-cli
          // plugin's config merge. Unset -> unsigned build.
          ...(process.env.CADMIUM_WIN_SIGN_SHA1
            ? {
                signtoolOptions: {
                  certificateSha1: process.env.CADMIUM_WIN_SIGN_SHA1,
                },
              }
            : {}),
        },
      },
    },
  },
};
