# Serving setup & acceleration — design

How the app decides *which models and hardware acceleration this machine should
use*, keeps that decision explicit to the user, and survives installs, updates,
and leftover state. Written 2026-07-22 after a field failure: a missing
*optional* accelerator model silently put gap-closing segmentation on the CPU
(~20 s/frame instead of ~1.3 s) with zero UI indication.

## The core design flaw being fixed

"What should this machine be running?" was never computed as an explicit,
comparable thing — it was implied by scattered conditionals (manifest
`platform` fields, `existsFn` gates in `buildSidecarArgs`, `cfg!` blocks in
`engine.rs`). When reality diverged from intent (missing optional model, stale
file, failed CoreML compile), nothing *knew* it diverged, so the app silently
served degraded.

Three principles replace it:

1. **One declared Serving Profile** — a pure function of
   `(platform, arch, manifest)` naming the models this machine wants and the
   execution providers it should reach when healthy.
2. **The sidecar reports actual, not just "ok"** — `/health` carries a
   per-capability acceleration report (planned EP, active EP, reason when
   degraded).
3. **The UI always shows expected vs actual** — degradation is loud but
   passive: a status row / chip with the one action that fixes it, never a
   silent fallback and never a blocking modal.

## Layer 1 — acceleration status (Phase 1, shipped)

`Engine` already resolves per-process serving plans at startup
(`ant_ep`, `gap_ep`) and logs every fallback; the change is *storing* those
facts so `/health` can serve them:

```json
{
  "status": "ok", "engine": "sidecar-rust", "version": "0.1.0",
  "gap_closer": true,
  "acceleration": {
    "colorize": { "planned": "coreml", "active": "building", "reason": null },
    "segment":  { "planned": "cpu",    "active": "cpu",
                  "reason": "gap_closer_fp32_bucket.onnx not configured" }
  }
}
```

- `planned` — what the resolved plan intends: `coreml` | `dml` | `cpu`.
- `active` — what the next request will actually get: `coreml` | `dml` |
  `building` (CoreML compile in flight; requests serve from CPU meanwhile) |
  `cpu`.
- `reason` — non-null exactly when something actionable is wrong: an
  accelerator model missing under `--ep auto`, a CoreML/DirectML build
  failure. A deliberate CPU plan (`--ep cpu`, or a platform with no
  accelerated path) carries no reason — CPU-by-design is not a degradation.

The Electron side stores the last parsed health body on the sidecar status
(`status.health`), refreshes it on every `sidecar:status` IPC (fire-and-forget
so the snapshot call stays sync), and the Server Settings modal renders an
**Acceleration** section: one row per capability — ✓ accelerated / ⏳
optimizing / ⚠ CPU with the reason and remediation.

## Layer 2 — the Serving Profile (Phase 2)

```
profile(platform, arch, manifest) = {
  name:    'mac-coreml' | 'win-dml' | 'cpu-only',
  models:  [ { file, bytes, sha, role: 'required' | 'accelerator' } ],
  expected:{ colorize: 'coreml' | 'dml' | 'cpu', segment: 'coreml' | 'cpu' },
}
```

- The **downloader** fetches exactly `profile.models`. A failed `accelerator`
  download completes the plan but surfaces a degradation warning — never
  silent, never aborts the required files.
- **`missingSidecarFiles`** validates against the profile (today it checks
  only the two required models — exactly why a missing gap bucket was
  invisible).
- **Presence = name + exact bytes (+ sha on first verify)**, memoized in the
  setup ledger so multi-GB files aren't re-hashed every launch. Filename-only
  presence is what "leftover state" exploits.

## Layer 3 — install identity & the setup ledger (Phase 3)

Rule: **any install that didn't arrive via the in-app updater is a new user.**

- **Windows — literal.** NSIS `deleteAppDataOnUninstall: true`: uninstall
  wipes userData; reinstall is genuinely fresh.
- **macOS — emulated at launch** (trashing a .app runs no code, so there is
  no uninstall hook). A `setup-ledger.json` in userData records every
  legitimate version transition:
  1. First-run setup completes → `{ appVersion, installedVia: 'first-run' }`.
  2. In-app update: right before `autoUpdater.quitAndInstall()` stamp
     `{ updatingTo }`; on relaunch a matching version rewrites the ledger
     (`installedVia: 'updater'`) → seamless upgrade, no prompts, delta model
     download if the manifest changed.
  3. Every packaged launch (`app.isPackaged` only — dev builds exempt): if
     running version ≠ ledger version **and** no matching `updatingTo` stamp
     → the binary arrived out-of-band (manual download, downgrade,
     reinstall-after-delete) → reset prefs + ledger and rerun first-run.

**Carve-out: model files are a cache, not state.** The out-of-band reset wipes
*decisions* (prefs, ledger, mismatched CoreML caches) but does not blindly
delete model files. First-run sha-verifies whatever is on disk against the
current manifest and says so explicitly — "Found model files from a previous
install — verified ✓ (4.2 GB reused)" — or quarantines and re-downloads
anything that fails. A sha-verified file is bit-identical to a fresh download;
deleting it buys no correctness and costs a 4 GB fetch. The hazard was never
verified files, it was unverified presence-by-filename, which Layer 2 kills.

### Scenario matrix

| Scenario | Detection | Experience |
|---|---|---|
| Fresh download | no ledger | first-run modal → capability check → profile download → "Optimizing…" |
| In-app update | `updatingTo` stamp matches | silent; toast only if the manifest adds/changes models |
| Reinstall after delete (mac) | version ≠ ledger, no stamp | full first-run again; disk models sha-verified & reused, stated in the modal |
| Uninstall → reinstall (win) | NSIS wiped userData | true fresh user |
| Downgrade / hand-replaced binary | version ≠ ledger, no stamp | first-run again (safe default) |

## Leftover-state invariants

1. The models dir is a **managed cache, not an interface**: validated every
   launch (size always, sha when suspect); unknown/wrong-size files are
   quarantined to `models/.orphaned/` and re-downloaded. Symlinks (dev
   overrides) are honored but labeled in Settings.
2. Every degradation has a **stored reason** that survives to the UI with the
   one action that fixes it.
3. Caches are **keyed, never trusted**: `CACHE_KEY` on *both* CoreML bucket
   models (gap is missing it today); mismatched cache dirs pruned at
   reconcile; cache size shown in Settings.
4. An explicit **"Reset embedded backend…"** button (deletes models,
   coreml-cache, ledger; reruns first-run) makes any weird state recoverable
   without folder-spelunking.

## Phases

| Phase | What | Where | Status |
|---|---|---|---|
| 1 | Acceleration report in `/health` + Settings rows | `engine.rs`, `contract.rs`, `sidecar-manager.js`, `ServerSettingsModal.vue` | **shipped** |
| 2 | Serving Profile + downloader/missing-files unification (roles; accelerator failures warn-and-continue; `missingAccel` in the sidecar status + Settings download offer). sha-verify-on-reuse moves to Phase 3 with the ledger that memoizes it. | `app/src/util/serving-profile.js`, `model-download-core.js`, `model-downloader.js`, `sidecar-core.js`, `ServerSettingsModal.vue` | **shipped** |
| 3 | Setup ledger + launch reconciler + update toast + NSIS `deleteAppDataOnUninstall` | `background.js`, new `model-reconciler.js`, `vue.config.js` | todo |
| 4 | Main-window status chip (Full speed / Reduced — why / Optimizing…) | main window UI | todo |
| 5 | Reset button, orphan quarantine, cache pruning, gap `CACHE_KEY` (needs model re-export) | Settings, downloader, export tooling | todo |
