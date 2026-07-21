"""Dump end-to-end HTTP goldens from the PRODUCTION serving process (R2 gate).

Drives the running local server (the exact process the app talks to)
through the app's real call chain on the robot corpus and records every
request and response verbatim:

    /segment (ref, strength 0)  ->  /preprocess (ref)  ->
    /segment (target, strength 0)  ->  /colorize (pair)
    plus /segment strength 1.0 per drawing (the AI-gap-closing toggle)

These are the assembly-level goldens: the Rust sidecar must accept the
identical request JSON and produce responses that match field-for-field,
EXCEPT the fields listed in meta.json `compare_skip` (colorized_seg_map_uri
uses an unseeded-random colormap) and `compare_approx` (entropy_conf_scores
depends on backend logits' low bits; predicted ids/colors must still be
exact — the corpus is 100% argmax-parity).

Run ON wallace next to the server:

    PYTHONPATH=. python serving/tools/dump_http_goldens.py /tmp/robot_corpus /tmp/http_goldens \
        --server http://127.0.0.1:8000

Layout:
    <out>/ref_f035/{segment_req,segment_resp,preprocess_req,preprocess_resp}.json
    <out>/gapclose_fNNN/{req,resp}.json            (strength 1.0, per drawing)
    <out>/pair_f035_fNNN/{segment_req,segment_resp,colorize_req,colorize_resp}.json
    <out>/meta.json
"""
import argparse
import base64
import json
import os
import sys
import time

import requests as rq

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from serving.onnx.parity_corpus import find_corpus


def png_uri(path, url_safe=False):
    with open(path, "rb") as f:
        raw = f.read()
    enc = base64.urlsafe_b64encode if url_safe else base64.b64encode
    return "data:image/png;base64," + enc(raw).decode()


def call(server, route, payload, out_dir, stem):
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, f"{stem}_req.json"), "w") as f:
        json.dump(payload, f)
    t0 = time.time()
    r = rq.post(f"{server}{route}", json=payload, timeout=600)
    r.raise_for_status()
    resp = r.json()
    with open(os.path.join(out_dir, f"{stem}_resp.json"), "w") as f:
        json.dump(resp, f)
    print(f"  {route} [{stem}]: {time.time() - t0:.2f}s")
    return resp


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("corpus_dir")
    ap.add_argument("out_root")
    ap.add_argument("--server", default="http://127.0.0.1:8000")
    args = ap.parse_args()

    health = rq.get(f"{args.server}/health", timeout=30).json()
    assert health.get("gap_closer"), f"server has no gap closer loaded: {health}"

    ref_nr, ref_line_p, ref_color_p, targets = find_corpus(args.corpus_dir, None)
    print(f"corpus: ref f{ref_nr}, {len(targets)} targets; server {args.server}")

    # ref chain, once
    ref_dir = os.path.join(args.out_root, f"ref_f{ref_nr:03d}")
    ref_seg = call(args.server, "/segment",
                   {"line_image_uri": png_uri(ref_line_p),
                    "gap_closer_strength": 0.0, "return_colorized": False},
                   ref_dir, "segment")
    pre = call(args.server, "/preprocess",
               {"references": [{
                   "seg_map_uri": ref_seg["seg_map_uri"],
                   "color_image_uri": png_uri(ref_color_p, url_safe=True),
                   "line_image_uri": png_uri(ref_line_p, url_safe=True)}],
                "return_filled": True},
               ref_dir, "preprocess")

    all_lines = {ref_nr: ref_line_p, **targets}
    for nr in sorted(all_lines):
        call(args.server, "/segment",
             {"line_image_uri": png_uri(all_lines[nr]),
              "gap_closer_strength": 1.0, "return_colorized": False},
             os.path.join(args.out_root, f"gapclose_f{nr:03d}"), "segment")

    for nr, tgt_p in sorted(targets.items()):
        pair_dir = os.path.join(args.out_root, f"pair_f{ref_nr:03d}_f{nr:03d}")
        tgt_seg = call(args.server, "/segment",
                       {"line_image_uri": png_uri(tgt_p),
                        "gap_closer_strength": 0.0, "return_colorized": False},
                       pair_dir, "segment")
        call(args.server, "/colorize",
             {"references": [{
                 "seg_map_uri": ref_seg["seg_map_uri"],
                 "line_image_uri": png_uri(ref_line_p),
                 "colors_rgba": pre["palette_rgba"]}],
              "target_seg_map_uri": tgt_seg["seg_map_uri"],
              "target_line_image_uri": png_uri(tgt_p)},
             pair_dir, "colorize")

    with open(os.path.join(args.out_root, "meta.json"), "w") as f:
        json.dump({
            "ref_frame": ref_nr,
            "targets": sorted(targets),
            "compare_skip": ["colorized_seg_map_uri"],
            "note": "responses recorded from the production CUDA server; every "
                    "field is exact-comparable on a 100%-argmax-parity backend — "
                    "*_uri image fields by DECODED pixels (PNG encoder bytes may "
                    "differ; cv2 encoding is BGR(A)-swapped, PIL is not — match "
                    "each handler's encoder)",
        }, f, indent=1)
    print("all http goldens dumped")


if __name__ == "__main__":
    main()
