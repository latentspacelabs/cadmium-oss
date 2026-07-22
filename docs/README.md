# docs/

Permanent component documentation — motivation, design, quirks, and open
TODOs for each part of the system:

| Doc | Covers |
|---|---|
| `app.md` | the Electron/Vue frontend (`app/`) |
| `build-and-release.md` | local packaged builds, the CI pipeline, signing/notarization, releases, model-artifact distribution |
| `segmentation.md` | trapped-ball segmentation, Python + Rust, goldens methodology |
| `colorizer-serving.md` | AnT v2 inference: pipeline, tokenization, ONNX export, parity, EPs, the sidecar |
| `gap-closer-serving.md` | GapCloser inference: tiling, UDF thresholding, EP results |

`temp/` holds retired brainstorming/planning docs (architecture.md,
serving-backends.md). They record decision history but are superseded by the
docs above and will be deleted; don't link to them from anything permanent.
