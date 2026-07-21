"""Golden-corpus parity: real production drawings through the exported AnT v2
ONNX graph vs the production GPU/bf16 forward.

Corpus layout (extracted from a .cdm, see tools/extract_cdm_images.py):
    <corpus>/lineLayer1_fNNN_<id>.png    line drawings (RGBA, transparent bg)
    <corpus>/colorLayer1_fNNN_<id>.png   colored frame(s)

The reference pair is the line+color frame with matching NNN (--ref-frame, or
the first color frame found); every other line drawing becomes a target. Seg
maps are trapped-ball (gap_closer_strength 0.0) — identical input to both
sides of the comparison, so parity validity is unaffected by skipping the
GapCloser net.

Run on a CUDA machine (production reference needs cupy):

    python -m serving.onnx.parity_corpus \\
        --checkpoint ~/dev/cadmium-vision/checkpoints/ant_v2/... \\
        --onnx /tmp/ant_v2_onnx/ant_v2.onnx \\
        --corpus /tmp/robot_corpus --dump /tmp/robot_feeds

--dump saves per-pair .npz bundles (every graph input + the production logits
and color ids) so other machines — e.g. the Apple-silicon CoreML spike — can
re-verify the same feeds without a CUDA reference.
"""
import argparse
import glob
import os
import re
import sys
import time

import numpy as np
import torch

from serving.onnx.export_ant_v2 import (
    AnTV2ExportWrapper, build_feed, pad_feed_to_bucket, probe_lowres_hw,
    seg_map_for,
)

# one shared bucket for the whole corpus: every padded pair has IDENTICAL
# input shapes, so a static-shape backend (CoreML) compiles ONCE
# (robot.cdm maxima: 24 slots, 12 rows, 216 cmds, 1273 flat, 47 tokens —
# NOTE the SVG encoder's max_position_embeddings is 256, capping cmds)
CORPUS_BUCKET = {"slots": 32, "rows": 16, "cmds": 256, "flat": 2048, "length": 64}


def load_rgba(path):
    from PIL import Image

    return np.array(Image.open(path).convert("RGBA"))


def find_corpus(corpus_dir, ref_frame):
    lines, colors = {}, {}
    for p in glob.glob(os.path.join(corpus_dir, "*.png")):
        m = re.match(r"(lineLayer|colorLayer)\d*_f(\d+)_", os.path.basename(p))
        if not m:
            continue
        (lines if m.group(1).startswith("line") else colors)[int(m.group(2))] = p
    if not colors:
        sys.exit(f"no colorLayer frames in {corpus_dir}")
    ref_nr = ref_frame if ref_frame is not None else sorted(colors)[0]
    if ref_nr not in lines or ref_nr not in colors:
        sys.exit(f"reference frame {ref_nr} needs BOTH a line and a color png")
    targets = {nr: p for nr, p in sorted(lines.items()) if nr != ref_nr}
    return ref_nr, lines[ref_nr], colors[ref_nr], targets


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--onnx", required=True)
    ap.add_argument("--corpus", required=True)
    ap.add_argument("--ref-frame", type=int, default=None)
    ap.add_argument("--dump", default=None, help="dir for per-pair .npz feed+reference bundles")
    ap.add_argument("--with-cpu", action="store_true", help="also run ORT-CPU per pair")
    ap.add_argument("--bf16-probe", action="store_true",
                    help="also run the eager wrapper on GPU under autocast(bf16): "
                         "matching production argmax means the graph restructuring is "
                         "faithful and any ORT flips are fp32-vs-bf16 precision noise")
    ap.add_argument("--bucket-test", action="store_true",
                    help="also run each pair padded to CORPUS_BUCKET and require the "
                         "same argmax — validates the CoreML static-shape strategy")
    args = ap.parse_args()

    import onnxruntime as ort
    from colorize.ant_v2.pipeline_ant_v2 import AnTV2Pipeline

    if not torch.cuda.is_available():
        sys.exit("needs a CUDA GPU for the production reference forward")
    if args.dump:
        os.makedirs(args.dump, exist_ok=True)

    ref_nr, ref_line_p, ref_color_p, targets = find_corpus(args.corpus, args.ref_frame)
    print(f"corpus: ref frame {ref_nr}, {len(targets)} targets")

    print("== load pipeline (CUDA, production semantics) ==")
    pipeline = AnTV2Pipeline.from_pretrained(checkpoint=args.checkpoint, verbose=False, device="cuda")
    pipeline.model.to("cuda")
    model = pipeline.model.eval()

    sessions = {"cuda": ort.InferenceSession(
        args.onnx, providers=["CUDAExecutionProvider", "CPUExecutionProvider"])}
    if args.with_cpu:
        sessions["cpu"] = ort.InferenceSession(args.onnx, providers=["CPUExecutionProvider"])

    line_ref = load_rgba(ref_line_p)
    color_ref = load_rgba(ref_color_p)
    seg_cache = {ref_line_p: seg_map_for(line_ref)}
    lowres_hw = None
    results = []

    for nr, tgt_p in targets.items():
        print(f"\n== pair: ref f{ref_nr} -> target f{nr} ==")
        line_tgt = load_rgba(tgt_p)
        if tgt_p not in seg_cache:
            seg_cache[tgt_p] = seg_map_for(line_tgt)
        prep = pipeline.preprocess(inputs={
            "ref_seg_image": seg_cache[ref_line_p],
            "ref_line_image": line_ref,
            "target_seg_image": seg_cache[tgt_p],
            "target_line_image": line_tgt,
            "ref_color_image": color_ref,
        })
        tok_gpu = {k: v.to("cuda") for k, v in prep["tokenized"].items()}
        with torch.inference_mode():
            ref_out = model(**tok_gpu)
        ref_logits = ref_out.target_color_logits.float().cpu()
        ref_ids = ref_out.target_color_id_predictions.cpu()

        tok = {k: v.cpu() for k, v in tok_gpu.items()}
        if lowres_hw is None:
            lowres_hw = probe_lowres_hw(model, tok)
        feed_t, ref_idx, tgt_idx = build_feed(tok, lowres_hw)
        feed_np = {k: v.numpy() for k, v in feed_t.items()}
        n_ref, n_tgt = len(ref_idx), len(tgt_idx)
        print(f"  segments: {n_ref} ref + {n_tgt} target; palette {ref_logits.shape[-1]}")

        row = {"target": nr, "n_ref": n_ref, "n_tgt": n_tgt}
        if args.bf16_probe:
            wrapper = AnTV2ExportWrapper(model).eval()
            feed_gpu = {k: v.to("cuda") for k, v in feed_t.items()}
            with torch.inference_mode(), torch.autocast("cuda", torch.bfloat16):
                probe_out = wrapper(**feed_gpu)
            probe_logits = probe_out.float().cpu().numpy()[:, n_ref:, :]
            agree = (probe_logits.argmax(-1) == ref_ids.numpy()).mean() * 100
            row["bf16_wrapper"] = agree
            print(f"  wrapper-bf16(GPU): argmax {agree:.2f}%, "
                  f"max|dlogit| {np.abs(probe_logits - ref_logits.numpy()).max():.3f}")
        for name, sess in sessions.items():
            t0 = time.time()
            out = sess.run(None, feed_np)[0][:, n_ref:, :]
            dt = (time.time() - t0) * 1000
            agree = (out.argmax(-1) == ref_ids.numpy()).mean() * 100
            diff = np.abs(out - ref_logits.numpy()).max()
            row[name] = agree
            print(f"  ORT-{name}: argmax {agree:.2f}%, max|dlogit| {diff:.3f}, {dt:.0f} ms")
            if name == "cuda" and agree < 100.0:
                ids_onnx = out.argmax(-1)[0]
                ids_prod = ref_ids.numpy()[0]
                logits_prod = ref_logits.numpy()[0]
                for s in np.nonzero(ids_onnx != ids_prod)[0][:8]:
                    margin = logits_prod[s, ids_prod[s]] - logits_prod[s, ids_onnx[s]]
                    print(f"    flip slot {s}: prod id {ids_prod[s]} vs onnx id "
                          f"{ids_onnx[s]}, prod top-margin {margin:.3f}")
        padded = None
        if args.bucket_test or args.dump:
            padded = {k: v.numpy() for k, v in
                      pad_feed_to_bucket(feed_t, CORPUS_BUCKET).items()}
        if args.bucket_test:
            out_b = sessions["cuda"].run(None, padded)[0][:, n_ref:n_ref + n_tgt, :]
            agree_b = (out_b.argmax(-1) == ref_ids.numpy()).mean() * 100
            row["bucket"] = agree_b
            print(f"  ORT-cuda bucketed: argmax {agree_b:.2f}% "
                  f"(len {padded['packed_attn_mask'].shape[1]})")
        results.append(row)

        if args.dump:
            np.savez_compressed(
                os.path.join(args.dump, f"pair_f{ref_nr}_f{nr}.npz"),
                ref_ids=ref_ids.numpy(), ref_logits=ref_logits.numpy(),
                n_ref=n_ref, n_tgt=n_tgt,
                **{f"feed_{k}": v for k, v in feed_np.items()},
                **{f"bucket_feed_{k}": v for k, v in padded.items()},
            )

    print("\n== summary ==")
    score_keys = list(sessions) + (["bucket"] if args.bucket_test else [])
    worst = 100.0
    for row in results:
        segs = f"{row['n_ref']}+{row['n_tgt']}"
        scores = "  ".join(f"{k} {row[k]:6.2f}%" for k in score_keys)
        print(f"  f{row['target']:>3} ({segs:>7} segs): {scores}")
        worst = min(worst, *[row[k] for k in score_keys])
    print(f"worst argmax agreement: {worst:.2f}%")
    if worst < 100.0:
        sys.exit("PARITY GATE FAILED — at least one color-id flip vs production")
    print("ALL PAIRS EXACT")


if __name__ == "__main__":
    main()
