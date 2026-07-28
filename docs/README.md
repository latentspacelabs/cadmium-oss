# docs/

Permanent component documentation — motivation, design, and quirks for each
part of the system. Open work lives ONLY in `todo.md`; the component docs
don't carry their own TODO sections:

| Doc | Covers |
|---|---|
| `app.md` | the Electron/Vue frontend (`app/`) |
| `build-and-release.md` | local packaged builds, the CI pipeline, signing/notarization, releases, model-artifact distribution |
| `segmentation.md` | trapped-ball segmentation, Python + Rust, goldens methodology |
| `colorizer-serving.md` | AnT v2 inference: pipeline, tokenization, ONNX export, parity, EPs, the sidecar |
| `gap-closer-serving.md` | GapCloser inference: tiling, UDF thresholding, EP results |
| `todo.md` | centralized index of open TODOs across the repo, by module and priority |