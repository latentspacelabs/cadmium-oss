# Cadmium — centralized TODO

The **single home** for outstanding work across the repo: inline `TODO`/
`FIXME` markers in the source plus roadmap items. Only open work lives here —
the history of closed items is in git (`git log -p docs/todo.md`).

**Split by module, ordered by priority within each:**

- **P1 — correctness / potential bug.** Wrong output, crash, or data loss under some input.
- **P2 — performance / resource / project risk.** Works, but wastes something or exposes the project to loss.
- **P3 — cleanup / refactor / rename.** Maintainability; no behavior change.
- **P4 — future / aspirational.** New capability, not a defect.

Where an item has an inline marker, it links to the authoritative location
(`file:line`). When you close an item, delete its line here **and** the marker
it points at.

---

## release / cross-cutting

### P1 — ship v1.5.7, the first unsigned release (now unblocked)

The mac-cert blocker dissolved by decision (the unsigned $0 route,
2026-07-28), so the release train can move. On board since v1.5.6: the
models-v2 manifest + surgical CoreML-cache prune, the unsigned build config,
the DirectML.dll fix, the nav-bar Server Settings button, and the July
P1/P2 sweeps.

- **Pre-flight — the signed→unsigned auto-update transition.** The record is
  ambiguous on whether v1.5.3–v1.5.6 actually shipped Developer-ID-signed
  (the CI-shakedown note said "signed/notarized ran green"; the later
  "first signed release" framing said no cert existed). If any published
  release WAS signed, its installed base may refuse an unsigned v1.5.7
  (mac: Squirrel validates the update's signature against the running app;
  win: electron-updater's publisher check) and those users need a one-time
  manual re-download. Check `codesign -dv` on a downloaded v1.5.6 artifact
  before tagging, and write the release notes accordingly.
- **Unsigned-install UX docs, shipped WITH the release:** README + release
  notes say the warnings are expected and how to get through them
  (macOS 15+: System Settings → Privacy & Security → "Open Anyway";
  win: SmartScreen → More info → Run anyway).
- **Windows installer shakedown on real hardware** (folds in the deferred
  DirectML end-to-end confirm): install packaged v1.5.7 on the T4 rig,
  SmartScreen click-through, `/health` reports `segment.active=dml` and
  `colorize.active=dml`, colorize a real drawing.
- Keep `models-v1` assets published — pre-v1.5.7 installs pin them by
  sha; deleting the release strands their model downloads.

### P2 — durable off-box home for the goldens (wallace decommission risk)

Found 2026-07-28: the golden suites lived in **`/tmp` on wallace** — wiped
on reboot — and are now copied to `~/cadmium-goldens` there (1.6 GB total:
tokenizer 674M, segment 476M, imageprep 342M, gapcloser 126M, plus http /
postprocess / vtracer / run logs). Remaining: publish them off-box (every
suite is well under the 2 GiB/file cap even tarred whole, so a
`goldens-v1` GitHub release works; S3 is the alternative), which also
unblocks running the `verify_*` harnesses in CI (ci.yml header: "no
durable home yet"). Residuals: the `parity_corpus.py --dump` bundles were
not found on wallace (likely consumed during replay work — regenerable
from the checkpoints while a pinned-env CUDA box exists), and confirm the
`checkpoints-v1` release truly carries both checkpoint assets (wallace
still holds a local staging dir).

### P4 — future

- **winget manifest** for the unsigned installer — a trusted discovery
  channel on Windows (doesn't remove SmartScreen). A Homebrew cask was
  considered and declined (2026-07-28).
- **SignPath Foundation application**, if signing ever returns: free OSS
  code signing that needs no legal entity; check the
  no-commercial-dual-licensing criterion first. build-and-release §4
  records the full re-enable path.
- **Web-app spike**: browser UI against a hosted GPU backend. The
  architecture already splits at the HTTP contract (`server-client.js`
  talks to any backend), so the UI port is bounded — but on-device
  inference does not survive the move (no sidecar in a browser; ORT-Web/
  WebGPU for a 1.4 GB custom-op model is a research project), and the trade
  is install friction for a usage-scaled GPU bill.

---

## app (Electron / Vue renderer + main)

### P3 — deferred with cause

Large refactors with no live bug paying for them, a persisted-key rename
that needs a migration, and UI / hot-drawing-path changes that need
interactive testing a code sweep can't do. With the project in
low-maintenance OSS mode, the first three are candidates to **retire
outright** rather than keep as standing debt:

- The big storage flip: the v2 `.cdm` document section is derived-and-validated only; `state.layers` + ghosts + `saveState` remain the source of truth. Flipping (Document primary, `saveState` dropped, ghost color records → real Cels) is ~100+ read-site churn. Do it only if the `LOAD_FILE` validation warning ([actions.js:703](../app/src/store/actions.js#L703)) ever fires in the wild. (Design notes: `docs/temp/architecture.md`, deleted 2026-07-28 — in git history.)
- Legacy job flags: the `*InProgress` / `*CanceledByUser` / progress keys survive as JobRunner-maintained mirrors, and cancellation still bridges through `SET_*_CANCELED_BY_USER` commits ([actions.js:496](../app/src/store/actions.js#L496)). Deleting the mirrors means porting every reader — pure refactor, no live bug.
- Rename `selectedFrame`/`SELECTED_FRAME_NR` → playhead: ~74 refs across 10 files AND `selectedFrame` is the persisted `.cdm` key, so it needs a `loadcdm` migration or old files silently lose the saved playhead. Risk exceeds value at this point — retire unless a document-schema change forces a migration anyway. → [store/state.js:35](../app/src/store/state.js#L35)
- Layer choice hard-coded where it should follow the last-active layer — a small UX behavior fix; needs an interactive-testing session. → [components/MainPane.vue:1349](../app/src/components/MainPane.vue#L1349), [util/KeyHandler.js:219](../app/src/util/KeyHandler.js#L219)
- Duplicated mouse-move block — extraction from the live drawing path; same interactive-test gap. → [components/MainPane.vue:990](../app/src/components/MainPane.vue#L990)
- Sidebar height hack (flexbox) — needs visual verification. → [components/Sidebar.vue:191](../app/src/components/Sidebar.vue#L191)
- Colour-wheel timer hack — needs interactive verification. → [components/ColorWheelControls.vue:624](../app/src/components/ColorWheelControls.vue#L624)

### P4 — future

- Handle app-update failure via popup. → [background.js:585](../app/src/background.js#L585)
- Drawing-tablet input support. → [components/MainPane.vue:1852](../app/src/components/MainPane.vue#L1852)

---

## segmentation (classical trapped-ball + GapCloser inference)

### P3 — cleanup

- Combine the two neighbouring helpers in `parallel.py`. → [trapped_ball/parallel.py:16](../segmentation/trapped_ball/parallel.py#L16)
- Golden sets: covered by the durable-home item in release / cross-cutting.
  (The Python serving path is now documented as reference/self-host-only —
  hosted service wound down 2026-07 — so the old "mark Python
  reference-only once the sidecar is the only shipped path" item is done.)

---

## serving/sidecar (Rust ONNX sidecar)

No open items and no inline markers in the Rust/Python serving source.
(Section kept because the component docs link here.)
