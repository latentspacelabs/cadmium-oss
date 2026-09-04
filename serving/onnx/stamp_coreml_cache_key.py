"""Stamp COREML_CACHE_KEY metadata into a CoreML bucket model.

The final, REQUIRED step for any bucket export destined for the models
release (ant_v2_fp32_bucket.onnx, gap_closer_fp32_bucket.onnx). ORT's CoreML
EP prefers a `COREML_CACHE_KEY` metadata_props entry over its fallback cache
identity — a hash of the model's file *path*, which is stable across
republishes of new weights to the same filename and therefore can't be
trusted (the app used to full-wipe the CoreML cache on every manifest change
because of exactly this).

The key is derived from the PRE-stamp file sha256, so any weight change
produces a new key -> ORT compiles into a fresh cache subdir and can never
serve a stale compile. The EP uses the key VERBATIM as the subdir name
(verified on ORT 1.29 CoreML), which is what lets the app prune stale
entries surgically: `model-manifest.js` mirrors the key per model
(`coremlCacheKey`), and `background.js::pruneCoremlCache` deletes any cache
subdir no current model owns.

This is a metadata-only patch: the graph and weights are untouched (asserted
below via graph-serialization sha), so parity vs the un-stamped export is
trivially preserved. After stamping, copy the printed `bytes` / `sha256` /
`coremlCacheKey` into the model's entry in app/src/util/model-manifest.js.

Usage:
    python stamp_coreml_cache_key.py --model ant_v2_fp32_bucket.onnx --tag antv2fp32bucket
    python stamp_coreml_cache_key.py --model gap_closer_fp32_bucket.onnx --tag gapcloserfp32bucket

Constraints from the EP: the key must be alphanumeric and shorter than 64
chars (a non-conforming key gets re-hashed by ORT, losing the verbatim
subdir naming the surgical prune relies on).
"""
import argparse
import hashlib
import os

import onnx


def sha256_file(path, bufsize=1 << 20):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(bufsize)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--model", required=True, help="bucket .onnx to stamp (in place unless --out)")
    ap.add_argument("--tag", required=True, help="alphanumeric model tag, e.g. antv2fp32bucket")
    ap.add_argument("--out", help="write the stamped model here instead of in place")
    args = ap.parse_args()

    orig_sha = sha256_file(args.model)
    key = args.tag + orig_sha[:32]
    assert key.isalnum() and len(key) < 64, f"key violates EP constraints: {key}"

    m = onnx.load(args.model)
    graph_sha = hashlib.sha256(m.graph.SerializeToString(deterministic=True)).hexdigest()

    for p in [p for p in m.metadata_props if p.key == "COREML_CACHE_KEY"]:
        m.metadata_props.remove(p)
    entry = m.metadata_props.add()
    entry.key = "COREML_CACHE_KEY"
    entry.value = key

    out = args.out or args.model
    onnx.save(m, out)

    m2 = onnx.load(out)
    got = {p.key: p.value for p in m2.metadata_props}
    assert got.get("COREML_CACHE_KEY") == key, got
    assert (
        hashlib.sha256(m2.graph.SerializeToString(deterministic=True)).hexdigest() == graph_sha
    ), "graph changed — stamping must be metadata-only"

    print(f"stamped {out}")
    print(f"  coremlCacheKey: '{key}'")
    print(f"  bytes: {os.path.getsize(out)}")
    print(f"  sha256: '{sha256_file(out)}'")


if __name__ == "__main__":
    main()
