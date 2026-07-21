# Build, CI & release

How Cadmium goes from source to a downloadable app: local packaged builds,
the GitHub Actions pipeline, signing/notarization, releases, and model
artifact distribution. App architecture lives in `app.md`; the sidecar's
internals in `colorizer-serving.md` / `segmentation.md`.

## 1. What a build produces

A packaged Cadmium is the Electron app plus one extra ingredient: the
**embedded serving sidecar** (`serving/sidecar`, Rust + ONNX Runtime),
copied into the app bundle by electron-builder:

- mac: `Cadmium.app/Contents/Resources/sidecar/cadmium-sidecar` (arm64)
- win: `resources/sidecar/cadmium-sidecar.exe` (x64 MSVC)

That location is a contract with `app/src/util/sidecar-core.js`
(`resolveSidecarPaths()` reads `process.resourcesPath + '/sidecar/...'` in
packaged builds). The copy happens via `extraResources` in
`app/vue.config.js` — the binary must exist at
`serving/sidecar/target/release/cadmium-sidecar` (mac) or
`serving/sidecar/target/x86_64-pc-windows-msvc/release/cadmium-sidecar.exe`
(win) *before* `electron:build` runs; nothing builds it for you.

**Models are not bundled.** The ~3.3 GB of ONNX artifacts load from
`userData/models/` at runtime; the app downloads them on demand from the
`models-v1` release with size+sha256 verification (see §6). Keeps
installers small and models upgradable independently of app versions.

**Platform targets: mac arm64 + win x64, deliberately.** The mac target
used to say `universal`, but we only compile the sidecar for arm64 — a
universal app would ship an Intel slice with a broken embedded backend.
Intel-mac support would need an `x86_64-apple-darwin` sidecar build and a
lipo step (unwired, no current demand).

## 2. Local builds

Dev loop (no packaging): `npm run electron:serve` with
`CADMIUM_SIDECAR_BIN` / `CADMIUM_MODELS_DIR` pointing at a cargo build and
a models dir. Dev-serve quirks (ELECTRON_RUN_AS_NODE etc.) are in
`app.md` §3.

Local packaged build, no signing assets required:

```bash
cd serving/sidecar && cargo build --release
cd ../../app && CADMIUM_UNSIGNED_LOCAL_BUILD=1 npm run electron:build -- --mac dir
```

`CADMIUM_UNSIGNED_LOCAL_BUILD=1` (read in `vue.config.js`) turns the
hardened runtime off. Necessary: with no Developer ID cert in the keychain,
electron-builder falls back to an **ad-hoc** signature, and on current
macOS an ad-hoc-signed main binary with the hardened runtime on is
rejected by dyld at launch ("different Team IDs" against the bundled
Electron framework). Production builds (real cert) keep the hardened
runtime on.

Packaged-build gotchas, learned the hard way:

- **Never pass `-c.` config overrides on the electron-builder CLI** (e.g.
  `-c.mac.hardenedRuntime=false`). They replace, rather than merge with,
  the vue-cli plugin's programmatic `builderOptions`, producing an asar
  without `background.js` and a wrong output dir. Env-guarded entries in
  `vue.config.js` `builderOptions` are the supported seam — that's how
  both `CADMIUM_UNSIGNED_LOCAL_BUILD` and `CADMIUM_WIN_SIGN_SHA1` work.
- **Launching a packaged app that silently exits 0 instantly**: check for
  stale `Singleton*` files in `~/Library/Application Support/Cadmium`
  (left by a SIGKILLed instance; delete them), and make sure
  `ELECTRON_RUN_AS_NODE` is not set in the launching shell
  (`env -u ELECTRON_RUN_AS_NODE ...`).
- A half-signed bundle from an earlier failed build can poison the next
  one (Team-ID mismatches between nested components) — delete
  `app/dist_electron/mac-arm64` and rebuild clean.
- `build/entitlements.mac.plist` is force-added past the `build/`
  gitignore; electron-builder hard-fails without it (allow-jit +
  allow-unsigned-executable-memory + allow-dyld-environment-variables).

## 3. The CI pipeline (`.github/workflows/ci.yml`)

Triggers: pushes to `main`, `v*` tags, PRs, manual dispatch. Shape:

```
sidecar-test (macos-14, windows-2022)  ─┐
                                        ├─► package-mac ─┐
app-test (ubuntu)                      ─┘                ├─► release (v* tags only)
                                        └─► package-win ─┘
```

1. **`sidecar-test`** — `cargo test --release` (all 119 tests) on both
   target platforms. Checkout uses `submodules: recursive`: the sidecar
   has a path-dependency on the vendored `third_party/vtracer` fork
   (which path-depends on `third_party/visioncortex`); both forks are
   public on github.com/latentspacelabs, so the default `GITHUB_TOKEN`
   fetches them (actions/checkout rewrites the `git@github.com:`
   submodule URLs to token-authenticated https). The tests are
   self-contained — the multi-GB golden dirs feed only the `verify_*`
   bins, which CI does not run (§7). First build compiles `ort`, which
   downloads the prebuilt ONNX Runtime for the host (CoreML-enabled on
   mac, DirectML-enabled on win — the per-target features in Cargo.toml).
   `Swatinem/rust-cache` with `shared-key: sidecar` shares the compiled
   deps with the packaging jobs.
2. **`app-test`** — `npm ci` + the jest suite on ubuntu (cheapest runner).
3. **`package-mac` / `package-win`** — gated on both test jobs. Each
   builds the sidecar for its platform (win passes the explicit
   `--target x86_64-pc-windows-msvc` so the binary lands on the
   `extraResources` path), then runs `npm run electron:build`. On
   Windows the `NODE_ENV=production` prefix in the npm script works
   because the `win-node-env` dependency shims it under cmd.exe.
   Signing is applied only if secrets exist (§4); with none, both jobs
   still produce artifacts. Uploaded (7-day retention): mac dmg+zip,
   win NSIS installer, plus the `latest*.yml` electron-updater feed
   files.
4. **`release`** — `v*` tags only: downloads both artifact sets and
   drafts a GitHub Release on this repo (`softprops/action-gh-release`,
   job-scoped `contents: write`). Draft on purpose — review, write
   notes, publish. electron-updater only sees *published* releases.

**Private-repo economics**: Actions minutes bill on private repos with
macOS at 10× and Windows at 2× (public repos are free). A cold full run
is roughly 350–400 billable minutes (~$3–4 in overage); warm runs with
the Rust cache are about a third. Everything (runs, artifacts, releases)
carries over unchanged when the repo flips public.

## 4. Signing & notarization

Entirely env-driven — no identities or thumbprints in checked-in config,
and every path degrades to an unsigned build when secrets are absent.
Secrets live in GitHub repo settings (Settings → Secrets and variables →
Actions) and are injected only into the packaging steps.

| Platform | Secret(s) | Consumed by |
|---|---|---|
| mac sign | `CSC_LINK` (base64 .p12 of the Developer ID Application cert+key), `CSC_KEY_PASSWORD` | electron-builder natively (imports into a throwaway keychain) |
| mac notarize | `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | `app/notarize.js` (afterSign hook; skips itself when unset) |
| win sign | `ES_USERNAME`, `ES_PASSWORD`, `ES_TOTP_SECRET` (and `ES_CREDENTIAL_ID` if the account holds several credentials) | the workflow's eSigner CKA step |

Windows signing goes through **SSL.com eSigner** (remote signing — the
cert never leaves SSL.com's HSM, as required for OV certs issued since
mid-2023). The CI step installs eSigner CKA, which surfaces the cloud
cert in the runner's certificate store, then exports its thumbprint as
`CADMIUM_WIN_SIGN_SHA1`; `vue.config.js` passes that to electron-builder
as `win.signtoolOptions.certificateSha1`. On a dev machine with eSigner
CKA installed, set the env var to the cert's thumbprint yourself. The
mac side needs no equivalent: without `CSC_LINK`, keychain auto-discovery
finds a locally installed Developer ID, or falls back to ad-hoc.

The eSigner CKA step follows SSL.com's documented flow but has not had a
real run yet — expect the first signed Windows build to need a shakedown.

## 5. App releases & auto-update

Push a `v*` tag → full pipeline → draft release with dmg/zip/exe and the
updater feed `.yml`s attached. The `publish` config in
`app/electron-builder.json` (provider github, this repo) is what the
in-app electron-updater reads; it only sees published releases, and on a
private repo it would need a token — moot until the repo is public.

## 6. Model artifacts

The three ONNX files ship as assets of the hand-managed **`models-v1`**
GitHub Release (the tag doesn't match `v*`, so it never triggers app
builds):

- `ant_v2_fp32.onnx` (1.39 GB) — AnT colorizer, dynamic shapes
- `ant_v2_fp32_bucket.onnx` (1.39 GB) — bucket-pinned CoreML fast path
  (optional)
- `gap_closer_fp32.onnx` (0.50 GB) — GapCloser, the parity anchor

`app/src/util/model-manifest.js` is the single source of truth: names,
byte sizes, sha256 hashes, release tag/URL. CommonJS on purpose so both
webpack and node tooling load it. `serving/tools/upload_models_release.sh
<models-dir>` verifies local files against the manifest (size + sha256)
and creates/uploads the release via `gh`. Bumping models = new tag + new
hashes in one commit, so an app version pins the exact bytes its parity
goldens were validated against. All assets sit under GitHub's 2 GiB/file
cap; bandwidth on public repos is free (the reason GH Releases won over
S3+CloudFront — swapping later is a one-line base-URL change in the
manifest).

**In-app bootstrap**: the Server Settings modal offers "Download models"
whenever the embedded backend's status reports missing model files. The
main-process `ModelDownloader` (`app/src/model-downloader.js`; pure
planning in `util/model-download-core.js`) streams each file to
`<name>.part` while hashing, requires the exact manifest size AND sha256,
then renames onto the final name — the sidecar's missing-file probe only
ever sees fully verified files, and its failed-missing state self-clears
on the ensure that runs after a successful download. Policy: required
models everywhere, the bucket-pinned AnT only on macOS (CoreML fast
path). Progress streams over `sidecar:models-progress` IPC. Downloads
use Electron's `net` (follows the GitHub 302 → CDN redirect, honors
system proxies). No resume yet: a failed/cancelled file refetches whole.

GH Releases downside to remember: 2 GiB/file ceiling with little headroom
over the 1.39 GB AnT fp32, and no signed URLs / download analytics.

## 7. Remaining TODOs

- **First-run shakedown**: the workflow has never executed (repo not on
  GitHub yet). Most likely friction: Windows `cargo test` runtime — the
  sidecar's Windows validation so far was Python-side (DirectML parity on
  the EC2 rig), never `cargo test` under MSVC.
- **Model bootstrap end-to-end test**: the downloader is built and
  unit-tested, but a real fetch against the `models-v1` release needs the
  release to exist (and the repo public for anonymous URLs). Resume
  support for interrupted GB-scale downloads is a known gap.
- **Verify goldens in CI**: the `verify_*` bins + a Windows CPU
  `parity_replay` need a durable home for the multi-GB golden dirs
  (candidates: a dedicated release tag like the models, or S3).
- **EP runtime checks**: CoreML/DirectML paths need real hardware; GitHub
  runners exercise only CPU EPs.
- **Signed-build validation**: mac notarization staple check and the
  eSigner CKA flow both need one real secrets-configured run.
