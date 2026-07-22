# Segmentation

How a line drawing becomes an integer-labeled segmentation map (one label per
fillable region) — the input every other ML component consumes. Two
implementations exist and are kept byte-exact with each other: the original
Python/cv2 pipeline (`segmentation/`) and the Rust port
(`serving/sidecar/src/segment/`).

## Motivation

Flat-fill colorization operates per *segment*, not per pixel. Everything
downstream — vectorization, tokenization, the colorizer itself, and the app's
fill tools — assumes a dense int32 label map where label 0 is background/lines
and labels 1..N are enclosed regions. Segmentation must be deterministic: the
colorizer's reference/target correspondence is by segment id, and the parity
test suite (see `docs/colorizer-serving.md`) depends on reproducing the exact
same maps on every backend.

## The classical path (trapped-ball)

`segmentation/trapped_ball/trapped_ball.py::compute_seg_fast`, fed by
`line.py::binarize`:

1. **Binarize** — `im = 255 − alpha`, then
   `cv2.adaptiveThreshold(…, ADAPTIVE_THRESH_MEAN_C, THRESH_BINARY, 51, 2)`.
   Lines → 0, background → 255.
2. **Trapped-ball passes** (radii 2, 1, 0; first pass `method='max'`) — erode
   with an elliptical kernel, flood-fill the eroded space, dilate the fills
   back. The shrinking ball "escapes" through gaps smaller than its radius,
   which is what closes small line gaps without ML.
3. **Flood fill** the remainder, **build the fill map**, **merge** small/thin
   regions (`merge_fill`, driven by `cv2.findContours` +
   `approxPolyDP` vertex-count heuristics), **thin** boundary pixels into
   neighbors, then relabel densely with `np.unique(…, return_inverse=True)`.

Production parameters (the `/segment` handler): `tb_sizes=[2,1,0]`,
`max_iter=10`, `min_seg_size=10`.

### The tiled variant

`segmentation/trapped_ball/parallel.py::compute_seg_full` runs
`compute_seg_fast` per 512×512 tile (0.5 overlap), offsets each tile's labels
by `tile_id * 256`, samples tile borders at half-overlap depth, connects
overlapping labels with a scipy sparse `connected_components` pass, and merges
via the tiler's overlap-tile window. It is only reachable through the
gap-closing path (`docs/gap-closer-serving.md`) — the plain `/segment` path is
single-pass.

## The Rust port

`serving/sidecar/src/segment/` reimplements all of the above byte-exactly,
including cv2-4.11 semantics ported from OpenCV source (findContours'
reverse-discovery output order, approxPolyDP line-by-line, cvRound
half-to-even in the box filter) and the tiler-0.5.7 / scipy-1.12 semantics of
the tiled variant. **Original quirks are preserved deliberately** — they are
load-bearing for byte-exactness; each is commented at the site. Highlights:

- `merge_fill` reads `ids[0]` as "background" but it is actually the smallest
  label present; preserved.
- `thinning` has `x-1>0`-style bounds tests (off-by-one vs the obvious
  intent); preserved.
- The tiled path's `compute_cc` swaps its h/w trim deltas (invisible in
  production because both are 128); preserved.
- Labels wrap mod 256 when the handler casts to u8 for the PNG response;
  preserved (`docs/colorizer-serving.md` §codecs).

## Verification (the goldens methodology)

Per-stage goldens are dumped **on the production machine by replaying the
production functions**, with a final assert that the replay equals the real
call — so goldens cannot drift from production:

- `serving/tools/dump_segment_goldens.py` → 12 robot-corpus drawings × 8
  stages (binarize, three trapped-ball passes, fillmap, merge, thin, relabel).
- `serving/tools/dump_gapcloser_goldens.py` → 12 drawings × 12 stages of the
  tiled/gap-closing path.

The Rust side replays them with `cargo run --release --bin verify_segment`
and `verify_gapclose` (byte-exact, per-stage PASS/FAIL matrix with
first-mismatch coordinates). Runtime: ~0.3 s/drawing vs ~2.3 s for Python.

## Quirks & gotchas

- **Binarize consumes alpha only.** The RGB of a line layer is irrelevant;
  canvas-exported PNGs keep white RGB under transparent alpha, which once
  poisoned an SDF replica downstream — always think in terms of the alpha
  plane.
- `compute_seg_fast`'s defaults (`[3,2,1]`, `min_seg_size=20`) are NOT the
  production values; the handler passes `[2,1,0]` / 10.
- The trapped-ball result depends on cv2's exact elliptical structuring
  elements (5×5 ellipse ≠ a naive disc) and on border-handling of
  erode/dilate; any cv2 version bump must re-run the golden gates.
- scipy `connected_components` label order (first-encountered node index) is
  part of the contract for the tiled path.

## Open work

Tracked centrally in [todo.md](todo.md) (segmentation section).
