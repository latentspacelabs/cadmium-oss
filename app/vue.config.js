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
        // otherwise). electron-updater keys updates off this id, so changing it
        // later makes updates look like a different application — keep it stable.
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
          // Self-signed distribution (still the $0 route — no Apple
          // Developer cert, no notarization): CI supplies the project's
          // long-lived self-signed cert via CSC_LINK/CSC_KEY_PASSWORD and
          // electron-builder signs with it. Squirrel.Mac validates an update
          // against the RUNNING app's signing identity before installing, so
          // auto-update requires a STABLE identity across versions — ad-hoc
          // signatures (each build's identity is its own cdhash) made every
          // mac auto-update fail silently at install. The cert changes
          // nothing about Gatekeeper: users still get the "Open Anyway" wall
          // on first launch of a downloaded copy. Losing the cert = one
          // manual re-download for every user (see docs/build-and-release.md
          // — keep ~/cadmium-signing backed up). The BUILD machine must
          // trust the cert (CI's "Trust self-signed signing cert" step;
          // docs §4 for local) or electron-builder silently falls back to
          // ad-hoc despite CSC_LINK. Without CSC_LINK (local dev), stay
          // ad-hoc; hardened runtime stays OFF either way (no notarization
          // to require it).
          identity: process.env.CSC_LINK ? undefined : null,
          hardenedRuntime: false,
        },
        win: {
          extraResources: [
            {
              from: '../serving/sidecar/target/x86_64-pc-windows-msvc/release/cadmium-sidecar.exe',
              to: 'sidecar/cadmium-sidecar.exe',
            },
            {
              // DirectML runtime the sidecar loads for the DML EP. Windows'
              // system DirectML.dll (1.4.0 on Server 2022, 2020) is too old and
              // fails session creation for our fp16/tiled models (887A0004),
              // silently dropping colorize + gap to CPU. Ship Microsoft's modern
              // redistributable next to the sidecar exe — the exe's own dir is
              // searched before System32, so it wins. Fetched by
              // serving/sidecar/scripts/fetch-directml.ps1.
              from: '../serving/sidecar/vendor/DirectML.dll',
              to: 'sidecar/DirectML.dll',
            },
          ],
          // Unsigned distribution ($0 route — no Authenticode cert). The
          // installer ships unsigned: Windows shows a SmartScreen "unknown
          // publisher" wall that users click through (More info -> Run
          // anyway). See docs/build-and-release.md for the trade-offs and
          // the SignPath Foundation option if signing returns.
        },
      },
    },
  },
};
