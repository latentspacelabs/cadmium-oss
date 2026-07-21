# segmentation/

Python implementation of line-art segmentation: classical trapped-ball plus
the ML gap-closing model.

```
trapped_ball/   binarize + trapped-ball segmentation (trapped_ball.py),
                tiled variant with connected-components merge (parallel.py),
                cropping helpers, int32<->RGBA serialization, scripts/
gap_closing/    GapCloser UNet (gap_closer.py, unet.py), training loss/
                dataset/visualization, inference.py (process_image — the
                /segment handler's entry point)
```

The plain `/segment` path is `binarize` + `compute_seg_fast`
(tb_sizes=[2,1,0], max_iter=10, min_seg_size=10). With "AI Gap Closing" on,
`GapCloser.predict` tiles the drawing, predicts a UDF boundary, then runs the
tiled trapped-ball with a CC merge.

A byte-exact Rust port of the entire inference surface lives in
`serving/sidecar/src/segment/` and is gated by per-stage goldens dumped from
this package. If you change semantics here, re-dump goldens
(`serving/tools/dump_segment_goldens.py`, `dump_gapcloser_goldens.py`) and
re-run the sidecar verify bins.

Deep dives: `docs/segmentation.md`, `docs/gap-closer-serving.md`,
`docs/gap-closer-training.md`.
